// ════════════════════════════════════════════════════════════════════════
//  booking-approval.ts — THE ONE booking-approval + Stripe-capture path.
//
//  Both approval surfaces call approveBooking():
//     • Discord card "Approve"  (app/api/discord/interactions/route.ts)
//     • Admin portal "Confirm"   (app/api/admin/bookings/[id]/status/route.ts)
//
//  Before this existed, the admin "Confirm" only flipped the status — it never
//  captured the $49 authorization, so an admin-confirmed booking could look
//  confirmed while the hold silently expired (~7 days) and the money was lost.
//  The Discord path already did this correctly; this module hoists that proven
//  logic out so there is exactly ONE implementation and the admin path is fixed.
//
//  SAFETY MODEL (unchanged from the proven Discord flow, verified in repo):
//    1. Guard the transition (status + a payment intent must exist).
//    2. ATOMIC CLAIM: UPDATE ... WHERE status='PENDING_APPROVAL'. Postgres
//       serializes this, so of N simultaneous approvals exactly ONE wins the
//       claim and proceeds to capture — the others short-circuit. No SELECT is
//       trusted before the claim.
//    3. Capture the hold with a Stripe idempotency key `capture:<pi>` so even a
//       pathological double-run collapses to a single charge at Stripe.
//    4. On capture failure, roll the claim back to PENDING_APPROVAL (guarded on
//       status='CONFIRMED') so the booking can be approved again once healthy.
//    5. Record the money in a $transaction. Payment is UPSERTED on the unique
//       stripePaymentIntentId, so a retried commit after a partial failure can
//       never create a duplicate Payment (the "capture-succeeded / DB-failed"
//       recovery the architecture review flagged).
//    6. Notify the customer ONLY after capture + DB are truthful. Notification
//       failure is non-fatal and NEVER rolls back a successful capture.
//
//  No long-running DB transaction is held across the Stripe network call — the
//  claim, the capture, and the commit are three separate, short steps.
//
//  Dependency-injected (ApprovalDeps) so the orchestration is unit-tested
//  offline with in-memory fakes (src/lib/__tests__/booking-approval.test.ts);
//  defaultApprovalDeps() wires the real prisma / Stripe / queues in production.
// ════════════════════════════════════════════════════════════════════════
import type { BookingStatus } from '@prisma/client'
import { prisma } from './db'
import { captureDeposit, retrieveChargeForIntent } from './stripe'
import { emailQueue, smsQueue } from './queues'
import { confirmationScheduleData, formatEastern } from './scheduling'
import { t } from './i18n'
import { outboxEnabled, emitApproved } from '../outbox/integration'
import { can, type Role } from './permissions'
import { apiLogger } from './logger'

// ── Public types ────────────────────────────────────────────────────────────

export type ApprovalSource = 'discord' | 'admin'

export type ApprovalActor = {
  /** Human-readable approver name for the audit trail + receipt metadata. */
  name: string
  /** Real User.id — set on the admin path; null/undefined for Discord. */
  userId?: string | null
  /** Discord user id — set on the Discord path; goes into audit details only. */
  discordUserId?: string | null
  /** When set, the actor's role is permission-checked (`booking.approve`). The
   *  Discord path is already gated to owners by discord-auth, so it passes
   *  role: 'OWNER'. Omitting role skips the check (caller vouches for authz). */
  role?: Role | null
}

export type ApprovalErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_status'
  | 'no_payment_intent'
  | 'capture_failed'
  | 'raced'

export type ApprovalResult =
  | {
      ok: true
      /** 'captured' = we performed the capture now. 'already_confirmed' = the
       *  booking was already CONFIRMED (idempotent replay), no capture done. */
      outcome: 'captured' | 'already_confirmed'
      booking: ApprovableBooking
      capturedCents: number | null
      receiptUrl: string | null
    }
  | { ok: false; code: ApprovalErrorCode; message: string; booking?: ApprovableBooking | null }

export type ApproveInput = {
  bookingId?: string
  /** Discord loads the booking by the clicked card's message id. */
  discordMessageId?: string
  actor: ApprovalActor
  source: ApprovalSource
  /** Send the customer confirmation email/SMS after capture (default true). */
  notify?: boolean
  /** Cap on how long we wait for notification enqueue (Discord's 3s window). */
  notifyTimeoutMs?: number
}

/** The subset of Booking (+ customer) the approval flow reads. Prisma returns a
 *  superset; this documents exactly what is used. */
export type ApprovableBooking = {
  id: string
  status: BookingStatus
  stripePaymentIntentId: string | null
  depositAmount: number
  displayId: string
  customerToken: string
  itemsDescription: string | null
  arrivalWindow: string | null
  totalEstimate: number | null
  originAddress: string | null
  destAddress: string | null
  serviceAreaZone: string | null
  travelFee: number | null
  manualReviewRequired: boolean | null
  requestedDate: Date | null
  confirmedDate: Date | null
  scheduledStart: Date | null
  scheduledEnd: Date | null
  estimatedHours: number | null
  customer: { name: string; email: string; phone: string | null; locale: string }
}

// ── Injectable dependencies (real impls in defaultApprovalDeps) ───────────────

export type CapturedIntent = {
  id: string
  amount_received?: number | null
  amount?: number | null
  latest_charge?: string | { id?: string | null } | null
  customer?: string | { id?: string | null } | null
  metadata?: Record<string, string> | null
}

export type ChargeInfo = {
  id?: string | null
  receipt_url?: string | null
  payment_method_details?: { type?: string | null } | null
}

export type CommitArgs = {
  bookingId: string
  paymentIntentId: string
  capturedCents: number
  stripeChargeId: string | null
  receiptUrl: string | null
  paymentMeta: Record<string, string>
  isInternalTest: boolean
  auditUserId: string | null
  auditDetails: Record<string, unknown>
}

export interface ApprovalStore {
  loadBooking(sel: { bookingId?: string; discordMessageId?: string }): Promise<ApprovableBooking | null>
  /** Atomic conditional UPDATE; returns rows changed (1 = won the claim). */
  claimConfirm(
    bookingId: string,
    sched: { confirmedDate: Date; scheduledStart: Date; scheduledEnd: Date } | null,
  ): Promise<number>
  rollbackClaim(bookingId: string): Promise<void>
  reloadStatus(bookingId: string): Promise<ApprovableBooking | null>
  /** Payment upsert + Job upsert + AuditLog in ONE transaction. */
  commitApproval(args: CommitArgs): Promise<void>
}

export interface ApprovalStripeGateway {
  capture(paymentIntentId: string, idempotencyKey: string): Promise<CapturedIntent>
  retrieveCharge(intent: CapturedIntent): Promise<ChargeInfo | null>
}

export interface ApprovalNotifier {
  sendApproved(booking: ApprovableBooking, capturedCents: number, approvedBy: string): Promise<void>
}

export interface ApprovalLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export type ApprovalDeps = {
  store: ApprovalStore
  stripe: ApprovalStripeGateway
  notifier: ApprovalNotifier
  logger: ApprovalLogger
}

// ── Pure guard (unit-tested directly) ─────────────────────────────────────────

/** Whether a booking in `status` with/without a payment intent may be approved.
 *  CONFIRMED is handled by the caller as an idempotent replay, so it is not a
 *  failure here. Pure — no I/O. */
export function checkApprovable(
  status: BookingStatus | string,
  hasPaymentIntent: boolean,
): { ok: true } | { ok: false; code: ApprovalErrorCode; message: string } {
  if (status !== 'PENDING_APPROVAL') {
    return { ok: false, code: 'invalid_status', message: `Can't approve a booking in ${status}.` }
  }
  if (!hasPaymentIntent) {
    return { ok: false, code: 'no_payment_intent', message: 'No payment hold attached — nothing to capture.' }
  }
  return { ok: true }
}

const errResult = (
  code: ApprovalErrorCode,
  message: string,
  booking?: ApprovableBooking | null,
): ApprovalResult => ({ ok: false, code, message, booking })

const asMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── The one approval operation ────────────────────────────────────────────────

export async function approveBooking(
  input: ApproveInput,
  deps: ApprovalDeps = defaultApprovalDeps(),
): Promise<ApprovalResult> {
  const { store, stripe, notifier, logger } = deps
  const { actor, source } = input

  const booking = await store.loadBooking({ bookingId: input.bookingId, discordMessageId: input.discordMessageId })
  if (!booking) return errResult('not_found', 'Booking not found.')

  // Authorization (admin path supplies a role; Discord is pre-gated to owners).
  if (actor.role && !can(actor.role, 'booking.approve')) {
    return errResult('forbidden', 'You do not have permission to approve bookings.', booking)
  }

  // Idempotent replay: already approved → report success without re-capturing.
  if (booking.status === 'CONFIRMED') {
    return { ok: true, outcome: 'already_confirmed', booking, capturedCents: null, receiptUrl: null }
  }

  const guard = checkApprovable(booking.status, !!booking.stripePaymentIntentId)
  if (!guard.ok) return errResult(guard.code, guard.message, booking)

  // 1) ATOMIC CLAIM — win the PENDING_APPROVAL → CONFIRMED transition before
  //    touching Stripe. Exactly one concurrent approver gets rows-changed === 1.
  const sched = confirmationScheduleData(booking)
  const claimed = await store.claimConfirm(booking.id, sched)
  if (claimed === 0) {
    const fresh = await store.reloadStatus(booking.id)
    if (fresh?.status === 'CONFIRMED') {
      return { ok: true, outcome: 'already_confirmed', booking: fresh, capturedCents: null, receiptUrl: null }
    }
    return errResult('raced', 'This booking was just handled by someone else — no action taken.', fresh ?? booking)
  }

  // 2) CAPTURE — idempotency key keyed on the payment intent.
  const pi = booking.stripePaymentIntentId as string // guaranteed by checkApprovable
  let intent: CapturedIntent
  try {
    intent = await stripe.capture(pi, `capture:${pi}`)
  } catch (e) {
    const message = asMessage(e)
    // Roll the claim back so a healthy retry can approve again. Guarded on
    // status='CONFIRMED' so we never stomp a later legitimate change.
    await store.rollbackClaim(booking.id).catch((rbErr) =>
      logger.error(
        { bookingId: booking.id, err: asMessage(rbErr) },
        'CRITICAL: failed to roll back approval claim after Stripe error — booking may be CONFIRMED without capture',
      ),
    )
    logger.error({ bookingId: booking.id, source, err: message }, 'captureDeposit failed — rolled back approval claim')
    return errResult('capture_failed', `Stripe capture failed: ${message}. The hold was NOT captured — try again.`, booking)
  }

  const capturedCents = intent.amount_received ?? intent.amount ?? booking.depositAmount

  // 2b) Best-effort charge details (receipt URL / charge id / method). Never
  //     blocks approval — the money is already captured.
  const charge = await stripe.retrieveCharge(intent).catch(() => null)
  const receiptUrl = charge?.receipt_url ?? null
  const stripeChargeId =
    charge?.id ?? (typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id) ?? null
  const paymentMethodType = charge?.payment_method_details?.type ?? null
  const stripeCustomerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id ?? null

  const paymentMeta: Record<string, string> = { capturedBy: actor.name, approvalSource: source }
  if (paymentMethodType) paymentMeta.paymentMethodType = paymentMethodType
  if (stripeCustomerId) paymentMeta.stripeCustomerId = stripeCustomerId
  // Mirror the intent's metadata (esp. internal_test) so revenue reporting
  // classifies owner checkout tests without a manual backfill.
  for (const [k, v] of Object.entries(intent.metadata ?? {})) {
    if (typeof v === 'string' && paymentMeta[k] == null) paymentMeta[k] = v
  }
  const isInternalTest = (intent.metadata?.internal_test ?? '') === 'true'

  // 3) RECORD MONEY — Payment (idempotent upsert) + Job + AuditLog, atomically.
  await store.commitApproval({
    bookingId: booking.id,
    paymentIntentId: intent.id,
    capturedCents,
    stripeChargeId,
    receiptUrl,
    paymentMeta,
    isInternalTest,
    auditUserId: actor.userId ?? null,
    auditDetails: {
      event: 'approve_booking',
      source,
      approvedBy: actor.name,
      discordUserId: actor.discordUserId ?? null,
      userId: actor.userId ?? null,
      previousStatus: 'PENDING_APPROVAL',
      newStatus: 'CONFIRMED',
      captured: capturedCents,
      paymentIntentId: intent.id,
      stripeResult: 'captured',
      result: 'success',
    },
  })

  logger.info(
    { bookingId: booking.id, captured: capturedCents, source, approvedBy: actor.name },
    'Booking approved → $49 captured → CONFIRMED',
  )

  // 4) NOTIFY — only now, after the state is truthful. Non-fatal + time-boxed
  //    so a Redis stall can't blow Discord's 3s interaction window or undo the
  //    capture. A failed notification leaves the money + booking intact.
  if (input.notify !== false) {
    try {
      await withTimeout(notifier.sendApproved(booking, capturedCents, actor.name), input.notifyTimeoutMs ?? 2500)
    } catch (e) {
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'approval notifications failed/timeout (non-fatal)')
    }
  }

  return { ok: true, outcome: 'captured', booking, capturedCents, receiptUrl }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ])
}

// ── Production wiring (never imported by the offline unit test) ────────────────

let _cachedDeps: ApprovalDeps | undefined

/** Real prisma / Stripe / BullMQ dependencies. Cached after first build. The
 *  imported queue/Stripe/prisma singletons are all lazy, so constructing this
 *  opens no connections — the offline test never calls it (it injects fakes). */
export function defaultApprovalDeps(): ApprovalDeps {
  if (_cachedDeps) return _cachedDeps
  _cachedDeps = {
    store: prismaApprovalStore(),
    stripe: {
      capture: (pi, key) => captureDeposit(pi, key) as unknown as Promise<CapturedIntent>,
      retrieveCharge: (intent) => retrieveChargeForIntent(intent as never) as unknown as Promise<ChargeInfo | null>,
    },
    notifier: queueApprovalNotifier(),
    logger: apiLogger,
  }
  return _cachedDeps
}

function prismaApprovalStore(): ApprovalStore {
  return {
    async loadBooking(sel) {
      const or: Array<Record<string, string>> = []
      if (sel.discordMessageId) or.push({ discordApprovalMessageId: sel.discordMessageId })
      if (sel.bookingId) or.push({ id: sel.bookingId })
      if (or.length === 0) return null
      const b = await prisma.booking.findFirst({ where: { OR: or }, include: { customer: true } })
      return b as unknown as ApprovableBooking | null
    },
    async claimConfirm(bookingId, sched) {
      const res = await prisma.booking.updateMany({
        where: { id: bookingId, status: 'PENDING_APPROVAL' },
        data: { status: 'CONFIRMED', depositPaid: true, ...(sched ?? {}) },
      })
      return res.count
    },
    async rollbackClaim(bookingId) {
      await prisma.booking.updateMany({
        where: { id: bookingId, status: 'CONFIRMED' },
        data: { status: 'PENDING_APPROVAL', depositPaid: false, confirmedDate: null, scheduledStart: null, scheduledEnd: null },
      })
    },
    async reloadStatus(bookingId) {
      const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { customer: true } })
      return b as unknown as ApprovableBooking | null
    },
    async commitApproval(a) {
      await prisma.$transaction([
        prisma.payment.upsert({
          where: { stripePaymentIntentId: a.paymentIntentId },
          update: {
            status: 'COMPLETED',
            stripeChargeId: a.stripeChargeId,
            amount: a.capturedCents,
            receiptUrl: a.receiptUrl,
            metadata: a.paymentMeta,
            isInternalTest: a.isInternalTest,
          },
          create: {
            bookingId: a.bookingId,
            stripePaymentIntentId: a.paymentIntentId,
            stripeChargeId: a.stripeChargeId,
            amount: a.capturedCents,
            status: 'COMPLETED',
            description: 'Booking deposit captured on approval',
            receiptUrl: a.receiptUrl,
            metadata: a.paymentMeta,
            isInternalTest: a.isInternalTest,
          },
        }),
        prisma.job.upsert({
          where: { bookingId: a.bookingId },
          update: { status: 'SCHEDULED' },
          create: { bookingId: a.bookingId, status: 'SCHEDULED' },
        }),
        prisma.auditLog.create({
          data: { action: 'PAYMENT_RECEIVED', bookingId: a.bookingId, userId: a.auditUserId, details: a.auditDetails as never },
        }),
      ])
    },
  }
}

function queueApprovalNotifier(): ApprovalNotifier {
  return {
    async sendApproved(booking, capturedCents, approvedBy) {
      const locale = booking.customer.locale
      const when = booking.requestedDate
      const dateStr = when ? formatEastern(when) : 'your move date'
      const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
      const portalUrl = `${appUrl}/my-booking/${booking.customerToken}`

      // OUTBOX_ENABLED → emit APPROVED to the outbox (which sends the email) and
      // SKIP the legacy email so the customer never gets both.
      if (outboxEnabled()) {
        await emitApproved({
          bookingId: booking.id,
          approvedBy,
          customerName: booking.customer.name,
          customerEmail: booking.customer.email,
          requestedDate: when?.toISOString() ?? null,
          items: booking.itemsDescription ?? undefined,
        })
      } else {
        await emailQueue.add('final-confirmation', {
          template: 'final-confirmation',
          to: booking.customer.email,
          bookingId: booking.id,
          payload: {
            customerName: booking.customer.name,
            displayId: booking.displayId,
            date: when?.toISOString(),
            timeLabel: booking.arrivalWindow ?? undefined,
            amountPaid: String(Math.round(capturedCents / 100)),
            originAddress: booking.originAddress ?? undefined,
            destAddress: booking.destAddress ?? undefined,
            estimate: booking.totalEstimate != null ? `$${Math.round(booking.totalEstimate).toLocaleString('en-US')}` : undefined,
            portalUrl,
            serviceAreaZone: booking.serviceAreaZone ?? undefined,
            travelFee: booking.travelFee ? booking.travelFee / 100 : undefined,
            manualReviewRequired: booking.manualReviewRequired ?? undefined,
            locale,
          },
        })
      }

      if (booking.customer.phone) {
        await smsQueue.add('pre-approval-sms', {
          to: booking.customer.phone,
          message: t(locale, 'preApproval', { name: booking.customer.name, displayId: booking.displayId, date: dateStr }),
          bookingId: booking.id,
        })
      }
    },
  }
}
