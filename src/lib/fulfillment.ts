import type { Prisma } from '@prisma/client'
import { prisma } from './db'
import { onBookingPaid } from './journeys'
import { emailQueue, smsQueue, discordQueue, marketingQueue } from './queues'
import { webhookLogger } from './logger'
import { t } from './i18n'
import { ingestBookingToTracker } from './tracker'
import { outboxEnabled, emitPaymentCompleted } from '../outbox/integration'
import { smsMoveWhen } from './booking-display'
import { isMigrationMissing, MIGRATION_MISSING_MESSAGE, readBookingWithMigrationFallback } from './migration-window'

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

/** The booking row this module fans out from. */
type PaidBooking = Prisma.BookingGetPayload<{ include: { customer: true } }>

/** ITEM P0-E — the reason returned when the deposit was authorized but the
 *  MIGRATIONS ARE NOT APPLIED, so the row cannot be read. Nothing is claimed,
 *  nothing is consumed: the booking stays PENDING_PAYMENT and the next trigger
 *  (webhook retry / success redirect / a manual replay) does the WHOLE
 *  fulfillment once the SQL lands. Callers must NOT record the Stripe event as
 *  processed on this reason — see src/lib/stripe-events.ts. */
export const MIGRATION_NOT_APPLIED = 'migration-not-applied'

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

  // ── ITEM P0-E — READ FIRST, CLAIM SECOND ────────────────────────────────
  //
  // This read used to sit immediately AFTER the atomic claim, as an
  // `include: { customer: true }` with no guard. An `include` makes Prisma ask
  // Postgres for `$scalars` FROM THE GENERATED SCHEMA, so during the normal
  // code-before-SQL window (migrations here are applied by hand) it raised
  // P2022 — one statement after the claim had already flipped the booking to
  // PENDING_APPROVAL. Nothing downstream ran: no Discord approval card, no
  // pre-approval email, no SMS, no tracker ingest.
  //
  // And it was UNRECOVERABLE, because the claim IS the idempotency guard: the
  // retry re-entered, matched 0 rows, returned `processed:false` without
  // throwing, and the webhook was then recorded as processed. A customer who
  // paid $49 in that window would never have been contacted, and applying the
  // SQL later replayed nothing.
  //
  // So the row is read BEFORE anything is consumed. A migration-shaped failure
  // now leaves the booking PENDING_PAYMENT — the honest state, from which the
  // very next trigger fulfills completely. A real outage still throws, before
  // the claim, so the queue retries it.
  let booking: PaidBooking | null
  let degradedRead = false
  try {
    const read = await readBookingWithMigrationFallback<PaidBooking>(
      (args) => prisma.booking.findUnique({ where: { id: bookingId }, ...(args as object) }),
      { customer: true },
    )
    booking = read.row
    degradedRead = read.degraded
  } catch (err) {
    // A REAL failure (outage, timeout, a broken generated client) is NOT a
    // migration window: rethrow it, before the claim, so the webhook queue
    // retries the whole event. Downgrading an outage into "deferred" would
    // quietly stop the retry that is the actual recovery.
    if (!isMigrationMissing(err)) throw err
    // Both rungs failed the same migration-shaped way. NOTHING has been claimed.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      `fulfillment cannot read the booking — ${MIGRATION_MISSING_MESSAGE}. The $49 is authorized and the booking stays PENDING_PAYMENT; re-run this event after the migration.`,
    )
    return { processed: false, bookingId, reason: MIGRATION_NOT_APPLIED }
  }
  if (!booking) {
    log.error('Booking not found — cannot fulfill (nothing claimed)')
    return { processed: false, bookingId, reason: 'booking-not-found' }
  }
  if (degradedRead) {
    log.warn(
      { reason: MIGRATION_MISSING_MESSAGE },
      'fulfillment read degraded (unapplied migration) — fan-out continues without the newest columns',
    )
  }
  // The status to restore if the fan-out cannot run (below). Captured from the
  // row we just read, so a DRAFT booking is never "rolled back" into a state it
  // was never in.
  const statusBeforeClaim = booking.status

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

  // ── ITEM P0-E — the claim must never outlive the work it was taken for ───
  // Everything from here to the end runs inside this try. Each task is already
  // individually guarded and cannot reject, so reaching the catch means
  // essentially nothing was queued — in which case the claim is RELEASED, so
  // the next trigger redoes the whole fulfillment instead of short-circuiting
  // on "already fulfilled" forever, and the error is rethrown so the webhook
  // queue retries it.
  try {

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
  // ── ITEM R3-1: the confirmation SMS ─────────────────────────────────────
  // `timeStyle:'short'` on a booking whose hour nobody chose formatted the
  // 00:00 ET DAY ANCHOR and texted the customer "Jul 15, 2027, 12:00 AM".
  // moveWhenParts is the ONE booking-aware formatter — same medium date, and
  // the time only when a real one exists. A timed move reads exactly as before.
  const dateStr =
    smsMoveWhen(booking, locale === 'es' ? 'es-US' : 'en-US') ??
    (locale === 'es' ? 'tu fecha solicitada' : 'your requested date')

  // ── Fan out every side-effect concurrently (each individually guarded) ──
  // Concurrent (not sequential) bounds the worst case to ~5s even if Redis is
  // down, which keeps the browser success redirect snappy.
  const tasks: Promise<void>[] = []

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
      })
        .then(() => undefined)
        // Every OTHER task here is wrapped in `enqueue`, which never rejects.
        // This one was not: an outbox failure rejected Promise.all and threw
        // AFTER the claim was taken, which used to make the whole fulfillment a
        // permanent no-op. It is guarded like its siblings now.
        .catch((err) =>
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            '[outbox] PAYMENT_COMPLETED emit failed (non-fatal — booking already moved to PENDING_APPROVAL)',
          ),
        )
    )
  } else {
    log.info({ to: booking.customer.email }, '[messaging] queueing PRE-CONFIRMATION email')
    tasks.push(
      enqueue('email:pre-approval', () =>
        emailQueue.add('pre-approval', {
          template: 'pre-approval',
          to: booking.customer.email,
          bookingId,
          payload: {
            customerName: booking.customer.name,
            displayId: booking.displayId,
            requestedDate: booking.requestedDate?.toISOString(),
            // Item R3-1 — the legacy queue payload is the OTHER pre-approval
            // sender, and it passed no time information at all, so the template
            // derived "12:00 AM" from the day anchor. An arrival window the
            // owner typed still wins; otherwise the flag suppresses the hour.
            timeLabel: booking.arrivalWindow ?? undefined,
            startTimeKnown: booking.startTimeKnown,
            originAddress: booking.originAddress,
            destAddress: booking.destAddress,
            estimate: booking.totalEstimate != null ? `$${Math.round(booking.totalEstimate).toLocaleString('en-US')}` : undefined,
            amountHold: String(Math.round(Number(amountPaid))),
            portalUrl,
            serviceAreaZone: booking.serviceAreaZone ?? undefined,
            travelFee: booking.travelFee ? booking.travelFee / 100 : undefined,
            manualReviewRequired: booking.manualReviewRequired ?? undefined,
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

  // 3b) Marketing-tracker revenue merge (Phase 2). Attribute this paid booking
  //     to its source / found-us in the scans→leads→jobs funnel. Idempotent on
  //     external_ref and self-guarded (5s timeout) — a tracker outage is a no-op.
  //     Revenue recorded is the move ESTIMATE (expected job value), not the $49.
  tasks.push(
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
    })
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

  // 5) Create the Discord job-coordination card (worker dispatch view).
  //    The payload carries everything the MOVE DAY JOB card renders so the
  //    worker never needs raw DB access; price detail stays owner-side except
  //    the labor estimate + travel-fee status the crew is allowed to see.
  tasks.push(
    enqueue('discord:create-job-channels', () =>
      discordQueue.add('create-job-channels', {
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
          // Item R3-1 — the crew dispatch card renders this date; without the
          // flag it printed the day anchor's midnight as the job's start time.
          startTimeKnown: booking.startTimeKnown,
          truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
          laborEstimate: booking.baseRate,
          travelFeeDollars: booking.travelFee ? booking.travelFee / 100 : 0,
          manualReviewRequired: booking.manualReviewRequired,
        },
      })
    )
  )

  // 6) Door-hanger discount approval card — REMOVED 2026-07-21 (owner
  //    decision). The campaign approved 30%, over the 10% public cap, so no
  //    new approval card is ever created. Historical DiscountType enum values
  //    are retained in the schema so existing bookings still read correctly.

  await Promise.all(tasks)

  // ── STOP RULE: the customer converted ───────────────────────────────────
  // Cancel every pending abandoned-recovery stage. This is an optimisation, not
  // the guarantee — each stage also re-reads the booking status at send time
  // (scheduled.worker) and again in the email worker (stillWantedForBooking),
  // so a queue we fail to clean still cannot produce a wrong email.
  await onBookingPaid(bookingId).catch((err) =>
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'onBookingPaid cleanup failed (non-fatal)')
  )

  } catch (err) {
    await prisma.booking
      .updateMany({ where: { id: bookingId, status: 'PENDING_APPROVAL' }, data: { status: statusBeforeClaim } })
      .catch((rbErr) =>
        log.error(
          { err: rbErr instanceof Error ? rbErr.message : String(rbErr) },
          'CRITICAL: fulfillment failed AND the claim could not be released — this booking may never fan out',
        ),
      )
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'fulfillment failed after the claim — claim released so the next trigger can redo it',
    )
    throw err
  }

  log.info('Checkout fulfilled — booking → PENDING_APPROVAL, all jobs queued')
  return { processed: true, bookingId }
}
