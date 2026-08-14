import { prisma } from './db'
import { moveTimeKnown, moveWhenInstant, type MoveWhenInput } from './booking-display'
import { TRAVEL_BUFFER_MINUTES } from './travel-buffer'

const TZ = process.env.TIMEZONE ?? 'America/New_York'
const MAX_JOBS = parseInt(process.env.MAX_JOBS_PER_DAY ?? '3', 10)
// THE house travel buffer, from the one module that owns it (P0-A). The truck
// hold math (truck-conflicts.truckHoldHours) adds the SAME constant when it
// derives a window for a booking with no stored scheduledEnd — that equality is
// what makes an unpaid hold occupy the same window its confirmed twin does, so
// the two must never be separate copies.
const BUFFER_MINS = TRAVEL_BUFFER_MINUTES
// Default job length (hours) when a booking carries no explicit estimate. Used
// only to derive scheduledEnd — the schedule keys off scheduledStart.
const DEFAULT_JOB_HOURS = parseFloat(process.env.DEFAULT_JOB_HOURS ?? '3')

// ════════════════════════════════════════════════════════════════════════
//  Timezone-correct date math (America/New_York, DST-aware)
//  ----------------------------------------------------------------------
//  Every schedule query and every stored move-date must agree on the SAME
//  wall-clock timezone regardless of what timezone the server process runs in
//  (Railway/Vercel default to UTC). Relying on `Date#setHours` computes the
//  boundary in the SERVER's local zone, which is why a Sunday ET move could
//  fall into Saturday-night / Monday UTC and vanish from the digest. These
//  helpers pin everything to ET.
// ════════════════════════════════════════════════════════════════════════

// Offset (ms) of America/New_York from UTC at a given instant (e.g. -4h in EDT,
// -5h in EST). Positive when ET is behind UTC would be negative; we return
// (ET-wall-as-UTC − instant), which is negative for western zones.
function etOffsetMs(instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  )
  // Intl formats only to whole seconds, so `asUTC` drops the instant's ms. Round
  // to the nearest minute — timezone offsets are always whole minutes — so the
  // dropped sub-second can't skew the result (this is what pushed a 23:59:59.999
  // boundary one ms past midnight before rounding).
  return Math.round((asUTC - instant.getTime()) / 60000) * 60000
}

/** The UTC instant for a given America/New_York wall-clock time (DST-correct). */
export function etWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0
): Date {
  // Guess: treat the wall clock as if it were UTC, then correct by the ET offset
  // at that instant. One correction is exact outside the ~1h DST transition
  // window, which never coincides with the 00:00 / 23:59 day boundaries we use.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const off = etOffsetMs(new Date(guess))
  return new Date(guess - off)
}

/** The America/New_York calendar Y/M/D for an instant. */
function etYmd(instant: Date): [number, number, number] {
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)) {
    parts[p.type] = p.value
  }
  return [Number(parts.year), Number(parts.month), Number(parts.day)]
}

/**
 * Parse a booking form's "YYYY-MM-DD" + "HH:MM" into the correct UTC instant for
 * that America/New_York wall-clock time. Replaces `new Date("...T...")`, which
 * silently interpreted the string in the SERVER's timezone. Returns null on a
 * malformed date so callers can fall back.
 *
 * PRE-EXISTING, DELIBERATELY LEFT ALONE (docs/moving-os-phase1-fixes-round2.md,
 * the R2-1 note): a missing `timeStr` defaults to 07:00, and the PUBLIC booking
 * route passes `time ?? '07:00'` (app/api/bookings/route.ts). That default is
 * UNREACHABLE from the admin path — admin-booking.resolveMoveSchedule passes an
 * explicit '00:00' day anchor when the owner gave no time, and records the
 * absence on `Booking.startTimeKnown` instead. Changing the public default is
 * out of scope for R2-1; it would silently re-time every public booking.
 */
export function etDateTimeToInstant(dateStr?: string | null, timeStr?: string | null): Date | null {
  if (!dateStr) return null
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!dm) return null
  const tm = /^(\d{1,2}):(\d{2})/.exec((timeStr ?? '07:00').trim())
  const hour = tm ? Number(tm[1]) : 7
  const minute = tm ? Number(tm[2]) : 0
  return etWallClockToInstant(Number(dm[1]), Number(dm[2]), Number(dm[3]), hour, minute)
}

/**
 * The UTC instants bounding an America/New_York calendar day, `offsetDays` from
 * the ET day that contains `base` (0 = today, 1 = tomorrow). DST-safe: the day
 * shift is done in calendar space, not by adding 24h.
 */
export function etDayRange(offsetDays = 0, base: Date = new Date()): { start: Date; end: Date } {
  const [y, m, d] = etYmd(base)
  const shifted = new Date(Date.UTC(y, m - 1, d))
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays)
  const yy = shifted.getUTCFullYear()
  const mm = shifted.getUTCMonth() + 1
  const dd = shifted.getUTCDate()
  return {
    start: etWallClockToInstant(yy, mm, dd, 0, 0, 0, 0),
    end: etWallClockToInstant(yy, mm, dd, 23, 59, 59, 999),
  }
}

// ── Move-date resolution (the single source of truth for "when is this job") ──

type MoveDateFields = {
  scheduledStart?: Date | null
  confirmedDate?: Date | null
  requestedDate?: Date | null
}

/**
 * The canonical instant a job happens. `scheduledStart` is authoritative once
 * set (admins can fine-tune it); otherwise fall back to the confirmed, then the
 * requested date. This is what every schedule view should sort/label by so a
 * booking never disappears because one date field was populated and another
 * wasn't.
 */
export function effectiveMoveDate<T extends MoveDateFields>(b: T): Date | null {
  return b.scheduledStart ?? b.confirmedDate ?? b.requestedDate ?? null
}

/**
 * Prisma `where` fragment matching bookings whose effective move date falls in
 * [start, end]. Resilient to legacy rows that were confirmed before
 * `scheduledStart` was populated: it coalesces scheduledStart → confirmedDate →
 * requestedDate at the query level.
 */
export function moveDateInRange(start: Date, end: Date) {
  return {
    OR: [
      { scheduledStart: { gte: start, lte: end } },
      { scheduledStart: null, confirmedDate: { gte: start, lte: end } },
      { scheduledStart: null, confirmedDate: null, requestedDate: { gte: start, lte: end } },
    ],
  }
}

/**
 * ── ITEM R3-2 — the day-level determination that survives an UNREADABLE flag ──
 *
 * The WRITE-side twin of `booking-display.moveTimeKnown`, and deliberately not a
 * second implementation of it: this is the same decision the display surfaces
 * make, so it delegates to the one rule rather than keeping a copy that can
 * drift.
 *
 * WHY IT MATTERS HERE: `startTimeKnown` is unreadable during the normal
 * code-before-SQL deploy window (migration 20260812010000 not applied yet), and
 * the degraded read that keeps approvals alive (item R3-2, booking-approval.ts)
 * returns it as `undefined`. Round 2 treated ONLY an explicit `false` as
 * day-level, so in exactly that window the 00:00 ET anchor was promoted into
 * `scheduledStart` again — fail-soft in the direction of the defect. With the
 * shared rule, the ANCHOR'S OWN SHAPE decides when the flag cannot be read: a
 * date-only move is stored as midnight ET and nothing in this system schedules
 * a crew at 00:00:00.000 (the public route writes `time ?? '07:00'`, the admin
 * form writes a real hour). That is conservative in the SAFE direction — a
 * day-level booking holds the WHOLE ET day for truck conflicts, where the
 * promoted-midnight bug held only 00:00–06:00.
 *
 * A stored `scheduledStart` still wins over everything, so a real 9 AM job can
 * never be mis-read as day-level.
 */
export function moveIsDayLevel(b: {
  startTimeKnown?: boolean | null
  scheduledStart?: Date | null
  confirmedDate?: Date | null
  requestedDate?: Date | null
}): boolean {
  return !moveTimeKnown(b)
}

/** What a booking transitioning to CONFIRMED writes to its schedule columns.
 *  `scheduledStart`/`scheduledEnd` are NULLABLE: a day-level booking is
 *  confirmed for a DATE, and no hour is invented for it (item R2-1). */
export type ConfirmationScheduleData = {
  confirmedDate: Date
  scheduledStart: Date | null
  scheduledEnd: Date | null
}

/**
 * The schedule fields to persist when a booking transitions to CONFIRMED so it
 * appears in every schedule view. Existing (admin-tuned) values are preserved.
 * Returns null when there is no date to schedule from.
 *
 * ── ITEM R2-1: NO INVENTED START ────────────────────────────────────────────
 * This function used to do `start = scheduledStart ?? confirmedDate ??
 * requestedDate`. For a DAY-LEVEL booking (admin Book Move with no crew start
 * time) `requestedDate` is the 00:00 ET day anchor, so approval PROMOTED
 * midnight into `scheduledStart` and the job landed at 12:00 AM ET. That was
 * not just cosmetic: `truck-conflicts.truckConflictBetween` compares two KNOWN
 * start times as an interval, so the promoted booking held only 00:00–06:00 ET
 * and the conservative "same ET day + unknown time ⇒ conflict" rule — the
 * double-booking guard — silently stopped applying.
 *
 * `startTimeKnown === false` now means exactly one thing here: keep
 * `confirmedDate` as the day anchor, and leave start/end NULL. Every consumer
 * treats a null start as "date only, time to be confirmed".
 *
 * `startTimeKnown` is OPTIONAL. `true` keeps the legacy behavior outright, and
 * `undefined` — a caller that did not select the column, or a DB where
 * migration 20260812010000_start_time_known is not applied yet — falls back to
 * the anchor's own shape (item R3-2, see `moveIsDayLevel`): a 00:00 ET anchor
 * is day-level, anything with a real time of day is not. A stored
 * `scheduledStart` always wins, so a real 9 AM job can never be mis-read as
 * day-level.
 */
export function confirmationScheduleData(b: {
  requestedDate?: Date | null
  confirmedDate?: Date | null
  scheduledStart?: Date | null
  scheduledEnd?: Date | null
  estimatedHours?: number | null
  /** Booking.startTimeKnown. FALSE = day-level; never fabricate an hour. */
  startTimeKnown?: boolean | null
}): ConfirmationScheduleData | null {
  const move = b.confirmedDate ?? b.requestedDate ?? b.scheduledStart ?? null
  if (!move) return null
  const confirmedDate = b.confirmedDate ?? move

  // Day-level: confirm the DATE, invent no hour. A start that somehow already
  // exists (an admin who set one later) still wins — the flag says "the owner
  // never gave one", and a real stored time is proof they since did.
  if (moveIsDayLevel(b)) {
    return { confirmedDate, scheduledStart: null, scheduledEnd: null }
  }

  const start = b.scheduledStart ?? move
  const hours = b.estimatedHours && b.estimatedHours > 0 ? b.estimatedHours : DEFAULT_JOB_HOURS
  return {
    confirmedDate,
    scheduledStart: start,
    scheduledEnd: b.scheduledEnd ?? calculateEndTime(start, hours),
  }
}

// ── Check if a given date has capacity ────────────────────────
export async function isDayAvailable(date: Date): Promise<boolean> {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)

  // Check admin blocks first
  const block = await prisma.dayBlock.findFirst({
    where: { date: { gte: start, lte: end }, blocked: true },
  })
  if (block) return false

  const count = await prisma.booking.count({
    where: {
      scheduledStart: { gte: start, lte: end },
      status: {
        in: ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'],
      },
    },
  })

  return count < MAX_JOBS
}

// ── Check if both Diego + Sebastian are available ─────────────
export async function isCrewAvailable(date: Date): Promise<{
  available: boolean
  unavailableUsers: string[]
}> {
  const dateOnly = new Date(date)
  dateOnly.setHours(0, 0, 0, 0)

  // Get all staff
  const staff = await prisma.user.findMany({
    where: { active: true, role: { in: ['OWNER', 'MANAGER'] } },
  })

  const unavailableUsers: string[] = []

  for (const member of staff) {
    const avail = await prisma.availability.findUnique({
      where: { userId_date: { userId: member.id, date: dateOnly } },
    })
    if (avail?.isDayOff) {
      unavailableUsers.push(member.name)
    }
  }

  return {
    available: unavailableUsers.length === 0,
    unavailableUsers,
  }
}

// ── Find next N available slots from a given date ─────────────
export async function findAvailableSlots(
  fromDate: Date,
  count = 3
): Promise<Date[]> {
  const slots: Date[] = []
  const check = new Date(fromDate)
  check.setHours(9, 0, 0, 0) // 9 AM start

  let attempts = 0
  const maxAttempts = 60 // don't loop forever

  while (slots.length < count && attempts < maxAttempts) {
    // Skip weekends (0 = Sunday, 6 = Saturday) — edit as needed
    const day = check.getDay()
    if (day !== 0 && day !== 6) {
      const dayOk = await isDayAvailable(check)
      const crewOk = await isCrewAvailable(check)
      if (dayOk && crewOk.available) {
        slots.push(new Date(check))
      }
    }
    check.setDate(check.getDate() + 1)
    attempts++
  }

  return slots
}

// ── Format a Date in Eastern Time for display ─────────────────
export function formatEastern(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

/**
 * `formatEastern` WITHOUT the hour — for a booking whose start time nobody has
 * committed to (item R2-1). Its date instant is a 00:00 ET DAY ANCHOR, so
 * `formatEastern` would render a confident "12:00 AM" that is not a fact about
 * the job. Same wording, same timezone, no invented hour.
 */
export function formatEasternDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

/**
 * THE display rule for a move's "when", in the long ET form used by the
 * approval notification and the Discord "Approved" card: the full timestamp
 * when a real crew hour exists, the DATE ALONE when it does not.
 *
 * Accepts either a bare instant (+ the flag) or a whole booking row — the row
 * form is preferred, because it lets `moveTimeKnown` see `scheduledStart` (a
 * stored start is proof of a real hour) as well as the flag.
 *
 * The decision itself lives in ONE place, `booking-display.moveTimeKnown`
 * (item R3-1), which every other surface calls too. It is fail-soft: an
 * absent/unreadable `startTimeKnown` still recognises a 00:00 ET day anchor by
 * its shape, and a real 9 AM instant can never be mistaken for one.
 *
 * Returns '' when there is no date signal at all — callers word that case
 * themselves ("your move date", "—").
 */
export function formatMoveWhen(input: Date | MoveWhenInput, startTimeKnown?: boolean | null): string {
  const b: MoveWhenInput =
    input instanceof Date
      ? { date: input, startTimeKnown }
      : startTimeKnown === undefined
        ? input
        : { ...input, startTimeKnown }
  const date = moveWhenInstant(b)
  if (!date) return ''
  return moveTimeKnown(b) ? formatEastern(date) : formatEasternDate(date)
}

// ── Calculate end time given start + estimated hours ──────────
export function calculateEndTime(start: Date, estimatedHours: number): Date {
  const end = new Date(start)
  end.setMinutes(end.getMinutes() + estimatedHours * 60 + BUFFER_MINS)
  return end
}
