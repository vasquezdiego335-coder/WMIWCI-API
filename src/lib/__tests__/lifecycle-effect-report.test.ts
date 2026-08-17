// ════════════════════════════════════════════════════════════════════════════
//  lifecycle-effect-report.test.ts — BLOCKER D3, under the SHIPPED DEFAULT.
//
//  THE REPRODUCTION (docs/moving-os-money-final2.md § D3):
//
//    effects: {"email":"queued","followups":"ok","balance":"ok"}
//    owner sees: "Move-complete email queued · review/referral sequence
//                 scheduled · balance reminder scheduled."
//
//  …with `EMAIL_JOURNEYS_ENABLED` and `MARKETING_FOLLOWUPS_ENABLED` unset —
//  which is what a stock deployment runs — so BOTH functions return before
//  their enqueue and NOTHING is scheduled. The report was inferring "it did the
//  work" from "it did not throw".
//
//  HOW THIS FILE IS RUN
//   • THE SHIPPED CODE RUNS. `lifecycle-service.ts`, `followups.ts` and
//     `journeys.ts` are imported for real against a fake Prisma client
//     installed before `src/lib/db.ts` loads (`_effect-report-harness.ts`).
//     Only the queue is a seam — and it is the SHIPPED function's own seam,
//     used to COUNT what reached the queue, never to replace the decision.
//   • THE BOOKING ROW COMES FROM THE SHIPPED WRITER (`buildBookingCreateData`).
//   • THE ENVIRONMENT IS THE SHIPPED DEFAULT. The flags are deleted below,
//     before any module reads them. The flags-ON cases (consent, a queue that
//     refuses) live in `lifecycle-effect-consent.test.ts` — a module-level
//     `const ENABLED = process.env…` is read once per process, so the two
//     environments cannot share a file.
//   • MUTATION-TESTED. § 0 reproduces the PRE-FIX MAPPING against the same
//     shipped functions and asserts the exact false report above still appears.
//     If that test ever goes green-by-accident, nothing below means anything.
//
//  OFFLINE: no database, no Redis, no Stripe, no network.
//    npx tsx --test src/lib/__tests__/lifecycle-effect-report.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── THE SHIPPED DEFAULT ENVIRONMENT, set before anything reads it ───────────
delete process.env.MARKETING_FOLLOWUPS_ENABLED
delete process.env.EMAIL_JOURNEYS_ENABLED
// A canary allowlist would block scheduling for a reason that has nothing to do
// with this blocker.
delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST
// C3-2 added an owner ALERT on a failed crew cancellation, and the D3-b failure
// cases below run the shipped default fan-out. Without a token `postOpsAlert`
// returns 'not configured' and touches no network — a test must never be able to
// post to the live Discord.
delete process.env.DISCORD_BOT_TOKEN

import { installFakePrisma, assertUsingFake, seedBooking, theDb, resetDb, quietLogger, type Row } from './_effect-report-harness'

installFakePrisma()

type Mods = {
  lifecycle: typeof import('../lifecycle-service')
  followups: typeof import('../followups')
  journeys: typeof import('../journeys')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    lifecycle: await import('../lifecycle-service'),
    followups: await import('../followups'),
    journeys: await import('../journeys'),
  }
  await assertUsingFake()
  return mods
}

const AT = new Date('2027-07-15T21:00:00.000Z')
const db = theDb

/** Every queue add the shipped code attempted, and what it was for. */
type QueueSpy = { adds: string[] }

/** The SHIPPED handoffs, with the queue replaced by a counter. The decision to
 *  enqueue (or not) is still entirely the shipped function's. */
async function shippedEffects(spy: QueueSpy, opts: { queue?: 'up' | 'down' } = {}) {
  const m = await load()
  const up = (opts.queue ?? 'up') === 'up'
  const journeyDeps = {
    ...m.journeys.defaultJourneyDeps(),
    async enqueue(stage: string, _data: Record<string, unknown>, _fireAt: Date, jobId: string) {
      spy.adds.push(`${stage}:${jobId}`)
      return up ? { ok: true } : { ok: false, reason: 'scheduledQueue.add timed out (Redis?)' }
    },
  }
  const followupDeps: import('../followups').CompletionFollowupDeps = {
    ...m.followups.defaultCompletionFollowupDeps(),
    async addScheduled(type, bookingId, _delayMs, jobId) {
      spy.adds.push(`${type}:${jobId}`)
      if (!up) throw new Error('scheduledQueue.add timed out (Redis?)')
      void bookingId
    },
  }
  const emails: string[] = []
  const effects: import('../lifecycle-service').LifecycleEffects = {
    async sendCompletionEmail(b) {
      if (!b.customer?.email) return false
      emails.push(b.id)
      return true
    },
    scheduleFollowups: (id) => m.followups.onBookingCompleted(id, followupDeps),
    scheduleBalanceReminder: (id) => m.journeys.onBookingCompletedBalance(id, journeyDeps),
    async stopJourneys() {},
  }
  return { effects, emails, followupDeps, journeyDeps }
}

// ════════════════════════════════════════════════════════════════════════════
//  0. THE HARNESS CAN STILL SEE THE ORIGINAL DEFECT
// ════════════════════════════════════════════════════════════════════════════

/** The report as it SHIPPED: 'ok' the moment the call returns without throwing.
 *  The handoffs are the real ones; what is reproduced is the caller's mapping,
 *  which is where the false claim lived. */
async function preFixReport(bookingId: string, spy: QueueSpy): Promise<{ email: string; followups: string; balance: string }> {
  const { followupDeps, journeyDeps } = await shippedEffects(spy)
  const m = await load()
  const report = { email: 'queued', followups: 'not-run', balance: 'not-run' }
  try {
    await m.followups.onBookingCompleted(bookingId, followupDeps) // ← return value DISCARDED, as it was
    report.followups = 'ok'
  } catch {
    report.followups = 'failed'
  }
  try {
    await m.journeys.onBookingCompletedBalance(bookingId, journeyDeps) // ← likewise
    report.balance = 'ok'
  } catch {
    report.balance = 'failed'
  }
  return report
}

/** The owner-facing line as it SHIPPED (src/lib/lifecycle-service.ts, before
 *  this fix). Kept verbatim so the sentence the owner actually read is the
 *  thing this test asserts about. */
function preFixMessage(r: { email: string; followups: string; balance: string }): string {
  const parts = [
    r.email === 'queued' ? 'Move-complete email queued' : 'Move-complete email could NOT be queued',
    r.followups === 'ok' ? 'review/referral sequence scheduled' : 'follow-up sequence FAILED to schedule',
    r.balance === 'ok' ? 'balance reminder scheduled' : 'balance reminder FAILED to schedule',
  ]
  return `${parts.join(' · ')}. Anything already sent is not sent twice.`
}

test('DEFECT D3: the pre-fix report claims a sequence the shipped functions never scheduled', async () => {
  const m = await load()
  await seedBooking({ status: 'COMPLETED', completedAt: AT })

  // The flags this deployment actually ships with.
  assert.equal(m.followups.FOLLOWUPS_ENABLED, false, 'precondition: MARKETING_FOLLOWUPS_ENABLED is not set')
  assert.equal(m.journeys.JOURNEYS_ENABLED, false, 'precondition: EMAIL_JOURNEYS_ENABLED is not set')

  const spy: QueueSpy = { adds: [] }
  const report = await preFixReport('bk_life', spy)

  // ── The exact reproduction from the blocker document ──────────────────────
  assert.deepEqual(report, { email: 'queued', followups: 'ok', balance: 'ok' }, 'THE DEFECT: "ok" for both')
  assert.equal(
    preFixMessage(report),
    'Move-complete email queued · review/referral sequence scheduled · balance reminder scheduled. ' +
      'Anything already sent is not sent twice.',
    'THE DEFECT: the owner is told work was scheduled',
  )
  // …and this is what actually happened.
  assert.deepEqual(spy.adds, [], 'NOTHING reached the queue — both functions returned before their enqueue')
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE FIX — the report distinguishes, and the owner string says which
// ════════════════════════════════════════════════════════════════════════════

test('D3: under the shipped default the report says SKIPPED-DISABLED, not scheduled', async () => {
  const m = await load()
  await seedBooking({ status: 'IN_PROGRESS' })
  const spy: QueueSpy = { adds: [] }
  const { effects, emails } = await shippedEffects(spy)

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects, logger: quietLogger },
  )

  assert.ok(res.ok, 'the completion itself is committed — this is a REPORTING fix, not a behaviour change')
  const eff = res.ok ? res.effects! : null
  assert.deepEqual(eff!.followups, { state: 'skipped', reason: 'followups-disabled', count: 0 })
  assert.deepEqual(eff!.balance, { state: 'skipped', reason: 'journeys-disabled', count: 0 })
  assert.deepEqual(eff!.email, { state: 'queued', count: 1 }, 'the email really was handed to the queue')
  assert.deepEqual(spy.adds, [], 'and the report matches reality: nothing was enqueued')
  assert.deepEqual(emails, ['bk_life'])

  // The completion is still durable and still exactly-once.
  assert.equal(db().bookings.get('bk_life')!.status, 'COMPLETED')
  assert.ok(db().bookings.get('bk_life')!.completedAt)
})

test('D3: the owner-facing sentence names the reason instead of claiming "scheduled"', async () => {
  const m = await load()
  await seedBooking({ status: 'IN_PROGRESS' })
  const spy: QueueSpy = { adds: [] }
  const { effects } = await shippedEffects(spy)

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects, logger: quietLogger },
  )
  const message = m.lifecycle.replayCompletionMessage(res.ok ? res.effects! : ({} as never))

  assert.ok(!/sequence scheduled/.test(message), `the false claim must be GONE: ${message}`)
  assert.ok(!/balance reminder scheduled/.test(message), `and so must this one: ${message}`)
  assert.match(message, /review request skipped — follow-ups are switched off/)
  assert.match(message, /balance reminder skipped — lifecycle journeys are switched off/)
  assert.match(message, /Move-complete email queued/, 'what DID happen is still reported')
})

test('D3: a queue that refuses is FAILED — never "scheduled", and never a skip', async () => {
  const m = await load()
  await seedBooking({ status: 'IN_PROGRESS' })
  const spy: QueueSpy = { adds: [] }
  const { effects } = await shippedEffects(spy, { queue: 'down' })

  // The flags are off in this file, so drive the two handoffs' failure paths
  // through the report's own classifiers — the same functions afterCompletion
  // calls, with the outcomes the shipped handoffs produce when every add is
  // refused (proved end-to-end in lifecycle-effect-consent.test.ts).
  const partial = m.lifecycle.followupOutcome({ scheduled: 3, failed: 1, total: 4, reason: 'enqueue_failed' })
  assert.equal(partial.state, 'failed', 'three of four stages on the queue is NOT "the sequence is scheduled"')
  assert.equal(partial.count, 3, 'and the report carries what really landed')

  const none = m.lifecycle.balanceOutcome({ scheduled: false, reason: 'scheduledQueue.add timed out (Redis?)' })
  assert.equal(none.state, 'failed')
  assert.match(m.lifecycle.replayCompletionMessage({ email: { state: 'queued' }, followups: partial, balance: none }), /FAILED to schedule/)

  // The completion still stands when the queue is down — only the messages are
  // in doubt, which is exactly what the report now says.
  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects, logger: quietLogger },
  )
  assert.ok(res.ok)
  assert.equal(db().bookings.get('bk_life')!.status, 'COMPLETED')
})

test('D3: a handoff that never ran is reported as not-run, not as a skip', async () => {
  const m = await load()
  await seedBooking({ status: 'IN_PROGRESS' })
  const spy: QueueSpy = { adds: [] }
  const { effects } = await shippedEffects(spy)
  // The Discord interaction budget expires while the email handoff hangs.
  const hanging: import('../lifecycle-service').LifecycleEffects = {
    ...effects,
    async sendCompletionEmail() {
      await new Promise(() => {})
      return true
    },
  }

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'sebastian' }, source: 'discord', at: AT, effectsTimeoutMs: 25 },
    { effects: hanging, logger: quietLogger },
  )

  assert.ok(res.ok, 'the crew still get their card')
  const eff = res.ok ? res.effects! : null
  assert.equal(eff!.timedOut, true)
  assert.equal(eff!.email.state, 'not-run', 'a handoff still running is not a handoff that skipped')
  assert.equal(eff!.followups.state, 'not-run')
  assert.match(m.lifecycle.replayCompletionMessage(eff!), /not attempted/)
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE SMALLER ONE — a P2002 on the deterministic audit id used to roll back
//     REAL remediation and then report it as a skip
// ════════════════════════════════════════════════════════════════════════════

const crewRow = (id: string): Row => ({ id, jobId: 'job_1', assignmentStatus: 'ASSIGNED' })

test('DEFECT D3-b: the pre-fix shape rolls the remediation back on the duplicate audit id', async () => {
  const m = await load()
  await seedBooking({ status: 'CANCELLED' }, { job: { status: 'CANCELLED' }, crew: [crewRow('jc_1')] })
  // An earlier pass already wrote the once-per-booking ledger row.
  const prisma = (await import('../db')).prisma as unknown as {
    auditLog: { create(a: unknown): Promise<unknown> }
    job: { updateMany(a: unknown): Promise<{ count: number }> }
    jobCrew: { updateMany(a: unknown): Promise<{ count: number }> }
    $transaction(fn: (tx: unknown) => Promise<unknown>): Promise<unknown>
  }
  await prisma.auditLog.create({
    data: { id: m.lifecycle.jobCancellationAuditId('bk_life'), action: 'BOOKING_STATE_CHANGED', bookingId: 'bk_life' },
  })

  // THE PRE-FIX BODY: the audit id is claimed unconditionally, inside the
  // transaction that does the remediation.
  const preFix = async (): Promise<{ jobCancelled: boolean; crewCancelled: number; skipped?: string }> => {
    try {
      return (await prisma.$transaction(async (tx) => {
        const t = tx as typeof prisma
        const job = await t.job.updateMany({ where: { bookingId: 'bk_life', status: { notIn: ['CANCELLED', 'COMPLETED'] } }, data: { status: 'CANCELLED' } })
        const crew = await t.jobCrew.updateMany({
          where: { jobId: 'job_1', assignmentStatus: { in: m.lifecycle.CANCELLABLE_ASSIGNMENT_STATUSES } },
          data: { assignmentStatus: 'CANCELLED', cancelledAt: AT, cancelReason: 'Booking cancelled' },
        })
        if (job.count === 0 && crew.count === 0) return { jobCancelled: false, crewCancelled: 0, skipped: 'nothing_live' }
        await t.auditLog.create({
          data: { id: m.lifecycle.jobCancellationAuditId('bk_life'), action: 'BOOKING_STATE_CHANGED', bookingId: 'bk_life' },
        })
        return { jobCancelled: job.count > 0, crewCancelled: crew.count }
      })) as { jobCancelled: boolean; crewCancelled: number; skipped?: string }
    } catch (e) {
      return { jobCancelled: false, crewCancelled: 0, skipped: `failed:${(e as Error).message}` }
    }
  }

  const out = await preFix()

  assert.match(out.skipped ?? '', /^failed:/, 'THE DEFECT: a failure wearing the word "skipped"')
  assert.equal(out.crewCancelled, 0)
  assert.equal(
    db().jobCrew.get('jc_1')!.assignmentStatus,
    'ASSIGNED',
    'THE DEFECT: the live crew of a CANCELLED move stayed live — the remediation rolled back with the audit row',
  )
})

test('D3-b: a repeat pass finishes crew assigned AFTER the first cancellation', async () => {
  const m = await load()
  await seedBooking({ status: 'CANCELLED' }, { crew: [crewRow('jc_1')] })

  const first = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { logger: quietLogger },
  )
  assert.deepEqual(
    { job: first.jobCancelled, crew: first.crewCancelled, failed: first.failed },
    { job: true, crew: 1, failed: undefined },
  )

  // A worker is assigned to the cancelled move afterwards (the conflict engine
  // warns, and the owner can still be wrong). The next pass owes real work.
  db().jobCrew.set('jc_2', { id: 'jc_2', jobId: 'job_1', assignmentStatus: 'ACCEPTED', cancelledAt: null, cancelReason: null })

  const second = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { logger: quietLogger },
  )

  assert.equal(second.crewCancelled, 1, 'the later assignment is cancelled — not rolled back')
  assert.equal(second.failed, undefined, 'and it is not reported as a failure')
  assert.equal(second.skipped, undefined, 'nor as a skip')
  assert.equal(second.followUpAudit, true, 'the ledger row already existed, so this pass recorded its OWN entry')
  assert.equal(db().jobCrew.get('jc_2')!.assignmentStatus, 'CANCELLED')
  assert.equal(db().jobCrew.get('jc_2')!.cancelReason, 'Booking cancelled')

  // The exactly-once ledger row is still exactly one, and the second pass's
  // work is recorded as what it is.
  const audits = Array.from(db().audits.values())
  assert.equal(audits.filter((a) => a.id === m.lifecycle.jobCancellationAuditId('bk_life')).length, 1)
  const followUp = audits.find((a) => (a.details as Row)?.event === 'cancel_job_for_cancelled_booking_followup')
  assert.ok(followUp, 'the later remediation leaves a record')
  assert.equal((followUp!.details as Row).crewCancelled, 1, 'stating what THIS pass did, not a running total')
})

test('D3-b: a genuine race on the ledger row still converges — the crew is cancelled', async () => {
  const m = await load()
  await seedBooking({ status: 'CANCELLED' }, { crew: [crewRow('jc_1')] })

  // Another caller writes the ledger row between our count and our insert: the
  // classic read-then-act race. Postgres aborts the whole transaction on the
  // violation, so the crew update rolls back with it.
  const prisma = (await import('../db')).prisma as unknown as { auditLog: { create(a: unknown): Promise<unknown> } }
  db().before = {
    op: 'auditLog.create',
    run: () => {
      void prisma.auditLog.create({
        data: { id: m.lifecycle.jobCancellationAuditId('bk_life'), action: 'BOOKING_STATE_CHANGED', bookingId: 'bk_life' },
      })
    },
  }

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { logger: quietLogger },
  )

  assert.equal(out.failed, undefined, 'the race is not a failure')
  assert.equal(out.crewCancelled, 1, 'the retry re-runs the remediation the violation rolled back')
  assert.equal(db().jobCrew.get('jc_1')!.assignmentStatus, 'CANCELLED')
})

test('D3-b: a real write failure is reported as FAILED, never as a skip', async () => {
  const m = await load()
  await seedBooking({ status: 'CANCELLED' }, { crew: [crewRow('jc_1')] })
  db().failOn = { op: 'jobCrew.updateMany', error: new Error('Neon: connection terminated') }

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { logger: quietLogger },
  )

  assert.match(out.failed ?? '', /connection terminated/, 'the caller can see that remediation is still owed')
  assert.equal(out.skipped, undefined, 'a failure must not wear the word "skipped"')
  assert.equal(db().jobCrew.get('jc_1')!.assignmentStatus, 'ASSIGNED', 'and nothing was half-written')
})

test('D3-b: a genuine no-op is still a SKIP, and still writes no audit row', async () => {
  const m = await load()
  await seedBooking({ status: 'CANCELLED' }, { job: { status: 'CANCELLED' }, crew: [{ id: 'jc_1', assignmentStatus: 'CANCELLED' }] })

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { logger: quietLogger },
  )

  assert.equal(out.skipped, 'nothing_live')
  assert.equal(out.failed, undefined)
  assert.equal(db().audits.size, 0, 'no ledger entry for work nobody did')
})

test('D3-b: cancelBooking surfaces a failed crew half instead of reporting a quiet zero', async () => {
  const m = await load()
  await seedBooking({ status: 'CANCELLED' }, { crew: [crewRow('jc_1')] })
  db().failOn = { op: 'jobCrew.updateMany', error: new Error('Neon: connection terminated') }

  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT, effects: false },
    { logger: quietLogger },
  )

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'already_cancelled')
  assert.match((res.ok && res.jobCancelFailed) ?? '', /connection terminated/)
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE VOCABULARY — every outcome maps to exactly one honest sentence
// ════════════════════════════════════════════════════════════════════════════

test('every follow-up refusal reason maps to a skip or a failure — never to "scheduled"', async () => {
  const { lifecycle } = await load()
  const total = 4
  const cases: Array<[string, string, string]> = [
    // handoff reason            → state     → reason in the report
    ['followups_disabled', 'skipped', 'followups-disabled'],
    ['no_marketing_consent', 'skipped', 'no-consent'],
    ['marketing_opted_out', 'skipped', 'opted-out'],
    ['not_in_rollout_allowlist', 'skipped', 'not-in-rollout'],
    ['internal_test_booking', 'skipped', 'internal-test'],
    ['consent_read_failed', 'failed', 'consent-unknown'],
    ['enqueue_failed', 'failed', 'enqueue_failed'],
    // A reason this table has never seen must NOT be rounded off to success.
    ['some_future_reason', 'failed', 'some_future_reason'],
  ]
  for (const [reason, state, reported] of cases) {
    const out = lifecycle.followupOutcome({ scheduled: 0, failed: 0, total, reason })
    assert.equal(out.state, state, reason)
    assert.equal(out.reason, reported, reason)
    assert.notEqual(out.state, 'scheduled', `${reason} must never read as scheduled`)
  }
  assert.deepEqual(lifecycle.followupOutcome({ scheduled: 4, failed: 0, total, reason: null }), {
    state: 'scheduled',
    count: 4,
  })
})

test('the balance reminder distinguishes both "off" switches, a refusal, and an unproven add', async () => {
  const { lifecycle } = await load()
  assert.deepEqual(lifecycle.balanceOutcome({ scheduled: false, reason: 'journeys_disabled' }), {
    state: 'skipped',
    reason: 'journeys-disabled',
    count: 0,
  })
  assert.deepEqual(lifecycle.balanceOutcome({ scheduled: false, reason: 'journey_disabled' }), {
    state: 'skipped',
    reason: 'journey-disabled',
    count: 0,
  })
  assert.equal(lifecycle.balanceOutcome({ scheduled: false, reason: 'boom' }).state, 'failed')
  // A seam that reports nothing is never quoted as proof.
  assert.deepEqual(lifecycle.balanceOutcome({ scheduled: false, reason: 'enqueue_unverified' }), {
    state: 'unknown',
    reason: 'not-confirmed',
    count: 0,
  })
  assert.deepEqual(lifecycle.balanceOutcome({ scheduled: true, reason: null }), { state: 'scheduled', count: 1 })
})

test('the owner sentence carries the wording the blocker asked for', async () => {
  const { lifecycle } = await load()
  const msg = lifecycle.replayCompletionMessage({
    email: { state: 'queued', count: 1 },
    followups: { state: 'skipped', reason: 'no-consent', count: 0 },
    balance: { state: 'scheduled', count: 1 },
  })
  assert.match(msg, /review request skipped — customer has not opted in/i)
  assert.match(msg, /balance reminder scheduled/)
  assert.ok(!/sequence scheduled/.test(msg), 'the sequence was not scheduled and the sentence must not say so')
})

test('an unknown skip reason is printed, not swallowed', async () => {
  const { lifecycle } = await load()
  const msg = lifecycle.replayCompletionMessage({
    email: { state: 'queued' },
    followups: { state: 'skipped', reason: 'brand_new_reason' },
    balance: { state: 'unknown', reason: 'not-confirmed' },
  })
  assert.match(msg, /review request skipped — brand_new_reason/)
  assert.match(msg, /balance reminder — could not confirm it was scheduled/)
})

test('the fresh report starts as not-run, so an unfinished handoff can never read as a done one', async () => {
  const { lifecycle } = await load()
  resetDb()
  await seedBooking({ status: 'IN_PROGRESS' })
  const res = await lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT, effects: false },
    { logger: quietLogger },
  )
  assert.ok(res.ok)
  assert.equal(res.ok && res.effects, undefined, 'no effects were requested, so none are reported')
})
