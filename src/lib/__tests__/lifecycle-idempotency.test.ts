// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE IDEMPOTENCY — production fix 2026-09-15.
//  ---------------------------------------------------------------------
//  Covers the send-key, gate and orchestration corrections made together:
//    • per-offset / per-date job-reminder keys and minute-bucketed receipt
//      resend keys (a 24h reminder was refused as a duplicate of the 72h one);
//    • abandoned-checkout recovery only while the booking is PENDING_PAYMENT;
//    • the follow-up frequency cap counting delivered rows, not 'sent';
//    • SMS removed from every lifecycle path;
//    • campaign lead rechecks passing the template;
//    • journey enqueue failures reported, repair starvation, consent ordering.
//  Everything here is offline: pure predicates, source-structural checks and a
//  fake JourneyDeps. No DB, no Redis, no provider.
// ════════════════════════════════════════════════════════════════════════
import './_journeys-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'

assertNoProductionCredentials()

import { jobReminderEventKey, receiptResendEventKey } from '../email-event-keys'
import { bookingBlockReason, type BookingSnapshot } from '../email-eligibility'
import { classifyBlock, type SendOutcome } from '../email-guard'
import { followupCapWhere, followupEmailStatus, followupDeferUntil, FOLLOWUP_RETRY_MAX_AGE_MS } from '../followups'
import { recipientStateForOutcome } from '../email-campaign-run'
import {
  ABANDONED_STAGES,
  QUOTE_STAGES,
  ensureQuoteJourney,
  jobIdFor,
  onBookingCreated,
  repairStrandedQuoteJourneys,
  type JourneyDeps,
  type JourneyLead,
} from '../journeys'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 11:00 America/New_York. */
const NOW = new Date('2026-09-15T15:00:00.000Z')
const EMAIL = 'idem@example.com'
assertTestRecipient(EMAIL)

const ROOT = resolve(__dirname, '../../..')
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

// ── 1. business event keys ───────────────────────────────────────────────

test('jobReminderEventKey: 72h and 24h differ for the same booking and date', () => {
  const d = new Date('2026-10-01T13:00:00.000Z')
  assert.notEqual(jobReminderEventKey('bk_1', 'job-reminder-72h', d), jobReminderEventKey('bk_1', 'job-reminder-24h', d))
})

test('jobReminderEventKey: identical inputs give an identical (retry-stable) key', () => {
  const a = jobReminderEventKey('bk_1', 'job-reminder-24h', new Date('2026-10-01T13:00:00.000Z'))
  const b = jobReminderEventKey('bk_1', 'job-reminder-24h', new Date('2026-10-01T13:00:00.000Z'))
  assert.equal(a, b)
})

test('jobReminderEventKey: a rescheduled move date is a new key', () => {
  assert.notEqual(
    jobReminderEventKey('bk_1', 'job-reminder-24h', new Date('2026-10-01T13:00:00.000Z')),
    jobReminderEventKey('bk_1', 'job-reminder-24h', new Date('2026-10-02T13:00:00.000Z'))
  )
})

test("jobReminderEventKey: null (or invalid) date is a stable 'no-date' key", () => {
  const a = jobReminderEventKey('bk_1', 'job-reminder-72h', null)
  assert.equal(a, jobReminderEventKey('bk_1', 'job-reminder-72h', null))
  assert.ok(a.endsWith(':no-date'), a)
  assert.equal(jobReminderEventKey('bk_1', 'job-reminder-72h', new Date('nope')), a)
})

test('receiptResendEventKey: same minute identical, next minute different', () => {
  const t0 = new Date('2026-09-15T15:00:05.000Z')
  const sameMinute = new Date('2026-09-15T15:00:59.999Z')
  const nextMinute = new Date('2026-09-15T15:01:00.000Z')
  assert.equal(receiptResendEventKey('bk_1', t0), receiptResendEventKey('bk_1', sameMinute))
  assert.notEqual(receiptResendEventKey('bk_1', t0), receiptResendEventKey('bk_1', nextMinute))
})

// ── 2. source wiring of those keys ──────────────────────────────────────

test('scheduled.worker job-reminder enqueue keys on jobReminderEventKey(..., effectiveMoveDate(booking))', () => {
  const s = src('src/workers/scheduled.worker.ts')
  const start = s.indexOf("case 'job-reminder-72h':")
  assert.ok(start > -1)
  const block = s.slice(start, s.indexOf('break', s.indexOf("emailQueue.add('job-reminder'", start)))
  assert.match(block, /emailQueue\.add\('job-reminder'/)
  assert.match(block, /businessEventKey:\s*jobReminderEventKey\(\s*bookingId,\s*type,\s*effectiveMoveDate\(booking\)\s*\)/)
})

test("scheduled.worker review-request-48h payload uses journey 'post-job'", () => {
  const s = src('src/workers/scheduled.worker.ts')
  const start = s.indexOf("case 'review-request-48h':")
  assert.ok(start > -1)
  const end = s.indexOf("log.info({ bookingId }, 'Review request queued')", start)
  assert.ok(end > start)
  const block = s.slice(start, end)
  assert.match(block, /emailQueue\.add\('review-request'/)
  assert.match(block, /journey:\s*'post-job'/)
})

test('receipt resend route keys the job on receiptResendEventKey', () => {
  const s = src('app/api/admin/receipts/[id]/resend/route.ts')
  assert.match(s, /import\s*\{[^}]*receiptResendEventKey[^}]*\}\s*from\s*'@\/lib\/email-event-keys'/)
  assert.match(s, /businessEventKey:\s*receiptResendEventKey\(/)
})

test('scheduled.worker lifecycle-repair re-drives retryDueFollowups', () => {
  const s = src('src/workers/scheduled.worker.ts')
  assert.match(s, /retryDueFollowups\(\)/)
})

// ── 3. abandoned-checkout gate ──────────────────────────────────────────

function booking(over: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    status: 'PENDING_PAYMENT',
    isInternalTest: false,
    depositPaid: false,
    completedAt: null,
    requestedDate: new Date(NOW.getTime() + 10 * DAY),
    confirmedDate: null,
    scheduledStart: null,
    customerMarketingConsent: true,
    customerMarketingOptOut: false,
    ...over,
  }
}

for (const template of ['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3']) {
  test(`${template}: only a still-unpaid PENDING_PAYMENT booking is recoverable`, () => {
    assert.equal(bookingBlockReason(template, booking({ status: 'PENDING_APPROVAL' }), NOW), 'booking_advanced:PENDING_APPROVAL')
    assert.equal(bookingBlockReason(template, booking({ status: 'CANCELLED' }), NOW), 'booking_advanced:CANCELLED')
    assert.equal(bookingBlockReason(template, booking({ depositPaid: true }), NOW), 'deposit_already_paid')
    assert.equal(bookingBlockReason(template, booking(), NOW), null)
  })
}

test("classifyBlock('booking_advanced:PENDING_APPROVAL') is terminal", () => {
  assert.equal(classifyBlock('booking_advanced:PENDING_APPROVAL'), 'terminal')
  assert.equal(classifyBlock('deposit_already_paid'), 'terminal')
})

// ── 4. follow-up cap and email status ───────────────────────────────────

test('followupCapWhere counts deliveredAt in the window for the customer, excluding itself', () => {
  const since = new Date(NOW.getTime() - 30 * DAY)
  const where = followupCapWhere('cus_1', since, { bookingId: 'bk_1', type: 'referral-ask' })
  assert.deepEqual(where, {
    deliveredAt: { gte: since },
    booking: { customerId: 'cus_1' },
    NOT: { bookingId: 'bk_1', type: 'referral-ask' },
  })
  const json = JSON.stringify(where)
  assert.ok(!json.includes('"status"'), 'must not filter on a status column')
  assert.ok(!json.includes('sent'), "must never mention 'sent'")
})

test('followupCapWhere in source never filters on status sent', () => {
  const s = src('src/lib/followups.ts').replace(/\r\n/g, '\n')
  const start = s.indexOf('export function followupCapWhere')
  assert.ok(start > -1)
  const body = s.slice(start, s.indexOf('\n}\n', start))
  assert.ok(body.includes('deliveredAt'))
  assert.ok(!/status/.test(body), body)
})

test('followupEmailStatus maps guard outcomes', () => {
  const sent: SendOutcome = { sent: true, providerId: 'prov_1', emailSendId: 'es_1' }
  assert.deepEqual(followupEmailStatus(sent), { status: 'delivered' })
  assert.deepEqual(followupEmailStatus({ sent: false, reason: 'duplicate' }), { status: 'delivered' })

  const na = (o: SendOutcome) => {
    const r = followupEmailStatus(o)
    assert.equal(r.status, 'not_applicable', JSON.stringify(o))
    assert.ok(r.error && r.error.length > 0, 'not_applicable carries an error')
  }
  na({ sent: false, reason: 'booking_advanced:CANCELLED', outcomeClass: 'terminal' })
  na({ sent: false, reason: 'provider_timeout', outcomeClass: 'ambiguous' })
  na({ sent: false, reason: 'ambiguous' })
  na({ sent: false, reason: 'terminal:invalid_to' })
  na({ sent: false, reason: 'attempts_exhausted' })

  const retry = followupEmailStatus({ sent: false, reason: 'provider_error', outcomeClass: 'retryable' })
  assert.equal(retry.status, 'failed')
  assert.ok(retry.error)
})

test('followupDeferUntil: a guard deferral carries its own due time and never burns an attempt', () => {
  const now = Date.parse('2026-09-15T12:00:00Z')
  const capAt = new Date(now + 24 * 3600_000)
  assert.equal(followupDeferUntil({ sent: false, reason: 'cap_weekly', outcomeClass: 'deferred', retryAt: capAt }, now)?.getTime(), capAt.getTime())
  const due = new Date(now + 120_000)
  assert.equal(followupDeferUntil({ sent: false, reason: 'not_due', notDueUntil: due }, now)?.getTime(), due.getTime())
  assert.ok((followupDeferUntil({ sent: false, reason: 'in_flight' }, now)?.getTime() ?? 0) > now)
  // Ordinary failures are attempts; a sent outcome is not a deferral.
  assert.equal(followupDeferUntil({ sent: false, reason: 'provider_error', outcomeClass: 'retryable' }, now), null)
  assert.equal(followupDeferUntil({ sent: true, providerId: 'p', emailSendId: 'e' }, now), null)
})

test('retryDueFollowups closes stale retryable rows before re-driving, and exhausted rows end failed_terminal', () => {
  const s = src('src/lib/followups.ts').replace(/\r\n/g, '\n')
  const fn = s.slice(s.indexOf('export async function retryDueFollowups'), s.indexOf('\n}\n', s.indexOf('export async function retryDueFollowups')))
  const close = fn.indexOf("terminalReason: 'stale:retry-window-expired'")
  const read = fn.indexOf('findMany')
  assert.ok(close > -1 && read > close, 'stale rows are closed before the due rows are read')
  assert.ok(/createdAt: \{ gte: cutoff \}/.test(fn), 'the re-drive is bounded by age')
  assert.ok(FOLLOWUP_RETRY_MAX_AGE_MS <= 14 * 24 * 3600_000)
  assert.ok(/status === 'failed_retryable' && attemptsUsed >= FOLLOWUP_MAX_EMAIL_ATTEMPTS/.test(s), 'out of attempts → failed_terminal, not a stranded retryable row')
})

// ── 5. SMS is gone ──────────────────────────────────────────────────────

test('no lifecycle path references smsQueue, and the SMS worker is deleted', () => {
  for (const rel of [
    'src/lib/followups.ts',
    'src/lib/notify.ts',
    'src/lib/fulfillment.ts',
    'src/lib/booking-approval.ts',
    'src/workers/scheduled.worker.ts',
  ]) {
    assert.ok(!src(rel).includes('smsQueue'), `${rel} still references smsQueue`)
  }
  assert.equal(existsSync(resolve(ROOT, 'src/workers/sms.worker.ts')), false)
})

test("follow-up ledger claim writes smsStatus 'not_applicable'", () => {
  const s = src('src/lib/followups.ts')
  const m = s.match(/followUpLedger\.create\(\{[\s\S]{0,400}?status:\s*'claimed'[^}]*\}/)
  assert.ok(m, 'ledger claim create not found')
  assert.match(m[0], /smsStatus:\s*'not_applicable'/)
})

// ── 6. campaign lead recheck ────────────────────────────────────────────

test('campaign recheck passes the template to leadEligibility and refuses a subjectless recipient', () => {
  const s = src('src/lib/email-campaign-dispatch.ts')
  assert.ok(s.includes('leadEligibility(recipient.leadId, template)'))
  const i = s.indexOf('leadEligibility(recipient.leadId, template)')
  assert.match(s.slice(i, i + 300), /return 'no_recheck_subject'/)
})

test('recipientStateForOutcome: live-state refusals are INELIGIBLE, missing consent stays DEFERRED', () => {
  for (const reason of ['has_quote', 'previous_customer', 'no_recheck_subject']) {
    assert.equal(recipientStateForOutcome({ sent: false, reason }).status, 'INELIGIBLE', reason)
  }
  assert.equal(
    recipientStateForOutcome({ sent: false, reason: 'no_marketing_consent', outcomeClass: 'retryable' }).status,
    'DEFERRED'
  )
})

// ── 7–9. journeys: fake JourneyDeps ─────────────────────────────────────

function quotedLead(id: string, over: Partial<JourneyLead> = {}): JourneyLead {
  return {
    id,
    email: EMAIL,
    status: 'QUOTED',
    quotedAt: new Date(NOW.getTime() - HOUR),
    bookedAt: null,
    lostAt: null,
    moveDate: new Date(NOW.getTime() + 30 * DAY),
    convertedBookingId: null,
    emailMarketingConsent: true,
    ...over,
  }
}

type World = {
  deps: JourneyDeps
  calls: string[]
  jobs: Map<string, string>
  leads: Map<string, JourneyLead>
  customerConsent: Map<string, boolean | null>
  repairLimits: number[]
}

function world(opts: {
  enqueueResult?: boolean | undefined
  leads?: JourneyLead[]
  pool?: string[]
  attempted?: Set<string>
} = {}): World {
  const w: World = {
    deps: null as unknown as JourneyDeps,
    calls: [],
    jobs: new Map(),
    leads: new Map((opts.leads ?? []).map((l) => [l.id, l])),
    customerConsent: new Map(),
    repairLimits: [],
  }
  const enqueueResult = 'enqueueResult' in opts ? opts.enqueueResult : true
  w.deps = {
    now: () => NOW,
    async enqueue(stage, _data, _fireAt, jobId) {
      w.calls.push(`enqueue:${jobId}`)
      if (enqueueResult !== false && !w.jobs.has(jobId)) w.jobs.set(jobId, stage)
      return enqueueResult
    },
    async cancel(jobId) {
      w.calls.push(`cancel:${jobId}`)
      w.jobs.delete(jobId)
    },
    async loadLead(id) {
      return w.leads.get(id) ?? null
    },
    async hasEverBooked() {
      return false
    },
    async bookingMarketingBlock(bookingId) {
      w.calls.push(`consentCheck:${bookingId}`)
      return w.customerConsent.get(EMAIL) === true ? null : 'no_marketing_consent'
    },
    async siblingUnpaidBooking() {
      return null
    },
    async convertLead(email, bookingId, o) {
      w.calls.push(`convertLead:${bookingId}`)
      if (email && typeof o.marketingConsent === 'boolean') w.customerConsent.set(email, o.marketingConsent)
      return null
    },
    async loadBookingDates() {
      return null
    },
    async repairCandidates({ limit }) {
      w.repairLimits.push(limit)
      return (opts.pool ?? []).slice(0, limit).map((id) => ({ id }))
    },
    async leadsAlreadyAttempted(ids) {
      return new Set(ids.filter((id) => opts.attempted?.has(id)))
    },
    fireLeadTrigger() {},
    fireBookingTrigger() {},
    stopEnrollments() {},
  }
  return w
}

test('ensureQuoteJourney reports enqueue_failed when every stage enqueue resolves false', async () => {
  const w = world({ enqueueResult: false, leads: [quotedLead('lead_q')] })
  const outcome = await ensureQuoteJourney('lead_q', w.deps)
  // A bare `false` (a world with no retry store) means nothing recorded the
  // failure: every stage is LOST, and the outcome says so by count (2026-09-15).
  assert.deepEqual(outcome, { scheduled: false, reason: 'enqueue_failed', recordedForRetry: 0, lost: QUOTE_STAGES.length })
  assert.equal(w.calls.filter((c) => c.startsWith('enqueue:')).length, QUOTE_STAGES.length)
})

test('ensureQuoteJourney treats a legacy void enqueue as success', async () => {
  const w = world({ enqueueResult: undefined, leads: [quotedLead('lead_q')] })
  const outcome = await ensureQuoteJourney('lead_q', w.deps)
  assert.equal(outcome.scheduled, true)
  if (outcome.scheduled) assert.equal(outcome.stages, QUOTE_STAGES.length)
})

test('repair: 60 already-attempted leads cannot starve a stranded one out of a limit-50 pass', async () => {
  const attemptedIds = Array.from({ length: 60 }, (_, i) => `lead_done_${i}`)
  const leads = [...attemptedIds, 'lead_stranded'].map((id) => quotedLead(id))
  const w = world({
    leads,
    pool: [...attemptedIds, 'lead_stranded'],
    attempted: new Set(attemptedIds),
  })
  const report = await repairStrandedQuoteJourneys({ limit: 50 }, w.deps)
  assert.ok(w.repairLimits[0] > 60, `candidate read must be wider than the batch (got ${w.repairLimits[0]})`)
  assert.equal(report.alreadyAttempted, 60)
  assert.equal(report.scheduled, 1)
  assert.ok(QUOTE_STAGES.every((s) => w.jobs.has(jobIdFor('quote', s.type, 'lead_stranded'))))
})

const abandonedIds = (bookingId: string) => ABANDONED_STAGES.map((s) => `enqueue:${jobIdFor('abandoned', s.type, bookingId)}`)

test('onBookingCreated propagates consent (convertLead) BEFORE any abandoned-checkout enqueue', async () => {
  const w = world()
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL, marketingConsent: true }, w.deps)
  const convert = w.calls.indexOf('convertLead:bk_1')
  const ids = abandonedIds('bk_1')
  const firstEnqueue = Math.min(...ids.map((id) => w.calls.indexOf(id)))
  assert.ok(convert > -1, 'convertLead was called')
  assert.ok(ids.every((id) => w.calls.includes(id)), `every abandoned stage enqueued: ${w.calls.join(', ')}`)
  assert.ok(convert < firstEnqueue, `convertLead must precede enqueue: ${w.calls.join(', ')}`)
  assert.ok(convert < w.calls.indexOf('consentCheck:bk_1'), 'consent is propagated before it is read')
})

for (const consent of [false, null] as const) {
  test(`onBookingCreated with consent ${consent} enqueues no abandoned-checkout stage`, async () => {
    const w = world()
    await onBookingCreated({ bookingId: 'bk_1', email: EMAIL, marketingConsent: consent }, w.deps)
    assert.ok(w.calls.includes('convertLead:bk_1'))
    assert.equal(w.calls.filter((c) => c.startsWith('enqueue:')).length, 0, w.calls.join(', '))
  })
}
