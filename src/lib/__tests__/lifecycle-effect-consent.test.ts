// ════════════════════════════════════════════════════════════════════════════
//  lifecycle-effect-consent.test.ts — BLOCKER D3, with the flags ON.
//
//  The second half of the D3 reproduction: "Same when the customer has not
//  consented to promotional mail." With `MARKETING_FOLLOWUPS_ENABLED=true` the
//  sequence is refused one step later — inside `bookingMarketingBlockReason` —
//  and the pre-fix report called that "ok" too, so the owner read
//  "review/referral sequence scheduled" about a customer nobody may email.
//
//  WHY THIS IS A SEPARATE FILE. `FOLLOWUPS_ENABLED` and `JOURNEYS_ENABLED` are
//  module-level consts, read ONCE when the module is first imported, so the
//  flags-off reproduction (lifecycle-effect-report.test.ts) and these flags-on
//  cases cannot run in the same process. The env is set below before anything
//  reads it — the same discipline as `_journeys-env.ts`.
//
//  THE SHIPPED CODE RUNS: real `followups.onBookingCompleted`, real
//  `journeys.onBookingCompletedBalance`, real `completeBooking`, real
//  `bookingMarketingBlockReason`, against the fake Prisma client in
//  `_effect-report-harness.ts`. Only the QUEUE is a seam — the shipped
//  functions' own — so what reached it can be counted, and a queue that refuses
//  (the documented Upstash stall) can be modelled without a Redis.
//
//  OFFLINE: no database, no Redis, no network.
//    npx tsx --test src/lib/__tests__/lifecycle-effect-consent.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── FLAGS ON, before any module reads them ──────────────────────────────────
process.env.MARKETING_FOLLOWUPS_ENABLED = 'true'
process.env.EMAIL_JOURNEYS_ENABLED = 'true'
// A canary allowlist would refuse for a reason that has nothing to do with D3.
delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST

import { installFakePrisma, assertUsingFake, seedBooking, theDb, quietLogger } from './_effect-report-harness'

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

type Queue = {
  adds: string[]
  /** 'up' accepts; 'down' refuses the way a stalled Upstash connection does;
   *  'silent' accepts but reports nothing back (a seam that cannot prove it). */
  mode: 'up' | 'down' | 'silent'
  /** Refuse only these stage names (a PARTIAL enqueue). */
  refuse?: Set<string>
}

async function shippedEffects(q: Queue) {
  const m = await load()
  const refuse = (stage: string): boolean => q.mode === 'down' || (q.refuse?.has(stage) ?? false)

  const followupDeps: import('../followups').CompletionFollowupDeps = {
    ...m.followups.defaultCompletionFollowupDeps(),
    async addScheduled(type, _bookingId, _delayMs, jobId) {
      if (refuse(type)) throw new Error('scheduledQueue.add timed out (Redis?)')
      q.adds.push(jobId)
    },
  }
  const journeyDeps = {
    ...m.journeys.defaultJourneyDeps(),
    async enqueue(stage: string, _data: Record<string, unknown>, _fireAt: Date, jobId: string) {
      if (refuse(stage)) return { ok: false, reason: 'scheduledQueue.add timed out (Redis?)' }
      q.adds.push(jobId)
      // A seam that returns nothing is exactly what "cannot prove it" means.
      return q.mode === 'silent' ? undefined : { ok: true }
    },
  }
  const effects: import('../lifecycle-service').LifecycleEffects = {
    async sendCompletionEmail(b) {
      return Boolean(b.customer?.email)
    },
    scheduleFollowups: (id) => m.followups.onBookingCompleted(id, followupDeps),
    scheduleBalanceReminder: (id) => m.journeys.onBookingCompletedBalance(id, journeyDeps),
    async stopJourneys() {},
  }
  return { effects, followupDeps, journeyDeps }
}

const complete = async (q: Queue) => {
  const m = await load()
  const { effects } = await shippedEffects(q)
  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects, logger: quietLogger },
  )
  assert.ok(res.ok, 'the completion itself must stand')
  return { report: res.ok ? res.effects! : null!, message: m.lifecycle.replayCompletionMessage(res.ok ? res.effects! : null!) }
}

// ════════════════════════════════════════════════════════════════════════════
//  0. THE HARNESS CAN STILL SEE THE ORIGINAL DEFECT
// ════════════════════════════════════════════════════════════════════════════

test('DEFECT D3: the pre-fix report says "scheduled" for a customer who never opted in', async () => {
  const m = await load()
  assert.equal(m.followups.FOLLOWUPS_ENABLED, true, 'precondition: the flag is ON in this file')
  // TRI-STATE consent: null = never asked. The shipped gate refuses it.
  await seedBooking({ status: 'COMPLETED', completedAt: AT }, { customer: { emailMarketingConsent: null } })
  const q: Queue = { adds: [], mode: 'up' }
  const { followupDeps } = await shippedEffects(q)

  // The pre-fix caller AWAITED the handoff and stamped 'ok' when it returned.
  let followups = 'not-run'
  try {
    await m.followups.onBookingCompleted('bk_life', followupDeps) // ← result discarded, as it was
    followups = 'ok'
  } catch {
    followups = 'failed'
  }

  assert.equal(followups, 'ok', 'THE DEFECT: refusing to schedule and returning normally look identical')
  assert.deepEqual(q.adds, [], 'and nothing was scheduled — the consent gate refused first')
  // Which the owner then read as:
  assert.equal(
    followups === 'ok' ? 'review/referral sequence scheduled' : 'follow-up sequence FAILED to schedule',
    'review/referral sequence scheduled',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  1. NO CONSENT — a skip with a reason, in the owner's words
// ════════════════════════════════════════════════════════════════════════════

test('D3: never-asked consent is reported as SKIPPED-NO-CONSENT, not scheduled', async () => {
  await seedBooking({ status: 'IN_PROGRESS' }, { customer: { emailMarketingConsent: null } })
  const q: Queue = { adds: [], mode: 'up' }

  const { report, message } = await complete(q)

  assert.deepEqual(report.followups, { state: 'skipped', reason: 'no-consent', count: 0 })
  assert.match(message, /review request skipped — customer has not opted in/i, message)
  assert.ok(!/sequence scheduled/.test(message), 'the false claim is gone')
  assert.deepEqual(
    q.adds.filter((id) => id.startsWith('followup__')),
    [],
    'no follow-up stage was queued for somebody we may not email',
  )
  // The balance reminder is TRANSACTIONAL — money owed, not marketing — so it
  // is still scheduled, and the report says so separately.
  assert.deepEqual(report.balance, { state: 'scheduled', count: 1 })
})

test('D3: an explicit STOP is reported as opted-out, distinctly from never-asked', async () => {
  await seedBooking({ status: 'IN_PROGRESS' }, { customer: { emailMarketingConsent: true, marketingOptOut: true } })
  const q: Queue = { adds: [], mode: 'up' }

  const { report, message } = await complete(q)

  assert.deepEqual(report.followups, { state: 'skipped', reason: 'opted-out', count: 0 })
  assert.match(message, /review request skipped — customer opted out of marketing mail/)
})

test('D3: the canary allowlist is a skip with its OWN reason, not a silent success', async () => {
  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = 'someone-else@example.com'
  try {
    await seedBooking({ status: 'IN_PROGRESS' })
    const q: Queue = { adds: [], mode: 'up' }
    const { report, message } = await complete(q)
    assert.deepEqual(report.followups, { state: 'skipped', reason: 'not-in-rollout', count: 0 })
    assert.match(message, /review request skipped — this customer is outside the email rollout/)
    assert.deepEqual(q.adds.filter((id) => id.startsWith('followup__')), [])
  } finally {
    delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE POSITIVE CASE — "scheduled" is only ever printed over a real enqueue
// ════════════════════════════════════════════════════════════════════════════

test('D3: with consent and a healthy queue the sequence really IS scheduled, and the count is real', async () => {
  await seedBooking({ status: 'IN_PROGRESS' })
  const q: Queue = { adds: [], mode: 'up' }

  const { report, message } = await complete(q)

  assert.deepEqual(report.followups, { state: 'scheduled', count: 4 })
  assert.deepEqual(report.balance, { state: 'scheduled', count: 1 })
  assert.match(message, /review\/referral sequence scheduled/)
  assert.match(message, /balance reminder scheduled/)

  // …and the queue really received the four stages, under the shipped stable
  // job ids (the anti-duplication guarantee this sequence rides on).
  assert.deepEqual(q.adds.filter((id) => id.startsWith('followup__')).sort(), [
    'followup__referral-ask__bk_life',
    'followup__repeat-reminder__bk_life',
    'followup__review-reminder__bk_life',
    'followup__review-request__bk_life',
  ])
  assert.ok(q.adds.includes('journey__balance__balance-reminder-post__bk_life'), 'the +24h balance reminder')
  for (const id of q.adds) assert.ok(!id.includes(':'), `BullMQ rejects a custom job id containing a colon: ${id}`)
  assert.ok(db().bookings.get('bk_life')!.completedAt, 'and the completion is committed underneath it all')
})

// ════════════════════════════════════════════════════════════════════════════
//  3. A QUEUE THAT REFUSES — modelled honestly, reported as a failure
// ════════════════════════════════════════════════════════════════════════════

test('D3: every stage refused is FAILED — the completion stands, the claim does not', async () => {
  await seedBooking({ status: 'IN_PROGRESS' })
  const q: Queue = { adds: [], mode: 'down' }

  const { report, message } = await complete(q)

  assert.equal(report.followups.state, 'failed')
  assert.equal(report.followups.count, 0, 'nothing landed, and the report says nothing landed')
  assert.equal(report.balance.state, 'failed')
  assert.match(message, /follow-up sequence FAILED to schedule/)
  assert.match(message, /balance reminder FAILED to schedule/)
  assert.deepEqual(q.adds, [])
  assert.equal(db().bookings.get('bk_life')!.status, 'COMPLETED', 'the job is still finished — only the messages are not')
})

test('D3: a PARTIAL enqueue is not "scheduled" — three of four is reported as a failure with its real count', async () => {
  await seedBooking({ status: 'IN_PROGRESS' })
  const q: Queue = { adds: [], mode: 'up', refuse: new Set(['referral-ask']) }

  const { report, message } = await complete(q)

  assert.equal(report.followups.state, 'failed', 'a sequence with a missing stage is not a scheduled sequence')
  assert.equal(report.followups.count, 3, 'and the count is what really landed')
  assert.equal(q.adds.filter((id) => id.startsWith('followup__')).length, 3)
  assert.match(message, /follow-up sequence FAILED to schedule/)
})

test('D3: an enqueue seam that proves nothing is UNKNOWN, never "scheduled"', async () => {
  await seedBooking({ status: 'IN_PROGRESS' })
  const q: Queue = { adds: [], mode: 'silent' }

  const { report, message } = await complete(q)

  assert.deepEqual(report.balance, { state: 'unknown', reason: 'not-confirmed', count: 0 })
  assert.match(message, /balance reminder — could not confirm it was scheduled/)
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE HANDOFFS THEMSELVES — what they return, run directly
// ════════════════════════════════════════════════════════════════════════════

test('onBookingCompleted reports the consent reason it refused on, and still stamps completedAt', async () => {
  const m = await load()
  await seedBooking({ status: 'COMPLETED', completedAt: null }, { customer: { emailMarketingConsent: null } })
  const q: Queue = { adds: [], mode: 'up' }
  const { followupDeps } = await shippedEffects(q)

  const out = await m.followups.onBookingCompleted('bk_life', followupDeps)

  assert.deepEqual(out, { scheduled: 0, failed: 0, total: 4, reason: 'no_marketing_consent' })
  assert.ok(
    db().bookings.get('bk_life')!.completedAt,
    'completion is a fact about the JOB, not about marketing — the stamp happens either way',
  )
})

test('onBookingCompletedBalance separates the master switch from this one journey', async () => {
  const m = await load()
  await seedBooking({ status: 'COMPLETED', completedAt: AT })
  const q: Queue = { adds: [], mode: 'up' }
  const { journeyDeps } = await shippedEffects(q)

  process.env.EMAIL_JOURNEY_BALANCE_DISABLED = 'true'
  try {
    assert.deepEqual(await m.journeys.onBookingCompletedBalance('bk_life', journeyDeps), {
      scheduled: false,
      reason: 'journey_disabled',
    })
    assert.deepEqual(q.adds, [], 'a disabled journey queues nothing')
  } finally {
    delete process.env.EMAIL_JOURNEY_BALANCE_DISABLED
  }

  assert.deepEqual(await m.journeys.onBookingCompletedBalance('bk_life', journeyDeps), { scheduled: true, reason: null })
  assert.deepEqual(q.adds, ['journey__balance__balance-reminder-post__bk_life'])
})

test('the replay action re-drives the messages and reports the SAME vocabulary', async () => {
  const m = await load()
  await seedBooking({ status: 'IN_PROGRESS' }, { customer: { emailMarketingConsent: null } })
  const q: Queue = { adds: [], mode: 'up' }
  const { effects } = await shippedEffects(q)

  await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects, logger: quietLogger },
  )
  const replay = await m.lifecycle.replayCompletion('bk_life', {}, { effects, logger: quietLogger })

  assert.ok(replay.ok)
  assert.deepEqual(replay.ok ? replay.effects.followups : null, { state: 'skipped', reason: 'no-consent', count: 0 })
  assert.match(
    m.lifecycle.replayCompletionMessage(replay.ok ? replay.effects : null!),
    /review request skipped — customer has not opted in/i,
    'the owner is told the same true thing on the recovery path',
  )
})
