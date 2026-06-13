import { prisma } from './db'
import { emailQueue, smsQueue, discordQueue, marketingQueue } from './queues'
import { webhookLogger } from './logger'
import { t } from './i18n'
import { outboxEnabled, emitPaymentCompleted } from '../outbox/integration'

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
// BullMQ uses maxRetriesPerRequest:null, so when Upstash drops the idle
// connection, queue.add() HANGS FOREVER (it never rejects). On the webhook
// that means no 200 → Stripe retries → duplicates; on the success redirect it
// means the customer's browser hangs. Promise.race converts the hang into a
// logged, non-fatal skip. Never throws.
async function enqueue(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('queue add timed out after 5s (Redis unreachable?)')), 5000)
      ),
    ])
    webhookLogger.debug({ label }, 'fulfillment job enqueued')
  } catch (err) {
    webhookLogger.error(
      { label, err: err instanceof Error ? err.message : String(err) },
      'fulfillment enqueue failed/timed out (non-fatal — booking already moved to PENDING_APPROVAL)'
    )
  }
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
}): Promise<FulfillResult> {
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

  // ════════════════════════════════════════════════════════════════════════
  //  MESSAGING POLICY — at the PAYMENT step, fulfillPaidCheckout sends ONLY the
  //  FINAL CONFIRMATION email + SMS. The pre-approval pair is sent later, by the
  //  Discord approval handler. No other customer email/SMS is queued here.
  // ════════════════════════════════════════════════════════════════════════

  // 1) Payment-step EMAIL.
  //    OUTBOX_ENABLED → emit PAYMENT_COMPLETED to the outbox (which sends the
  //    email) and SKIP the legacy email here, so the customer never gets both.
  if (outboxEnabled()) {
    log.info({ to: booking.customer.email }, '[outbox] emitting PAYMENT_COMPLETED (legacy payment email skipped)')
    tasks.push(
      emitPaymentCompleted({
        bookingId,
        amountPaid,
        customerName: booking.customer.name,
        customerEmail: booking.customer.email,
        requestedDate: booking.requestedDate?.toISOString() ?? null,
      }).then(() => undefined)
    )
  } else {
    log.info({ to: booking.customer.email }, '[messaging] queueing FINAL CONFIRMATION email')
    tasks.push(
      enqueue('email:final-confirmation', () =>
        emailQueue.add('final-confirmation', {
          template: 'final-confirmation',
          to: booking.customer.email,
          bookingId,
          payload: {
            customerName: booking.customer.name,
            displayId: booking.displayId,
            date: booking.requestedDate?.toISOString(),
            amountPaid,
            items: booking.itemsDescription ?? undefined,
            portalUrl,
            locale,
          },
        })
      )
    )
  }

  // 2) FINAL CONFIRMATION SMS (1 of 2 allowed texts) — bilingual
  if (booking.customer.phone) {
    log.info('[messaging] queueing FINAL CONFIRMATION sms')
    tasks.push(
      enqueue('sms:final-confirmation', () =>
        smsQueue.add('final-confirmation-sms', {
          to: booking.customer.phone!,
          message: t(locale, 'finalConfirmation', {
            name: booking.customer.name,
            displayId: booking.displayId,
            date: dateStr,
          }),
          bookingId,
        })
      )
    )
  }

  // 3) Discord booking approval card (the Approve / Offer / Deny card)
  tasks.push(
    enqueue('discord:booking-created', () =>
      discordQueue.add('booking-created', {
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
          moveTotal: booking.totalEstimate,
          balanceAfterJob: booking.totalEstimate != null ? booking.totalEstimate - 49 : null,
          truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
          truckAddonAmount: booking.truckAddonAmount,
          // ── Moving Service Agreement status (shown on the card) ──
          agreementAccepted: booking.agreementAccepted,
          agreementVersion: booking.agreementVersion,
          agreementName: booking.agreementName,
          agreementAcceptedAt: booking.agreementAcceptedAt?.toISOString(),
        },
      })
    )
  )

  // 4) Marketing automation enrollment (external tool — env-gated stub)
  tasks.push(
    enqueue('marketing:enroll', () =>
      marketingQueue.add('booking-paid', {
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
    )
  )

  // 5) Create the Discord job-coordination card
  tasks.push(
    enqueue('discord:create-job-channels', () =>
      discordQueue.add('create-job-channels', {
        type: 'create-job-channels',
        bookingId,
        payload: {
          bookingId,
          displayId: booking.displayId,
          customerName: booking.customer.name,
        },
      })
    )
  )

  // 6) Door-hanger discount approval card (only if one is pending)
  if (booking.discountType === 'DOOR_HANGER_PENDING') {
    tasks.push(
      enqueue('discord:discount-request', () =>
        discordQueue.add('discount-request', {
          type: 'discount-request',
          bookingId,
          payload: {
            bookingId,
            displayId: booking.displayId,
            customerName: booking.customer.name,
            discountCode: booking.discountCode,
          },
        })
      )
    )
  }

  await Promise.all(tasks)

  log.info('Checkout fulfilled — booking → PENDING_APPROVAL, all jobs queued')
  return { processed: true, bookingId }
}
