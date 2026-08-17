// ════════════════════════════════════════════════════════════════════════
//  R5 — PHANTOM-SIBLING SUPPRESSION (tranche 1 repair, 2026-08-15)
//  ---------------------------------------------------------------------
//  THE REGRESSION THIS FILE EXISTS TO KILL. B9 made a public booking BORN
//  `PENDING_PAYMENT` instead of DRAFT-then-promoted, which is correct: DRAFT was
//  the one status nothing could recover. But `onCheckoutStarted` suppressed the
//  abandoned-checkout sequence whenever an earlier UNPAID booking existed for the
//  same customer — and after B9 a submission stranded by a crash IS an earlier
//  unpaid booking. So the customer's good re-submission was silenced by their own
//  broken attempt: stages scheduled went from 3 to ZERO, and the log line claimed
//  the stranded row "already owns a recovery sequence" — a statement the database
//  could not support, because that booking owned nothing.
//
//  THE RULE NOW: suppress only against PROOF — stage jobs really in the queue, or
//  stage emails really in the send ledger. A status is not evidence.
//
//  HOW THIS IS TESTED. The shipped `onBookingCreated` / `onCheckoutStarted` are
//  driven for real; only the edges are faked, and each fake is a transcription of
//  the query it stands for:
//    • `siblingUnpaidBooking` — the prisma findFirst in journeys.ts, predicate for
//      predicate (same customer, PENDING_PAYMENT, unpaid, not internal-test,
//      created inside the window and STRICTLY BEFORE this row).
//    • `recoverySequenceFor` — the queue lookup + the EmailSend count, read from
//      the harness's own queue and ledger, so a sibling can only "own a sequence"
//      when one was genuinely scheduled or genuinely sent.
//  Every assertion below was mutation-tested: the pre-repair predicate (suppress
//  on the sibling's existence) turns test 1 red; deleting the evidence check turns
//  tests 2/3 red.
// ════════════════════════════════════════════════════════════════════════
import './_journeys-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABANDONED_STAGES,
  DUPLICATE_BOOKING_WINDOW_MS,
  decideDuplicateSuppression,
  jobIdFor,
  onBookingCreated,
  onCheckoutStarted,
  type JourneyDeps,
  type RecoveryEvidence,
} from '../journeys'

const NOW = new Date('2026-08-15T15:00:00.000Z') // 11:00 America/New_York — not quiet hours
const EMAIL = 'sam@example.com'
const MINUTE = 60_000

type BookingRow = {
  id: string
  customerId: string
  createdAt: Date
  status: string
  depositPaid: boolean
  isInternalTest: boolean
}

function bookingRow(id: string, createdAt: Date, over: Partial<BookingRow> = {}): BookingRow {
  return {
    id,
    customerId: 'cus_1',
    createdAt,
    // What the public route now writes in the SAME statement that creates the
    // row (app/api/bookings/route.ts — "BORN RECOVERABLE"). The stranded booking
    // in test 1 has exactly this shape: it never got past the create.
    status: 'PENDING_PAYMENT',
    depositPaid: false,
    isInternalTest: false,
    ...over,
  }
}

type Harness = {
  deps: JourneyDeps
  /** The queue, keyed by job id exactly like BullMQ (a duplicate add is a no-op). */
  jobs: Map<string, { stage: string; fireAt: Date }>
  /** bookingId -> recovery stage emails the send ledger has recorded. */
  ledger: Map<string, number>
  /** Bookings whose evidence cannot be read at all (Redis AND Postgres down). */
  unreadable: Set<string>
  bookings: Map<string, BookingRow>
  /** Ordered outward calls, so "what did it ask, in what order" is assertable. */
  calls: string[]
}

function harness(rows: BookingRow[] = [], over: Partial<Pick<Harness, 'ledger' | 'unreadable'>> = {}): Harness {
  const h: Harness = {
    deps: null as unknown as JourneyDeps,
    jobs: new Map(),
    ledger: over.ledger ?? new Map(),
    unreadable: over.unreadable ?? new Set(),
    bookings: new Map(rows.map((r) => [r.id, r])),
    calls: [],
  }

  h.deps = {
    now: () => NOW,
    async enqueue(stage, _data, fireAt, jobId) {
      h.calls.push(`enqueue:${jobId}`)
      if (!h.jobs.has(jobId)) h.jobs.set(jobId, { stage, fireAt })
    },
    async cancel(jobId) {
      h.calls.push(`cancel:${jobId}`)
      h.jobs.delete(jobId)
    },
    async loadLead() {
      return null
    },
    async hasEverBooked() {
      return false
    },
    async bookingMarketingBlock(bookingId) {
      // Consent is granted for every booking in this file; R5 is about the
      // suppression that runs AFTER the consent gate.
      return h.bookings.has(bookingId) ? null : 'booking_deleted'
    },
    // ── The shipped prisma findFirst, predicate for predicate. ──────────
    async siblingUnpaidBooking(bookingId) {
      h.calls.push(`sibling:${bookingId}`)
      const self = h.bookings.get(bookingId)
      if (!self || DUPLICATE_BOOKING_WINDOW_MS <= 0) return null
      const floor = self.createdAt.getTime() - DUPLICATE_BOOKING_WINDOW_MS
      const match = Array.from(h.bookings.values())
        .filter(
          (b) =>
            b.id !== self.id &&
            b.customerId === self.customerId &&
            b.status === 'PENDING_PAYMENT' &&
            !b.depositPaid &&
            !b.isInternalTest &&
            b.createdAt.getTime() >= floor &&
            b.createdAt.getTime() < self.createdAt.getTime()
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      return match[0]?.id ?? null
    },
    // ── The queue lookup + the EmailSend count. ─────────────────────────
    async recoverySequenceFor(bookingId): Promise<RecoveryEvidence | null> {
      h.calls.push(`evidence:${bookingId}`)
      if (h.unreadable.has(bookingId)) return null
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
    fireBookingTrigger(trigger, bookingId) {
      h.calls.push(`trigger:${trigger}:${bookingId}`)
    },
    stopEnrollments() {},
  }
  return h
}

const stageIds = (bookingId: string) => ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, bookingId))
const stagesFor = (h: Harness, bookingId: string) => stageIds(bookingId).filter((id) => h.jobs.has(id)).length

// ════════════════════════════════════════════════════════════════════════
//  1. THE REPRODUCTION — strand at T, re-submission at T+4min.
// ════════════════════════════════════════════════════════════════════════

test('R5: a stranded first attempt does NOT suppress the re-submission (3 stages, not 0)', async () => {
  const T = new Date(NOW.getTime() - 4 * MINUTE)
  // bk_stranded: the create landed (born PENDING_PAYMENT) and the request then
  // died before the hand-over — so NOTHING was ever scheduled for it. That is
  // the state B9 introduced and R5 mis-read as "owns a sequence".
  const h = harness([bookingRow('bk_stranded', T), bookingRow('bk_good', NOW)])

  // The customer re-submits. This is the composite the public route calls.
  await onBookingCreated({ bookingId: 'bk_good', email: EMAIL }, h.deps)

  assert.equal(stagesFor(h, 'bk_good'), ABANDONED_STAGES.length, 'the good booking owns the full sequence')
  assert.equal(stagesFor(h, 'bk_stranded'), 0, 'nothing was ever scheduled for the stranded attempt')
  // WHAT THE OLD SKIP COST: with the pre-repair predicate this total was 0 —
  // after a strand the customer received no recovery email for either booking.
  assert.equal(h.jobs.size, ABANDONED_STAGES.length, 'the customer gets exactly one recovery sequence')
  // The decision was made on EVIDENCE about the sibling, not on its status.
  assert.ok(h.calls.includes('evidence:bk_stranded'), 'the sibling\'s scheduled work was actually checked')
})

test('R5: the stranded booking is still reachable itself — the fix is not "schedule for the wrong row"', async () => {
  const T = new Date(NOW.getTime() - 4 * MINUTE)
  const h = harness([bookingRow('bk_stranded', T), bookingRow('bk_good', NOW)])
  await onCheckoutStarted('bk_good', h.deps)

  // Every scheduled job carries the GOOD booking's id: a recovery email must
  // point the customer at the checkout that exists, never at the dead attempt.
  for (const id of Array.from(h.jobs.keys())) {
    assert.ok(id.endsWith('__bk_good'), `stage job ${id} must belong to the re-submission`)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  2. THE BEHAVIOUR THE SUPPRESSION EXISTS FOR — still intact.
// ════════════════════════════════════════════════════════════════════════

test('R5: a genuine double-submit still produces ONE sequence, on the earlier booking', async () => {
  const h = harness([bookingRow('bk_1', new Date(NOW.getTime() - 2 * MINUTE)), bookingRow('bk_2', NOW)])

  await onCheckoutStarted('bk_1', h.deps) // first submission: schedules
  await onCheckoutStarted('bk_2', h.deps) // the accidental second: suppressed

  assert.equal(stagesFor(h, 'bk_1'), ABANDONED_STAGES.length)
  assert.equal(stagesFor(h, 'bk_2'), 0, 'no second sequence at one inbox')
  assert.equal(h.jobs.size, ABANDONED_STAGES.length)
  // The booking is real either way: the owner-facing trigger fires for BOTH.
  assert.ok(h.calls.includes('trigger:booking_started:bk_2'))
})

test('R5: a sibling whose stages already SENT still suppresses (ledger proof outlives the queue)', async () => {
  // The queue keeps only the last 200 completed jobs, so a fired stage can be
  // evicted. The send ledger is the durable half of the evidence.
  const h = harness([bookingRow('bk_1', new Date(NOW.getTime() - 2 * MINUTE)), bookingRow('bk_2', NOW)], {
    ledger: new Map([['bk_1', 1]]),
  })

  await onCheckoutStarted('bk_2', h.deps)

  assert.equal(h.jobs.size, 0, 'a sequence that already reached the customer is still a sequence')
})

test('R5: two genuinely separate moves, booked outside the window, each keep their sequence', async () => {
  const older = new Date(NOW.getTime() - DUPLICATE_BOOKING_WINDOW_MS - MINUTE)
  const h = harness([bookingRow('bk_old', older), bookingRow('bk_new', NOW)])

  await onCheckoutStarted('bk_old', h.deps)
  await onCheckoutStarted('bk_new', h.deps)

  assert.equal(h.jobs.size, 2 * ABANDONED_STAGES.length)
})

// ════════════════════════════════════════════════════════════════════════
//  3. UNPROVABLE ⇒ NEVER SUPPRESS.
// ════════════════════════════════════════════════════════════════════════

test('R5: when the sibling\'s evidence cannot be read, the sequence is scheduled anyway', async () => {
  const h = harness([bookingRow('bk_1', new Date(NOW.getTime() - 2 * MINUTE)), bookingRow('bk_2', NOW)], {
    unreadable: new Set(['bk_1']),
  })

  await onCheckoutStarted('bk_2', h.deps)

  assert.equal(stagesFor(h, 'bk_2'), ABANDONED_STAGES.length, 'silence is the worse failure; a duplicate is capped')
})

// ════════════════════════════════════════════════════════════════════════
//  4. THE LOG LINE MUST BE PROVABLE (the second half of R5).
// ════════════════════════════════════════════════════════════════════════

test('R5: the suppression message states the counts it was decided on', () => {
  const d = decideDuplicateSuppression({
    bookingId: 'bk_2',
    sibling: 'bk_1',
    evidence: { queuedStages: 3, sentStages: 0 },
  })
  assert.equal(d.suppress, true)
  assert.match(d.message, /owns a recovery sequence \(3 stage job\(s\) queued, 0 in the send ledger\)/)
  assert.deepEqual(d.fields, { bookingId: 'bk_2', duplicateOf: 'bk_1', queuedStages: 3, sentStages: 0 })
})

test('R5: with no scheduled work, nothing claims the sibling owns a sequence', () => {
  const d = decideDuplicateSuppression({
    bookingId: 'bk_good',
    sibling: 'bk_stranded',
    evidence: { queuedStages: 0, sentStages: 0 },
  })
  assert.equal(d.suppress, false)
  assert.ok(!/owns a recovery sequence/.test(d.message), `the old line claimed ownership: ${d.message}`)
  assert.match(d.message, /owns NO recovery sequence \(0 queued, 0 sent\)/)
})

test('R5: unreadable evidence is reported as unreadable, never as zero', () => {
  const d = decideDuplicateSuppression({ bookingId: 'bk_2', sibling: 'bk_1', evidence: null })
  assert.equal(d.suppress, false)
  assert.equal(d.fields.evidence, 'unreadable')
  assert.ok(!/0 queued/.test(d.message), 'a read failure must not be printed as a count')
})

test('R5: one stage of evidence is enough — the counts are ADDED, not required both', () => {
  for (const ev of [
    { queuedStages: 1, sentStages: 0 },
    { queuedStages: 0, sentStages: 1 },
  ] as RecoveryEvidence[]) {
    assert.equal(decideDuplicateSuppression({ bookingId: 'b', sibling: 'a', evidence: ev }).suppress, true, JSON.stringify(ev))
  }
})

test('R5: no sibling at all ⇒ no suppression, and no claim about one', () => {
  const d = decideDuplicateSuppression({ bookingId: 'bk_1', sibling: null, evidence: null })
  assert.equal(d.suppress, false)
  assert.match(d.message, /^no earlier unpaid booking/)
  assert.equal(d.fields.sibling, undefined, 'nothing is named that was not found')
})
