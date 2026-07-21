// ============================================================================
// reporting-basis.ts — where a reported number CAME FROM (Stage 3, owner spec
// 2026-07-20).
//
// The rule this file exists to enforce: a report must always say whether a
// figure is finalized or provisional, and whether it is cash or accrual. Mixing
// them silently is how a business ends up distributing profit it has not made.
//
// FINALIZED  reads the immutable FinancialSnapshot written at closeout. It does
//            NOT recalculate from current settings — a rate change today can
//            never rewrite last quarter.
// PROVISIONAL recalculates live from the same centralized Phase 2 math, and is
//            always labelled.
//
// Pure functions, offline-tested.
// ============================================================================

export type ReportBasis = 'CASH' | 'ACCRUAL'
export type ReportScope = 'FINALIZED_ONLY' | 'PROVISIONAL_ONLY' | 'COMBINED'
export type FigureSource = 'FINALIZED' | 'PROVISIONAL' | 'ESTIMATED' | 'MIXED'

export interface BasisLabel {
  basis: ReportBasis
  scope: ReportScope
  source: FigureSource
  /** One line the UI and every export header must carry verbatim. */
  label: string
  /** Set when the figure blends sources and the reader must be warned. */
  warning: string | null
}

const BASIS_TEXT: Record<ReportBasis, string> = {
  CASH: 'Cash basis — money actually collected and paid',
  ACCRUAL: 'Accrual basis — billed and owed, whether or not settled',
}

const SCOPE_TEXT: Record<ReportScope, string> = {
  FINALIZED_ONLY: 'finalized moves only',
  PROVISIONAL_ONLY: 'provisional moves only',
  COMBINED: 'finalized and provisional combined',
}

/**
 * The disclosure line for a report. Every surface — dashboard header, table
 * footer, CSV/XLSX row 1, PDF header — uses this, so the basis can never be
 * lost between the calculation and the reader.
 */
export function describeBasis(basis: ReportBasis, scope: ReportScope, counts?: { finalized: number; provisional: number }): BasisLabel {
  let source: FigureSource =
    scope === 'FINALIZED_ONLY' ? 'FINALIZED' : scope === 'PROVISIONAL_ONLY' ? 'PROVISIONAL' : 'MIXED'

  let warning: string | null = null
  if (scope === 'COMBINED' && counts) {
    if (counts.provisional === 0) source = 'FINALIZED'
    else if (counts.finalized === 0) source = 'PROVISIONAL'
    else {
      warning = `Includes ${counts.provisional} move${counts.provisional === 1 ? '' : 's'} that ${counts.provisional === 1 ? 'has' : 'have'} not been financially finalized. Those figures may still change.`
    }
  }
  if (scope === 'PROVISIONAL_ONLY') {
    warning = 'Every figure here is provisional and may change at closeout.'
  }

  return {
    basis, scope, source,
    label: `${BASIS_TEXT[basis]} · ${SCOPE_TEXT[scope]}`,
    warning,
  }
}

// ── Per-move classification ─────────────────────────────────────────────────

export interface MoveFinancialRow {
  bookingId: string
  isFinalized: boolean
  /** From the current (non-superseded) snapshot when finalized. */
  snapshot?: {
    netBilledRevenueCents: number
    netCollectedRevenueCents: number
    outstandingBalanceCents: number
    directJobCostCents: number
    crewLaborCents: number
    ownerEconomicLaborCents: number
    allocatedOverheadCents: number
    cashGrossProfitCents: number
    economicProfitCents: number
    companyNetProfitCents: number
    economicNetProfitCents: number
    taxReserveCents: number
    businessReserveCents: number
    retainedEarningsCents: number
    distributableProfitCents: number
    // ── The 40/30/30 allocation (Stage 4) ──
    //    OPTIONAL because snapshots written before Stage 4 genuinely do not
    //    carry them. Missing reads as zero in a total, which is honest: that
    //    move allocated nothing under a policy that did not exist yet.
    businessRetainedCents?: number
    businessRetainedBp?: number
    roundingRemainderCents?: number
    /** [{ owner, amountCents, percentBp }] as allocated on THIS move. */
    ownerAllocations?: { owner: string; amountCents: number; percentBp: number }[]
  } | null
  /** Live recomputation, used when not finalized. */
  provisional?: MoveFinancialRow['snapshot']
  /** Anything that makes this row untrustworthy (drives the data-quality banner). */
  incompleteFlags?: string[]
}

export interface AggregateTotals {
  netBilledRevenueCents: number
  netCollectedRevenueCents: number
  outstandingBalanceCents: number
  directJobCostCents: number
  crewLaborCents: number
  ownerEconomicLaborCents: number
  allocatedOverheadCents: number
  cashGrossProfitCents: number
  economicProfitCents: number
  companyNetProfitCents: number
  economicNetProfitCents: number
  taxReserveCents: number
  businessReserveCents: number
  retainedEarningsCents: number
  distributableProfitCents: number
  // ── The 40/30/30 allocation, summed across the period ──
  businessRetainedCents: number
  roundingRemainderCents: number
  /** Allocation per owner key ("DIEGO" / "SEBASTIAN"), summed. Keyed rather
   *  than named so the totals do not hard-code who the owners are. */
  ownerAllocationCents: Record<string, number>
  /** Basis points of net collected revenue; null when nothing was collected. */
  marginBp: number | null
  moveCount: number
  finalizedCount: number
  provisionalCount: number
  /** Moves excluded because they had neither a snapshot nor a live figure. */
  unusableCount: number
}

const ZERO: AggregateTotals = {
  netBilledRevenueCents: 0, netCollectedRevenueCents: 0, outstandingBalanceCents: 0,
  directJobCostCents: 0, crewLaborCents: 0, ownerEconomicLaborCents: 0,
  allocatedOverheadCents: 0, cashGrossProfitCents: 0, economicProfitCents: 0,
  companyNetProfitCents: 0, economicNetProfitCents: 0, taxReserveCents: 0,
  businessReserveCents: 0, retainedEarningsCents: 0, distributableProfitCents: 0,
  businessRetainedCents: 0, roundingRemainderCents: 0, ownerAllocationCents: {},
  marginBp: null, moveCount: 0, finalizedCount: 0, provisionalCount: 0, unusableCount: 0,
}

/**
 * Pick the figures for ONE move according to the report scope.
 *
 * A finalized move ALWAYS reads its snapshot — never a live recomputation —
 * which is what makes historical reports stable.
 */
export function selectMoveFigures(row: MoveFinancialRow, scope: ReportScope): MoveFinancialRow['snapshot'] | null {
  if (row.isFinalized) {
    if (scope === 'PROVISIONAL_ONLY') return null
    return row.snapshot ?? null
  }
  if (scope === 'FINALIZED_ONLY') return null
  return row.provisional ?? null
}

/**
 * Roll a set of moves into company totals under one scope.
 *
 * `unusableCount` is reported rather than silently dropped: a move that should
 * be in the total but has no usable figures is itself information.
 */
export function aggregateMoves(rows: MoveFinancialRow[], scope: ReportScope): AggregateTotals {
  const t: AggregateTotals = { ...ZERO, ownerAllocationCents: {} }
  for (const row of rows) {
    const f = selectMoveFigures(row, scope)
    if (!f) {
      // Only count as unusable when the scope wanted it.
      const wanted = scope === 'COMBINED' || (scope === 'FINALIZED_ONLY' && row.isFinalized) || (scope === 'PROVISIONAL_ONLY' && !row.isFinalized)
      if (wanted) t.unusableCount++
      continue
    }
    t.moveCount++
    if (row.isFinalized) t.finalizedCount++
    else t.provisionalCount++

    t.netBilledRevenueCents += f.netBilledRevenueCents
    t.netCollectedRevenueCents += f.netCollectedRevenueCents
    t.outstandingBalanceCents += f.outstandingBalanceCents
    t.directJobCostCents += f.directJobCostCents
    t.crewLaborCents += f.crewLaborCents
    t.ownerEconomicLaborCents += f.ownerEconomicLaborCents
    t.allocatedOverheadCents += f.allocatedOverheadCents
    t.cashGrossProfitCents += f.cashGrossProfitCents
    t.economicProfitCents += f.economicProfitCents
    t.companyNetProfitCents += f.companyNetProfitCents
    t.economicNetProfitCents += f.economicNetProfitCents
    t.taxReserveCents += f.taxReserveCents
    t.businessReserveCents += f.businessReserveCents
    t.retainedEarningsCents += f.retainedEarningsCents
    t.distributableProfitCents += f.distributableProfitCents
    t.businessRetainedCents += f.businessRetainedCents ?? 0
    t.roundingRemainderCents += f.roundingRemainderCents ?? 0
    for (const a of f.ownerAllocations ?? []) {
      t.ownerAllocationCents[a.owner] = (t.ownerAllocationCents[a.owner] ?? 0) + a.amountCents
    }
  }
  t.marginBp = t.netCollectedRevenueCents > 0
    ? Math.round((t.companyNetProfitCents / t.netCollectedRevenueCents) * 10_000)
    : null
  return t
}

/**
 * The headline revenue figure under a basis.
 *  CASH    = collected (what actually arrived)
 *  ACCRUAL = billed (what was earned, settled or not)
 */
export function revenueForBasis(t: AggregateTotals, basis: ReportBasis): number {
  return basis === 'CASH' ? t.netCollectedRevenueCents : t.netBilledRevenueCents
}

/** True when combined totals blend sources and need the disclosure banner. */
export const isMixedSource = (t: AggregateTotals): boolean => t.finalizedCount > 0 && t.provisionalCount > 0
