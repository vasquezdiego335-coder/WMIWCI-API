// ============================================================================
// profit-allocation.ts — THE owner-facing view of the profit policy.
//
// Owner policy 2026-07-21: of FINAL company net profit —
//   40% retained by the business · 30% Diego · 30% Sebastian
//
// Internally that is `generalReserveBp` (the retained share) plus a 50/50 owner
// split of what REMAINS. Presenting the internal numbers alone would read as
// "the owners take everything and the business keeps nothing", which is the
// opposite of the policy. Every owner-facing surface must render THIS model,
// never the raw split percentages.
//
// Pure — no Prisma, no React. Offline-tested.
// ============================================================================

export interface AllocationLine {
  /** 'Business retained' | 'Diego allocation' | 'Sebastian allocation' */
  label: string
  /** Share of FINAL company net profit, in basis points (4000 = 40%). */
  ofNetProfitBp: number
  amountCents: number
  /** True for the business line — it also absorbs the rounding remainder. */
  isBusiness: boolean
}

export interface ProfitAllocationView {
  companyNetProfitCents: number
  /** False on a loss or a zero-profit move: nothing is allocated to anyone. */
  hasDistribution: boolean
  businessRetainedCents: number
  businessRetainedBp: number
  ownerDistributableCents: number
  lines: AllocationLine[]
  /** Integer-cent remainder; stays with the business by policy. */
  roundingRemainderCents: number
  /** One-sentence explanation shown next to the numbers. */
  explanation: string
}

export const ALLOCATION_EXPLANATION =
  'The business retains 40% of final positive company net profit. The remaining 60% is divided ' +
  'equally between Diego and Sebastian, giving each owner 30% of total final profit.'

/** Share of NET PROFIT each owner ends up with, in basis points. */
function ownerShareOfNetBp(retainedBp: number, ownershipBp: number): number {
  return Math.round(((10_000 - retainedBp) * ownershipBp) / 10_000)
}

export interface AllocationInput {
  companyNetProfitCents: number
  businessRetainedCents: number
  businessRetainedBp: number
  distributableProfitCents: number
  /** Resolved owner allocations, already computed by owner-split. */
  ownerShares: { owner: string; amountCents: number; percentBp: number }[]
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

/**
 * Build the owner-facing 40/30/30 view.
 *
 * A loss or a zero-profit move produces `hasDistribution: false` and zero on
 * every line — never a negative allocation, and never a share of a receivable.
 */
export function buildProfitAllocation(i: AllocationInput): ProfitAllocationView {
  const hasDistribution = i.companyNetProfitCents > 0 && i.distributableProfitCents > 0
  const allocated = i.ownerShares.reduce((s, o) => s + o.amountCents, 0)
  const remainder = Math.max(0, i.distributableProfitCents - allocated)

  const lines: AllocationLine[] = [
    {
      label: 'Business retained',
      ofNetProfitBp: i.businessRetainedBp,
      // The remainder stays with the business, so it belongs on this line.
      amountCents: i.businessRetainedCents + remainder,
      isBusiness: true,
    },
    ...i.ownerShares.map((o) => ({
      label: `${titleCase(o.owner)} allocation`,
      ofNetProfitBp: ownerShareOfNetBp(i.businessRetainedBp, o.percentBp),
      amountCents: o.amountCents,
      isBusiness: false,
    })),
  ]

  return {
    companyNetProfitCents: i.companyNetProfitCents,
    hasDistribution,
    businessRetainedCents: i.businessRetainedCents,
    businessRetainedBp: i.businessRetainedBp,
    ownerDistributableCents: i.distributableProfitCents,
    lines,
    roundingRemainderCents: remainder,
    explanation: ALLOCATION_EXPLANATION,
  }
}

/** "40%" from 4000. Whole percents stay whole; halves keep one decimal. */
export function bpToPercentLabel(bp: number): string {
  const pct = bp / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`
}
