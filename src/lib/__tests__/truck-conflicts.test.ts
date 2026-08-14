// Offline tests for truck conflict detection (Moving OS Phase 1) + the
// truck-double-booked Action Center rule. Pure shapes, no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  overlapWindow,
  truckConflictBetween,
  findTruckConflictsIn,
  etDayKey,
  isPendingTruckHold,
  truckHoldHours,
  truckOccupiedEtDays,
  MAX_TRUCK_HOLD_HOURS,
  TRUCK_FALLBACK_HOURS,
  TRUCK_HOLD_STATUSES,
  type TruckBookingShape,
} from '../truck-conflicts'
import { TRAVEL_BUFFER_HOURS } from '../travel-buffer'
import { evaluateTruckOverlaps, evaluateAll, type RuleBooking } from '../reminder-rules'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Noon ET on Aug 12 2026 (EDT, UTC-4) — mid-day so ET day keys are unambiguous.
const NOW = new Date('2026-08-12T16:00:00Z')
const at = (iso: string) => new Date(iso)

// ── overlapWindow math ────────────────────────────────────────────────────────

test('overlapWindow: plain interval overlap and disjoint windows', () => {
  const a = at('2026-08-12T09:00:00-04:00')
  const aEnd = at('2026-08-12T13:00:00-04:00')
  assert.equal(overlapWindow(a, aEnd, at('2026-08-12T12:00:00-04:00'), at('2026-08-12T15:00:00-04:00')), true)
  assert.equal(overlapWindow(a, aEnd, at('2026-08-12T14:00:00-04:00'), at('2026-08-12T16:00:00-04:00')), false)
  // Touching endpoints do NOT overlap (half-open intervals): 9-13 vs 13-15.
  assert.equal(overlapWindow(a, aEnd, at('2026-08-12T13:00:00-04:00'), at('2026-08-12T15:00:00-04:00')), false)
})

test('overlapWindow: missing end assumes the 6h truck hold (load+drive+unload)', () => {
  assert.equal(TRUCK_FALLBACK_HOURS, 6)
  const a = at('2026-08-12T09:00:00-04:00') // held 09:00-15:00 with no end
  // A 14:30 start collides with the assumed hold…
  assert.equal(overlapWindow(a, null, at('2026-08-12T14:30:00-04:00'), null), true)
  // …a 15:00 start does not (the hold has ended).
  assert.equal(overlapWindow(a, null, at('2026-08-12T15:00:00-04:00'), null), false)
  // Explicit fallbackHours is honored: a 2h hold frees the truck by noon.
  assert.equal(overlapWindow(a, null, at('2026-08-12T12:00:00-04:00'), null, 2), false)
})

// ── P0-A: truckHoldHours — the derived window ────────────────────────────────

test('truckHoldHours: the estimate + the house buffer, floored at the fallback', () => {
  // The floor. A studio's 3h job + the 1h buffer is shorter than the fallback,
  // so the hold stays 6h — max(), never "replace" (a replace would SHRINK
  // holds that are correct today).
  assert.equal(truckHoldHours({ estimatedHours: 3 }), TRUCK_FALLBACK_HOURS)
  assert.equal(truckHoldHours({ estimatedHours: TRUCK_FALLBACK_HOURS - TRAVEL_BUFFER_HOURS }), TRUCK_FALLBACK_HOURS)
  // Above the floor the job's own length wins: an 8h 4BR holds its truck for 9h.
  assert.equal(truckHoldHours({ estimatedHours: 8 }), 8 + TRAVEL_BUFFER_HOURS)
  assert.equal(truckHoldHours({ estimatedHours: 10 }), 10 + TRAVEL_BUFFER_HOURS)
  // No usable estimate → the fallback, exactly as before P0-A. This is the row
  // read by a caller whose `select` never named the column.
  for (const junk of [null, undefined, 0, -4, NaN, Infinity]) {
    assert.equal(truckHoldHours({ estimatedHours: junk as number | null }), TRUCK_FALLBACK_HOURS, String(junk))
  }
  // An explicit fallback is still honoured (a caller saying "assume 2h").
  assert.equal(truckHoldHours({ estimatedHours: null }, 2), 2)
  assert.equal(truckHoldHours({ estimatedHours: 8 }, 2), 8 + TRAVEL_BUFFER_HOURS)
  // A data-error estimate is clamped, and the clamp can never pull a hold
  // BELOW the fallback.
  assert.equal(truckHoldHours({ estimatedHours: 9_999 }), MAX_TRUCK_HOLD_HOURS + TRAVEL_BUFFER_HOURS)
  assert.ok(truckHoldHours({ estimatedHours: 9_999 }) >= TRUCK_FALLBACK_HOURS)
})

test('P0-A: a long job occupies the next ET day; the same job in the morning does not', () => {
  const evening = { scheduledStart: null, scheduledEnd: null, confirmedDate: at('2026-08-13T18:00:00-04:00') }
  // 8h + buffer = 9h → 18:00 runs to 03:00 the next day.
  assert.deepEqual(truckOccupiedEtDays({ ...evening, estimatedHours: 8 }), ['2026-08-13', '2026-08-14'])
  // Without the column it collapses to the flat fallback — 18:00 + 6h lands
  // exactly on midnight, and the window is half-open, so ONE day. That is the
  // defect, kept here as the contrast.
  assert.deepEqual(truckOccupiedEtDays(evening), ['2026-08-13'])
  // Morning: nowhere near midnight either way.
  const morning = { scheduledStart: null, scheduledEnd: null, confirmedDate: at('2026-08-13T09:00:00-04:00'), estimatedHours: 8 }
  assert.deepEqual(truckOccupiedEtDays(morning), ['2026-08-13'])
})

test('P0-A: a STORED window governs — the hold floor never widens a known end', () => {
  // The floor answers "we do not know when this ends". A row that DOES say when
  // it ends is not second-guessed: a 20:00 job that releases the truck at
  // midnight occupies one ET day, and the next day is free — including for a
  // day-level booking, which is the comparison that would otherwise silently
  // inherit the 6h fallback.
  const knownEnd = {
    scheduledStart: at('2026-08-13T20:00:00-04:00'),
    scheduledEnd: at('2026-08-14T00:00:00-04:00'),
    confirmedDate: null,
    estimatedHours: 3,
  }
  assert.deepEqual(truckOccupiedEtDays(knownEnd), ['2026-08-13'])
  const nextDayLevel = { scheduledStart: null, scheduledEnd: null, confirmedDate: at('2026-08-14T00:00:00-04:00') }
  assert.equal(truckConflictBetween(knownEnd, nextDayLevel), null)
  // Strip the stored end and the derived hold takes over (3h + buffer < the 6h
  // floor → 02:00), so the same job then does hold the next morning.
  assert.equal(truckConflictBetween({ ...knownEnd, scheduledEnd: null }, nextDayLevel), 'same_day_unknown_times')
})

test('P0-A: each side of a comparison uses ITS OWN length', () => {
  // Two open-ended timed rows, 8 hours apart. The long job's hold reaches the
  // second one; the short job's does not reach back — the hold is a property of
  // the booking, not of the comparison.
  const long = { scheduledStart: at('2026-08-13T09:00:00-04:00'), scheduledEnd: null, confirmedDate: null, estimatedHours: 10 }
  const later = { scheduledStart: at('2026-08-13T17:00:00-04:00'), scheduledEnd: null, confirmedDate: null, estimatedHours: 3 }
  assert.equal(truckConflictBetween(long, later), 'time_overlap')
  assert.equal(truckConflictBetween(later, long), 'time_overlap', 'the rule is symmetric')
  // Drop the long job's estimate and the flat 6h fallback frees the truck at
  // 15:00 — the pre-P0-A answer.
  assert.equal(truckConflictBetween({ ...long, estimatedHours: null }, later), null)
  // A STORED end always wins over the derived one: the same long job with a
  // real 13:00 finish does not reach 17:00.
  assert.equal(truckConflictBetween({ ...long, scheduledEnd: at('2026-08-13T13:00:00-04:00') }, later), null)
  // overlapWindow takes the two lengths separately (and one scalar still means
  // "both sides", the old signature).
  const a = at('2026-08-13T09:00:00-04:00')
  const b = at('2026-08-13T14:30:00-04:00')
  assert.equal(overlapWindow(a, null, b, null, 4, 4), false)
  assert.equal(overlapWindow(a, null, b, null, 9, 4), true, "the FIRST booking's length is what reaches")
})

// ── truckConflictBetween: unknown-times conservatism ─────────────────────────

test('same ET day with unknown times is a conservative conflict', () => {
  const timed = { scheduledStart: at('2026-08-13T09:00:00-04:00'), scheduledEnd: null, confirmedDate: null }
  const dateOnly = { scheduledStart: null, scheduledEnd: null, confirmedDate: at('2026-08-13T18:00:00-04:00') }
  assert.equal(truckConflictBetween(timed, dateOnly), 'same_day_unknown_times')
  // Different ET day: no conflict.
  const otherDay = { scheduledStart: null, scheduledEnd: null, confirmedDate: at('2026-08-14T09:00:00-04:00') }
  assert.equal(truckConflictBetween(timed, otherDay), null)
  // No date at all on one side: nothing to collide with.
  const dateless = { scheduledStart: null, scheduledEnd: null, confirmedDate: null }
  assert.equal(truckConflictBetween(timed, dateless), null)
  // Both timed on the same day but disjoint: real times beat day-level panic.
  const evening = { scheduledStart: at('2026-08-13T16:00:00-04:00'), scheduledEnd: null, confirmedDate: null }
  assert.equal(truckConflictBetween(timed, evening), null)
})

test('etDayKey renders the America/New_York calendar day', () => {
  assert.equal(etDayKey(NOW), '2026-08-12')
  // 1am UTC is still the PREVIOUS day in ET — the classic off-by-one.
  assert.equal(etDayKey(at('2026-08-13T01:00:00Z')), '2026-08-12')
})

// ── findTruckConflictsIn ─────────────────────────────────────────────────────

function shape(over: Partial<TruckBookingShape> = {}): TruckBookingShape {
  return {
    id: 'b1',
    truckId: 't1',
    scheduledStart: at('2026-08-13T09:00:00-04:00'),
    scheduledEnd: at('2026-08-13T13:00:00-04:00'),
    confirmedDate: null,
    status: 'SCHEDULED',
    ...over,
  }
}

test('findTruckConflictsIn: overlap found on the same truck only', () => {
  const bookings = [
    shape({ id: 'b1' }),
    shape({ id: 'b2', truckId: 't2' }), // different truck — never a conflict
  ]
  const conflicts = findTruckConflictsIn(bookings, { truckId: 't1', start: at('2026-08-13T12:00:00-04:00'), end: at('2026-08-13T16:00:00-04:00') })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].booking.id, 'b1')
  assert.equal(conflicts[0].reason, 'time_overlap')
})

test('findTruckConflictsIn: excludeBookingId skips the booking being edited', () => {
  const bookings = [shape({ id: 'b1' })]
  const q = { truckId: 't1', start: at('2026-08-13T09:30:00-04:00'), excludeBookingId: 'b1' }
  assert.equal(findTruckConflictsIn(bookings, q).length, 0)
  assert.equal(findTruckConflictsIn(bookings, { ...q, excludeBookingId: null }).length, 1)
})

test('findTruckConflictsIn: finished/abandoned bookings never occupy a truck', () => {
  for (const status of ['CANCELLED', 'COMPLETED', 'DRAFT', 'ARCHIVED', 'DECLINED']) {
    const conflicts = findTruckConflictsIn([shape({ status })], { truckId: 't1', start: at('2026-08-13T10:00:00-04:00') })
    assert.equal(conflicts.length, 0, `${status} should not conflict`)
  }
  // Every TRUCK_HOLD_STATUS conflicts — including the unpaid/unapproved holds
  // the default `stripe_link` create writes (R2-2). Round 1 asserted the
  // opposite for PENDING_APPROVAL, which is how a truck could be assigned in a
  // status the check could not see.
  for (const status of TRUCK_HOLD_STATUSES) {
    const conflicts = findTruckConflictsIn([shape({ status })], { truckId: 't1', start: at('2026-08-13T10:00:00-04:00') })
    assert.equal(conflicts.length, 1, `${status} should conflict`)
    assert.equal(conflicts[0].hold, isPendingTruckHold(status) ? 'pending' : 'confirmed')
  }
})

test('findTruckConflictsIn: date-only booking conflicts on the same ET day', () => {
  const dateOnly = shape({ id: 'b9', scheduledStart: null, scheduledEnd: null, confirmedDate: at('2026-08-13T00:00:00-04:00') })
  const conflicts = findTruckConflictsIn([dateOnly], { truckId: 't1', start: at('2026-08-13T15:00:00-04:00') })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].reason, 'same_day_unknown_times')
  // Next day: free.
  assert.equal(findTruckConflictsIn([dateOnly], { truckId: 't1', start: at('2026-08-14T15:00:00-04:00') }).length, 0)
})

test('findTruckConflictsIn: no truckId or no start means nothing to check', () => {
  assert.equal(findTruckConflictsIn([shape()], { truckId: null, start: at('2026-08-13T09:30:00-04:00') }).length, 0)
  assert.equal(findTruckConflictsIn([shape()], { truckId: 't1', start: null }).length, 0)
})

// ── truck-double-booked Action Center rule ───────────────────────────────────

function ruleBooking(over: Partial<RuleBooking> = {}): RuleBooking {
  return {
    id: 'b1', displayId: 'B-1', status: 'SCHEDULED',
    customerName: 'Maria Lopez', customerPhone: '(973) 555-0100', customerEmail: 'maria@example.com',
    originAddress: '12 Main St, Newark, NJ', destAddress: '99 Oak Ave, Montclair, NJ',
    originVerification: 'verified', destVerification: 'verified', manualReviewRequired: false,
    agreementAccepted: true, totalEstimate: 700,
    scheduledStart: new Date(NOW.getTime() + DAY), scheduledEnd: null,
    requestedDate: null, completedAt: null,
    truckAddonDueOnMoveDay: false, truckProvider: null, truckReservationStatus: null, truckReservationNumber: null,
    jobStartedAt: null, truckId: 't1', confirmedDate: null,
    crew: [], hasFailedPayment: false, hasWorkerPayExpense: false,
    outstandingBalanceCents: 0, netRevenueCents: 70000, netProfitCents: 40000,
    ...over,
  }
}

test('truck-double-booked fires once per truck per ET day with a stable dedupeKey', () => {
  // NOW+DAY = noon ET Aug 13; a 2h-later start is inside the 6h truck hold.
  const a = ruleBooking({ id: 'bA', customerName: 'A' })
  const b = ruleBooking({ id: 'bB', customerName: 'B', scheduledStart: new Date(NOW.getTime() + DAY + 2 * HOUR) })
  const first = evaluateTruckOverlaps([a, b], NOW)
  assert.equal(first.length, 1)
  const hit = first[0]
  assert.equal(hit.reminderType, 'truck-double-booked')
  assert.equal(hit.category, 'JOBS_SCHEDULING')
  assert.equal(hit.severity, 'CRITICAL')
  assert.equal(hit.sourceEntityType, 'truck')
  assert.equal(hit.sourceEntityId, 't1')
  assert.equal(hit.dedupeKey, 'truck-double-booked:truck:t1:2026-08-13')
  assert.match(hit.description, /A, B|B, A/)
  // Stable: same key on a re-run AND regardless of input order — the
  // anti-spam contract computeSyncActions depends on.
  assert.equal(evaluateTruckOverlaps([a, b], NOW)[0].dedupeKey, hit.dedupeKey)
  assert.equal(evaluateTruckOverlaps([b, a], NOW)[0].dedupeKey, hit.dedupeKey)
})

test('three jobs colliding on one truck one day collapse into ONE reminder', () => {
  const a = ruleBooking({ id: 'bA', customerName: 'A' })
  const b = ruleBooking({ id: 'bB', customerName: 'B', scheduledStart: new Date(NOW.getTime() + DAY + HOUR) })
  const c = ruleBooking({ id: 'bC', customerName: 'C', scheduledStart: new Date(NOW.getTime() + DAY + 2 * HOUR) })
  const out = evaluateTruckOverlaps([a, b, c], NOW)
  assert.equal(out.length, 1)
  assert.match(out[0].title, /3 jobs/)
})

test('no truck, different trucks, cancelled, or disjoint times: rule stays quiet', () => {
  const a = ruleBooking({ id: 'bA' })
  // No truckId at all.
  assert.equal(evaluateTruckOverlaps([ruleBooking({ id: 'x', truckId: null }), ruleBooking({ id: 'y', truckId: undefined })], NOW).length, 0)
  // Different trucks.
  assert.equal(evaluateTruckOverlaps([a, ruleBooking({ id: 'bB', truckId: 't2' })], NOW).length, 0)
  // Cancelled sibling.
  assert.equal(evaluateTruckOverlaps([a, ruleBooking({ id: 'bB', status: 'CANCELLED' })], NOW).length, 0)
  // Same truck, but far enough apart (7h > the 6h hold).
  assert.equal(evaluateTruckOverlaps([a, ruleBooking({ id: 'bB', scheduledStart: new Date(NOW.getTime() + DAY + 7 * HOUR) })], NOW).length, 0)
})

test('date-only bookings sharing a truck on the same ET day fire the rule', () => {
  const moveDay = new Date(NOW.getTime() + 2 * DAY)
  const a = ruleBooking({ id: 'bA', customerName: 'A', status: 'CONFIRMED', scheduledStart: null, confirmedDate: moveDay })
  const b = ruleBooking({ id: 'bB', customerName: 'B', status: 'CONFIRMED', scheduledStart: null, confirmedDate: moveDay })
  const out = evaluateTruckOverlaps([a, b], NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].dedupeKey, `truck-double-booked:truck:t1:${etDayKey(moveDay)}`)
})

test('truck-double-booked fires when one side is only an unpaid hold, and says so (R2-2)', () => {
  // PENDING_APPROVAL is loaded by reminder-sync TODAY, so this pairing is live:
  // a confirmed job and a paid-but-unapproved booking on one truck used to be
  // invisible to this rule until BOTH were approved — i.e. after the damage.
  const confirmed = ruleBooking({ id: 'bA', customerName: 'A', status: 'CONFIRMED' })
  const held = ruleBooking({
    id: 'bB', customerName: 'B', status: 'PENDING_APPROVAL',
    scheduledStart: new Date(NOW.getTime() + DAY + 2 * HOUR),
  })
  const out = evaluateTruckOverlaps([confirmed, held], NOW)
  assert.equal(out.length, 1)
  assert.match(out[0].description, /B \(unpaid hold\)/)
  assert.match(out[0].description, /only an unpaid hold/)

  // Two unpaid holds (the shape the default stripe_link path produces) get
  // their own line — the owner may be waiting on one to fall through.
  const bothPending = evaluateTruckOverlaps(
    [
      ruleBooking({ id: 'bC', customerName: 'C', status: 'PENDING_PAYMENT' }),
      ruleBooking({ id: 'bD', customerName: 'D', status: 'PENDING_PAYMENT', scheduledStart: new Date(NOW.getTime() + DAY + HOUR) }),
    ],
    NOW,
  )
  assert.equal(bothPending.length, 1)
  assert.match(bothPending[0].description, /None of them is paid or approved yet/)

  // A dead status on one side still keeps the rule quiet.
  for (const dead of ['CANCELLED', 'COMPLETED', 'DRAFT', 'ARCHIVED']) {
    assert.equal(evaluateTruckOverlaps([confirmed, ruleBooking({ id: 'bX', status: dead })], NOW).length, 0, dead)
  }
})

test('evaluateAll carries the truck rule and stamps its fingerprint', () => {
  const a = ruleBooking({ id: 'bA', customerName: 'A' })
  const b = ruleBooking({ id: 'bB', customerName: 'B', scheduledStart: new Date(NOW.getTime() + DAY + HOUR) })
  const all = evaluateAll({ bookings: [a, b], expenses: [], ownerTransactions: [], leads: [], customers: [] }, NOW)
  const hit = all.find((c) => c.reminderType === 'truck-double-booked')
  assert.ok(hit)
  assert.ok(hit!.fingerprint, 'evaluateAll must stamp the fingerprint')
})
