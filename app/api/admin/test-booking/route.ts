import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { testPaymentsEnabled, resolveTestAmountCents } from '@/lib/test-payments'
import { nextBookingReference } from '@/lib/booking-reference'

export const runtime = 'nodejs'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/admin/test-booking — CONTROLLED TEST ONLY.
//
//  Creates a flagged internal-test booking whose deposit is a small controlled
//  amount ($1 by default) so the owner can verify the whole authorize → approve →
//  capture → refund path WITHOUT the real $49 and WITHOUT touching public pricing.
//
//  THREE independent gates, ALL required:
//    1. process.env.ALLOW_TEST_PAYMENTS === 'true'   (OFF by default)
//    2. an authenticated session that is an OWNER      (middleware already limits
//       /api/admin to OWNER+MANAGER; can(...,'booking.test_payment') is OWNER-only)
//    3. CSRF (enforced by middleware on state-mutating /api/admin calls)
//  A normal customer cannot satisfy any of these. The booking is isInternalTest,
//  so it is excluded from every revenue aggregate/report, and its creation is
//  written to the AuditLog. Disable by unsetting the env var; remove by deleting
//  this file.
// ════════════════════════════════════════════════════════════════════════

const Body = z.object({
  email: z.string().email().max(200).optional(),
  name: z.string().max(100).optional(),
  phone: z.string().max(25).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  // GATE 1 — env flag (off by default).
  if (!testPaymentsEnabled()) {
    return NextResponse.json({ error: 'Controlled test payments are disabled.' }, { status: 403 })
  }
  // GATE 2 — OWNER only.
  const session = await getSession()
  if (!session || !can(session.role as Role, 'booking.test_payment')) {
    return NextResponse.json({ error: 'Owner only.' }, { status: 403 })
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  const data = parsed.success ? parsed.data : {}

  const amountCents = resolveTestAmountCents()
  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
  const marketingUrl = process.env.MARKETING_SITE_URL ?? 'https://www.moveitclearit.com'

  const email = (data.email ?? `owner-test+${Date.now()}@moveitclearit.com`).toLowerCase()
  const customer = await prisma.customer.upsert({
    where: { email },
    update: {},
    create: { email, name: data.name ?? 'Owner Test Booking', phone: data.phone ?? '', isFirstTime: false },
  })

  const bookingReference = await nextBookingReference()
  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      bookingReference,
      displayId: bookingReference,
      status: 'DRAFT',
      isInternalTest: true, // excluded from ALL revenue/reports
      originAddress: 'TEST — controlled payment verification',
      destAddress: 'TEST — controlled payment verification',
      itemsDescription: `CONTROLLED TEST BOOKING — $${(amountCents / 100).toFixed(2)} authorization. Initiated by ${session.name}.`,
      requestedDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      depositAmount: amountCents,
      depositPaid: false,
      customerTokenExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      agreementAccepted: true,
      agreementVersion: 'controlled-test',
      agreementName: session.name,
    },
  })

  let checkout
  try {
    checkout = await createBookingCheckout({
      bookingId: booking.id,
      customerEmail: customer.email,
      customerName: customer.name,
      description: `CONTROLLED TEST ($${(amountCents / 100).toFixed(2)})`,
      successUrl: `${appUrl}/api/stripe/checkout/success?session_id={CHECKOUT_SESSION_ID}&booking=${booking.id}`,
      cancelUrl: `${marketingUrl}/contact.html?cancelled=1`,
      amountCentsOverride: amountCents, // bypasses the $49 floor — test only
      extraMetadata: {
        internal_test: 'true', // → Payment.isInternalTest on capture
        testInitiatedBy: session.name,
        bookingReference: booking.bookingReference ?? '',
      },
    })
  } catch (err) {
    await prisma.booking.delete({ where: { id: booking.id } }).catch(() => undefined)
    apiLogger.error({ err, bookingId: booking.id }, 'controlled test-booking checkout failed')
    return NextResponse.json({ error: 'Failed to create test checkout' }, { status: 500 })
  }

  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING_PAYMENT', stripeCheckoutId: checkout.id } })

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_CREATED',
      userId: session.userId,
      bookingId: booking.id,
      details: { event: 'controlled_test_booking', amountCents, initiatedBy: session.name, isInternalTest: true },
    },
  })

  apiLogger.warn(
    { bookingId: booking.id, reference: booking.bookingReference, amountCents, by: session.name },
    'CONTROLLED TEST booking created (internal test — excluded from revenue)',
  )

  return NextResponse.json({
    ok: true,
    testMode: true,
    amount: `$${(amountCents / 100).toFixed(2)}`,
    bookingId: booking.id,
    bookingReference: booking.bookingReference,
    checkoutUrl: checkout.url,
    note: 'Internal test booking — excluded from revenue. Pay the authorization, then approve via Discord OR the admin portal to verify a single capture.',
  })
}
