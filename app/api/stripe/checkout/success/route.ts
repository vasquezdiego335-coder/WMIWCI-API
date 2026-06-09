import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { stripe } from '@/lib/stripe'

// Stripe redirects here after successful payment with ?session_id=xxx
// The actual fulfilment is handled by the webhook (checkout.session.completed).
// This route just finds the booking and sends the customer to their portal.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get('session_id')

  if (!sessionId) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    const bookingId = session.metadata?.bookingId

    if (!bookingId) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { customerToken: true, status: true },
    })

    if (!booking?.customerToken) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    // Send customer to their self-service portal
    return NextResponse.redirect(
      new URL(`/my-booking/${booking.customerToken}`, req.url)
    )
  } catch {
    return NextResponse.redirect(new URL('/', req.url))
  }
}
