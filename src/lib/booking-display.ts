// ════════════════════════════════════════════════════════════════════════
//  booking-display.ts — the ONE place technical booking data becomes human.
//  ----------------------------------------------------------------------
//  Everything here is PURE (no prisma, no discord.js, no network) so it can
//  be unit-tested offline and shared by:
//    • app/api/bookings/route.ts     (itemsDescription builder)
//    • src/bot/discord-rest.ts       (worker job card, REST)
//    • src/bot/discord-actions.ts    (gateway duplicate of the card)
//    • app/api/discord/interactions  (in-place card updates on button press)
//
//  RULES (owner spec, 2026-07-11):
//    • Workers never see raw enums (MANUAL_REVIEW, elevator=none, …).
//    • Workers never see full database IDs — short refs only; full IDs live
//      in the admin portal (and in button custom_ids, which are invisible).
//    • Price detail on the WORKER card is limited to the labor estimate +
//      a travel-fee status; the owner approval card keeps the full breakdown.
// ════════════════════════════════════════════════════════════════════════

import { resolveBookingScope, scopeInventoryLine } from './booking-scope'

/** "1000 Executive Dr, West Orange, NJ — Unit 443A". The unit is appended, not
 *  left buried inside the street string where no filter could ever see it. */
function unitSuffixed(address: string | null | undefined, unit: string | null): string | null {
  const a = (address ?? '').trim()
  if (!a) return null
  return unit ? `${a} — Unit ${unit}` : a
}

// ── Human labels for the structured access fields ─────────────────────────
export const ELEVATOR_LABELS: Record<string, string> = {
  none: 'No elevator — stairs only',
  close: 'Elevator near the unit',
  far: 'Elevator — long walk to it',
}

export const PARKING_LABELS: Record<string, string> = {
  door: 'Truck parking at the door',
  short: 'Short carry (under 100 ft)',
  medium: 'Medium carry (100–300 ft)',
  far: 'Long carry (300 ft+)',
}

export const BUILDING_LABELS: Record<string, string> = {
  newer: 'Newer building (2000+)',
  mid: 'Building from 1980–1999',
  old: 'Older building (pre-1980)',
  unsure: 'Building age unknown',
}

export const TRUCK_OPTION_LABELS: Record<string, string> = {
  'own-truck': 'Customer-provided truck',
  'truck-pickup-return': 'Truck pickup & return — $50 collected on move day',
}

// ── Human labels for the server-computed service-area zone ────────────────
export const SERVICE_AREA_ZONE_LABELS: Record<string, string> = {
  primary: 'Primary area — no travel fee',
  extended_nj: 'Extended NJ — $50 travel fee (move day)',
  new_york: 'New York — owner review',
  manual_review: 'Owner review required',
  unsupported: 'Out of area — owner review',
}

// ── Human status labels (worker-facing; never show the raw enum) ──────────
export const BOOKING_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_PAYMENT: 'Awaiting payment',
  PENDING_APPROVAL: 'Awaiting owner approval',
  CONFIRMED: 'Scheduled',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'Job in progress',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
  CANCELLED: 'Cancelled',
}

export function statusLabel(status?: string | null): string {
  if (!status) return 'Scheduled'
  return BOOKING_STATUS_LABELS[status] ?? 'Scheduled'
}

// ── Brand status colors (Discord embed accent) ────────────────────────────
export const STATUS_COLORS = {
  scheduled: 0x0a1628, // Ink Navy
  inProgress: 0xff5a1f, // Ember Orange
  completed: 0x22c55e, // green
  archived: 0x6b7280, // muted gray
  cancelled: 0x6b7280,
  ownerReview: 0xc9a961, // Antique Gold
  attention: 0xef4444, // red — blocked/unsafe only
} as const

export function statusColor(status?: string | null, manualReview?: boolean): number {
  switch (status) {
    case 'IN_PROGRESS':
      return STATUS_COLORS.inProgress
    case 'COMPLETED':
      return STATUS_COLORS.completed
    case 'ARCHIVED':
      return STATUS_COLORS.archived
    case 'CANCELLED':
      return STATUS_COLORS.cancelled
    default:
      // A scheduled job that still needs owner review carries the gold accent.
      return manualReview ? STATUS_COLORS.ownerReview : STATUS_COLORS.scheduled
  }
}

// ── Short internal reference (never the full cuid) ────────────────────────
export function shortRef(id?: string | null): string {
  const s = (id ?? '').trim()
  if (!s) return '—'
  return s.length <= 6 ? s : `…${s.slice(-4)}`
}

// ── Money / date helpers ───────────────────────────────────────────────────
/**
 * "$699" for a whole amount, "$719.10" when there are cents.
 *
 * The cents used to be dropped entirely: a $719.10 total rendered as "$719.1",
 * which reads as a typo on a card an owner is about to approve money against.
 * Whole dollars stay whole because most of our prices are.
 */
export function moneyFromDollars(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const digits = Number.isInteger(n) ? 0 : 2
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`
}

const TZ = 'America/New_York'

/** "Sat, Jul 12 · 4:00 PM" in Eastern time. */
export function jobDateTime(date?: Date | string | null): string {
  if (!date) return 'Date to be confirmed'
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return 'Date to be confirmed'
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
  return `${day} · ${time}`
}

/** "4:08 PM" in Eastern time — for "Started by Diego · 4:08 PM". */
export function timeOfDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(date)
}

/** Like timeOfDay but tolerates a string/Date/null (job-card waiting timestamps). */
export function timeLabel(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : timeOfDay(d)
}

// ── Discord-safe text ──────────────────────────────────────────────────────
/** Neutralize mass mentions and cap length. Keeps normal punctuation intact. */
export function discordSafe(text: string, max = 1024): string {
  const cleaned = text
    .replace(/@(everyone|here)/g, '@​$1') // zero-width break kills the ping
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .trim()
  if (cleaned.length <= max) return cleaned
  const suffix = ' … (full notes in the admin portal)'
  return cleaned.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix
}

// ── Legacy access-blob humanizer ───────────────────────────────────────────
// Older bookings carry frontend-generated text like:
//   "Access: stairs, elevator=none, parking=door, building=newer | Est. $699 (base $699 + add-ons $0)"
// plus a MANUAL_REVIEW warning line. New bookings are written clean, but every
// card renderer runs this so historical bookings display human text too.
const LEGACY_TOKEN_MAP: Array<[RegExp, string]> = [
  [/elevator=none/gi, 'No elevator'],
  [/elevator=close/gi, 'Elevator near the unit'],
  [/elevator=far/gi, 'Elevator far from the unit'],
  [/elevator=n\/a/gi, ''],
  [/parking=door/gi, 'Truck parking at the door'],
  [/parking=short/gi, 'Short carry from parking'],
  [/parking=medium/gi, 'Medium carry from parking'],
  [/parking=far/gi, 'Long carry from parking'],
  [/parking=n\/a/gi, ''],
  [/building=newer/gi, 'Newer building'],
  [/building=mid/gi, 'Building from 1980–1999'],
  [/building=old/gi, 'Older building'],
  [/building=(unsure|n\/a)/gi, ''],
  [/\bMANUAL[_ ]REVIEW\b/g, 'Owner review required'],
  [/\bNEW[_ ]YORK\b/g, 'New York'],
  [/\bUNSUPPORTED\b/g, 'Out of area'],
  [/\bCUSTOMER_PROVIDES\b/gi, 'Customer-provided truck'],
]

export function humanizeLegacyAccess(text: string): string {
  let out = text
  for (const [re, replacement] of LEGACY_TOKEN_MAP) out = out.replace(re, replacement)
  // Collapse leftovers from removed tokens ("…, , …") and stray separators.
  return out
    .replace(/,\s*(?=,)/g, '')
    .replace(/(:\s*),/g, '$1')
    .replace(/,\s*\|/g, ' |')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── Crew-notes cleanup ─────────────────────────────────────────────────────
// The booking description (itemsDescription) mixes operational lines the card
// already shows as fields (Service:, Truck:, Source:, photo counts, service-
// area verdicts) with the customer's actual notes. Extract just the parts a
// crew needs to read, deduplicating repeated sentences.
const NOISE_LINE = /^(service:|truck:|truck add-on|source:|📷|service area:|extended service-area fee|⚠ service area|additional pickup|note: stairs, long walks|customer-side estimate|stairs:|long walk:|heavy items:|elevator:|parking:|building:)/i

export function crewNotesFromDescription(description?: string | null): string {
  if (!description) return ''
  const lines = description
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE_LINE.test(l))
    .map((l) => l.replace(/^notes:\s*/i, ''))
    .map(humanizeLegacyAccess)
    // Legacy bookings folded "— Access: … | Est. $x (base $y + add-ons $z)" into
    // the notes — the access list gets its own field and the estimate belongs
    // to the owner card, not the crew.
    .map((l) => l.replace(/\|?\s*Est\.\s*\$\d[\d,]*\s*\(base[^)]*\)/gi, '').trim())
    .map((l) => l.replace(/[—-]?\s*Access:\s*[^|]*\|?/gi, '').trim())
    .filter(Boolean)

  // Dedupe repeated sentences (the "Facebook messages" repetition bug):
  //   1. sentences that all say "details were agreed over <channel> messages"
  //      collapse into ONE canonical line, and
  //   2. exact-normalized duplicates keep only their first occurrence.
  const CHANNEL_NOTE = /\b(facebook|instagram|whatsapp|text)\b.*\bmessages?\b|\bmessages?\b.*\b(facebook|instagram|whatsapp|text)\b/i
  const seen = new Set<string>()
  const out: string[] = []
  let channelNoted = false
  for (const line of lines) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim()
      if (!trimmed) continue
      if (CHANNEL_NOTE.test(trimmed) && /\b(details?|specified|as per|confirmed|discussed)\b/i.test(trimmed)) {
        if (!channelNoted) {
          const channel = trimmed.match(/\b(facebook|instagram|whatsapp|text)\b/i)?.[1] ?? 'customer'
          out.push(`Job details were confirmed through ${channel[0].toUpperCase()}${channel.slice(1).toLowerCase()} messages.`)
          channelNoted = true
        }
        continue
      }
      const norm = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      out.push(trimmed)
    }
  }
  return out.join('\n')
}

// ── Access summary (worker card bullet list) ───────────────────────────────
export type AccessInfo = {
  stairs?: boolean
  longWalk?: boolean
  heavyItems?: boolean
  elevatorAccess?: string | null
  parkingDistance?: string | null
  buildingYear?: string | null
}

export function accessBullets(access: AccessInfo): string[] {
  const bullets: string[] = []
  if (access.stairs) bullets.push('Stairs — flights to carry up or down')
  if (access.heavyItems) bullets.push('Heavy items on this job')
  if (access.elevatorAccess && ELEVATOR_LABELS[access.elevatorAccess]) {
    bullets.push(ELEVATOR_LABELS[access.elevatorAccess])
  }
  if (access.longWalk) bullets.push('Long walk from door to truck')
  if (access.parkingDistance && PARKING_LABELS[access.parkingDistance]) {
    const label = PARKING_LABELS[access.parkingDistance]
    // "Long walk" + "Long carry" would read twice — keep the more specific one.
    if (!(access.longWalk && access.parkingDistance !== 'door')) bullets.push(label)
    else bullets[bullets.length - 1] = label
  }
  if (access.buildingYear && BUILDING_LABELS[access.buildingYear]) {
    bullets.push(BUILDING_LABELS[access.buildingYear])
  }
  return bullets
}

// ── Access bullets straight from itemsDescription ─────────────────────────
// New bookings write human lines ("Elevator: No elevator — stairs only").
// Legacy bookings folded a raw blob into the notes ("Access: stairs,
// elevator=none, parking=door, building=newer | Est. $699 …"). Both render
// as the same clean bullet list.
const ACCESS_LINE = /^(stairs|long walk|heavy items|elevator|parking|building):\s*(.+)$/i

export function accessBulletsFromDescription(description?: string | null): string[] {
  if (!description) return []
  const bullets: string[] = []
  const push = (b: string): void => {
    const clean = b.trim().replace(/[.,;]$/, '')
    if (clean && !bullets.some((x) => x.toLowerCase() === clean.toLowerCase())) bullets.push(clean)
  }

  for (const raw of description.split('\n')) {
    const line = raw.trim()
    const m = line.match(ACCESS_LINE)
    if (m) {
      const kind = m[1].toLowerCase()
      const value = m[2].trim()
      if (kind === 'stairs') push('Stairs — flights to carry up or down')
      else if (kind === 'long walk') push('Long walk from door to truck')
      else if (kind === 'heavy items') push('Heavy items — piano, safe, appliances, or dense furniture')
      else push(value) // elevator / parking / building lines already carry the full label
      continue
    }
    // Legacy blob inside a notes line.
    const legacy = line.match(/Access:\s*([^|]+)/i)
    if (legacy) {
      for (const token of humanizeLegacyAccess(legacy[1]).split(',')) {
        const t = token.trim()
        if (!t) continue
        if (/^stairs$/i.test(t)) push('Stairs — flights to carry up or down')
        else if (/^long walk$/i.test(t)) push('Long walk from door to truck')
        else if (/^heavy items$/i.test(t)) push('Heavy items on this job')
        else push(t)
      }
    }
  }
  return bullets
}

// ── Service / truck labels straight from itemsDescription ─────────────────
export function serviceLabelFromDescription(description?: string | null): string | null {
  // "Move Size:" is the current wording; "Service:" is what every booking
  // taken before 2026-08-14 carries. Both are the SIZE, never a truck claim.
  const m = (description ?? '').match(/^(?:Move\s*Size|Service):\s*(.+)$/im)
  return m ? m[1].trim() : null
}

export function truckLabelFromDescription(description?: string | null): string | null {
  const m = (description ?? '').match(/^Truck(?:\s*Provider)?:\s*(.+)$/im)
  if (!m) return null
  const v = m[1].trim()
  if (/customer provides/i.test(v)) return TRUCK_OPTION_LABELS['own-truck']
  if (/pickup\s*&(amp;)?\s*return/i.test(v)) return TRUCK_OPTION_LABELS['truck-pickup-return']
  return humanizeLegacyAccess(v)
}

// ── Discord embed / component JSON types (plain JSON — no discord.js dep) ──
export type EmbedField = { name: string; value: string; inline?: boolean }
export type EmbedJson = {
  title?: string
  description?: string
  url?: string
  color?: number
  fields?: EmbedField[]
  image?: { url: string }
  footer?: { text: string }
  timestamp?: string
}
type ButtonJson = {
  type: 2
  style: number
  label: string
  custom_id?: string
  url?: string
  disabled?: boolean
}
type ActionRowJson = { type: 1; components: ButtonJson[] }

const BTN = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 } as const

// ── The worker dispatch card ("MOVE DAY JOB") ──────────────────────────────
export type JobCardData = {
  bookingId: string
  displayId?: string | null
  status?: string | null // BookingStatus
  customerName?: string | null
  customerPhone?: string | null
  serviceType?: string | null // human label, e.g. "2 Bedrooms"
  moveDate?: Date | string | null
  originAddress?: string | null
  destAddress?: string | null
  truckOptionLabel?: string | null
  access?: AccessInfo
  crewNotes?: string | null // already-humanized notes (or raw description → we clean)
  rawDescription?: string | null // fallback when structured fields are absent
  photoCount?: number
  laborEstimate?: number | null // dollars — base labor only
  travelFeePending?: boolean // manual review → fee not final
  travelFeeDollars?: number | null // fixed fee (extended NJ)
  manualReviewRequired?: boolean
  adminUrl?: string | null
  // Move-day audit trail, shown under Status.
  startedBy?: string | null
  startedAtLabel?: string | null
  completedBy?: string | null
  completedAtLabel?: string | null
  // Waiting-time (Late Arrival & Delay Policy). Timestamps drive the buttons;
  // waitingSummary is a pre-rendered human line (fee math from waiting-time.ts).
  crewArrivedAt?: Date | string | null
  customerReadyAt?: Date | string | null
  waitingStartedAt?: Date | string | null
  waitingEndedAt?: Date | string | null
  waitingSummary?: string | null
}

function field(name: string, value: string, inline = false): EmbedField {
  return { name, value: discordSafe(value, 1024) || '—', inline }
}

function mapsUrl(address?: string | null): string | null {
  const a = (address ?? '').trim()
  if (!a || /provided at confirmation/i.test(a)) return null
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a)}`
}

/** Build the worker-facing dispatch embed + buttons for the current status. */
export function buildJobCard(data: JobCardData): { embeds: EmbedJson[]; components: ActionRowJson[] } {
  const status = data.status ?? 'CONFIRMED'
  const manualReview = !!data.manualReviewRequired

  const fields: EmbedField[] = []

  fields.push(field('Customer', data.customerName || 'Name pending', true))
  fields.push(field('Service', data.serviceType || 'Move — details in admin', true))
  fields.push(field('Date & Time', jobDateTime(data.moveDate), true))

  fields.push(field('Pickup', data.originAddress || 'Address pending — check admin', true))
  fields.push(field('Destination', data.destAddress || 'Address pending — check admin', true))
  if (data.customerPhone) fields.push(field('Customer Phone', data.customerPhone, true))

  fields.push(field('Truck', data.truckOptionLabel || TRUCK_OPTION_LABELS['own-truck']))

  const bullets =
    data.access && Object.values(data.access).some(Boolean)
      ? accessBullets(data.access)
      : accessBulletsFromDescription(data.rawDescription)
  if (bullets.length) fields.push(field('Access', bullets.map((b) => `• ${b}`).join('\n')))

  const notes = (data.crewNotes ?? crewNotesFromDescription(data.rawDescription)).trim()
  if (notes) fields.push(field('Crew Notes', notes))

  fields.push(
    field('Photos', data.photoCount ? `${data.photoCount} available — open the admin portal to view` : 'None uploaded', true)
  )

  // Worker-visible money: labor estimate + travel status only. No breakdowns.
  if (typeof data.laborEstimate === 'number' && data.laborEstimate > 0) {
    fields.push(field('Estimated Labor', moneyFromDollars(data.laborEstimate) ?? '—', true))
  }
  if (manualReview || data.travelFeePending) {
    fields.push(field('Travel Fee', 'Pending owner review', true))
  } else if (typeof data.travelFeeDollars === 'number' && data.travelFeeDollars > 0) {
    fields.push(field('Travel Fee', `${moneyFromDollars(data.travelFeeDollars)} — collected on move day`, true))
  }

  const statusLines = [statusLabel(status)]
  if (data.startedBy) statusLines.push(`Started by ${data.startedBy}${data.startedAtLabel ? ` · ${data.startedAtLabel}` : ''}`)
  if (data.completedBy) statusLines.push(`Completed by ${data.completedBy}${data.completedAtLabel ? ` · ${data.completedAtLabel}` : ''}`)
  fields.push(field('Status', statusLines.join('\n'), true))

  // Waiting-time — only surfaced once the crew logs an arrival/waiting event.
  const waitingLines: string[] = []
  if (data.crewArrivedAt) waitingLines.push(`Arrived · ${timeLabel(data.crewArrivedAt)}`)
  if (data.waitingStartedAt)
    waitingLines.push(`Waiting started · ${timeLabel(data.waitingStartedAt)}${data.waitingEndedAt ? ` → ended ${timeLabel(data.waitingEndedAt)}` : ' (running)'}`)
  if (data.customerReadyAt) waitingLines.push(`Customer ready · ${timeLabel(data.customerReadyAt)}`)
  if (data.waitingSummary) waitingLines.push(data.waitingSummary)
  if (waitingLines.length) fields.push(field('Waiting Time', waitingLines.join('\n')))

  const descriptionParts: string[] = []
  if (manualReview && status !== 'COMPLETED' && status !== 'ARCHIVED') {
    descriptionParts.push(
      '🟡 **Owner Review Required**\nTravel pricing has not been finalized. Do not promise or discuss a final travel fee with the customer.'
    )
  }
  if (status === 'IN_PROGRESS') {
    descriptionParts.push('Tap **Complete Job** after the customer confirms the move is finished.')
  } else if (status === 'COMPLETED') {
    descriptionParts.push('Move finished. Archive this card once paperwork is done.')
  } else if (status !== 'ARCHIVED' && status !== 'CANCELLED') {
    descriptionParts.push('Tap **Start Job** when labor begins. Tap **Complete Job** after the customer confirms the move is finished.')
  }

  const rawTitle = `🚚 Move Day Job — ${data.customerName || 'Customer'}`.replace(/@(everyone|here)/g, '@​$1')
  const embed: EmbedJson = {
    title: rawTitle.length > 256 ? rawTitle.slice(0, 255) + '…' : rawTitle,
    color: statusColor(status, manualReview),
    description: descriptionParts.join('\n\n') || undefined,
    fields,
    footer: { text: `Ref ${shortRef(data.displayId || data.bookingId)} · full details in the admin portal` },
    timestamp: new Date().toISOString(),
  }

  return { embeds: [embed], components: jobCardButtons(data) }
}

function jobCardButtons(data: JobCardData): ActionRowJson[] {
  const id = data.bookingId
  const status = data.status ?? 'CONFIRMED'

  const actionRow: ButtonJson[] = []
  if (status === 'CONFIRMED' || status === 'SCHEDULED' || status === 'PENDING_APPROVAL') {
    actionRow.push({ type: 2, style: BTN.primary, label: '▶ Start Job', custom_id: `job_start:${id}` })
    actionRow.push({ type: 2, style: BTN.success, label: '✅ Complete Job', custom_id: `job_complete:${id}` })
  } else if (status === 'IN_PROGRESS') {
    actionRow.push({ type: 2, style: BTN.success, label: '✅ Complete Job', custom_id: `job_complete:${id}` })
  } else if (status === 'COMPLETED') {
    actionRow.push({ type: 2, style: BTN.secondary, label: '🗃 Archive', custom_id: `archive_job:${id}` })
  }

  // ── Waiting-time crew row (Late Arrival & Delay Policy) ──────────────────
  //    Shown while the job is live (before it's completed/archived/cancelled).
  //    Each tap stamps a timestamp; the fee is derived in waiting-time.ts.
  const waitingRow: ButtonJson[] = []
  const jobLive = status !== 'COMPLETED' && status !== 'ARCHIVED' && status !== 'CANCELLED'
  if (jobLive) {
    if (!data.crewArrivedAt) {
      waitingRow.push({ type: 2, style: BTN.secondary, label: '📍 Arrived', custom_id: `crew_arrived:${id}` })
    }
    if (!data.waitingStartedAt) {
      waitingRow.push({ type: 2, style: BTN.secondary, label: '⏳ Waiting Started', custom_id: `waiting_start:${id}` })
    } else if (!data.waitingEndedAt && !data.customerReadyAt) {
      waitingRow.push({ type: 2, style: BTN.primary, label: '⏹ Waiting Ended', custom_id: `waiting_end:${id}` })
    }
    if (!data.customerReadyAt) {
      waitingRow.push({ type: 2, style: BTN.success, label: '👍 Customer Ready', custom_id: `customer_ready:${id}` })
    }
  }

  const linkRow: ButtonJson[] = []
  // Before the job starts the crew drives to the PICKUP; once in progress the
  // next drive is to the DESTINATION.
  const navTarget = status === 'IN_PROGRESS' ? data.destAddress : data.originAddress
  const nav = mapsUrl(navTarget)
  if (nav && status !== 'COMPLETED' && status !== 'ARCHIVED') {
    linkRow.push({ type: 2, style: BTN.link, label: '🗺 Open Navigation', url: nav })
  }
  if (data.adminUrl) {
    linkRow.push({ type: 2, style: BTN.link, label: '🔎 Open in Admin', url: data.adminUrl })
  }

  const rows: ActionRowJson[] = []
  if (actionRow.length) rows.push({ type: 1, components: actionRow })
  if (waitingRow.length) rows.push({ type: 1, components: waitingRow })
  if (linkRow.length) rows.push({ type: 1, components: linkRow })
  return rows
}

// ════════════════════════════════════════════════════════════════════════
//  The OWNER approval card ("🚛 New Booking")
//  ----------------------------------------------------------------------
//  The premium, FULL-DETAIL card the owner acts on the moment a $49 hold is
//  authorized. Unlike the worker job card this hides nothing: both addresses,
//  the whole pricing + service-area breakdown, Stripe references, the
//  customer's exact notes, photos, and a "View Full Booking" button for the
//  untruncated record. Pure JSON (no prisma / discord.js) so the REST worker,
//  the gateway bot, and the reschedule re-post all render the SAME card, and
//  it can be unit-tested offline.
// ════════════════════════════════════════════════════════════════════════
export type ApprovalCardData = {
  bookingId: string
  displayId?: string | null
  status?: string | null
  rescheduled?: boolean
  // Customer
  customerName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  // Move
  requestedDate?: Date | string | null
  serviceType?: string | null // human label; falls back to parsing rawDescription
  truckOptionLabel?: string | null
  // ── The three separate facts (owner spec 2026-08-14, WMIC-1019) ─────────
  //    "Service: 1 Bedroom / Truck: Customer-provided" read as a bedroom
  //    package that happened to mention a truck. It is a LABOR ONLY job of
  //    1-bedroom size on the customer's truck — three answers, shown as three.
  serviceHeadline?: string | null // "LABOR ONLY" / "FULL SERVICE"
  moveSizeLabel?: string | null // "2 Bedrooms" — size only, never a truck claim
  truckProviderLabel?: string | null // "Customer" / "Move It Clear It"
  /** The unresolved-scope banners, most serious first. */
  scopeAlerts?: { banner: string; detail: string }[]
  /** The one-paragraph brief; rendered at the very top of the embed. */
  alertParagraph?: string | null
  /** Disclosed inventory, one line. */
  inventoryLine?: string | null
  originAddress?: string | null
  destAddress?: string | null
  access?: AccessInfo
  rawDescription?: string | null // itemsDescription — source for access bullets + notes
  customerNotes?: string | null // explicit column, preferred over parsed notes when set
  // Pricing (dollars unless the field name says cents)
  baseRate?: number | null
  travelFeeDollars?: number | null
  truckAddonDueOnMoveDay?: boolean
  truckAddonAmountCents?: number | null
  discountType?: string | null
  discountCode?: string | null
  discountPercent?: number | null
  depositDollars?: number | null
  depositPaid?: boolean
  /** DOLLARS. THE final total: quote + add-ons − discount. */
  moveTotal?: number | null
  /** DOLLARS. What the discount actually took off. */
  discountDollars?: number | null
  /** DOLLARS. Captured so far. An authorized hold is NOT captured. */
  collectedDollars?: number | null
  /** DOLLARS. What remains once the $49 authorization is captured. */
  balanceAfterJob?: number | null
  // Service area
  serviceAreaZone?: string | null
  manualReviewRequired?: boolean
  serviceAreaMessage?: string | null
  /** Readable reasons this booking needs the owner's eyes — piano, difficult
   *  elevator, unverified address, unpriced package. Built server-side by
   *  buildReviewReasons() in app/api/bookings/route.ts. Shown verbatim. */
  reviewReasons?: string[] | null
  // Access difficulty the customer declared (review triggers, never auto-priced)
  difficultElevatorPickup?: boolean | null
  difficultElevatorDropoff?: boolean | null
  difficultBuildingPickup?: boolean | null
  difficultBuildingDropoff?: boolean | null
  /** Customer attested the inventory/access details are accurate. */
  inventoryAccuracyConfirmed?: boolean | null
  // Stripe
  paymentStatusLabel?: string | null
  stripePaymentIntentId?: string | null
  stripeCheckoutId?: string | null
  stripeChargeId?: string | null
  receiptUrl?: string | null
  // Agreement
  agreementAccepted?: boolean
  agreementVersion?: string | null
  agreementName?: string | null
  agreementAcceptedAt?: Date | string | null
  // Meta
  source?: string | null
  foundUs?: string | null
  photoCount?: number
  photos?: { url: string }[] // up to 4 rendered as an inline gallery
  adminUrl?: string | null
  includeActionButtons?: boolean // Approve/Offer/Deny (default true)
  warnings?: string[] // missing-info lines (from bookingCompleteness), owner-facing
}

const GALLERY_URL = 'https://www.moveitclearit.com'

/** Build the owner-facing premium approval embed + buttons. */
export function buildBookingApprovalCard(data: ApprovalCardData): {
  embeds: EmbedJson[]
  components: ActionRowJson[]
} {
  const money = (n: unknown): string | null => moneyFromDollars(n)
  const fields: EmbedField[] = []

  // 1) Customer
  fields.push(
    field(
      '👤 Customer',
      [data.customerName ? `**${data.customerName}**` : '', data.customerPhone ?? '', data.customerEmail ?? '']
        .filter(Boolean)
        .join('\n') || 'Name pending',
      true
    )
  )

  // 2) Move — the SERVICE, the SIZE and the TRUCK as three separate lines.
  //    They used to be one ("1 Bedroom") plus a truck footnote, which is how a
  //    job on the customer's own U-Haul read as a full-service bedroom package.
  const moveLines: string[] = [jobDateTime(data.requestedDate)]
  if (data.serviceHeadline) {
    moveLines.push(`**${data.serviceHeadline}**`)
    if (data.moveSizeLabel) moveLines.push(`Move size: ${data.moveSizeLabel}`)
    else moveLines.push('Move size: not selected')
    moveLines.push(`🚚 Truck: ${data.truckProviderLabel || 'Not confirmed'}`)
  } else {
    // Degraded path (the booking row was unavailable): whatever the payload had.
    moveLines.push(data.serviceType || serviceLabelFromDescription(data.rawDescription) || 'Service in details')
    moveLines.push(`🚚 ${data.truckOptionLabel || truckLabelFromDescription(data.rawDescription) || TRUCK_OPTION_LABELS['own-truck']}`)
  }
  fields.push(field('📅 Move', moveLines.filter(Boolean).join('\n'), true))

  // 3) Agreement
  fields.push(
    field(
      '📜 Agreement',
      data.agreementAccepted
        ? `✅ Accepted${data.agreementVersion ? ` (${data.agreementVersion})` : ''}` +
            (data.agreementName ? `\nby **${data.agreementName}**` : '')
        : '⚠️ NOT accepted',
      true
    )
  )

  // 4/5) Pickup + Dropoff — the addresses the old card dropped entirely.
  fields.push(field('📍 Pickup', data.originAddress || 'Provided at confirmation', true))
  fields.push(field('📍 Dropoff', data.destAddress || 'Provided at confirmation', true))

  // 6) Access details
  const bullets =
    data.access && Object.values(data.access).some(Boolean)
      ? accessBullets(data.access)
      : accessBulletsFromDescription(data.rawDescription)
  if (bullets.length) fields.push(field('🔑 Access', bullets.map((b) => `• ${b}`).join('\n')))

  // 7) Pricing — the full owner breakdown, ending on ONE final total.
  //
  //    This block used to print the discount as a note ("MOVE10 10% off") and
  //    then a "Move total" that ignored it, followed by a "Balance after job"
  //    of total − deposit. On WMIC-1019 that read $550 and $501 for a booking
  //    the admin correctly showed as $495. Every figure below now comes from
  //    the canonical calculation in booking-quote.ts.
  const priceLines: string[] = []
  if (typeof data.baseRate === 'number' && data.baseRate > 0) priceLines.push(`Base labor: ${money(data.baseRate)}`)
  if (data.manualReviewRequired) priceLines.push('Travel fee: Pending owner review')
  else if (typeof data.travelFeeDollars === 'number' && data.travelFeeDollars > 0)
    priceLines.push(`Travel fee: ${money(data.travelFeeDollars)} — collected on move day`)
  if (data.truckAddonDueOnMoveDay)
    priceLines.push(`Truck pickup & return: ${money((data.truckAddonAmountCents ?? 5000) / 100)} — crew labor, collected on move day`)
  if (data.discountCode || data.discountType) {
    const parts = [
      data.discountCode ? `\`${data.discountCode}\`` : null,
      typeof data.discountPercent === 'number' && data.discountPercent > 0 ? `${data.discountPercent}% off` : null,
      data.discountType ? `(${data.discountType})` : null,
    ].filter(Boolean)
    const applied = typeof data.discountDollars === 'number' && data.discountDollars > 0
      ? ` −${money(data.discountDollars)}`
      : ''
    priceLines.push(`Discount: ${parts.join(' ')}${applied}`)
  }
  // THE number. Bold, because it is the one an owner acts on.
  if (typeof data.moveTotal === 'number') priceLines.push(`**Final total: ${money(data.moveTotal)}**`)

  // The deposit is APPLIED toward that total, never added to it.
  const depositDollars = data.depositDollars ?? 49
  const collected = data.collectedDollars ?? 0
  if (data.depositPaid || collected > 0) {
    priceLines.push(`Deposit paid: ${money(Math.min(depositDollars, collected) || depositDollars)}`)
    if (typeof data.balanceAfterJob === 'number')
      priceLines.push(`Remaining move-day balance: ${money(data.balanceAfterJob)}`)
  } else {
    priceLines.push(`Deposit authorized: ${money(depositDollars)} — captured on approval`)
    priceLines.push(`Amount captured so far: ${money(collected)}`)
    if (typeof data.balanceAfterJob === 'number')
      priceLines.push(`Remaining after capture: ${money(data.balanceAfterJob)}`)
  }
  fields.push(field('💰 Pricing', priceLines.join('\n')))

  // 8) Stripe references
  const stripeLines: string[] = [data.paymentStatusLabel || '🔒 $49 hold authorized (captured on approval)']
  if (data.stripePaymentIntentId) stripeLines.push(`Payment Intent: \`${shortRef(data.stripePaymentIntentId)}\``)
  if (data.stripeCheckoutId) stripeLines.push(`Checkout Session: \`${shortRef(data.stripeCheckoutId)}\``)
  if (data.stripeChargeId) stripeLines.push(`Charge: \`${shortRef(data.stripeChargeId)}\``)
  fields.push(field('💳 Stripe', stripeLines.join('\n'), true))

  // 7-bis) UNRESOLVED SCOPE. Full width, immediately under the money, because
  //        every one of these can change the money. Each banner is the owner's
  //        own wording ("⚠️ INVENTORY EXCEEDS SELECTED MOVE SIZE …") with one
  //        sentence of detail underneath.
  const scopeAlerts = (data.scopeAlerts ?? []).filter((a) => a && a.banner)
  if (scopeAlerts.length) {
    fields.push(
      field(
        '🚨 Before You Approve',
        scopeAlerts.map((a) => `**${a.banner}**\n${a.detail}`).join('\n\n'),
        false
      )
    )
  }

  if (data.inventoryLine) fields.push(field('📦 Disclosed Inventory', data.inventoryLine, false))

  // 8-bis) WHY this needs review. Full width and directly above the buttons the
  //        owner is about to press — a bare "⚠️ Owner review required" told them
  //        THAT a job needed review but never WHY, so they re-derived it by hand
  //        from the notes. Reasons are pre-worded server-side; shown verbatim.
  const reviewReasons = (data.reviewReasons ?? []).filter((r) => !!r && r.trim())
  if (reviewReasons.length) {
    fields.push(
      field(
        '⚠️ Owner Review Required',
        reviewReasons.map((r) => `• ${r}`).join('\n'),
        false // full width — these are sentences, not a two-column stat
      )
    )
  }

  // 8-ter) Access difficulty + the inventory attestation. Separate from the
  //        reasons above because the crew needs these even when the owner has
  //        already cleared the review.
  const accessFlags: string[] = []
  if (data.difficultElevatorPickup) accessFlags.push('⚠️ Difficult elevator — pickup')
  if (data.difficultElevatorDropoff) accessFlags.push('⚠️ Difficult elevator — destination')
  if (data.difficultBuildingPickup) accessFlags.push('⚠️ Difficult building access — pickup')
  if (data.difficultBuildingDropoff) accessFlags.push('⚠️ Difficult building access — destination')
  if (data.inventoryAccuracyConfirmed === true) accessFlags.push('✅ Customer confirmed inventory is accurate')
  else if (data.inventoryAccuracyConfirmed === false) accessFlags.push('❔ Inventory accuracy NOT confirmed')
  if (accessFlags.length) {
    fields.push(field('🚪 Access Difficulty', accessFlags.join('\n'), false))
  }

  // 9) Service area (only when it needs the owner's eyes)
  if (data.serviceAreaZone || data.manualReviewRequired) {
    const zone = data.serviceAreaZone ? SERVICE_AREA_ZONE_LABELS[data.serviceAreaZone] ?? data.serviceAreaZone : null
    fields.push(
      field(
        '🧭 Service Area',
        [zone, data.manualReviewRequired ? '⚠️ Owner review required' : null, data.serviceAreaMessage]
          .filter(Boolean)
          .join('\n') || '—',
        true
      )
    )
  }

  // 10) Source / found-us
  if (data.source || data.foundUs) {
    fields.push(
      field(
        '🌐 Source',
        [data.foundUs ? `Found us: ${data.foundUs}` : null, data.source ? `Ref: ${data.source}` : null]
          .filter(Boolean)
          .join('\n'),
        true
      )
    )
  }

  // 11) Notes — the customer's exact words, full text (not the mixed blob).
  const notes = (data.customerNotes?.trim() || crewNotesFromDescription(data.rawDescription)).trim()
  if (notes) fields.push(field('📝 Customer Notes', notes))

  // 12) Photos — links here; up to 4 render as a gallery below.
  const photos = data.photos ?? []
  const photoCount = data.photoCount ?? photos.length
  if (photoCount) {
    const links = photos.length
      ? photos.map((p, i) => `[Photo ${i + 1}](${p.url})`).join(' · ')
      : 'Open the dashboard to view'
    fields.push(field(`📷 Job Photos (${photoCount})`, links, true))
  }

  // 13) Missing-info warnings (from bookingCompleteness) — surfaced so the owner
  //     never approves an undispatchable/mispriced booking without seeing it.
  if (data.warnings && data.warnings.length) {
    fields.push(field('⚠️ Needs Attention', data.warnings.map((w) => `• ${w}`).join('\n')))
  }

  const descriptionParts: string[] = []
  // The whole problem in one breath, above everything else on the card.
  if (data.alertParagraph) descriptionParts.push(`**${data.alertParagraph}**`)
  if (data.rescheduled) descriptionParts.push('🔁 **Rescheduled by the customer** — approve for the new date.')
  if (data.manualReviewRequired)
    descriptionParts.push(
      '🟡 **Owner review required** — travel pricing is not finalized. Do not confirm a final travel fee with the customer yet.'
    )

  const rawTitle = `🚛 New Booking — ${data.displayId || shortRef(data.bookingId)}`
  const embed: EmbedJson = {
    title: rawTitle.length > 256 ? rawTitle.slice(0, 255) + '…' : rawTitle,
    color: statusColor(data.status ?? 'PENDING_APPROVAL', data.manualReviewRequired),
    description: descriptionParts.join('\n\n') || undefined,
    fields,
    footer: { text: `Booking ID: ${data.bookingId}` },
    timestamp: new Date().toISOString(),
  }

  const embeds: EmbedJson[] = [embed]
  if (photos.length) {
    // Discord merges embeds that share a `url` into one image gallery.
    embed.url = GALLERY_URL
    for (const p of photos.slice(0, 4)) {
      embeds.push({ url: GALLERY_URL, image: { url: p.url } })
    }
  }

  return { embeds, components: approvalCardButtons(data) }
}

function approvalCardButtons(data: ApprovalCardData): ActionRowJson[] {
  const id = data.bookingId
  const rows: ActionRowJson[] = []

  // Owner decision buttons (custom_id → interactions route).
  if (data.includeActionButtons !== false) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: BTN.success, label: '✅ Approve', custom_id: `approve_booking:${id}` },
        { type: 2, style: BTN.primary, label: '📅 Offer New Dates', custom_id: `offer_reschedule:${id}` },
        { type: 2, style: BTN.danger, label: '❌ Deny', custom_id: `deny_booking:${id}` },
      ],
    })
  }

  // Link shortcuts — this is what makes Discord the dashboard.
  const linkRow: ButtonJson[] = []
  const pickup = mapsUrl(data.originAddress)
  const dropoff = mapsUrl(data.destAddress)
  if (pickup) linkRow.push({ type: 2, style: BTN.link, label: '🗺 Maps · Pickup', url: pickup })
  if (dropoff) linkRow.push({ type: 2, style: BTN.link, label: '🗺 Maps · Dropoff', url: dropoff })
  if (data.adminUrl) linkRow.push({ type: 2, style: BTN.link, label: '🔎 Dashboard', url: data.adminUrl })
  if (data.receiptUrl) linkRow.push({ type: 2, style: BTN.link, label: '🧾 Receipt', url: data.receiptUrl })
  if (linkRow.length) rows.push({ type: 1, components: linkRow.slice(0, 5) })

  // The untruncated record (owner-only ephemeral, handled in the interactions route).
  rows.push({
    type: 1,
    components: [{ type: 2, style: BTN.secondary, label: '📄 View Full Booking', custom_id: `view_full_booking:${id}` }],
  })

  return rows
}

// ── Map a persisted booking (+ customer) → ApprovalCardData ────────────────
// Duck-typed on purpose: this module stays free of a Prisma import, so the
// renderer, the reschedule re-post, and the tests all build the card from a
// plain object. Callers pass the extra render-time bits (photos, admin URL,
// captured charge/receipt) via `opts`.
export type ApprovalBookingInput = {
  id: string
  displayId?: string | null
  status?: string | null
  originAddress?: string | null
  destAddress?: string | null
  itemsDescription?: string | null
  customerNotes?: string | null
  requestedDate?: Date | string | null
  baseRate?: number | null
  totalEstimate?: number | null
  travelFee?: number | null // cents
  truckAddonDueOnMoveDay?: boolean | null
  truckAddonAmount?: number | null // cents
  discountType?: string | null
  discountCode?: string | null
  discountPercent?: number | null
  depositAmount?: number | null // cents
  depositPaid?: boolean | null
  serviceAreaZone?: string | null
  manualReviewRequired?: boolean | null
  serviceAreaMessage?: string | null
  reviewReasons?: string[] | null
  difficultElevatorPickup?: boolean | null
  difficultElevatorDropoff?: boolean | null
  difficultBuildingPickup?: boolean | null
  difficultBuildingDropoff?: boolean | null
  inventoryAccuracyConfirmed?: boolean | null
  stripePaymentIntentId?: string | null
  stripeCheckoutId?: string | null
  agreementAccepted?: boolean | null
  agreementVersion?: string | null
  agreementName?: string | null
  agreementAcceptedAt?: Date | string | null
  source?: string | null
  foundUs?: string | null
  customer?: { name?: string | null; email?: string | null; phone?: string | null } | null
  // ── The labor-only booking shape (owner spec 2026-08-14). All optional:
  //    a historical row carries none of them and service-shape.ts derives the
  //    answer from truckProvider + the "Truck:" line in itemsDescription. ──
  serviceTypeKey?: string | null
  moveSizeKey?: string | null
  truckProvider?: string | null
  inventoryDetail?: unknown
  inventoryReviewRequired?: boolean | null
  numBoxes?: number | null
  needsAssembly?: boolean | null
  needsDisassembly?: boolean | null
  assemblyItems?: string | null
  disassemblyItems?: string | null
  assemblyFee?: number | null // cents
  disassemblyFee?: number | null // cents
  assemblyApprovalRequired?: boolean | null
  coiRequiredOrigin?: string | null
  coiRequiredDest?: string | null
  coiNotes?: string | null
  discountRejected?: unknown
  originUnit?: string | null
  destUnit?: string | null
  additionalTruckFees?: number | null // cents
  /** CENTS captured so far, when the caller has the payment rows. */
  payments?: { amount: number; status: string; isInternalTest?: boolean | null }[] | null
}

export function approvalCardDataFromBooking(
  b: ApprovalBookingInput,
  opts?: {
    photos?: { url: string }[]
    photoCount?: number
    adminUrl?: string | null
    rescheduled?: boolean
    stripeChargeId?: string | null
    receiptUrl?: string | null
    includeActionButtons?: boolean
    warnings?: string[]
  }
): ApprovalCardData {
  const dollars = (cents?: number | null): number | null => (typeof cents === 'number' ? cents / 100 : null)
  const deposit = dollars(b.depositAmount ?? 4900) ?? 49

  // ── ONE resolution of the booking's shape, scope and money ──────────────
  //    The card, the admin page and the approval guards all call this same
  //    function, so the card can no longer describe a booking differently
  //    from the page the owner opens two seconds later.
  const collectedCents = (b.payments ?? [])
    .filter((p) => p.status === 'COMPLETED' && !p.isInternalTest)
    .reduce((s, p) => s + p.amount, 0)
  const authorizedCents = (b.payments ?? [])
    .filter((p) => p.status === 'PENDING' && !p.isInternalTest)
    .reduce((s, p) => s + p.amount, 0)
  const scope = resolveBookingScope({
    ...b,
    additionalCents: (b.truckAddonDueOnMoveDay ? b.truckAddonAmount ?? 0 : 0) + (b.additionalTruckFees ?? 0),
    collectedCents: collectedCents || (b.depositPaid ? b.depositAmount ?? 4900 : 0),
    authorizedNotCapturedCents: authorizedCents,
    photoCount: opts?.photoCount ?? opts?.photos?.length ?? 0,
  })

  return {
    bookingId: b.id,
    displayId: b.displayId ?? null,
    status: b.status ?? null,
    rescheduled: opts?.rescheduled ?? false,
    customerName: b.customer?.name ?? null,
    customerEmail: b.customer?.email ?? null,
    customerPhone: b.customer?.phone ?? null,
    requestedDate: b.requestedDate ?? null,
    serviceType: serviceLabelFromDescription(b.itemsDescription),
    truckOptionLabel: b.truckAddonDueOnMoveDay
      ? TRUCK_OPTION_LABELS['truck-pickup-return']
      : truckLabelFromDescription(b.itemsDescription),
    serviceHeadline: scope.headline,
    moveSizeLabel: scope.shape.moveSizeLabel,
    truckProviderLabel: scope.shape.truckProviderDetail
      ? `${scope.shape.truckProviderLabel} (${scope.shape.truckProviderDetail})`
      : scope.shape.truckProviderLabel,
    scopeAlerts: scope.flags
      .filter((f) => f.severity !== 'info' || f.code === 'photos_recommended' || f.code === 'coi_unknown')
      .map((f) => ({ banner: f.banner, detail: f.detail })),
    alertParagraph: scope.alertParagraph,
    inventoryLine: scope.inventory.inventory.empty ? null : scopeInventoryLine(scope),
    // Units are split out of the street string for display — see address.ts.
    originAddress: unitSuffixed(scope.addresses.origin.address, scope.addresses.origin.unit),
    destAddress: unitSuffixed(scope.addresses.dest.address, scope.addresses.dest.unit),
    rawDescription: b.itemsDescription ?? null,
    customerNotes: b.customerNotes ?? null,
    baseRate: b.baseRate ?? null,
    travelFeeDollars: dollars(b.travelFee),
    truckAddonDueOnMoveDay: b.truckAddonDueOnMoveDay ?? false,
    truckAddonAmountCents: b.truckAddonAmount ?? null,
    discountType: b.discountType ?? null,
    discountCode: b.discountCode ?? null,
    discountPercent: b.discountPercent ?? null,
    depositDollars: deposit,
    depositPaid: b.depositPaid ?? false,
    // THE final total (quote + add-ons − discount) and what is left once the
    // $49 authorization is captured — both from the canonical calculation.
    // These two lines used to read `totalEstimate` and `totalEstimate − 49`,
    // which is where $550 and $501 came from on a $495 booking.
    moveTotal: scope.quote.quoteMissing && scope.quote.finalTotalCents === 0 ? null : scope.quote.finalTotalDollars,
    discountDollars: scope.quote.discountDollars,
    collectedDollars: scope.quote.collectedDollars,
    balanceAfterJob: scope.quote.quoteMissing && scope.quote.finalTotalCents === 0 ? null : scope.quote.remainingAfterDepositDollars,
    serviceAreaZone: b.serviceAreaZone ?? null,
    manualReviewRequired: b.manualReviewRequired ?? false,
    serviceAreaMessage: b.serviceAreaMessage ?? null,
    // Why the owner is being asked to look, and what the customer declared
    // about access. Both are read straight from the booking row — the route
    // is the only thing that words them.
    reviewReasons: b.reviewReasons ?? [],
    difficultElevatorPickup: b.difficultElevatorPickup ?? null,
    difficultElevatorDropoff: b.difficultElevatorDropoff ?? null,
    difficultBuildingPickup: b.difficultBuildingPickup ?? null,
    difficultBuildingDropoff: b.difficultBuildingDropoff ?? null,
    inventoryAccuracyConfirmed: b.inventoryAccuracyConfirmed ?? null,
    paymentStatusLabel: b.depositPaid
      ? `✅ $${deposit.toFixed(0)} captured`
      : `🔒 $${deposit.toFixed(0)} hold authorized (captured on approval)`,
    stripePaymentIntentId: b.stripePaymentIntentId ?? null,
    stripeCheckoutId: b.stripeCheckoutId ?? null,
    stripeChargeId: opts?.stripeChargeId ?? null,
    receiptUrl: opts?.receiptUrl ?? null,
    agreementAccepted: b.agreementAccepted ?? false,
    agreementVersion: b.agreementVersion ?? null,
    agreementName: b.agreementName ?? null,
    agreementAcceptedAt: b.agreementAcceptedAt ?? null,
    source: b.source ?? null,
    foundUs: b.foundUs ?? null,
    photos: opts?.photos ?? [],
    photoCount: opts?.photoCount ?? opts?.photos?.length ?? 0,
    adminUrl: opts?.adminUrl ?? null,
    includeActionButtons: opts?.includeActionButtons ?? true,
    warnings: opts?.warnings ?? [],
  }
}

// ════════════════════════════════════════════════════════════════════════
//  THE NEW-LEAD CARD (owner spec 2026-08-03)
//  ---------------------------------------------------------------------
//  Until now the first Discord card for a customer appeared only AFTER they
//  paid the deposit (src/lib/fulfillment.ts). Someone who asked what a move
//  costs and left produced nothing an owner could act on — the whole reason
//  a $1,049 quote request could sit unanswered.
//
//  This card is INFORMATIONAL: link buttons only, no custom_id actions, so it
//  needs no entry in OWNER_ACTIONS and a click can never dead-end on a
//  generic ack. "Call" and "Email" are tel:/mailto: links the owner taps from
//  the phone; "Open in admin" is the dashboard.
//
//  Like every other builder here this file stays free of prisma and
//  discord.js so the card is unit-testable offline.
// ════════════════════════════════════════════════════════════════════════

export type LeadCardData = {
  leadId: string
  firstName?: string | null
  lastName?: string | null
  /** Full name when first/last were not captured separately. */
  name?: string | null
  phone?: string | null
  email?: string | null
  /** DOLLARS. Null when no estimate could be produced — never rendered as $0. */
  estimateDollars?: number | null
  moveDate?: Date | string | null
  moveSize?: string | null
  pickup?: string | null
  destination?: string | null
  /** Raw contact-preference key; humanized here. */
  contactPreference?: string | null
  bestTimeToCall?: string | null
  formStep?: string | null
  /** Classified channel (LeadSource) + the raw string it came from. */
  source?: string | null
  referrer?: string | null
  landingPage?: string | null
  utmSource?: string | null
  utmCampaign?: string | null
  adminUrl?: string | null
  /** True when this is a re-alert after a meaningful change, not a new lead. */
  isUpdate?: boolean
}

const CONTACT_PREFERENCE_LABELS: Record<string, string> = {
  call_asap: '📞 Call me as soon as possible',
  text: '💬 Text me',
  email: '✉️ Email me',
  customer_will_contact: '🙋 They will contact us',
}

export function contactPreferenceLabel(value?: string | null): string | null {
  const v = (value ?? '').trim().toLowerCase()
  return v ? CONTACT_PREFERENCE_LABELS[v] ?? v.replace(/_/g, ' ') : null
}

/** Digits-only phone for a tel: link. Returns null when there is nothing
 *  dialable, so we never render a button that opens an empty dialer. */
export function telHref(phone?: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  return `tel:+${digits.length === 10 ? '1' + digits : digits}`
}

/**
 * A phone number a human can read back over the phone.
 *
 * PURE, and deliberately conservative: it only reformats what it is CERTAIN
 * about — a 10-digit NANP number, or 11 digits starting with the country code.
 * Anything else (an extension, an international number, a typo) is printed
 * EXACTLY as the customer typed it. Guessing at a malformed number and
 * printing a confident-looking `(186) 230-6673` is worse than showing the raw
 * string: it hides the fact that the number needs a human's judgement.
 */
export function formatPhoneDisplay(phone?: string | null): string {
  const raw = (phone ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  const nanp = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (nanp.length !== 10) return raw
  // A real NANP area code and exchange never start with 0 or 1.
  if (/^[01]/.test(nanp) || /^[01]/.test(nanp.slice(3))) return raw
  return `(${nanp.slice(0, 3)}) ${nanp.slice(3, 6)}-${nanp.slice(6)}`
}

/**
 * How far the visitor got, in words the owner already uses. The raw values are
 * two different vocabularies — the quote page sends `quote`, the booking form
 * sends `card1`..`card5` — and neither means anything at a glance.
 */
export function stepLabel(formStep?: string | null): string | null {
  const s = (formStep ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'quote_in_person') return 'Asked for an in-person estimate'
  if (s === 'quote') return 'Finished the quick quote'
  if (s === 'submitted') return 'Submitted the booking form'
  const card = s.match(/^card(\d)$/)
  if (card) return `Reached step ${card[1]} of the booking form`
  return null
}

/** The route as ONE line, or null when neither end is known. */
export function routeLine(pickup?: string | null, destination?: string | null): string | null {
  const from = (pickup ?? '').trim()
  const to = (destination ?? '').trim()
  if (!from && !to) return null
  if (from && to) return from === to ? `${from} (local)` : `${from} → ${to}`
  return from ? `From ${from}` : `To ${to}`
}

/**
 * Where the lead came from, in ONE line — or null when there is nothing worth
 * a line. A channel of OTHER/UNKNOWN with no campaign tag and no referrer is
 * not information; it is the absence of it, and it does not earn space on a
 * card whose job is to get someone called.
 */
export function originLine(data: {
  source?: string | null
  utmSource?: string | null
  utmCampaign?: string | null
  referrer?: string | null
}): string | null {
  const channel = (data.source ?? '').trim().toUpperCase()
  const known = channel && channel !== 'OTHER' && channel !== 'UNKNOWN' ? channel.replace(/_/g, ' ').toLowerCase() : null
  const campaign = [data.utmSource, data.utmCampaign].map((v) => (v ?? '').trim()).filter(Boolean).join(' / ')
  // Host only. A full URL is a paragraph on a phone and the admin has the rest.
  let ref: string | null = null
  const r = (data.referrer ?? '').trim()
  if (r) {
    try {
      ref = new URL(r).host.replace(/^www\./, '')
    } catch {
      ref = r.slice(0, 60)
    }
  }
  const parts = [known, campaign || null, ref ? `via ${ref}` : null].filter(Boolean)
  return parts.length ? parts.join('  ·  ') : null
}

export function buildLeadCard(data: LeadCardData): { embeds: EmbedJson[]; components: ActionRowJson[] } {
  const fullName =
    [data.firstName, data.lastName].filter(Boolean).join(' ').trim() ||
    (data.name ?? '').trim() ||
    'Name not given'

  // ── Money. An absent estimate is stated, never shown as $0 — quoting zero
  //    is quoting a free move. Mirrors the site's travelPending rule.
  // An in-person request was never quoted, so the card must not show a number
  // even if one somehow reached it. The route already refuses to compute one;
  // a card that WOULD render a stray value is a card that eventually will.
  const inPersonEstimate = (data.formStep ?? '').trim().toLowerCase() === 'quote_in_person'
  const estimate = inPersonEstimate
    // Not "we could not price it" — we deliberately did not.
    ? '_In-person estimate requested_'
    : typeof data.estimateDollars === 'number' && data.estimateDollars > 0
      ? `**$${Math.round(data.estimateDollars).toLocaleString('en-US')}**`
      : '_no estimate yet_'

  // null, not "Not given" — the field is omitted entirely when there is no
  // date. See the LAYOUT note below.
  //
  // RENDERED IN UTC, AND THAT IS THE FIX, NOT THE BUG. A move date is a
  // CALENDAR DATE, not an instant: the form sends "2026-08-29" and
  // parseMoveDate stores it as 2026-08-29T00:00:00Z. Rendering that in
  // America/New_York moves it back four hours — to 8pm on the 28th — so the
  // card showed the owner THE DAY BEFORE the one the customer picked, every
  // time. A crew sent a day early is the most expensive kind of typo, and it
  // was invisible because "Fri, Aug 28" looks perfectly plausible.
  const dateLabel = data.moveDate
    ? new Date(data.moveDate).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : null

  // ════════════════════════════════════════════════════════════════════
  //  LAYOUT (owner feedback 2026-08-05: "it seems ugly, more organized")
  //  ------------------------------------------------------------------
  //  The card is read on a phone, one-handed, while the lead is warm. So it
  //  is built in three tiers, and NOTHING EMPTY IS PRINTED:
  //
  //    1. WHO + HOW TO REACH THEM — a full-width block. The old card spread
  //       this across inline fields, so the phone number — the one thing the
  //       owner acts on — landed in a narrow column beside "Not given".
  //    2. THE JOB — up to three inline fields (estimate / date / route).
  //       Discord lays inline fields three to a row, so three is exactly one
  //       clean row; a field with nothing to say is OMITTED rather than
  //       printed as "Not given", which is what made the old card look like a
  //       form with blanks in it.
  //    3. WHERE THEY CAME FROM — ONE line. The old version printed six,
  //       including two full URLs, which pushed the phone number off a phone
  //       screen. The full referrer and landing page live in the admin, one
  //       tap away on the button below.
  // ════════════════════════════════════════════════════════════════════
  const fields: EmbedField[] = []

  const pref = contactPreferenceLabel(data.contactPreference)
  const reach = [
    data.phone ? `📞 **${formatPhoneDisplay(data.phone)}**` : null,
    data.email ? `✉️ ${data.email}` : null,
    // contactPreferenceLabel already carries its own emoji ("💬 Text me").
    [pref, data.bestTimeToCall ? `🕒 ${data.bestTimeToCall}` : null].filter(Boolean).join('  ·  ') || null,
  ]
    .filter(Boolean)
    .join('\n')
  fields.push(field(`👤 ${fullName}`, reach || '_no contact details_'))

  // ── Tier 2: the job. Inline, and only what exists. ──
  fields.push(field('💵 Estimate', [estimate, data.moveSize || null].filter(Boolean).join('\n'), true))
  if (dateLabel) fields.push(field('📅 Move date', dateLabel, true))
  const route = routeLine(data.pickup, data.destination)
  if (route) fields.push(field('📍 Route', route, true))

  // ── Tier 3: one line, and only when it says something. A lead that came
  //    straight from the site with no campaign tag needs no attribution row
  //    at all — the absence IS the answer, and printing "Channel: UNKNOWN /
  //    Referrer: none (direct)" spends three lines saying nothing.
  const origin = originLine(data)
  if (origin) fields.push(field('📈 Source', origin))

  // An IN-PERSON request is a different job for the owner: someone has to go
  // and look at it, and there is deliberately no number to act on. It has to
  // be recognisable in the channel list without opening the card.
  const inPersonCard = (data.formStep ?? '').trim().toLowerCase() === 'quote_in_person'
  const title = inPersonCard
    ? '🏠 In-Person Estimate Requested'
    : data.isUpdate
      ? '🔄 Lead updated — details changed'
      : '🆕 New quote request'
  const embed: EmbedJson = {
    title,
    // Orange for a new lead (brand action colour), navy for an update so a
    // re-alert cannot be mistaken for a second person.
    color: data.isUpdate ? 0x0a1628 : 0xff5a1f,
    description: data.isUpdate
      ? 'This lead changed something that affects how you should call them.'
      : 'They asked for a price and left their number. Call while it is warm.',
    fields,
    // The step belongs here, not in a field of its own: it is context for
    // reading the card, not a fact to act on. The lead id stays because it is
    // what you quote when something looks wrong — but it no longer sits above
    // the phone number.
    footer: { text: [stepLabel(data.formStep), `Lead ${data.leadId}`].filter(Boolean).join('  ·  ') },
    timestamp: new Date().toISOString(),
  }

  // ── Buttons: LINK style only (style 5 + url, never custom_id). Max 5.
  //
  //  ONLY http(s) URLS ARE SAFE HERE. Discord validates every link button and
  //  rejects the WHOLE message on an unsupported scheme — so a `tel:` or
  //  `mailto:` button does not degrade to an un-clickable button, it deletes
  //  the entire alert. Since the alert exists precisely so a lead gets called,
  //  losing it to make the phone tappable is the worst possible trade.
  //
  //  The phone and email are therefore in the FIRST embed field as plain text,
  //  where the Discord mobile client (the one the owner actually acts on)
  //  linkifies a phone number and an address by itself.
  const row: ButtonJson[] = []
  if (data.adminUrl) row.push({ type: 2, style: BTN.link, label: '🔎 Open lead in admin', url: data.adminUrl })

  return { embeds: [embed], components: row.length ? [{ type: 1, components: row.slice(0, 5) }] : [] }
}
