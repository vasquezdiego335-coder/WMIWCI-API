// ============================================================================
// Deterministic reminder severity + fingerprint (increment 2.1). All thresholds
// are named constants here — no magic numbers scattered in the rules. Pure +
// offline-tested at exact time boundaries (reminder-severity.test.ts).
// ============================================================================

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

// Lead-time tiers: if the move is at or under `withinDays` away, use `severity`.
// Evaluated most-urgent first; the first match wins. A move already in the past
// or with no date falls through to `fallback`.
export interface SeverityTier {
  withinDays: number
  severity: Severity
}

/** Days from `now` until `target` (can be negative if past). */
export function daysUntil(target: Date | null, now: Date): number | null {
  if (!target) return null
  return (target.getTime() - now.getTime()) / DAY_MS
}

/** Pick a severity by how soon the move is. Boundaries are INCLUSIVE of the
 *  tighter tier: exactly 1.0 day out with a `<= 1` tier hits that tier. */
export function severityByLeadTime(target: Date | null, now: Date, tiers: SeverityTier[], fallback: Severity): Severity {
  const d = daysUntil(target, now)
  if (d == null || d < 0) return fallback
  for (const t of [...tiers].sort((a, b) => a.withinDays - b.withinDays)) {
    if (d <= t.withinDays) return t.severity
  }
  return fallback
}

// ── Named tiers used by the rules ────────────────────────────────────────────

// Address verification / unverified: <24h CRITICAL, 1-3d HIGH, else MEDIUM.
export const ADDRESS_TIERS: SeverityTier[] = [
  { withinDays: 1, severity: 'CRITICAL' },
  { withinDays: 3, severity: 'HIGH' },
]
export const ADDRESS_FALLBACK: Severity = 'MEDIUM'

// Missing crew: <24h CRITICAL, 1-3d HIGH, else MEDIUM.
export const CREW_TIERS: SeverityTier[] = [
  { withinDays: 1, severity: 'CRITICAL' },
  { withinDays: 3, severity: 'HIGH' },
]
export const CREW_FALLBACK: Severity = 'MEDIUM'

// Missing pickup/drop-off address: <=3d out is CRITICAL, else HIGH (a job with no
// address is worse than an unverified one, so the floor is HIGH not MEDIUM).
export const MISSING_ADDRESS_TIERS: SeverityTier[] = [{ withinDays: 3, severity: 'CRITICAL' }]
export const MISSING_ADDRESS_FALLBACK: Severity = 'HIGH'

// ── Financial exposure severity (completed job with an unpaid balance) ──
export const BALANCE_HIGH_CENTS = 25_000 // $250+ owed is HIGH regardless of age
export const BALANCE_OVERDUE_DAYS = 7 // 7+ days after completion escalates

export function unpaidBalanceSeverity(balanceCents: number, daysSinceCompleted: number): Severity {
  if (balanceCents >= BALANCE_HIGH_CENTS || daysSinceCompleted >= BALANCE_OVERDUE_DAYS) return 'HIGH'
  if (balanceCents > 0) return 'MEDIUM'
  return 'LOW'
}

// Negative-profit severity by magnitude of the loss.
export const LOSS_HIGH_CENTS = 10_000 // losing $100+ is HIGH

export function negativeProfitSeverity(netProfitCents: number): Severity {
  return netProfitCents <= -LOSS_HIGH_CENTS ? 'HIGH' : 'MEDIUM'
}

// ── Deterministic fingerprint (FNV-1a over the material fields) ──────────────
// Two reminders with the same fingerprint describe the same underlying state.
// A dismissal (OCCURRENCE / UNTIL_ENTITY_CHANGES) reopens when this changes,
// because the description embeds the concrete values (amounts, dates, names).

export function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function computeFingerprint(parts: { reminderType: string; severity: string; dueAt: Date | null; description: string }): string {
  return fnv1a(`${parts.reminderType}|${parts.severity}|${parts.dueAt?.getTime() ?? 'none'}|${parts.description}`)
}

// ── Severity ordering for sorting (0 = most urgent) ──
export const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
