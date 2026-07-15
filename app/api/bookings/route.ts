import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { BOOKING_FEE_CENTS, createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { AGREEMENT_VERSION } from '@/lib/agreement'
import { notifyBookingCreated } from '@/lib/notify'
import { checkServiceArea, travelFeeDollars, type AddressInput } from '@/lib/service-area'
import { verifyAddress, type VerifiedAddress } from '@/lib/address-verify'
import { assessAddress } from '@/lib/address'
import { ELEVATOR_LABELS, PARKING_LABELS, BUILDING_LABELS } from '@/lib/booking-display'
import { etDateTimeToInstant } from '@/lib/scheduling'
import { computeEstimate, MOVE_SIZES } from '@/lib/estimate'
import { nextBookingReference } from '@/lib/booking-reference'
import { attributionSchemaFields, attributionColumns } from '@/lib/attribution'

const TRUCK_PICKUP_RETURN_AMOUNT_CENTS = 5000

// ── CORS ──────────────────────────────────────────────────────
// The marketing site (static HTML) is served from a different origin than this
// API, so browser booking submissions are cross-origin and require CORS. The
// allowlist is env-driven; defaults cover local dev (server.py on :8000) and
// the production marketing domain. NOTE: /api/bookings is intentionally outside
// the middleware matcher, so CSRF is not enforced here — keep it that way.
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  // Local static server (server.py) runs on :3000; :8000 kept for older setups.
  // BOTH marketing domains are allowed so cross-origin booking POSTs aren't blocked.
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://www.wemoveitweclearit.com,https://wemoveitweclearit.com,https://www.moveitclearit.com,https://moveitclearit.com,https://wmiwci-backend.vercel.app'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

// Preflight handler — browsers send OPTIONS before a cross-origin JSON POST.
export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

// Public entrypoint: run the booking handler, then attach CORS headers to
// whatever response it returns (success or error) so the browser can read it.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handleBooking(req)
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) {
    res.headers.set(k, v)
  }
  return res
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

function sanitizeNotes(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function normalizeTruckOption(value?: string): string | undefined {
  const clean = value ? sanitizeText(value) : undefined
  if (!clean) return undefined
  if (clean === 'full-148' || clean === 'reserve-99') return 'truck-pickup-return'
  return clean
}

const cleanString = (min: number, max: number) =>
  z.string().transform(sanitizeText).pipe(z.string().min(min).max(max))

const BookingSchema = z.object({
  fullName: cleanString(2, 100),
  phone: cleanString(7, 25),
  email: z.string().transform((v) => sanitizeText(v).toLowerCase()).pipe(z.string().email()),
  serviceType: cleanString(1, 60),
  date: z.string().transform(sanitizeText).optional(),
  time: z.string().transform(sanitizeText).optional(),
  truckOption: z.string().transform(normalizeTruckOption).optional(),
  jobDetails: z.string().transform(sanitizeNotes).pipe(z.string().max(2000)).optional(),
  discountCode: z.string().transform(sanitizeText).pipe(z.string().max(50)).optional(),

  // ── Addresses & access (collected on the booking form) ──
  addressFrom: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
  addressTo: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),

  // ── Structured service-area addresses (new booking form) ──
  // Optional; when present, drive the server-side travel-fee/zone decision. The
  // single-line addressFrom/addressTo above stay for back-compat.
  pickupAddresses: z
    .array(
      z.object({
        street: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
        city: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
        state: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
        zip: z.string().transform(sanitizeText).pipe(z.string().max(12)).optional(),
      }),
    )
    .max(10)
    .optional(),
  destinationAddress: z
    .object({
      street: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
      city: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
      state: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
      zip: z.string().transform(sanitizeText).pipe(z.string().max(12)).optional(),
    })
    .optional(),
  stairs: z.coerce.boolean().optional(),
  longWalk: z.coerce.boolean().optional(),
  heavyItems: z.coerce.boolean().optional(),

  // ── Structured access details (booking form selects). Unknown values are
  //    dropped rather than rejected so an old cached form can never 422. ──
  elevatorAccess: z
    .string()
    .transform((v) => (ELEVATOR_LABELS[sanitizeText(v)] ? sanitizeText(v) : undefined))
    .optional(),
  parkingDistance: z
    .string()
    .transform((v) => (PARKING_LABELS[sanitizeText(v)] ? sanitizeText(v) : undefined))
    .optional(),
  buildingYear: z
    .string()
    .transform((v) => (BUILDING_LABELS[sanitizeText(v)] ? sanitizeText(v) : undefined))
    .optional(),

  // ── Structured access details (owner spec 2026-07-12) — all optional so an
  //    older cached form never 422s. Pickup=origin, drop-off=dest stay separate.
  //    Access CODES are persisted to their own columns and NEVER folded into
  //    itemsDescription (which reaches public emails + the customer summary). ──
  originUnit: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  destUnit: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  originFloor: z.coerce.number().int().min(-5).max(200).optional(),
  destFloor: z.coerce.number().int().min(-5).max(200).optional(),
  originHasElevator: z.coerce.boolean().optional(),
  destHasElevator: z.coerce.boolean().optional(),
  originStairCount: z.coerce.number().int().min(0).max(200).optional(),
  destStairCount: z.coerce.number().int().min(0).max(200).optional(),
  originAccessNotes: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  destAccessNotes: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  originAccessCode: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  destAccessCode: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  truckProvider: z.string().transform(sanitizeText).pipe(z.string().max(80)).optional(),
  truckSize: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  truckReservationStatus: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  truckPickupLocation: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
  truckReturnResponsibility: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
  equipmentNeeds: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  crewInstructions: z.string().transform(sanitizeNotes).pipe(z.string().max(1000)).optional(),

  // ── Phase 2 address verification handshake. addressFormVersion >= 2 means the
  //    form ran the autocomplete widget and enforced suggestion selection, so the
  //    server may hard-reject undeliverable strings. manualEntryReason is the
  //    controlled fallback (verification genuinely failed) — it always routes the
  //    booking to owner manual review instead of rejecting. ──
  addressFormVersion: z.coerce.number().int().min(1).max(10).optional(),
  manualEntryReason: z.string().transform(sanitizeNotes).pipe(z.string().max(300)).optional(),

  // ── Client-side estimate snapshot (display only — NEVER drives pricing).
  //    Shown to the owner so the approval card matches what the customer saw. ──
  estimateTotal: z.coerce.number().min(0).max(100000).optional(),
  estimateAddons: z.coerce.number().min(0).max(100000).optional(),

  // ── Marketing attribution (?src= from the QR / landing URL) ──
  source: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  // "Where did you find us?" self-report from the booking-form dropdown.
  foundUs: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  // ── First-party ad attribution (gclid/gbraid/wbraid + utm_* + first-touch) ──
  ...attributionSchemaFields,

  // ── Moving Service Agreement (hard-required) ──
  // Must be literally true — booking + Stripe session are refused otherwise.
  agreementAccepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Moving Service Agreement to book.' }),
  }),
  agreementName: cleanString(2, 100),
  // Frontend sends the version it displayed; we store the server's canonical version.
  agreementVersion: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  agreementSignature: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),

  // Preferred language from the site's EN/ES toggle — drives bilingual email/SMS.
  locale: z.string().transform(sanitizeText).pipe(z.string().max(8)).optional(),

  // ── Job photos (uploaded client-side to Cloudinary before submit) ──
  // Each entry is the {url, publicId} Cloudinary returns. Optional + capped so a
  // malformed/oversized payload can't bloat the booking. Persisted as File rows.
  photos: z
    .array(
      z.object({
        url: z.string().url().max(500),
        publicId: z.string().transform(sanitizeText).pipe(z.string().min(1).max(300)),
      })
    )
    .max(20)
    .optional(),
})

// Move-size flat prices live in the canonical estimate module (the ONE table
// the form mirrors + the estimate tests pin). Aliased so existing references
// keep working without a second copy that could drift.
const SERVICE_MAP = MOVE_SIZES

const TRUCK_LABELS: Record<string, string> = {
  'own-truck': 'Customer provides truck ($0)',
  'truck-pickup-return': 'Truck Pickup & Return (+$50 due on move day)',
}

function buildRequestedDate(date?: string, time?: string): Date {
  if (!date) return new Date()
  // Interpret the customer's picked date/time as America/New_York wall-clock,
  // independent of the server's timezone. Using `new Date("...T...")` parsed the
  // string in the SERVER's zone, so on a UTC host a picked "12:00 PM" was stored
  // as noon-UTC (= 8 AM ET) and could land the move on the wrong calendar day.
  const dt = etDateTimeToInstant(date, time ?? '07:00')
  return dt ?? new Date()
}

type AccessFlags = {
  stairs?: boolean
  longWalk?: boolean
  heavyItems?: boolean
  elevatorAccess?: string
  parkingDistance?: string
  buildingYear?: string
}

function buildDescription(
  serviceType: string,
  truckOption?: string,
  jobDetails?: string,
  access?: AccessFlags,
  estimate?: { total?: number; addons?: number },
): string {
  const svc = SERVICE_MAP[serviceType]
  const lines: string[] = []
  lines.push(`Service: ${svc ? svc.label : serviceType}`)
  if (truckOption) lines.push(`Truck: ${TRUCK_LABELS[truckOption] ?? truckOption}`)
  if (truckOption === 'truck-pickup-return') {
    lines.push('Truck add-on due on move day: $50 (not charged in Stripe)')
  }
  // Access conditions — always human-readable (these lines reach the Discord
  // cards, admin portal, and customer emails verbatim).
  const accessLines: string[] = []
  if (access?.stairs) accessLines.push('Stairs: No elevator / flights to carry up or down')
  if (access?.longWalk) accessLines.push('Long walk: Far from the door to the truck or parking')
  if (access?.heavyItems) accessLines.push('Heavy items: Piano, safe, appliances, dense furniture')
  if (access?.elevatorAccess && ELEVATOR_LABELS[access.elevatorAccess]) {
    accessLines.push(`Elevator: ${ELEVATOR_LABELS[access.elevatorAccess]}`)
  }
  if (access?.parkingDistance && PARKING_LABELS[access.parkingDistance]) {
    accessLines.push(`Parking: ${PARKING_LABELS[access.parkingDistance]}`)
  }
  if (access?.buildingYear && BUILDING_LABELS[access.buildingYear]) {
    accessLines.push(`Building: ${BUILDING_LABELS[access.buildingYear]}`)
  }
  if (accessLines.length) {
    lines.push(...accessLines)
    lines.push('Note: access conditions above are included in the estimated total.')
  }
  // The SERVER-computed estimate (source of truth, identical to the form headline
  // and every downstream surface). Access add-ons are already folded into total.
  if (typeof estimate?.total === 'number' && estimate.total > 0) {
    const addons = typeof estimate.addons === 'number' && estimate.addons > 0 ? ` (incl. $${estimate.addons} access add-ons)` : ''
    lines.push(`Estimated moving total: $${estimate.total}${addons}`)
  }
  if (jobDetails?.trim()) lines.push(`Notes: ${jobDetails.trim()}`)
  return lines.join('\n')
}

// Map a SERVER verification result to the origin_*/dest_* columns. Client-side
// claims never reach here. 'skipped' (no key/timeout) stores only the status +
// reason so a later re-verification pass can find these rows.
function verifiedAddressColumns(prefix: 'origin' | 'dest', v: VerifiedAddress, manualReason?: string): Record<string, unknown> {
  const p = (k: string) => `${prefix}${k}`
  return {
    [p('StreetNumber')]: v.streetNumber ?? null,
    [p('Route')]: v.route ?? null,
    [p('City')]: v.city ?? null,
    [p('County')]: v.county ?? null,
    [p('State')]: v.state ?? null,
    [p('Zip')]: v.zip ?? null,
    [p('Country')]: v.country ?? null,
    [p('Formatted')]: v.formatted ?? null,
    [p('Lat')]: v.lat ?? null,
    [p('Lng')]: v.lng ?? null,
    [p('PlaceId')]: v.placeId ?? null,
    [p('Verification')]: v.status,
    [p('ValidationReason')]: manualReason ? `manual_entry: ${manualReason}` : v.reason ?? null,
  }
}

function formatAddr(a?: { street?: string; city?: string; state?: string; zip?: string }): string {
  if (!a) return ''
  const region = [a.state, a.zip].map((s) => s?.trim()).filter(Boolean).join(' ')
  return [a.street, a.city, region].map((s) => s?.trim()).filter(Boolean).join(', ')
}

async function handleBooking(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const ua = req.headers.get('user-agent') ?? ''
  // APP_URL must point at THIS backend (where /api/stripe/checkout/success lives).
  // Default to the live API domain — NOT the dead wmiwci-backend.vercel.app, which
  // 404s and breaks the post-payment redirect + success-route fulfillment fallback.
  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
  const marketingUrl = process.env.MARKETING_SITE_URL ?? 'https://www.moveitclearit.com'

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = BookingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const data = parsed.data

  // ── Service-area evaluation — SERVER-SIDE source of truth. Any travel fee the
  //    browser may have shown is ignored; the zone + fee are recomputed here and
  //    stored on the booking. The fee is a MOVE-DAY amount (like the truck add-on)
  //    and is never added to the $49 Stripe deposit. ──
  const saPickups: AddressInput[] = (data.pickupAddresses ?? []).map((a) => ({ ...a }))
  const structuredDest = data.destinationAddress
  const saDest: AddressInput | null =
    structuredDest && (structuredDest.zip || structuredDest.city || structuredDest.state)
      ? { ...structuredDest }
      : data.addressTo || data.addressFrom
        ? { raw: data.addressTo ?? data.addressFrom }
        : null
  if (saPickups.length === 0 && data.addressFrom) saPickups.push({ raw: data.addressFrom })
  const sa = saDest ? checkServiceArea(saPickups, saDest) : null
  const travelFeeCents = sa?.travelFeeCents ?? 0 // null (pending NY review) -> stored 0
  const travelFeeUsd = travelFeeCents / 100
  let originDisplay = data.pickupAddresses?.length
    ? formatAddr(data.pickupAddresses[0])
    : data.addressFrom?.trim() ?? ''
  let destDisplay = data.destinationAddress
    ? formatAddr(data.destinationAddress)
    : data.addressTo?.trim() ?? ''

  // ── Phase 2: SERVER-side address verification. The browser's autocomplete
  //    selection is UX only — we re-verify the submitted STRINGS with Google
  //    Address Validation (degrade-safe: no key/timeout → 'skipped' and the
  //    offline heuristics in address.ts take over). Client components are never
  //    trusted or persisted. Enforcement is version-gated so an old cached form
  //    can NEVER be hard-rejected — it routes to manual review instead. ──
  const formV2 = (data.addressFormVersion ?? 1) >= 2
  const [originV, destV] = await Promise.all([
    verifyAddress([originDisplay]),
    verifyAddress([destDisplay]),
  ])
  const originAssess = assessAddress(originDisplay)
  const destAssess = assessAddress(destDisplay)

  const addressFieldErrors: Record<string, string[]> = {}
  if (formV2 && !data.manualEntryReason) {
    // The new form promised a selected, verified suggestion. If Google says the
    // string is not deliverable (street/city-level only), or the provider was
    // unavailable AND the string fails even the offline completeness check,
    // reject with a field-mapped error so the form can highlight the input.
    const bad = (v: { status: string }, assess: { complete: boolean }) =>
      v.status === 'unverified' || (v.status === 'skipped' && !assess.complete)
    if (bad(originV, originAssess)) addressFieldErrors.addressFrom = ['Select a complete pickup address (street number, city, ZIP) from the suggestions.']
    if (bad(destV, destAssess)) addressFieldErrors.addressTo = ['Select a complete destination address (street number, city, ZIP) from the suggestions.']
    if (Object.keys(addressFieldErrors).length) {
      return NextResponse.json(
        { error: 'Address verification failed', details: { fieldErrors: addressFieldErrors } },
        { status: 422 },
      )
    }
  }
  // Verified + new form → the customer SAW and picked this exact address, so the
  // canonical formatted string becomes the display address everywhere. Legacy
  // payloads keep the customer's own string (formatted lands in origin_formatted).
  if (formV2 && originV.status === 'verified' && originV.formatted) originDisplay = originV.formatted
  if (formV2 && destV.status === 'verified' && destV.formatted) destDisplay = destV.formatted

  // Manual review when: customer used the manual-entry fallback, or either
  // address is unverified/incomplete (legacy path) — the owner sees the reason.
  const addressNeedsReview =
    !!data.manualEntryReason ||
    originV.status === 'unverified' || destV.status === 'unverified' ||
    (originV.status === 'skipped' && !originAssess.complete) ||
    (destV.status === 'skipped' && !destAssess.complete)

  const existingCustomer = await prisma.customer.findUnique({
    where: { email: data.email },
  })

  const customerLocale = data.locale && data.locale.toLowerCase().startsWith('es') ? 'es' : 'en'
  const customer = await prisma.customer.upsert({
    where: { email: data.email },
    update: { name: data.fullName, phone: data.phone, locale: customerLocale },
    create: { email: data.email, name: data.fullName, phone: data.phone, isFirstTime: true, locale: customerLocale },
  })

  let discountType: string | undefined
  let discountPercent: number | undefined

  if (data.discountCode) {
    discountType = 'DOOR_HANGER_PENDING'
    discountPercent = 0
  } else if (!existingCustomer) {
    discountType = 'FIRST_TIME_AUTO'
    discountPercent = 10
  }

  const requestedDate = buildRequestedDate(data.date, data.time)
  const truckAddonDueOnMoveDay = data.truckOption === 'truck-pickup-return'
  const svc = SERVICE_MAP[data.serviceType]

  // ── SERVER-COMPUTED estimate (source of truth). The client-submitted
  //    estimateTotal/estimateAddons are IGNORED for pricing — recomputed here
  //    from validated inputs so the form headline, DB, admin, Discord, emails,
  //    SMS and Stripe metadata all show the SAME number. Access add-ons are
  //    INCLUDED in the total (labor difficulty); travel + truck are labelled
  //    due-on-move-day. This is the fix for the "$699 form vs $599 email" bug. ──
  const est = computeEstimate({
    serviceType: data.serviceType,
    stairs: data.stairs,
    longWalk: data.longWalk,
    heavyItems: data.heavyItems,
    elevatorAccess: data.elevatorAccess,
    parkingDistance: data.parkingDistance,
    buildingYear: data.buildingYear,
    travelFeeCents,
    truckAddonDueOnMoveDay,
  })
  const totalEstimateValue = svc ? est.estimatedTotal : est.estimatedTotal > 0 ? est.estimatedTotal : null

  const itemsDescription = buildDescription(
    data.serviceType,
    data.truckOption,
    data.jobDetails,
    {
      stairs: data.stairs,
      longWalk: data.longWalk,
      heavyItems: data.heavyItems,
      elevatorAccess: data.elevatorAccess,
      parkingDistance: data.parkingDistance,
      buildingYear: data.buildingYear,
    },
    { total: est.estimatedTotal, addons: est.accessAddons },
  )
    + (data.source ? `\nSource: ${data.source}` : '')
    + (data.photos?.length ? `\n📷 ${data.photos.length} job photo(s) attached — view in admin/portal` : '')
    + (sa?.zone === 'extended_nj' ? '\nExtended service-area fee: $50 (due on move day)' : '')
    + (sa?.zone === 'primary' ? '\nService area: Primary — no travel fee' : '')
    + (sa?.manualReviewRequired ? '\n⚠ Service area: Owner review required — travel price pending; do not confirm a final travel price' : '')
    + ((data.pickupAddresses ?? []).slice(1).map(formatAddr).filter(Boolean).length
        ? `\nAdditional pickup(s): ${(data.pickupAddresses ?? []).slice(1).map(formatAddr).filter(Boolean).join(' | ')}`
        : '')
  const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  // Public reference (WMIC-####) from the atomic sequence — assigned once, never
  // changes. Mirrored into displayId so every existing customer/owner surface
  // shows the friendly reference; the internal cuid `id` is untouched.
  const bookingReference = await nextBookingReference()

  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      bookingReference,
      displayId: bookingReference,
      status: 'DRAFT',
      originAddress: originDisplay || 'Provided at confirmation',
      destAddress: destDisplay || 'Provided at confirmation',
      itemsDescription,
      // The customer's own words also land in a dedicated column (not just the
      // itemsDescription blob) so the Discord card, admin portal, and emails can
      // show the exact notes cleanly. itemsDescription still carries a "Notes:"
      // line for the legacy/human summary.
      customerNotes: data.jobDetails ?? null,
      // ── Structured access details (nullable; older rows stay null). Access
      //    CODES persist ONLY here, never in itemsDescription → never in emails
      //    or the customer summary. Pickup/drop-off kept separate. ──
      originUnit: data.originUnit,
      destUnit: data.destUnit,
      originFloor: data.originFloor,
      destFloor: data.destFloor,
      originHasElevator: data.originHasElevator,
      destHasElevator: data.destHasElevator,
      originStairCount: data.originStairCount,
      destStairCount: data.destStairCount,
      originAccessNotes: data.originAccessNotes,
      destAccessNotes: data.destAccessNotes,
      originAccessCode: data.originAccessCode,
      destAccessCode: data.destAccessCode,
      truckProvider: data.truckProvider,
      truckSize: data.truckSize,
      truckReservationStatus: data.truckReservationStatus,
      truckPickupLocation: data.truckPickupLocation,
      truckReturnResponsibility: data.truckReturnResponsibility,
      equipmentNeeds: data.equipmentNeeds,
      crewInstructions: data.crewInstructions,
      // ── Verified structured address (server verification results ONLY) ──
      ...verifiedAddressColumns('origin', originV, data.manualEntryReason),
      ...verifiedAddressColumns('dest', destV, data.manualEntryReason),
      requestedDate,
      depositAmount: BOOKING_FEE_CENTS,
      depositPaid: false,
      truckAddonDueOnMoveDay,
      truckAddonAmount: truckAddonDueOnMoveDay ? TRUCK_PICKUP_RETURN_AMOUNT_CENTS : 0,
      baseRate: svc?.price ?? null,
      // Estimated moving total = base labor + access add-ons + travel fee — the
      // SAME value the form headline shows (computeEstimate). Access add-ons used
      // to be dropped here, which is what made the email/DB read $599 while the
      // form showed $699.
      totalEstimate: totalEstimateValue,
      // ── Service area (server-computed; travel fee is due on move day, not in Stripe) ──
      serviceAreaZone: (sa?.zone ?? null) as any,
      travelFee: travelFeeCents,
      travelFeeDueOnMoveDay: travelFeeCents > 0,
      manualReviewRequired: (sa?.manualReviewRequired ?? false) || addressNeedsReview,
      serviceAreaMessage: sa?.message ?? null,
      addressEvaluation: sa ? (sa.evaluatedAddresses as any) : undefined,
      discountCode: data.discountCode,
      discountType: discountType as any,
      discountPercent,
      ipAddress: ip,
      userAgent: ua,
      // Attribution columns (Phase 2) — also kept in itemsDescription text above
      // for the Discord card; these power the marketing-tracker revenue merge.
      source: data.source,
      foundUs: data.foundUs,
      // First-party ad attribution (first-touch; ready for Ads offline import).
      ...attributionColumns(data),
      customerTokenExpiry: tokenExpiry,
      // ── Moving Service Agreement acceptance record ──
      agreementAccepted: true,
      agreementVersion: AGREEMENT_VERSION,
      agreementAcceptedAt: new Date(),
      agreementName: data.agreementName,
      agreementSignature: data.agreementSignature,
    },
    include: { customer: true },
  })

  let checkoutSession
  try {
    const svcLabel = svc ? svc.label : data.serviceType
    checkoutSession = await createBookingCheckout({
      bookingId: booking.id,
      customerEmail: customer.email,
      customerName: customer.name,
      description: `${svcLabel} move - ${data.date ?? 'date TBD'}`,
      successUrl: `${appUrl}/api/stripe/checkout/success?session_id={CHECKOUT_SESSION_ID}&booking=${booking.id}`,
      cancelUrl: `${marketingUrl}/contact.html?cancelled=1`,
      agreementAccepted: true,
      agreementVersion: AGREEMENT_VERSION,
      agreementName: data.agreementName,
      // Server-computed estimate on the payment (owner/finance traceability).
      // bookingReference is added below once the booking row exists.
      extraMetadata: {
        bookingReference: booking.bookingReference ?? '',
        estimatedTotal: String(est.estimatedTotal),
        accessAddons: String(est.accessAddons),
        travelFeeDollars: String(est.travel),
        truckAddonDollars: String(est.truckAddon),
        dueOnMoveDayDollars: String(est.dueOnMoveDay),
      },
    })
  } catch (err) {
    apiLogger.error({ err, bookingId: booking.id }, 'Failed to create Stripe checkout')
    await prisma.booking.delete({ where: { id: booking.id } })
    return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 })
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: 'PENDING_PAYMENT',
      stripeCheckoutId: checkoutSession.id,
    },
  })

  // ── Attach uploaded job photos as File rows (non-fatal) ──
  // The browser already uploaded these to Cloudinary; we only record the
  // references. A failure here must never block the booking/payment, so it is
  // caught and logged. createMany skipDuplicates guards the unique cloudinaryId.
  if (data.photos?.length) {
    try {
      await prisma.file.createMany({
        data: data.photos.map((p) => ({
          bookingId: booking.id,
          type: 'PHOTO_BEFORE' as const,
          cloudinaryId: p.publicId,
          cloudinaryUrl: p.url,
          filename: p.publicId.split('/').pop() ?? 'photo',
          mimeType: 'image/jpeg',
          sizeBytes: 0,
          uploadedBy: 'customer',
        })),
        skipDuplicates: true,
      })
      apiLogger.info({ bookingId: booking.id, count: data.photos.length }, 'Job photos attached')
    } catch (err) {
      apiLogger.error({ err, bookingId: booking.id }, 'Failed to attach job photos (non-fatal)')
    }
  }

  // MESSAGING POLICY: no email/SMS is sent at booking creation. The system sends
  // exactly four customer messages downstream — FINAL CONFIRMATION (email + SMS)
  // when payment completes (fulfillPaidCheckout), and PRE-APPROVAL (email + SMS)
  // when an admin approves in Discord. The Stripe Checkout URL is returned in the
  // response below and the customer is redirected straight to it, so the old
  // pre-payment "booking-confirmation" email (and the abandoned-checkout recovery
  // email) were both removed.

  apiLogger.info({ bookingId: booking.id, customerId: customer.id, serviceType: data.serviceType }, 'Booking created')

  // ── Owner alert: a new booking was started (non-fatal; never blocks booking) ──
  // The customer is intentionally NOT messaged here — they receive the existing
  // FINAL CONFIRMATION (email + SMS) when payment completes, so we don't text
  // people who are still mid-checkout. notifyBookingCreated guards each send.
  try {
    await notifyBookingCreated({
      name: customer.name,
      phone: customer.phone ?? undefined,
      email: customer.email,
      source: data.source,
      foundUs: data.foundUs,
      serviceType: svc ? svc.label : data.serviceType,
      displayId: booking.displayId,
      locale: customerLocale,
      serviceAreaZone: sa?.zone,
      travelFee: travelFeeDollars(sa?.travelFeeCents ?? 0),
      manualReviewRequired: sa?.manualReviewRequired ?? false,
      originAddress: originDisplay || undefined,
      destAddress: destDisplay || undefined,
    })
  } catch (err) {
    apiLogger.error({ err, bookingId: booking.id }, 'owner booking alert failed (non-fatal)')
  }

  return NextResponse.json({
    bookingId: booking.id,
    // Public reference (WMIC-####) — the id customers/owners/support should use.
    bookingReference: booking.bookingReference,
    displayId: booking.displayId,
    // Stripe Checkout URL — returned under every key any caller might read,
    // so a frontend expecting `url`, `checkoutUrl`, or `stripeUrl` all redirect.
    checkoutUrl: checkoutSession.url,
    url: checkoutSession.url,
    stripeUrl: checkoutSession.url,
    dueOnMoveDay: {
      truckPickupReturn: truckAddonDueOnMoveDay,
      amount: truckAddonDueOnMoveDay ? TRUCK_PICKUP_RETURN_AMOUNT_CENTS / 100 : 0,
    },
  })
}
 