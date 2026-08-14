// ============================================================================
// Scan concurrency + cooldown (increment 2.1). The DB orchestration lives in
// reminder-sync.ts; the DECISION logic is pure here so it is offline-testable.
//
// Two guards:
//  1. Postgres transaction advisory lock (SCAN_LOCK_KEY) makes the "is a scan
//     running? if not, claim one" check atomic across web + worker processes
//     and Railway restarts — an in-memory flag is NOT enough (multiple
//     containers). The lock is transaction-scoped, so a crash releases it.
//  2. A ScanRun lease row is the durable signal the UI reads. A RUNNING row
//     older than SCAN_STALE_MS is treated as a crashed scan and superseded.
// ============================================================================

// Arbitrary constant advisory-lock key (namespaced to the Action Center scan).
// BigInt() form (not the `n` literal) keeps the current TS target happy while
// still binding as a Postgres int8 for pg_advisory_xact_lock.
export const SCAN_LOCK_KEY = BigInt(92607131)

export const SCAN_STALE_MS = 5 * 60_000 // a RUNNING scan older than this = crashed
export const SCAN_COOLDOWN_MS = 3 * 60_000 // manual/page scans no more than once per this

export type ClaimTrigger = 'MANUAL' | 'SCHEDULED' | 'API' | 'PAGE_LOAD'

/** A RUNNING scan row is "live" only if it started within the stale window. */
export function isScanLive(startedAt: Date, now: Date, staleMs = SCAN_STALE_MS): boolean {
  return now.getTime() - startedAt.getTime() < staleMs
}

/** True when a fresh scan happened too recently to run another automatic one.
 *  Manual owner-forced scans bypass this (handled by the caller). */
export function withinCooldown(lastStartedAt: Date | null, now: Date, cooldownMs = SCAN_COOLDOWN_MS): boolean {
  if (!lastStartedAt) return false
  return now.getTime() - lastStartedAt.getTime() < cooldownMs
}

export type ClaimDecision =
  | { proceed: true }
  | { proceed: false; reason: 'already_running' | 'cooldown' }

/** Pure claim decision given the current state. `force` (owner manual rescan)
 *  bypasses cooldown but never bypasses an already-running scan. */
export function decideClaim(
  input: { liveRunningExists: boolean; lastScanStartedAt: Date | null; trigger: ClaimTrigger; force: boolean },
  now: Date,
): ClaimDecision {
  if (input.liveRunningExists) return { proceed: false, reason: 'already_running' }
  // Scheduled scans always respect cooldown; manual with force bypasses it.
  const enforceCooldown = !input.force
  if (enforceCooldown && withinCooldown(input.lastScanStartedAt, now)) return { proceed: false, reason: 'cooldown' }
  return { proceed: true }
}

// ── WHAT A SCAN ACTUALLY LOADS (R3-3) ───────────────────────────────────────
//
// The one list of booking statuses `reminder-sync.performSync` evaluates. It
// lives HERE, not next to the query, because two things must agree about it and
// only one of them may import the DB module:
//   • the loader builds its `where` from it (reminder-sync.ts), and
//   • the kick report may only claim a booking is covered when that booking's
//     status is in it (describeScanOutcome below).
// Round 2 hard-coded the list in the query and put an unconditional "this
// booking is included" in the success copy — and the default `stripe_link`
// booking is PENDING_PAYMENT, which the query did not load. The claim was false
// on essentially every default-path create. One constant, consumed by both, is
// what makes the STATUS half of the sentence checkable instead of aspirational
// — P0-B added the other half (`isInternalTest`) in scanCoversBooking below,
// because the loader filters on that too and this comment used to imply the
// constant was the whole predicate.
//
// PENDING_PAYMENT is in the list as of R3-3: an unpaid hold already holds a
// truck (truck-conflicts.TRUCK_HOLD_STATUSES), so the truck-double-booked rule
// has to see it. COMPLETED bookings are ALSO scanned by performSync, but only
// within a recency window, so they are deliberately not claimable here — a
// status-only test cannot know whether a given completed row is recent enough.
export const SCANNED_BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'SCHEDULED',
  'IN_PROGRESS',
] as const

/** Is a booking in this status evaluated by every scan? Unknown/absent status
 *  → false: the honest default is to make no coverage claim at all.
 *
 *  STATUS IS ONLY HALF THE LOADER (P0-B). performSync's where clause is
 *  `isInternalTest: false AND (status in SCANNED_BOOKING_STATUSES OR recent
 *  COMPLETED)` — see scanCoversBooking below for the whole predicate. This
 *  half is exported on its own because the truck-hold invariant ("every status
 *  that can hold a truck is a status the scan loads") is a question about
 *  statuses and nothing else. */
export function scanCoversBookingStatus(status: string | null | undefined): boolean {
  return !!status && (SCANNED_BOOKING_STATUSES as readonly string[]).includes(status)
}

/** The booking facts the loader filters on. Both are required to make a
 *  coverage claim, because the loader tests both. */
export interface ScanCoverageInput {
  status?: string | null
  /** `Booking.isInternalTest`. performSync loads `isInternalTest: false` ONLY
   *  (reminder-sync.ts), so an owner checkout-test row is never in the scan
   *  whatever its status. */
  isInternalTest?: boolean | null
}

/** THE coverage predicate — the full loader `where`, not just its status half.
 *
 *  P0-B: `scanCoversBookingStatus` modelled only the OR-branch of performSync's
 *  filter while the comment above it claimed the constant is "what makes the
 *  sentence checkable". It is half of what makes it checkable. Nothing routes
 *  an internal-test booking through a scan kick today (POST /api/admin/bookings
 *  never writes the flag; /api/admin/test-booking writes `isInternalTest: true`
 *  but kicks no scan), so this closes the gap BEFORE it opens rather than after.
 *
 *  Absent flag → the status decides, because the column is a non-nullable
 *  `@default(false)`: "the caller did not mention it" is not "unknown". A
 *  caller that CAN read the committed row passes it (the admin create does). */
export function scanCoversBooking(b: ScanCoverageInput): boolean {
  if (b.isInternalTest === true) return false
  return scanCoversBookingStatus(b.status)
}

// ── THE LOADER SHAPE THIS PREDICATE MODELS (H2) ──────────────────────────────
//
// scanCoversBooking is an EQUIVALENCE claim about performSync's booking query:
// "a row with these facts is one that scan loaded". Round 4 guarded it by
// PRESENCE — a regex checking the query still mentions `isInternalTest` and
// still spreads SCANNED_BOOKING_STATUSES. A presence check cannot see a filter
// that was ADDED, so the predicate starts over-claiming in silence: dropping
// `manualReviewRequired: false` into the loader's `where` kept the whole suite
// green while the Book Move panel went on telling the owner those rows were
// included. That is not a contrived mutation — `buildBookingCreateData` sets
// `manualReviewRequired: true` for a default-path booking carrying a piano,
// i.e. exactly the jobs the owner most needs on the list.
//
// These three constants are the loader as the predicate understands it.
// `action-center-kick.test.ts` PARSES the query in reminder-sync.ts and fails
// when the source and these disagree in EITHER direction — an added filter, a
// removed one, a shrunken cap, a dropped order. Adding a filter therefore
// cannot be merged without editing this file, three lines from the predicate,
// and deciding in the same commit what the coverage claim now means.

/** Top-level keys allowed in performSync's booking `where`. Every one of them
 *  is modelled above: `isInternalTest` by the early return, `OR` by
 *  scanCoversBookingStatus. A key that is not here is a filter the predicate
 *  does not know about — do not add it here without modelling it. */
export const SCAN_LOADER_WHERE_KEYS = ['isInternalTest', 'OR'] as const

/** Keys allowed INSIDE an `OR` branch. A branch narrowed by a fourth fact
 *  (`{ status: {...}, manualReviewRequired: false }`) shrinks the loaded set
 *  just as effectively as a top-level filter, so the branches are parsed too. */
export const SCAN_LOADER_OR_KEYS = ['status', 'updatedAt'] as const

/** The loader's row cap, pinned so the claim and the query cannot drift.
 *
 *  The predicate models NO row cap: it answers "does the scan load this row?"
 *  from status alone. That is only true while TWO things hold — the cap sits
 *  far above the live operational set, and the query is ordered
 *  most-recently-touched first so the row a kick is reporting on (the newest
 *  one) can never be the row truncation drops. At `take: 5` both halves
 *  collapse and the claim becomes a guess, which is why the guard pins the
 *  number instead of merely noticing that some `take` exists. */
export const SCAN_LOADER_TAKE = 500

// ── Kicking a scan from another flow (correctness pass item 7) ───────────────
//
// A flow that KICKS a scan (the admin Book Move create) must report what
// actually happened instead of claiming success. runScan() has exactly three
// real endings — it ran, it was blocked (cooldown / already running), or it
// threw — plus the caller's own "I stopped waiting" timeout. This mapper is
// the ONE place those endings become the response contract; it invents no
// states of its own.
//
// ROUND 2 (R2-6) — WHAT THE MESSAGES MAY CLAIM. The mechanism was honest but
// the copy was not: a skip said "one ran moments ago, so the list is already
// current", which is provably FALSE for the booking that just triggered the
// kick — that earlier scan ran BEFORE this booking committed, so the booking
// it is reassuring the owner about is exactly the one missing from the list.
// Booking two jobs back to back showed a green "already current" line while
// job #2 was absent. The rule now:
//
//   • The CALLER kicks after its own write has committed, so a scan that
//     actually RAN evaluated that write — PROVIDED the scan looks at rows in
//     that booking's status at all. R3-3: round 2 made the skips honest and
//     then put the same unverifiable claim in the SUCCESS message, where
//     `force: true` made it the normal ending. `ran` alone is not enough;
//     the claim is now conditioned on scanCoversBookingStatus, and a caller
//     that does not say which status it wrote gets the claimless wording.
//   • A scan that did NOT run (cooldown, or one already in flight that
//     started at an unknown moment) tells the owner the booking MAY not be on
//     the list yet, and how to refresh. We never claim someone else's scan
//     covers our row.
//   • A scan that outlived the caller's wait is STILL RUNNING server-side.
//     The copy says that rather than "did not run" — the caller reports it as
//     unconfirmed (see ScanKickReason 'timeout'), not as a dead scan.

export type ScanKickState = 'completed' | 'skipped_cooldown' | 'failed'

/** The REAL ending, kept alongside the coarse state so nothing is glossed
 *  over: 'already_running' is a skip, not a cooldown, even though both mean
 *  "no scan of mine ran and that is fine". */
export type ScanKickReason = 'ran' | 'cooldown' | 'already_running' | 'timeout' | 'error' | 'unknown'

export interface ScanKickReport {
  state: ScanKickState
  reason: ScanKickReason
  /** Owner-facing sentence. Every `failed` variant tells them what to do. */
  message: string
}

/** The structural shape of runScan()'s outcome. Declared here (not imported)
 *  because scan-lock.ts stays free of the DB module. */
export type ScanOutcomeLike = { ran: boolean; reason?: string | null }

export const SCAN_KICK_MESSAGES = {
  // The only claim of coverage we can make, and only when the caller tells us
  // the booking is in a status the scan loads: this scan started after the
  // write, so it read that row.
  ran_included: 'Action Center rescanned — this booking is included in the scan',
  // A scan DID run, but we cannot prove it looked at this particular booking
  // (no status supplied, or a status performSync does not load). Report the
  // scan, promise nothing about the row, and say where to look.
  ran: 'Action Center rescanned — this booking may not be on the list; open the Action Center to see it',
  // Not "the list is already current", and not a flat claim of staleness
  // either — "probably" is the honest strength: the blocking scan is the last
  // COMPLETED one, which all but certainly finished before this write.
  cooldown:
    'Action Center scan skipped — a scan ran moments ago, probably before this booking existed. This booking may not be on the list yet; open the Action Center to refresh',
  // A scan already in flight started at a moment we do not know: usually
  // before this row committed, occasionally after. Either way we cannot
  // promise it read this booking, so we do not.
  already_running:
    'Action Center scan already in progress — it may have started before this booking, so this booking may not appear on that pass; open the Action Center to refresh',
  // The scan is not dead, it is slow. Say that, not "did not run".
  timeout:
    'Action Center scan is still running — it did not finish before this answer; open the Action Center in a moment to see this booking',
  failed: 'Action Center scan did not run — open the Action Center to refresh',
} as const

/**
 * Map a scan kick's ending to the reported outcome. Accepts:
 *  • runScan()'s outcome  → `{ ran: true }` / `{ ran: false, reason }`
 *  • the error it threw   → any Error (or anything unrecognizable)
 *  • the caller's timeout  → `{ timedOut: true }`
 *
 * `opts.bookingStatus` / `opts.bookingIsInternalTest` describe the row the
 * caller just committed. They ONLY ever strengthen the wording of a scan that
 * ran (R3-3) — omit them and the report simply makes no coverage claim.
 *
 * Anything that is NOT a recognized "the scan is fine" ending reports
 * `failed`, because the honest default is to tell the owner to refresh rather
 * than to claim a scan happened.
 */
export function describeScanOutcome(
  input: unknown,
  opts: { bookingStatus?: string | null; bookingIsInternalTest?: boolean | null } = {},
): ScanKickReport {
  if (input instanceof Error) {
    return { state: 'failed', reason: 'error', message: SCAN_KICK_MESSAGES.failed }
  }
  if (input && typeof input === 'object') {
    const o = input as { ran?: unknown; reason?: unknown; timedOut?: unknown }
    if (o.timedOut === true) {
      return { state: 'failed', reason: 'timeout', message: SCAN_KICK_MESSAGES.timeout }
    }
    if (o.ran === true) {
      // The scan ran AFTER this write committed, so it read every row it loads.
      // Whether THIS row is one of them is a question about the loader's own
      // filter — status AND isInternalTest — and only the caller knows that.
      const covered = scanCoversBooking({ status: opts.bookingStatus, isInternalTest: opts.bookingIsInternalTest })
      return {
        state: 'completed',
        reason: 'ran',
        message: covered ? SCAN_KICK_MESSAGES.ran_included : SCAN_KICK_MESSAGES.ran,
      }
    }
    if (o.ran === false) {
      if (o.reason === 'cooldown') {
        return { state: 'skipped_cooldown', reason: 'cooldown', message: SCAN_KICK_MESSAGES.cooldown }
      }
      if (o.reason === 'already_running') {
        return { state: 'skipped_cooldown', reason: 'already_running', message: SCAN_KICK_MESSAGES.already_running }
      }
      // Blocked for a reason this build does not know: do not pretend it was a
      // healthy skip.
      return { state: 'failed', reason: 'unknown', message: SCAN_KICK_MESSAGES.failed }
    }
  }
  return { state: 'failed', reason: 'error', message: SCAN_KICK_MESSAGES.failed }
}

/** Sanitize a scan error into a short, secret-free summary for the ScanRun row
 *  and the UI. Never store stack traces, tokens, or raw payloads. */
export function sanitizeScanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').slice(0, 300)
}
