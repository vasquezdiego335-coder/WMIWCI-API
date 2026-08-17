// ════════════════════════════════════════════════════════════════════════════
//  ITEM C2 (release blocker B2) — THE CUSTOMER PORTAL'S PAYMENT STATE.
//
//  Lifted out of page.tsx and PURE, because this is the derivation the blocker
//  asked for a test on: "export buildCustomerView (or lift the paymentStatus
//  derivation into a pure helper) and table-test the four combinations of
//  depositPaid × Payment.status × refundedAmountCents against the rendered
//  strings — that helper is what the 'no claim the code cannot prove' rule
//  needs a test for."
//
//  WHAT WAS WRONG. page.tsx read:
//
//      const captured = booking.depositPaid || booking.payments.some(p => p.status === 'COMPLETED')
//      const paymentStatus =
//        status === 'cancelled' ? 'released'
//          : captured ? 'captured' : …
//
//  `status === 'cancelled'` was tested FIRST, so `captured` was never consulted
//  for a cancelled booking, and six strings hung off the answer: "any $49 hold
//  has been released — you were not charged", "Nothing further is owed",
//  "$49 hold released", "Nothing is owed", "Any $49 hold was released in full —
//  your card was never charged", and "The authorization on your card was
//  released in full. You were not charged." All six shipped over a CAPTURED
//  $49, next to a working receipt link.
//
//  `booking.depositPaid` was half of the input, and that flag is written by the
//  approval CLAIM before Stripe is called — so it is not evidence either.
//
//  THE RULE HERE: a statement about money may only come from
//  `deposit-evidence`, which proves a capture from a Stripe-reported Payment
//  row, a hold from the amount Stripe reported at checkout, and a release from
//  the audit row the decline path writes from the Stripe call's OUTCOME.
//  Anything unproven renders as no claim and no figure.
// ════════════════════════════════════════════════════════════════════════════

import type { DepositEvidence } from '@/lib/deposit-evidence'

export type PaymentStatus =
  | 'captured' // a COMPLETED Stripe payment on this booking's own deposit intent
  | 'partially_refunded' // captured, and PART of it is recorded as refunded
  | 'refunded' // captured, and the WHOLE capture is recorded as refunded
  | 'received' // authorized/held, not captured (normal post-checkout state)
  | 'awaiting' // no verified payment yet
  | 'released' // no capture, and the release is PROVEN (or nothing was ever held)
  | 'hold_unresolved' // no capture, and NOTHING proves what became of the hold
  | 'unknown' // the ledger could not be READ — no money claim may be made at all

export interface PaymentView {
  paymentStatus: PaymentStatus
  /** PROVEN dollars, formatted, or null when nothing proves a figure. Null
   *  renders as no number at all — never "$49", never `depositAmount`. */
  paidAmount: string | null
  heldAmount: string | null
  refundedAmount: string | null
  /** A refund IS recorded but its amount cannot be determined. */
  refundAmountUnknown: boolean
}

/** Money for display: cents kept when they exist, ".00" dropped when they do
 *  not, so a proven $49.00 still reads "$49" and a proven $123.45 is never
 *  rounded to "$123". */
export function moneyExact(dollars: number): string {
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString('en-US')}`
    : `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const dollarsOf = (cents: number | null | undefined): string | null =>
  typeof cents === 'number' && Number.isFinite(cents) ? moneyExact(cents / 100) : null

/**
 * The portal's payment state, from evidence only.
 *
 * ORDER IS THE FIX: "was the card charged?" is asked FIRST, for every booking
 * including a cancelled one. Only when the answer is a proven no does the
 * cancellation matter, and then the page may say "released" ONLY if the release
 * itself is proven — a decline whose Stripe call failed lands in
 * `hold_unresolved`, which says the booking is cancelled and promises nothing
 * about the customer's card.
 */
export function paymentView(evidence: DepositEvidence, ctx: { cancelled: boolean; awaitingPayment: boolean }): PaymentView {
  const money = evidence.money

  // ── ITEM C1 (round 8) — A FAILED READ IS NOT EVIDENCE OF ANYTHING ────────
  //  `readDepositEvidence` never throws; it answers `degraded: true` with
  //  `money.state = 'none'` and `release = 'unknown'`, and NOTHING here read
  //  that flag. Those two values are not neutral downstream — they mean "the
  //  card was not charged" and "the hold is unresolved" — so a cancelled
  //  booking whose ledger read failed (P2022 in the code-before-SQL window, a
  //  Neon blip) rendered "Nothing is owed · we're releasing the authorization
  //  on your card" OVER A CAPTURED $49. That is release blocker B2 again, by a
  //  different door. The page now says the booking's state and says nothing
  //  whatsoever about the customer's card.
  if (evidence.degraded) {
    return {
      paymentStatus: 'unknown',
      paidAmount: null,
      heldAmount: null,
      refundedAmount: null,
      refundAmountUnknown: false,
    }
  }

  if (money.state !== 'none') {
    return {
      // ITEM C1 — `partially_refunded` used to collapse into `refunded`, so a
      // $10 refund against a $49 deposit told the customer "your deposit was
      // refunded". The ledger proves a PARTIAL refund; only that may be said.
      paymentStatus: money.state === 'captured' ? 'captured' : money.state === 'refunded' ? 'refunded' : 'partially_refunded',
      paidAmount: dollarsOf(money.cents),
      heldAmount: null,
      refundedAmount: money.refundAmountUnknown ? null : dollarsOf(money.refundedCents),
      refundAmountUnknown: money.refundAmountUnknown,
    }
  }

  const heldAmount = dollarsOf(evidence.authorizedCents)

  if (ctx.cancelled) {
    const releaseProven = evidence.release === 'released' || evidence.release === 'no_hold'
    return {
      paymentStatus: releaseProven ? 'released' : 'hold_unresolved',
      paidAmount: null,
      heldAmount,
      refundedAmount: null,
      refundAmountUnknown: false,
    }
  }

  return {
    paymentStatus: ctx.awaitingPayment ? 'awaiting' : 'received',
    paidAmount: null,
    heldAmount,
    refundedAmount: null,
    refundAmountUnknown: false,
  }
}

/** TRUE when this state means money actually left the customer's card. */
export const isCharged = (s: PaymentStatus): boolean =>
  s === 'captured' || s === 'refunded' || s === 'partially_refunded'

/** TRUE when a refund is recorded against the capture (whole or part). */
export const isRefunded = (s: PaymentStatus): boolean => s === 'refunded' || s === 'partially_refunded'

/**
 * TRUE when the page may show a PAYMENT RECEIPT link.
 *
 * ITEM C2 (release blocker B2) — the link was rendered whenever a `Receipt` row
 * existed, which put a live "View payment receipt" button directly under "The
 * authorization on your card was released in full. You were not charged." The
 * finding calls that out by name: two contradictory statements from one company
 * about one $49, on a public URL, in the customer's hands during a dispute.
 *
 * A receipt is a claim that money was taken, so it may appear only where the
 * ledger proves money was taken.
 */
export const canShowReceipt = (s: PaymentStatus): boolean => isCharged(s)
