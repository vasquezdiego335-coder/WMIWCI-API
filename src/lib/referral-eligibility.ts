// ════════════════════════════════════════════════════════════════════════
//  REFERRAL ELIGIBILITY — owner spec 2026-07-20.
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES (gap audit 2026-07-17, severity HIGH):
//  the referral email had NO eligibility gate. `src/lib/followups.ts` fired it
//  on a day-5 timer after completion, or 24h after any review with rating >= 4,
//  and the handler rendered `ReferralEmail` with no check on payment, on booking
//  status, or on whether a receipt had ever been sent. A cancelled, refunded,
//  unpaid, or internal-test booking could ask a customer to refer their friends.
//
//  THE RULE (all must hold, checked TWICE — at schedule and again at send):
//    1. booking exists and is COMPLETED
//    2. booking is not an internal test
//    3. a Stripe payment exists (when STRIPE is the required provider)
//    4. that payment is COMPLETED — not pending, failed, refunded, or disputed
//    5. a DURABLE receipt event exists: AuditLog(action = RECEIPT_SENT)
//    6. that receipt event is NOT in the future (clock-skew / seeded-data guard)
//    7. the referral program is enabled
//    8. the referral URL + code are real and safe
//    9. the customer is not suppressed  (enforced by the send guard)
//   10. a referral was not already sent for this booking (enforced by the
//       FollowUpLedger unique key + the EmailSend idempotency key)
//
//  `receiptSentAt` DOES NOT EXIST on Booking — the durable signal in this schema
//  is AuditLog where action = RECEIPT_SENT (schema.prisma AuditAction). Its
//  `createdAt` is the receipt-sent time. Nothing here invents a timestamp.
//
//  Pure decision function (`evaluateReferralEligibility`) + a DB loader, so the
//  rules are unit-testable offline with no database.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { isSafeUrl } from '../emails/validation'

const log = queueLogger.child({ mod: 'referral-eligibility' })

/** Referral program master switch. Default OFF — a program must be turned on. */
export function isReferralProgramEnabled(): boolean {
  return process.env.REFERRAL_PROGRAM_ENABLED === 'true'
}

/**
 * When true (default), a completed booking must have a COMPLETED Stripe payment.
 * Set REFERRAL_REQUIRE_STRIPE=false only if the business starts taking cash jobs
 * that should still earn referral asks — and record why.
 */
export function referralRequiresStripe(): boolean {
  return process.env.REFERRAL_REQUIRE_STRIPE !== 'false'
}

export type ReferralFacts = {
  bookingExists: boolean
  bookingStatus: string | null
  isInternalTest: boolean
  /** A payment row whose provider is Stripe (has a payment intent or charge id). */
  hasStripePayment: boolean
  /** That payment's status. */
  paymentStatus: string | null
  /** Cumulative refunded cents on the qualifying payment, if any. */
  refundedAmountCents: number | null
  /** Timestamp of the durable AuditLog(RECEIPT_SENT) event, if one exists. */
  receiptSentAt: Date | null
  programEnabled: boolean
  requireStripe: boolean
  referralUrl: string | null
  referralCode: string | null
}

export type ReferralDecision = { eligible: boolean; reason: string }

const OK: ReferralDecision = { eligible: true, reason: 'eligible' }

/**
 * PURE rule evaluation. No database, no clock beyond the injected `now`.
 * Returns the FIRST failing reason so the admin sees the real blocker.
 */
export function evaluateReferralEligibility(facts: ReferralFacts, now: Date = new Date()): ReferralDecision {
  if (!facts.bookingExists) return { eligible: false, reason: 'no_booking' }

  // 1. completed only — never mid-job, never cancelled.
  if (facts.bookingStatus !== 'COMPLETED') {
    return { eligible: false, reason: `booking_not_completed:${facts.bookingStatus ?? 'unknown'}` }
  }

  // 2. internal tests never generate customer marketing.
  if (facts.isInternalTest) return { eligible: false, reason: 'internal_test_booking' }

  // 7. program switch (checked early — a disabled program short-circuits).
  if (!facts.programEnabled) return { eligible: false, reason: 'referral_program_disabled' }

  // 3 + 4. payment provider + status.
  if (facts.requireStripe && !facts.hasStripePayment) {
    return { eligible: false, reason: 'no_stripe_payment' }
  }
  if (facts.paymentStatus !== 'COMPLETED') {
    return { eligible: false, reason: `payment_not_completed:${facts.paymentStatus ?? 'none'}` }
  }
  // A refunded job is not a happy customer to ask for referrals.
  if ((facts.refundedAmountCents ?? 0) > 0) {
    return { eligible: false, reason: 'payment_refunded' }
  }

  // 5. durable receipt event.
  if (!facts.receiptSentAt) return { eligible: false, reason: 'no_receipt_event' }

  // 6. a receipt "sent" in the future is bad data, not proof.
  if (facts.receiptSentAt.getTime() > now.getTime()) {
    return { eligible: false, reason: 'receipt_event_in_future' }
  }

  // 8. real, safe links — an unusable referral link is worse than no email.
  if (!facts.referralUrl || !isSafeUrl(facts.referralUrl)) {
    return { eligible: false, reason: 'invalid_referral_url' }
  }
  if (!facts.referralCode || !facts.referralCode.trim()) {
    return { eligible: false, reason: 'missing_referral_code' }
  }

  return OK
}

/**
 * Load the facts for a booking and decide. Fails CLOSED — any read error is
 * `not eligible`, never an optimistic send.
 */
export async function checkReferralEligibility(
  bookingId: string,
  links: { referralUrl?: string | null; referralCode?: string | null } = {}
): Promise<ReferralDecision & { facts?: ReferralFacts }> {
  try {
    const [booking, receiptLog] = await Promise.all([
      prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          status: true,
          isInternalTest: true,
          payments: {
            select: {
              status: true,
              stripePaymentIntentId: true,
              stripeChargeId: true,
              refundedAmountCents: true,
              isInternalTest: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      // The durable receipt signal. `receiptSentAt` does not exist in this schema.
      prisma.auditLog.findFirst({
        where: { bookingId, action: 'RECEIPT_SENT' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ])

    // The qualifying payment: the most recent non-test payment carrying a Stripe id.
    const stripePayment = booking?.payments.find(
      (p) => !p.isInternalTest && (p.stripePaymentIntentId || p.stripeChargeId)
    )
    // Fall back to any non-test payment so the reason string stays informative
    // when Stripe is not required.
    const anyPayment = booking?.payments.find((p) => !p.isInternalTest)
    const qualifying = stripePayment ?? anyPayment

    const facts: ReferralFacts = {
      bookingExists: Boolean(booking),
      bookingStatus: booking?.status ?? null,
      isInternalTest: booking?.isInternalTest ?? false,
      hasStripePayment: Boolean(stripePayment),
      paymentStatus: qualifying?.status ?? null,
      refundedAmountCents: qualifying?.refundedAmountCents ?? null,
      receiptSentAt: receiptLog?.createdAt ?? null,
      programEnabled: isReferralProgramEnabled(),
      requireStripe: referralRequiresStripe(),
      referralUrl: links.referralUrl ?? process.env.REFERRAL_URL?.trim() ?? null,
      referralCode: links.referralCode ?? process.env.REFERRAL_CODE?.trim() ?? null,
    }

    const decision = evaluateReferralEligibility(facts)
    if (!decision.eligible) log.info({ bookingId, reason: decision.reason }, 'referral not eligible')
    return { ...decision, facts }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), bookingId }, 'eligibility read failed — failing closed')
    return { eligible: false, reason: 'eligibility_read_failed' }
  }
}
