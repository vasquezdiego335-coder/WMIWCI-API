// ============================================================================
// estimate-variance.ts — did the move go the way we quoted it? (Stage 3).
//
// Feeds two things: the estimate-vs-actual report, and the pricing intelligence
// that learns what similar moves really cost.
//
// FAIRNESS RULE: an estimate is not "inaccurate" when the SCOPE changed after
// booking. A customer who added a second stop did not expose a bad estimate —
// they bought a different move. Scope changes are surfaced alongside the
// variance so the owner reads the right lesson.
//
// Pure functions, integer cents / minutes, offline-tested.
// ============================================================================

export type VarianceSeverity = 'OK' | 'NOTICE' | 'WARNING'

export interface VarianceThresholds {
  /** Basis points of the estimate before a variance is a NOTICE / WARNING. */
  noticeBp: number
  warningBp: number
  /** Margin below which a move is flagged regardless of variance. */
  targetMarginBp: number
}

export const DEFAULT_THRESHOLDS: VarianceThresholds = {
  noticeBp: 1500, // 15%
  warningBp: 3000, // 30%
  targetMarginBp: 2000, // 20%
}

export interface VarianceLine {
  metric: string
  estimated: number | null
  actual: number | null
  varianceAbs: number | null
  /** Basis points of the estimate. Null when there is no estimate to compare. */
  varianceBp: number | null
  severity: VarianceSeverity
  /** Present when the metric could not be compared. */
  note: string | null
  unit: 'cents' | 'minutes' | 'count' | 'bp'
}

export interface VarianceInput {
  estimatedPriceCents?: number | null
  actualBilledCents?: number | null
  estimatedMinutes?: number | null
  actualMinutes?: number | null
  estimatedCrewMinutes?: number | null
  actualCrewMinutes?: number | null
  estimatedLaborCents?: number | null
  actualLaborCents?: number | null
  estimatedTruckCents?: number | null
  actualTruckCents?: number | null
  estimatedExpenseCents?: number | null
  actualExpenseCents?: number | null
  actualGrossProfitCents?: number | null
  actualNetProfitCents?: number | null
  actualMarginBp?: number | null
  // scope signals
  estimatedStops?: number | null
  actualStops?: number | null
  addedHeavyItems?: boolean | null
  addedStairs?: boolean | null
  scopeChangeNotes?: string | null
}

export interface VarianceReport {
  lines: VarianceLine[]
  flags: { code: string; message: string; severity: VarianceSeverity }[]
  /** True when something material changed after booking. */
  scopeChanged: boolean
  scopeChangeReasons: string[]
  /** Overall verdict, ignoring metrics that could not be compared. */
  severity: VarianceSeverity
  /** True when there was not enough estimate data to judge anything. */
  insufficientEstimate: boolean
}

function line(metric: string, estimated: number | null | undefined, actual: number | null | undefined, unit: VarianceLine['unit'], th: VarianceThresholds): VarianceLine {
  const e = estimated ?? null
  const a = actual ?? null
  if (e == null || a == null) {
    return {
      metric, estimated: e, actual: a, varianceAbs: null, varianceBp: null,
      severity: 'OK', unit,
      note: e == null ? 'No estimate recorded' : 'No actual recorded',
    }
  }
  if (e === 0) {
    return {
      metric, estimated: e, actual: a, varianceAbs: a, varianceBp: null,
      severity: a > 0 ? 'NOTICE' : 'OK', unit,
      note: a > 0 ? 'Nothing was estimated for this' : null,
    }
  }
  const varianceAbs = a - e
  const varianceBp = Math.round((varianceAbs / Math.abs(e)) * 10_000)
  const mag = Math.abs(varianceBp)
  const severity: VarianceSeverity = mag >= th.warningBp ? 'WARNING' : mag >= th.noticeBp ? 'NOTICE' : 'OK'
  return { metric, estimated: e, actual: a, varianceAbs, varianceBp, severity, note: null, unit }
}

/**
 * Compare estimate to actual across every metric we can.
 *
 * Metrics with no estimate are reported as "No estimate recorded" rather than
 * shown as a 100% miss — the absence of an estimate is a data-quality problem,
 * not an estimating failure.
 */
export function computeVariance(input: VarianceInput, th: VarianceThresholds = DEFAULT_THRESHOLDS): VarianceReport {
  const lines: VarianceLine[] = [
    line('Customer price', input.estimatedPriceCents, input.actualBilledCents, 'cents', th),
    line('Duration', input.estimatedMinutes, input.actualMinutes, 'minutes', th),
    line('Crew hours', input.estimatedCrewMinutes, input.actualCrewMinutes, 'minutes', th),
    line('Labor cost', input.estimatedLaborCents, input.actualLaborCents, 'cents', th),
    line('Truck cost', input.estimatedTruckCents, input.actualTruckCents, 'cents', th),
    line('Direct expenses', input.estimatedExpenseCents, input.actualExpenseCents, 'cents', th),
  ]

  // ── Scope change detection ──
  const scopeChangeReasons: string[] = []
  if (input.estimatedStops != null && input.actualStops != null && input.actualStops > input.estimatedStops) {
    scopeChangeReasons.push(`${input.actualStops - input.estimatedStops} more stop(s) than quoted`)
  }
  if (input.addedHeavyItems) scopeChangeReasons.push('heavy items added after booking')
  if (input.addedStairs) scopeChangeReasons.push('stairs added after booking')
  if (input.scopeChangeNotes?.trim()) scopeChangeReasons.push(input.scopeChangeNotes.trim())
  const scopeChanged = scopeChangeReasons.length > 0

  const flags: VarianceReport['flags'] = []
  const at = (m: string) => lines.find((l) => l.metric === m)

  const dur = at('Duration')
  if (dur?.varianceBp != null && dur.varianceBp >= th.noticeBp) {
    flags.push({ code: 'RAN_LONG', message: `The move ran ${(dur.varianceBp / 100).toFixed(0)}% longer than estimated.`, severity: dur.severity })
  }
  const crew = at('Crew hours')
  if (crew?.varianceBp != null && crew.varianceBp >= th.noticeBp) {
    flags.push({ code: 'CREW_HOURS_OVER', message: `Crew hours exceeded the estimate by ${(crew.varianceBp / 100).toFixed(0)}%.`, severity: crew.severity })
  }
  const truck = at('Truck cost')
  if (truck?.varianceBp != null && truck.varianceBp >= th.noticeBp) {
    flags.push({ code: 'TRUCK_COST_OVER', message: `Truck cost exceeded the estimate by ${(truck.varianceBp / 100).toFixed(0)}%.`, severity: truck.severity })
  }
  if (input.estimatedStops != null && input.actualStops != null && input.actualStops > input.estimatedStops) {
    const priceLine = at('Customer price')
    if (!priceLine?.varianceBp || priceLine.varianceBp <= 0) {
      flags.push({ code: 'EXTRA_STOPS_UNBILLED', message: 'Extra stops were worked but the customer price did not increase.', severity: 'WARNING' })
    }
  }
  if (input.addedStairs && (at('Labor cost')?.varianceBp ?? 0) >= th.noticeBp) {
    flags.push({ code: 'STAIRS_UNDERPRICED', message: 'Stairs were added and labor ran over — stair pricing may be too low.', severity: 'NOTICE' })
  }
  if (input.addedHeavyItems && (at('Labor cost')?.varianceBp ?? 0) >= th.noticeBp) {
    flags.push({ code: 'HEAVY_ITEMS_UNDERPRICED', message: 'Heavy items were added and labor ran over — heavy-item pricing may be too low.', severity: 'NOTICE' })
  }
  if (input.actualMarginBp != null && input.actualMarginBp < th.targetMarginBp) {
    flags.push({
      code: input.actualMarginBp < 0 ? 'MOVE_LOST_MONEY' : 'MARGIN_BELOW_TARGET',
      message: input.actualMarginBp < 0
        ? `This move lost money (${(input.actualMarginBp / 100).toFixed(1)}% margin).`
        : `Margin ${(input.actualMarginBp / 100).toFixed(1)}% is below the ${(th.targetMarginBp / 100).toFixed(0)}% target.`,
      severity: input.actualMarginBp < 0 ? 'WARNING' : 'NOTICE',
    })
  }
  // Over-quoting is worth knowing too: it loses jobs.
  const price = at('Customer price')
  if (price?.varianceBp != null && price.varianceBp <= -th.warningBp) {
    flags.push({ code: 'QUOTED_HIGH', message: 'The final price came in well under the quote — the estimate may be too high for this move type.', severity: 'NOTICE' })
  }

  const missing = lines.filter((l) => l.note === 'No estimate recorded')
  const insufficientEstimate = missing.length >= 4
  if (missing.length > 0) {
    flags.push({
      code: 'ESTIMATE_FIELDS_MISSING',
      message: `${missing.length} estimate field${missing.length === 1 ? '' : 's'} were never recorded (${missing.map((l) => l.metric.toLowerCase()).join(', ')}).`,
      severity: insufficientEstimate ? 'WARNING' : 'NOTICE',
    })
  }
  if (scopeChanged) {
    flags.push({
      code: 'SCOPE_CHANGED',
      message: `Scope changed after booking: ${scopeChangeReasons.join('; ')}. Judge the estimate against the original scope.`,
      severity: 'NOTICE',
    })
  }

  const severity: VarianceSeverity = flags.some((f) => f.severity === 'WARNING')
    ? 'WARNING'
    : flags.some((f) => f.severity === 'NOTICE') ? 'NOTICE' : 'OK'

  return { lines, flags, scopeChanged, scopeChangeReasons, severity, insufficientEstimate }
}

/** True when this move is a fair teacher for pricing intelligence: finalized,
 *  estimated, and not distorted by a post-booking scope change. */
export function isPricingComparable(v: VarianceReport, isFinalized: boolean): boolean {
  return isFinalized && !v.insufficientEstimate && !v.scopeChanged
}
