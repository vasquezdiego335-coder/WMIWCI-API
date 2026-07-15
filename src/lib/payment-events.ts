// ════════════════════════════════════════════════════════════════════════
//  payment-events.ts — PURE refund/dispute state logic (no prisma, no Stripe).
//  Unit-tested offline; imported by src/lib/stripe-events.ts which does the I/O.
//
//  DESIGN (architecture review Q8/Q9): the Payment.status enum is NOT changed.
//  Refund state maps onto the EXISTING REFUNDED / PARTIALLY_REFUNDED values, and
//  disputes are tracked with additive nullable columns (stripe_dispute_id,
//  dispute_status) so money truth is never overwritten by a dispute.
//
//  All transitions are MONOTONIC so a webhook delivered twice or OUT OF ORDER
//  can never lower the refunded total or walk a status backwards.
// ════════════════════════════════════════════════════════════════════════

export type RefundableStatus = 'REFUNDED' | 'PARTIALLY_REFUNDED'

/** Cumulative refunded amount is non-decreasing. Take the max so a replayed or
 *  out-of-order charge.refunded (each carries the CUMULATIVE amount_refunded)
 *  can never reduce what we've recorded. */
export function monotonicRefund(existing: number | null | undefined, incoming: number | null | undefined): number {
  return Math.max(existing ?? 0, incoming ?? 0)
}

/** Derive the refund status from captured vs cumulative-refunded cents. Returns
 *  null when nothing is refunded (keep the prior status). */
export function refundStatusFor(capturedCents: number, refundedCents: number): RefundableStatus | null {
  if (refundedCents <= 0) return null
  return refundedCents >= capturedCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
}

export type PaymentRefundState = {
  amount: number // captured cents
  refundedAmountCents: number | null
  status: string // PaymentStatus
}

export type RefundPatch = {
  refundedAmountCents: number
  status: string
  stripeRefundId?: string
}

/**
 * Build the Payment update for a charge.refunded event. Pure + idempotent:
 * `amountRefunded` is Stripe's CUMULATIVE total, so replays converge and a
 * partial that later becomes full advances COMPLETED → PARTIALLY_REFUNDED →
 * REFUNDED but never backward.
 */
export function refundPatch(payment: PaymentRefundState, amountRefunded: number, refundId?: string | null): RefundPatch {
  const refundedAmountCents = monotonicRefund(payment.refundedAmountCents, amountRefunded)
  const derived = refundStatusFor(payment.amount, refundedAmountCents)
  const patch: RefundPatch = {
    refundedAmountCents,
    // Never walk backward out of a terminal REFUNDED state.
    status: payment.status === 'REFUNDED' ? 'REFUNDED' : derived ?? payment.status,
  }
  if (refundId) patch.stripeRefundId = refundId
  return patch
}

export type DisputeOutcome = 'open' | 'won' | 'lost'

/** Classify a Stripe dispute status into open / won / lost for alerting. */
export function disputeOutcome(status: string | null | undefined): DisputeOutcome {
  const s = (status ?? '').toLowerCase()
  if (s === 'won' || s === 'warning_closed') return 'won'
  if (s === 'lost') return 'lost'
  return 'open'
}

/** Whether a dispute status should raise a prominent owner alert (opened or a
 *  final outcome — not every intermediate 'under_review' tick). */
export function disputeIsAlertable(status: string | null | undefined, phase: 'created' | 'updated' | 'closed'): boolean {
  if (phase === 'created' || phase === 'closed') return true
  // updated: only alert when it flips to a decided outcome.
  return disputeOutcome(status) !== 'open'
}
