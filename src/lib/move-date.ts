// ════════════════════════════════════════════════════════════════════════════
//  move-date.ts — THE calendar semantics of a move date, and the ONLY place
//  a move date is turned into words.
//  ------------------------------------------------------------------------
//  THE BUG THIS FILE EXISTS TO KILL (reported 2026-08-20, link SACBX6T8SZHB):
//  the owner picked Saturday 22 August 2026 in the admin form and the customer
//  was shown "August 21, 2026". Every hop was individually defensible:
//
//    1. <input type="date">            → the string "2026-08-22"
//    2. new Date("2026-08-22")         → 2026-08-22T00:00:00.000Z
//       (ECMA-262: a DATE-ONLY form is parsed as UTC. A date-TIME form without
//        an offset is parsed as LOCAL. That inconsistency is the whole trap.)
//    3. stored in move_date TIMESTAMP(3)
//    4. toLocaleDateString('en-US', { timeZone: 'America/New_York' })
//       → 2026-08-21, 20:00 EDT → "August 21, 2026"
//
//  A MOVE DATE IS A CALENDAR DATE, NOT AN INSTANT. Nobody moves at "the instant
//  2026-08-22T00:00:00Z"; they move *on Saturday*. The moment a calendar date is
//  stored as an instant, some timezone will read it as the day before — and on
//  a page where a customer is about to hand over money, being shown the wrong
//  day is the difference between trust and a phone call.
//
//  THE TWO RULES:
//
//    WRITING — a calendar date is anchored at 12:00:00.000 UTC of that day.
//    Noon UTC is 07:00/08:00 in America/New_York year-round, so it is the same
//    calendar day in every timezone from UTC-11 to UTC+11. This is not a new
//    invention: src/lib/quote-date.ts already stores move dates exactly this
//    way (Date.UTC(y, m-1, d, 12, 0, 0, 0)). This file aligns with it.
//
//    READING — `moveDateParts` extracts the calendar day WITHOUT letting a
//    timezone shift it, and every formatter in this file works from those parts
//    on a UTC-pinned Date. There is no `timeZone: 'America/New_York'` anywhere
//    below the decoder, so no formatter can move a day again.
//
//  THE ONE HISTORICAL EXCEPTION, stated out loud: rows written before this fix
//  hold EXACTLY 00:00:00.000 UTC, because that is what `new Date("2026-08-22")`
//  produces and nothing else on this path produces it. Read as Eastern those
//  rows are a day early; read as UTC they are correct. So an exact-UTC-midnight
//  instant is treated as a date-only value and read in UTC. That repairs every
//  existing row without a data migration and without touching one customer by
//  hand. It is narrow on purpose — 00:00:00.000Z is 8:00 PM Eastern, which is
//  not a time anybody schedules a move for, and a real inherited timestamp
//  (a booking's requestedDate) practically never lands on it to the millisecond.
//
//  THE MOVE TIME IS NOT IN THE TIMESTAMP. It is a separate integer, minutes
//  after midnight Eastern (0-1439). A time that never enters a Date can never
//  be shifted by a timezone, and "7:00 AM" stays 7:00 AM through DST, through a
//  server in UTC, and through a customer's phone in California.
//
//  PURE. No Prisma, no network, no process.env. Every rule here is unit-testable
//  offline — see src/lib/__tests__/move-date.test.ts.
// ════════════════════════════════════════════════════════════════════════════

/** The company's timezone. Used ONLY to decode a real instant into a calendar
 *  day — never to format one, because formatting is what shifted the day. */
export const MOVE_TZ = 'America/New_York'

/** A calendar day, as three plain numbers. No timezone, no instant, no Date. */
export type MoveDateParts = { year: number; month: number; day: number }

const MS_PER_MINUTE = 60_000
const NOON_MS = 12 * 60 * MS_PER_MINUTE

// ── Reading ─────────────────────────────────────────────────────────────────

/** Is this instant exactly midnight UTC? The signature of the legacy bug shape. */
function isUtcMidnight(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
}

/**
 * Calendar parts of a stored move date, immune to timezone drift.
 *
 * · exactly 00:00:00.000 UTC → a date-only value (the legacy shape, and what a
 *   naive `new Date("2026-08-22")` still produces anywhere else) → read in UTC.
 * · anything else → a real instant, including our own noon-UTC anchor → read in
 *   America/New_York. Noon UTC is 7-8 AM Eastern, so the anchor decodes to the
 *   same day either way; this branch exists for genuinely time-bearing values
 *   such as a booking's requestedDate.
 */
export function moveDateParts(at: Date): MoveDateParts | null {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null
  if (isUtcMidnight(at)) {
    return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
  }
  return easternParts(at)
}

/**
 * Calendar parts of an instant in America/New_York.
 *
 * Uses Intl with an en-CA locale, whose short date format is ISO-ordered
 * (YYYY-MM-DD), so the parts come back without parsing a localised string.
 * `formatToParts` is read explicitly rather than splitting the formatted string,
 * because a runtime is free to add characters a naive split would swallow.
 */
export function easternParts(at: Date, timeZone: string = MOVE_TZ): MoveDateParts | null {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return { year, month, day }
}

/**
 * Calendar parts → a Date pinned to NOON UTC of that day.
 *
 * Every formatter below runs on one of these with `timeZone: 'UTC'`. Noon is
 * twelve hours from either midnight, so no rounding, locale or calendar quirk
 * can tip it into an adjacent day.
 */
function partsToUtcNoon(p: MoveDateParts): Date {
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0, 0))
}

// ── Writing ─────────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * "2026-08-22" (an <input type="date"> value) → the stored anchor, 12:00 UTC.
 *
 * Rejects anything that is not a real calendar day. The ROLL-OVER GUARD is the
 * same one quote-date.ts uses: Date.UTC silently turns Feb 31 into Mar 3, and
 * requiring the components to come back out unchanged is the only reliable way
 * to catch every such case, leap years included.
 *
 * Returns null — never a wrong date — for anything it cannot vouch for.
 */
export function parseCalendarDate(input: unknown): Date | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null

  // An <input type="date"> always emits YYYY-MM-DD. A datetime-local value
  // ("2026-08-22T07:00") is accepted by taking its DATE half: the time half
  // belongs in moveTimeMinutes, not in the anchor.
  const m = ISO_DATE.exec(raw.length > 10 && raw[10] === 'T' ? raw.slice(0, 10) : raw)
  if (!m) return null

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (year < 2000 || year > 2100) return null

  const at = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0))
  if (Number.isNaN(at.getTime())) return null
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null
  return at
}

/**
 * Re-anchor a value that is already a Date.
 *
 * Used when a deposit inherits its date from a booking's `requestedDate`, which
 * IS a real instant with a real Eastern time in it. The calendar day is taken in
 * Eastern (correct for an instant) and re-stored as a noon anchor, so from that
 * moment on the deposit's date is a calendar date like any other.
 */
export function anchorFromInstant(at: Date | null | undefined): Date | null {
  if (!at) return null
  const parts = moveDateParts(at)
  return parts ? partsToUtcNoon(parts) : null
}

/** The calendar day of an instant in Eastern, as minutes after midnight. */
export function easternTimeMinutes(at: Date | null | undefined, timeZone: string = MOVE_TZ): number | null {
  if (!at || Number.isNaN(at.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN)
  const h = get('hour')
  const min = get('minute')
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  return h * 60 + min
}

// ── The move time ───────────────────────────────────────────────────────────

export const MAX_TIME_MINUTES = 24 * 60 - 1

/**
 * "07:00" (an <input type="time"> value) → 420 minutes after midnight Eastern.
 *
 * Also accepts "7:00 AM" / "7 pm" so a value pasted from a text message is not
 * silently dropped. Returns null for anything unparseable — a wrong time on a
 * payment page is worse than no time.
 */
export function parseMoveTime(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= 0 && input <= MAX_TIME_MINUTES ? input : null
  }
  if (typeof input !== 'string') return null
  const raw = input.trim().toLowerCase()
  if (!raw) return null

  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(raw)
  if (!m) return null

  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3]?.replace(/\./g, '')

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (minute > 59) return null

  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  } else if (hour > 23) {
    return null
  }

  const total = hour * 60 + minute
  return total >= 0 && total <= MAX_TIME_MINUTES ? total : null
}

/** 420 → "07:00", the value an <input type="time"> wants back. */
export function moveTimeInputValue(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_TIME_MINUTES) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "2026-08-22", the value an <input type="date"> wants back. */
export function moveDateInputValue(at: Date | null | undefined): string {
  if (!at) return ''
  const p = moveDateParts(at)
  if (!p) return ''
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

// ── Formatting ──────────────────────────────────────────────────────────────
//
// EVERY formatter below pins `timeZone: 'UTC'` on a noon-anchored Date built
// from decoded parts. That is what makes the day mathematically unable to move:
// the decoder has already settled which calendar day this is, and the formatter
// is only allowed to spell it.

type Loc = 'en' | 'es' | string

const localeTag = (lang: Loc): string => (lang === 'es' ? 'es-US' : 'en-US')

/** "Saturday, August 22, 2026" · es: "sábado, 22 de agosto de 2026" */
export function formatMoveDateLong(at: Date | null | undefined, lang: Loc = 'en'): string | null {
  const p = at ? moveDateParts(at) : null
  if (!p) return null
  return new Intl.DateTimeFormat(localeTag(lang), {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(partsToUtcNoon(p))
}

/** "August 22, 2026" · es: "22 de agosto de 2026" — no weekday. */
export function formatMoveDatePlain(at: Date | null | undefined, lang: Loc = 'en'): string | null {
  const p = at ? moveDateParts(at) : null
  if (!p) return null
  return new Intl.DateTimeFormat(localeTag(lang), {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(partsToUtcNoon(p))
}

/** "Saturday, August 22" · es: "sábado, 22 de agosto" — no year. */
export function formatMoveDayAndMonth(at: Date | null | undefined, lang: Loc = 'en'): string | null {
  const p = at ? moveDateParts(at) : null
  if (!p) return null
  return new Intl.DateTimeFormat(localeTag(lang), {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(partsToUtcNoon(p))
}

/** 420 → "7:00 AM" · es: "7:00 a. m." */
export function formatMoveTime(minutes: number | null | undefined, lang: Loc = 'en'): string | null {
  if (minutes == null || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_TIME_MINUTES) return null
  // A throwaway UTC instant carrying only the hour and minute. It is formatted
  // in UTC, so it is a spelling device and not a point in time.
  const at = new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60, 0, 0))
  return new Intl.DateTimeFormat(localeTag(lang), {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at)
}

/**
 * THE headline line on the deposit page.
 *
 *   with a time → "Saturday, August 22 · 7:00 AM"
 *   without     → "Saturday, August 22, 2026"
 *
 * The year is dropped only when a time is present, because the line is already
 * long on a phone and a move with a booked hour is always imminent. Without a
 * time the year stays: a bare "Saturday, August 22" a year out is ambiguous.
 */
export function formatMoveWhen(
  at: Date | null | undefined,
  timeMinutes: number | null | undefined,
  lang: Loc = 'en'
): string | null {
  const time = formatMoveTime(timeMinutes, lang)
  if (!time) return formatMoveDateLong(at, lang)
  const day = formatMoveDayAndMonth(at, lang)
  if (!day) return null
  return `${day} · ${time}`
}

// ── Eastern wall clock → instant (for the LINK EXPIRY, not the move) ────────
//
// THE SECOND TIMEZONE BUG ON THIS FEATURE, and a costlier one than the date.
// The admin expiry field is an <input type="datetime-local">, which emits an
// OFFSET-LESS string like "2026-08-22T23:00". ECMA-262 parses a date-TIME form
// with no offset in the HOST's local timezone — the mirror image of the
// date-only rule that broke the move date. Production runs on Railway/Vercel,
// which are UTC, so `new Date("2026-08-22T23:00")` became 23:00 UTC = 7:00 PM
// Eastern. The owner set the link to live until 11 PM and it died at 7 PM,
// showing a real customer "This payment link has expired" while they were
// trying to pay.
//
// The algorithm is the same one src/lib/scheduling.ts uses, deliberately
// duplicated rather than imported: scheduling.ts imports Prisma, and both
// deposit-links.ts (unit-tested with no database) and the client bundle need
// this. The duplication is a few lines; the coupling would be a whole ORM.

const ET_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOVE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** How far Eastern is from UTC at a given instant, in ms (negative: behind). */
function etOffsetMs(instant: Date): number {
  const p: Record<string, string> = {}
  for (const part of ET_PARTS.formatToParts(instant)) p[part.type] = part.value
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  )
  // Intl formats to whole seconds only, so `asUTC` has dropped the instant's
  // milliseconds. Offsets are always a whole number of minutes, so rounding to
  // the nearest minute removes that error exactly.
  return Math.round((asUTC - instant.getTime()) / 60_000) * 60_000
}

/** The UTC instant of an America/New_York wall-clock time. DST-correct. */
export function etWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  // Treat the wall clock as if it were UTC, then correct by the Eastern offset
  // at that instant. One correction is exact outside the ~1h DST transition
  // window; inside it, either reading of an ambiguous local time is defensible.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  return new Date(guess - etOffsetMs(new Date(guess)))
}

/**
 * An <input type="datetime-local"> value → the instant the owner MEANT.
 *
 * "2026-08-22T23:00" is 11 PM in New Jersey, which is what the owner typed and
 * what he told the customer. Values that already carry an offset or a trailing
 * Z are absolute and are passed through untouched.
 */
export function parseEtDateTimeLocal(input: unknown): Date | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw)
  if (!m) {
    // Carries its own offset (…Z, …+05:00) or is some other form: absolute
    // already, so there is nothing to interpret.
    const abs = new Date(raw)
    return Number.isNaN(abs.getTime()) ? null : abs
  }

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59) return null
  if (year < 2000 || year > 2100) return null

  const at = etWallClockToInstant(year, month, day, hour, minute)
  return Number.isNaN(at.getTime()) ? null : at
}

/** "Aug 22, 2026 at 11:00 PM ET" — an INSTANT, so genuinely formatted in ET. */
export function formatEtInstant(at: Date | null | undefined, lang: Loc = 'en'): string | null {
  if (!at || Number.isNaN(at.getTime())) return null
  return `${new Intl.DateTimeFormat(localeTag(lang), {
    timeZone: MOVE_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at)} ET`
}

// ── Legacy-instant repair, for values this app did not write ────────────────

/**
 * Would reading this stored value in Eastern print a different calendar day
 * than reading it in UTC? Diagnostic only — used by the preflight script and by
 * tests to prove the repair rule fires exactly where it is needed.
 */
export function wouldShiftDay(at: Date, timeZone: string = MOVE_TZ): boolean {
  const utc = { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
  const et = easternParts(at, timeZone)
  if (!et) return false
  return utc.year !== et.year || utc.month !== et.month || utc.day !== et.day
}
