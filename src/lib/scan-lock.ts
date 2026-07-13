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

/** Sanitize a scan error into a short, secret-free summary for the ScanRun row
 *  and the UI. Never store stack traces, tokens, or raw payloads. */
export function sanitizeScanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').slice(0, 300)
}
