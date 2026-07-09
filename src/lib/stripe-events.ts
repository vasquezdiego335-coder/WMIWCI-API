// ════════════════════════════════════════════════════════════════════════
//  Stripe webhook CORE — framework-agnostic.
//  ────────────────────────────────────────────────────────────────────
//  ONE source of truth for "a Stripe event arrived": signature verify →
//  idempotency (webhookLog) → business handling → mark processed.
//
//  It knows NOTHING about Next.js or Express. It takes the raw body + the
//  stripe-signature header and returns an HTTP { status, body } for the
//  caller to send. That lets BOTH entry points reuse the exact same logic:
//
//    • app/api/stripe/webhook/route.ts   (Next.js API — primary)
//    • src/worker-host.ts                (Railway worker — optional)
//
//  Whichever URL you register in the Stripe Dashboard, the behavior is
//  identical, and the two can never drift apart.
// ════════════════════════════════════════════════════════════════════════
import Stripe from 'stripe'
import { constructWebhookEvent } from './stripe'
import { prisma } from './db'
import { discordQueue } from './queues'
import { fulfillPaidCheckout } from './fulfillment'
import { webhookLogger } from './logger'

export type StripeWebhookResult = {
  status: 200 | 400 | 500
  body: { ok: true } | { error: string }
}

/**
 * Verify, dedupe, handle, and record a Stripe webhook.
 *
 * @param rawBody   The EXACT bytes Stripe sent (a Buffer or the untouched
 *                  UTF-8 string). Never a re-serialized JSON object — the
 *                  signature is computed over the raw bytes.
 * @param signature The `stripe-signature` request header.
 *
 * Always resolves (never throws). Returns 200 for anything we've accepted
 * (including handled-with-internal-error) so Stripe does not retry events we
 * already own; 400/500 only for signatures/config we reject outright.
 */
export async function processStripeWebhook(
  rawBody: string | Buffer,
  signature: string | null | undefined
): Promise<StripeWebhookResult> {
  if (!signature) {
    return { status: 400, body: { error: 'Missing signature' } }
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    webhookLogger.error('STRIPE_WEBHOOK_SECRET is not set — rejecting webhook')
    return { status: 500, body: { error: 'Server misconfigured' } }
  }

  // ── Verify the signature over the RAW body ──────────────────────
  let event: Stripe.Event
  try {
    event = constructWebhookEvent(rawBody, signature)
  } catch (err) {
    webhookLogger.error({ err }, 'Stripe webhook signature verification failed')
    return { status: 400, body: { error: 'Invalid signature' } }
  }

  webhookLogger.info({ eventId: event.id, eventType: event.type }, 'Stripe webhook received')

  // ── Idempotency + handling (single try/catch) ───────────────────
  // The webhookLog upsert can throw a unique-constraint race when Stripe
  // delivers the same event concurrently. Wrapping everything in one
  // try/catch makes that race return 200, not 500.
  try {
    const existing = await prisma.webhookLog.findUnique({ where: { eventId: event.id } })
    if (existing && existing.status === 'processed') {
      webhookLogger.info({ eventId: event.id }, 'Duplicate webhook — skipping')
      return { status: 200, body: { ok: true } }
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
    const errObj =
      err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
    webhookLogger.error({ eventId: event.id, eventType: event.type, err: errObj }, 'Webhook processing failed')

    try {
      await prisma.webhookLog.updateMany({
        where: { eventId: event.id, status: 'pending' },
        data: { status: 'failed' },
      })
    } catch {
      /* best-effort */
    }

    // Return 200 to prevent Stripe from retrying — we handle retries ourselves.
    return { status: 200, body: { ok: true } }
  }

  return { status: 200, body: { ok: true } }
}

/**
 * The business switch: turn a verified Stripe event into side-effects.
 * All heavy lifting lives in fulfillPaidCheckout() (idempotent, shared with
 * the browser success-redirect backup path) and the BullMQ queues, so this
 * function only routes by event type.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const bookingId = session.metadata?.bookingId
      if (!bookingId) {
        webhookLogger.warn(
          { sessionId: session.id },
          'checkout.session.completed without metadata.bookingId — ignoring'
        )
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
