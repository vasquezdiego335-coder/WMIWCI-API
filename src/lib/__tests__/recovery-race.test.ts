// ════════════════════════════════════════════════════════════════════════
//  T4 / R5 — THE SIBLING GUARD WAS ITSELF READ-THEN-WRITE (2026-08-15)
//  ---------------------------------------------------------------------
//  WHAT ROUND 2 FIXED, AND WHAT IT LEFT. `onCheckoutStarted` stopped
//  suppressing on a sibling's STATUS and started demanding PROOF — stage jobs
//  in the queue or stage emails in the ledger. That closed the stranded-booking
//  regression (recovery-suppression.test.ts, still green, still required).
//
//  BUT THE PROOF IS A READ, AND THE SIBLING WRITES IT MOMENTS LATER. Two
//  submissions of the same form ~900ms apart (a double-click, two taps, a
//  retried POST) both ask "does the other one own a sequence?" before either
//  has queued anything, both hear NO, and both schedule:
//
//      await Promise.all([onCheckoutStarted('bk_1'), onCheckoutStarted('bk_2')])
//      → 6 stage jobs, two recovery sequences, one inbox.
//
//  This is the third defect in this codebase with that exact shape, so the fix
//  is not another read. Every recovery stage now enqueues under a CUSTOMER-
//  scoped deduplication id, which BullMQ resolves with `SET <key> <jobId> PX
//  <ttl> NX` inside the same atomic script that would have created the job
//  (verified in the shipped addDelayedJob Lua, node_modules/bullmq). One add
//  creates a job; the other creates nothing and is told which job won.
//
//  HOW THIS IS TESTED — and why the harness can SEE the defect.
//   • The shipped `onCheckoutStarted` is driven for real; only the edges are
//     faked, and the queue fake is a transcription of that Lua: job-id
//     collision first (no add, no dedupe key), then SET-NX on the dedupe id
//     with its ttl, then the add.
//   • Every fake answers after a deterministic number of microtask turns, so
//     the two runs INTERLEAVE the way two HTTP requests do: the queue write is
//     a round trip and lands after the read that raced it. Without that, a
//     zero-latency fake writes h.jobs before the sibling can read it and the
//     race is invisible — a harness that cannot see the defect proves nothing.
//   • Test 2 IS the mutation test, permanently: it drives the SAME race with
//     the fix disabled (deps without `recoveryGroupId`, i.e. the round-2 shape)
//     and asserts SIX jobs. If the collapse is ever removed, test 1 goes red
//     and test 2 stays green — the pair pins the behaviour from both sides.
//   • SOURCE MUTATIONS, measured against the shipped journeys.ts:
//       – stop passing the key (`recoveryDedupeFor(...)` → undefined)
//         → tests 1, 3, 4, 13 red; test 2 still green (the old defect, back).
//       – drop the `deduplication` option from the queue add → test 13 red.
// ════════════════════════════════════════════════════════════════════════
import './_journeys-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ABANDONED_STAGES,
  DUPLICATE_BOOKING_WINDOW_MS,
  jobIdFor,
  onCheckoutStarted,
  recoveryDedupeFor,
  type EnqueueDedupe,
  type JourneyDeps,
  type RecoveryEvidence,
} from '../journeys'

const NOW = new Date('2026-08-15T15:00:00.000Z') // 11:00 America/New_York — not quiet hours
const MINUTE = 60_000

/** Deterministic "this took a round trip": n microtask turns. Real timers are
 *  not needed and would only add flake — what matters is that another run gets
 *  to advance while this one is in flight. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

type BookingRow = { id: string; customerId: string; createdAt: Date }

type Harness = {
  deps: JourneyDeps
  /** jobId -> the booking the stage would email about. */
  jobs: Map<string, { stage: string; bookingId: string }>
  /** BullMQ's `de:` keys: dedupe id -> { jobId that holds it, expiresAt }. */
  dedupeKeys: Map<string, { jobId: string; expiresAt: number }>
  ledger: Map<string, number>
  bookings: Map<string, BookingRow>
  calls: string[]
  /** Round trips, in microtask turns. The queue is slower than the reads — see
   *  the header. `readTurns` is shared by every read. */
  latency: { readTurns: number; enqueueTurns: (bookingId: string) => number }
}

function harness(
  rows: BookingRow[],
  opts: {
    /** Omit to build the ROUND-2 deps: no group id, so no collapse. */
    withDedupe?: boolean
    enqueueTurns?: (bookingId: string) => number
    now?: Date
    ledger?: Map<string, number>
  } = {}
): Harness {
  const now = opts.now ?? NOW
  const h: Harness = {
    deps: null as unknown as JourneyDeps,
    jobs: new Map(),
    dedupeKeys: new Map(),
    ledger: opts.ledger ?? new Map(),
    bookings: new Map(rows.map((r) => [r.id, r])),
    calls: [],
    latency: { readTurns: 1, enqueueTurns: opts.enqueueTurns ?? (() => 6) },
  }

  const base: JourneyDeps = {
    now: () => now,
    // ── The shipped BullMQ add, transcribed from addDelayedJob's Lua. ────
    async enqueue(stage, data, _fireAt, jobId, dedupe?: EnqueueDedupe) {
      const bookingId = String((data as { bookingId?: unknown }).bookingId ?? '')
      h.calls.push(`enqueue:${jobId}${dedupe ? `:${dedupe.id}` : ''}`)
      // The round trip. Everything after this point is one atomic script.
      await turns(h.latency.enqueueTurns(bookingId))
      // 1. `if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob`
      //    — a re-add of the same subject never even reaches the dedupe.
      if (h.jobs.has(jobId)) return
      // 2. `SET <de:id> <jobId> PX <ttl> NX` — held key ⇒ nothing is added.
      if (dedupe) {
        const held = h.dedupeKeys.get(dedupe.id)
        if (held && held.expiresAt > now.getTime()) {
          h.calls.push(`collapsed:${jobId}:into:${held.jobId}`)
          return
        }
        h.dedupeKeys.set(dedupe.id, { jobId, expiresAt: now.getTime() + dedupe.ttlMs })
      }
      // 3. storeJob + addDelayedJob.
      h.jobs.set(jobId, { stage, bookingId })
    },
    async cancel(jobId) {
      h.jobs.delete(jobId)
    },
    async loadLead() {
      return null
    },
    async hasEverBooked() {
      return false
    },
    async bookingMarketingBlock(bookingId) {
      await turns(h.latency.readTurns)
      return h.bookings.has(bookingId) ? null : 'booking_deleted'
    },
    async siblingUnpaidBooking(bookingId) {
      await turns(h.latency.readTurns)
      const self = h.bookings.get(bookingId)
      if (!self || DUPLICATE_BOOKING_WINDOW_MS <= 0) return null
      const floor = self.createdAt.getTime() - DUPLICATE_BOOKING_WINDOW_MS
      const match = Array.from(h.bookings.values())
        .filter(
          (b) =>
            b.id !== self.id &&
            b.customerId === self.customerId &&
            b.createdAt.getTime() >= floor &&
            b.createdAt.getTime() < self.createdAt.getTime()
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      return match[0]?.id ?? null
    },
    async recoverySequenceFor(bookingId): Promise<RecoveryEvidence | null> {
      await turns(h.latency.readTurns)
      h.calls.push(`evidence:${bookingId}`)
      return {
        queuedStages: ABANDONED_STAGES.filter((s) => h.jobs.has(jobIdFor('abandoned', s.type, bookingId))).length,
        sentStages: h.ledger.get(bookingId) ?? 0,
      }
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

  h.deps = opts.withDedupe
    ? {
        ...base,
        // The shipped prisma read: booking -> customerId.
        async recoveryGroupId(bookingId) {
          await turns(h.latency.readTurns)
          return h.bookings.get(bookingId)?.customerId ?? null
        },
      }
    : base
  return h
}

const stagesFor = (h: Harness, bookingId: string) =>
  ABANDONED_STAGES.filter((s) => h.jobs.has(jobIdFor('abandoned', s.type, bookingId))).length
/** Every booking a queued stage would email about. */
const targets = (h: Harness) => new Set(Array.from(h.jobs.values()).map((j) => j.bookingId))

// The double-click: the same form submitted twice, 900ms apart.
const DOUBLE_CLICK: BookingRow[] = [
  { id: 'bk_1', customerId: 'cus_1', createdAt: new Date(NOW.getTime() - 900) },
  { id: 'bk_2', customerId: 'cus_1', createdAt: NOW },
]

// ════════════════════════════════════════════════════════════════════════
//  1. THE REPRODUCTION — and 2, the same race with the fix removed.
// ════════════════════════════════════════════════════════════════════════

test('T4/R5: two near-simultaneous submissions produce ONE recovery sequence', async () => {
  const h = harness(DOUBLE_CLICK, { withDedupe: true })

  await Promise.all([onCheckoutStarted('bk_1', h.deps), onCheckoutStarted('bk_2', h.deps)])

  assert.equal(h.jobs.size, ABANDONED_STAGES.length, `two sequences reached one inbox: ${Array.from(h.jobs.keys()).join(', ')}`)
  // ...and it is ONE booking's sequence, not a mix of both.
  assert.equal(targets(h).size, 1, 'the surviving stages must all belong to the same booking')
  const winner = Array.from(targets(h))[0]
  assert.ok(['bk_1', 'bk_2'].includes(winner), `stages were queued for an unrelated booking: ${winner}`)
  assert.equal(stagesFor(h, winner), ABANDONED_STAGES.length, 'the surviving sequence is complete')
  // The loser learned it lost — that is what stops the log claiming a sequence
  // it does not own (the phantom claim R5 was opened about, pointing the other way).
  assert.ok(
    h.calls.some((c) => c.startsWith('collapsed:')),
    'the queue, not a read, is what decided this',
  )
})

test('T4/R5 MUTATION: the SAME race with the collapse removed still double-schedules', async () => {
  // Round-2 deps exactly: sibling + evidence, no dedupe. Both runs read "no
  // sequence" about each other because neither has written one yet.
  const h = harness(DOUBLE_CLICK, { withDedupe: false })

  await Promise.all([onCheckoutStarted('bk_1', h.deps), onCheckoutStarted('bk_2', h.deps)])

  assert.equal(h.jobs.size, 2 * ABANDONED_STAGES.length, 'the harness cannot see the defect it is meant to prove')
  assert.equal(stagesFor(h, 'bk_1'), ABANDONED_STAGES.length)
  assert.equal(stagesFor(h, 'bk_2'), ABANDONED_STAGES.length)
  // And the evidence check DID run and DID pass, for both — read-then-write.
  assert.ok(h.calls.includes('evidence:bk_1'), 'the round-2 guard was consulted and let it through')
})

test('T4/R5: the collapse does not depend on which request is faster', async () => {
  // A guard two callers can both pass is not a guard, so the assertion is
  // ORDER-INDEPENDENCE: flip the round trips so the SECOND submission reaches
  // the queue first, and the outcome must be identical.
  const h = harness(DOUBLE_CLICK, {
    withDedupe: true,
    enqueueTurns: (bookingId) => (bookingId === 'bk_2' ? 1 : 9),
  })

  await Promise.all([onCheckoutStarted('bk_1', h.deps), onCheckoutStarted('bk_2', h.deps)])

  assert.equal(h.jobs.size, ABANDONED_STAGES.length, 'one sequence, whichever request won the queue')
  assert.equal(targets(h).size, 1)
})

test('T4/R5: three taps collapse just as two do', async () => {
  const rows: BookingRow[] = [
    ...DOUBLE_CLICK,
    { id: 'bk_3', customerId: 'cus_1', createdAt: new Date(NOW.getTime() + 400) },
  ]
  const h = harness(rows, { withDedupe: true })

  await Promise.all(rows.map((r) => onCheckoutStarted(r.id, h.deps)))

  assert.equal(h.jobs.size, ABANDONED_STAGES.length)
  assert.equal(targets(h).size, 1)
})

// ════════════════════════════════════════════════════════════════════════
//  2. WHAT MUST NOT REGRESS — the round-2 behaviours, through the new path.
// ════════════════════════════════════════════════════════════════════════

test('T4/R5: a stranded attempt still cannot suppress the re-submission (3 stages, its own ids)', async () => {
  // The stranded row died mid-request: it never ran onCheckoutStarted, so it
  // queued nothing AND holds no dedupe key. The collapse is between submissions
  // that both reach the queue — it can never silence a lone survivor.
  const h = harness(
    [
      { id: 'bk_stranded', customerId: 'cus_1', createdAt: new Date(NOW.getTime() - 4 * MINUTE) },
      { id: 'bk_good', customerId: 'cus_1', createdAt: NOW },
    ],
    { withDedupe: true }
  )

  await onCheckoutStarted('bk_good', h.deps)

  assert.equal(stagesFor(h, 'bk_good'), ABANDONED_STAGES.length, 'the good booking owns the full sequence')
  assert.equal(h.jobs.size, ABANDONED_STAGES.length)
  for (const id of Array.from(h.jobs.keys())) {
    assert.ok(id.endsWith('__bk_good'), `stage job ${id} must belong to the re-submission, not the dead attempt`)
  }
})

test('T4/R5: a sequential duplicate is still suppressed by EVIDENCE, before the queue is touched', async () => {
  const h = harness(
    [
      { id: 'bk_1', customerId: 'cus_1', createdAt: new Date(NOW.getTime() - 2 * MINUTE) },
      { id: 'bk_2', customerId: 'cus_1', createdAt: NOW },
    ],
    { withDedupe: true }
  )

  await onCheckoutStarted('bk_1', h.deps)
  await onCheckoutStarted('bk_2', h.deps)

  assert.equal(stagesFor(h, 'bk_1'), ABANDONED_STAGES.length)
  assert.equal(stagesFor(h, 'bk_2'), 0)
  // The dedupe id is the backstop, not the first answer: bk_2 never enqueued.
  assert.ok(!h.calls.some((c) => c.startsWith('enqueue:journey__abandoned__') && c.includes('__bk_2')))
})

test('T4/R5: two genuinely separate moves outside the window each keep their sequence', async () => {
  // The dedupe key lives exactly as long as the sibling window, so a second
  // move booked past it holds no key to collide with.
  const older = new Date(NOW.getTime() - DUPLICATE_BOOKING_WINDOW_MS - MINUTE)
  const h = harness(
    [
      { id: 'bk_old', customerId: 'cus_1', createdAt: older },
      { id: 'bk_new', customerId: 'cus_1', createdAt: NOW },
    ],
    { withDedupe: true }
  )

  await onCheckoutStarted('bk_old', h.deps)
  // The first sequence's keys were taken at `older`; expire them the way Redis
  // does, by moving the clock past the ttl.
  for (const [id, held] of Array.from(h.dedupeKeys.entries())) h.dedupeKeys.set(id, { ...held, expiresAt: older.getTime() + DUPLICATE_BOOKING_WINDOW_MS })
  await onCheckoutStarted('bk_new', h.deps)

  assert.equal(h.jobs.size, 2 * ABANDONED_STAGES.length, 'a separate move must not inherit an expired collapse')
  assert.equal(targets(h).size, 2)
})

test('T4/R5: different customers never collapse into each other', async () => {
  const h = harness(
    [
      { id: 'bk_a', customerId: 'cus_1', createdAt: NOW },
      { id: 'bk_b', customerId: 'cus_2', createdAt: NOW },
    ],
    { withDedupe: true }
  )

  await Promise.all([onCheckoutStarted('bk_a', h.deps), onCheckoutStarted('bk_b', h.deps)])

  assert.equal(h.jobs.size, 2 * ABANDONED_STAGES.length)
  assert.equal(targets(h).size, 2)
})

test('T4/R5: a partial queue failure can still be repaired — the keys are per stage', async () => {
  // Stage 1 landed; stages 2-3 timed out (enqueue swallows that by design). A
  // single sequence-wide key would have locked out the retry that fixes it.
  const h = harness([{ id: 'bk_1', customerId: 'cus_1', createdAt: NOW }], { withDedupe: true })
  const first = ABANDONED_STAGES[0]
  await h.deps.enqueue(
    first.type,
    { bookingId: 'bk_1' },
    NOW,
    jobIdFor('abandoned', first.type, 'bk_1'),
    recoveryDedupeFor(first.type, 'cus_1') ?? undefined
  )
  assert.equal(h.jobs.size, 1)

  await onCheckoutStarted('bk_1', h.deps)

  assert.equal(stagesFor(h, 'bk_1'), ABANDONED_STAGES.length, 'the stages that never made it are queued by the retry')
})

// ════════════════════════════════════════════════════════════════════════
//  3. THE KEY ITSELF (pure) AND THE WIRING (source).
// ════════════════════════════════════════════════════════════════════════

test('T4/R5: the dedupe key is per customer AND per stage, and lives for the sibling window', () => {
  const one = recoveryDedupeFor(ABANDONED_STAGES[0].type, 'cus_1')
  const two = recoveryDedupeFor(ABANDONED_STAGES[0].type, 'cus_1')
  assert.deepEqual(one, two, 'two submissions by one customer must compute the SAME key')
  assert.equal(one?.ttlMs, DUPLICATE_BOOKING_WINDOW_MS, 'the collapse window is the duplicate window')
  assert.notEqual(
    recoveryDedupeFor(ABANDONED_STAGES[1].type, 'cus_1')?.id,
    one?.id,
    'stage 2 must not be blocked by stage 1',
  )
  assert.notEqual(recoveryDedupeFor(ABANDONED_STAGES[0].type, 'cus_2')?.id, one?.id)
  assert.ok(one && one.id.includes('cus_1'))
})

test('T4/R5: an unknown group, or a disabled window, means NO collapse (fails open)', () => {
  assert.equal(recoveryDedupeFor(ABANDONED_STAGES[0].type, null), null)
  assert.equal(recoveryDedupeFor(ABANDONED_STAGES[0].type, undefined), null)
  assert.equal(recoveryDedupeFor(ABANDONED_STAGES[0].type, ''), null)
  assert.equal(recoveryDedupeFor(ABANDONED_STAGES[0].type, 'cus_1', 0), null, 'window off ⇒ the whole rule is off')
  assert.equal(recoveryDedupeFor(ABANDONED_STAGES[0].type, 'cus_1', -1), null)
})

test('T4/R5: deps without a group id schedule exactly as before — the dep is additive', async () => {
  const h = harness([{ id: 'bk_1', customerId: 'cus_1', createdAt: NOW }], { withDedupe: false })
  await onCheckoutStarted('bk_1', h.deps)
  assert.equal(stagesFor(h, 'bk_1'), ABANDONED_STAGES.length)
  assert.ok(!h.calls.some((c) => c.includes('__group__')), 'no group ⇒ no dedupe id is invented')
})

test('T4/R5 WIRING: the shipped enqueue hands the dedupe id to BullMQ, and the real deps supply the group', () => {
  // Comments stripped: no claim here can be satisfied by prose.
  const src = readFileSync(join(__dirname, '..', 'journeys.ts'), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

  assert.ok(
    /deduplication:\s*\{\s*id:\s*dedupe\.id,\s*ttl:\s*dedupe\.ttlMs\s*\}/.test(src),
    'the queue add must carry the deduplication option — without it the collapse is fiction',
  )
  assert.ok(/recoveryGroupId,/.test(src), 'defaultJourneyDeps must wire the real group read')
  assert.ok(
    /select:\s*\{\s*customerId:\s*true\s*\}/.test(src),
    'the group id comes from the booking row, not from an inference',
  )
  assert.ok(
    /recoveryDedupeFor\(s\.type,\s*groupId\)/.test(src),
    'onCheckoutStarted must pass the per-stage key through to the enqueue',
  )
})
