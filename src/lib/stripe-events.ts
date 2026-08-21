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
import type { PaymentStatus } from '@prisma/client'
import { constructWebhookEvent } from './stripe'
import { prisma } from './db'
import { discordQueue, webhookRetryQueue } from './queues'
import { fulfillPaidCheckout } from './fulfillment'
import { webhookLogger } from './logger'
import { refundPatch, disputeOutcome, disputeIsAlertable } from './payment-events'

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

// ════════════════════════════════════════════════════════════════════════
//  DEPOSIT LINK — the confirmed-payment path (owner spec 2026-08-15)
//  ----------------------------------------------------------------------
//  ORDER OF OPERATIONS, and why it is this order:
//    1. refuse anything Stripe has not called PAID
//    2. record the money + mark the link paid + queue the notification, in ONE
//       transaction (markDepositPaid)
//    3. enqueue the Discord job
//  Discord is LAST and is fully guarded. A Discord outage, a missing webhook
//  URL, a rate limit — none of them can throw here, because throwing would fail
//  the webhook job, make Stripe retry, and put a completed payment back into an
//  "unprocessed" state over a chat message.
// ════════════════════════════════════════════════════════════════════════
async function handleDepositSession(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<void> {
  const depositRequestId = session.metadata?.depositRequestId as string
  const log = webhookLogger.child({ depositRequestId, sessionId: session.id, eventId: event.id })

  // Load what THIS deposit is supposed to cost, so the webhook can cross-check
  // the money Stripe reports against the money we asked for. A read failure here
  // must not credit anything, so it is treated as "cannot confirm".
  const { isConfirmedDepositSession, isAmountOrCurrencyMismatch } = await import('./deposit-links')
  let expected: { amountCents: number; currency: string | null } | undefined
  try {
    const { prisma } = await import('./db')
    const row = await prisma.depositRequest.findUnique({
      where: { id: depositRequestId },
      select: { amountCents: true, currency: true },
    })
    if (row) expected = { amountCents: row.amountCents, currency: row.currency }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'could not load the deposit row to verify the amount — not crediting')
    return
  }

  // THE gate, and it is a pure function so the rule is unit-tested rather than
  // inferred from this call site. `checkout.session.completed` fires for delayed
  // payment methods BEFORE the money is confirmed — only 'paid' with a real
  // amount_total that MATCHES the expected deposit amount and currency may touch
  // the ledger or notify anyone.
  const gate = isConfirmedDepositSession(session, expected)
  if (!gate.confirmed) {
    if (isAmountOrCurrencyMismatch(gate.reason)) {
      // A paid session whose amount or currency does not match what we asked
      // for. Do NOT mark paid; flag it loudly with everything a human needs to
      // reconcile it by hand. Money that really moved is still safe on Stripe's
      // side; we are refusing to write an UNVERIFIED figure to our ledger.
      log.error(
        {
          reason: gate.reason,
          expectedAmountCents: expected?.amountCents,
          stripeAmountTotal: session.amount_total,
          expectedCurrency: expected?.currency ?? 'usd',
          stripeCurrency: session.currency,
          eventId: event.id,
          sessionId: session.id,
        },
        'DEPOSIT AMOUNT/CURRENCY MISMATCH — payment NOT applied, needs manual reconciliation'
      )
      return
    }
    log.info({ reason: gate.reason }, 'deposit session is NOT a confirmed payment — no ledger write, no notification')
    return
  }
  const amountPaidCents = gate.amountCents

  const { markDepositPaid } = await import('./deposit-service')
  const result = await markDepositPaid({
    depositRequestId,
    checkoutSessionId: session.id,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
    stripeEventId: event.id,
    amountPaidCents,
    livemode: event.livemode,
    currency: session.currency ?? 'usd',
  })

  if (!result.applied) {
    // The common case here is a duplicate delivery of the same event, or the
    // async_payment_succeeded twin of a completed session. Both are correct
    // no-ops — and critically, NO second Discord message is produced.
    log.info({ reason: result.reason }, 'deposit payment not applied (already recorded)')
    return
  }

  // Fire-and-forget by design: the money is already recorded and the row
  // carries discordStatus=PENDING, so a failure here is recoverable from the
  // admin list rather than lost.
  const { queueDepositNotification } = await import('./discord-payments')
  await queueDepositNotification(depositRequestId).catch((err) =>
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'deposit Discord notification could not be queued (payment is recorded; retry from the admin list)'
    )
  )
}

/** Locate a Payment by its Stripe intent id (preferred) or charge id. */
async function findPaymentByStripeIds(intentId: string | null, chargeId: string | null) {
  if (intentId) {
    const p = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intentId } })
    if (p) return p
  }
  if (chargeId) {
    const p = await prisma.payment.findUnique({ where: { stripeChargeId: chargeId } })
    if (p) return p
  }
  return null
}

/**
 * The business switch: turn a verified Stripe event into side-effects.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session

      // ── DEPOSIT LINK first, and it RETURNS ────────────────────────────────
      // A deposit session also carries metadata.bookingId (so the Stripe
      // dashboard shows which move it belongs to). Falling through to
      // fulfillPaidCheckout would flip a still-unpaid booking to
      // PENDING_APPROVAL off a deposit that has nothing to do with the $49
      // authorization. The kind of payment decides the handler, not the
      // presence of a booking id.
      if (session.metadata?.depositRequestId) {
        await handleDepositSession(event, session)
        return
      }

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

    // Delayed payment methods (ACH, some wallets) complete the session as
    // `unpaid`/`processing` and confirm LATER with this event. Without it a
    // customer who paid by a delayed method would never be credited.
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.metadata?.depositRequestId) {
        await handleDepositSession(event, session)
        return
      }
      break
    }

    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session
      const depositRequestId = session.metadata?.depositRequestId
      if (!depositRequestId) break
      // Nothing to reverse — a failed async payment never marked anything paid.
      // The link stays ACTIVE so the customer can simply try again.
      webhookLogger.warn({ depositRequestId, sessionId: session.id }, 'deposit async payment failed — link left active')
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

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null
      const payment = await findPaymentByStripeIds(intentId, charge.id)
      if (!payment) {
        webhookLogger.warn({ chargeId: charge.id, intentId }, 'charge.refunded for an unknown payment — logged only')
        break
      }
      const latestRefundId = charge.refunds?.data?.[0]?.id ?? null
      // amount_refunded is CUMULATIVE — refundPatch is monotonic + replay-safe.
      const patch = refundPatch(
        { amount: payment.amount, refundedAmountCents: payment.refundedAmountCents, status: payment.status },
        charge.amount_refunded,
        latestRefundId,
      )
      await prisma.payment.update({ where: { id: payment.id }, data: { ...patch, status: patch.status as PaymentStatus } })
      await prisma.auditLog.create({
        data: {
          action: 'PAYMENT_REFUNDED',
          bookingId: payment.bookingId,
          details: {
            chargeId: charge.id,
            paymentIntentId: intentId,
            amountRefunded: charge.amount_refunded,
            capturedAmount: payment.amount,
            newStatus: patch.status,
            refundId: latestRefundId,
          },
        },
      })
      webhookLogger.info({ paymentId: payment.id, amountRefunded: charge.amount_refunded, status: patch.status }, 'refund recorded')
      break
    }

    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute
      const intentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id ?? null
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? null
      const payment = await findPaymentByStripeIds(intentId, chargeId)
      const phase = event.type === 'charge.dispute.created' ? 'created' : event.type === 'charge.dispute.closed' ? 'closed' : 'updated'
      const outcome = disputeOutcome(dispute.status)
      if (payment) {
        // Dispute state is tracked ALONGSIDE money truth — status is untouched.
        await prisma.payment.update({
          where: { id: payment.id },
          data: { stripeDisputeId: dispute.id, disputeStatus: dispute.status },
        })
        await prisma.auditLog.create({
          data: {
            action: 'PAYMENT_DISPUTED',
            bookingId: payment.bookingId,
            details: { disputeId: dispute.id, phase, status: dispute.status, outcome, amount: dispute.amount, chargeId, paymentIntentId: intentId },
          },
        })
      } else {
        webhookLogger.warn({ disputeId: dispute.id, intentId, chargeId }, 'dispute for an unknown payment — logged only')
      }
      // Surface disputes prominently — owners act in Discord.
      if (disputeIsAlertable(dispute.status, phase)) {
        const title = phase === 'closed'
          ? (outcome === 'won' ? '✅ Dispute WON' : outcome === 'lost' ? '🚨 Dispute LOST' : '⚖️ Dispute closed')
          : '🚨 Payment Dispute Opened'
        await discordQueue
          .add('failure-alert', {
            type: 'failure-alert',
            bookingId: payment?.bookingId,
            payload: {
              title,
              message: `${title}\n${payment ? `Booking payment ${payment.bookingId}` : `Charge ${chargeId ?? dispute.id}`}\nStatus: ${dispute.status}\nAmount: $${(dispute.amount / 100).toFixed(2)}\nDispute: ${dispute.id}`,
            },
          })
          .catch((err) => webhookLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'dispute Discord alert enqueue failed (non-fatal)'))
      }
      break
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      const payment = await findPaymentByStripeIds(pi.id, null)
      // A released authorization (deny-before-capture) usually has NO Payment row.
      if (payment && payment.status !== 'COMPLETED' && payment.status !== 'REFUNDED') {
        await prisma.auditLog.create({
          data: { action: 'PAYMENT_FAILED', bookingId: payment.bookingId, details: { paymentIntentId: pi.id, reason: 'payment_intent.canceled (authorization released)' } },
        })
      } else {
        webhookLogger.info({ paymentIntentId: pi.id }, 'payment_intent.canceled (no captured payment to update)')
      }
      break
    }

    default:
      webhookLogger.debug({ eventType: event.type }, 'Unhandled Stripe event type')
  }
}
