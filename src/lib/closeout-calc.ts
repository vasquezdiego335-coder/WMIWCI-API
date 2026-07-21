// ============================================================================
// closeout-calc.ts — THE financial hierarchy for one move (Phase 2, owner spec
// 2026-07-20). Revenue → costs → profit → overhead → reserves → distributable.
//
// EVERY figure in the closeout comes from here. Pages must not re-derive any of
// it; that divergence is what produced the Phase 0 defects.
//
// Pure functions, integer CENTS, basis points for rates (500 = 5.00%). No
// Prisma, so the whole hierarchy is unit-testable offline.
//
// THE RULE THIS FILE PROTECTS: profit is never computed from money that was not
// collected. An outstanding balance is a receivable, not cash, and it can never
// reach an owner distribution.
// ============================================================================

/** Bumped when a formula changes, so a snapshot records which math produced it. */
export const CALCULATION_VERSION = 'phase2.1'

const nn = (v: number | null | undefined): number => Math.max(0, Math.round(v ?? 0))
/** Basis points → cents of a base. 500bp of $100 = $5. */
export const applyBp = (baseCents: number, bp: number): number =>
  baseCents <= 0 || bp <= 0 ? 0 : Math.round((baseCents * bp) / 10_000)

// ── A. Revenue ──────────────────────────────────────────────────────────────

export interface BilledInput {
  /** Every approved customer charge, in cents, already itemized by the caller. */
  grossCustomerChargesCents: number
  discountsCents?: number | null
  creditsCents?: number | null
}

/** What the customer was BILLED — an entitlement, not cash. */
export function netBilledRevenueCents(i: BilledInput): number {
  return Math.max(0, nn(i.grossCustomerChargesCents) - nn(i.discountsCents) - nn(i.creditsCents))
}

export interface CollectedInput {
  /** Captured payments, net of refunds and lost chargebacks — from
   *  money-rules.summarizeRevenue. Never a gross capture. */
  netCollectedCents: number
}

/**
 * Money still owed by the customer, minus anything the owner has deliberately
 * written off. Never negative: collecting more than billed is a data problem,
 * not a negative receivable.
 */
export function outstandingBalanceCents(billed: number, collected: number, writeOffCents = 0): number {
  return Math.max(0, nn(billed) - nn(collected) - nn(writeOffCents))
}

// ── B. Direct job costs ─────────────────────────────────────────────────────

export interface DirectCostInput {
  /** APPROVED crew labor that is a cash cost (labor-calc.rollupLabor). */
  approvedCrewLaborCents: number
  /** Eligible job-linked expenses (money-rules.eligibleExpenseCents). Already
   *  includes truck, fuel, tolls, parking, supplies, food, damage. */
  eligibleExpenseCents: number
  /** Estimated Stripe processing fees on captured card money. */
  processingFeeCents: number
  /** Truck cost recorded OUTSIDE the expense ledger, if any. Normally 0 —
   *  truck costs are expenses. Kept separate so the caller cannot double-add. */
  standaloneTruckCostCents?: number | null
}

export function directJobCostCents(i: DirectCostInput): number {
  return (
    nn(i.approvedCrewLaborCents) +
    nn(i.eligibleExpenseCents) +
    nn(i.processingFeeCents) +
    nn(i.standaloneTruckCostCents)
  )
}

// ── C. Profit ───────────────────────────────────────────────────────────────

export interface ProfitInput {
  netCollectedRevenueCents: number
  directJobCostCents: number
  /** Owner hours worked without pay, valued at the replacement rate
   *  (labor-calc.rollupLabor.unpaidOwnerValueCents). Never cash. */
  unpaidOwnerLaborValueCents: number
  allocatedOverheadCents: number
}

export interface ProfitResult {
  cashGrossProfitCents: number
  economicProfitCents: number
  companyNetProfitCents: number
  economicNetProfitCents: number
  /** Basis points of net collected revenue; null when there is no revenue. */
  marginBp: number | null
}

/**
 *   cash gross profit  = net collected − direct job costs
 *   economic profit    = cash gross profit − unpaid owner labor
 *   company net profit = cash gross profit − allocated overhead
 *   economic net       = company net profit − unpaid owner labor
 *
 * All four may be NEGATIVE and are reported as such — a loss is never hidden.
 */
export function computeProfit(i: ProfitInput): ProfitResult {
  const cashGrossProfitCents = nn(i.netCollectedRevenueCents) - nn(i.directJobCostCents)
  const economicProfitCents = cashGrossProfitCents - nn(i.unpaidOwnerLaborValueCents)
  const companyNetProfitCents = cashGrossProfitCents - nn(i.allocatedOverheadCents)
  const economicNetProfitCents = companyNetProfitCents - nn(i.unpaidOwnerLaborValueCents)
  return {
    cashGrossProfitCents,
    economicProfitCents,
    companyNetProfitCents,
    economicNetProfitCents,
    marginBp: i.netCollectedRevenueCents > 0 ? Math.round((companyNetProfitCents / i.netCollectedRevenueCents) * 10_000) : null,
  }
}

// ── D. Overhead allocation ──────────────────────────────────────────────────

export type OverheadMethod = 'NONE' | 'PER_MOVE' | 'PCT_REVENUE' | 'PER_LABOR_HOUR' | 'MONTHLY_POOL' | 'MANUAL'

export interface OverheadInput {
  method: OverheadMethod
  netCollectedRevenueCents: number
  approvedLaborMinutes: number
  perMoveCents?: number | null
  pctRevenueBp?: number | null
  perLaborHourCents?: number | null
  monthlyPoolCents?: number | null
  /** Number of eligible completed moves in the period, for MONTHLY_POOL. */
  eligibleMovesInPeriod?: number | null
  manualCents?: number | null
}

export interface OverheadResult {
  amountCents: number
  method: OverheadMethod
  /** The rate actually used, stored on the snapshot so the number can be
   *  re-explained after the policy changes. */
  rateRaw: number | null
  basis: string
}

/** Allocate company overhead to ONE move. Never negative. */
export function computeOverhead(i: OverheadInput): OverheadResult {
  switch (i.method) {
    case 'PER_MOVE':
      return { amountCents: nn(i.perMoveCents), method: i.method, rateRaw: nn(i.perMoveCents), basis: 'fixed per completed move' }
    case 'PCT_REVENUE':
      return {
        amountCents: applyBp(nn(i.netCollectedRevenueCents), nn(i.pctRevenueBp)),
        method: i.method,
        rateRaw: nn(i.pctRevenueBp),
        basis: `${(nn(i.pctRevenueBp) / 100).toFixed(2)}% of net collected revenue`,
      }
    case 'PER_LABOR_HOUR': {
      const hours = nn(i.approvedLaborMinutes) / 60
      return {
        amountCents: Math.round(hours * nn(i.perLaborHourCents)),
        method: i.method,
        rateRaw: nn(i.perLaborHourCents),
        basis: `per approved crew hour (${hours.toFixed(2)}h)`,
      }
    }
    case 'MONTHLY_POOL': {
      const moves = Math.max(1, nn(i.eligibleMovesInPeriod))
      return {
        amountCents: Math.round(nn(i.monthlyPoolCents) / moves),
        method: i.method,
        rateRaw: nn(i.monthlyPoolCents),
        basis: `monthly pool ÷ ${moves} eligible move${moves === 1 ? '' : 's'}`,
      }
    }
    case 'MANUAL':
      return { amountCents: nn(i.manualCents), method: i.method, rateRaw: null, basis: 'manual owner allocation' }
    default:
      return { amountCents: 0, method: 'NONE', rateRaw: null, basis: 'no overhead allocated' }
  }
}

// ── E. Reserves + distributable profit ──────────────────────────────────────

export interface ReserveInput {
  companyNetProfitCents: number
  /** Percentage of company net profit held for taxes, in basis points. */
  taxReserveBp?: number | null
  /** A fixed tax amount, overriding the percentage when set. */
  taxReserveFixedCents?: number | null
  /**
   * THE COMPANY-RETAINED SHARE, in basis points of FINAL company net profit
   * (BusinessConfig.generalReserveBp). Owner policy 2026-07-21 = 4000 (40%).
   *
   * Applied ONLY to positive net profit, and only AFTER every cost and
   * overhead — never to customer revenue, the quote, or collected payments.
   * D4: this was a dead column until now.
   */
  businessRetainedBp?: number | null
  /** Named business reserves entered by hand (truck fund, emergency, …).
   *  ADDITIVE to the retained share above; the two are never the same money. */
  businessReserveCents?: number | null
  retainedEarningsCents?: number | null
  /** Money the business already owes: unpaid approved labor + owner
   *  reimbursements owed. Held back before anything is distributed. */
  unresolvedLiabilityCents?: number | null
}

export interface ReserveResult {
  taxReserveCents: number
  /** The policy share of profit the business keeps (generalReserveBp). */
  businessRetainedCents: number
  businessRetainedBp: number
  businessReserveCents: number
  retainedEarningsCents: number
  unresolvedLiabilityCents: number
  totalHeldBackCents: number
  /** Profit available to allocate at all: net profit − liabilities, floored. */
  availableForAllocationCents: number
  distributableProfitCents: number
  /** True only when REQUESTED allocations exceed what is available. */
  overAllocated: boolean
}

/**
 *   available     = max(0, company net profit − unresolved liabilities)
 *   retained      = generalReserveBp of POSITIVE net profit  (40% policy)
 *   distributable = available − retained − tax − manual reserves − retained earnings
 *
 * D2 — WHY `overAllocated` IS NOT `raw < 0`:
 *   A loss with NO requested allocation is not over-allocated. The old rule
 *   compared hold-backs against a negative profit, so every unprofitable move
 *   raised a HARD RESERVES_EXCEED_PROFIT blocker and could never be finalized —
 *   with a message that misdescribed the cause. Over-allocation now means what
 *   it says: somebody asked for more than exists.
 *
 * A loss therefore produces zero of everything and stays finalizable. Reserving
 * nothing against a loss is correct, not an error.
 */
export function computeReserves(i: ReserveInput): ReserveResult {
  const profit = i.companyNetProfitCents
  const positiveProfit = Math.max(0, profit)
  const unresolvedLiabilityCents = nn(i.unresolvedLiabilityCents)

  // What could be allocated at all, before any policy is applied.
  const availableForAllocationCents = Math.max(0, profit - unresolvedLiabilityCents)

  // D4 — the company-retained share, from BusinessConfig.generalReserveBp.
  // floor() by applyBp; any rounding remainder stays with the business because
  // the owner shares are computed from what is LEFT after this line.
  const businessRetainedBp = nn(i.businessRetainedBp)
  const businessRetainedCents = Math.min(availableForAllocationCents, applyBp(positiveProfit, businessRetainedBp))

  const taxReserveCents =
    i.taxReserveFixedCents != null ? nn(i.taxReserveFixedCents) : applyBp(positiveProfit, nn(i.taxReserveBp))
  const businessReserveCents = nn(i.businessReserveCents)
  const retainedEarningsCents = nn(i.retainedEarningsCents)

  const requestedAllocations =
    businessRetainedCents + taxReserveCents + businessReserveCents + retainedEarningsCents
  const totalHeldBackCents = requestedAllocations + unresolvedLiabilityCents

  return {
    taxReserveCents,
    businessRetainedCents,
    businessRetainedBp,
    businessReserveCents,
    retainedEarningsCents,
    unresolvedLiabilityCents,
    totalHeldBackCents,
    availableForAllocationCents,
    distributableProfitCents: Math.max(0, availableForAllocationCents - requestedAllocations),
    // Only a genuine over-ask is an error. Zero requested against a loss is not.
    overAllocated: requestedAllocations > availableForAllocationCents,
  }
}

// ── F. The whole hierarchy in one call ──────────────────────────────────────

export interface CloseoutInput {
  billed: BilledInput
  collected: CollectedInput
  refundedCents: number
  chargebackCents: number
  disputedOpenCents: number
  balanceWriteOffCents?: number | null
  costs: DirectCostInput
  unpaidOwnerLaborValueCents: number
  ownerCashLaborCents: number
  approvedLaborMinutes: number
  overhead: Omit<OverheadInput, 'netCollectedRevenueCents' | 'approvedLaborMinutes'>
  reserves: Omit<ReserveInput, 'companyNetProfitCents'>
}

export interface CloseoutFinancials {
  netBilledRevenueCents: number
  netCollectedRevenueCents: number
  outstandingBalanceCents: number
  refundedCents: number
  chargebackCents: number
  disputedOpenCents: number
  directJobCostCents: number
  crewLaborCents: number
  ownerCashLaborCents: number
  ownerEconomicLaborCents: number
  processingFeeCents: number
  truckCostCents: number
  directExpenseCents: number
  profit: ProfitResult
  overhead: OverheadResult
  reserves: ReserveResult
  calculationVersion: string
}

/** THE single derivation. The closeout page, the snapshot writer and the tests
 *  all call this, so they cannot disagree. */
export function computeCloseout(i: CloseoutInput): CloseoutFinancials {
  const netBilled = netBilledRevenueCents(i.billed)
  const netCollected = nn(i.collected.netCollectedCents)
  const outstanding = outstandingBalanceCents(netBilled, netCollected, nn(i.balanceWriteOffCents))

  const directCost = directJobCostCents(i.costs)

  const overhead = computeOverhead({
    ...i.overhead,
    netCollectedRevenueCents: netCollected,
    approvedLaborMinutes: i.approvedLaborMinutes,
  })

  const profit = computeProfit({
    netCollectedRevenueCents: netCollected,
    directJobCostCents: directCost,
    unpaidOwnerLaborValueCents: nn(i.unpaidOwnerLaborValueCents),
    allocatedOverheadCents: overhead.amountCents,
  })

  const reserves = computeReserves({ ...i.reserves, companyNetProfitCents: profit.companyNetProfitCents })

  return {
    netBilledRevenueCents: netBilled,
    netCollectedRevenueCents: netCollected,
    outstandingBalanceCents: outstanding,
    refundedCents: nn(i.refundedCents),
    chargebackCents: nn(i.chargebackCents),
    disputedOpenCents: nn(i.disputedOpenCents),
    directJobCostCents: directCost,
    crewLaborCents: nn(i.costs.approvedCrewLaborCents),
    ownerCashLaborCents: nn(i.ownerCashLaborCents),
    ownerEconomicLaborCents: nn(i.unpaidOwnerLaborValueCents),
    processingFeeCents: nn(i.costs.processingFeeCents),
    truckCostCents: nn(i.costs.standaloneTruckCostCents),
    directExpenseCents: nn(i.costs.eligibleExpenseCents),
    profit,
    overhead,
    reserves,
    calculationVersion: CALCULATION_VERSION,
  }
}
