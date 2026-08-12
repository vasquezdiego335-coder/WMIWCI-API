// ============================================================================
// Truck conflict detection (Moving OS Phase 1, owner spec 2026-08-11).
//
// PURE — plain booking shapes, no Prisma imports, offline-testable (the same
// pattern as reminder-rules.ts / profit.ts). Consumers: the admin booking
// create flow (refuses a silent double-booking), GET /api/admin/trucks?date=
// (per-truck busy state in the Book Move workspace), and the
// `truck-double-booked` Action Center rule.
//
// FALLBACK WINDOW: when a booking has no scheduledEnd we hold the truck for
// TRUCK_FALLBACK_HOURS (6h). reminder-rules' crew overlap uses 4h — that
// models a WORKER's shift on the job; a truck is held longer because its
// window brackets the labor on both sides: load + drive + unload (+ the
// return leg to the lot). The 6h difference is deliberate, not drift.
//
// UNKNOWN TIMES: two bookings sharing a truck on the same America/New_York
// calendar day, where either side has no scheduledStart (a date-only
// booking), are a CONFLICT — conservative by design. An unknown time could be
// any time that day, and a silent truck double-booking is exactly the
// expensive mistake this module exists to prevent.
// ============================================================================

const HOUR = 3_600_000

/** Hours a truck is assumed held when a booking has no scheduledEnd. */
export const TRUCK_FALLBACK_HOURS = 6

/** Booking statuses that actually occupy a truck. PENDING_APPROVAL does not
 *  (nothing is promised yet); COMPLETED/CANCELLED trucks are free again. */
export const TRUCK_CONFLICT_STATUSES = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'] as const

/** The plain booking shape every function here works over. The loader maps
 *  Prisma rows (or RuleBooking rows) into this — never pass Prisma types. */
export interface TruckBookingShape {
  id: string
  truckId: string | null
  scheduledStart: Date | null
  scheduledEnd: Date | null
  /** Date-only fallback for legacy rows confirmed before scheduledStart
   *  existed. Used only for the same-ET-day conservative check. */
  confirmedDate: Date | null
  status: string
}

export type TruckConflictReason = 'time_overlap' | 'same_day_unknown_times'

export interface TruckConflict {
  booking: TruckBookingShape
  reason: TruckConflictReason
}

/** 'YYYY-MM-DD' calendar day of an instant in America/New_York. en-CA is the
 *  locale whose date format IS ISO — the same trick availability-engine uses. */
export function etDayKey(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/**
 * Do two time windows overlap? A missing end is assumed `fallbackHours` after
 * its start (6h default — see the header for why trucks hold longer than crew).
 * Pure interval math: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅.
 */
export function overlapWindow(
  aStart: Date,
  aEnd: Date | null,
  bStart: Date,
  bEnd: Date | null,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): boolean {
  const aEndMs = aEnd?.getTime() ?? aStart.getTime() + fallbackHours * HOUR
  const bEndMs = bEnd?.getTime() ?? bStart.getTime() + fallbackHours * HOUR
  return aStart.getTime() < bEndMs && bStart.getTime() < aEndMs
}

/**
 * Conflict test for two bookings ALREADY known to share a truck.
 *  • Both have real start times → interval overlap ('time_overlap').
 *  • Either side is date-only (no scheduledStart) → conservative: the same
 *    ET calendar day is a conflict ('same_day_unknown_times').
 *  • A side with no date at all can never conflict (nothing to collide with).
 */
export function truckConflictBetween(
  a: Pick<TruckBookingShape, 'scheduledStart' | 'scheduledEnd' | 'confirmedDate'>,
  b: Pick<TruckBookingShape, 'scheduledStart' | 'scheduledEnd' | 'confirmedDate'>,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): TruckConflictReason | null {
  if (a.scheduledStart && b.scheduledStart) {
    return overlapWindow(a.scheduledStart, a.scheduledEnd, b.scheduledStart, b.scheduledEnd, fallbackHours)
      ? 'time_overlap'
      : null
  }
  // At least one side has unknown times: compare ET calendar days. Both sides
  // go through the same etDayKey conversion, so a uniformly-stored date-only
  // value compares consistently with its sibling rows.
  const aDay = a.scheduledStart ?? a.confirmedDate
  const bDay = b.scheduledStart ?? b.confirmedDate
  if (!aDay || !bDay) return null
  return etDayKey(aDay) === etDayKey(bDay) ? 'same_day_unknown_times' : null
}

/**
 * All bookings in `bookings` that would collide with assigning `query.truckId`
 * over [start, end]. Only live statuses (CONFIRMED/SCHEDULED/IN_PROGRESS)
 * occupy a truck; `excludeBookingId` lets an edit flow skip the booking being
 * edited. No truckId or no start → nothing to check → no conflicts.
 */
export function findTruckConflictsIn(
  bookings: TruckBookingShape[],
  query: {
    truckId: string | null | undefined
    start: Date | null
    end?: Date | null
    excludeBookingId?: string | null
  },
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): TruckConflict[] {
  if (!query.truckId || !query.start) return []
  const q = { scheduledStart: query.start, scheduledEnd: query.end ?? null, confirmedDate: null }
  const out: TruckConflict[] = []
  for (const b of bookings) {
    if (b.truckId !== query.truckId) continue
    if (query.excludeBookingId && b.id === query.excludeBookingId) continue
    if (!(TRUCK_CONFLICT_STATUSES as readonly string[]).includes(b.status)) continue
    const reason = truckConflictBetween(q, b, fallbackHours)
    if (reason) out.push({ booking: b, reason })
  }
  return out
}
