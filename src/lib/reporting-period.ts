// ============================================================================
// reporting-period.ts — timezone-safe reporting boundaries (Stage 3, owner spec
// 2026-07-20).
//
// TIME-ZONE POLICY: timestamps are stored in UTC; reporting boundaries are
// computed in the BUSINESS time zone (America/New_York). This matters because a
// move worked at 8pm on 31 January is 01:00 UTC on 1 February — using UTC
// boundaries silently moves revenue into the wrong month, and the owner would
// never know why the numbers disagreed with their memory.
//
// Pure functions, no Prisma, offline-tested including DST transitions.
// ============================================================================

export const BUSINESS_TIME_ZONE = 'America/New_York'

export type PeriodKey =
  | 'today' | 'yesterday' | 'this_week' | 'previous_week'
  | 'this_month' | 'previous_month' | 'this_quarter' | 'previous_quarter'
  | 'year_to_date' | 'previous_year' | 'custom'

export interface Period {
  key: PeriodKey
  /** Inclusive UTC instant of the first millisecond of the period. */
  start: Date
  /** EXCLUSIVE UTC instant — use `lt`, never `lte`, so a move at 23:59:59.999
   *  is included and one at 00:00:00.000 the next day is not. */
  end: Date
  label: string
  timeZone: string
}

/**
 * The business-local calendar parts of a UTC instant.
 * Uses Intl rather than manual offset math so DST is handled by the platform.
 */
export function zonedParts(d: Date, timeZone = BUSINESS_TIME_ZONE): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  }
}

/** The zone's UTC offset in minutes at a given instant (negative west of UTC). */
function offsetMinutes(d: Date, timeZone: string): number {
  const p = zonedParts(d, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return Math.round((asUtc - d.getTime()) / 60_000)
}

/**
 * The UTC instant of business-local midnight on a given calendar date.
 *
 * Two-pass: guess with the offset at the naive instant, then re-derive with the
 * offset that actually applies at the guess. That second pass is what makes DST
 * days correct — on 9 March the offset before and after 2am differ by an hour.
 */
export function zonedStartOfDay(year: number, month: number, day: number, timeZone = BUSINESS_TIME_ZONE): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  const guess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000)
  const corrected = new Date(naive - offsetMinutes(guess, timeZone) * 60_000)
  return corrected
}

/**
 * Read a report date input safely.
 *
 * A DATE-ONLY string ("2026-06-30") is a calendar date, not an instant:
 * `new Date("2026-06-30")` is UTC midnight, which is 29 June in New York and
 * would silently drop the last day of a custom range. Date-only input is
 * therefore resolved directly in the business zone.
 */
export function parseReportDate(input: string | Date, timeZone = BUSINESS_TIME_ZONE): Date {
  if (input instanceof Date) return startOfBusinessDay(input, timeZone)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (m) return zonedStartOfDay(Number(m[1]), Number(m[2]), Number(m[3]), timeZone)
  return startOfBusinessDay(new Date(input), timeZone)
}

/** Business-local midnight that starts the day containing `d`. */
export function startOfBusinessDay(d: Date, timeZone = BUSINESS_TIME_ZONE): Date {
  const p = zonedParts(d, timeZone)
  return zonedStartOfDay(p.year, p.month, p.day, timeZone)
}

/** Add whole calendar days in the business zone (DST-safe: not +24h). */
export function addBusinessDays(d: Date, days: number, timeZone = BUSINESS_TIME_ZONE): Date {
  const p = zonedParts(d, timeZone)
  return zonedStartOfDay(p.year, p.month, p.day + days, timeZone)
}

/** Monday-start week containing `d`, in business-local time. */
export function startOfBusinessWeek(d: Date, timeZone = BUSINESS_TIME_ZONE): Date {
  const p = zonedParts(d, timeZone)
  const midnight = zonedStartOfDay(p.year, p.month, p.day, timeZone)
  // getUTCDay on the local-midnight instant would be wrong; derive the weekday
  // from the zone-local Y/M/D instead.
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() // 0=Sun
  const backToMonday = dow === 0 ? 6 : dow - 1
  return addBusinessDays(midnight, -backToMonday, timeZone)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Resolve a named period into UTC boundaries.
 * `now` is injectable so every boundary is testable without faking the clock.
 */
export function resolvePeriod(
  key: PeriodKey,
  now: Date = new Date(),
  custom?: { start?: string | Date | null; end?: string | Date | null },
  timeZone = BUSINESS_TIME_ZONE,
): Period {
  const p = zonedParts(now, timeZone)
  const day = (y: number, m: number, d: number) => zonedStartOfDay(y, m, d, timeZone)
  const mk = (start: Date, end: Date, label: string): Period => ({ key, start, end, label, timeZone })

  switch (key) {
    case 'today': {
      const s = day(p.year, p.month, p.day)
      return mk(s, addBusinessDays(s, 1, timeZone), 'Today')
    }
    case 'yesterday': {
      const s = day(p.year, p.month, p.day - 1)
      return mk(s, addBusinessDays(s, 1, timeZone), 'Yesterday')
    }
    case 'this_week': {
      const s = startOfBusinessWeek(now, timeZone)
      return mk(s, addBusinessDays(s, 7, timeZone), 'This week')
    }
    case 'previous_week': {
      const thisWeek = startOfBusinessWeek(now, timeZone)
      const s = addBusinessDays(thisWeek, -7, timeZone)
      return mk(s, thisWeek, 'Previous week')
    }
    case 'this_month':
      return mk(day(p.year, p.month, 1), day(p.year, p.month + 1, 1), `${MONTHS[p.month - 1]} ${p.year}`)
    case 'previous_month': {
      const m = p.month === 1 ? 12 : p.month - 1
      const y = p.month === 1 ? p.year - 1 : p.year
      return mk(day(y, m, 1), day(p.year, p.month, 1), `${MONTHS[m - 1]} ${y}`)
    }
    case 'this_quarter': {
      const q = Math.floor((p.month - 1) / 3)
      return mk(day(p.year, q * 3 + 1, 1), day(p.year, q * 3 + 4, 1), `Q${q + 1} ${p.year}`)
    }
    case 'previous_quarter': {
      const q = Math.floor((p.month - 1) / 3)
      const pq = q === 0 ? 3 : q - 1
      const y = q === 0 ? p.year - 1 : p.year
      return mk(day(y, pq * 3 + 1, 1), day(y, pq * 3 + 4, 1), `Q${pq + 1} ${y}`)
    }
    case 'previous_year':
      return mk(day(p.year - 1, 1, 1), day(p.year, 1, 1), String(p.year - 1))
    case 'custom': {
      const s = custom?.start ? parseReportDate(custom.start, timeZone) : day(p.year, p.month, 1)
      // The end date is INCLUSIVE for the user, exclusive internally.
      const e = custom?.end ? addBusinessDays(parseReportDate(custom.end, timeZone), 1, timeZone) : day(p.year, p.month + 1, 1)
      return mk(s, e, 'Custom range')
    }
    case 'year_to_date':
    default:
      return mk(day(p.year, 1, 1), addBusinessDays(day(p.year, p.month, p.day), 1, timeZone), `${p.year} year to date`)
  }
}

/**
 * The comparable prior period of the same length, for period-over-period
 * comparison. Named periods use their true calendar predecessor; a custom range
 * shifts back by its own duration.
 */
export function previousComparablePeriod(period: Period, now: Date = new Date(), timeZone = BUSINESS_TIME_ZONE): Period {
  const map: Partial<Record<PeriodKey, PeriodKey>> = {
    today: 'yesterday',
    this_week: 'previous_week',
    this_month: 'previous_month',
    this_quarter: 'previous_quarter',
    year_to_date: 'previous_year',
  }
  const mapped = map[period.key]
  if (mapped) return resolvePeriod(mapped, now, undefined, timeZone)
  const ms = period.end.getTime() - period.start.getTime()
  return {
    key: 'custom',
    start: new Date(period.start.getTime() - ms),
    end: new Date(period.start.getTime()),
    label: 'Previous period',
    timeZone,
  }
}

/** A Prisma `where` fragment for a UTC-stored timestamp column. Exclusive end. */
export const periodWhere = (period: Period) => ({ gte: period.start, lt: period.end })

/** True when a UTC instant falls inside the period. */
export const inPeriod = (d: Date, period: Period): boolean =>
  d.getTime() >= period.start.getTime() && d.getTime() < period.end.getTime()

// ── Safe comparison ─────────────────────────────────────────────────────────

export interface Delta {
  currentCents: number
  previousCents: number
  changeCents: number
  /** Basis points. NULL when the prior period has no comparable value — a
   *  percentage change from zero is meaningless and must never be rendered. */
  changeBp: number | null
  /** What to show when changeBp is null. */
  note: string | null
}

/**
 * Period-over-period change. Returns `changeBp: null` with an explicit note when
 * the denominator is zero, so no surface can print "+∞%" or a fake "+100%".
 */
export function compareCents(currentCents: number, previousCents: number): Delta {
  const changeCents = currentCents - previousCents
  if (previousCents === 0) {
    return {
      currentCents, previousCents, changeCents,
      changeBp: null,
      note: 'No comparable prior-period value',
    }
  }
  return {
    currentCents, previousCents, changeCents,
    changeBp: Math.round((changeCents / Math.abs(previousCents)) * 10_000),
    note: null,
  }
}

/** Format a business-local date for report headers and exports. */
export function formatBusinessDate(d: Date, timeZone = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(d)
}

/** The inclusive human-facing end date (the internal end is exclusive). */
export function inclusiveEndDate(period: Period): Date {
  return new Date(period.end.getTime() - 1)
}
