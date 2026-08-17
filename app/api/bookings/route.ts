import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { BOOKING_FEE_CENTS, createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { AGREEMENT_VERSION } from '@/lib/agreement'
import { notifyBookingCreated } from '@/lib/notify'
import { onBookingCreated } from '@/lib/journeys'
import { checkServiceArea, travelFeeDollars, type AddressInput } from '@/lib/service-area'
import { verifyAddress, type VerifiedAddress } from '@/lib/address-verify'
import { assessAddress } from '@/lib/address'
import { ELEVATOR_LABELS, PARKING_LABELS, BUILDING_LABELS } from '@/lib/booking-display'
import { etDateTimeToInstant } from '@/lib/scheduling'
import { computeEstimate, MOVE_SIZES } from '@/lib/estimate'
import { nextBookingReference } from '@/lib/booking-reference'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { ingestLeadSafe } from '@/lib/leads'
import { TRUCK_PICKUP_RETURN, DISCOUNT_POLICY } from '@/lib/pricing-config'
// Next.js App Router route files may export ONLY route handlers, so the Zod
// schema and the review-reason builder live in lib/ — where they are also
// unit testable without importing a Next route.
import { BookingSchema } from '@/lib/booking-schema'
import { CONSENT_VERSION } from '@/lib/consent'
import { buildReviewReasons } from '@/lib/booking-review'
import { resolveServiceShape } from '@/lib/service-shape'
import { assessInventory, describeInventory, mergeInventory, parseInventoryText, toInventory } from '@/lib/inventory'
import { resolveDiscount } from '@/lib/discount-rules'
import { normalizeAddressAndUnit } from '@/lib/address'
import { checkIntake, hoursToMinutes, laborOnlyEstimateCents } from '@/lib/product-catalog'
import { computeRouteDistance, summarize as summarizeRoute } from '@/lib/route-distance'
import { mileageChargeForMiles, TRANSPORTATION_MILEAGE, assertNoDoubleTravelCharge } from '@/lib/pricing-config'

/** The truck pickup & return ADD-ON. Distinct from BOOKING_FEE_CENTS — the two
 *  are both $49 and must never be merged or deduplicated by amount. */
const TRUCK_PICKUP_RETURN_AMOUNT_CENTS = TRUCK_PICKUP_RETURN.amountCents

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

// Move-size flat prices live in the canonical estimate module (the ONE table
// the form mirrors + the estimate tests pin). Aliased so existing references
// keep working without a second copy that could drift.
const SERVICE_MAP = MOVE_SIZES

// Labels are INTERPOLATED from the canonical price book — never hardcoded.
// A hardcoded "$50" here disagreed with TRUCK_PICKUP_RETURN.amount ($49) and
// with every price shown on the marketing site, and this string is written
// into itemsDescription, which reaches customer emails verbatim.
const TRUCK_LABELS: Record<string, string> = {
  'own-truck': 'Customer provides truck ($0)',
  'truck-pickup-return': `Truck Pickup & Return (+$${TRUCK_PICKUP_RETURN.amount} due on move day)`,
}

/**
 * The `truckOption` EXACTLY as the browser sent it, before Zod runs.
 *
 * booking-schema's `normalizeTruckOption` folds the legacy aliases `full-148`
 * and `reserve-99` into `truck-pickup-return`, which is correct for reading
 * historical payloads — but it means the parsed value can no longer tell us
 * which spelling arrived. Since Truck Pickup & Return is now RETIRED and every
 * alias must be refused, the gate reads the raw body instead of the normalised
 * one. Anything non-string is ignored; the schema has already rejected those.
 */
function rawTruckOption(body: unknown): string | null {
  const v = (body as { truckOption?: unknown } | null)?.truckOption
  return typeof v === 'string' ? v.trim() : null
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
  shape?: { serviceTypeLabel: string; moveSizeLabel: string | null; truckProviderLabel: string; serviceType: string },
  inventoryLine?: string,
): string {
  const svc = SERVICE_MAP[serviceType]
  const lines: string[] = []
  // ── THREE FACTS, THREE LINES (owner spec 2026-08-14) ────────────────────
  //    This blob reaches the crew, the admin and the customer's email
  //    verbatim. It used to open "Service: 1 Bedroom" / "Truck:
  //    Customer-provided", which reads as a bedroom package that mentions a
  //    truck in passing. It is a LABOR ONLY job of 1-bedroom size on the
  //    customer's truck, and those are three answers.
  if (shape) {
    lines.push(`Service Type: ${shape.serviceTypeLabel}`)
    lines.push(`Move Size: ${shape.moveSizeLabel ?? (svc ? svc.label : serviceType)}`)
    lines.push(`Truck Provider: ${shape.truckProviderLabel}`)
    if (shape.serviceType === 'labor_only') {
      lines.push('Labor only — the customer supplies the truck. No company truck, fuel, mileage or rental is billed on this job.')
    }
  }
  // The legacy "Service:" / "Truck:" lines stay: every historical row has them,
  // and the parsers that read them still run against those rows.
  lines.push(`Service: ${svc ? svc.label : serviceType}`)
  if (truckOption) lines.push(`Truck: ${TRUCK_LABELS[truckOption] ?? truckOption}`)
  if (truckOption === 'truck-pickup-return') {
    lines.push(`Truck pickup & return due on move day: $${TRUCK_PICKUP_RETURN.amount} — crew labor to collect and return YOUR rental (not charged in Stripe)`)
  }
  if (inventoryLine) lines.push(`Inventory: ${inventoryLine}`)
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

  const rl = await rateLimit(LIMITS.booking, [clientIp(req)])
  if (!rl.ok) {
    apiLogger.warn({ ip }, 'booking rate-limited')
    return tooManyRequests(rl) // CORS headers are added by the POST wrapper
  }

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

  // ══════════════════════════════════════════════════════════════════════
  //  THE PRODUCT GATE — BEFORE ANY SIDE EFFECT WHATSOEVER
  //  (repair audit 2026-08-14: P0-01 / P0-02 / P0-04 + the retired add-on)
  //
  //  IT SITS HERE, DIRECTLY AFTER PARSING, ON PURPOSE. It used to run further
  //  down, after `prisma.customer.upsert` — so a refused one-hour request had
  //  ALREADY created a Customer row before it was told no. That is a real
  //  write, on a real person, for a booking that was never allowed to exist.
  //  Everything below this block writes something, calls a paid API, or both:
  //  address verification, the customer upsert, the booking insert, Stripe.
  //  Nothing may run until we know we are allowed to sell what was asked for.
  //
  //  DO NOT MOVE THIS DOWN. If a check needs data computed further down, the
  //  check is wrong, not the position.
  // ══════════════════════════════════════════════════════════════════════
  //  THE DISCRIMINANT IS REQUIRED AND NEVER INFERRED (owner decision
  //  2026-08-14). It used to be guessed from the package, the truck provider
  //  or the notes when absent, which is how a job on the customer's own U-Haul
  //  was recorded — and dispatched — as a company-truck move. If the customer
  //  did not say which product they are buying, we ask; we do not decide.
  //
  //  `moveSizeKey` is read for full-service, falling back to the legacy
  //  `serviceType` field that older form versions used for the same value.
  //  `serviceType` is no longer overloaded to mean the product.
  const product = data.serviceTypeKey ?? null
  const submittedPackage = product === 'full_service' ? data.moveSizeKey ?? data.serviceType ?? null : data.moveSizeKey ?? null
  const laborMinutes = data.laborHours != null ? hoursToMinutes(data.laborHours) : null

  const intakeErrors = checkIntake({
    product,
    packageKey: submittedPackage,
    laborMinutes,
    laborService: data.laborService ?? null,
    laborWorkers: data.laborWorkers ?? null,
    // A company truck on a labor-only job is a contradiction, not a preference.
    hasCompanyTruckFields: !!data.truckSizeUpgradeRequested,
    // The raw value, before the schema's alias normalisation, so every
    // historical spelling is caught rather than just the canonical one.
    truckOption: rawTruckOption(body),
  })
  if (intakeErrors.length) {
    const fieldErrors: Record<string, string[]> = {}
    for (const e of intakeErrors) (fieldErrors[e.field] ??= []).push(e.message)
    apiLogger.warn(
      { ip, product, codes: intakeErrors.map((e) => e.code) },
      'booking refused at the product gate — no customer, booking, or Stripe object created',
    )
    return NextResponse.json(
      { error: intakeErrors[0].message, code: intakeErrors[0].code, details: { fieldErrors } },
      { status: 422 },
    )
  }

  // THE authoritative labor-only price. $75/worker/hour with a two-hour
  // minimum: the form's two-mover product is $150/hour, a requested 3-worker
  // crew is $225, 4 workers $300. The rate is SNAPSHOTTED onto the booking so
  // a future ladder change can never re-price an accepted quote.
  const labor = product === 'labor_only' ? laborOnlyEstimateCents(laborMinutes ?? 0, data.laborWorkers) : null
  // Full-service keeps the flat package model, unchanged: 1BR $550, 2BR $779,
  // 3BR $1,049, 4BR $1,449, 5BR $1,799, truck included in the package.
  const packageKey = product === 'full_service' ? submittedPackage : null

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
  // ── TRAVEL: MILEAGE IN, BAND OUT ────────────────────────────────────────
  //  checkServiceArea no longer returns a band fee for a new evaluation (it was
  //  retired 2026-07-31 and replaced by $3-per-routed-mile transportation).
  //  This stays 0 for every new booking; a historical row keeps whatever it was
  //  approved with, read from its stored column and never recalculated.
  //  assertNoDoubleTravelCharge below makes charging both impossible.
  const travelFeeCents = 0
  const travelFeeUsd = 0
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

  // DOOR-HANGER CAMPAIGN REMOVED 2026-07-21 (owner decision). It approved 30%,
  // over the 10% public cap in DISCOUNT_POLICY, and disagreed with the admin
  // route which wrote 10% for the same click. A submitted discount code no
  // longer opens a pending 30% path; first-time customers keep the 10% rate,
  // which is the cap. The Prisma DiscountType enum values are retained so
  // historical bookings still read correctly.
  //
  // ── DISCOUNTS DO NOT STACK (owner spec 2026-08-14) ─────────────────────
  //    DISCOUNT_POLICY.allowStacking has been `false` since it was written,
  //    and nothing enforced it. A first-time customer got FIRST_TIME_AUTO at
  //    10% automatically AND could type MOVE10 — the same 10% welcome offer
  //    wearing a coupon code — for 20% off one promotion. resolveDiscount
  //    keeps the single best entitlement and records why the others lost, so
  //    the customer hears "already applied", not "no".
  const discountDecision = resolveDiscount({
    isFirstTimeCustomer: !existingCustomer,
    requestedCode: data.discountCode,
  })
  const discountType = discountDecision.appliedType ?? undefined
  const discountPercent = discountDecision.percent > 0 ? discountDecision.percent : undefined

  const requestedDate = buildRequestedDate(data.date, data.time)
  const truckAddonDueOnMoveDay = data.truckOption === 'truck-pickup-return'
  const svc = packageKey ? SERVICE_MAP[packageKey] : undefined

  // ── SERVER-COMPUTED estimate (source of truth). The client-submitted
  //    estimateTotal/estimateAddons are IGNORED for pricing — recomputed here
  //    from validated inputs so the form headline, DB, admin, Discord, emails,
  //    SMS and Stripe metadata all show the SAME number. Access add-ons are
  //    INCLUDED in the total (labor difficulty); travel + truck are labelled
  //    due-on-move-day. This is the fix for the "$699 form vs $599 email" bug. ──
  //    2026-07-21: elevatorAccess / parkingDistance / buildingYear no longer
  //    price anything — the building-age surcharge was removed (undisclosed)
  //    and elevator/parking distance are review-gated, not automatic. They are
  //    still collected and stored for the crew; they just don't bill.
  const est = computeEstimate({
    serviceType: packageKey ?? undefined,
    pickupStairFlights: data.pickupStairFlights ?? undefined,
    dropoffStairFlights: data.dropoffStairFlights ?? undefined,
    pickupCarryFeet: data.pickupCarryFeet ?? undefined,
    dropoffCarryFeet: data.dropoffCarryFeet ?? undefined,
    heavyItems: data.heavyItemsDetail ?? undefined,
    additionalStops: data.additionalStops ?? undefined,
    // Legacy booleans from a browser tab opened before the cutover. They map to
    // the LOWEST tier (stairs → 2nd flight, longWalk → 100ft); a weightless
    // heavy-item checkbox becomes a review line, never a guessed charge.
    stairs: data.stairs,
    longWalk: data.longWalk,
    legacyHeavyItems: data.heavyItems,
    travelFeeCents,
    truckAddonDueOnMoveDay,
  })
  // The stored quote. For LABOR-ONLY the base is the hourly labor subtotal,
  // not a package price — access add-ons and travel still apply on top, and
  // they are already inside est.estimatedTotal (which carries a zero base for
  // labor-only, since 'labor-only' is not a package key).
  // ── SERVER-AUTHORITATIVE TRANSPORTATION ($3 per routed mile) ────────────
  //  Measured HERE, not taken from the browser. /api/route-estimate exists so
  //  the form can DISPLAY a live figure; this is the number that is stored and
  //  billed, and the two are computed by the same module.
  //
  //  LABOR-ONLY NEVER ROUTES. The customer supplies the truck, so there is no
  //  transportation to price and no address is sent to a routing provider at
  //  all — not as an optimisation, as a rule.
  //
  //  A route we cannot measure is REVIEW, never a free trip: routeManualReview
  //  is set and no amount is stored, so nothing downstream can sum a null as 0.
  let transportation: {
    routedMiles: number | null
    billableMiles: number | null
    rateCents: number | null
    amountCents: number | null
    status: string
    manualReview: boolean
    summary: Record<string, unknown> | null
  } | null = null

  if (product === 'full_service') {
    const stops = (data.pickupAddresses ?? []).slice(1).map(formatAddr).filter(Boolean)
    const route = await computeRouteDistance({
      origin: originDisplay,
      destination: destDisplay,
      stops,
    }).catch(() => null)

    const charge = mileageChargeForMiles(route?.miles ?? null)
    const measured = charge.billableMiles != null
    transportation = {
      routedMiles: route?.miles ?? null,
      billableMiles: charge.billableMiles,
      rateCents: measured ? TRANSPORTATION_MILEAGE.ratePerMileCents : null,
      amountCents: measured ? charge.amountCents ?? null : null,
      status: route?.status ?? 'skipped',
      manualReview: !measured,
      summary: route ? (summarizeRoute(route) as Record<string, unknown>) : null,
    }
  }

  //  Full-service: package + access add-ons + TRANSPORTATION.
  //  Labor-only:   hourly labor + access add-ons. Never transportation.
  const transportationDollars = (transportation?.amountCents ?? 0) / 100
  const totalEstimateValue = labor
    ? Math.round(labor.subtotalCents + est.estimatedTotal * 100) / 100
    : svc
      ? Math.round((est.estimatedTotal + transportationDollars) * 100) / 100
      : est.estimatedTotal + transportationDollars > 0
        ? Math.round((est.estimatedTotal + transportationDollars) * 100) / 100
        : null

  // ── THE THREE SEPARATE FACTS (owner spec 2026-08-14) ────────────────────
  //    What we are selling, how big the job is, and whose truck moves it. The
  //    form's own answer wins; otherwise the shape is derived from the truck
  //    provider and the truck option, so a customer-supplied truck is recorded
  //    as LABOR ONLY rather than a bedroom package with a company truck.
  const truckProviderValue =
    data.truckProvider ?? (data.truckOption === 'own-truck' ? 'customer' : undefined)
  const shape = resolveServiceShape({
    serviceTypeKey: data.serviceTypeKey ?? (data.laborService || data.laborHours != null ? 'labor_only' : null),
    // The explicit two-product field first; the legacy `serviceType` package
    // spelling as the fallback. Reading ONLY the legacy field made the
    // oversized-inventory check depend on a field a future form may stop
    // sending — and shape.moveSizeKey is what assessInventory sizes against.
    moveSizeKey: data.moveSizeKey ?? data.serviceType,
    truckProvider: truckProviderValue,
    truckAddonDueOnMoveDay,
    baseRate: svc?.price ?? null,
  })

  // ── DISCLOSED INVENTORY vs THE SELECTED PACKAGE ─────────────────────────
  //    The selection is a request, not a measurement. When the disclosed load
  //    does not fit it, the booking goes to review — never auto-approved at
  //    the smaller price, and never silently re-priced at the larger one.
  const inventory = mergeInventory(
    toInventory({
      ...(data.inventory ?? {}),
      // The customer ticking "assembly or disassembly needed" is the same
      // control as the two structured booleans.
      assembly: data.inventory?.assembly ?? data.needsAssembly ?? data.needsDisassembly,
    }),
    parseInventoryText(data.jobDetails),
  )
  const inventoryVerdict = assessInventory(inventory, shape.moveSizeKey)

  // ── ASSEMBLY SCOPE ──────────────────────────────────────────────────────
  const assemblyRequested = !!(data.needsAssembly || data.needsDisassembly || inventory.assembly)
  const assemblyItems = (data.assemblyItems ?? '').trim()
  const disassemblyItems = (data.disassemblyItems ?? '').trim()
  const assemblyScopeKnown = !assemblyRequested || !!(assemblyItems || disassemblyItems)

  // ── COI ─────────────────────────────────────────────────────────────────
  const coiOrigin = data.coiRequiredOrigin ?? null
  const coiDest = data.coiRequiredDest ?? null
  const coiRequired = coiOrigin === 'yes' || coiDest === 'yes'
  const coiUnknown = !coiRequired && (coiOrigin == null || coiDest == null || coiOrigin === 'unknown' || coiDest === 'unknown')

  // ── UNITS OUT OF THE STREET STRING ──────────────────────────────────────
  //    "1000 Executive Dr apt 443a" arrived with the unit inside the address
  //    and the Apartment/Unit column empty. Split it once, at intake, so no
  //    surface has to guess and the two fields cannot drift apart.
  const originParsed = normalizeAddressAndUnit(originDisplay, data.originUnit)
  const destParsed = normalizeAddressAndUnit(destDisplay, data.destUnit)
  originDisplay = originParsed.address || originDisplay
  destDisplay = destParsed.address || destDisplay

  const photoCount = data.photos?.length ?? 0

  // ── Manual review: ONE verdict, with reasons the owner can read. ──
  //    est.requiresReview was computed and thrown away before this; the access
  //    flags never reached the server at all.
  const reviewReasons = buildReviewReasons({
    estimate: est,
    serviceArea: sa,
    addressNeedsReview,
    manualEntryReason: data.manualEntryReason,
    difficultElevatorPickup: data.difficultElevatorPickup,
    difficultElevatorDropoff: data.difficultElevatorDropoff,
    difficultBuildingPickup: data.difficultBuildingPickup,
    difficultBuildingDropoff: data.difficultBuildingDropoff,
    inventory: inventoryVerdict,
    hasPhotos: photoCount > 0,
    assemblyScopeUnknown: assemblyRequested && !assemblyScopeKnown,
    coiRequired,
    coiUnknown,
    // Only when we INFERRED it — an explicit labor-only selection is not a
    // question, it is an answer.
    laborOnlyInferred: shape.serviceType === 'labor_only' && !shape.explicit,
  })
  const needsManualReview = reviewReasons.length > 0

  const itemsDescription = buildDescription(
    packageKey ?? data.serviceType ?? '',
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
    shape,
    inventory.empty ? undefined : describeInventory(inventory),
  )
    + (data.source ? `\nSource: ${data.source}` : '')
    + (data.photos?.length ? `\n📷 ${data.photos.length} job photo(s) attached — view in admin/portal` : '')
    + (sa?.zone === 'extended_nj' ? `\nExtended service-area fee: $${travelFeeUsd} (due on move day)` : '')
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
      // The unit the customer typed into the Apartment/Unit field, or the one
      // recovered from the street string — never both, never a duplicate.
      originUnit: originParsed.unit ?? undefined,
      destUnit: destParsed.unit ?? undefined,
      originFloor: data.originFloor ?? originParsed.floor ?? undefined,
      destFloor: data.destFloor ?? destParsed.floor ?? undefined,
      originHasElevator: data.originHasElevator,
      destHasElevator: data.destHasElevator,
      originStairCount: data.originStairCount,
      destStairCount: data.destStairCount,
      originAccessNotes: data.originAccessNotes,
      destAccessNotes: data.destAccessNotes,
      originAccessCode: data.originAccessCode,
      destAccessCode: data.destAccessCode,
      // truckProvider is written once, below, with the "own-truck" fallback —
      // a customer who picked "I have my own truck" and typed no brand name
      // still supplies the truck, and this column is what says so.
      truckSize: data.truckSize,
      truckReservationStatus: data.truckReservationStatus,
      truckPickupLocation: data.truckPickupLocation,
      truckReturnResponsibility: data.truckReturnResponsibility,
      equipmentNeeds: data.equipmentNeeds,
      crewInstructions: data.crewInstructions,
      // ── Access difficulty + inventory attestation (owner fix 2026-07-28) ──
      //    Stored so the crew and the owner can see what the customer declared.
      //    These drive reviewReasons above; they price nothing.
      difficultElevatorPickup: data.difficultElevatorPickup,
      difficultElevatorDropoff: data.difficultElevatorDropoff,
      difficultBuildingPickup: data.difficultBuildingPickup,
      difficultBuildingDropoff: data.difficultBuildingDropoff,
      inventoryAccuracyConfirmed: data.inventoryAccuracyConfirmed,
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
      // ── Service area. The ZONE still decides serviceability, the customer
      //    message and New York review; the FEE is retired. ──
      serviceAreaZone: (sa?.zone ?? null) as any,
      travelFee: 0,
      travelFeeDueOnMoveDay: false,
      // ── FULL-SERVICE TRANSPORTATION ($3 per routed mile, fuel included) ──
      //    Server-measured, never taken from the browser. Labor-only stores
      //    NOTHING here: the customer supplies the truck, so there is no
      //    transportation to bill and no address is ever sent to a router.
      routedMiles: transportation?.routedMiles ?? undefined,
      billableMiles: transportation?.billableMiles ?? undefined,
      mileageRateCents: transportation?.rateCents ?? undefined,
      transportationCharge: transportation?.amountCents ?? undefined,
      routeStatus: transportation?.status ?? undefined,
      routeManualReview: transportation?.manualReview ?? false,
      routeSummary: (transportation?.summary ?? undefined) as never,
      // Derived from buildReviewReasons() so the flag and the reasons can never
      // disagree. Previously this read only the service-area/address verdicts,
      // so an unpriced piano booked as if it were a settled job.
      manualReviewRequired: needsManualReview,
      reviewReasons,
      serviceAreaMessage: sa?.message ?? null,
      addressEvaluation: sa ? (sa.evaluatedAddresses as any) : undefined,
      discountCode: data.discountCode,
      discountType: discountType as any,
      discountPercent,
      // Codes the customer asked for that did NOT apply, with the reason. Kept
      // so the answer to "but I had MOVE10" is on the booking rather than in
      // an argument on move day.
      discountRejected: discountDecision.rejected.length ? (discountDecision.rejected as any) : undefined,

      // ── The three separate facts ──
      serviceTypeKey: product,
      moveSizeKey: shape.moveSizeKey ?? undefined,
      truckProvider: truckProviderValue,

      // ── THE LABOR-ONLY HOURLY QUOTE (repair audit P0-02) ──
      //    Rate and crew size are SNAPSHOTS: a future price change must never
      //    silently re-price a quote this customer already accepted. Requested
      //    and billable minutes are stored separately so the two-hour minimum
      //    reads as a minimum, not as a rewrite of what they asked for.
      laborService: (data.laborService as string | undefined) ?? undefined,
      laborRequestedMinutes: labor?.requestedMinutes,
      laborBillableMinutes: labor?.billableMinutes,
      laborMinimumApplied: labor?.minimumApplied,
      laborRateCents: labor?.hourlyRateCents,
      laborWorkers: labor?.workers,
      laborSubtotalCents: labor?.subtotalCents,
      // baseRate is DOLLARS by the unit contract. For labor-only it is the
      // hourly subtotal, so every existing consumer that reads baseRate as
      // "the labor price" stays correct without knowing about hourly billing.
      ...(labor ? { baseRate: labor.subtotalCents / 100 } : {}),

      // ── Disclosed inventory + the size verdict. Advisory: it sets a review
      //    flag and suggests a size. It NEVER re-prices the booking. ──
      inventoryDetail: inventory.empty ? undefined : (inventory as any),
      inventorySuggestedSize: inventoryVerdict.suggestedKey ?? undefined,
      inventoryReviewRequired: inventoryVerdict.exceedsSelected,
      numBoxes: inventory.boxes > 0 ? inventory.boxes : undefined,
      hasPiano: inventory.piano || undefined,
      hasSafe: inventory.safe || undefined,
      hasAppliances: inventory.appliances > 0 || undefined,

      // ── Assembly / disassembly as a real scope ──
      needsAssembly: data.needsAssembly ?? (inventory.assembly ? true : undefined),
      needsDisassembly: data.needsDisassembly ?? (inventory.assembly ? true : undefined),
      assemblyItems: assemblyItems || undefined,
      disassemblyItems: disassemblyItems || undefined,
      assemblyScopeKnown: assemblyRequested ? assemblyScopeKnown : undefined,
      // An assembly job whose scope nobody knows cannot be finalized by anyone
      // except an owner who has asked the customer what it is.
      assemblyApprovalRequired: assemblyRequested && !assemblyScopeKnown,

      // ── COI ──
      coiRequiredOrigin: coiOrigin ?? undefined,
      coiRequiredDest: coiDest ?? undefined,
      coiNotes: data.coiNotes,

      // Photos are RECOMMENDED, never required — this flags the admin, it does
      // not block the customer.
      photosReviewRequired: inventoryVerdict.photosRecommended && photoCount === 0,
      ipAddress: ip,
      userAgent: ua,
      // Attribution columns (Phase 2) — also kept in itemsDescription text above
      // for the Discord card; these power the marketing-tracker revenue merge.
      source: data.source,
      foundUs: data.foundUs,
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
    // Roll back the booking we just created — BEST EFFORT ONLY.
    //
    // This runs inside an error handler, so an exception here would replace the
    // payment failure we are reporting, and the customer would get an opaque
    // 500 instead of "Failed to initialize payment". Since the closeout FK
    // became ON DELETE RESTRICT, the database can also legitimately refuse this
    // delete for a booking carrying financial history — that refusal is correct
    // and must never be weakened. A booking left behind is strictly better than
    // a misreported payment error: it is logged with its id and can be cleaned
    // up by hand. The cleanup failure is logged separately, with only the
    // booking id — never the Stripe error payload or any secret.
    await prisma.booking.delete({ where: { id: booking.id } }).catch((cleanupErr) => {
      apiLogger.error(
        { cleanupErr, bookingId: booking.id },
        'Could not roll back booking after Stripe failure — left in place for manual review',
      )
    })
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

  // ── "Not sure which service" = a quote request. Also drop it into the Lead
  //    pipeline so it is tracked as a lead, not just an unpriced booking.
  //    Non-fatal.
  //
  //    RUNS BEFORE THE HAND-OVER BELOW, and the order matters: the hand-over
  //    converts the matching OPEN lead. Ingesting afterwards created a BRAND
  //    NEW lead, status NEW, for somebody who had just booked — a customer
  //    sitting in the prospect pipeline forever, and a `lead_created` trigger
  //    fired on a converted person. Ingesting first means this submission
  //    either merges into the Step-1 partial lead or creates the lead that is
  //    then immediately converted. One lead, correctly closed.
  if ((data.moveSizeKey ?? data.serviceType) === 'not-sure') {
    await ingestLeadSafe(
      {
        name: data.fullName,
        email: data.email,
        phone: data.phone,
        source: data.source ?? 'website',
        foundUs: data.foundUs,
        jobType: 'quote-request',
        moveDate: requestedDate,
        originCity: data.pickupAddresses?.[0]?.city ?? undefined,
        destCity: data.destinationAddress?.city ?? undefined,
      },
      'not-sure-booking',
    )
  }

  // ── BOOKING LIFECYCLE HAND-OVER ─────────────────────────────────────────
  // ONE call, because the ORDER of its three steps is the whole point.
  //
  //   1. convert the matching OPEN lead and propagate the visitor's marketing
  //      consent onto the durable Customer record (the canonical write);
  //   2. cancel the lead's own journeys — a person who just booked must never
  //      get "still thinking about your move?" or "did our quote arrive?";
  //   3. start the abandoned-checkout recovery sequence, which READS the
  //      consent written in step 1.
  //
  // This route used to run step 3 first and step 1 second, so for every
  // brand-new customer the consent gate read `null` and refused the recovery
  // sequence moments before the same request recorded their explicit opt-in.
  // Sequencing that by hand in a 700-line route is what allowed it; the order
  // now lives in journeys.onBookingCreated, where it is tested. Never fatal —
  // the customer's checkout is already created and returned below.
  const { convertedLeadId } = await onBookingCreated({
    bookingId: booking.id,
    email: customer.email,
    // Match the exact partial lead captured in Step 1 (session first, then email).
    bookingSessionId: data.bookingSessionId,
    marketingConsent: data.marketingConsent,
    // Controlled vocabulary + the disclosure version the visitor actually saw.
    // `booking_step_1` was an ad-hoc string, and the version was never recorded
    // at all — so a consent record could not say WHAT was agreed to.
    consentSource: 'BOOKING_FORM',
    consentVersion: CONSENT_VERSION,
  })
  if (convertedLeadId) apiLogger.info({ bookingId: booking.id, convertedLeadId }, 'lead converted (booking created)')

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
 