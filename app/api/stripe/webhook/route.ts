import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { constructWebhookEvent } from '@/lib/stripe'
import { prisma } from '@/lib/db'
import { discordQueue } from '@/lib/queues'
import { fulfillPaidCheckout } from '@/lib/fulfillment'
import { webhookLogger } from '@/lib/logger'

// ── Force Node.js runtime (not Edge) — needed for Prisma, BullMQ, Buffer ─
export const runtime = 'nodejs'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  // ── Read raw body BEFORE any JSON parsing ──────────────────────
  // Stripe signature verification needs the exact bytes that were
  // sent.  req.text() returns the untouched UTF-8 string — this is
  // what constructEvent() expects.  Using req.json() first would
  // re-serialize the body and break the signature.
  let event: Stripe.Event

  try {
    const rawBody = await req.text()
    event = constructWebhookEvent(rawBody, sig)
  } catch (err) {
    webhookLogger.error({ err }, 'Stripe webhook signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── Idempotency + logging + processing (single try/catch) ─────
  // The upsert on webhookLog can throw a unique-constraint race when
  // Stripe delivers the same event concurrently (common with
  // price.created, charge.updated bursts).  Wrapping everything in
  // one try/catch ensures that race returns 200, not 500.
  try {
    const existing = await prisma.webhookLog.findUnique({
      where: { eventId: event.id },
    })
    if (existing && existing.status === 'processed') {
      webhookLogger.info({ eventId: event.id }, 'Duplicate webhook — skipping')
      return NextResponse.json({ ok: true })
    }

    const log = await prisma.webhookLog.upsert({
      where: { eventId: event.id },
      update: {},
      create: {
        source: 'stripe',
        eventType: event.type,
        eventId: event.id,
        payload: event as any,
        status: 'pending',
      },
    })

    await handleStripeEvent(event)
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: 'processed', processedAt: new Date() },
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    webhookLogger.error({ eventId: event.id, eventType: event.type, err: errMsg }, 'Webhook processing failed')
    // Return 200 to prevent Stripe from retrying — we handle retries ourselves
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true })
}

async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const bookingId = session.metadata?.bookingId
      if (!bookingId) {
        webhookLogger.warn({ sessionId: session.id }, 'checkout.session.completed without metadata.bookingId — ignoring')
        return
      }

      // All fulfillment (status flip + email/SMS/Discord/marketing jobs) lives
      // in the shared, idempotent helper so the browser success redirect can
      // run the exact same path as a backup when the webhook never arrives.
      await fulfillPaidCheckout({
        bookingId,
        paymentIntentId: (session.payment_intent as string) ?? null,
        amountTotalCents: session.amount_total,
        source: 'webhook',
      })
      break
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      const bookingId = pi.metadata?.bookingId
      if (!bookingId) return

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking) return

      // Update payment record
      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { status: 'FAILED' },
      })

      // Alert Discord
      await discordQueue.add('failure-alert', {
        type: 'failure-alert',
        bookingId,
        payload: {
          title: '❌ Payment Failed',
          message: `Payment failed for booking **${booking.displayId}**\nCustomer: ${booking.customer.name} (${booking.customer.email})\nReason: ${pi.last_payment_error?.message ?? 'Unknown'}`,
        },
      })

      await prisma.auditLog.create({
        data: {
          action: 'PAYMENT_FAILED',
          bookingId,
          details: { paymentIntentId: pi.id, reason: pi.last_payment_error?.message },
        },
      })
      break
    }


    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session
      const bookingId = session.metadata?.bookingId
      if (!bookingId) return
      // Booking stays in PENDING_PAYMENT — abandoned checkout job will handle it
      webhookLogger.info({ bookingId }, 'Checkout session expired')
      break
    }

    default:
      webhookLogger.debug({ eventType: event.type }, 'Unhandled Stripe event type')
  }
}
