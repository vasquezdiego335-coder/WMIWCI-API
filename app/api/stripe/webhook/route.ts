import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { constructWebhookEvent } from '@/lib/stripe'
import { prisma } from '@/lib/db'
import { emailQueue, discordQueue, scheduledQueue, marketingQueue, smsQueue } from '@/lib/queues'
import { webhookLogger } from '@/lib/logger'
import { findAvailableSlots } from '@/lib/scheduling'
import { t, BIZ_PHONE } from '@/lib/i18n'

// ── Disable Next.js body parser — we need raw bytes for Stripe ─
export const runtime = 'nodejs'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  let event: Stripe.Event
  let rawBody: Buffer

  try {
    const chunks: Uint8Array[] = []
    const reader = req.body?.getReader()
    if (!reader) return NextResponse.json({ error: 'No body' }, { status: 400 })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    rawBody = Buffer.concat(chunks)
    event = constructWebhookEvent(rawBody, sig)
  } catch (err) {
    webhookLogger.error({ err }, 'Stripe webhook signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── Idempotency check ─────────────────────────────────────────
  const existing = await prisma.webhookLog.findUnique({
    where: { eventId: event.id },
  })
  if (existing && existing.status === 'processed') {
    webhookLogger.info({ eventId: event.id }, 'Duplicate webhook — skipping')
    return NextResponse.json({ ok: true })
  }

  // ── Log the webhook ───────────────────────────────────────────
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

  try {
    await handleStripeEvent(event)
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: 'processed', processedAt: new Date() },
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: 'failed', error: errMsg },
    })
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
      if (!bookingId) return

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking) return

      // AUTHORIZE-ONLY: the $49 is HELD (PaymentIntent requires_capture), not
      // captured. Store the PI id and move to PENDING_APPROVAL. The Payment row
      // and depositPaid=true are written later, on capture (admin approval).
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'PENDING_APPROVAL',
          depositPaid: false, // authorized, not captured yet
          stripePaymentIntentId: session.payment_intent as string,
        },
      })

      await prisma.auditLog.create({
        data: {
          action: 'PAYMENT_RECEIVED',
          bookingId,
          details: { authorized: true, amount: session.amount_total, stripeSessionId: session.id },
        },
      })

      // (No payment-receipt email — nothing has been charged yet; the $49 is
      //  only authorized. The pending-approval email below explains the hold.)

      // Queue: send pending approval email (bilingual via customer.locale)
      await emailQueue.add('pending-approval', {
        template: 'pending-approval',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          requestedDate: booking.requestedDate?.toISOString(),
          locale: booking.customer.locale,
        },
      })

      // Queue: confirmation SMS (Twilio) — bilingual, includes the hold + fallback line
      if (booking.customer.phone) {
        await smsQueue.add('deposit-confirmation-sms', {
          to: booking.customer.phone,
          message: t(booking.customer.locale, 'depositHold', { displayId: booking.displayId, phone: BIZ_PHONE }),
          bookingId,
        })
      }

      // Queue: Discord booking approval card
      await discordQueue.add('booking-created', {
        type: 'booking-created',
        bookingId,
        payload: {
          bookingId,
          displayId: booking.displayId,
          customerName: booking.customer.name,
          customerEmail: booking.customer.email,
          customerPhone: booking.customer.phone,
          originAddress: booking.originAddress,
          destAddress: booking.destAddress,
          requestedDate: booking.requestedDate?.toISOString(),
          discountType: booking.discountType,
          discountCode: booking.discountCode,
          estimatedHours: booking.estimatedHours,
          items: booking.itemsDescription,
          amountPaid: ((session.amount_total ?? 4900) / 100).toFixed(2),
          // ── Payment / balance breakdown (shown on the card) ──
          moveTotal: booking.totalEstimate,
          balanceAfterJob:
            booking.totalEstimate != null ? booking.totalEstimate - 49 : null,
          truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
          truckAddonAmount: booking.truckAddonAmount,
          // ── Moving Service Agreement status (shown on the card) ──
          agreementAccepted: booking.agreementAccepted,
          agreementVersion: booking.agreementVersion,
          agreementName: booking.agreementName,
          agreementAcceptedAt: booking.agreementAcceptedAt?.toISOString(),
        },
      })

      // Queue: marketing automation enrollment (external tool — env-gated stub)
      await marketingQueue.add('booking-paid', {
        type: 'enroll-customer',
        bookingId,
        payload: {
          email: booking.customer.email,
          name: booking.customer.name,
          phone: booking.customer.phone,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
        },
      })

      // Queue: create Discord job channels
      await discordQueue.add('create-job-channels', {
        type: 'create-job-channels',
        bookingId,
        payload: {
          bookingId,
          displayId: booking.displayId,
          customerName: booking.customer.name,
        },
      })

      // If door hanger discount pending, queue approval card
      if (booking.discountType === 'DOOR_HANGER_PENDING') {
        await discordQueue.add('discount-request', {
          type: 'discount-request',
          bookingId,
          payload: {
            bookingId,
            displayId: booking.displayId,
            customerName: booking.customer.name,
            discountCode: booking.discountCode,
          },
        })
      }

      webhookLogger.info({ bookingId }, 'Payment processed — booking moved to pending_approval')
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
