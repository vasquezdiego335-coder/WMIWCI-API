// ════════════════════════════════════════════════════════════════════════════
//  discord-ui.ts — the ONE visual system for every card this app posts.
//  ------------------------------------------------------------------------
//  PURE. No prisma, no discord.js, no env, no network.
//
//  WHY THIS EXISTS. The 2026-09-20 audit found two card-rendering stacks
//  (discord.js builders in discord-rest.ts, hand-built JSON in deposit-notify.ts)
//  with different colours, footers, date formats and field orders — so one move
//  looked like four unrelated products across four channels. Everything a card
//  needs in order to LOOK like Move It Clear It now comes from here:
//
//    • TONE          semantic colours (what a colour MEANS, not where it is used)
//    • bookingStage  the status badge, derived from BookingStatus and nothing else
//    • moveDayLabel  "Tuesday, September 22" / moveTimeLabel "2:00 PM"
//    • cityState     "Orange, NJ"
//    • fieldIf       a field that does not exist when its value does not
//    • brandFooter   one footer
//
//  THERE IS NO DISCORD-ONLY STATUS SYSTEM. `bookingStage` is a VIEW of the
//  BookingStatus enum in prisma/schema.prisma. A card can never be in a state
//  the database is not in, because it has no state of its own.
//
//  SAFETY IS NOT REIMPLEMENTED HERE. Text is neutralised by the same
//  `discordSafe()` every other renderer uses (booking-display.ts), and senders
//  keep `allowed_mentions: { parse: [] }`. This module formats; it does not
//  relax either defence.
// ════════════════════════════════════════════════════════════════════════════
import { discordSafe, type EmbedField } from './booking-display'

export const BRAND = { name: 'Move It Clear It', orange: 0xff5a1f } as const

/**
 * What a colour MEANS. A card picks a tone by meaning, never a hex by taste.
 *
 *   pending   brand orange — new, or waiting on a decision
 *   success   green        — confirmed, paid, completed
 *   info      blue         — scheduled / informational / underway
 *   attention yellow       — needs a human's eyes
 *   danger    red          — cancelled, failed, urgent
 *   neutral   grey         — archived / no longer live
 */
export const TONE = {
  pending: BRAND.orange,
  success: 0x22c55e,
  info: 0x3b82f6,
  attention: 0xeab308,
  danger: 0xef4444,
  neutral: 0x6b7280,
} as const
export type Tone = keyof typeof TONE

export type Stage = {
  /** One restrained marker. The ONLY emoji a status line carries. */
  dot: string
  /** Owner-facing wording. */
  label: string
  /** Crew-facing wording — never mentions money or approval. */
  crewLabel: string
  tone: Tone
}

/**
 * The status badge for a booking — a pure function of BookingStatus.
 *
 * PENDING_APPROVAL is a REQUEST, not a job: the website's $49 is an
 * authorization (capture_method: 'manual') and nothing has been received. It
 * must never read "paid" or "confirmed". CONFIRMED is reached only after
 * approveBooking() captured the hold and committed the approval.
 */
export function bookingStage(status?: string | null): Stage {
  switch (status) {
    case 'PENDING_APPROVAL':
      return { dot: '🟠', label: 'BOOKING REQUEST', crewLabel: 'NOT CONFIRMED', tone: 'pending' }
    case 'CONFIRMED':
    case 'SCHEDULED':
      return { dot: '🟢', label: 'JOB CONFIRMED', crewLabel: 'CONFIRMED', tone: 'success' }
    case 'IN_PROGRESS':
      return { dot: '🔵', label: 'IN PROGRESS', crewLabel: 'IN PROGRESS', tone: 'info' }
    case 'COMPLETED':
      return { dot: '✅', label: 'COMPLETED', crewLabel: 'COMPLETED', tone: 'success' }
    case 'CANCELLED':
      return { dot: '🔴', label: 'CANCELLED', crewLabel: 'CANCELLED', tone: 'danger' }
    case 'ARCHIVED':
      return { dot: '⚪', label: 'ARCHIVED', crewLabel: 'ARCHIVED', tone: 'neutral' }
    default:
      // DRAFT / PENDING_PAYMENT / anything unknown: checkout has not finished.
      return { dot: '⚪', label: 'AWAITING CHECKOUT', crewLabel: 'NOT CONFIRMED', tone: 'neutral' }
  }
}

/** True once the $49 hold has actually been captured. */
export const isConfirmedStatus = (status?: string | null): boolean =>
  status === 'CONFIRMED' || status === 'SCHEDULED' || status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'ARCHIVED'

const dollars = (cents: number): string => {
  const d = cents / 100
  return `$${d.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(d) ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** "$1,250" / "$719.10" from integer cents. Null in, null out — never "$NaN". */
export function moneyFromCents(cents?: number | null): string | null {
  return typeof cents === 'number' && Number.isFinite(cents) ? dollars(cents) : null
}

/**
 * The one line that says what happened to the $49 — and it is decided by the
 * booking's STATUS, not by which Stripe event arrived.
 *
 *   PENDING_APPROVAL → "$49 authorized · awaiting approval"   (a hold; NOT money received)
 *   CONFIRMED+       → "$49 captured"
 *   CANCELLED        → "$49 hold released · not charged"
 */
export function holdLine(status: string | null | undefined, holdCents: number | null | undefined, capturedCents?: number | null): string | null {
  const hold = moneyFromCents(holdCents ?? 4900)
  if (!hold) return null
  if (status === 'PENDING_APPROVAL') return `${hold} authorized · awaiting approval`
  if (status === 'CANCELLED') return capturedCents ? `${moneyFromCents(capturedCents)} captured before cancellation` : `${hold} hold released · not charged`
  if (isConfirmedStatus(status)) return `${moneyFromCents(capturedCents || holdCents || 4900)} captured`
  return null
}

// ── Dates: human, Eastern, never ISO ────────────────────────────────────────

const ET = 'America/New_York'

const asDate = (at?: Date | string | null): Date | null => {
  if (!at) return null
  const d = at instanceof Date ? at : new Date(at)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "Tuesday, September 22" — an INSTANT read on the Eastern calendar. */
export function moveDayLabel(at?: Date | string | null): string | null {
  const d = asDate(at)
  if (!d) return null
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'long', month: 'long', day: 'numeric' }).format(d)
}

/** "2:00 PM" — Eastern. */
export function moveTimeLabel(at?: Date | string | null): string | null {
  const d = asDate(at)
  if (!d) return null
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(d)
}

// ── Places ──────────────────────────────────────────────────────────────────

/**
 * "Orange, NJ". City and state only — a street address is deliberately NOT
 * something this helper can produce, so a crew-visible card cannot leak one by
 * accident. Either part alone is still useful; neither is null.
 */
export function cityState(city?: string | null, state?: string | null): string | null {
  const c = (city ?? '').trim()
  const s = (state ?? '').trim()
  if (c && s) return `${c}, ${s}`
  return c || s || null
}

/** "Orange, NJ\n→ Philadelphia, PA" — either end may be missing. */
export function routeBlock(from?: string | null, to?: string | null): string | null {
  const a = (from ?? '').trim()
  const b = (to ?? '').trim()
  if (a && b) return `${a}\n→ ${b}`
  if (a) return a
  return b ? `→ ${b}` : null
}

// ── Fields that do not exist when their value does not ──────────────────────

const NOISE = new Set(['', 'null', 'undefined', 'n/a', 'na', 'none', '-', '—', 'unknown', 'tbd'])

/** True for the values a card must never print. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return !Number.isFinite(value)
  return NOISE.has(String(value).trim().toLowerCase())
}

/** Join the parts that have content. Never yields "undefined" or a stray newline. */
export function lines(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && !isBlank(p)).join('\n')
}

/**
 * A field, or NOTHING. This is the optional-field rule in one place: a card
 * built from `compact([...fieldIf()])` cannot show "N/A", "null", "undefined"
 * or an empty heading, because the field is never created.
 */
export function fieldIf(name: string, value: string | null | undefined | false, inline = false, max = 1024): EmbedField | null {
  if (typeof value !== 'string' || isBlank(value)) return null
  return { name, value: discordSafe(value, max), inline }
}

export const compact = (fields: Array<EmbedField | null | undefined>): EmbedField[] => fields.filter((f): f is EmbedField => !!f)

/** "Move It Clear It • Ref …1019" — one footer, everywhere. */
export function brandFooter(detail?: string | null): { text: string } {
  return { text: isBlank(detail) ? BRAND.name : `${BRAND.name} • ${discordSafe(String(detail), 120)}` }
}

/** Embed titles cap at 256 chars and are customer-influenced on some cards. */
export function safeTitle(text: string): string {
  const t = discordSafe(text, 256)
  return t.length > 256 ? `${t.slice(0, 255)}…` : t
}
