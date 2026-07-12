import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { BOOKING_FEE_CENTS, createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { AGREEMENT_VERSION } from '@/lib/agreement'
import { notifyBookingCreated } from '@/lib/notify'
import { checkServiceArea, travelFeeDollars, type AddressInput } from '@/lib/service-area'
import { ELEVATOR_LABELS, PARKING_LABELS, BUILDING_LABELS } from '@/lib/booking-display'
import { etDateTimeToInstant } from '@/lib/scheduling'

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

  // ── Client-side estimate snapshot (display only — NEVER drives pricing).
  //    Shown to the owner so the approval card matches what the customer saw. ──
  estimateTotal: z.coerce.number().min(0).max(100000).optional(),
  estimateAddons: z.coerce.number().min(0).max(100000).optional(),

  // ── Marketing attribution (?src= from the QR / landing URL) ──
  source: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  // "Where did you find us?" self-report from the booking-form dropdown.
  foundUs: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),

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

const SERVICE_MAP: Record<string, { label: string; price: number }> = {
  'little-studio': { label: 'Little Studio', price: 359 },
  'half-studio': { label: 'Half Studio', price: 409 },
  'full-studio': { label: 'Full Studio', price: 509 },
  '1br': { label: '1 Bedroom', price: 599 },
  '2br': { label: '2 Bedrooms', price: 699 },
  '3br': { label: '3 Bedrooms', price: 949 },
  '4br': { label: '4 Bedrooms', price: 1249 },
  '5br': { label: '5 Bedrooms', price: 1549 },
  'not-sure': { label: 'Need a Quote', price: 0 },
}

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
    lines.push('Note: Stairs, long walks, and heavy items may add an extra fee.')
  }
  // Owner-facing snapshot of the estimate the CUSTOMER saw (display only —
  // pricing stays server-computed in baseRate/totalEstimate).
  if (typeof estimate?.total === 'number' && estimate.total > 0) {
    const addons = typeof estimate.addons === 'number' && estimate.addons > 0 ? ` (includes $${estimate.addons} access add-ons)` : ''
    lines.push(`Customer-side estimate: $${estimate.total}${addons}`)
  }
  if (jobDetails?.trim()) lines.push(`Notes: ${jobDetails.trim()}`)
  return lines.join('\n')
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
  const originDisplay = data.pickupAddresses?.length
    ? formatAddr(data.pickupAddresses[0])
    : data.addressFrom?.trim() ?? ''
  const destDisplay = data.destinationAddress
    ? formatAddr(data.destinationAddress)
    : data.addressTo?.trim() ?? ''

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
    { total: data.estimateTotal, addons: data.estimateAddons },
  )
    + (data.source ? `\nSource: ${data.source}` : '')
    + (data.photos?.length ? `\n📷 ${data.photos.length} job photo(s) attached — view in admin/portal` : '')
    + (sa?.zone === 'extended_nj' ? '\nExtended service-area fee: $50 (due on move day)' : '')
    + (sa?.zone === 'primary' ? '\nService area: Primary — no travel fee' : '')
    + (sa?.manualReviewRequired ? '\n⚠ Service area: Owner review required — travel price pending; do not confirm a final travel price' : '')
    + ((data.pickupAddresses ?? []).slice(1).map(formatAddr).filter(Boolean).length
        ? `\nAdditional pickup(s): ${(data.pickupAddresses ?? []).slice(1).map(formatAddr).filter(Boolean).join(' | ')}`
        : '')
  const svc = SERVICE_MAP[data.serviceType]
  const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      status: 'DRAFT',
      originAddress: originDisplay || 'Provided at confirmation',
      destAddress: destDisplay || 'Provided at confirmation',
      itemsDescription,
      requestedDate,
      depositAmount: BOOKING_FEE_CENTS,
      depositPaid: false,
      truckAddonDueOnMoveDay,
      truckAddonAmount: truckAddonDueOnMoveDay ? TRUCK_PICKUP_RETURN_AMOUNT_CENTS : 0,
      baseRate: svc?.price ?? null,
      // Move-day total = base labor + travel fee (NY/manual stay pending -> fee 0 here).
      totalEstimate: svc?.price != null ? svc.price + travelFeeUsd : travelFeeUsd || null,
      // ── Service area (server-computed; travel fee is due on move day, not in Stripe) ──
      serviceAreaZone: (sa?.zone ?? null) as any,
      travelFee: travelFeeCents,
      travelFeeDueOnMoveDay: travelFeeCents > 0,
      manualReviewRequired: sa?.manualReviewRequired ?? false,
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
 