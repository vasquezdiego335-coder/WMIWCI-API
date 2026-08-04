// ════════════════════════════════════════════════════════════════════════
//  quote-date.ts — strict calendar validation for a customer-supplied move date.
//
//  WHY A REGEX IS NOT ENOUGH. `/^\d{4}-\d{2}-\d{2}$/` accepts '2026-02-31',
//  and `new Date('2026-02-31T12:00:00.000Z')` does not throw — it SILENTLY
//  ROLLS OVER to March 3rd. The lead, the confirmation email and the owner's
//  Discord card would then all agree on a date the customer never picked, and
//  a crew would be scheduled for the wrong day. The round-trip check below is
//  what makes rollover impossible: we rebuild the date and require the UTC
//  components to equal the digits we were given.
//
//  THE NOON-UTC CHOICE IS DELIBERATE AND PRESERVED. Midnight UTC renders as the
//  PREVIOUS calendar day in America/New_York (UTC-4/-5), so a customer picking
//  the 11th would see the 10th on every downstream surface. Noon UTC is 07:00 /
//  08:00 ET — the same calendar day in every US timezone.
//
//  PURE + OFFLINE: no prisma, no env, no network.
// ════════════════════════════════════════════════════════════════════════

/** How far ahead a move may be booked. Beyond this the date is almost always a
 *  typo (a mistyped year), and quoting a price 5 years out is meaningless. */
export const MAX_BOOKING_HORIZON_DAYS = 540

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/

export type MoveDateVerdict =
  | { ok: true; date: Date; iso: string }
  | {
      ok: false
      reason: 'empty' | 'bad_format' | 'not_a_real_date' | 'in_the_past' | 'beyond_horizon'
    }

/**
 * Validate a 'YYYY-MM-DD' move date.
 *
 * `today` is injectable so the boundary cases (today allowed, yesterday
 * rejected) are testable without touching the system clock.
 */
export function isValidMoveDate(value: string | null | undefined, today: Date = new Date()): MoveDateVerdict {
  const raw = (value ?? '').trim()
  if (!raw) return { ok: false, reason: 'empty' }

  const m = SHAPE.exec(raw)
  if (!m) return { ok: false, reason: 'bad_format' }

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])

  // Cheap range rejections first, so Date never sees an absurd year.
  if (month < 1 || month > 12) return { ok: false, reason: 'not_a_real_date' }
  if (day < 1 || day > 31) return { ok: false, reason: 'not_a_real_date' }
  if (year < 2000 || year > 2100) return { ok: false, reason: 'not_a_real_date' }

  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0))
  if (Number.isNaN(date.getTime())) return { ok: false, reason: 'not_a_real_date' }

  // THE ROLL-OVER GUARD. Feb 31 -> Mar 3, Apr 31 -> May 1, Feb 29 in a
  // non-leap year -> Mar 1. Requiring the components back out unchanged is the
  // only reliable way to reject all of them, leap years included.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, reason: 'not_a_real_date' }
  }

  // Compare CALENDAR DAYS, not instants: a move later today is still valid at
  // 6pm, and the stored value is noon UTC either way.
  const todayUtcDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const pickedUtcDay = Date.UTC(year, month - 1, day)
  if (pickedUtcDay < todayUtcDay) return { ok: false, reason: 'in_the_past' }

  const daysOut = Math.round((pickedUtcDay - todayUtcDay) / 86_400_000)
  if (daysOut > MAX_BOOKING_HORIZON_DAYS) return { ok: false, reason: 'beyond_horizon' }

  return { ok: true, date, iso: date.toISOString() }
}

/**
 * Parse for STORAGE. Returns null for anything `isValidMoveDate` rejects, so a
 * bad date is stored as "not given" rather than as a wrong day.
 *
 * Callers that must tell the customer WHY should call isValidMoveDate first —
 * this is the convenience wrapper for the persistence path.
 */
export function parseMoveDate(value: string | null | undefined, today: Date = new Date()): Date | null {
  const v = isValidMoveDate(value, today)
  return v.ok ? v.date : null
}
