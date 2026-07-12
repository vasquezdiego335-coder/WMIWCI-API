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
//    • Travel fee + truck add-on are due ON MOVE DAY, never charged in Stripe.
// ════════════════════════════════════════════════════════════════════════

export const centsToDollars = (cents: number): number => cents / 100

/** "$409.00" — money with cents. Use for every displayed dollar amount. */
export function formatUSD(dollars: number): string {
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Format a CENTS integer as money. Guards against rendering cents as dollars. */
export function formatCentsUSD(cents: number): string {
  return formatUSD(centsToDollars(cents))
}

export type PaymentLike = { amount: number; status: string } // amount in CENTS

export type PricingInput = {
  baseRate?: number | null // DOLLARS
  totalEstimate?: number | null // DOLLARS
  travelFee?: number | null // CENTS
  truckAddonAmount?: number | null // CENTS
  truckAddonDueOnMoveDay?: boolean | null
  depositAmount?: number | null // CENTS (default 4900 = $49)
  depositPaid?: boolean | null
  payments?: PaymentLike[] // CENTS amounts
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
  moveTotalDollars: number | null
  balanceAfterJobDollars: number | null
  /** Travel + truck add-on — settled on move day, NOT charged in Stripe. */
  dueOnMoveDayDollars: number
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
  const collectedCents = payments.filter((p) => p.status === 'COMPLETED').reduce((s, p) => s + p.amount, 0)
  const refundedCents = payments.filter((p) => p.status === 'REFUNDED').reduce((s, p) => s + p.amount, 0)
  const depositCaptured = !!b.depositPaid || collectedCents > 0

  const moveTotalDollars = typeof b.totalEstimate === 'number' ? round2(b.totalEstimate) : null

  return {
    baseDollars: typeof b.baseRate === 'number' ? round2(b.baseRate) : null,
    travelFeeDollars,
    truckAddonDollars,
    depositDollars,
    depositAuthorized: true, // a booking reaches PENDING_APPROVAL only after the $49 auth
    depositCaptured,
    collectedDollars: round2(centsToDollars(collectedCents)),
    refundedDollars: round2(centsToDollars(refundedCents)),
    moveTotalDollars,
    balanceAfterJobDollars: moveTotalDollars != null ? round2(moveTotalDollars - depositDollars) : null,
    dueOnMoveDayDollars: round2(travelFeeDollars + truckAddonDollars),
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

  // Move total should equal base labor + travel fee (the server computes it that way).
  if (p.moveTotalDollars != null && p.baseDollars != null) {
    const expected = round2(p.baseDollars + p.travelFeeDollars)
    if (Math.abs(expected - p.moveTotalDollars) > 0.01) {
      issues.push(`totalEstimate ${p.moveTotalDollars} != base ${p.baseDollars} + travel ${p.travelFeeDollars}`)
    }
  }

  // Collected must never exceed what was actually captured.
  const capturedCents = (b.payments ?? []).filter((x) => x.status === 'COMPLETED').reduce((s, x) => s + x.amount, 0)
  if (round2(p.collectedDollars) !== round2(centsToDollars(capturedCents))) {
    issues.push('collectedDollars does not match CAPTURED (COMPLETED) payments')
  }

  return issues
}
