// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE ENQUEUE DURABILITY — what happens when Redis says no.
//  (production reliability release 2026-09-15)
//  ---------------------------------------------------------------------
//  THE DEFECT THIS PINS. Every lifecycle scheduler raced `queue.add` against a
//  5s timeout, logged the failure as "non-fatal", and then logged "scheduled"
//  anyway. A Redis stall during checkout deleted a customer's whole abandoned
//  sequence, a booking approval lost both pre-move reminders, and the only
//  trace was an info line claiming the opposite. Nothing ever looked at that
//  work again.
//
//  THE CONTRACT NOW, exercised here through the PRODUCTION code (journeys,
//  followups and fulfillment are driven by their real functions with a fake
//  queue and a fake Prisma delegate behind the REAL store):
//    • an add that fails writes the EXACT job — queue, name, data,
//      deterministic id, intended fire time, lateness bound — to
//      lifecycle_enqueue_retries, and the caller says "recorded for retry";
//    • an add that fails AND cannot be recorded says LOST, loudly and counted;
//    • the hourly sweep re-adds that job under the SAME id, once, and never
//      after the row's `not_after`;
//    • a cancelled stage's row is closed, so the sweep can never resurrect it;
//    • nothing here re-decides eligibility: the re-added job is byte-identical
//      to the one the live path meant to add, so it runs the same gates.
//
//  Offline: no Postgres, no Redis, no Resend. The DB-gated companion is
//  lifecycle-enqueue-retry-db.test.ts.
// ════════════════════════════════════════════════════════════════════════
import './_lifecycle-durability-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captured, type CapturedLog } from './_lifecycle-durability-env'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import {
  ABANDONED_STAGES,
  BALANCE_REMINDER_DELAY_MS,
  LEAD_NURTURE_STAGES,
  QUOTE_STAGES,
  REMINDER_OFFSETS,
  ensureQuoteJourney,
  jobIdFor,
  journeyQueueEdge,
  onBookingCancelled,
  onBookingCompletedBalance,
  onCheckoutStarted,
  onLeadCaptured,
  onMoveDateSet,
  type JourneyDeps,
  type JourneyLead,
} from '../journeys'
import {
  COMPLETION_DELAYS,
  deferFollowupForQuietHours,
  onBookingCompleted,
  shiftIntoAllowedHours,
  type FollowupScheduleDeps,
} from '../followups'
import { enqueueFanout, fanoutJobId, fanoutSummary } from '../fulfillment'
import {
  CANCELLED_REASON,
  LIFECYCLE_ENQUEUE_LOST,
  PAYMENT_FANOUT_RETRY_WINDOW_MS,
  TOO_LATE_REASON,
  enqueueDurable,
  lifecycleEnqueueCounters,
  resetLifecycleEnqueueCounters,
  retryWindowFor,
  type LifecyclePath,
  type QueueLike,
  type RetryStore,
} from '../lifecycle-enqueue'
// The REAL store, on an in-memory Prisma delegate that models the unique
// job_id index — see _lifecycle-retry-memory-db.ts.
import { memoryRetryStore, type MemoryRetryDb } from './_lifecycle-retry-memory-db'
import {
  RETRY_BACKOFF_CAP_MS,
  UNROUTABLE_REASON,
  lifecycleRetryMetrics,
  nextRetryAt,
  retryDelayMs,
  runLifecycleRetrySweep,
  sweepShiftFor,
  type LifecycleRetrySweepDeps,
} from '../lifecycle-retry-sweep'
import { nextAllowedTime } from '../email-guard'

// A production-looking DATABASE_URL / Redis URL / Resend key is a HARD
// FAILURE, never a skip — see _disposable-test-env.ts.
assertNoProductionCredentials()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 11:00 America/New_York — comfortably outside quiet hours both ways. */
const NOW = new Date('2026-09-15T15:00:00.000Z')
const now = () => NOW

const BOOKING = 'bk_durable_1'
const LEAD = 'lead_durable_1'
const EMAIL = 'durability@example.com'
assertTestRecipient(EMAIL)

// ════════════════════════════════════════════════════════════════════════
//  FAKE QUEUE — BullMQ's dedupe-by-job-id semantics, and its failure modes.
// ════════════════════════════════════════════════════════════════════════

type AddAttempt = { name: string; data: Record<string, unknown>; delay: number; jobId: string; deduped: boolean }
type Mode = 'ok' | 'false' | 'throw' | 'hang'

type FakeQueue = QueueLike & {
  attempts: AddAttempt[]
  jobs: Map<string, AddAttempt>
  mode: Mode
  getJob(jobId: string): Promise<{ remove(): Promise<unknown> } | undefined>
  removed: string[]
}

function fakeQueue(name = 'scheduled', mode: Mode = 'ok'): FakeQueue {
  const q: FakeQueue = {
    name,
    mode,
    attempts: [],
    jobs: new Map(),
    removed: [],
    async add(jobName, data, options) {
      const jobId = String(options?.jobId ?? '')
      const attempt: AddAttempt = {
        name: jobName,
        data: (data ?? {}) as Record<string, unknown>,
        delay: options?.delay ?? 0,
        jobId,
        deduped: q.jobs.has(jobId),
      }
      q.attempts.push(attempt)
      if (q.mode === 'false') return false
      if (q.mode === 'throw') throw new Error('Connection is closed.')
      if (q.mode === 'hang') return new Promise(() => {})
      // BullMQ ignores an add for a job id that already exists, in ANY state.
      if (!attempt.deduped) q.jobs.set(jobId, attempt)
      return q.jobs.get(jobId)
    },
    async getJob(jobId) {
      const job = q.jobs.get(jobId)
      if (!job) return undefined
      return {
        async remove() {
          q.jobs.delete(jobId)
          q.removed.push(jobId)
        },
      }
    },
  }
  return q
}

/** Successful adds only — the attempts list also records the refusals. */
const addedIds = (q: FakeQueue) => q.attempts.filter((a) => !a.deduped).map((a) => a.jobId)

// ════════════════════════════════════════════════════════════════════════
//  WORLDS
// ════════════════════════════════════════════════════════════════════════

function makeLead(over: Partial<JourneyLead> = {}): JourneyLead {
  return {
    id: LEAD,
    email: EMAIL,
    status: 'NEW',
    quotedAt: null,
    bookedAt: null,
    lostAt: null,
    moveDate: null,
    convertedBookingId: null,
    emailMarketingConsent: true,
    ...over,
  }
}

type World = {
  queue: FakeQueue
  db: MemoryRetryDb
  store: RetryStore
  deps: JourneyDeps
}

/** The real journey edge (durable enqueue + retry-closing cancel) on fakes. */
function journeyWorld(opts: { mode?: Mode; lead?: JourneyLead; consentBlock?: string | null; sibling?: string | null } = {}): World {
  const queue = fakeQueue('scheduled', opts.mode ?? 'ok')
  const { db, store } = memoryRetryStore()
  const lead = opts.lead ?? makeLead()
  const deps: JourneyDeps = {
    now,
    ...journeyQueueEdge({ queue, store, now }),
    async loadLead(leadId) {
      return leadId === lead.id ? lead : null
    },
    async hasEverBooked() {
      return false
    },
    async bookingMarketingBlock() {
      return opts.consentBlock ?? null
    },
    async siblingUnpaidBooking() {
      return opts.sibling ?? null
    },
    async convertLead() {
      return null
    },
    async loadBookingDates() {
      return null
    },
    async repairCandidates() {
      return []
    },
    async leadsAlreadyAttempted() {
      return new Set<string>()
    },
    fireLeadTrigger() {},
    fireBookingTrigger() {},
    stopEnrollments() {},
  }
  return { queue, db, store, deps }
}

function followupDeps(edge: { queue: QueueLike; store: RetryStore }): FollowupScheduleDeps {
  return {
    now,
    async stampCompleted() {},
    async marketingBlock() {
      return null
    },
    edge: { queue: edge.queue, store: edge.store, now },
  }
}

function sweepDeps(store: RetryStore, queues: Record<string, FakeQueue>): LifecycleRetrySweepDeps {
  return {
    store,
    queueFor: (name) => queues[name] ?? null,
    shiftFor: sweepShiftFor,
  }
}

/** Run the hourly sweep against a working queue. */
const sweep = (store: RetryStore, queues: Record<string, FakeQueue>, at: Date = NOW) =>
  runLifecycleRetrySweep({ now: at, deps: sweepDeps(store, queues) })

// ── log capture helpers ────────────────────────────────────────────────
const mark = () => captured.length
const since = (from: number): CapturedLog[] => captured.slice(from)
const saidScheduled = (logs: CapturedLog[], label: string) =>
  logs.some((l) => l.level === 'info' && l.msg === `${label} scheduled`)
const mentionsAddress = (logs: CapturedLog[]) => logs.some((l) => JSON.stringify(l).includes('@example.com'))

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')

// ════════════════════════════════════════════════════════════════════════
//  1. enqueueDurable — the three honest outcomes
// ════════════════════════════════════════════════════════════════════════

const durableInput = (queue: QueueLike, over: Partial<Parameters<typeof enqueueDurable>[0]> = {}) => ({
  queue,
  // The CALLER names its queue. Never `queue.name` — that is the read the
  // production bug depended on (see "a queue that throws on every property
  // read" below).
  queueName: 'scheduled',
  name: 'abandoned-checkout-recovery',
  data: { type: 'abandoned-checkout-recovery', bookingId: BOOKING },
  jobId: jobIdFor('abandoned', 'abandoned-checkout-recovery', BOOKING),
  fireAt: new Date(NOW.getTime() + 45 * MINUTE),
  notAfter: new Date(NOW.getTime() + 45 * MINUTE + 3 * HOUR),
  path: 'abandoned-checkout' as LifecyclePath,
  subjectType: 'booking' as const,
  subjectId: BOOKING,
  ...over,
})

test('a successful add is "scheduled" and writes NO retry row', async () => {
  const queue = fakeQueue()
  const { db, store } = memoryRetryStore()
  const r = await enqueueDurable(durableInput(queue), { store, now })

  assert.deepEqual(r, { status: 'scheduled' })
  assert.equal(db.rows.length, 0, 'a healthy enqueue must not create retry work')
  assert.equal(queue.attempts[0].delay, 45 * MINUTE, 'delay is fireAt − now')
})

test('the schedule-time quiet-hours shift is applied to the delay', async () => {
  const queue = fakeQueue()
  const { store } = memoryRetryStore()
  // 02:00 ET the next morning — inside the 21:00–08:00 quiet window.
  const fireAt = new Date('2026-09-16T06:00:00.000Z')
  await enqueueDurable(durableInput(queue, { fireAt, notAfter: new Date(fireAt.getTime() + 3 * HOUR) }), { store, now })

  assert.equal(queue.attempts[0].delay, nextAllowedTime(fireAt).getTime() - NOW.getTime())
  assert.ok(queue.attempts[0].delay > fireAt.getTime() - NOW.getTime(), 'the shift pushed it later, not earlier')
})

test('add returning false records the EXACT job for retry', async () => {
  const queue = fakeQueue('scheduled', 'false')
  const { db, store } = memoryRetryStore()
  const input = durableInput(queue)
  const r = await enqueueDurable(input, { store, now })

  assert.deepEqual(r, { status: 'recorded_for_retry' })
  assert.equal(db.rows.length, 1)
  const row = db.rows[0]
  assert.equal(row.queueName, 'scheduled')
  assert.equal(row.jobName, input.name)
  assert.equal(row.jobId, input.jobId)
  assert.deepEqual(row.data, input.data)
  assert.equal(row.fireAt.getTime(), input.fireAt.getTime())
  assert.equal(row.notAfter.getTime(), input.notAfter.getTime())
  assert.equal(row.path, 'abandoned-checkout')
  assert.equal(row.subjectType, 'booking')
  assert.equal(row.subjectId, BOOKING)
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 1)
  assert.equal(row.nextAttemptAt.getTime(), NOW.getTime(), 'due immediately — the next sweep picks it up')
})

test('a throwing add, and an add that HANGS, both record for retry', async () => {
  for (const mode of ['throw', 'hang'] as const) {
    const queue = fakeQueue('scheduled', mode)
    const { db, store } = memoryRetryStore()
    // A hang is the real Redis failure mode (maxRetriesPerRequest: null never
    // rejects), so the timeout is the only thing that can save the caller.
    const r = await enqueueDurable(durableInput(queue), { store, now, timeoutMs: 25 })
    assert.deepEqual(r, { status: 'recorded_for_retry' }, `mode ${mode}`)
    assert.equal(db.rows.length, 1, `mode ${mode} recorded exactly one row`)
    assert.ok((db.rows[0].lastError ?? '').length > 0, 'the reason is kept for the operator')
  }
})

test('when the retry row ALSO cannot be written the result is LOST, counted and tagged', async () => {
  resetLifecycleEnqueueCounters()
  const queue = fakeQueue('scheduled', 'false')
  const { db, store } = memoryRetryStore({ createThrows: true })
  const at = mark()
  const r = await enqueueDurable(durableInput(queue), { store, now })

  assert.deepEqual(r, { status: 'lost' })
  assert.equal(db.rows.length, 0)
  assert.equal(lifecycleEnqueueCounters().lost, 1, 'the in-process counter is the only record a lost job leaves')
  const logs = since(at)
  const lost = logs.find((l) => l.level === 'error' && l.msg.includes(LIFECYCLE_ENQUEUE_LOST))
  assert.ok(lost, 'an operator must be able to grep LIFECYCLE_ENQUEUE_LOST')
  assert.equal(lost!.obj.tag, LIFECYCLE_ENQUEUE_LOST)
  assert.ok(!mentionsAddress(logs), 'no recipient address in a lifecycle enqueue log')
})

test('two concurrent failures for ONE job id leave ONE row', async () => {
  const queue = fakeQueue('scheduled', 'false')
  const { db, store } = memoryRetryStore()
  const results = await Promise.all([
    enqueueDurable(durableInput(queue), { store, now }),
    enqueueDurable(durableInput(queue), { store, now }),
  ])

  assert.deepEqual(
    results.map((r) => r.status),
    ['recorded_for_retry', 'recorded_for_retry']
  )
  assert.equal(db.rows.length, 1, 'the unique job_id index collapses the duplicate')
  assert.equal(db.rows[0].attempts, 2, 'both failures are counted on the one row')
})

test('a row the sweep already enqueued is NOT flipped back to pending by a later failure', async () => {
  const queue = fakeQueue('scheduled', 'false')
  const { db, store } = memoryRetryStore()
  const input = durableInput(queue)
  await enqueueDurable(input, { store, now })
  await store.markEnqueued(db.rows[0].id, NOW)

  await enqueueDurable(input, { store, now })

  // The sweep already put this exact job in Redis; re-pending it would re-add a
  // job that may have run. The attempt is still counted for the operator.
  assert.equal(db.rows[0].status, 'enqueued')
  assert.equal(db.rows[0].attempts, 2)
})

// ════════════════════════════════════════════════════════════════════════
//  2. not_after POLICY — a bound on lateness, never a replay of history
// ════════════════════════════════════════════════════════════════════════

test('every lifecycle stage carries its documented lateness bound', () => {
  const fireAt = NOW
  const expected: Array<[string, LifecyclePath, number]> = [
    ['abandoned-checkout-recovery', 'abandoned-checkout', 3 * HOUR],
    ['abandoned-checkout-recovery-2', 'abandoned-checkout', 12 * HOUR],
    ['abandoned-checkout-recovery-3', 'abandoned-checkout', 12 * HOUR],
    ['job-reminder-72h', 'pre-move', 12 * HOUR],
    ['job-reminder-24h', 'pre-move', 6 * HOUR],
    ['balance-reminder-post', 'balance', 48 * HOUR],
    ['lead-nurture-1', 'lead-nurture', 12 * HOUR],
    ['lead-nurture-2', 'lead-nurture', 12 * HOUR],
    ['lead-nurture-final', 'lead-nurture', 12 * HOUR],
    ['quote-followup-1', 'quote-journey', 24 * HOUR],
    ['quote-followup-2', 'quote-journey', 24 * HOUR],
    ['quote-followup-final', 'quote-journey', 24 * HOUR],
    ['review-request', 'post-job-followup', 72 * HOUR],
    ['review-reminder', 'post-job-followup', 72 * HOUR],
    ['referral-ask', 'post-job-followup', 72 * HOUR],
    ['repeat-reminder', 'post-job-followup', 72 * HOUR],
  ]
  for (const [stage, path, lateMs] of expected) {
    const w = retryWindowFor(stage, fireAt)
    assert.ok(w, `${stage} must have a retry policy`)
    assert.equal(w!.path, path, `${stage} path`)
    assert.equal(w!.notAfter.getTime(), fireAt.getTime() + lateMs, `${stage} bound`)
  }
  assert.equal(retryWindowFor('not-a-stage', fireAt), null, 'an unknown stage gets no invented bound')
})

test('a pre-move reminder is never retried past the move itself', () => {
  // The bound is the tighter of "late by X" and "before the move starts", and
  // the reminder copy ("in 3 days" / "tomorrow") is why.
  const fireAt = NOW
  assert.ok(retryWindowFor('job-reminder-72h', fireAt)!.notAfter.getTime() < fireAt.getTime() + 72 * HOUR)
  assert.ok(retryWindowFor('job-reminder-24h', fireAt)!.notAfter.getTime() < fireAt.getTime() + 24 * HOUR)
})

// ════════════════════════════════════════════════════════════════════════
//  3. EVERY LIVE PATH: a refused enqueue is recorded, never called "scheduled",
//     and the sweep re-adds exactly that job — once.
// ════════════════════════════════════════════════════════════════════════

/** The shared shape of every path test below. */
async function assertRecordedThenSwept(input: {
  db: MemoryRetryDb
  store: RetryStore
  expected: Array<{ jobId: string; name: string; data: Record<string, unknown>; fireAt: number; path: LifecyclePath }>
  queueName?: string
}): Promise<void> {
  const { db, store, expected } = input
  const queueName = input.queueName ?? 'scheduled'
  assert.equal(db.rows.length, expected.length, 'one retry row per stage that did not enqueue')
  for (const e of expected) {
    const row = db.byJobId(e.jobId)
    assert.ok(row, `a row for ${e.jobId}`)
    assert.equal(row!.queueName, queueName, `${e.jobId} is routed back to the queue its caller named`)
    assert.equal(row!.jobName, e.name)
    assert.deepEqual(row!.data, e.data)
    assert.equal(row!.fireAt.getTime(), e.fireAt, `${e.jobId} keeps its INTENDED fire time`)
    assert.equal(row!.path, e.path)
    assert.equal(row!.status, 'pending')
  }

  // Every other queue is present and healthy too, so "it landed on the right
  // one" is a real assertion rather than the only option available.
  const healthy = fakeQueue(queueName)
  const others = Object.fromEntries(
    ['scheduled', 'email', 'discord', 'marketing'].filter((n) => n !== queueName).map((n) => [n, fakeQueue(n)])
  )
  const first = await sweep(store, { ...others, [queueName]: healthy })
  assert.equal(first.enqueued, expected.length)
  for (const [name, q] of Object.entries(others)) {
    assert.equal(q.attempts.length, 0, `nothing was mis-routed onto the ${name} queue`)
  }
  assert.deepEqual(
    addedIds(healthy).slice().sort(),
    expected.map((e) => e.jobId).sort(),
    'the sweep re-adds the SAME deterministic job ids'
  )
  for (const e of expected) {
    const added = healthy.attempts.find((a) => a.jobId === e.jobId)!
    assert.equal(added.name, e.name, 'same job name — it routes to the same handler')
    assert.deepEqual(added.data, e.data, 'same payload — the handler re-reads and re-gates on it')
  }

  const second = await sweep(store, { [queueName]: healthy })
  assert.equal(second.examined, 0, 'a second sweep finds nothing: enqueued rows are closed')
  assert.equal(healthy.attempts.length, expected.length, 'and adds nothing a second time')
}

test('CONTROL: a healthy enqueue still says "scheduled" — the negative assertions below mean something', async () => {
  const w = journeyWorld()
  const at = mark()
  const summary = await onCheckoutStarted(BOOKING, w.deps)

  assert.deepEqual(summary, { scheduled: 3, recordedForRetry: 0, lost: 0, skipped: 0 })
  assert.ok(saidScheduled(since(at), 'abandoned-recovery'), 'the success line is unchanged')
  assert.equal(w.db.rows.length, 0)
  assert.deepEqual(addedIds(w.queue).sort(), ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, BOOKING)).sort())
})

test('ABANDONED CHECKOUT: three refused stages are recorded, never logged as scheduled, then swept', async () => {
  const w = journeyWorld({ mode: 'false' })
  const at = mark()
  const summary = await onCheckoutStarted(BOOKING, w.deps)

  assert.deepEqual(summary, { scheduled: 0, recordedForRetry: 3, lost: 0, skipped: 0 })
  const logs = since(at)
  assert.ok(!saidScheduled(logs, 'abandoned-recovery'), 'the old lie ("abandoned-recovery scheduled") is gone')
  assert.ok(
    logs.some((l) => l.level === 'warn' && l.msg.includes('NOT fully scheduled')),
    'the failure is stated out loud'
  )
  assert.ok(!mentionsAddress(logs))

  await assertRecordedThenSwept({
    db: w.db,
    store: w.store,
    expected: ABANDONED_STAGES.map((s) => ({
      jobId: jobIdFor('abandoned', s.type, BOOKING),
      name: s.type,
      data: { type: s.type, bookingId: BOOKING },
      fireAt: NOW.getTime() + s.delay,
      path: 'abandoned-checkout' as LifecyclePath,
    })),
  })
})

test('PRE-MOVE REMINDERS: both offsets are recorded against the move date, then swept', async () => {
  const w = journeyWorld({ mode: 'false' })
  const moveDate = new Date(NOW.getTime() + 5 * DAY)
  const at = mark()
  const summary = await onMoveDateSet(BOOKING, moveDate, w.deps)

  assert.deepEqual(summary, { scheduled: 0, recordedForRetry: 2, lost: 0, skipped: 0 })
  assert.ok(!saidScheduled(since(at), 'pre-move reminders'))

  await assertRecordedThenSwept({
    db: w.db,
    store: w.store,
    expected: REMINDER_OFFSETS.map((r) => ({
      jobId: jobIdFor('pre-move', r.type, BOOKING),
      name: r.type,
      data: { type: r.type, bookingId: BOOKING },
      fireAt: moveDate.getTime() - r.before,
      path: 'pre-move' as LifecyclePath,
    })),
  })
})

test('BALANCE REMINDER: a refused enqueue returns "recorded_for_retry", then is swept', async () => {
  const w = journeyWorld({ mode: 'false' })
  const at = mark()
  const status = await onBookingCompletedBalance(BOOKING, w.deps)

  assert.equal(status, 'recorded_for_retry')
  assert.ok(!saidScheduled(since(at), 'post-completion balance reminder'))

  await assertRecordedThenSwept({
    db: w.db,
    store: w.store,
    expected: [
      {
        jobId: jobIdFor('balance', 'balance-reminder-post', BOOKING),
        name: 'balance-reminder-post',
        data: { type: 'balance-reminder-post', bookingId: BOOKING },
        fireAt: NOW.getTime() + BALANCE_REMINDER_DELAY_MS,
        path: 'balance',
      },
    ],
  })
})

test('LEAD NURTURE: refused stages are recorded and swept; "scheduled" is never logged', async () => {
  const w = journeyWorld({ mode: 'false' })
  const at = mark()
  const summary = await onLeadCaptured(LEAD, w.deps)

  assert.deepEqual(summary, { scheduled: 0, recordedForRetry: LEAD_NURTURE_STAGES.length, lost: 0, skipped: 0 })
  assert.ok(!saidScheduled(since(at), 'lead nurture'))
  assert.ok(!mentionsAddress(since(at)), 'a nurture failure log names the lead id, never the address')

  await assertRecordedThenSwept({
    db: w.db,
    store: w.store,
    expected: LEAD_NURTURE_STAGES.map((s) => ({
      jobId: jobIdFor('lead-nurture', s.type, LEAD),
      name: s.type,
      data: { type: s.type, leadId: LEAD },
      fireAt: NOW.getTime() + s.delay,
      path: 'lead-nurture' as LifecyclePath,
    })),
  })
})

test('QUOTE JOURNEY: a total enqueue failure is reported truthfully and swept', async () => {
  const w = journeyWorld({ mode: 'false', lead: makeLead({ quotedAt: NOW }) })
  const at = mark()
  const outcome = await ensureQuoteJourney(LEAD, w.deps)

  // Nothing reached the queue, so the admin audit must not say it did.
  assert.deepEqual(outcome, { scheduled: false, reason: 'recorded_for_retry', recordedForRetry: 3, lost: 0 })
  assert.ok(!saidScheduled(since(at), 'quote follow-up'))

  await assertRecordedThenSwept({
    db: w.db,
    store: w.store,
    expected: QUOTE_STAGES.map((s) => ({
      jobId: jobIdFor('quote', s.type, LEAD),
      name: s.type,
      data: { type: s.type, leadId: LEAD },
      fireAt: NOW.getTime() + s.delay,
      path: 'quote-journey' as LifecyclePath,
    })),
  })
})

test('POST-JOB FOLLOW-UPS: all four stages are recorded and swept', async () => {
  const queue = fakeQueue('scheduled', 'false')
  const { db, store } = memoryRetryStore()
  const at = mark()
  const summary = await onBookingCompleted(BOOKING, followupDeps({ queue, store }))

  assert.deepEqual(summary, { scheduled: 0, recordedForRetry: COMPLETION_DELAYS.length, lost: 0, skipped: 0 })
  assert.ok(!saidScheduled(since(at), 'completion follow-ups'))

  await assertRecordedThenSwept({
    db,
    store,
    expected: COMPLETION_DELAYS.map(({ type, delay }) => ({
      jobId: `followup__${type}__${BOOKING}`,
      name: type,
      data: { type, bookingId: BOOKING },
      fireAt: NOW.getTime() + delay,
      path: 'post-job-followup' as LifecyclePath,
    })),
  })
})

test('QUIET-HOURS DEFERRAL: the re-add is no longer dropped on the floor', async () => {
  // It used to be `.catch(() => {})`: with no ledger row claimed yet, a failed
  // re-add completed the job "successfully" and the follow-up was gone.
  const queue = fakeQueue('scheduled', 'false')
  const { db, store } = memoryRetryStore()
  const wait = 9 * HOUR
  const outcome = await deferFollowupForQuietHours(BOOKING, 'review-request', wait, { queue, store, now })

  assert.equal(outcome, 'deferred-quiet-hours:recorded-for-retry')
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].jobId, `followup__review-request__${BOOKING}__retry`, 'its own __retry id, as before')
  assert.equal(db.rows[0].fireAt.getTime(), NOW.getTime() + wait)

  const healthy = fakeQueue('scheduled')
  await sweep(store, { scheduled: healthy })
  assert.deepEqual(addedIds(healthy), [`followup__review-request__${BOOKING}__retry`])
})

test('QUIET-HOURS DEFERRAL: a LOST re-add throws, so BullMQ runs the job again', async () => {
  const queue = fakeQueue('scheduled', 'false')
  const { store } = memoryRetryStore({ createThrows: true })
  await assert.rejects(
    () => deferFollowupForQuietHours(BOOKING, 'review-request', 9 * HOUR, { queue, store, now }),
    /could not be enqueued or recorded/,
    'no ledger row is claimed yet, so a retry of the whole job is safe and is the only recovery left'
  )
})

test('PAYMENT FAN-OUT: a refused approval card is recorded and swept on its own queue', async () => {
  const discord = fakeQueue('discord', 'false')
  const { db, store } = memoryRetryStore()
  const data = { type: 'booking-created', bookingId: BOOKING, payload: { displayId: 'MIC-1' } }
  const at = mark()
  const status = await enqueueFanout('discord:booking-created', { queue: discord, queueName: 'discord', name: 'booking-created', kind: 'booking-created', data }, BOOKING, { store, now })

  assert.equal(status, 'recorded_for_retry')
  assert.ok(
    since(at).some((l) => l.level === 'warn' && l.msg.includes('recorded for retry')),
    'the webhook says what actually happened'
  )
  assert.equal(db.rows[0].notAfter.getTime(), NOW.getTime() + PAYMENT_FANOUT_RETRY_WINDOW_MS)

  await assertRecordedThenSwept({
    db,
    store,
    queueName: 'discord',
    expected: [
      { jobId: fanoutJobId('booking-created', BOOKING), name: 'booking-created', data, fireAt: NOW.getTime(), path: 'payment-fanout' },
    ],
  })
})

test('PAYMENT FAN-OUT: every descriptor records its OWN queue, and the sweep routes each one back there', async () => {
  // The whole paid-checkout fan-out at once, all four queues refusing. Getting
  // any ONE of these names wrong is the defect: the sweep would hand a discord
  // or marketing job to the scheduled worker, whose dispatch warns "unknown job
  // type" and then COMPLETES it — the row reads 'enqueued', the backlog check
  // reads clean, and the approval card for a customer whose $49 is already held
  // is gone for good.
  const { db, store } = memoryRetryStore()
  const refusing = {
    email: fakeQueue('email', 'false'),
    discord: fakeQueue('discord', 'false'),
    marketing: fakeQueue('marketing', 'false'),
  }
  const descriptors = [
    { label: 'email:pre-approval', queue: refusing.email, queueName: 'email', name: 'pre-approval', kind: 'pre-approval' },
    { label: 'discord:booking-created', queue: refusing.discord, queueName: 'discord', name: 'booking-created', kind: 'booking-created' },
    { label: 'marketing:enroll', queue: refusing.marketing, queueName: 'marketing', name: 'booking-paid', kind: 'marketing-enroll' },
    { label: 'discord:create-job-channels', queue: refusing.discord, queueName: 'discord', name: 'create-job-channels', kind: 'create-job-channels' },
  ]
  for (const d of descriptors) {
    const status = await enqueueFanout(d.label, { queue: d.queue, queueName: d.queueName, name: d.name, kind: d.kind, data: { type: d.name, bookingId: BOOKING } }, BOOKING, { store, now })
    assert.equal(status, 'recorded_for_retry', d.label)
  }

  for (const d of descriptors) {
    const row = db.byJobId(fanoutJobId(d.kind, BOOKING))!
    assert.ok(row, `a row for ${d.label}`)
    assert.equal(row.queueName, d.queueName, `${d.label} must be routed back to the ${d.queueName} queue`)
  }
  assert.equal(db.rows.filter((r) => r.queueName === 'scheduled').length, 0, 'no fan-out row may name the scheduled queue')

  const healthy = { scheduled: fakeQueue('scheduled'), email: fakeQueue('email'), discord: fakeQueue('discord'), marketing: fakeQueue('marketing') }
  const counts = await sweep(store, healthy)

  assert.equal(counts.enqueued, descriptors.length)
  assert.deepEqual(addedIds(healthy.email), [fanoutJobId('pre-approval', BOOKING)])
  assert.deepEqual(addedIds(healthy.discord).sort(), [fanoutJobId('booking-created', BOOKING), fanoutJobId('create-job-channels', BOOKING)].sort())
  assert.deepEqual(addedIds(healthy.marketing), [fanoutJobId('marketing-enroll', BOOKING)])
  assert.equal(healthy.scheduled.attempts.length, 0, 'the scheduled worker has no handler for any of these job names')
})

test('the queue name comes from the CALLER: a queue that throws on every property read still records the right route', async () => {
  // THE PRODUCTION SHAPE. src/lib/queues/index.ts wraps each queue in a Proxy
  // whose get trap constructs it, and getBullConnection() throws when REDIS_URL
  // is unset. So `.name` throws exactly when `.add` throws — the code used to
  // read the name off that object and fall back to the literal 'scheduled',
  // guessing the route for the only rows that ever take this path.
  const unbuildable = new Proxy({} as QueueLike, {
    get() {
      throw new Error('REDIS_URL is required in production')
    },
  })
  const { db, store } = memoryRetryStore()
  const status = await enqueueFanout(
    'discord:booking-created',
    { queue: unbuildable, queueName: 'discord', name: 'booking-created', kind: 'booking-created', data: { type: 'booking-created', bookingId: BOOKING } },
    BOOKING,
    { store, now }
  )

  assert.equal(status, 'recorded_for_retry', 'a queue that cannot even be constructed is still recorded, never thrown')
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].queueName, 'discord', 'the caller named it; the unbuildable object was never asked')
  assert.notEqual(db.rows[0].queueName, 'scheduled')

  // And it sweeps onto discord, not onto the queue the old fallback named.
  const healthy = { scheduled: fakeQueue('scheduled'), discord: fakeQueue('discord') }
  await sweep(store, healthy)
  assert.deepEqual(addedIds(healthy.discord), [fanoutJobId('booking-created', BOOKING)])
  assert.equal(healthy.scheduled.attempts.length, 0)
})

test('no caller infers its queue name from the queue object, and no fallback names a routable queue', () => {
  const enqueueSrc = src('src/lib/lifecycle-enqueue.ts')
  const body = enqueueSrc.slice(enqueueSrc.indexOf('export async function enqueueDurable'))
  assert.ok(!/input\.queue\.name/.test(body), 'reading .name off a queue that failed to build throws — that is the whole defect')
  assert.match(body, /const queueName = input\.queueName/, 'the caller supplies the name')

  // Each fan-out descriptor names the queue it actually passes.
  const fulfillment = src('src/lib/fulfillment.ts')
  for (const [queue, name] of [
    ['edge.email', 'email'],
    ['edge.discord', 'discord'],
    ['edge.marketing', 'marketing'],
  ] as const) {
    const at = fulfillment.indexOf(`queue: ${queue},`)
    assert.ok(at > -1, `${queue} is still a fan-out queue`)
    for (let i = at; i > -1; i = fulfillment.indexOf(`queue: ${queue},`, i + 1)) {
      assert.match(fulfillment.slice(i, i + 120), new RegExp(`queueName: '${name}'`), `${queue} must be named '${name}'`)
    }
  }
  // The lifecycle schedulers name the scheduled queue for themselves.
  for (const file of ['src/lib/journeys.ts', 'src/lib/followups.ts']) {
    assert.match(src(file), /queueName: 'scheduled',/, `${file} names its queue`)
  }
})

test('PAYMENT FAN-OUT: "all jobs queued" is said only when all jobs were queued', () => {
  assert.equal(fanoutSummary(['scheduled', 'scheduled']).level, 'info')
  assert.match(fanoutSummary(['scheduled']).message, /all jobs queued/)
  const partial = fanoutSummary(['scheduled', 'recorded_for_retry'])
  assert.equal(partial.level, 'warn')
  assert.doesNotMatch(partial.message, /all jobs queued/)
  const lost = fanoutSummary(['scheduled', 'lost'])
  assert.equal(lost.level, 'error')
  assert.match(lost.message, /LOST/)
  assert.deepEqual(lost.counts, { scheduled: 1, recorded_for_retry: 0, lost: 1 })
})

// ════════════════════════════════════════════════════════════════════════
//  4. THE SWEEP'S OWN RULES
// ════════════════════════════════════════════════════════════════════════

test('a row past its not_after is ABANDONED and never re-added', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onCheckoutStarted(BOOKING, w.deps)

  // Stage 1 fires at +45m with a 3h bound; four hours later it is history.
  const late = new Date(NOW.getTime() + 45 * MINUTE + 4 * HOUR)
  const healthy = fakeQueue('scheduled')
  const counts = await sweep(w.store, { scheduled: healthy }, late)

  const stage1 = w.db.byJobId(jobIdFor('abandoned', ABANDONED_STAGES[0].type, BOOKING))!
  assert.equal(stage1.status, 'abandoned')
  assert.equal(stage1.lastError, TOO_LATE_REASON)
  assert.equal(stage1.resolvedAt!.getTime(), late.getTime())
  assert.ok(!addedIds(healthy).includes(stage1.jobId), 'an expired stage is never replayed')
  assert.equal(counts.abandonedTooLate, 1)
  // The other two stages are still inside their 12h bounds and DO go.
  assert.equal(counts.enqueued, 2)
})

test('a cancelled stage: the row is closed, and the sweep never resurrects it', async () => {
  const w = journeyWorld({ mode: 'false' })
  const moveDate = new Date(NOW.getTime() + 5 * DAY)
  await onMoveDateSet(BOOKING, moveDate, w.deps)
  assert.equal(w.db.rows.filter((r) => r.status === 'pending').length, 2)

  await onBookingCancelled(BOOKING, w.deps)

  for (const r of REMINDER_OFFSETS) {
    const row = w.db.byJobId(jobIdFor('pre-move', r.type, BOOKING))!
    assert.equal(row.status, 'abandoned', `${r.type} row closed by the cancel`)
    assert.equal(row.lastError, CANCELLED_REASON)
  }
  const healthy = fakeQueue('scheduled')
  const counts = await sweep(w.store, { scheduled: healthy })
  assert.equal(counts.examined, 0)
  assert.equal(healthy.attempts.length, 0, 'a cancelled booking gets no reminders, outage or not')
})

test('the cancel closes the retry row even while Redis is still refusing', async () => {
  // The cancel path used to touch only Redis. During an outage that is exactly
  // when a row exists, so closing the row must not depend on the queue.
  const w = journeyWorld({ mode: 'false' })
  await onBookingCompletedBalance(BOOKING, w.deps)
  w.queue.mode = 'throw'

  await onBookingCancelled(BOOKING, w.deps)

  const row = w.db.byJobId(jobIdFor('balance', 'balance-reminder-post', BOOKING))!
  assert.equal(row.status, 'abandoned')
  assert.equal(row.lastError, CANCELLED_REASON)
})

test('a row naming a queue this process cannot route is abandoned LOUDLY, never delivered to a default queue', async () => {
  const marketing = fakeQueue('marketing', 'false')
  const { db, store } = memoryRetryStore()
  await enqueueFanout('marketing:enroll', { queue: marketing, queueName: 'marketing', name: 'booking-paid', kind: 'marketing-enroll', data: { bookingId: BOOKING } }, BOOKING, { store, now })

  const fallback = fakeQueue('scheduled')
  const at = mark()
  const counts = await sweep(store, { scheduled: fallback })

  assert.equal(counts.abandonedUnroutable, 1)
  assert.equal(counts.enqueued, 0)
  assert.equal(db.rows[0].status, 'abandoned')
  assert.equal(db.rows[0].lastError, UNROUTABLE_REASON)
  // The name the sweep cannot resolve is an operator error, not a routing
  // decision: a job delivered to the wrong worker is warned-and-completed there
  // and would be counted as repaired.
  assert.equal(fallback.attempts.length, 0, 'an unknown queue name never falls through to another queue')
  assert.ok(
    since(at).some((l) => l.level === 'error' && l.msg.includes('unknown queue')),
    'an unroutable row is an error line, not a silent default'
  )
})

test('a sweep whose re-add fails backs off, keeps the row pending, and succeeds later', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onBookingCompletedBalance(BOOKING, w.deps)
  const row = w.db.rows[0]

  const stillBroken = fakeQueue('scheduled', 'throw')
  const counts = await sweep(w.store, { scheduled: stillBroken })
  assert.equal(counts.failed, 1)
  assert.equal(counts.enqueued, 0)
  assert.equal(row.status, 'pending', 'still owed')
  assert.equal(row.attempts, 2)
  assert.ok(row.nextAttemptAt.getTime() > NOW.getTime(), 'and not retried in a tight loop')
  assert.ok(row.nextAttemptAt.getTime() <= row.notAfter.getTime(), 'the back-off never skips past the bound')

  const healthy = fakeQueue('scheduled')
  const later = new Date(row.nextAttemptAt.getTime())
  await sweep(w.store, { scheduled: healthy }, later)
  assert.deepEqual(addedIds(healthy), [jobIdFor('balance', 'balance-reminder-post', BOOKING)])
  assert.equal(row.status, 'enqueued')
  assert.equal(row.resolvedAt!.getTime(), later.getTime())
})

test('nextRetryAt: exponential, capped at an hour, never past the row bound', () => {
  const notAfter = new Date(NOW.getTime() + 10 * DAY)
  assert.equal(nextRetryAt(0, NOW, notAfter).getTime(), NOW.getTime() + MINUTE)
  assert.equal(nextRetryAt(3, NOW, notAfter).getTime(), NOW.getTime() + 8 * MINUTE)
  assert.equal(nextRetryAt(12, NOW, notAfter).getTime(), NOW.getTime() + RETRY_BACKOFF_CAP_MS, 'capped at 1h')
  const soon = new Date(NOW.getTime() + 90_000)
  assert.equal(nextRetryAt(9, NOW, soon).getTime(), soon.getTime(), 'the last attempt happens AT not_after')
})

test('retryDelayMs: a future stage keeps its time, an overdue one goes now, quiet hours still shift', () => {
  const identity = (d: Date) => d
  assert.equal(retryDelayMs({ fireAt: new Date(NOW.getTime() + 2 * HOUR) }, NOW, identity), 2 * HOUR)
  assert.equal(retryDelayMs({ fireAt: new Date(NOW.getTime() - 2 * HOUR) }, NOW, identity), 0, 'overdue means now, not a replay at the old time')

  // 23:00 ET: the live path would have shifted it, so the retry does too.
  const quiet = new Date('2026-09-16T03:00:00.000Z')
  const shifted = retryDelayMs({ fireAt: quiet }, NOW, sweepShiftFor('lead-nurture'))
  assert.equal(shifted, nextAllowedTime(quiet).getTime() - NOW.getTime())
  assert.ok(shifted > quiet.getTime() - NOW.getTime())
})

test('post-job retries re-apply followups.ts own quiet-hours window', () => {
  const quiet = new Date('2026-09-16T03:00:00.000Z')
  assert.equal(sweepShiftFor('post-job-followup')(quiet).getTime(), shiftIntoAllowedHours(quiet).getTime())
  assert.equal(sweepShiftFor('payment-fanout')(quiet).getTime(), quiet.getTime(), 'a transactional fan-out is never delayed')
})

test('the sweep is bounded and takes the oldest work first', async () => {
  const { db, store } = memoryRetryStore()
  const queue = fakeQueue('scheduled', 'false')
  for (let i = 0; i < 5; i++) {
    await enqueueDurable(
      durableInput(queue, { jobId: `journey__abandoned__abandoned-checkout-recovery__bk_${i}`, subjectId: `bk_${i}` }),
      { store, now }
    )
    // Oldest due first: bk_0 is the most overdue.
    db.rows[i].nextAttemptAt = new Date(NOW.getTime() - (5 - i) * MINUTE)
  }

  const healthy = fakeQueue('scheduled')
  const counts = await runLifecycleRetrySweep({ now: NOW, limit: 2, deps: sweepDeps(store, { scheduled: healthy }) })

  assert.equal(counts.examined, 2)
  assert.deepEqual(addedIds(healthy), [
    'journey__abandoned__abandoned-checkout-recovery__bk_0',
    'journey__abandoned__abandoned-checkout-recovery__bk_1',
  ])
})

test('metrics report the backlog without leaking job data', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onCheckoutStarted(BOOKING, w.deps)
  const healthy = fakeQueue('scheduled')
  await sweep(w.store, { scheduled: healthy })

  const m = await lifecycleRetryMetrics(w.store, NOW)
  assert.equal(m.pending, 0)
  assert.equal(m.enqueued, 3)
  assert.equal(m.abandoned, 0)
  assert.equal(m.lastSweepCounts!.enqueued, 3)
  assert.ok(m.lastSweepAt)
  assert.ok(!JSON.stringify(m).includes('@'), 'metrics carry counts, never recipients')
})

test('the health summary counts a stale backlog but ignores cancellations', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onCheckoutStarted(BOOKING, w.deps)
  // One row aged past the warn and critical thresholds.
  w.db.rows[0].createdAt = new Date(NOW.getTime() - 7 * HOUR)
  // One row closed by a cancel — the system working, not a failure.
  await w.store.abandonForJobIds([w.db.rows[1].jobId], CANCELLED_REASON, NOW)
  // One row closed as too late — a customer message genuinely skipped.
  await w.store.markAbandoned(w.db.rows[2].id, TOO_LATE_REASON, NOW)

  const s = await w.store.summary(NOW)
  assert.equal(s.pendingOlderThan2h, 1)
  assert.equal(s.pendingOlderThan6h, 1)
  assert.equal(s.abandonedLast24h, 1, 'the cancelled row must not page anyone')
})

// ════════════════════════════════════════════════════════════════════════
//  5. WHAT THE DURABLE PATH MUST NOT CHANGE
// ════════════════════════════════════════════════════════════════════════

test('a REFUSED journey records nothing — durability never becomes enrolment', async () => {
  // No promotional consent: the stages were never meant to exist, so there is
  // nothing to retry. The retry table only ever holds work a live trigger
  // actually decided to schedule.
  const w = journeyWorld({ mode: 'false', consentBlock: 'no_marketing_consent' })
  assert.equal(await onCheckoutStarted(BOOKING, w.deps), null)
  assert.equal(w.db.rows.length, 0)
  assert.equal(w.queue.attempts.length, 0)

  const dup = journeyWorld({ mode: 'false', sibling: 'bk_earlier' })
  assert.equal(await onCheckoutStarted(BOOKING, dup.deps), null)
  assert.equal(dup.db.rows.length, 0, 'a duplicate checkout stays refused')
})

test('the re-added job is byte-identical, so the stage handler re-gates it', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onCheckoutStarted(BOOKING, w.deps)
  const healthy = fakeQueue('scheduled')
  await sweep(w.store, { scheduled: healthy })

  const stage1 = healthy.attempts.find((a) => a.jobId === jobIdFor('abandoned', 'abandoned-checkout-recovery', BOOKING))!
  assert.deepEqual(stage1.data, { type: 'abandoned-checkout-recovery', bookingId: BOOKING })

  // …and that handler still re-reads the booking and refuses an advanced one.
  const worker = src('src/workers/scheduled.worker.ts')
  const abandoned = worker.slice(worker.indexOf("case 'abandoned-checkout-recovery':"), worker.indexOf("case 'job-reminder-72h':"))
  assert.match(abandoned, /booking\.status !== 'PENDING_PAYMENT'/, 'the recovery stage still self-cancels once paid')
  assert.match(abandoned, /isInternalTest/)
  const reminder = worker.slice(worker.indexOf("case 'job-reminder-72h':"), worker.indexOf("case 'quote-followup-1':"))
  assert.match(reminder, /\['CONFIRMED', 'SCHEDULED'\]\.includes\(booking\.status\)/, 'the reminder still re-checks status')
})

test('the sweep touches Redis ONLY by add-with-the-same-id', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onCheckoutStarted(BOOKING, w.deps)
  const healthy = fakeQueue('scheduled')
  await sweep(w.store, { scheduled: healthy })
  assert.deepEqual(healthy.removed, [], 'no removals: a completed or failed job must stay as it is')

  const sweepSrc = src('src/lib/lifecycle-retry-sweep.ts')
  for (const forbidden of ['.remove(', 'getJob(', 'getState(', 'obliterate(', 'drain(']) {
    assert.ok(!sweepSrc.includes(forbidden), `the sweep must not call ${forbidden}`)
  }
})

test('retry job ids stay BullMQ-safe and deterministic', async () => {
  const w = journeyWorld({ mode: 'false' })
  await onCheckoutStarted(BOOKING, w.deps)
  await onMoveDateSet(BOOKING, new Date(NOW.getTime() + 5 * DAY), w.deps)
  await onBookingCompletedBalance(BOOKING, w.deps)
  const queue = fakeQueue('scheduled', 'false')
  await onBookingCompleted(BOOKING, followupDeps({ queue, store: w.store }))
  await enqueueFanout('discord:booking-created', { queue: fakeQueue('discord', 'false'), queueName: 'discord', name: 'booking-created', kind: 'booking-created', data: {} }, BOOKING, { store: w.store, now })

  assert.ok(w.db.rows.length > 0)
  for (const row of w.db.rows) {
    // A custom BullMQ job id may not contain ':'.
    assert.ok(!row.jobId.includes(':'), `${row.jobId} must not contain a colon`)
    assert.ok(row.jobId.includes(BOOKING), 'and must name its subject')
  }
})

// ════════════════════════════════════════════════════════════════════════
//  6. WIRING — the sweep only helps if something runs it
// ════════════════════════════════════════════════════════════════════════

test('the hourly lifecycle-repair job runs the retry sweep, and still runs both older repairs', () => {
  const worker = src('src/workers/scheduled.worker.ts')
  const body = worker.slice(worker.indexOf("case 'lifecycle-repair':"), worker.indexOf("case 'lifecycle-repair':") + 3000)
  assert.match(body, /runLifecycleRetrySweep\(/, 'the durable retries are swept hourly')
  assert.match(body, /repairStrandedQuoteJourneys\(/, 'and the stranded-quote repair is untouched')
  assert.match(body, /retryDueFollowups\(/, 'and the follow-up ledger retry is untouched')
  // An outage is exactly when the retry sweep has work to do, so no earlier
  // repair in the same job may be able to skip it by throwing.
  for (const call of ['repairStrandedQuoteJourneys()', 'retryDueFollowups()']) {
    const at = body.indexOf(call)
    assert.ok(at > -1, `${call} is called`)
    assert.match(body.slice(at, at + 40), /\.catch\(/, `${call} must not be able to abort the retry sweep`)
  }
})

test('the retry table is declared, migrated, and unique on job_id', () => {
  const schema = src('prisma/schema.prisma')
  const model = schema.slice(schema.indexOf('model LifecycleEnqueueRetry {'))
  assert.match(model, /jobId\s+String\s+@unique @map\("job_id"\)/, 'one row per deterministic job id')
  assert.match(model, /@@map\("lifecycle_enqueue_retries"\)/)
  assert.match(model, /@@index\(\[status, nextAttemptAt\]\)/, 'the sweep query is indexed')

  const migration = src('prisma/migrations/20260915120200_lifecycle_enqueue_retries/migration.sql')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "lifecycle_enqueue_retries"/)
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_enqueue_retries_job_id_key"/)
  assert.match(migration, /DROP TABLE IF EXISTS "lifecycle_enqueue_retries"/, 'the rollback is written down')
  assert.ok(!/ALTER TABLE "(?!lifecycle_enqueue_retries)/.test(migration), 'additive only — no existing table is touched')

  // RE-RUNNABLE, like its two siblings in this release. Reaching this file with
  // the objects already present — applied by hand during an incident, or re-run
  // after a partially applied deploy — would otherwise abort; `migrate deploy`
  // then records the migration FAILED and blocks every subsequent deploy until
  // someone runs `migrate resolve --rolled-back`.
  const ddl = migration.split('\n').filter((l) => !l.trimStart().startsWith('--'))
  const creates = ddl.filter((l) => /^CREATE /.test(l.trim()))
  assert.equal(creates.length, 4, 'the table and all three indexes')
  for (const stmt of creates) {
    assert.match(stmt, /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS /, `re-running the migration must not abort: ${stmt}`)
  }
})

test('the email agent surfaces a retry backlog, with counts and no addresses', () => {
  const checks = src('src/lib/email-agent/checks/send.ts')
  const block = checks.slice(checks.indexOf("id: 'lifecycle.enqueue_retry_backlog'"), checks.indexOf('export const sendChecks'))
  assert.match(block, /severity: critical \? 'critical' : 'warning'/)
  assert.match(block, /abandonedLast24h > 0 \|\| s\.pendingOlderThan6h > 0/, 'critical: work skipped, or a sweep that is not running')
  assert.match(block, /pendingOlderThan2h > 0/, 'warning: a backlog older than 2h')
  const evidence = block.slice(block.indexOf('evidence: {'), block.indexOf('suggestedActions'))
  assert.ok(!/email|recipient|to:/i.test(evidence), 'evidence is counts only')
})
