// ============================================================================
// availability-engine.ts — is a worker available for a given window? (Stage 5)
//
// PURE. No Prisma, no Date-now, no timezone library. The caller resolves a
// job's real times into the worker's LOCAL minutes-from-midnight and passes
// them in; this module only decides. That keeps the precedence logic — the part
// that must never be wrong — unit-testable offline.
//
// THE PRECEDENCE, highest wins (owner spec 2026-07-21):
//   1. administrative hard-unavailable block     → UNAVAILABLE (cannot override)
//   2. date-specific unavailable block           → UNAVAILABLE
//   3. date-specific available override          → AVAILABLE
//   4. recurring weekly availability             → AVAILABLE
//   5. default                                   → UNAVAILABLE
//
// A worker is available for a WINDOW only if the whole window is covered — a
// partial overlap is not availability. "Unavailable by default" is deliberate:
// the system never assumes someone can work a slot nobody said they could.
// ============================================================================

export const MINUTES_IN_DAY = 24 * 60

export interface RecurringRule {
  dayOfWeek: number // 0 = Sunday … 6 = Saturday
  startMinute: number
  endMinute: number
  active?: boolean
  /** 'YYYY-MM-DD' inclusive bound, or null for open-ended. */
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export type ExceptionKind =
  | 'ADMIN_BLOCK'
  | 'UNAVAILABLE_FULL'
  | 'UNAVAILABLE_PARTIAL'
  | 'AVAILABLE_OVERRIDE'
  | 'VACATION'
  | 'LEAVE'

export interface DateException {
  kind: ExceptionKind
  /** 'YYYY-MM-DD' in the worker's local zone. */
  date: string
  startMinute?: number | null
  endMinute?: number | null
  reason?: string | null
}

/** The window being checked, already in the worker's local time. */
export interface QueryWindow {
  /** 'YYYY-MM-DD' local. */
  date: string
  startMinute: number
  endMinute: number
}

export type AvailabilityTier =
  | 'ADMIN_BLOCK'
  | 'DATE_UNAVAILABLE'
  | 'DATE_AVAILABLE_OVERRIDE'
  | 'RECURRING'
  | 'DEFAULT_UNAVAILABLE'

export interface AvailabilityDecision {
  available: boolean
  tier: AvailabilityTier
  reason: string
  /** True only for the administrative block — the one tier a scheduler may not
   *  wave through even with an override. */
  hardBlock: boolean
}

/** Two closed-open intervals overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** [outerStart, outerEnd] fully contains [innerStart, innerEnd]. */
function contains(outerStart: number, outerEnd: number, innerStart: number, innerEnd: number): boolean {
  return outerStart <= innerStart && innerEnd <= outerEnd
}

/** Day of week (0=Sun) for a plain 'YYYY-MM-DD', timezone-independent because a
 *  plain date has no zone. `new Date('YYYY-MM-DD')` parses as UTC midnight, so
 *  getUTCDay is stable regardless of where the server runs. */
export function dayOfWeekOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay()
}

const inEffectiveRange = (r: RecurringRule, date: string): boolean =>
  (!r.effectiveFrom || date >= r.effectiveFrom) && (!r.effectiveTo || date <= r.effectiveTo)

/**
 * Decide availability for one window.
 *
 * `businessBlocked` folds in the company-wide DayBlock so an admin closed-day is
 * the same top-precedence tier as a per-worker ADMIN_BLOCK.
 */
export function evaluateAvailability(i: {
  window: QueryWindow
  rules: RecurringRule[]
  exceptions: DateException[]
  businessBlocked?: boolean
}): AvailabilityDecision {
  const { window: w } = i
  const onDate = i.exceptions.filter((e) => e.date === w.date)

  // 1 — administrative hard-unavailable (per-worker or business-wide).
  if (i.businessBlocked) {
    return { available: false, tier: 'ADMIN_BLOCK', reason: 'The business is closed on this date.', hardBlock: true }
  }
  const adminBlock = onDate.find((e) => e.kind === 'ADMIN_BLOCK')
  if (adminBlock) {
    return { available: false, tier: 'ADMIN_BLOCK', reason: adminBlock.reason || 'Administratively blocked on this date.', hardBlock: true }
  }

  // 2 — date-specific unavailable (full day, leave, vacation, or overlapping partial).
  const fullOff = onDate.find((e) => e.kind === 'UNAVAILABLE_FULL' || e.kind === 'VACATION' || e.kind === 'LEAVE')
  if (fullOff) {
    const label = fullOff.kind === 'VACATION' ? 'on vacation' : fullOff.kind === 'LEAVE' ? 'on leave' : 'unavailable'
    return { available: false, tier: 'DATE_UNAVAILABLE', reason: fullOff.reason || `Marked ${label} on this date.`, hardBlock: false }
  }
  const partialOff = onDate.find(
    (e) => e.kind === 'UNAVAILABLE_PARTIAL' && overlaps(w.startMinute, w.endMinute, e.startMinute ?? 0, e.endMinute ?? MINUTES_IN_DAY),
  )
  if (partialOff) {
    return { available: false, tier: 'DATE_UNAVAILABLE', reason: partialOff.reason || 'Unavailable for part of this date that overlaps the window.', hardBlock: false }
  }

  // 3 — date-specific available override covering the whole window.
  const override = onDate.find(
    (e) => e.kind === 'AVAILABLE_OVERRIDE' && contains(e.startMinute ?? 0, e.endMinute ?? MINUTES_IN_DAY, w.startMinute, w.endMinute),
  )
  if (override) {
    return { available: true, tier: 'DATE_AVAILABLE_OVERRIDE', reason: 'Available by a date-specific override.', hardBlock: false }
  }

  // 4 — recurring weekly availability covering the whole window.
  const dow = dayOfWeekOf(w.date)
  const covering = i.rules.filter(
    (r) => (r.active ?? true) && r.dayOfWeek === dow && inEffectiveRange(r, w.date) && contains(r.startMinute, r.endMinute, w.startMinute, w.endMinute),
  )
  if (covering.length > 0) {
    return { available: true, tier: 'RECURRING', reason: 'Within recurring weekly availability.', hardBlock: false }
  }

  // 5 — default unavailable.
  return { available: false, tier: 'DEFAULT_UNAVAILABLE', reason: 'No availability is configured for this window.', hardBlock: false }
}

// ── Read models for the UI ──────────────────────────────────────────────────

export interface DayBlockView {
  startMinute: number
  endMinute: number
  source: 'RECURRING' | 'OVERRIDE'
}

/** The available blocks for one local date, merged and sorted — what the
 *  availability tab draws. Full-day-off and admin blocks produce an empty list. */
export function availableBlocksForDate(i: {
  date: string
  rules: RecurringRule[]
  exceptions: DateException[]
  businessBlocked?: boolean
}): DayBlockView[] {
  const onDate = i.exceptions.filter((e) => e.date === i.date)
  if (i.businessBlocked || onDate.some((e) => e.kind === 'ADMIN_BLOCK' || e.kind === 'UNAVAILABLE_FULL' || e.kind === 'VACATION' || e.kind === 'LEAVE')) {
    return []
  }
  const dow = dayOfWeekOf(i.date)
  const blocks: DayBlockView[] = [
    ...i.rules
      .filter((r) => (r.active ?? true) && r.dayOfWeek === dow && inEffectiveRange(r, i.date))
      .map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute, source: 'RECURRING' as const })),
    ...onDate
      .filter((e) => e.kind === 'AVAILABLE_OVERRIDE')
      .map((e) => ({ startMinute: e.startMinute ?? 0, endMinute: e.endMinute ?? MINUTES_IN_DAY, source: 'OVERRIDE' as const })),
  ]
  // Subtract partial-unavailable windows.
  const offs = onDate.filter((e) => e.kind === 'UNAVAILABLE_PARTIAL').map((e) => [e.startMinute ?? 0, e.endMinute ?? MINUTES_IN_DAY] as const)
  const result: DayBlockView[] = []
  for (const b of blocks) {
    let segments = [[b.startMinute, b.endMinute]] as [number, number][]
    for (const [os, oe] of offs) {
      segments = segments.flatMap(([s, e]) => {
        if (!overlaps(s, e, os, oe)) return [[s, e] as [number, number]]
        const out: [number, number][] = []
        if (s < os) out.push([s, Math.min(e, os)])
        if (oe < e) out.push([Math.max(s, oe), e])
        return out
      })
    }
    for (const [s, e] of segments) if (e > s) result.push({ startMinute: s, endMinute: e, source: b.source })
  }
  return result.sort((a, b) => a.startMinute - b.startMinute)
}

/** "8:00 AM" from minutes-from-midnight. */
export function formatMinute(m: number): string {
  const h24 = Math.floor(m / 60) % 24
  const min = m % 60
  const ampm = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(min).padStart(2, '0')} ${ampm}`
}

/** "HH:MM" (24h) → minutes. Returns null on a malformed value rather than 0,
 *  so a bad input never reads as "midnight". */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}
