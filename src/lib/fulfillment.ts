import { prisma } from './db'
import { onBookingPaid } from './journeys'
import { emailQueue, discordQueue, marketingQueue } from './queues'
import { webhookLogger } from './logger'
import { ingestBookingToTracker } from './tracker'
import { outboxEnabled, emitPaymentCompleted } from '../outbox/integration'
import { computeQuote } from './booking-quote'
import {
  PAYMENT_FANOUT_RETRY_WINDOW_MS,
  defaultRetryStore,
  enqueueDurable,
  type EnqueueStatus,
  type QueueLike,
  type RetryStore,
} from './lifecycle-enqueue'

// ════════════════════════════════════════════════════════════════════════
//  Checkout fulfillment — the single source of truth for "a $49 hold was
//  authorized; move the booking to PENDING_APPROVAL and fan out notifications".
//
//  WHY THIS EXISTS (the bug it fixes):
//  The whole downstream pipeline (Discord approval card, emails, SMS) used to
//  live INSIDE the Stripe webhook handler. If the webhook never arrived —
//  stale ngrok URL, a Dashboard endpoint pointed at the wrong host, `stripe
//  listen` not forwarding, a test/live mode mismatch — NOTHING happened even
//  though the customer paid. "Payment succeeds but nothing triggers."
//
//  Fix: pull fulfillment into this shared, IDEMPOTENT function and call it from
//  TWO independent triggers:
//    1. POST /api/stripe/webhook       (checkout.session.completed) — primary
//    2. GET  /api/stripe/checkout/success (browser redirect)        — backup
//  The browser ALWAYS hits the success URL after paying, so even with a broken
//  webhook the card still posts. Whichever fires first wins; the other no-ops.
// ════════════════════════════════════════════════════════════════════════

export type FulfillResult = {
  processed: boolean
  bookingId: string
  reason?: string
}

// Guard a single queue.add() so a Redis stall can't hang the caller.
// BullMQ uses maxRetriesPerRequest:null, so when the idle connection drops,
// queue.add() HANGS FOREVER (it never rejects). On the webhook that means no
// 200 → Stripe retries → duplicates; on the success redirect it means the
// customer's browser hangs. The race converts the hang into a bounded failure.
// Never throws.
//
// DURABLE (production reliability release 2026-09-15). A failed add used to be
// logged as "non-fatal" and then the function logged "all jobs queued" anyway:
// the Discord approval card, the job channels and the marketing enroll were
// simply gone, for a customer whose $49 was already held. Each job now carries
// a deterministic id and a failure is recorded in lifecycle_enqueue_retries; the
// hourly lifecycle-repair sweep re-adds that exact job (within 24h). The atomic
// status claim above guarantees this fan-out runs once per booking, so the
// deterministic id never collides with a legitimate second job.

/** The queues + retry store this fan-out writes to, injectable for tests. */
export type FulfillmentEdge = {
  email: QueueLike
  discord: QueueLike
  marketing: QueueLike
  store?: RetryStore
  now?: () => Date
}

export function defaultFulfillmentEdge(): FulfillmentEdge {
  return { email: emailQueue, discord: discordQueue, marketing: marketingQueue }
}

/** Deterministic, BullMQ-safe (no ':') id for one fan-out job. */
export function fanoutJobId(kind: string, bookingId: string): string {
  return `fulfill__${kind}__${bookingId}`
}

export async function enqueueFanout(
  label: string,
  job: { queue: QueueLike; queueName: string; name: string; data: Record<string, unknown>; kind: string },
  bookingId: string,
  edge: Pick<FulfillmentEdge, 'store' | 'now'> = {}
): Promise<EnqueueStatus> {
  const now = edge.now ? edge.now() : new Date()
  const { status } = await enqueueDurable(
    {
      queue: job.queue,
      // Each descriptor below names its own queue. A retry row that guessed
      // 'scheduled' here would be swept onto a worker with no handler for these
      // job names, which warns and COMPLETES them — the card silently lost.
      queueName: job.queueName,
      name: job.name,
      data: job.data,
      jobId: fanoutJobId(job.kind, bookingId),
      fireAt: now,
      notAfter: new Date(now.getTime() + PAYMENT_FANOUT_RETRY_WINDOW_MS),
      path: 'payment-fanout',
      subjectType: 'booking',
      subjectId: bookingId,
    },
    { store: edge.store ?? defaultRetryStore(), now: () => now }
  )
  if (status === 'scheduled') webhookLogger.debug({ label, bookingId }, 'fulfillment job enqueued')
  else if (status === 'recorded_for_retry') {
    webhookLogger.warn({ label, bookingId }, 'fulfillment enqueue failed — recorded for retry by lifecycle-repair')
  } else {
    webhookLogger.error({ label, bookingId, tag: 'LIFECYCLE_ENQUEUE_LOST' }, 'fulfillment enqueue failed and was NOT recorded — job LOST')
  }
  return status
}

/** PURE: the one truthful summary line for a fan-out. */
export function fanoutSummary(statuses: EnqueueStatus[]): { level: 'info' | 'warn' | 'error'; message: string; counts: Record<EnqueueStatus, number> } {
  const counts: Record<EnqueueStatus, number> = { scheduled: 0, recorded_for_retry: 0, lost: 0 }
  for (const st of statuses) counts[st]++
  if (counts.lost > 0) {
    return { level: 'error', counts, message: `Checkout fulfilled — booking → PENDING_APPROVAL, but ${counts.lost} job(s) LOST (LIFECYCLE_ENQUEUE_LOST)` }
  }
  if (counts.recorded_for_retry > 0) {
    return { level: 'warn', counts, message: `Checkout fulfilled — booking → PENDING_APPROVAL, ${counts.recorded_for_retry} job(s) recorded for retry` }
  }
  return { level: 'info', counts, message: 'Checkout fulfilled — booking → PENDING_APPROVAL, all jobs queued' }
}

/**
 * Move a paid (authorized) booking to PENDING_APPROVAL and queue every
 * side-effect. Safe to call multiple times and from multiple processes — the
 * atomic status claim below guarantees the work runs exactly once.
 */
export async function fulfillPaidCheckout(params: {
  bookingId: string
  paymentIntentId: string | null
  amountTotalCents: number | null
  source: 'webhook' | 'success_redirect'
}, edge: FulfillmentEdge = defaultFulfillmentEdge()): Promise<FulfillResult> {
  const { bookingId, paymentIntentId, amountTotalCents, source } = params
  const log = webhookLogger.child({ bookingId, source })

  // ── Atomic claim — the race-condition fix ───────────────────────────────
  // updateMany with a status guard compiles to ONE conditional SQL UPDATE.
  // Whoever flips PENDING_PAYMENT/DRAFT → PENDING_APPROVAL first gets count:1
  // and proceeds; a concurrent caller (the other trigger, or a Stripe retry)
  // gets count:0 and bails. No double cards, no double emails — without a lock.
  const claim = await prisma.booking.updateMany({
    where: { id: bookingId, status: { in: ['PENDING_PAYMENT', 'DRAFT'] } },
    data: {
      status: 'PENDING_APPROVAL',
      depositPaid: false, // AUTHORIZE-ONLY: the $49 is held, not captured yet
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
  })

  if (claim.count === 0) {
    log.info('Checkout already fulfilled (or booking not in a payable state) — skipping')
    return { processed: false, bookingId, reason: 'already-fulfilled-or-not-pending' }
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true },
  })
  if (!booking) {
    log.error('Booking disappeared immediately after claim — cannot fulfill')
    return { processed: false, bookingId, reason: 'booking-not-found' }
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'PAYMENT_RECEIVED',
        bookingId,
        details: { authorized: true, amount: amountTotalCents, paymentIntentId, source },
      },
    })
    .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, 'audit log write failed (non-fatal)'))

  const amountPaid = ((amountTotalCents ?? 4900) / 100).toFixed(2)

  // ── THE final total, once, for every message this function fans out ─────
  //    The customer email used to send raw `totalEstimate` as "your estimate",
  //    and the Discord payload sent `totalEstimate` and `totalEstimate − 49`.
  //    On a discounted booking all three were wrong in the same direction:
  //    WMIC-1019 was told $550 by email and $501 by Discord on a $495 job.
  //    At this point the $49 is AUTHORIZED, not captured, so nothing is
  //    collected yet — which is exactly what the customer should be told.
  const quote = computeQuote({
    totalEstimate: booking.totalEstimate,
    baseRate: booking.baseRate,
    travelFeeCents: booking.travelFee,
    additionalCents: booking.truckAddonDueOnMoveDay ? booking.truckAddonAmount ?? 0 : 0,
    discountPercent: booking.discountPercent,
    depositCents: booking.depositAmount,
    collectedCents: 0,
    authorizedNotCapturedCents: amountTotalCents ?? booking.depositAmount ?? 4900,
  })

  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
  const portalUrl = `${appUrl}/my-booking/${booking.customerToken}`
  const locale = booking.customer.locale
  const dateStr = booking.requestedDate
    ? booking.requestedDate.toLocaleString(locale === 'es' ? 'es-US' : 'en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : locale === 'es'
    ? 'tu fecha solicitada'
    : 'your requested date'

  // ── Fan out every side-effect concurrently (each individually guarded) ──
  // Concurrent (not sequential) bounds the worst case to ~5s even if Redis is
  // down, which keeps the browser success redirect snappy.
  const tasks: Promise<void>[] = []
  // Only the queue fan-out reports a status; the outbox and tracker are
  // durable/self-guarded on their own.
  const fanout: Promise<EnqueueStatus>[] = []

  // ════════════════════════════════════════════════════════════════════════
  //  MESSAGING POLICY — the PAYMENT step (booking → PENDING_APPROVAL, $49 held
  //  but NOT captured) sends the PRE-CONFIRMATION email + a payment-step SMS.
  //  The FINAL CONFIRMATION ("you're approved") is sent later by the Discord
  //  approval handler once the owner approves and the $49 is captured. Sending
  //  the pre-confirmation here (not the confirmation) keeps every message honest
  //  about the true booking state.
  // ════════════════════════════════════════════════════════════════════════

  // 1) Payment-step EMAIL = the premium PRE-CONFIRMATION ("we've received your
  //    booking request"). OUTBOX_ENABLED → emit PAYMENT_COMPLETED to the outbox
  //    (which renders + sends that template) and SKIP the legacy queue here so
  //    the customer never gets both.
  if (outboxEnabled()) {
    log.info({ to: booking.customer.email }, '[outbox] emitting PAYMENT_COMPLETED (legacy payment email skipped)')
    tasks.push(
      emitPaymentCompleted({
        bookingId,
        amountPaid,
        customerName: booking.customer.name,
        customerEmail: booking.customer.email,
        requestedDate: booking.requestedDate?.toISOString() ?? null,
        items: booking.itemsDescription ?? undefined,
      }).then(() => undefined)
    )
  } else {
    log.info({ to: booking.customer.email }, '[messaging] queueing PRE-CONFIRMATION email')
    fanout.push(
      enqueueFanout('email:pre-approval', {
        queue: edge.email,
        queueName: 'email',
        name: 'pre-approval',
        kind: 'pre-approval',
        data: {
          template: 'pre-approval',
          to: booking.customer.email,
          bookingId,
          payload: {
            customerName: booking.customer.name,
            displayId: booking.displayId,
            requestedDate: booking.requestedDate?.toISOString(),
            originAddress: booking.originAddress,
            destAddress: booking.destAddress,
            // The FINAL total — discount applied. Was `totalEstimate`, which
            // quoted the customer a price we were not going to charge them.
            estimate: quote.finalTotalCents > 0
              ? `$${quote.finalTotalDollars.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(quote.finalTotalDollars) ? 0 : 2, maximumFractionDigits: 2 })}`
              : undefined,
            amountHold: String(Math.round(Number(amountPaid))),
            portalUrl,
            serviceAreaZone: booking.serviceAreaZone ?? undefined,
            travelFee: booking.travelFee ? booking.travelFee / 100 : undefined,
            manualReviewRequired: booking.manualReviewRequired ?? undefined,
            locale,
          },
        },
      }, bookingId, edge)
    )
  }

  // 2) No customer SMS: Move It Clear It no longer texts customers (owner,
  //    2026-09-15). The confirmation email above is the customer's receipt.

  // 3) Discord booking approval card (the Approve / Offer / Deny card)
  fanout.push(
    enqueueFanout('discord:booking-created', {
      queue: edge.discord,
      queueName: 'discord',
      name: 'booking-created',
      kind: 'booking-created',
      data: {
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
          amountPaid,
          // ── Payment / balance breakdown (shown on the card) ──
          //    Only a FALLBACK: discord-rest reloads the booking and rebuilds
          //    the card from it. These are the canonical figures so the
          //    degraded path cannot print a different total from the live one.
          moveTotal: quote.finalTotalDollars,
          balanceAfterJob: quote.remainingAfterDepositDollars,
          truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
          truckAddonAmount: booking.truckAddonAmount,
          // ── Moving Service Agreement status (shown on the card) ──
          agreementAccepted: booking.agreementAccepted,
          agreementVersion: booking.agreementVersion,
          agreementName: booking.agreementName,
          agreementAcceptedAt: booking.agreementAcceptedAt?.toISOString(),
        },
      },
    }, bookingId, edge)
  )

  // 3b) Marketing-tracker revenue merge (Phase 2). Attribute this paid booking
  //     to its source / found-us in the scans→leads→jobs funnel. Idempotent on
  //     external_ref and self-guarded (5s timeout) — a tracker outage is a no-op.
  //     Revenue recorded is the move ESTIMATE (expected job value), not the $49.
  //
  //     INTERNAL TEST BOOKINGS NEVER LEAVE THIS SYSTEM (2026-09-16). An owner
  //     rehearsal is not revenue, and the tracker copy is an email store the
  //     API's suppression and test-identity rules do not reach.
  if (!booking.isInternalTest) tasks.push(
    ingestBookingToTracker({
      bookingId,
      source: booking.source,
      foundUs: booking.foundUs,
      name: booking.customer.name,
      phone: booking.customer.phone,
      email: booking.customer.email,
      revenueCents:
        booking.totalEstimate != null ? Math.round(booking.totalEstimate * 100) : amountTotalCents ?? 4900,
      status: 'scheduled',
      scheduledDate: booking.requestedDate ? booking.requestedDate.toISOString().slice(0, 10) : null,
      notes: `Booking ${booking.displayId} — deposit paid`,
      // ── WHAT MAKES THIS REVENUE ATTRIBUTABLE (2026-08-24) ───────────────
      //  Without attributionId the tracker has no way to join this money to
      //  the scan that produced it, so it writes the conversion as
      //  'unattributed' — correctly, because it refuses to guess. That is why
      //  the owner's revenue card has always said "Attributed scan: no".
      //
      //  originCity/State/Zip are the CUSTOMER-REPORTED pickup location. The
      //  tracker groups campaign performance by this, never by the
      //  IP-estimated scan city, which is a network guess and regularly a town
      //  off. Both already exist on Booking; neither needed a migration.
      attributionId: booking.attributionId,
      originCity: booking.originCity,
      originState: booking.originState,
      originZip: booking.originZip,
    })
  )

  // 4) Marketing automation enrollment (external tool — env-gated stub).
  //    Never for an internal test booking (2026-09-16): a rehearsal must not
  //    put the owner's address on an external marketing list. The consent,
  //    suppression and test-identity gate itself runs in enrollCustomer, at
  //    job time, because consent can change between payment and the job.
  if (!booking.isInternalTest) fanout.push(
    enqueueFanout('marketing:enroll', {
      queue: edge.marketing,
      queueName: 'marketing',
      name: 'booking-paid',
      kind: 'marketing-enroll',
      data: {
        type: 'enroll-customer',
        bookingId,
        payload: {
          email: booking.customer.email,
          name: booking.customer.name,
          phone: booking.customer.phone,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
        },
      },
    }, bookingId, edge)
  )

  // 5) Create the Discord job-coordination card (worker dispatch view).
  //    The payload carries everything the MOVE DAY JOB card renders so the
  //    worker never needs raw DB access; price detail stays owner-side except
  //    the labor estimate + travel-fee status the crew is allowed to see.
  fanout.push(
    enqueueFanout('discord:create-job-channels', {
      queue: edge.discord,
      queueName: 'discord',
      name: 'create-job-channels',
      kind: 'create-job-channels',
      data: {
        type: 'create-job-channels',
        bookingId,
        payload: {
          bookingId,
          displayId: booking.displayId,
          customerName: booking.customer.name,
          customerPhone: booking.customer.phone,
          originAddress: booking.originAddress,
          destAddress: booking.destAddress,
          requestedDate: booking.requestedDate?.toISOString(),
          items: booking.itemsDescription ?? undefined,
          truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
          laborEstimate: booking.baseRate,
          travelFeeDollars: booking.travelFee ? booking.travelFee / 100 : 0,
          manualReviewRequired: booking.manualReviewRequired,
        },
      },
    }, bookingId, edge)
  )

  // 6) Door-hanger discount approval card — REMOVED 2026-07-21 (owner
  //    decision). The campaign approved 30%, over the 10% public cap, so no
  //    new approval card is ever created. Historical DiscountType enum values
  //    are retained in the schema so existing bookings still read correctly.

  const [statuses] = await Promise.all([Promise.all(fanout), Promise.all(tasks)])

  // ── STOP RULE: the customer converted ───────────────────────────────────
  // Cancel every pending abandoned-recovery stage. This is an optimisation, not
  // the guarantee — each stage also re-reads the booking status at send time
  // (scheduled.worker) and again in the email worker (stillWantedForBooking),
  // so a queue we fail to clean still cannot produce a wrong email.
  await onBookingPaid(bookingId).catch((err) =>
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'onBookingPaid cleanup failed (non-fatal)')
  )

  // "all jobs queued" is said ONLY when every queue add succeeded (2026-09-15).
  const summary = fanoutSummary(statuses)
  log[summary.level]({ jobs: summary.counts }, summary.message)
  return { processed: true, bookingId }
}
