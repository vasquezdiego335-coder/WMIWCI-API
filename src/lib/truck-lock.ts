// ============================================================================
// truck-lock.ts — truck double-booking under CONCURRENCY
// (Moving OS correctness pass item 9, owner spec 2026-08-12;
//  R2-2 default-path + cross-midnight fix, same day).
//
// PROBLEM: Phase 1 checked truck conflicts BEFORE the booking transaction. A
// read proves nothing about what commits next: two near-simultaneous creates
// could both pass the check and both commit — one truck, two jobs, same day.
//
// THE FIX, in the shape src/lib/scan-lock.ts already uses for the Action
// Center scan:
//   1. INSIDE the booking transaction, take a Postgres transaction advisory
//      lock — pg_advisory_xact_lock(bigint) — keyed on (truck, ET calendar
//      day). It is transaction-scoped, so COMMIT, ROLLBACK or a crashed
//      connection all release it; nothing can wedge a truck.
//   2. RE-RUN the conflict query while holding the lock. A booking that
//      committed between the fast pre-check and now is visible here, because
//      the loser of the race cannot enter this section until the winner's
//      transaction has ended.
//   3. Conflicts + no explicit override → throw TruckDoubleBookedError, which
//      rolls the entire create back (nothing is written) and the route maps to
//      the SAME 409 body the pre-check returns.
//
// The pre-transaction check STAYS as the fast, friendly path for the UI: it
// answers instantly with the conflicting bookings and writes nothing. This
// module is the backstop that makes the answer true under concurrency.
//
// ── R2-2: THE LOCK WAS GUARDING AN EMPTY ROOM ───────────────────────────────
// The lock and the re-check were correct, and still the guarantee was vacuous:
// the candidate query filtered to CONFIRMED/SCHEDULED/IN_PROGRESS while the
// DEFAULT `stripe_link` create writes `truckId` on a PENDING_PAYMENT row. Two
// creates — racing or minutes apart — both took the truck. The status list now
// lives in ONE place (truck-conflicts.TRUCK_HOLD_STATUSES) and includes the
// unpaid/unapproved holds, and the candidate `where` is built by
// truck-conflicts.truckCandidateWhere so no caller can re-narrow it.
//
// LOCK SCOPE — why (truck, ET day): the key is derived from the truck id and
// the move's America/New_York calendar day, so two creates only ever wait on
// each other when they could ACTUALLY double-book the same truck on the same
// day. Different trucks, or the same truck on different days, never serialize.
// The lock is held for the REMAINDER of the booking transaction (the re-check
// query plus a few hundred ms of writes), so the loser of a race waits well
// inside the interactive-transaction timeout the route sets explicitly.
//
// CROSS-MIDNIGHT (R2-2 fix 4): an evening job whose window (its estimated
// length + the travel buffer, floored at the 6h fallback — see P0-A in
// truck-conflicts.ts) runs past midnight ET occupies TWO ET days, so it takes BOTH day
// locks — always in ASCENDING KEY ORDER. A global order is what makes deadlock
// impossible: two transactions that both want {D, D+1} request them in the
// same sequence, so one simply waits instead of each holding what the other
// needs. Same-day bookings still take exactly one lock, so nothing extra
// serializes.
//
// PURE-ish: the only DB surface used here is `$queryRaw` (structurally typed),
// and the candidate rows arrive through a caller-supplied loader — so the
// whole guard is testable offline with a fake transaction.
// ============================================================================

import { findAdminTruckConflicts } from './admin-booking'
import {
  etDayKey,
  etDayLabel,
  etDaysCovered,
  truckBookingBasis,
  truckHoldEndInstant,
  truckHoldHours,
  type TruckBookingShape,
  type TruckConflict,
} from './truck-conflicts'

// ── The 409 contract (shared by the pre-check and the locked re-check) ───────

/** What the owner can DO about it — appended to every refusal so the copy is
 *  identical whichever check refused. */
export const TRUCK_CONFLICT_ACTION =
  'Pick another truck, or set truckConflictOverride to double-book deliberately.'

/** Baseline refusal: the truck is on a CONFIRMED job. A promise to a customer,
 *  so the copy is firm. */
export const TRUCK_CONFLICT_MESSAGE = `Truck is already booked in this window. ${TRUCK_CONFLICT_ACTION}`

/** Refusal when every clash is an unpaid / unapproved hold (R2-2 fix 2). Still
 *  a refusal — the truck IS held — but the owner is told WHAT it is held by,
 *  because overriding an unpaid hold is a legitimate call to make on the phone
 *  and overriding a confirmed job is not. */
export const TRUCK_PENDING_CONFLICT_MESSAGE = `Truck is held by an unpaid booking. ${TRUCK_CONFLICT_ACTION}`

/** How a clashing booking is named to the owner: its WMIC reference when the
 *  row has one, else the internal id (never blank). */
function conflictLabel(b: TruckBookingShape): string {
  return b.displayId?.trim() || b.id
}

/**
 * THE refusal message. Distinguishes an unpaid HOLD from a confirmed JOB and
 * names the booking(s) + ET day so the owner can go look at it, e.g.
 *   "Truck 1 is held by an unpaid booking (WMIC-1042) on Aug 15 — not paid or
 *    approved yet. Pick another truck, or set truckConflictOverride…"
 */
export function truckConflictMessage(
  conflicts: TruckConflict[],
  opts: { truckLabel?: string | null } = {},
): string {
  if (conflicts.length === 0) return TRUCK_CONFLICT_MESSAGE
  const subject = opts.truckLabel?.trim() || 'This truck'
  const names = conflicts.map((c) => conflictLabel(c.booking)).join(', ')
  const days = Array.from(
    new Set(
      conflicts
        .map((c) => truckBookingBasis(c.booking))
        .filter((d): d is Date => !!d)
        .map((d) => etDayLabel(d)),
    ),
  ).join(', ')
  const on = days ? ` on ${days}` : ''
  // P0-A: a hold is now as long as the job, so an evening booking legitimately
  // blocks the following morning — and naming only the clashing job's OWN day
  // leaves the owner reading "held on Aug 15" while booking Aug 16. Say where
  // the window actually ends, but ONLY when it ends on a different ET day, so
  // an ordinary same-day refusal keeps the exact wording it has today.
  const spillDays = Array.from(
    new Set(
      conflicts
        .map((c) => {
          const basis = truckBookingBasis(c.booking)
          const end = truckHoldEndInstant(c.booking)
          if (!basis || !end) return null
          // Half-open [start, end): the LAST OCCUPIED instant decides the day.
          const lastOccupied = new Date(end.getTime() - 1)
          return etDayKey(lastOccupied) === etDayKey(basis) ? null : etDayLabel(lastOccupied)
        })
        .filter((d): d is string => !!d),
    ),
  ).join(', ')
  const spill = spillDays ? `, running into ${spillDays}` : ''
  const allPending = conflicts.every((c) => c.hold === 'pending')
  return allPending
    ? `${subject} is held by an unpaid booking (${names})${on}${spill} — not paid or approved yet. ${TRUCK_CONFLICT_ACTION}`
    : `${subject} is already booked (${names})${on}${spill}. ${TRUCK_CONFLICT_ACTION}`
}

/** Thrown INSIDE the booking transaction when the locked re-check finds a
 *  conflict the pre-check could not see (a booking committed in between).
 *  Throwing rolls the whole create back — customer, booking, inventory, job,
 *  audits — and the route maps it to the same 409 the pre-check returns. */
export class TruckDoubleBookedError extends Error {
  readonly status = 409
  readonly conflicts: TruckConflict[]
  readonly truckLabel: string | null
  constructor(conflicts: TruckConflict[], truckLabel: string | null = null) {
    super(truckConflictMessage(conflicts, { truckLabel }))
    this.name = 'TruckDoubleBookedError'
    this.conflicts = conflicts
    this.truckLabel = truckLabel
  }
}

/** The 409 response body for a truck clash. ONE builder, so the pre-check and
 *  the locked re-check are byte-identical to the client. `hold` tells the
 *  workspace whether it is arguing with an unpaid hold or a confirmed job. */
export function truckConflictResponseBody(
  conflicts: TruckConflict[],
  opts: { truckLabel?: string | null } = {},
): {
  error: string
  conflicts: Array<{ bookingId: string; displayId: string | null; reason: string; hold: string }>
} {
  return {
    error: truckConflictMessage(conflicts, opts),
    conflicts: conflicts.map((c) => ({
      bookingId: c.booking.id,
      displayId: c.booking.displayId ?? null,
      reason: c.reason,
      hold: c.hold,
    })),
  }
}

// ── Lock key derivation ──────────────────────────────────────────────────────

/** Namespace prefix so this key space can never collide with SCAN_LOCK_KEY or
 *  any future advisory lock in the app. */
export const TRUCK_LOCK_NAMESPACE = 'moving-os:truck-day'

const FNV_OFFSET_BASIS = BigInt('14695981039346656037')
const FNV_PRIME = BigInt('1099511628211')
const TWO_64 = BigInt('18446744073709551616')
const TWO_63 = BigInt('9223372036854775808')
const MASK_64 = TWO_64 - BigInt(1)

/** FNV-1a over the UTF-8 bytes, 64-bit. Deterministic across processes and
 *  Node versions (no crypto, no locale, no Math.random) — two web containers
 *  MUST derive the same key or the lock is useless. */
function fnv1a64(text: string): bigint {
  const bytes = new TextEncoder().encode(text)
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ BigInt(bytes[i])) & MASK_64
    hash = (hash * FNV_PRIME) & MASK_64
  }
  return hash
}

/** The human-readable scope a lock key is derived from: `<ns>:<truck>:<ET day>`.
 *  Exported so the derivation is inspectable (and testable) rather than magic. */
export function truckDayLockScope(truckId: string, day: Date | string): string {
  const dayKey = typeof day === 'string' ? day : etDayKey(day)
  return `${TRUCK_LOCK_NAMESPACE}:${truckId}:${dayKey}`
}

/**
 * The advisory-lock key for (truck, ET calendar day).
 *
 * Derivation: FNV-1a 64 over `moving-os:truck-day:<truckId>:<YYYY-MM-DD ET>`,
 * folded into the SIGNED int64 range Postgres' `pg_advisory_xact_lock(bigint)`
 * accepts (values >= 2^63 wrap to negative, exactly as int8 does).
 *
 * Any instant inside the same America/New_York day yields the SAME key — a
 * 6 AM create and an 8 PM create for the same truck on the same day contend,
 * and DST never shifts a booking into a neighbouring lock because the day is
 * computed with the same `etDayKey` the conflict rules use.
 */
export function truckDayLockKey(truckId: string, day: Date | string): bigint {
  const unsigned = fnv1a64(truckDayLockScope(truckId, day))
  // int8 is signed: fold the top half of the unsigned range to negatives.
  return unsigned >= TWO_63 ? unsigned - TWO_64 : unsigned
}

/**
 * Every ET calendar day a booking's truck window touches, as 'YYYY-MM-DD'.
 *
 *  • Day-level booking (no start time) → just the move day; the conflict rules
 *    already hold that WHOLE day conservatively.
 *  • Timed booking → the start day, plus each further day the window reaches.
 *    The end is the LATER of `scheduledEnd` and the derived hold
 *    (truck-conflicts.truckHoldHours: the job's own estimate + the house travel
 *    buffer, floored at TRUCK_FALLBACK_HOURS).
 *
 * The day walk itself is `truck-conflicts.etDaysCovered` (R3-4): detection and
 * locking derive a booking's day span from ONE function, so they cannot drift
 * apart the way they did for basis-only rows. Half-open [start, end): a window
 * ending exactly at 00:00 ET does NOT reach into the next day.
 *
 * ── P0-A: WHY THE LATER OF THE TWO ──────────────────────────────────────────
 * The lock is taken from the create's IN-MEMORY schedule, which carries
 * scheduledEnd on every deposit mode; DETECTION of the same row afterwards
 * reads the persisted columns, which on the default `stripe_link` path are
 * requestedDate + estimatedHours alone and yield the DERIVED hold. Taking the
 * later of the two makes the locked span a superset of the detected one for
 * both shapes — the lock can never serialize a narrower window than the check
 * can find a conflict in — and on the default path they are exactly equal,
 * because both then come from truckHoldHours. (Before P0-A a 20:00 studio
 * locked one ET day while its stored row was detected over two.)
 */
export function truckWindowDayKeys(opts: {
  moveDay: Date | null
  scheduledStart: Date | null
  scheduledEnd?: Date | null
  /** Booking.estimatedHours — the same input detection reads off the row. */
  estimatedHours?: number | null
  fallbackHours?: number
}): string[] {
  const days = new Set<string>()
  if (opts.moveDay) days.add(etDayKey(opts.moveDay))
  const hold = truckHoldHours({ estimatedHours: opts.estimatedHours ?? null }, opts.fallbackHours)
  // A day-level booking walks from its 00:00 ET anchor, exactly as detection
  // does for the stored row (truckOccupiedEtDays falls back to the basis). With
  // any real estimate that is still just the move day — a 00:00 anchor plus the
  // assistant's 12h ceiling and the buffer ends at 13:00 — so this changes no
  // reachable answer; it means the lock cannot be narrower than detection even
  // for a data-error estimate.
  const from = opts.scheduledStart ?? opts.moveDay
  if (from) {
    const derivedEndMs = from.getTime() + hold * 3_600_000
    // A stored end belongs to a stored START; it is never measured from a day
    // anchor (that is what invented 12:00 AM schedules in round 2).
    const end =
      opts.scheduledStart && opts.scheduledEnd && opts.scheduledEnd.getTime() > derivedEndMs ? opts.scheduledEnd : null
    for (const day of etDaysCovered(from, end, hold)) {
      days.add(day)
    }
  }
  return Array.from(days).sort()
}

/**
 * The advisory-lock keys this booking must hold, in ASCENDING KEY ORDER.
 *
 * The order is the deadlock proof: every transaction in the system requests
 * (truck, day) locks smallest key first, so two creates that both want the same
 * pair can never hold half of each other's set. Sorting on the KEY (not the day
 * string) is what makes the order global — different trucks interleave too.
 */
export function truckDayLockKeys(opts: {
  truckId: string
  moveDay: Date | null
  scheduledStart: Date | null
  scheduledEnd?: Date | null
  estimatedHours?: number | null
  fallbackHours?: number
}): bigint[] {
  const keys = truckWindowDayKeys(opts).map((day) => truckDayLockKey(opts.truckId, day))
  const unique = Array.from(new Set(keys.map((k) => k.toString()))).map((s) => BigInt(s))
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ── The in-transaction guard ─────────────────────────────────────────────────

/** The minimal transaction surface this guard needs. Structural (house
 *  pattern, cf. StaffingTx in staffing-plan.ts): the real Prisma `tx`
 *  satisfies it and an offline fake can too. */
export type TruckLockTx = {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
}

export interface TruckLockOptions {
  truckId: string
  /** The move's day anchor (the booking's requestedDate — an ET instant). */
  moveDay: Date
  scheduledStart: Date | null
  scheduledEnd: Date | null
  /** The assistant's estimated hours for THIS booking (P0-A). Drives both the
   *  day span that gets locked and the window the re-check compares, so a long
   *  job holds its truck for as long as it actually runs. Absent → the flat
   *  fallback, exactly as before. */
  estimatedHours?: number | null
  /** The owner's explicit, audited decision to double-book anyway. */
  override: boolean
  /** The truck's name, for the refusal copy. Optional — the guard works
   *  without it, the message just says "This truck". */
  truckLabel?: string | null
  /** Loads the live candidate bookings for this truck INSIDE the transaction.
   *  Supplied by the caller so this module never imports the Prisma runtime
   *  (and so the guard is testable with fakes). */
  loadCandidates: () => Promise<TruckBookingShape[]>
}

/**
 * Take the (truck, ET day) advisory lock(s) and re-run the conflict check under
 * them. Returns the conflicts found (empty when the truck is free); THROWS
 * TruckDoubleBookedError when there are conflicts and the owner did not
 * explicitly override — which aborts the caller's transaction.
 *
 * A returned non-empty array therefore means "conflicts existed AND the owner
 * overrode them" — the caller records that on the audit log.
 *
 * ORDER MATTERS TWICE:
 *   • locks BEFORE the read — reading first would re-open the exact race this
 *     exists to close;
 *   • ascending key order across a multi-day window — see truckDayLockKeys.
 */
export async function assertTruckFreeUnderLock(
  tx: TruckLockTx,
  opts: TruckLockOptions,
): Promise<TruckConflict[]> {
  const keys = truckDayLockKeys({
    truckId: opts.truckId,
    moveDay: opts.moveDay,
    scheduledStart: opts.scheduledStart,
    scheduledEnd: opts.scheduledEnd,
    estimatedHours: opts.estimatedHours ?? null,
  })
  // Transaction-scoped: released on COMMIT/ROLLBACK, so a failed booking can
  // never leave a truck locked. Prisma binds the bigint as int8.
  for (const key of keys) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key})`
  }

  const candidates = await opts.loadCandidates()
  const conflicts = findAdminTruckConflicts(candidates, {
    truckId: opts.truckId,
    scheduledStart: opts.scheduledStart,
    scheduledEnd: opts.scheduledEnd,
    moveDay: opts.moveDay,
    estimatedHours: opts.estimatedHours ?? null,
  })
  if (conflicts.length > 0 && !opts.override) {
    throw new TruckDoubleBookedError(conflicts, opts.truckLabel ?? null)
  }
  return conflicts
}
