import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { AGREEMENT_VERSION } from '@/lib/agreement'

// ════════════════════════════════════════════════════════════════════════
//  GET /api/stripe/checkout/resume?booking=<id>
//
//  THE MISSING DESTINATION (link audit 2026-07-25). All three
//  abandoned-checkout recovery emails linked to
//  `${APP_URL}/api/stripe/checkout?resume=<id>` — a route that never existed
//  (app/api/stripe/checkout has only cancel/ and success/, and nothing handled
//  a `resume` param). Every "finish your booking" button in that journey was a
//  404. The journey is flag-gated off, so no customer has hit it yet.
//
//  What this does: for a booking that is genuinely still awaiting its deposit,
//  create a FRESH Stripe Checkout session — the same $49 manual-capture
//  authorization the public booking flow creates — and redirect the customer
//  into it. Stripe sessions expire (~24h), so a stale one cannot simply be
//  re-opened; a new session is the only correct way to resume.
//
//  DELIBERATE GUARDS (each one prevents a way a customer could be wronged):
//    • PENDING_PAYMENT only. A booking that already advanced (confirmed,
//      cancelled, completed) redirects to its portal instead of being sent to
//      pay again.
//    • depositPaid ⇒ never a new session. This is the double-charge guard: a
//      paid customer can never be walked into a second authorization.
//    • Internal test bookings are refused outright.
//    • Rate-limited by IP, and the id is an opaque cuid, so this is not a
//      usable enumeration surface.
//    • No payment is CAPTURED here. capture_method stays 'manual' (inherited
//      from createBookingCheckout) — funds are held until an owner approves,
//      exactly like the normal flow.
//
//  A GET is correct: it is the target of a link in an email client.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Where to send someone whose booking cannot be resumed. Never a dead end. */
function fallbackUrl(token?: string | null): string {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  const site = (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
  if (token && app) return `${app}/my-booking/${token}`
  return `${site}/booking-form.html?src=resume_unavailable`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Accept `booking` (canonical) and `resume` (what the shipped emails used, so
  // any already-queued recovery email still works once this deploys).
  const id = (req.nextUrl.searchParams.get('booking') ?? req.nextUrl.searchParams.get('resume') ?? '').trim()
  if (!id || id.length > 60) {
    return NextResponse.redirect(fallbackUrl(), { status: 302 })
  }

  const rl = await rateLimit(LIMITS.booking, [clientIp(req)])
  if (!rl.ok) return tooManyRequests(rl)

  try {
    const booking = await prisma.booking.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        depositPaid: true,
        isInternalTest: true,
        customerToken: true,
        bookingReference: true,
        requestedDate: true,
        itemsDescription: true,
        customer: { select: { email: true, name: true } },
      },
    })

    if (!booking) {
      apiLogger.info({ id }, 'checkout resume: booking not found')
      return NextResponse.redirect(fallbackUrl(), { status: 302 })
    }
    if (booking.isInternalTest) {
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }
    // DOUBLE-CHARGE GUARD: already paid, or moved past payment → portal, not Stripe.
    if (booking.depositPaid || booking.status !== 'PENDING_PAYMENT') {
      apiLogger.info(
        { bookingId: booking.id, status: booking.status, depositPaid: booking.depositPaid },
        'checkout resume refused — booking is not awaiting a deposit'
      )
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }

    const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')
    const marketingUrl = (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
    const svcLabel = booking.itemsDescription?.split('\n')[0]?.replace('Service: ', '') ?? 'Moving service'
    const dateLabel = booking.requestedDate ? booking.requestedDate.toISOString().slice(0, 10) : 'date TBD'

    const session = await createBookingCheckout({
      bookingId: booking.id,
      customerEmail: booking.customer.email,
      customerName: booking.customer.name,
      description: `${svcLabel} move - ${dateLabel}`,
      successUrl: `${appUrl}/api/stripe/checkout/success?session_id={CHECKOUT_SESSION_ID}&booking=${booking.id}`,
      cancelUrl: `${marketingUrl}/contact.html?cancelled=1`,
      agreementAccepted: true,
      agreementVersion: AGREEMENT_VERSION,
      extraMetadata: {
        bookingReference: booking.bookingReference ?? '',
        resumed: 'true', // finance traceability: this session came from recovery
      },
    })

    if (!session.url) {
      apiLogger.error({ bookingId: booking.id }, 'checkout resume: Stripe returned no session url')
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }
    apiLogger.info({ bookingId: booking.id, sessionId: session.id }, 'checkout resume: new session created')
    return NextResponse.redirect(session.url, { status: 302 })
  } catch (err) {
    // Never show a Stripe/DB error to a customer who clicked a link in an email.
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), id }, 'checkout resume failed')
    return NextResponse.redirect(fallbackUrl(), { status: 302 })
  }
}
