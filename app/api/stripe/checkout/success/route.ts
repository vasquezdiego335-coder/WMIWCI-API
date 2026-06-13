import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { stripe } from '@/lib/stripe'
import { fulfillPaidCheckout } from '@/lib/fulfillment'
import { webhookLogger } from '@/lib/logger'

export const runtime = 'nodejs'

// Stripe redirects the customer's browser here after they complete checkout,
// with ?session_id=xxx. This redirect is GUARANTEED (it's a 303 from Stripe),
// unlike the webhook, which depends on a correctly-configured endpoint. So we
// run the SAME idempotent fulfillment here as a safety net: if the webhook
// never arrives (stale ngrok, wrong Dashboard endpoint, mode mismatch), the
// Discord card + emails still fire. fulfillPaidCheckout() claims the booking
// atomically, so the webhook and this route can never double-process.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get('session_id')

  if (!sessionId) {
    webhookLogger.warn('Success redirect hit without session_id — sending home')
    return NextResponse.redirect(new URL('/', req.url))
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    const bookingId = session.metadata?.bookingId

    if (!bookingId) {
      webhookLogger.warn({ sessionId }, 'Success redirect: session has no metadata.bookingId')
      return NextResponse.redirect(new URL('/', req.url))
    }

    // Only fulfill if the customer actually completed checkout (mirrors the
    // webhook's checkout.session.completed trigger). A no-op if the webhook
    // already claimed it.
    if (session.status === 'complete') {
      const result = await fulfillPaidCheckout({
        bookingId,
        paymentIntentId: (session.payment_intent as string) ?? null,
        amountTotalCents: session.amount_total,
        source: 'success_redirect',
      })
      webhookLogger.info(
        { bookingId, processed: result.processed, reason: result.reason },
        'Success-redirect fulfillment ran'
      )
    } else {
      webhookLogger.info({ bookingId, status: session.status }, 'Success redirect: session not complete — not fulfilling')
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { customerToken: true, status: true },
    })

    if (!booking?.customerToken) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    // Send the customer to their self-service portal.
    return NextResponse.redirect(new URL(`/my-booking/${booking.customerToken}`, req.url))
  } catch (err) {
    webhookLogger.error(
      { sessionId, err: err instanceof Error ? err.message : String(err) },
      'Success redirect failed — sending customer home'
    )
    return NextResponse.redirect(new URL('/', req.url))
  }
}
