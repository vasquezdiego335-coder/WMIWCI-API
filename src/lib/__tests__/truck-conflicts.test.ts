// Offline tests for truck conflict detection (Moving OS Phase 1) + the
// truck-double-booked Action Center rule. Pure shapes, no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  overlapWindow,
  truckConflictBetween,
  findTruckConflictsIn,
  etDayKey,
  TRUCK_FALLBACK_HOURS,
  type TruckBookingShape,
} from '../truck-conflicts'
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

test('findTruckConflictsIn: cancelled/completed/pending bookings never occupy a truck', () => {
  for (const status of ['CANCELLED', 'COMPLETED', 'PENDING_APPROVAL', 'DECLINED']) {
    const conflicts = findTruckConflictsIn([shape({ status })], { truckId: 't1', start: at('2026-08-13T10:00:00-04:00') })
    assert.equal(conflicts.length, 0, `${status} should not conflict`)
  }
  // Sanity: the same window against a live status DOES conflict.
  for (const status of ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']) {
    const conflicts = findTruckConflictsIn([shape({ status })], { truckId: 't1', start: at('2026-08-13T10:00:00-04:00') })
    assert.equal(conflicts.length, 1, `${status} should conflict`)
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

test('evaluateAll carries the truck rule and stamps its fingerprint', () => {
  const a = ruleBooking({ id: 'bA', customerName: 'A' })
  const b = ruleBooking({ id: 'bB', customerName: 'B', scheduledStart: new Date(NOW.getTime() + DAY + HOUR) })
  const all = evaluateAll({ bookings: [a, b], expenses: [], ownerTransactions: [], leads: [], customers: [] }, NOW)
  const hit = all.find((c) => c.reminderType === 'truck-double-booked')
  assert.ok(hit)
  assert.ok(hit!.fingerprint, 'evaluateAll must stamp the fingerprint')
})
