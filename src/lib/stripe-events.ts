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
//  flip only needs Postgres).
//
//  ITEM B3 — AND IF THAT INLINE FALLBACK ALSO FAILS, WE RETURN 500. This used
//  to return 200, which told Stripe the event was handled when it had been
//  neither stored durably nor processed: Stripe never retried, the webhook_logs
//  'failed' row had no reader, and the event was gone. Worst for
//  charge.dispute.created, which has no second trigger and a hard evidence
//  deadline. A non-2xx hands the event back to Stripe's own ~3-day retry
//  schedule (with its delivery-failure alerting) — the durable retry of last
//  resort this design was missing.
//
//  ITEM R3 — AND A SKIP IS NOT A SUCCESS. The 'processing' lease makes exactly
//  one runner own an event, but exclusivity alone turned a killed run into a
//  silently lost one: the retry saw the lease, RETURNED NORMALLY, and the
//  worker marked the job COMPLETED. Only 'processed' means finished; a live
//  lease answers 409 so the delivery comes back. The lease itself is sized to
//  the retry cadence it has to survive (WEBHOOK_LEASE_MS below).
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
import {
  fulfillPaidCheckout,
  LEDGER_UNREADABLE,
  MIGRATION_NOT_APPLIED,
  NO_DURABLE_HANDOFF,
  RESUME_IN_PROGRESS,
} from './fulfillment'
import { webhookLogger } from './logger'
import { handleCheckoutSessionExpired } from './checkout-expiry'
import { refundPatch, disputeOutcome, disputeIsAlertable } from './payment-events'

export type StripeWebhookResult = {
  /** 200 = queued or genuinely finished. 409 = another runner holds a LIVE
   *  lease, so this delivery did NOTHING and must come back (ITEM R3).
   *  500 = neither queued nor processed. 400 = bad signature. */
  status: 200 | 400 | 409 | 500
  body: { ok: true } | { error: string }
}

/** The one non-Postgres dependency the business switch has. Injected so the
 *  "fulfilment delivered nothing ⇒ do NOT record this event processed" contract
 *  can be tested without a live Redis; production always uses the real one. */
export type EventHandlerDeps = {
  fulfill: (params: Parameters<typeof fulfillPaidCheckout>[0]) => Promise<Awaited<ReturnType<typeof fulfillPaidCheckout>>>
}

export function defaultEventHandlerDeps(): EventHandlerDeps {
  return { fulfill: (params) => fulfillPaidCheckout(params) }
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

/** The two things the HTTP entry point can do with a verified event. Injected
 *  so the 200-vs-500 contract can be exercised offline; production always uses
 *  defaultWebhookHandoff() (both call sites pass nothing). */
export type WebhookHandoff = {
  /** Put the event on the webhook-retry queue. Rejects/hangs when Redis is down. */
  enqueue: (event: Stripe.Event) => Promise<unknown>
  /** Do the heavy work in THIS process. Throws when it could not be done. */
  processInline: (event: Stripe.Event) => Promise<void>
}

export function defaultWebhookHandoff(): WebhookHandoff {
  return {
    enqueue: (event) =>
      webhookRetryQueue.add(
        'stripe-event',
        { event },
        {
          // jobId = event.id dedupes duplicate deliveries at the queue level.
          jobId: event.id,
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        }
      ),
    processInline: processStripeEventJob,
  }
}

/**
 * HTTP entry point. Verify → hand to worker → return 200 immediately.
 * Always resolves (never throws). Returns 200 when the event is durably
 * QUEUED or has actually been PROCESSED — and 500 when it is neither, so
 * Stripe retries it (ITEM B3).
 */
export async function processStripeWebhook(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  handoff: WebhookHandoff = defaultWebhookHandoff()
): Promise<StripeWebhookResult> {
  const verified = verifyStripeSignature(rawBody, signature)
  if (!verified.ok) return { status: verified.status, body: verified.body }
  const event = verified.event

  webhookLogger.info({ eventId: event.id, eventType: event.type }, 'Stripe webhook received')

  // Hand off to the worker. 3s guard so a Redis stall can't hang the 200.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      handoff.enqueue(event),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('queue handoff timed out after 3s (Redis unreachable?)')), 3000)
      }),
    ])
    webhookLogger.info({ eventId: event.id }, 'Stripe event queued for worker — 200 OK')
    return { status: 200, body: { ok: true } }
  } catch (err) {
    // Redis unreachable/slow from THIS process. Don't lose the event: process
    // inline (the booking flip only needs Postgres). 200 only if that WORKS.
    webhookLogger.warn(
      { eventId: event.id, err: err instanceof Error ? err.message : String(err) },
      'Queue handoff failed — processing Stripe event inline as fallback'
    )
    try {
      await handoff.processInline(event)
    } catch (inner) {
      // ── ITEM R3 — A SKIP IS NOT A SUCCESS ────────────────────────────────
      // Another runner holds a LIVE lease on this event. Nothing was done here
      // and the event is NOT finished, so this delivery must come back. 409
      // (not 500) because nothing is broken — the work is simply owned by
      // someone else right now; Stripe re-delivers on any non-2xx.
      if (isWebhookLeaseHeld(inner)) {
        webhookLogger.warn(
          { eventId: event.id, eventType: event.type },
          'Inline fallback found the event held by another runner — 409 so this delivery is retried (it is NOT finished)',
        )
        return { status: 409, body: { error: 'Webhook event is held by another runner — retry this event' } }
      }
      // ── ITEM B3 — TELL STRIPE THE TRUTH ──────────────────────────────────
      // The event was NOT queued (that is why we are here) and inline
      // processing threw, so nothing durable exists anywhere. A 200 here ended
      // the only retry that could still deliver it — including the
      // MIGRATION_NOT_APPLIED throw below, which exists precisely so the event
      // is replayed once the SQL lands. 500 → Stripe retries for ~3 days and
      // alerts on the failing endpoint.
      const message = inner instanceof Error ? inner.message : String(inner)
      webhookLogger.error(
        { eventId: event.id, eventType: event.type, err: message },
        'Inline fallback processing FAILED — returning 500 so Stripe retries this event'
      )
      return { status: 500, body: { error: 'Webhook processing failed — retry this event' } }
    }
    return { status: 200, body: { ok: true } }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** ITEM R3 — how long a run may hold the 'processing' lease before another
 *  runner may take the event over.
 *
 *  SIZED TO THE REAL RETRY CADENCE, not to a round number. Every delivery that
 *  can rescue a killed run arrives inside ~2.5 minutes: the `webhook-retry`
 *  queue is 5 attempts on a 10s exponential backoff (src/lib/queues/index.ts:83
 *  → re-runs at roughly t+10s, t+30s, t+70s, t+150s). The previous TEN-MINUTE
 *  lease outlived every single one of them, so a process killed mid-run was
 *  never reclaimed by any of its own retries — the lease inverted the purpose
 *  it was added for.
 *
 *  60s is comfortably longer than any healthy run (the fan-out's worst case is
 *  the 5s enqueue guard plus the direct owner notice — ~10s measured with Redis
 *  dead) and short enough that the THIRD delivery (~t+70s) can reclaim a dead
 *  lease with two attempts still in hand. Reclaiming a run that is somehow
 *  still alive is safe: the fulfilment claim is one conditional UPDATE and
 *  every handoff carries a deterministic job id (src/lib/fulfillment.ts). */
export const WEBHOOK_LEASE_MS = 60 * 1000

/** ITEM R3 — this runner could not take the event AND the event is not
 *  finished: another runner holds a live lease. It is a SKIP, never a success.
 *  Thrown so the queue retries the job and so the HTTP entry point answers
 *  non-2xx — a 200 here ends the retry chain on a row nobody will revisit,
 *  which is exactly how a killed run became a permanently lost event. */
export class WebhookLeaseHeldError extends Error {
  /** Structural marker so a cross-module/instance check still works. */
  readonly webhookLeaseHeld = true
  constructor(eventId: string, status: string | null | undefined) {
    super(
      `Stripe event ${eventId} is held by another runner (webhook_logs.status=${status ?? 'unknown'}). ` +
        'Nothing was processed by this delivery and the event is NOT finished — it must be retried.',
    )
    this.name = 'WebhookLeaseHeldError'
  }
}

export function isWebhookLeaseHeld(err: unknown): boolean {
  if (err instanceof WebhookLeaseHeldError) return true
  return typeof err === 'object' && err !== null && (err as { webhookLeaseHeld?: unknown }).webhookLeaseHeld === true
}

/**
 * HEAVY path — runs in the WORKER (or the inline fallback). Idempotency via
 * webhookLog + business handling + mark processed. Throws on failure so the
 * worker's retry policy (webhook-retry queue: 5 attempts) can re-run it.
 *
 * ITEM B3 — the event claim is ATOMIC. It used to be findUnique-then-upsert
 * (read-then-act), which allowed two runners — the inline fallback and the
 * late-arriving queue job — to run the handler concurrently. That is money-safe
 * (fulfillPaidCheckout's conditional UPDATE lets exactly one caller win, and
 * that code is correct), but it also let a no-op LOSER stamp the log
 * 'processed' while the WINNER later rolled back, after which every future
 * retry skipped the event forever. One conditional UPDATE decides the owner;
 * the success stamp and the failure downgrade are both guarded on still
 * holding the lease (by its TOKEN, not merely by its status).
 *
 * ITEM R3 — a SKIP is not a SUCCESS. Losing the claim returns normally ONLY
 * when the row says 'processed' (the event is genuinely finished). Every other
 * skip THROWS, so the delivery comes back instead of being retired: a runner
 * killed after stamping 'processing' used to make its own retry return
 * normally, the worker mark the job COMPLETED, and the event vanish.
 */
export async function processStripeEventJob(
  event: Stripe.Event,
  deps: EventHandlerDeps = defaultEventHandlerDeps()
): Promise<void> {
  // Create-if-absent. `eventId` is @unique, so a concurrent create loses here
  // rather than producing a second row for the same event.
  await prisma.webhookLog.upsert({
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

  // THE CLAIM. Claimable = never started ('pending'), previously failed
  // ('failed' — this is the retry), or a lease that has expired.
  //
  // `leaseAt` is also this run's LEASE TOKEN: it is written into processedAt by
  // the claim, and both terminal writes below are conditional on finding it
  // still there. Guarding on `status:'processing'` alone is not exclusive — a
  // run whose lease expired and was reclaimed by another runner would still
  // match, and could stamp 'processed' over work that is still in flight.
  const leaseAt = new Date()
  const staleBefore = new Date(leaseAt.getTime() - WEBHOOK_LEASE_MS)
  const claim = await prisma.webhookLog.updateMany({
    where: {
      eventId: event.id,
      OR: [
        { status: { in: ['pending', 'failed'] } },
        { status: 'processing', processedAt: null },
        { status: 'processing', processedAt: { lt: staleBefore } },
      ],
    },
    // processedAt doubles as the lease stamp while status is 'processing'; the
    // success write below overwrites it with the real completion time.
    data: { status: 'processing', processedAt: leaseAt },
  })

  if (claim.count === 0) {
    // ITEM T3 — a read failure is not a state HERE either. Swallowing it into
    // `null` made the code answer "another runner holds the lease" about a row
    // it never saw. The throw is right either way (both are retryable), but the
    // reason must be the true one: a lease-held error is logged as ordinary
    // contention by src/workers/webhook.worker.ts, while a database that cannot
    // answer is a real failure and must read like one.
    let row: { status: string } | null = null
    let readError: string | null = null
    try {
      row = await prisma.webhookLog.findUnique({ where: { eventId: event.id }, select: { status: true } })
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err)
    }
    if (readError) {
      webhookLogger.error(
        { eventId: event.id, eventType: event.type, err: readError },
        'Webhook event could not be claimed AND its state could not be read — this delivery did nothing and the ' +
          'event is NOT finished; it must be retried',
      )
      throw new Error(
        `Stripe event ${event.id} could not be claimed and its webhook_logs row could not be read (${readError}). Nothing was processed by this delivery — retry it.`,
      )
    }

    // ── ITEM R3 — FINISHED and SKIPPED are not the same answer ─────────────
    // 'processed' is the ONLY state in which this event is genuinely done, and
    // therefore the only one a caller may report as success. Anything else
    // means a live lease: a run that may still be alive, or one that was killed
    // and whose lease has not expired yet. Returning normally there told the
    // BullMQ worker the job was COMPLETE, which ended the retry chain on a row
    // nothing would ever revisit — a killed run became a silently lost event,
    // strictly worse than the pre-lease code, which simply re-ran it.
    if (row?.status === 'processed') {
      webhookLogger.info({ eventId: event.id }, 'Duplicate webhook — already processed, skipping')
      return
    }
    webhookLogger.warn(
      { eventId: event.id, eventType: event.type, status: row?.status ?? null, leaseMs: WEBHOOK_LEASE_MS },
      'Webhook event is held by another runner — this delivery did nothing and the event is NOT finished; it must be retried',
    )
    throw new WebhookLeaseHeldError(event.id, row?.status)
  }

  try {
    await handleStripeEvent(event, deps)
    const stamped = await prisma.webhookLog.updateMany({
      where: { eventId: event.id, status: 'processing', processedAt: leaseAt },
      data: { status: 'processed', processedAt: new Date() },
    })
    if (stamped.count === 0) {
      // We finished the work, but the row is no longer ours (reclaimed after a
      // lease expiry, or downgraded). The work IS done, so this run succeeds;
      // the owner of the row decides its final state.
      webhookLogger.warn(
        { eventId: event.id },
        'Webhook handler finished but this run no longer held the lease — not stamping processed',
      )
    }
  } catch (err) {
    const errObj =
      err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
    webhookLogger.error(
      { eventId: event.id, eventType: event.type, err: errObj },
      'Webhook processing failed'
    )
    // Downgrade ONLY while we still hold the lease: a run that lost it must not
    // knock a live runner's row back to 'failed'.
    await prisma.webhookLog
      .updateMany({
        where: { eventId: event.id, status: 'processing', processedAt: leaseAt },
        data: { status: 'failed' },
      })
      .catch(() => undefined)
    throw err // surface to the worker so it retries
  }
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
 *
 * ── ITEM T3 — WHAT "RETURNING NORMALLY" COMMITS THIS FUNCTION TO ────────────
 * Returning without throwing is not a neutral act: processStripeEventJob then
 * stamps webhook_logs 'processed', the worker marks the job COMPLETED and
 * Stripe retires the event. So every non-throwing outcome must mean FINISHED,
 * never UNKNOWN. The full audit of checkout.session.completed:
 *
 *   fulfilment result            finished?  answer
 *   ───────────────────────────  ─────────  ─────────────────────────────────
 *   processed:true               YES        return  (the fan-out ran)
 *   already-fulfilled-or-        YES        return  (the ledger says 'complete',
 *     not-pending                             or there is no ledger and the
 *                                             booking is not payable — a state
 *                                             read from the database, not a
 *                                             failure to read it)
 *   migration-not-applied        no         throw   (P0-E)
 *   no-durable-handoff           no         throw   (B4/R4)
 *   fulfilment-resume-in-        no         throw   (R4)
 *     progress
 *   fulfilment-ledger-           no         throw   (T3 — the read failed or the
 *     unreadable                               payload is not a ledger)
 *   booking-not-found            no         throw   (T3 — money authorized, no
 *                                             row to fulfil against)
 *   ledger could not be written  no         THROWN BY fulfilment itself
 *
 * The other event types: `checkout.session.completed` with no metadata.bookingId
 * is not one of our sessions and there is nothing to do (finished); a
 * `charge.refunded` / dispute for a payment_intent this database has never seen
 * is logged and finished, because no retry can make a Payment row appear that
 * was never written. Anything that IS ours and fails, throws.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  deps: EventHandlerDeps = defaultEventHandlerDeps()
): Promise<void> {
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
      const fulfillment = await deps.fulfill({
        bookingId,
        paymentIntentId: (session.payment_intent as string) ?? null,
        amountTotalCents: session.amount_total,
        source: 'webhook',
      })
      // ── ITEM P0-E — do NOT record this event as processed when nothing was
      //    done. `MIGRATION_NOT_APPLIED` means the deposit is authorized but
      //    the booking could not be read (code deployed, SQL not yet run), so
      //    the booking is deliberately still PENDING_PAYMENT and NOTHING has
      //    been sent. Marking the webhookLog 'processed' here would be a false
      //    record AND would end the only retry that can still fulfill it.
      //    Throwing keeps the log honest ('failed') and hands the event back to
      //    the webhook-retry queue.
      if (!fulfillment.processed && fulfillment.reason === MIGRATION_NOT_APPLIED) {
        throw new Error(
          `Checkout fulfillment deferred for booking ${bookingId}: migrations not applied. The $49 is authorized, the booking is still PENDING_PAYMENT and no customer message was sent — apply the migration and replay this event.`,
        )
      }
      // ── ITEM B4 / R4 — the same contract, for the same reason ────────────
      //    NO_DURABLE_HANDOFF means the fan-out reached NOBODY: no customer
      //    email, no Discord approval card, not even the plain-text notice.
      //    Recording this event 'processed' would end the retry while the
      //    customer sits paid and un-contacted — the exact failure this module
      //    exists to prevent.
      //
      //    R4: fulfilment KEEPS its claim now and records which handoffs are
      //    still outstanding, so the retry this throw buys resumes ONLY those.
      //    (It used to release the claim, which made the retry re-run the whole
      //    fan-out and double-send every handoff that had actually succeeded.)
      if (!fulfillment.processed && fulfillment.reason === NO_DURABLE_HANDOFF) {
        throw new Error(
          `Checkout fulfillment delivered nothing for booking ${bookingId}: every notification handoff failed and the direct owner notice could not be delivered. The $49 is authorized and NO message was sent — this event must be retried so the outstanding handoffs are re-driven.`,
        )
      }
      // ── ITEM R4 — a SKIP is not a SUCCESS here either ────────────────────
      //    Another runner (the browser success redirect, a parallel delivery)
      //    holds the fan-out lease, so THIS delivery did nothing. Recording the
      //    event processed would retire the retry on the word of a run that
      //    performed no work and whose outcome we do not know — and the other
      //    runner may be the success redirect, whose failure nothing retries.
      if (!fulfillment.processed && fulfillment.reason === RESUME_IN_PROGRESS) {
        throw new Error(
          `Checkout fulfillment for booking ${bookingId} is being re-driven by another runner right now; this delivery did nothing. Retry it — by then the outstanding handoffs are either delivered or still recorded as outstanding.`,
        )
      }
      // ── ITEM T3 — AN UNKNOWN IS NOT A FINISH ─────────────────────────────
      //    The durable handoff ledger could not be read (a failed query) or
      //    could not be understood (a payload that is not a ledger), so
      //    fulfilment does not know what has already been sent and deliberately
      //    sent nothing. That used to arrive here as
      //    `already-fulfilled-or-not-pending` — a reason this switch does NOT
      //    throw on — so one failed SELECT recorded the webhook 'processed',
      //    retired the Stripe event, and left the customer's email and the
      //    owner's approval card permanently unsent.
      if (!fulfillment.processed && fulfillment.reason === LEDGER_UNREADABLE) {
        throw new Error(
          `Checkout fulfillment for booking ${bookingId} could not read its durable handoff ledger, so it does not know which notifications have already gone out and sent none. Nothing about this checkout is finished — retry this event.`,
        )
      }
      // ── ITEM T3 — a booking the fulfilment cannot find ───────────────────
      //    The $49 IS authorized (Stripe says so) and the row this event names
      //    is not readable, so NOTHING was done and nothing is known. Recording
      //    the event processed would retire the only delivery that could still
      //    fulfil it — a booking write that had not committed yet, or a replica
      //    that had not caught up, would become permanent silence for a paying
      //    customer. Stripe's retry schedule (and its delivery-failure alerting)
      //    is the only net under this case.
      if (!fulfillment.processed && fulfillment.reason === 'booking-not-found') {
        throw new Error(
          `Checkout fulfillment could not find booking ${bookingId} named by Stripe event ${event.id}. The deposit is authorized at Stripe and NOTHING was sent — retry this event, and if it keeps failing the booking row is missing and needs a human.`,
        )
      }
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

    // ── ITEM B6 / D1 — AN EXPIRED CHECKOUT RECORDS, AND NOTHING ELSE ───────
    //    This case was one `logger.info` line while the booking sat in
    //    PENDING_PAYMENT, which IS a truck-hold status (truck-conflicts.ts
    //    R2-2, deliberately) — so a customer who did not finish paying inside
    //    the 30-minute session window left a stale hold on that truck.
    //
    //    B6 answered that by CANCELLING the booking from here and from an
    //    hourly sweep. D1 removed that path: the sweep applied no mid-payment
    //    guard at all, so a booking whose customer was being redirected into a
    //    fresh session (the resume route EXPIRES the recorded session before
    //    minting its replacement) was cancelled while they paid — and CANCELLED
    //    is terminal, so nobody could undo it. Cancelling a paying customer's
    //    booking is a worse defect than a stale truck hold.
    //
    //    SO THIS HANDLER RECORDS AND NOTHING MORE. It writes nothing to the
    //    booking; the durable trace of the event is the `webhook_logs` row this
    //    module already keys on `eventId`. The stale hold is surfaced to the
    //    owner by the Action Center rule `checkout-hold-stale` and by
    //    `reportStaleCheckouts`, and only a human ends it (the audited
    //    POST /api/admin/bookings/[id]/release-hold). See the header of
    //    src/lib/checkout-expiry.ts for what automatic cancellation would need
    //    before it could ever be safe.
    //
    //    RETURNING NORMALLY IS STILL A CLAIM (see the T3 audit above): every
    //    outcome here is genuinely FINISHED — the event was classified and
    //    recorded. Only an infrastructure failure (the booking cannot be READ)
    //    throws, and that is what buys the Stripe retry.
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session
      const outcome = await handleCheckoutSessionExpired({
        bookingId: session.metadata?.bookingId ?? null,
        sessionId: session.id,
        sessionCreatedSec: session.created ?? null,
        sessionExpiresAtSec: session.expires_at ?? null,
        eventCreatedSec: event.created ?? null,
      })
      webhookLogger.info(
        { bookingId: session.metadata?.bookingId ?? null, sessionId: session.id, ...outcome },
        'Checkout session expired',
      )
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
