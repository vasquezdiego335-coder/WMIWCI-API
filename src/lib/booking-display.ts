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
export function moneyFromDollars(n: unknown): string | null {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toLocaleString('en-US')}` : null
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
  const m = (description ?? '').match(/^Service:\s*(.+)$/im)
  return m ? m[1].trim() : null
}

export function truckLabelFromDescription(description?: string | null): string | null {
  const m = (description ?? '').match(/^Truck:\s*(.+)$/im)
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
  moveTotal?: number | null
  balanceAfterJob?: number | null
  // Service area
  serviceAreaZone?: string | null
  manualReviewRequired?: boolean
  serviceAreaMessage?: string | null
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

  // 2) Move (date / service / truck)
  fields.push(
    field(
      '📅 Move',
      [
        jobDateTime(data.requestedDate),
        data.serviceType || serviceLabelFromDescription(data.rawDescription) || 'Service in details',
        `🚚 ${data.truckOptionLabel || truckLabelFromDescription(data.rawDescription) || TRUCK_OPTION_LABELS['own-truck']}`,
      ]
        .filter(Boolean)
        .join('\n'),
      true
    )
  )

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

  // 7) Pricing — the full owner breakdown.
  const priceLines: string[] = []
  if (typeof data.baseRate === 'number' && data.baseRate > 0) priceLines.push(`Base labor: ${money(data.baseRate)}`)
  if (data.manualReviewRequired) priceLines.push('Travel fee: Pending owner review')
  else if (typeof data.travelFeeDollars === 'number' && data.travelFeeDollars > 0)
    priceLines.push(`Travel fee: ${money(data.travelFeeDollars)} — collected on move day`)
  if (data.truckAddonDueOnMoveDay)
    priceLines.push(`Truck add-on: ${money((data.truckAddonAmountCents ?? 5000) / 100)} — collected on move day`)
  if (data.discountCode || data.discountType) {
    const parts = [
      data.discountCode ? `\`${data.discountCode}\`` : null,
      typeof data.discountPercent === 'number' && data.discountPercent > 0 ? `${data.discountPercent}% off` : null,
      data.discountType ? `(${data.discountType})` : null,
    ].filter(Boolean)
    priceLines.push(`Discount: ${parts.join(' ')}`)
  }
  priceLines.push(
    data.depositPaid
      ? `Deposit: ${money(data.depositDollars ?? 49)} captured ✅`
      : `Deposit: ${money(data.depositDollars ?? 49)} held (captured on approval)`
  )
  if (typeof data.moveTotal === 'number') priceLines.push(`Move total: ${money(data.moveTotal)}`)
  if (typeof data.balanceAfterJob === 'number') priceLines.push(`Balance after job: ${money(data.balanceAfterJob)}`)
  fields.push(field('💰 Pricing', priceLines.join('\n')))

  // 8) Stripe references
  const stripeLines: string[] = [data.paymentStatusLabel || '🔒 $49 hold authorized (captured on approval)']
  if (data.stripePaymentIntentId) stripeLines.push(`Payment Intent: \`${shortRef(data.stripePaymentIntentId)}\``)
  if (data.stripeCheckoutId) stripeLines.push(`Checkout Session: \`${shortRef(data.stripeCheckoutId)}\``)
  if (data.stripeChargeId) stripeLines.push(`Charge: \`${shortRef(data.stripeChargeId)}\``)
  fields.push(field('💳 Stripe', stripeLines.join('\n'), true))

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
  stripePaymentIntentId?: string | null
  stripeCheckoutId?: string | null
  agreementAccepted?: boolean | null
  agreementVersion?: string | null
  agreementName?: string | null
  agreementAcceptedAt?: Date | string | null
  source?: string | null
  foundUs?: string | null
  customer?: { name?: string | null; email?: string | null; phone?: string | null } | null
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
  const moveTotal = typeof b.totalEstimate === 'number' ? b.totalEstimate : null
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
    originAddress: b.originAddress ?? null,
    destAddress: b.destAddress ?? null,
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
    moveTotal,
    balanceAfterJob: moveTotal != null ? Math.round((moveTotal - deposit) * 100) / 100 : null,
    serviceAreaZone: b.serviceAreaZone ?? null,
    manualReviewRequired: b.manualReviewRequired ?? false,
    serviceAreaMessage: b.serviceAreaMessage ?? null,
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
