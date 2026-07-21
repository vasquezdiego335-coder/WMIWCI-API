// ============================================================================
// pricing-intelligence.ts — what should a move like this cost? (Stage 3).
//
// Learns ONLY from finalized moves. A provisional move has not proven what it
// cost, so it cannot teach what to charge.
//
// THREE HARD RULES:
//  1. Never recommend from insufficient history. Under 3 comparables returns
//     INSUFFICIENT and no price — a confident-looking number built on one move
//     is worse than no number.
//  2. Always show the assumptions and the evidence count. A recommendation the
//     owner cannot interrogate is not decision support, it is a guess.
//  3. NEVER apply or send a quote. This module returns a recommendation object
//     and nothing else; there is no write path to a customer price.
//
// Median, not mean: one nightmare move should not drag the recommendation for
// twenty normal ones.
// ============================================================================

export type Confidence = 'INSUFFICIENT' | 'LOW' | 'MODERATE' | 'STRONG'

export const CONFIDENCE_THRESHOLDS = { low: 3, moderate: 6, strong: 16 } as const

export function confidenceFor(comparableCount: number): Confidence {
  if (comparableCount < CONFIDENCE_THRESHOLDS.low) return 'INSUFFICIENT'
  if (comparableCount < CONFIDENCE_THRESHOLDS.moderate) return 'LOW'
  if (comparableCount < CONFIDENCE_THRESHOLDS.strong) return 'MODERATE'
  return 'STRONG'
}

export const CONFIDENCE_TEXT: Record<Confidence, string> = {
  INSUFFICIENT: 'Not enough history to recommend a price',
  LOW: 'Low confidence — very few comparable moves',
  MODERATE: 'Moderate confidence',
  STRONG: 'Stronger confidence',
}

// ── Statistics ──────────────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]
}

/**
 * Drop extreme outliers using the interquartile range (1.5 × IQR — the standard
 * Tukey fence). Below 4 points nothing is dropped: with so little data every
 * point is signal.
 */
export function withoutOutliers(values: number[]): { kept: number[]; dropped: number[] } {
  if (values.length < 4) return { kept: [...values], dropped: [] }
  const q1 = percentile(values, 25)!
  const q3 = percentile(values, 75)!
  const iqr = q3 - q1
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  const kept: number[] = []
  const dropped: number[] = []
  for (const v of values) (v < lo || v > hi ? dropped : kept).push(v)
  return { kept, dropped }
}

// ── Comparables ─────────────────────────────────────────────────────────────

export interface ComparableMove {
  bookingId: string
  serviceType?: string | null
  crewSize?: number | null
  actualMinutes?: number | null
  stops?: number | null
  originCity?: string | null
  destCity?: string | null
  stairs?: boolean | null
  heavyItems?: boolean | null
  truckSource?: string | null
  outOfState?: boolean | null
  /** FINALIZED figures only. */
  netCollectedRevenueCents: number
  directJobCostCents: number
  crewLaborCents: number
  companyNetProfitCents: number
  marginBp: number | null
}

export interface PricingQuery {
  serviceType?: string | null
  crewSize?: number | null
  estimatedMinutes?: number | null
  stops?: number | null
  city?: string | null
  stairs?: boolean | null
  heavyItems?: boolean | null
  truckSource?: string | null
  outOfState?: boolean | null
}

/**
 * Score how similar a past move is to the query. Only moves scoring above the
 * floor become comparables — and the matched dimensions are reported so the
 * owner can see WHY something was considered similar.
 */
export function similarityScore(q: PricingQuery, m: ComparableMove): { score: number; matched: string[] } {
  const matched: string[] = []
  let score = 0
  const add = (w: number, label: string) => { score += w; matched.push(label) }

  if (q.serviceType && m.serviceType && q.serviceType === m.serviceType) add(35, 'service type')
  if (q.crewSize != null && m.crewSize != null && q.crewSize === m.crewSize) add(20, 'crew size')
  if (q.estimatedMinutes != null && m.actualMinutes != null) {
    const ratio = m.actualMinutes / Math.max(1, q.estimatedMinutes)
    if (ratio >= 0.7 && ratio <= 1.3) add(15, 'similar duration')
  }
  if (q.stops != null && m.stops != null && q.stops === m.stops) add(8, 'stop count')
  if (q.city && (m.originCity === q.city || m.destCity === q.city)) add(10, 'city')
  if (q.stairs != null && m.stairs != null && q.stairs === m.stairs) add(5, 'stairs')
  if (q.heavyItems != null && m.heavyItems != null && q.heavyItems === m.heavyItems) add(5, 'heavy items')
  if (q.truckSource && m.truckSource && q.truckSource === m.truckSource) add(7, 'truck source')
  if (q.outOfState != null && m.outOfState != null && q.outOfState === m.outOfState) add(5, 'out of state')
  return { score, matched }
}

export const SIMILARITY_FLOOR = 35

export interface PricingRecommendation {
  confidence: Confidence
  confidenceText: string
  comparableCount: number
  outliersDropped: number
  /** Every dimension that was used to select comparables. */
  assumptions: string[]
  medianPriceCents: number | null
  averagePriceCents: number | null
  medianDirectCostCents: number | null
  medianLaborCents: number | null
  medianMinutes: number | null
  medianProfitCents: number | null
  medianMarginBp: number | null
  /** The cheapest historical price that still produced a profit. */
  lowestProfitablePriceCents: number | null
  /** Median direct cost — below this, a move loses money before overhead. */
  breakEvenPriceCents: number | null
  suggestedRange: { lowCents: number; highCents: number } | null
  /** Human-readable caveats the UI must display with the number. */
  caveats: string[]
  /** ALWAYS false. Kept explicit so no caller can mistake this for an action. */
  quoteApplied: false
}

/**
 * Recommend a price range from finalized history.
 *
 * The range is the 25th–75th percentile of comparable prices, floored at the
 * break-even cost — never recommend a range whose bottom loses money.
 */
export function recommendPrice(q: PricingQuery, allMoves: ComparableMove[]): PricingRecommendation {
  const scored = allMoves
    .map((m) => ({ m, ...similarityScore(q, m) }))
    .filter((x) => x.score >= SIMILARITY_FLOOR)
    .sort((a, b) => b.score - a.score)

  const assumptions: string[] = []
  if (q.serviceType) assumptions.push(`service type = ${q.serviceType}`)
  if (q.crewSize != null) assumptions.push(`crew size = ${q.crewSize}`)
  if (q.estimatedMinutes != null) assumptions.push(`estimated ${(q.estimatedMinutes / 60).toFixed(1)}h`)
  if (q.stops != null) assumptions.push(`${q.stops} stop(s)`)
  if (q.city) assumptions.push(`city = ${q.city}`)
  if (q.truckSource) assumptions.push(`truck = ${q.truckSource}`)
  if (q.stairs) assumptions.push('stairs')
  if (q.heavyItems) assumptions.push('heavy items')
  if (q.outOfState) assumptions.push('out of state')
  assumptions.push('finalized moves only')

  const caveats: string[] = []
  const prices = scored.map((x) => x.m.netCollectedRevenueCents)
  const { kept, dropped } = withoutOutliers(prices)
  const keptMoves = scored.filter((x) => kept.includes(x.m.netCollectedRevenueCents))

  const confidence = confidenceFor(kept.length)

  if (confidence === 'INSUFFICIENT') {
    return {
      confidence,
      confidenceText: CONFIDENCE_TEXT[confidence],
      comparableCount: kept.length,
      outliersDropped: dropped.length,
      assumptions,
      medianPriceCents: null, averagePriceCents: null, medianDirectCostCents: null,
      medianLaborCents: null, medianMinutes: null, medianProfitCents: null, medianMarginBp: null,
      lowestProfitablePriceCents: null, breakEvenPriceCents: null, suggestedRange: null,
      caveats: [
        `Only ${kept.length} comparable finalized move${kept.length === 1 ? '' : 's'} — at least ${CONFIDENCE_THRESHOLDS.low} are needed before a price is suggested.`,
        'Price this move from the break-even calculator and judgement instead.',
      ],
      quoteApplied: false,
    }
  }

  const medianPriceCents = median(kept)
  const medianDirectCostCents = median(keptMoves.map((x) => x.m.directJobCostCents))
  const profitableMoves = keptMoves.filter((x) => x.m.companyNetProfitCents > 0)
  const lowestProfitablePriceCents = profitableMoves.length ? Math.min(...profitableMoves.map((x) => x.m.netCollectedRevenueCents)) : null

  const lowRaw = percentile(kept, 25) ?? medianPriceCents!
  const highRaw = percentile(kept, 75) ?? medianPriceCents!
  // Never suggest a floor beneath the cost of doing the work.
  const floor = medianDirectCostCents ?? 0
  const suggestedRange = { lowCents: Math.max(lowRaw, floor), highCents: Math.max(highRaw, floor) }

  if (confidence === 'LOW') caveats.push(`Based on only ${kept.length} comparable moves — treat as a starting point, not a rule.`)
  if (dropped.length > 0) caveats.push(`${dropped.length} outlier move(s) excluded from the range.`)
  if (lowRaw < floor) caveats.push('The historical low was below the typical direct cost, so the suggested floor was raised to break-even.')
  if (profitableMoves.length === 0) caveats.push('None of the comparable moves were profitable. Review pricing for this move type.')
  caveats.push('Recommendation only — no quote has been created, sent, or applied.')

  return {
    confidence,
    confidenceText: CONFIDENCE_TEXT[confidence],
    comparableCount: kept.length,
    outliersDropped: dropped.length,
    assumptions,
    medianPriceCents,
    averagePriceCents: mean(kept),
    medianDirectCostCents,
    medianLaborCents: median(keptMoves.map((x) => x.m.crewLaborCents)),
    medianMinutes: median(keptMoves.map((x) => x.m.actualMinutes ?? 0).filter((v) => v > 0)),
    medianProfitCents: median(keptMoves.map((x) => x.m.companyNetProfitCents)),
    medianMarginBp: median(keptMoves.map((x) => x.m.marginBp ?? 0)),
    lowestProfitablePriceCents,
    breakEvenPriceCents: medianDirectCostCents,
    suggestedRange,
    caveats,
    quoteApplied: false,
  }
}

// ── Break-even calculator ───────────────────────────────────────────────────

export interface BreakEvenInput {
  crewSize: number
  estimatedMinutes: number
  hourlyRateCents?: number | null
  flatLaborCents?: number | null
  /** What owner hours are WORTH even when no cash is paid. */
  ownerUnpaidMinutes?: number | null
  ownerEconomicRateCents?: number | null
  truckCents?: number | null
  fuelCents?: number | null
  tollsCents?: number | null
  suppliesCents?: number | null
  /** Processing fee as basis points of the price (2.9% ≈ 290bp). */
  processingFeeBp?: number | null
  overheadCents?: number | null
  targetMarginBp?: number | null
  taxReserveBp?: number | null
  businessReserveBp?: number | null
}

export interface BreakEvenResult {
  cashLaborCents: number
  ownerEconomicLaborCents: number
  otherDirectCents: number
  /** Costs that require actual cash. */
  directCostBreakEvenCents: number
  /** Direct costs + overhead — the price at which the company breaks even. */
  cashBreakEvenCents: number
  /** Cash break-even + the value of unpaid owner time. */
  economicBreakEvenCents: number
  targetPriceCents: number
  expectedCashProfitCents: number
  expectedEconomicProfitCents: number
  expectedMarginBp: number | null
  assumptions: string[]
}

/**
 * The minimum price this move can be sold at.
 *
 * Three distinct floors, deliberately not collapsed:
 *   DIRECT   covers only the money that leaves the business
 *   CASH     also covers overhead — the real company break-even
 *   ECONOMIC also charges for unpaid owner hours, so "we did it ourselves"
 *            stops looking free
 */
export function computeBreakEven(i: BreakEvenInput): BreakEvenResult {
  const nn = (v: number | null | undefined) => Math.max(0, Math.round(v ?? 0))
  const assumptions: string[] = []

  const crewMinutes = Math.max(0, i.estimatedMinutes) * Math.max(1, i.crewSize)
  const cashLaborCents = i.flatLaborCents != null
    ? nn(i.flatLaborCents)
    : Math.round((crewMinutes / 60) * nn(i.hourlyRateCents))
  assumptions.push(
    i.flatLaborCents != null
      ? `flat labor ${(nn(i.flatLaborCents) / 100).toFixed(2)}`
      : `${i.crewSize} crew × ${(i.estimatedMinutes / 60).toFixed(1)}h at ${(nn(i.hourlyRateCents) / 100).toFixed(2)}/h`,
  )

  const ownerEconomicLaborCents = Math.round((nn(i.ownerUnpaidMinutes) / 60) * nn(i.ownerEconomicRateCents))
  if (ownerEconomicLaborCents > 0) {
    assumptions.push(`${(nn(i.ownerUnpaidMinutes) / 60).toFixed(1)}h unpaid owner time valued at ${(nn(i.ownerEconomicRateCents) / 100).toFixed(2)}/h`)
  }

  const otherDirectCents = nn(i.truckCents) + nn(i.fuelCents) + nn(i.tollsCents) + nn(i.suppliesCents)
  if (otherDirectCents > 0) assumptions.push(`truck/fuel/tolls/supplies ${(otherDirectCents / 100).toFixed(2)}`)

  const directCostBreakEvenCents = cashLaborCents + otherDirectCents
  const overhead = nn(i.overheadCents)
  if (overhead > 0) assumptions.push(`overhead ${(overhead / 100).toFixed(2)}`)

  const cashBreakEvenCents = directCostBreakEvenCents + overhead
  const economicBreakEvenCents = cashBreakEvenCents + ownerEconomicLaborCents

  // Target price solves: price − costs − fee(price) = price × targetMargin
  const targetMarginBp = nn(i.targetMarginBp)
  const feeBp = nn(i.processingFeeBp)
  if (feeBp > 0) assumptions.push(`processing fee ${(feeBp / 100).toFixed(2)}% of price`)
  if (targetMarginBp > 0) assumptions.push(`target margin ${(targetMarginBp / 100).toFixed(1)}%`)

  const denom = 1 - targetMarginBp / 10_000 - feeBp / 10_000
  const targetPriceCents = denom > 0 ? Math.ceil(cashBreakEvenCents / denom) : cashBreakEvenCents

  const feeOnTarget = Math.round((targetPriceCents * feeBp) / 10_000)
  const expectedCashProfitCents = targetPriceCents - cashBreakEvenCents - feeOnTarget
  const expectedEconomicProfitCents = expectedCashProfitCents - ownerEconomicLaborCents

  if (i.taxReserveBp) assumptions.push(`tax reserve ${(nn(i.taxReserveBp) / 100).toFixed(1)}% of profit (not part of break-even)`)
  if (i.businessReserveBp) assumptions.push(`business reserve ${(nn(i.businessReserveBp) / 100).toFixed(1)}% of profit (not part of break-even)`)

  return {
    cashLaborCents,
    ownerEconomicLaborCents,
    otherDirectCents,
    directCostBreakEvenCents,
    cashBreakEvenCents,
    economicBreakEvenCents,
    targetPriceCents,
    expectedCashProfitCents,
    expectedEconomicProfitCents,
    expectedMarginBp: targetPriceCents > 0 ? Math.round((expectedCashProfitCents / targetPriceCents) * 10_000) : null,
    assumptions,
  }
}
