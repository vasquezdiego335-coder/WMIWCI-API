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

// ── Reading a FINALIZED move back ───────────────────────────────────────────

/** The frozen fields a FinancialSnapshot row carries. */
export interface SnapshotAllocationRow {
  companyNetProfitCents: number
  businessRetainedCents: number
  businessRetainedBp: number
  distributableProfitCents: number
  roundingRemainderCents?: number | null
  ownerAllocations?: unknown
  /** The presented lines, stored verbatim at finalization. */
  allocationLines?: unknown
}

const isLine = (v: unknown): v is AllocationLine =>
  !!v && typeof v === 'object' &&
  typeof (v as AllocationLine).label === 'string' &&
  typeof (v as AllocationLine).amountCents === 'number'

const isShare = (v: unknown): v is { owner: string; amountCents: number; percentBp: number } =>
  !!v && typeof v === 'object' &&
  typeof (v as { owner: unknown }).owner === 'string' &&
  typeof (v as { amountCents: unknown }).amountCents === 'number'

/**
 * Rebuild the owner-facing 40/30/30 view of a FINALIZED move from its snapshot
 * ALONE.
 *
 * THE RULE THIS FUNCTION EXISTS TO ENFORCE: a historical figure is never
 * recomputed from live configuration. Changing the retained share, the owner
 * split or an owner's labor rate today must leave every closed move exactly
 * where it was — so nothing here reads BusinessConfig, and the percentages come
 * from the basis points that were frozen at the time.
 *
 * Stored lines are preferred when present (they are what the owner actually
 * saw). Older snapshots, written before `allocationLines` existed, are restated
 * from the frozen amounts — still without touching live config.
 */
export function allocationFromSnapshot(row: SnapshotAllocationRow): ProfitAllocationView {
  const stored = Array.isArray(row.allocationLines) ? row.allocationLines.filter(isLine) : []
  if (stored.length > 0) {
    return {
      companyNetProfitCents: row.companyNetProfitCents,
      hasDistribution: stored.some((l) => !l.isBusiness && l.amountCents > 0),
      businessRetainedCents: row.businessRetainedCents,
      businessRetainedBp: row.businessRetainedBp,
      ownerDistributableCents: row.distributableProfitCents,
      lines: stored,
      roundingRemainderCents: row.roundingRemainderCents ?? 0,
      explanation: ALLOCATION_EXPLANATION,
    }
  }

  const shares = Array.isArray(row.ownerAllocations) ? row.ownerAllocations.filter(isShare) : []
  return buildProfitAllocation({
    companyNetProfitCents: row.companyNetProfitCents,
    businessRetainedCents: row.businessRetainedCents,
    businessRetainedBp: row.businessRetainedBp,
    distributableProfitCents: row.distributableProfitCents,
    ownerShares: shares.map((s) => ({ owner: s.owner, amountCents: s.amountCents, percentBp: s.percentBp ?? 0 })),
  })
}

// ── Period totals ───────────────────────────────────────────────────────────

/**
 * The same 40/30/30 block for a WHOLE PERIOD rather than one move.
 *
 * The percentages are DERIVED from the dollars actually allocated, not asserted
 * from today's policy — across a period some moves may have closed under an
 * older retained share, and a report that printed "40%" over numbers that added
 * up to something else would be lying about history. Loss-making moves
 * contribute a loss to net profit and zero to every allocation, so a period can
 * legitimately show a smaller realized share than the headline rate.
 */
export function allocationFromTotals(t: {
  companyNetProfitCents: number
  businessRetainedCents: number
  roundingRemainderCents: number
  distributableProfitCents: number
  ownerAllocationCents: Record<string, number>
}): ProfitAllocationView {
  const net = t.companyNetProfitCents
  const shareBp = (cents: number) => (net > 0 ? Math.round((cents / net) * 10_000) : 0)
  const businessTotal = t.businessRetainedCents + t.roundingRemainderCents

  const owners = Object.entries(t.ownerAllocationCents).sort(([a], [b]) => a.localeCompare(b))
  const lines: AllocationLine[] = [
    { label: 'Business retained', ofNetProfitBp: shareBp(businessTotal), amountCents: businessTotal, isBusiness: true },
    ...owners.map(([owner, amountCents]) => ({
      label: `${titleCase(owner)} allocation`,
      ofNetProfitBp: shareBp(amountCents),
      amountCents,
      isBusiness: false,
    })),
  ]

  return {
    companyNetProfitCents: net,
    hasDistribution: owners.some(([, cents]) => cents > 0),
    businessRetainedCents: t.businessRetainedCents,
    businessRetainedBp: shareBp(businessTotal),
    ownerDistributableCents: t.distributableProfitCents,
    lines,
    roundingRemainderCents: t.roundingRemainderCents,
    explanation: ALLOCATION_EXPLANATION,
  }
}

// ── One shape for every report, export and printed summary ──────────────────

export type AllocationBasis = 'FINALIZED' | 'PROVISIONAL'

export interface AllocationExportFields {
  companyNetProfit: number
  businessRetainedBp: number
  businessRetainedPercent: string
  businessRetained: number
  diegoPercent: string
  diegoAllocation: number
  sebastianPercent: string
  sebastianAllocation: number
  roundingRemainder: number
  /** 'Finalized' or 'Provisional' — never blank, so a reader always knows. */
  allocationStatus: string
  snapshotVersion: number | string
}

const dollars = (cents: number): number => Math.round(cents) / 100
const ownerLine = (v: ProfitAllocationView, owner: string): AllocationLine | undefined =>
  v.lines.find((l) => !l.isBusiness && l.label.toUpperCase().startsWith(owner.toUpperCase()))

/**
 * The 40/30/30 block as flat, exportable fields — the SAME numbers the screen
 * shows, because both come from the same view.
 *
 * Every value is a plain number or a short string. Nothing here is a credential,
 * a provider secret, a receipt URL or any other restricted field, so this can be
 * appended to any export without widening what leaves the building.
 */
export function allocationExportFields(
  v: ProfitAllocationView,
  meta: { basis: AllocationBasis; snapshotVersion?: number | null },
): AllocationExportFields {
  const diego = ownerLine(v, 'Diego')
  const sebastian = ownerLine(v, 'Sebastian')
  return {
    companyNetProfit: dollars(v.companyNetProfitCents),
    businessRetainedBp: v.businessRetainedBp,
    businessRetainedPercent: bpToPercentLabel(v.businessRetainedBp),
    businessRetained: dollars(v.lines.find((l) => l.isBusiness)?.amountCents ?? v.businessRetainedCents),
    diegoPercent: bpToPercentLabel(diego?.ofNetProfitBp ?? 0),
    diegoAllocation: dollars(diego?.amountCents ?? 0),
    sebastianPercent: bpToPercentLabel(sebastian?.ofNetProfitBp ?? 0),
    sebastianAllocation: dollars(sebastian?.amountCents ?? 0),
    roundingRemainder: dollars(v.roundingRemainderCents),
    allocationStatus: meta.basis === 'FINALIZED' ? 'Finalized' : 'Provisional',
    snapshotVersion: meta.snapshotVersion ?? '',
  }
}

/** The export columns for the fields above. Report column sets spread this in
 *  so no surface can ship half the policy. */
export const ALLOCATION_EXPORT_COLUMNS: { key: string; header: string; money?: boolean; roles?: string[] }[] = [
  { key: 'companyNetProfit', header: 'Final company net profit', money: true, roles: ['OWNER'] },
  { key: 'businessRetainedBp', header: 'Business retained (bp)', roles: ['OWNER'] },
  { key: 'businessRetainedPercent', header: 'Business retained %', roles: ['OWNER'] },
  { key: 'businessRetained', header: 'Business retained', money: true, roles: ['OWNER'] },
  { key: 'diegoPercent', header: 'Diego % of net profit', roles: ['OWNER'] },
  { key: 'diegoAllocation', header: 'Diego allocation', money: true, roles: ['OWNER'] },
  { key: 'sebastianPercent', header: 'Sebastian % of net profit', roles: ['OWNER'] },
  { key: 'sebastianAllocation', header: 'Sebastian allocation', money: true, roles: ['OWNER'] },
  { key: 'roundingRemainder', header: 'Rounding remainder (business)', money: true, roles: ['OWNER'] },
  { key: 'allocationStatus', header: 'Finalized / provisional' },
  { key: 'snapshotVersion', header: 'Snapshot version' },
]

/**
 * The block as printable text, in the owner's agreed wording:
 *
 *   Final company net profit   $1,000.00
 *   Business retained — 40%      $400.00
 *   Diego allocation — 30%       $300.00
 *   Sebastian allocation — 30%   $300.00
 *
 * Used by the printable closeout summary and by tests that pin the wording.
 */
export function renderAllocationText(v: ProfitAllocationView, meta?: { basis?: AllocationBasis }): string {
  const money = (c: number) => (Math.round(c) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  const head = `Final company net profit: ${money(v.companyNetProfitCents)}`
  const status = meta?.basis === 'PROVISIONAL' ? ' (Provisional)' : ''
  const body = v.lines.map((l) => `${l.label} — ${bpToPercentLabel(l.ofNetProfitBp)}: ${money(l.amountCents)}`)
  return [head + status, ...body].join('\n')
}
