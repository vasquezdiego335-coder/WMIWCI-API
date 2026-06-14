import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { BOOKING_FEE_CENTS, createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { AGREEMENT_VERSION } from '@/lib/agreement'

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
  stairs: z.coerce.boolean().optional(),
  longWalk: z.coerce.boolean().optional(),
  heavyItems: z.coerce.boolean().optional(),

  // ── Marketing attribution (?src= from the QR / landing URL) ──
  source: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),

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
  const timeStr = time ?? '07:00'
  const dt = new Date(`${date}T${timeStr}:00`)
  return isNaN(dt.getTime()) ? new Date() : dt
}

type AccessFlags = { stairs?: boolean; longWalk?: boolean; heavyItems?: boolean }

function buildDescription(
  serviceType: string,
  truckOption?: string,
  jobDetails?: string,
  access?: AccessFlags,
): string {
  const svc = SERVICE_MAP[serviceType]
  const lines: string[] = []
  lines.push(`Service: ${svc ? svc.label : serviceType}`)
  if (truckOption) lines.push(`Truck: ${TRUCK_LABELS[truckOption] ?? truckOption}`)
  if (truckOption === 'truck-pickup-return') {
    lines.push('Truck add-on due on move day: $50 (not charged in Stripe)')
  }
  // Access difficulty — verbose lines + fee note, only when something is selected.
  const accessLines: string[] = []
  if (access?.stairs) accessLines.push('Stairs: No elevator / flights to carry up or down')
  if (access?.longWalk) accessLines.push('Long walk: Far from the door to the truck or parking')
  if (access?.heavyItems) accessLines.push('Heavy items: Piano, safe, appliances, dense furniture')
  if (accessLines.length) {
    lines.push(...accessLines)
    lines.push('Note: Stairs, long walks, and heavy items may add an extra fee.')
  }
  if (jobDetails?.trim()) lines.push(`Notes: ${jobDetails.trim()}`)
  return lines.join('\n')
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
  const itemsDescription = buildDescription(data.serviceType, data.truckOption, data.jobDetails, {
    stairs: data.stairs,
    longWalk: data.longWalk,
    heavyItems: data.heavyItems,
  }) + (data.source ? `\nSource: ${data.source}` : '')
  const svc = SERVICE_MAP[data.serviceType]
  const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      status: 'DRAFT',
      originAddress: data.addressFrom?.trim() || 'Provided at confirmation',
      destAddress: data.addressTo?.trim() || 'Provided at confirmation',
      itemsDescription,
      requestedDate,
      depositAmount: BOOKING_FEE_CENTS,
      depositPaid: false,
      truckAddonDueOnMoveDay,
      truckAddonAmount: truckAddonDueOnMoveDay ? TRUCK_PICKUP_RETURN_AMOUNT_CENTS : 0,
      baseRate: svc?.price ?? null,
      totalEstimate: svc?.price ?? null,
      discountCode: data.discountCode,
      discountType: discountType as any,
      discountPercent,
      ipAddress: ip,
      userAgent: ua,
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

  // MESSAGING POLICY: no email/SMS is sent at booking creation. The system sends
  // exactly four customer messages downstream — FINAL CONFIRMATION (email + SMS)
  // when payment completes (fulfillPaidCheckout), and PRE-APPROVAL (email + SMS)
  // when an admin approves in Discord. The Stripe Checkout URL is returned in the
  // response below and the customer is redirected straight to it, so the old
  // pre-payment "booking-confirmation" email (and the abandoned-checkout recovery
  // email) were both removed.

  apiLogger.info({ bookingId: booking.id, customerId: customer.id, serviceType: data.serviceType }, 'Booking created')

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
 