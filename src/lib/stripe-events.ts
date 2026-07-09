// ════════════════════════════════════════════════════════════════════════
//  Stripe webhook CORE — framework-agnostic, FAST-200 design.
//  ────────────────────────────────────────────────────────────────────
//  The HTTP entry point (processStripeWebhook) does the MINIMUM before it
//  returns 200 to Stripe:
//     1. verify the signature (crypto only — no DB, no network)
//     2. hand the event to the worker via the `webhook-retry` queue
//     3. return 200
//  The HEAVY work (idempotency log + fulfillment + notifications) runs in the
//  WORKER (src/workers/webhook.worker.ts → processStripeEventJob).
//
//  WHY: doing DB writes + 6 Redis enqueues INSIDE the webhook request made the
//  200 take up to ~15s on a cold Upstash/Postgres connection, which crossed
//  Stripe's delivery timeout → "failed delivery" + retries. Returning 200 in
//  ~single-digit ms fixes that permanently.
//
//  SAFETY: if the queue handoff fails (Redis unreachable from the API), we do
//  NOT drop the event — we process it inline as a fallback (the booking status
//  flip only needs Postgres) and still return 200 so Stripe never retries a
//  slow/failed response.
//
//  Both entry points share this core:
//     • app/api/stripe/webhook/route.ts   (Next.js API — primary)
//     • src/worker-host.ts                (Railway worker — optional endpoint)
// ════════════════════════════════════════════════════════════════════════
import Stripe from 'stripe'
import { constructWebhookEvent } from './stripe'
import { prisma } from './db'
import { discordQueue, webhookRetryQueue } from './queues'
import { fulfillPaidCheckout } from './fulfillment'
import { webhookLogger } from './logger'

export type StripeWebhookResult = {
  status: 200 | 400 | 500
  body: { ok: true } | { error: string }
}

export type VerifyResult =
  | { ok: true; event: Stripe.Event }
  | { ok: false; status: 400 | 500; body: { error: string } }

/**
 * FAST signature check — crypto only, no I/O. Returns the parsed event or the
 * HTTP error to send back. Never throws.
 */
export function verifyStripeSignature(
  rawBody: string | Buffer,
  signature: string | null | undefined
): VerifyResult {
  if (!signature) {
    return { ok: false, status: 400, body: { error: 'Missing signature' } }
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    webhookLogger.error('STRIPE_WEBHOOK_SECRET is not set — rejecting webhook')
    return { ok: false, status: 500, body: { error: 'Server misconfigured' } }
  }
  try {
    const event = constructWebhookEvent(rawBody, signature)
    return { ok: true, event }
  } catch (err) {
    webhookLogger.error({ err }, 'Stripe webhook signature verification failed')
    return { ok: false, status: 400, body: { error: 'Invalid signature' } }
  }
}

/**
 * HTTP entry point. Verify → hand to worker → return 200 immediately.
 * Always resolves (never throws); returns 200 for any event we accept so
 * Stripe never retries something we already own.
 */
export async function processStripeWebhook(
  rawBody: string | Buffer,
  signature: string | null | undefined
): Promise<StripeWebhookResult> {
  const verified = verifyStripeSignature(rawBody, signature)
  if (!verified.ok) return { status: verified.status, body: verified.body }
  const event = verified.event

  webhookLogger.info({ eventId: event.id, eventType: event.type }, 'Stripe webhook received')

  // Hand off to the worker. jobId = event.id dedupes duplicate deliveries at
  // the queue level. 3s guard so a Redis stall can't hang the 200 response.
  try {
    await Promise.race([
      webhookRetryQueue.add(
        'stripe-event',
        { event },
        {
          jobId: event.id,
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        }
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('queue handoff timed out after 3s (Redis unreachable?)')), 3000)
      ),
    ])
    webhookLogger.info({ eventId: event.id }, 'Stripe event queued for worker — 200 OK')
    return { status: 200, body: { ok: true } }
  } catch (err) {
    // Redis unreachable/slow from THIS process. Don't lose the event: process
    // inline (the booking flip only needs Postgres) and still return 200.
    webhookLogger.warn(
      { eventId: event.id, err: err instanceof Error ? err.message : String(err) },
      'Queue handoff failed — processing Stripe event inline as fallback'
    )
    try {
      await processStripeEventJob(event)
    } catch (inner) {
      webhookLogger.error(
        { eventId: event.id, err: inner instanceof Error ? inner.message : String(inner) },
        'Inline fallback processing failed (event accepted; will not be retried by Stripe)'
      )
    }
    return { status: 200, body: { ok: true } }
  }
}

/**
 * HEAVY path — runs in the WORKER (or the inline fallback). Idempotency via
 * webhookLog + business handling + mark processed. Throws on failure so the
 * worker's retry policy (webhook-retry queue: 5 attempts) can re-run it.
 */
export async function processStripeEventJob(event: Stripe.Event): Promise<void> {
  const existing = await prisma.webhookLog.findUnique({ where: { eventId: event.id } })
  if (existing && existing.status === 'processed') {
    webhookLogger.info({ eventId: event.id }, 'Duplicate webhook — already processed, skipping')
    return
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

  try {
    await handleStripeEvent(event)
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: 'processed', processedAt: new Date() },
    })
  } catch (err) {
    const errObj =
      err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
    webhookLogger.error(
      { eventId: event.id, eventType: event.type, err: errObj },
      'Webhook processing failed'
    )
    await prisma.webhookLog
      .updateMany({ where: { eventId: event.id, status: 'pending' }, data: { status: 'failed' } })
      .catch(() => undefined)
    throw err // surface to the worker so it retries
  }
}

/**
 * The business switch: turn a verified Stripe event into side-effects.
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

      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { status: 'FAILED' },
      })

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
      webhookLogger.info({ bookingId }, 'Checkout session expired')
      break
    }

    default:
      webhookLogger.debug({ eventType: event.type }, 'Unhandled Stripe event type')
  }
}
