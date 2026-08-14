// ============================================================================
// Truck conflict detection (Moving OS Phase 1, owner spec 2026-08-11;
// R2-2 hold-status fix 2026-08-12).
//
// PURE — plain booking shapes, no Prisma imports, offline-testable (the same
// pattern as reminder-rules.ts / profit.ts). Consumers: the admin booking
// create flow (refuses a silent double-booking, before AND under the lock),
// GET /api/admin/trucks?date= (per-truck busy state in the Book Move
// workspace), and the `truck-double-booked` Action Center rule.
//
// FALLBACK WINDOW: when a booking has no scheduledEnd we hold the truck for
// TRUCK_FALLBACK_HOURS (6h). reminder-rules' crew overlap uses 4h — that
// models a WORKER's shift on the job; a truck is held longer because its
// window brackets the labor on both sides: load + drive + unload (+ the
// return leg to the lot). The 6h difference is deliberate, not drift.
//
// ── P0-A: THE FALLBACK IS THE FLOOR, NOT THE ANSWER ─────────────────────────
// The 6h fallback was applied as a FIXED scalar to every row without a stored
// end, so an 8h 4BR job and a 2h studio job held their truck for exactly as
// long. The default `stripe_link` create persists `estimatedHours` and NOT
// scheduledStart/scheduledEnd (those ride the CONFIRMED branch), so the row the
// owner produces most often was the one whose real length was thrown away: a
// 4BR starting 18:00 ET occupies 18:00 → 03:00, but the 6h fallback ended at
// exactly 00:00 — and because etDaysCovered is half-open, that collapsed to ONE
// ET day. The next-day-early booking was waved through, while the byte-
// identical CONFIRMED job (which stores scheduledEnd) was refused.
//
// `truckHoldHours` now derives the window from the booking's own estimate plus
// the house travel buffer, and takes the MAX with the fallback so a hold can
// only ever get LONGER than it was (a 3h studio estimate must not shrink the
// 6h hold it has today). `TRUCK_CANDIDATE_SELECT` / `TruckBookingShape` /
// `toTruckBookingShapes` carry `estimatedHours` so a STORED row can answer the
// question — before P0-A the column was saved and then dropped four times over
// between the database and this file.
//
// UNKNOWN TIMES: two bookings sharing a truck on the same America/New_York
// calendar day, where either side has no scheduledStart (a date-only
// booking), are a CONFLICT — conservative by design. An unknown time could be
// any time that day, and a silent truck double-booking is exactly the
// expensive mistake this module exists to prevent.
//
// ── R3-4: THE UNKNOWN-TIME SIDE ALSO CROSSES MIDNIGHT ───────────────────────
// Round 2 compared ONE ET day key per side, which quietly made the guard
// weaker for exactly the rows the DEFAULT path writes. buildBookingCreateData
// persists scheduledStart ONLY on a CONFIRMED create, so a `stripe_link` hold
// keeps its move instant in `requestedDate` alone: a 9 PM hold read as one ET
// day, its 6 h fallback (→ 3 AM) evaporated, and a 00:30 create the next day
// was waved through — while the byte-identical CONFIRMED job (which does store
// scheduledStart) was refused by the interval check. Detection now derives the
// ET days from the WINDOW on both sides (truckOccupiedEtDays), which is the
// same span the create-time lock already takes (truck-lock.truckWindowDayKeys,
// built on the shared etDaysCovered below).
//
// The scope of that claim, stated exactly (P0-A): the lock is taken from the
// create's IN-MEMORY schedule and detection reads a STORED row, so "identical"
// holds for the rows the default path writes, and everywhere else the lock is a
// SUPERSET — it can never serialize a narrower window than the check can find a
// conflict in. Before P0-A that was untrue in the dangerous direction: a
// stripe_link create locked both ET days and the re-check under that lock then
// read one, so the lock serialised the race perfectly and returned the wrong
// answer.
//
// ── R2-2: WHICH STATUSES HOLD A TRUCK ───────────────────────────────────────
// Round 1 filtered candidates to [CONFIRMED, SCHEDULED, IN_PROGRESS] — the
// LIVE statuses. The DEFAULT owner path (`stripe_link` deposit) creates the
// booking PENDING_PAYMENT with `truckId` already set, so the truck was
// assigned in a status the conflict check could not see: two creates —
// concurrent OR SEQUENTIAL — both took the same truck, the busy indicator
// showed it free, and the Action Center rule stayed quiet until both were
// approved. A truck the owner assigned to an unpaid booking IS held.
//
// TRUCK_HOLD_STATUSES is THE list, used by every caller (pre-check, locked
// re-check, findTruckConflictsIn, the trucks busy indicator, the
// truck-double-booked rule). No per-caller copies — a second copy is how the
// default path lost the guarantee in the first place.
//
// DRAFT / COMPLETED / CANCELLED / ARCHIVED never hold a truck: a draft was
// never promised, and the other three are over.
// ============================================================================

// The ONE house travel buffer (travel-buffer.ts imports nothing, so this module
// stays pure and client-safe). scheduling.calculateEndTime adds the same
// constant when it writes a CONFIRMED row's scheduledEnd — a second, hand-typed
// copy here is exactly the drift that lost round R2-2.
import { TRAVEL_BUFFER_HOURS } from './travel-buffer'

const HOUR = 3_600_000
const DAY_MS = 24 * HOUR

/** Hours a truck is held when a booking gives us nothing better to go on — no
 *  scheduledEnd AND no usable estimate. It is the FLOOR of every derived hold
 *  (see truckHoldHours), never a cap. */
export const TRUCK_FALLBACK_HOURS = 6

/** Ceiling on the ESTIMATE half of a derived hold. A single move occupying a
 *  truck for more than a day is a data error — the assistant's own ceiling is
 *  HOURS_MAX = 12 — and an unbounded window would block every neighbouring day.
 *  It never binds in practice (12h + the 1h buffer is 13h) and can never pull a
 *  hold BELOW `fallbackHours`. */
export const MAX_TRUCK_HOLD_HOURS = 24

/** Statuses where the truck is assigned but the job is not yet paid for /
 *  approved. They HOLD the truck (nobody else may take it) but the refusal
 *  message says so, because the owner may legitimately override a hold that a
 *  customer has not paid for — unlike a confirmed job, which is a promise. */
export const TRUCK_PENDING_HOLD_STATUSES = ['PENDING_APPROVAL', 'PENDING_PAYMENT'] as const

/** THE statuses that occupy a truck — live jobs plus unpaid/unapproved holds.
 *  ONE constant for every caller (see the header). */
export const TRUCK_HOLD_STATUSES = [
  // Live: crew and truck are going out.
  'CONFIRMED',
  'SCHEDULED',
  'IN_PROGRESS',
  // Held: the owner assigned this truck; money/approval is still outstanding.
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
] as const

export type TruckHoldStatus = (typeof TRUCK_HOLD_STATUSES)[number]

/** Does this booking status occupy a truck? */
export function holdsTruck(status: string): boolean {
  return (TRUCK_HOLD_STATUSES as readonly string[]).includes(status)
}

/** Is the hold an unpaid/unapproved one (softer refusal copy)? */
export function isPendingTruckHold(status: string): boolean {
  return (TRUCK_PENDING_HOLD_STATUSES as readonly string[]).includes(status)
}

/** The plain booking shape every function here works over. The loader maps
 *  Prisma rows (or RuleBooking rows) into this — never pass Prisma types. */
export interface TruckBookingShape {
  id: string
  /** WMIC-#### — used to NAME the clashing booking in the refusal. Optional so
   *  older fixtures and the reminder-rule shape still satisfy this type. */
  displayId?: string | null
  truckId: string | null
  scheduledStart: Date | null
  scheduledEnd: Date | null
  /** Date-only fallback for legacy rows confirmed before scheduledStart
   *  existed, and for day-level bookings (R2-1). Used for the same-ET-day
   *  conservative check. */
  confirmedDate: Date | null
  status: string
  /** Booking.estimatedHours — the assistant's estimatedHoursMax, which
   *  buildBookingCreateData persists on EVERY deposit mode (P0-A). It is how a
   *  row with no stored scheduledEnd states its real length; without it the
   *  hold collapses to the flat 6h fallback. Optional so older fixtures, the
   *  reminder-rule shape and a row read before the column was selected still
   *  satisfy this type — absent simply means "fall back", the pre-P0-A
   *  behaviour. */
  estimatedHours?: number | null
}

export type TruckConflictReason = 'time_overlap' | 'same_day_unknown_times'

/** Which KIND of hold was hit — drives the message (R2-2 fix 2): a confirmed
 *  job is a promise to a customer; a pending one is money not yet taken. */
export type TruckHoldKind = 'confirmed' | 'pending'

export interface TruckConflict {
  booking: TruckBookingShape
  reason: TruckConflictReason
  hold: TruckHoldKind
}

export const holdKindOf = (status: string): TruckHoldKind =>
  isPendingTruckHold(status) ? 'pending' : 'confirmed'

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

/** "Aug 15" in ET — how a conflicting day is named to the owner. */
export function etDayLabel(instant: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  }).format(instant)
}

/** The instant a booking's day is judged by: a real start, else the day anchor. */
export const truckBookingBasis = (b: Pick<TruckBookingShape, 'scheduledStart' | 'confirmedDate'>): Date | null =>
  b.scheduledStart ?? b.confirmedDate ?? null

/** Safety stop for the day walk below: a booking window longer than this is a
 *  data error, not an overnight job, and must never expand without bound. */
export const MAX_WINDOW_DAYS = 4

/**
 * How long this booking holds its truck when the window has to be DERIVED —
 * i.e. there is no stored `scheduledEnd` (P0-A). THE one derivation: the
 * conflict rules and the advisory locks both go through it.
 *
 *   max(estimatedHours + the house travel buffer, fallbackHours)
 *
 * MAX, not "replace", and that is load-bearing rather than stylistic: a
 * little-studio's 3h estimate + 1h buffer is SHORTER than the 6h fallback, so
 * replacing would SHRINK a hold that is correct today (a 20:00 studio job would
 * stop occupying the next ET day, which is a regression, not a fix). The
 * estimate can only ever make a hold LONGER.
 *
 * The buffer is the same TRAVEL_BUFFER_MINUTES `scheduling.calculateEndTime`
 * adds when it computes a CONFIRMED row's real scheduledEnd. That equality is
 * the point of P0-A: an unpaid `stripe_link` hold must occupy exactly the
 * window its `collect_on_day` twin does, because it is the same job.
 *
 * No usable estimate (null, 0, NaN, or a column that was never selected) →
 * the fallback, exactly as before.
 */
export function truckHoldHours(
  b: Pick<TruckBookingShape, 'estimatedHours'>,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): number {
  const est = b.estimatedHours
  if (typeof est !== 'number' || !Number.isFinite(est) || est <= 0) return fallbackHours
  return Math.max(fallbackHours, Math.min(est, MAX_TRUCK_HOLD_HOURS) + TRAVEL_BUFFER_HOURS)
}

/**
 * Every ET calendar day the half-open window [start, end) touches, as
 * 'YYYY-MM-DD'. A missing `end` is the `fallbackHours` truck hold.
 *
 * Half-open: a window ending exactly at 00:00 ET does NOT reach into the next
 * day, so the LAST OCCUPIED instant (end − 1 ms) decides. The walk steps day by
 * day so a multi-day window can never skip the middle.
 *
 * THE one day-span derivation in the system: the conflict rules (below) and the
 * advisory locks (truck-lock.truckWindowDayKeys) both call it. On the default
 * `stripe_link` path the two produce the SAME set — same basis, same derived
 * hold — and the lock is never narrower than detection anywhere else, because
 * truckWindowDayKeys walks the LATER of the stored end and the derived hold.
 */
export function etDaysCovered(
  start: Date,
  end: Date | null,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): string[] {
  const days = new Set<string>([etDayKey(start)])
  const endMs = end?.getTime() ?? start.getTime() + fallbackHours * HOUR
  const lastMs = endMs - 1
  if (lastMs > start.getTime()) {
    for (let i = 1; i <= MAX_WINDOW_DAYS; i++) {
      const step = start.getTime() + i * DAY_MS
      days.add(etDayKey(new Date(Math.min(step, lastMs))))
      if (step >= lastMs) break
    }
    days.add(etDayKey(new Date(lastMs)))
  }
  return Array.from(days).sort()
}

/**
 * The ET calendar days this booking OCCUPIES its truck on (R3-4).
 *
 *  • Timed row → its real window (scheduledEnd, else the derived hold).
 *  • Basis-only row (no scheduledStart — the shape the default `stripe_link`
 *    create persists) → the SAME derived window measured from its basis. A
 *    day anchor at 00:00 ET still covers one day; a 9 PM move instant covers
 *    two, exactly as the identical timed row does.
 *  • No date at all → no days, and therefore no possible conflict.
 *
 * P0-A: the derived hold is `truckHoldHours(b)` — the booking's OWN estimated
 * length, floored at the fallback — not a flat 6h for every row. That is what
 * makes an 18:00 4BR hold reach into the next ET day the way its confirmed twin
 * always did.
 */
export function truckOccupiedEtDays(
  b: Pick<TruckBookingShape, 'scheduledStart' | 'scheduledEnd' | 'confirmedDate' | 'estimatedHours'>,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): string[] {
  const basis = b.scheduledStart ?? truckBookingBasis(b)
  if (!basis) return []
  return etDaysCovered(basis, truckHoldEndInstant(b, fallbackHours), truckHoldHours(b, fallbackHours))
}

/**
 * The instant this booking releases its truck — a stored `scheduledEnd` when
 * there is one, else the derived hold measured from the booking's basis. Null
 * only when the booking has no date at all.
 *
 * Exported because the REFUSAL COPY needs it: with a hold now as long as the
 * job, an evening booking legitimately blocks the following ET morning, and
 * "Truck 1 is held by WMIC-1042 on Aug 15" alone reads like a non sequitur to
 * an owner who is booking Aug 16. It is derived HERE, next to the day walk that
 * uses it, so the sentence and the decision can never describe different
 * windows (a second copy of this derivation is the R2-2 defect class).
 */
export function truckHoldEndInstant(
  b: Pick<TruckBookingShape, 'scheduledStart' | 'scheduledEnd' | 'confirmedDate' | 'estimatedHours'>,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): Date | null {
  const basis = b.scheduledStart ?? truckBookingBasis(b)
  if (!basis) return null
  // A stored end belongs to a stored start; a basis-only row has neither, so
  // the derived hold is all we know.
  if (b.scheduledStart && b.scheduledEnd) return b.scheduledEnd
  return new Date(basis.getTime() + truckHoldHours(b, fallbackHours) * HOUR)
}

/**
 * Do two time windows overlap? A missing end is assumed `aHoldHours` /
 * `bHoldHours` after its own start. Pure interval math:
 * [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅.
 *
 * P0-A: the two sides take SEPARATE hold lengths, because a hold's length is a
 * property of the booking (its estimate), not of the comparison. Passing one
 * scalar still works and applies it to both sides — that is the old signature,
 * and it is what a caller means by "assume a 2h hold for anything open-ended".
 */
export function overlapWindow(
  aStart: Date,
  aEnd: Date | null,
  bStart: Date,
  bEnd: Date | null,
  aHoldHours: number = TRUCK_FALLBACK_HOURS,
  bHoldHours: number = aHoldHours,
): boolean {
  const aEndMs = aEnd?.getTime() ?? aStart.getTime() + aHoldHours * HOUR
  const bEndMs = bEnd?.getTime() ?? bStart.getTime() + bHoldHours * HOUR
  return aStart.getTime() < bEndMs && bStart.getTime() < aEndMs
}

/**
 * Conflict test for two bookings ALREADY known to share a truck.
 *  • Both have real start times → interval overlap ('time_overlap').
 *  • Either side is date-only (no scheduledStart) → conservative: sharing ANY
 *    ET calendar day their windows touch is a conflict
 *    ('same_day_unknown_times'). R3-4: "the days their windows touch", not
 *    "the day their basis lands on" — an evening booking whose hold runs past
 *    midnight occupies both days whether or not its start time was persisted.
 *  • A side with no date at all can never conflict (nothing to collide with).
 */
export function truckConflictBetween(
  a: Pick<TruckBookingShape, 'scheduledStart' | 'scheduledEnd' | 'confirmedDate' | 'estimatedHours'>,
  b: Pick<TruckBookingShape, 'scheduledStart' | 'scheduledEnd' | 'confirmedDate' | 'estimatedHours'>,
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): TruckConflictReason | null {
  if (a.scheduledStart && b.scheduledStart) {
    // P0-A: each side's open-ended window is ITS OWN length. A stored
    // scheduledEnd still wins outright — that is the real window, not a guess.
    return overlapWindow(
      a.scheduledStart,
      a.scheduledEnd,
      b.scheduledStart,
      b.scheduledEnd,
      truckHoldHours(a, fallbackHours),
      truckHoldHours(b, fallbackHours),
    )
      ? 'time_overlap'
      : null
  }
  // At least one side has unknown times: compare the ET calendar days each side
  // occupies. Both sides go through the same etDayKey conversion, so a
  // uniformly-stored date-only value compares consistently with its siblings.
  const aDays = truckOccupiedEtDays(a, fallbackHours)
  const bDays = truckOccupiedEtDays(b, fallbackHours)
  if (aDays.length === 0 || bDays.length === 0) return null
  return aDays.some((d) => bDays.includes(d)) ? 'same_day_unknown_times' : null
}

/**
 * All bookings in `bookings` that would collide with assigning `query.truckId`
 * over [start, end]. Only TRUCK_HOLD_STATUSES occupy a truck — which now
 * includes the unpaid/unapproved holds the default `stripe_link` create makes
 * (R2-2); `excludeBookingId` lets an edit flow skip the booking being edited.
 * No truckId or no start → nothing to check → no conflicts.
 */
export function findTruckConflictsIn(
  bookings: TruckBookingShape[],
  query: {
    truckId: string | null | undefined
    start: Date | null
    end?: Date | null
    excludeBookingId?: string | null
    /** The booking being CREATED / edited states its own length too (P0-A), so
     *  an open-ended query window is as long as that job — not a flat 6h. */
    estimatedHours?: number | null
  },
  fallbackHours: number = TRUCK_FALLBACK_HOURS,
): TruckConflict[] {
  if (!query.truckId || !query.start) return []
  const q = {
    scheduledStart: query.start,
    scheduledEnd: query.end ?? null,
    confirmedDate: null,
    estimatedHours: query.estimatedHours ?? null,
  }
  const out: TruckConflict[] = []
  for (const b of bookings) {
    if (b.truckId !== query.truckId) continue
    if (query.excludeBookingId && b.id === query.excludeBookingId) continue
    if (!holdsTruck(b.status)) continue
    const reason = truckConflictBetween(q, b, fallbackHours)
    if (reason) out.push({ booking: b, reason, hold: holdKindOf(b.status) })
  }
  return out
}

// ── The candidate query (R2-2) ───────────────────────────────────────────────
//
// The status filter is where the guarantee was actually lost: the lock and the
// re-check were correct, but they only ever saw CONFIRMED/SCHEDULED/IN_PROGRESS
// rows while the default create wrote `truckId` on a PENDING_PAYMENT row. The
// `where` is built HERE, next to TRUCK_HOLD_STATUSES and offline-testable, so
// the pre-check, the locked re-check and any future caller cannot drift apart
// or quietly re-narrow the list.

/** Prisma `select` for conflict candidates — the columns the pure shapes need.
 *
 *  `estimatedHours` (P0-A) is how a row with no stored scheduledEnd states its
 *  real length. It is a BASELINE column (no migration under prisma/migrations
 *  creates `estimated_hours`; APPROVAL_BOOKING_SELECT already reads it on the
 *  same principle), so naming it here adds no P2022 exposure during the
 *  code-before-SQL window. `startTimeKnown` deliberately stays OUT: that one IS
 *  migration-gated (20260812010000) and a P2022 in this read is swallowed by
 *  the caller as "no candidates", i.e. it would silently DISABLE the guard. */
export const TRUCK_CANDIDATE_SELECT = {
  id: true,
  displayId: true,
  truckId: true,
  scheduledStart: true,
  scheduledEnd: true,
  confirmedDate: true,
  requestedDate: true,
  status: true,
  estimatedHours: true,
} as const

/** Rows a conflict check must consider for `truckId` around `day`.
 *
 *  The window is the ET day ±1 so an overnight job on either side is still
 *  seen (the 6h fallback hold can cross midnight). Statuses are
 *  TRUCK_HOLD_STATUSES — live jobs AND unpaid/unapproved holds. Internal test
 *  bookings never hold a real truck. */
export function truckCandidateWhere(truckId: string, day: { start: Date; end: Date }) {
  const from = new Date(day.start.getTime() - DAY_MS)
  const to = new Date(day.end.getTime() + DAY_MS)
  return {
    truckId,
    isInternalTest: false,
    status: { in: [...TRUCK_HOLD_STATUSES] },
    // The effective move date: scheduledStart → confirmedDate → requestedDate
    // (the same coalescing scheduling.moveDateInRange uses), so a day-level
    // booking that has no start time is still a candidate.
    OR: [
      { scheduledStart: { gte: from, lte: to } },
      { scheduledStart: null, confirmedDate: { gte: from, lte: to } },
      { scheduledStart: null, confirmedDate: null, requestedDate: { gte: from, lte: to } },
    ],
  }
}

/** Prisma rows → the pure conflict shape. Date-only rows fall back through the
 *  same chain the schedule uses (confirmedDate, else requestedDate). */
export function toTruckBookingShapes(
  rows: Array<{
    id: string
    displayId?: string | null
    truckId: string | null
    scheduledStart: Date | null
    scheduledEnd: Date | null
    confirmedDate: Date | null
    requestedDate?: Date | null
    status: string
    estimatedHours?: number | null
  }>,
): TruckBookingShape[] {
  return rows.map((b) => ({
    id: b.id,
    displayId: b.displayId ?? null,
    truckId: b.truckId,
    scheduledStart: b.scheduledStart,
    scheduledEnd: b.scheduledEnd,
    confirmedDate: b.confirmedDate ?? b.requestedDate ?? null,
    status: b.status,
    // P0-A: carried, not dropped. A caller whose `select` omitted the column
    // gets null here, which truckHoldHours reads as "no better data" — the
    // pre-P0-A fallback behaviour, never a fabricated length.
    estimatedHours: b.estimatedHours ?? null,
  }))
}
