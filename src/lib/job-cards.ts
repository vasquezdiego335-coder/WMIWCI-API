// ════════════════════════════════════════════════════════════════════════════
//  job-cards.ts — ONE job, rendered for TWO audiences.
//  ------------------------------------------------------------------------
//  PURE. No prisma, no discord.js, no env, no network — so the exact JSON that
//  reaches Discord is asserted in tests.
//
//    buildBookingRequestCard  #bookings, PENDING_APPROVAL. The existing owner
//                             approval card (every hard-won pricing/scope line
//                             intact) under the shared header. Says what is
//                             TRUE: a $49 hold was AUTHORIZED. Nothing is paid.
//    buildOwnerJobCard        #bookings, CONFIRMED onward. Money, customer
//                             contact, addresses, warnings.
//    buildCrewJobCard         #job-data. What a mover needs to do the job, and
//                             NOTHING about what the job is worth.
//    buildDailyDigest         #today-jobs / #upcoming-jobs. Crew-safe.
//
//  THE AUDIENCE IS A PROPERTY OF THE FUNCTION, NOT OF THE CALLER'S CARE.
//  `CrewJobView` — the only thing the crew renderers accept — has no field that
//  can hold a price, an email, a phone number, a street address, an access code
//  or a Stripe id. A crew card cannot leak what it was never handed.
//  `toCrewView()` is the single, audited place an owner-grade record is cut
//  down, and job-cards.test.ts walks every string it can produce.
//
//  STATUS comes from BookingStatus via discord-ui.bookingStage(). There is no
//  Discord-side state.
// ════════════════════════════════════════════════════════════════════════════
import {
  buildBookingApprovalCard,
  discordSafe,
  formatPhoneDisplay,
  shortRef,
  timeLabel,
  type ApprovalCardData,
  type EmbedField,
  type EmbedJson,
} from './booking-display'
import { resolveBookingScope, scopeInventoryLine } from './booking-scope'
import { firstNameOf } from './deposit-links'
import {
  BRAND,
  TONE,
  bookingStage,
  brandFooter,
  cityState,
  compact,
  fieldIf,
  holdLine,
  isBlank,
  lines,
  moneyFromCents,
  moveDayLabel,
  moveTimeLabel,
  routeBlock,
} from './discord-ui'

type ButtonJson = { type: 2; style: number; label: string; custom_id?: string; url?: string }
type ActionRowJson = { type: 1; components: ButtonJson[] }
export type CardJson = { embeds: EmbedJson[]; components: ActionRowJson[] }

const BTN = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 } as const
const TITLE = `🚚 ${BRAND.name.toUpperCase()}`

// ── What the database hands us (duck-typed, like booking-display.ts) ────────

export type CrewAssignmentInput = {
  assignmentStatus?: string | null
  role?: string | null
  crewLeader?: boolean | null
  isDriver?: boolean | null
  reportTime?: Date | string | null
  workerVisibleNotes?: string | null
  user?: { name?: string | null } | null
}

export type JobBookingInput = {
  id: string
  displayId?: string | null
  bookingReference?: string | null
  status?: string | null
  isInternalTest?: boolean | null
  customer?: { name?: string | null; phone?: string | null; email?: string | null } | null
  requestedDate?: Date | string | null
  confirmedDate?: Date | string | null
  scheduledStart?: Date | string | null
  arrivalWindow?: string | null
  originAddress?: string | null
  destAddress?: string | null
  originCity?: string | null
  originState?: string | null
  destCity?: string | null
  destState?: string | null
  originUnit?: string | null
  destUnit?: string | null
  originFloor?: number | null
  destFloor?: number | null
  originStairCount?: number | null
  destStairCount?: number | null
  originHasElevator?: boolean | null
  destHasElevator?: boolean | null
  originAccessNotes?: string | null
  destAccessNotes?: string | null
  difficultElevatorPickup?: boolean | null
  difficultElevatorDropoff?: boolean | null
  difficultBuildingPickup?: boolean | null
  difficultBuildingDropoff?: boolean | null
  itemsDescription?: string | null
  customerNotes?: string | null
  serviceTypeKey?: string | null
  moveSizeKey?: string | null
  truckProvider?: string | null
  truckSize?: string | null
  truckAddonDueOnMoveDay?: boolean | null
  truckAddonAmount?: number | null
  truckPickupLocation?: string | null
  additionalTruckFees?: number | null
  laborWorkers?: number | null
  hasPiano?: boolean | null
  hasSafe?: boolean | null
  hasPoolTable?: boolean | null
  hasAppliances?: boolean | null
  specialtyItems?: string | null
  needsPacking?: boolean | null
  needsUnpacking?: boolean | null
  needsAssembly?: boolean | null
  needsDisassembly?: boolean | null
  needsStorage?: boolean | null
  assemblyItems?: string | null
  disassemblyItems?: string | null
  equipmentNeeds?: string | null
  crewInstructions?: string | null
  inventoryDetail?: unknown
  numBoxes?: number | null
  baseRate?: number | null
  totalEstimate?: number | null
  travelFee?: number | null
  discountPercent?: number | null
  discountCode?: string | null
  discountType?: string | null
  depositAmount?: number | null
  depositPaid?: boolean | null
  manualReviewRequired?: boolean | null
  reviewReasons?: string[] | null
  crewArrivedAt?: Date | string | null
  customerReadyAt?: Date | string | null
  waitingStartedAt?: Date | string | null
  waitingEndedAt?: Date | string | null
  waitingMinutes?: number | null
  payments?: { amount: number; status: string; isInternalTest?: boolean | null; receiptUrl?: string | null }[] | null
  job?: {
    crewNotes?: string | null
    crew?: CrewAssignmentInput[] | null
    staffingReq?: { requiredWorkers?: number | null } | null
  } | null
}

export type JobCardOptions = {
  adminUrl?: string | null
  startedBy?: string | null
  startedAtLabel?: string | null
  completedBy?: string | null
  completedAtLabel?: string | null
  /** Owner-only: the waiting FEE line. The crew card shows minutes, never the fee. */
  waitingFeeLine?: string | null
  /** Owner-only: "Approved by Diego" / "Declined by Sebastian" — two owners share this channel. */
  decisionLine?: string | null
  warnings?: string[]
}

// ── THE CREW VIEW — the only thing a crew renderer is ever given ────────────

export type CrewMember = { name: string; lead: boolean; driver: boolean; reportTime: string | null }
export type CrewStop = { place: string | null; details: string[] }

/**
 * Everything a mover may know. Read the field list: there is nowhere to put a
 * dollar amount, a phone number, an email, a street address, an access code or
 * a Stripe id. Adding one is a deliberate, reviewable change to THIS type.
 */
export type CrewJobView = {
  bookingId: string
  ref: string
  status: string | null
  isTest: boolean
  customerFirstName: string | null
  day: string | null
  time: string | null
  arrivalWindow: string | null
  pickup: CrewStop
  dropoff: CrewStop
  service: string | null
  moveSize: string | null
  crewSize: number | null
  crew: CrewMember[]
  truck: string | null
  specialItems: string[]
  services: string[]
  inventory: string | null
  equipment: string | null
  notes: string | null
  trail: string[]
}

const ordinal = (n: number): string => {
  const v = Math.abs(n) % 100
  const s = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.min(v % 10, 4)] ?? 'th'
  return `${n}${s}`
}

/** "2nd floor", "Ground floor" — null when the floor was never recorded. */
function floorLabel(floor?: number | null): string | null {
  if (typeof floor !== 'number' || !Number.isFinite(floor)) return null
  return floor <= 1 ? 'Ground floor' : `${ordinal(floor)} floor`
}

function stopDetails(o: {
  floor?: number | null
  stairs?: number | null
  elevator?: boolean | null
  unit?: string | null
  notes?: string | null
  hardElevator?: boolean | null
  hardBuilding?: boolean | null
}): string[] {
  const out: string[] = []
  const floor = floorLabel(o.floor)
  if (floor) out.push(floor)
  if (typeof o.stairs === 'number' && o.stairs > 0) out.push(`${o.stairs} stairs`)
  // null means "not asked" — which is NOT the same as "no elevator".
  if (o.elevator === true) out.push('Elevator')
  else if (o.elevator === false) out.push('No elevator')
  if (!isBlank(o.unit)) out.push(`Unit ${String(o.unit).trim()}`)
  if (o.hardElevator) out.push('Difficult elevator')
  if (o.hardBuilding) out.push('Difficult building access')
  if (!isBlank(o.notes)) out.push(String(o.notes).trim())
  return out
}

const LIVE_ASSIGNMENT = new Set(['INVITED', 'OFFERED', 'ACCEPTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'])

/** Assigned people, from JobCrew — THE assignment record. Leads first. */
export function crewFromAssignments(rows?: CrewAssignmentInput[] | null): CrewMember[] {
  return (rows ?? [])
    .filter((r) => LIVE_ASSIGNMENT.has(String(r.assignmentStatus ?? 'ASSIGNED')))
    .map((r) => ({
      // First name only on a card a whole crew can read.
      name: firstNameOf(r.user?.name) ?? '',
      lead: r.crewLeader === true || r.role === 'CREW_LEADER',
      driver: r.isDriver === true || r.role === 'DRIVER',
      reportTime: moveTimeLabel(r.reportTime),
    }))
    .filter((m) => m.name)
    .sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name))
}

const effectiveWhen = (b: JobBookingInput): Date | string | null => b.scheduledStart ?? b.confirmedDate ?? b.requestedDate ?? null

function scopeOf(b: JobBookingInput) {
  const collected = (b.payments ?? []).filter((p) => p.status === 'COMPLETED' && !p.isInternalTest).reduce((s, p) => s + p.amount, 0)
  const authorized = (b.payments ?? []).filter((p) => p.status === 'PENDING' && !p.isInternalTest).reduce((s, p) => s + p.amount, 0)
  // THE one resolution of shape + money, shared with the admin page and the
  // approval card — so no card can describe a job differently from the page.
  return resolveBookingScope({
    ...b,
    additionalCents: (b.truckAddonDueOnMoveDay ? b.truckAddonAmount ?? 0 : 0) + (b.additionalTruckFees ?? 0),
    collectedCents: collected || (b.depositPaid ? b.depositAmount ?? 4900 : 0),
    authorizedNotCapturedCents: authorized,
  } as never)
}

function truckLine(b: JobBookingInput, providerLabel: string | null): string | null {
  const size = isBlank(b.truckSize) ? null : String(b.truckSize).trim()
  const head = [size ? `${size} truck` : null, providerLabel && providerLabel !== 'Not confirmed' ? providerLabel : null].filter(Boolean).join(' · ')
  const pickup = b.truckAddonDueOnMoveDay
    ? `Crew collects and returns the customer's rental${isBlank(b.truckPickupLocation) ? '' : ` — ${String(b.truckPickupLocation).trim()}`}`
    : null
  return lines(head || null, pickup) || null
}

const SERVICE_NAMES: Record<string, string> = { labor_only: 'Labor-Only Move', full_service: 'Full-Service Move' }

/**
 * Cut an owner-grade booking down to what a mover may know.
 *
 * THIS is the privacy boundary. Everything the crew card and the daily digest
 * can say passes through here, and nothing else does.
 */
export function toCrewView(b: JobBookingInput, opts: Pick<JobCardOptions, 'startedBy' | 'startedAtLabel' | 'completedBy' | 'completedAtLabel'> = {}): CrewJobView {
  const scope = scopeOf(b)
  const when = effectiveWhen(b)
  const crew = crewFromAssignments(b.job?.crew)

  const special: string[] = []
  if (b.hasPiano) special.push('Piano')
  if (b.hasSafe) special.push('Safe')
  if (b.hasPoolTable) special.push('Pool table')
  if (b.hasAppliances) special.push('Appliances')
  if (!isBlank(b.specialtyItems)) special.push(String(b.specialtyItems).trim())

  const services: string[] = []
  if (b.needsPacking) services.push('Packing')
  if (b.needsUnpacking) services.push('Unpacking')
  if (b.needsDisassembly) services.push(isBlank(b.disassemblyItems) ? 'Disassembly' : `Disassembly — ${String(b.disassemblyItems).trim()}`)
  if (b.needsAssembly) services.push(isBlank(b.assemblyItems) ? 'Assembly' : `Assembly — ${String(b.assemblyItems).trim()}`)
  if (b.needsStorage) services.push('Storage')

  const trail: string[] = []
  if (opts.startedBy) trail.push(`Started by ${opts.startedBy}${opts.startedAtLabel ? ` · ${opts.startedAtLabel}` : ''}`)
  if (opts.completedBy) trail.push(`Completed by ${opts.completedBy}${opts.completedAtLabel ? ` · ${opts.completedAtLabel}` : ''}`)
  if (b.crewArrivedAt) trail.push(`Arrived · ${timeLabel(b.crewArrivedAt)}`)
  if (b.waitingStartedAt) trail.push(`Waiting started · ${timeLabel(b.waitingStartedAt)}${b.waitingEndedAt ? ` → ended ${timeLabel(b.waitingEndedAt)}` : ' (running)'}`)
  if (b.customerReadyAt) trail.push(`Customer ready · ${timeLabel(b.customerReadyAt)}`)
  // Minutes are operational. The FEE those minutes produce is money, and money
  // is not on this card.
  if (typeof b.waitingMinutes === 'number' && b.waitingMinutes > 0) trail.push(`Waited ${b.waitingMinutes} min`)

  const required = b.job?.staffingReq?.requiredWorkers
  const crewSize =
    typeof required === 'number' && required > 0 ? required : typeof b.laborWorkers === 'number' && b.laborWorkers > 0 ? b.laborWorkers : null

  return {
    bookingId: b.id,
    ref: shortRef(b.bookingReference || b.displayId || b.id),
    status: b.status ?? null,
    isTest: b.isInternalTest === true,
    customerFirstName: firstNameOf(b.customer?.name),
    day: moveDayLabel(when),
    time: moveTimeLabel(when),
    arrivalWindow: isBlank(b.arrivalWindow) ? null : String(b.arrivalWindow).trim(),
    pickup: {
      place: cityState(b.originCity, b.originState),
      details: stopDetails({ floor: b.originFloor, stairs: b.originStairCount, elevator: b.originHasElevator, unit: b.originUnit, notes: b.originAccessNotes, hardElevator: b.difficultElevatorPickup, hardBuilding: b.difficultBuildingPickup }),
    },
    dropoff: {
      place: cityState(b.destCity, b.destState),
      details: stopDetails({ floor: b.destFloor, stairs: b.destStairCount, elevator: b.destHasElevator, unit: b.destUnit, notes: b.destAccessNotes, hardElevator: b.difficultElevatorDropoff, hardBuilding: b.difficultBuildingDropoff }),
    },
    service: SERVICE_NAMES[scope.shape.serviceType] ?? null,
    moveSize: scope.shape.moveSizeLabel,
    crewSize,
    crew,
    truck: truckLine(b, scope.shape.truckProviderDetail ? `${scope.shape.truckProviderLabel} (${scope.shape.truckProviderDetail})` : scope.shape.truckProviderLabel),
    specialItems: special,
    services,
    inventory: scope.inventory.inventory.empty ? null : scopeInventoryLine(scope),
    equipment: isBlank(b.equipmentNeeds) ? null : String(b.equipmentNeeds).trim(),
    notes: lines(isBlank(b.crewInstructions) ? null : String(b.crewInstructions).trim(), isBlank(b.job?.crewNotes) ? null : String(b.job?.crewNotes).trim()) || null,
    trail,
  }
}

// ── Shared pieces ───────────────────────────────────────────────────────────

/** The header every job card opens with: status, then the DATE, large. */
function headerBlock(parts: { test: boolean; dot: string; label: string; sub?: string | null; day: string | null; time: string | null; arrivalWindow?: string | null }): string {
  return lines(
    parts.test ? '🧪 **TEST BOOKING — not a real job**' : null,
    `${parts.dot} **${parts.label}**`,
    parts.sub ?? null,
    // A markdown heading: the move date is the single most important line on
    // the card, so it is the largest thing on it.
    parts.day ? `## ${parts.day}` : '## Date to be confirmed',
    parts.arrivalWindow ? `Arrival window ${parts.arrivalWindow}` : parts.time,
  )
}

function crewLines(size: number | null, crew: CrewMember[]): string | null {
  const people = crew.map((m) => {
    const tags = [m.lead ? 'lead' : null, m.driver ? 'driver' : null].filter(Boolean).join(', ')
    return `${m.name}${tags ? ` (${tags})` : ''}${m.reportTime ? ` · report ${m.reportTime}` : ''}`
  })
  const head = size ? `${size} mover${size === 1 ? '' : 's'}` : null
  return lines(head, people.length ? people.join('\n') : null) || null
}

const stopField = (name: string, stop: CrewStop): EmbedField | null => fieldIf(name, stop.details.join(' · ') || null)

function crewFields(v: CrewJobView): EmbedField[] {
  return compact([
    fieldIf('ROUTE', routeBlock(v.pickup.place, v.dropoff.place), true),
    fieldIf('JOB', lines([v.service, v.moveSize].filter(Boolean).join(' · ') || null, v.truck), true),
    fieldIf('CREW', crewLines(v.crewSize, v.crew), true),
    stopField('PICKUP ACCESS', v.pickup),
    stopField('DROP-OFF ACCESS', v.dropoff),
    fieldIf('HEAVY / SPECIAL ITEMS', v.specialItems.join(' · ') || null),
    fieldIf('SERVICES', v.services.join('\n') || null),
    fieldIf('INVENTORY', v.inventory),
    fieldIf('EQUIPMENT', v.equipment),
    fieldIf('CREW NOTES', v.notes, false, 900),
    fieldIf('MOVE DAY LOG', v.trail.join('\n') || null),
  ])
}

/** Start / Complete / waiting-time buttons — same custom_ids the interactions route already handles. */
function moveDayButtons(bookingId: string, status: string | null, b: Pick<JobBookingInput, 'crewArrivedAt' | 'waitingStartedAt' | 'waitingEndedAt' | 'customerReadyAt'>): ActionRowJson[] {
  const rows: ActionRowJson[] = []
  const action: ButtonJson[] = []
  if (status === 'CONFIRMED' || status === 'SCHEDULED') {
    action.push({ type: 2, style: BTN.primary, label: 'Start Job', custom_id: `job_start:${bookingId}` })
    action.push({ type: 2, style: BTN.success, label: 'Complete Job', custom_id: `job_complete:${bookingId}` })
  } else if (status === 'IN_PROGRESS') {
    action.push({ type: 2, style: BTN.success, label: 'Complete Job', custom_id: `job_complete:${bookingId}` })
  } else if (status === 'COMPLETED') {
    action.push({ type: 2, style: BTN.secondary, label: 'Archive', custom_id: `archive_job:${bookingId}` })
  }
  if (action.length) rows.push({ type: 1, components: action })

  const live = status === 'CONFIRMED' || status === 'SCHEDULED' || status === 'IN_PROGRESS'
  if (live) {
    const waiting: ButtonJson[] = []
    if (!b.crewArrivedAt) waiting.push({ type: 2, style: BTN.secondary, label: 'Arrived', custom_id: `crew_arrived:${bookingId}` })
    if (!b.waitingStartedAt) waiting.push({ type: 2, style: BTN.secondary, label: 'Waiting Started', custom_id: `waiting_start:${bookingId}` })
    else if (!b.waitingEndedAt && !b.customerReadyAt) waiting.push({ type: 2, style: BTN.primary, label: 'Waiting Ended', custom_id: `waiting_end:${bookingId}` })
    if (!b.customerReadyAt) waiting.push({ type: 2, style: BTN.success, label: 'Customer Ready', custom_id: `customer_ready:${bookingId}` })
    if (waiting.length) rows.push({ type: 1, components: waiting })
  }
  return rows
}

// ── 1. CREW CARD ────────────────────────────────────────────────────────────

/** The card in #job-data. Operational only — see CrewJobView. */
export function buildCrewJobCard(b: JobBookingInput, opts: JobCardOptions = {}): CardJson {
  const v = toCrewView(b, opts)
  const stage = bookingStage(v.status)
  const embed: EmbedJson = {
    title: TITLE,
    color: TONE[stage.tone],
    description: headerBlock({ test: v.isTest, dot: stage.dot, label: stage.crewLabel, day: v.day, time: v.time, arrivalWindow: v.arrivalWindow }),
    fields: compact([fieldIf('CUSTOMER', v.customerFirstName, true), ...crewFields(v)]),
    footer: brandFooter(`Ref ${v.ref}`),
    timestamp: new Date().toISOString(),
  }
  // No admin link (crew have no admin login) and no navigation link (it would
  // carry the street address into a channel every mover can read).
  return { embeds: [embed], components: moveDayButtons(b.id, v.status, b) }
}

// ── 2. OWNER CARD ───────────────────────────────────────────────────────────

const mapsUrl = (address?: string | null): string | null => {
  const a = (address ?? '').trim()
  return a && !/provided at confirmation/i.test(a) ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a)}` : null
}

/** The card in #bookings from CONFIRMED onward. Owner + Manager only. */
export function buildOwnerJobCard(b: JobBookingInput, opts: JobCardOptions = {}): CardJson {
  const v = toCrewView(b, opts)
  const scope = scopeOf(b)
  const stage = bookingStage(b.status)
  const q = scope.quote
  const captured = q.collectedCents

  const withUnit = (address?: string | null, unit?: string | null): string | null => {
    const a = (address ?? '').trim()
    if (!a) return null
    return isBlank(unit) || a.toLowerCase().includes(String(unit).trim().toLowerCase()) ? a : `${a} — Unit ${String(unit).trim()}`
  }
  const pickupAddress = withUnit(scope.addresses.origin.address || b.originAddress, scope.addresses.origin.unit ?? b.originUnit)
  const dropoffAddress = withUnit(scope.addresses.dest.address || b.destAddress, scope.addresses.dest.unit ?? b.destUnit)

  // Total / Paid / Remaining — from the ONE quote calculation. A missing quote
  // prints no total rather than a confident-looking floor.
  const money = lines(
    q.quoteMissing && q.finalTotalCents === 0 ? null : `Total: ${moneyFromCents(q.finalTotalCents)}`,
    `Paid: ${moneyFromCents(captured) ?? '$0'}`,
    q.quoteMissing && q.finalTotalCents === 0 ? null : `Remaining: ${moneyFromCents(q.remainingCents)}`,
    q.authorizedNotCapturedCents > 0 ? `Held, not captured: ${moneyFromCents(q.authorizedNotCapturedCents)}` : null,
  )

  const attention = [...(b.reviewReasons ?? []), ...(opts.warnings ?? [])].filter((w) => !isBlank(w))
  if (b.manualReviewRequired && !attention.length) attention.push('Owner review required — travel pricing is not finalized.')
  const crewMissing = (b.status === 'CONFIRMED' || b.status === 'SCHEDULED') && v.crew.length === 0
  if (crewMissing) attention.push('No crew assigned yet.')

  const embed: EmbedJson = {
    title: TITLE,
    color: TONE[stage.tone],
    description: headerBlock({
      test: v.isTest,
      dot: stage.dot,
      label: stage.label,
      sub: lines(holdLine(b.status, b.depositAmount, captured), opts.decisionLine ?? null) || null,
      day: v.day,
      time: v.time,
      arrivalWindow: v.arrivalWindow,
    }),
    fields: compact([
      fieldIf('CUSTOMER', lines(b.customer?.name ?? null, isBlank(b.customer?.phone) ? null : formatPhoneDisplay(b.customer?.phone)), true),
      fieldIf('ROUTE', routeBlock(v.pickup.place ?? pickupAddress, v.dropoff.place ?? dropoffAddress), true),
      fieldIf('JOB', lines([v.service, v.moveSize].filter(Boolean).join(' · ') || null, v.truck), true),
      fieldIf('ADDRESSES', lines(pickupAddress ? `Pickup: ${pickupAddress}` : null, dropoffAddress ? `Drop-off: ${dropoffAddress}` : null)),
      stopField('PICKUP ACCESS', v.pickup),
      stopField('DROP-OFF ACCESS', v.dropoff),
      fieldIf('SPECIAL ITEMS', v.specialItems.join(' · ') || null, true),
      fieldIf('SERVICES', v.services.join('\n') || null, true),
      fieldIf('CREW', crewLines(v.crewSize, v.crew), true),
      fieldIf('INVENTORY', v.inventory),
      fieldIf('PAYMENT', money),
      fieldIf('MOVE DAY LOG', lines(v.trail.join('\n') || null, opts.waitingFeeLine ?? null)),
      fieldIf('NEEDS ATTENTION', attention.map((w) => `• ${w}`).join('\n') || null),
    ]),
    footer: brandFooter(b.bookingReference || b.displayId || `Ref ${v.ref}`),
    timestamp: new Date().toISOString(),
  }

  const links: ButtonJson[] = []
  const live = b.status !== 'COMPLETED' && b.status !== 'ARCHIVED' && b.status !== 'CANCELLED'
  const pickup = mapsUrl(pickupAddress)
  const dropoff = mapsUrl(dropoffAddress)
  if (live && pickup) links.push({ type: 2, style: BTN.link, label: 'Maps · Pickup', url: pickup })
  if (live && dropoff) links.push({ type: 2, style: BTN.link, label: 'Maps · Drop-off', url: dropoff })
  if (opts.adminUrl) links.push({ type: 2, style: BTN.link, label: 'Dashboard', url: opts.adminUrl })
  const receipt = (b.payments ?? []).find((p) => p.status === 'COMPLETED' && p.receiptUrl)?.receiptUrl
  if (receipt) links.push({ type: 2, style: BTN.link, label: 'Receipt', url: receipt })

  const components: ActionRowJson[] = []
  if (links.length) components.push({ type: 1, components: links.slice(0, 5) })
  components.push({ type: 1, components: [{ type: 2, style: BTN.secondary, label: 'View Full Booking', custom_id: `view_full_booking:${b.id}` }] })
  return { embeds: [embed], components }
}

// ── 3. BOOKING REQUEST (the $49 is AUTHORIZED — nothing has been paid) ──────

/**
 * The existing owner approval card under the shared header.
 *
 * A decorator on purpose. `buildBookingApprovalCard` carries months of owner
 * corrections — the final-total arithmetic, the scope banners, the review
 * reasons — and ~100 assertions protect them. This keeps every one of those
 * lines and changes only what the card CLAIMS at the top:
 *
 *     🟠 BOOKING REQUEST
 *     $49 authorized · awaiting approval
 *
 * The website checkout uses capture_method 'manual', so at this point Stripe
 * holds the money and the business has received none. "Paid", "Deposit paid"
 * and "Confirmed" are all false here and none of them may appear in the header.
 */
export function buildBookingRequestCard(data: ApprovalCardData): CardJson {
  const card = buildBookingApprovalCard(data)
  const [main, ...gallery] = card.embeds
  const status = data.status ?? 'PENDING_APPROVAL'
  const stage = bookingStage(status)
  const holdCents = Math.round((data.depositDollars ?? 49) * 100)
  const capturedCents = Math.round((data.collectedDollars ?? 0) * 100)

  const header = headerBlock({
    test: false,
    dot: stage.dot,
    label: stage.label,
    sub: holdLine(status, holdCents, capturedCents),
    day: moveDayLabel(data.requestedDate),
    time: moveTimeLabel(data.requestedDate),
  })
  const restyled: EmbedJson = {
    ...main,
    title: TITLE,
    // Owner review keeps its own accent so it still stands out in the channel.
    color: data.manualReviewRequired && status === 'PENDING_APPROVAL' ? TONE.attention : TONE[stage.tone],
    description: lines(header, main.description ?? null),
    footer: brandFooter(data.displayId || `Ref ${shortRef(data.bookingId)}`),
  }
  return { embeds: [restyled, ...gallery], components: card.components as ActionRowJson[] }
}

// ── 4. DAILY DIGEST ─────────────────────────────────────────────────────────

export type DigestSlot = 'today' | 'tomorrow'

/**
 * #today-jobs (7:00 AM) and #upcoming-jobs (7:00 PM). Built from CrewJobView, so
 * it is crew-safe by construction. One field per job; the field NAME is the
 * line a mover reads on a lock screen: time · first name · route.
 */
export function buildDailyDigest(slot: DigestSlot, dayLabel: string, jobs: CrewJobView[]): { embeds: EmbedJson[] } {
  const MAX = 20 // Discord allows 25 fields; leave room for the overflow line
  const shown = jobs.slice(0, MAX)
  const count = jobs.length
  const fields: EmbedField[] = shown.map((v) => {
    const stage = bookingStage(v.status)
    const headsUp = [
      ...v.specialItems,
      ...(v.pickup.details.filter((d) => /stairs|No elevator|Difficult/.test(d)).map((d) => `${d} at pickup`)),
      ...(v.dropoff.details.filter((d) => /stairs|No elevator|Difficult/.test(d)).map((d) => `${d} at drop-off`)),
      ...v.services.map((s) => s.split(' — ')[0]),
    ]
    const name = [v.arrivalWindow ?? v.time ?? 'Time TBC', v.customerFirstName, routeBlock(v.pickup.place, v.dropoff.place)?.replace('\n', ' ')].filter(Boolean).join(' · ')
    return {
      name: discordSafe(name, 256),
      value: discordSafe(
        lines(
          [v.service, v.moveSize].filter(Boolean).join(' · ') || null,
          `Crew: ${crewLines(v.crewSize, v.crew)?.replace(/\n/g, ', ') ?? 'not assigned yet'}`,
          v.truck ? `Truck: ${v.truck.replace(/\n/g, ' · ')}` : null,
          v.equipment ? `Equipment: ${v.equipment}` : null,
          headsUp.length ? `Heads-up: ${headsUp.join(' · ')}` : null,
          `${stage.dot} ${stage.crewLabel}`,
        ),
        1024,
      ),
      inline: false,
    }
  })
  if (count > MAX) fields.push({ name: `+ ${count - MAX} more`, value: 'See #job-data for every job.', inline: false })

  return {
    embeds: [
      {
        title: slot === 'today' ? "☀️ TODAY'S JOBS" : "🌙 TOMORROW'S JOBS",
        color: count ? TONE.info : TONE.neutral,
        description: count ? `## ${dayLabel}\n${count} job${count === 1 ? '' : 's'}` : `## ${dayLabel}\nNo jobs scheduled.`,
        fields,
        footer: brandFooter(slot === 'today' ? 'Posted 7:00 AM ET' : 'Posted 7:00 PM ET'),
        timestamp: new Date().toISOString(),
      },
    ],
  }
}
