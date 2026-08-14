// ════════════════════════════════════════════════════════════════════════
//  pricing.ts — the ONE canonical booking money calculation + formatters.
//  Pure (no prisma / network) so it is unit-tested offline and every surface
//  (admin, Discord, email, customer portal) can originate its totals here
//  instead of re-deriving them.
//
//  UNIT CONTRACT (the source of the "$409 vs $4.09" class of bugs):
//    • CENTS  (integers): depositAmount, truckAddonAmount, travelFee, Payment.amount
//    • DOLLARS (floats):  baseRate, totalEstimate, finalAmount
//  Never divide a DOLLARS field by 100. Never render a CENTS field without /100.
//
//  MONEY-FLOW FACTS:
//    • The $49 deposit is AUTHORIZED (held) at checkout, CAPTURED only on owner
//      approval. "Collected" counts CAPTURED (Payment.status=COMPLETED) only —
//      an authorized-but-not-captured hold is NOT collected.
//    • The $49 deposit is the ONLY money Stripe ever takes. Base labor, travel
//      and the truck add-on are ALL collected in person on move day, so the
//      "due on move day" amount is the WHOLE outstanding balance, never just
//      the fee columns.
//    • `Booking.totalEstimate` ALREADY contains the travel fee (estimate.ts:
//      base + access add-ons + travel). Adding travelFee to it double-bills.
//
//  For the live per-move balance used by the admin, use
//  `job-money.customerBalance()` — it works in integer cents and handles
//  waiting fees, itemized charges, discounts, refunds and chargebacks.
// ════════════════════════════════════════════════════════════════════════

import { computeQuote } from './booking-quote'

export const centsToDollars = (cents: number): number => cents / 100

/** "$409.00" — money with cents. Use for every displayed dollar amount. */
export function formatUSD(dollars: number): string {
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Format a CENTS integer as money. Guards against rendering cents as dollars. */
export function formatCentsUSD(cents: number): string {
  return formatUSD(centsToDollars(cents))
}

export type PaymentLike = { amount: number; status: string; isInternalTest?: boolean | null } // amount in CENTS

/** True for payments that count as REAL money: captured AND not an owner
 *  checkout test. THE revenue filter — every aggregate/report derives from it. */
export const isRealPayment = (p: PaymentLike): boolean => p.status === 'COMPLETED' && !p.isInternalTest

export type PricingInput = {
  baseRate?: number | null // DOLLARS
  totalEstimate?: number | null // DOLLARS
  travelFee?: number | null // CENTS
  truckAddonAmount?: number | null // CENTS
  truckAddonDueOnMoveDay?: boolean | null
  depositAmount?: number | null // CENTS (default 4900 = $49)
  depositPaid?: boolean | null
  payments?: PaymentLike[] // CENTS amounts
  /**
   * Whole percent off (10 = 10%).
   *
   * ADDED 2026-08-14. Its absence is what let the Discord approval card print
   * "Discount: MOVE10 10% off" on one line and "Move total: $550" on the next
   * — the discount was displayed and never applied. Every total below now
   * comes from computeQuote(), which applies it.
   */
  discountPercent?: number | null
}

export type PricingBreakdown = {
  baseDollars: number | null
  travelFeeDollars: number
  truckAddonDollars: number
  depositDollars: number
  depositAuthorized: boolean
  depositCaptured: boolean
  /** CAPTURED only (COMPLETED payments) — never counts an un-captured hold. */
  collectedDollars: number
  refundedDollars: number
  /**
   * THE final total the customer owes: quote + add-ons − discount.
   *
   * Was the raw `totalEstimate`, which ignored the discount entirely. On
   * WMIC-1019 that printed $550 next to a "10% off" line, while the admin
   * page — which did apply the discount — printed $495 for the same booking.
   */
  moveTotalDollars: number | null
  /** DOLLARS. The accepted quote BEFORE add-ons and discount (base + travel). */
  quotedDollars: number
  /** DOLLARS. The discount actually taken off. 0 when there is none. */
  discountDollars: number
  /**
   * What is left once the $49 authorization is captured.
   *
   * Was `totalEstimate − deposit`, i.e. $550 − $49 = $501 on WMIC-1019 — a
   * number that is neither the quote, the total, nor the balance. It is now
   * FINAL total − deposit = $495 − $49 = $446.
   */
  balanceAfterJobDollars: number | null
  /**
   * The customer's FULL remaining balance — base labor included. Stripe only
   * ever holds the $49 deposit, so everything still owed is collected in
   * person on move day.
   *
   * This used to be `travel + truck add-on`, which described the fee columns
   * rather than the balance and understated a $460 debt as "$100".
   */
  dueOnMoveDayDollars: number
  /** Of that balance, the part that is NOT inside the quote (truck add-on). */
  moveDayFeesDollars: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * The single source of truth for a booking's money breakdown. Every consumer
 * should format FROM this rather than re-deriving totals.
 */
export function bookingPricing(b: PricingInput): PricingBreakdown {
  const travelFeeDollars = round2(centsToDollars(b.travelFee ?? 0))
  const truckAddonDollars = b.truckAddonDueOnMoveDay ? round2(centsToDollars(b.truckAddonAmount ?? 0)) : 0
  const depositDollars = round2(centsToDollars(b.depositAmount ?? 4900))

  const payments = b.payments ?? []
  // Internal checkout tests are invisible to money math (they're still listed
  // in payment history UIs, just never counted).
  const collectedCents = payments.filter(isRealPayment).reduce((s, p) => s + p.amount, 0)
  const refundedCents = payments.filter((p) => p.status === 'REFUNDED' && !p.isInternalTest).reduce((s, p) => s + p.amount, 0)
  const depositCaptured = !!b.depositPaid || collectedCents > 0

  // ── THE ONE CALCULATION ────────────────────────────────────────────────
  //  Delegated to booking-quote.computeQuote, which job-money.customerBalance
  //  also calls. Two modules formatting one arithmetic cannot disagree; two
  //  modules each doing their own arithmetic did, for months, on every card.
  //
  //  The truck add-on is passed as an ADDITIONAL charge because estimate.ts
  //  deliberately leaves it out of estimatedTotal. Travel is already inside
  //  the quote and must not be added again.
  const authorizedNotCapturedCents = payments
    .filter((p) => p.status === 'PENDING' && !p.isInternalTest)
    .reduce((s, p) => s + p.amount, 0)
  const q = computeQuote({
    totalEstimate: b.totalEstimate,
    baseRate: b.baseRate,
    travelFeeCents: b.travelFee,
    additionalCents: Math.round(truckAddonDollars * 100),
    discountPercent: b.discountPercent,
    depositCents: b.depositAmount,
    collectedCents,
    authorizedNotCapturedCents,
  })

  return {
    baseDollars: typeof b.baseRate === 'number' ? round2(b.baseRate) : null,
    travelFeeDollars,
    truckAddonDollars,
    depositDollars,
    depositAuthorized: true, // a booking reaches PENDING_APPROVAL only after the $49 auth
    depositCaptured,
    collectedDollars: round2(centsToDollars(collectedCents)),
    refundedDollars: round2(centsToDollars(refundedCents)),
    // Null ONLY when there is genuinely nothing to price — never a silent 0.
    moveTotalDollars: q.quoteMissing && q.finalTotalCents === 0 ? null : q.finalTotalDollars,
    quotedDollars: round2(centsToDollars(q.quotedCents)),
    discountDollars: q.discountDollars,
    balanceAfterJobDollars: q.quoteMissing && q.finalTotalCents === 0 ? null : q.remainingAfterDepositDollars,
    dueOnMoveDayDollars: q.remainingDollars,
    moveDayFeesDollars: truckAddonDollars,
  }
}

/**
 * Consistency checks over a booking's money (Part 4). Returns human-readable
 * problems; empty means consistent. Catches the dollars-as-cents mistake, a
 * move-total that doesn't equal base+travel, and a collected amount that would
 * wrongly include an un-captured authorization.
 */
export function pricingConsistencyIssues(b: PricingInput): string[] {
  const issues: string[] = []
  const p = bookingPricing(b)

  // baseRate is DOLLARS — a flat service price (359–1549). No single residential
  // move is $10,000+, so a value that large is almost certainly cents stored as a
  // dollar value (e.g. 40900 = $409 mis-stored) — the "$409 vs $4.09" bug's twin.
  if (p.baseDollars != null && p.baseDollars >= 10000) {
    issues.push(`baseRate ${p.baseDollars} looks like cents stored as a dollar value (would misprice the move)`)
  }

  // The stored QUOTE should equal base labor + travel fee (the server computes
  // it that way). Compared against `quotedDollars`, not the final total — the
  // final total legitimately differs once a discount or an add-on applies, and
  // checking it here would report every discounted booking as inconsistent.
  if (p.baseDollars != null && (b.totalEstimate != null || p.quotedDollars > 0)) {
    const expected = round2(p.baseDollars + p.travelFeeDollars)
    if (Math.abs(expected - p.quotedDollars) > 0.01) {
      issues.push(`totalEstimate ${p.quotedDollars} != base ${p.baseDollars} + travel ${p.travelFeeDollars}`)
    }
  }

  // Collected must never exceed what was actually captured.
  const capturedCents = (b.payments ?? []).filter(isRealPayment).reduce((s, x) => s + x.amount, 0)
  if (round2(p.collectedDollars) !== round2(centsToDollars(capturedCents))) {
    issues.push('collectedDollars does not match CAPTURED (COMPLETED) payments')
  }

  return issues
}
