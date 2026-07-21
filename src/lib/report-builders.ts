// ============================================================================
// report-builders.ts — one builder per report type (Stage 3B).
//
// Each builder loads rows through reporting-service and shapes them for both the
// API response and the export. THE SAME builder feeds the screen and the file,
// which is what makes "exported totals match the report" true by construction
// rather than by discipline.
//
// No money arithmetic here — it composes the verified Stage 3 pure services.
// ============================================================================

import type { Role } from './permissions'
import type { ResolvedReportRequest } from './reporting-filters'
import { compareCents } from './reporting-period'
import { revenueForBasis, type AggregateTotals } from './reporting-basis'
import {
  loadMovesReport, loadMarketingReport, loadCustomerReport, loadPricingComparables,
  sortMoveRows, paginate, figuresOf, type MoveReportRow,
} from './reporting-service'
import { formatRoas } from './marketing-profitability'
import { recommendPrice, computeBreakEven } from './pricing-intelligence'
import { financialActionsForMove, dedupeActions } from './action-center-financial'
import type { ReportType } from './report-permissions'

export const REPORT_TYPES: ReportType[] = [
  'overview', 'profit-loss', 'moves', 'revenue-profit', 'variance',
  'marketing', 'customers', 'pricing', 'action-center',
]

export interface BuiltReport {
  data: unknown
  counts: { finalized: number; provisional: number; incomplete: number }
  warnings: string[]
  page?: { page: number; pageSize: number; total: number; totalPages: number }
  /** Flat rows for CSV/XLSX — identical numbers to `data`. */
  exportRows: Record<string, unknown>[]
}

const centsToNum = (c: number | null | undefined) => (c == null ? null : Math.round(c) / 100)
const pct = (bp: number | null | undefined) => (bp == null ? null : Math.round(bp) / 100)
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100

function moveMoney(r: MoveReportRow) {
  const f = figuresOf(r)
  const crewHours = hours(r.actualCrewMinutes)
  return {
    ...f,
    marginBp: f && f.netCollectedRevenueCents > 0
      ? Math.round((f.companyNetProfitCents / f.netCollectedRevenueCents) * 10_000)
      : null,
    revenuePerCrewHourCents: f && crewHours > 0 ? Math.round(f.netCollectedRevenueCents / crewHours) : null,
    profitPerCrewHourCents: f && crewHours > 0 ? Math.round(f.companyNetProfitCents / crewHours) : null,
    crewHours,
  }
}

export async function buildReport(report: ReportType, req: ResolvedReportRequest, role: Role): Promise<BuiltReport> {
  switch (report) {
    case 'overview': return buildOverview(req)
    case 'profit-loss': return buildProfitLoss(req)
    case 'moves': return buildMoves(req)
    case 'revenue-profit': return buildRevenueProfit(req)
    case 'variance': return buildVariance(req)
    case 'marketing': return buildMarketing(req, role)
    case 'customers': return buildCustomers(req)
    case 'pricing': return buildPricing(req)
    case 'action-center': return buildActionCenter(req)
  }
}

// ── Overview ────────────────────────────────────────────────────────────────

async function buildOverview(req: ResolvedReportRequest): Promise<BuiltReport> {
  const current = await loadMovesReport(req)
  const prior = await loadMovesReport({ ...req, period: req.comparePeriod })
  const t = current.totals
  const p = prior.totals

  const metric = (label: string, value: number | null, previous?: number | null, note?: string | null) => ({
    metric: label,
    valueCents: value,
    value: centsToNum(value),
    previousCents: previous ?? null,
    delta: previous != null && value != null ? compareCents(value, previous) : null,
    note: note ?? null,
  })

  const data = {
    metrics: [
      metric('Billed revenue', t.netBilledRevenueCents, p.netBilledRevenueCents),
      metric('Collected revenue', t.netCollectedRevenueCents, p.netCollectedRevenueCents),
      metric('Outstanding balances', t.outstandingBalanceCents, p.outstandingBalanceCents, 'A receivable — never counted as profit or cash.'),
      metric('Direct job costs', t.directJobCostCents, p.directJobCostCents),
      metric('Labor cost', t.crewLaborCents, p.crewLaborCents),
      metric('Cash gross profit', t.cashGrossProfitCents, p.cashGrossProfitCents),
      metric('Unpaid owner labor value', t.ownerEconomicLaborCents, p.ownerEconomicLaborCents, 'Never cash — what the owners’ hours were worth.'),
      metric('Economic profit', t.economicProfitCents, p.economicProfitCents),
      metric('Allocated overhead', t.allocatedOverheadCents, p.allocatedOverheadCents, t.allocatedOverheadCents === 0 ? 'No overhead policy configured — this is GROSS profit, not net.' : null),
      metric('Company net profit', t.companyNetProfitCents, p.companyNetProfitCents),
      metric('Tax reserves', t.taxReserveCents, p.taxReserveCents, 'Planned allocation, not a bank transfer.'),
      metric('Business reserves', t.businessReserveCents, p.businessReserveCents, 'Planned allocation, not a bank transfer.'),
      metric('Distributable profit', t.distributableProfitCents, p.distributableProfitCents),
    ],
    revenueForBasis: centsToNum(revenueForBasis(t, req.basis)),
    marginPct: pct(t.marginBp),
    counts: { finalized: t.finalizedCount, provisional: t.provisionalCount, incomplete: t.unusableCount, moves: t.moveCount },
  }

  const warnings = [...current.warnings]
  if (t.allocatedOverheadCents === 0 && t.moveCount > 0) {
    warnings.push('No overhead has been allocated in this period, so "company net profit" equals gross profit. Configure an overhead method to see true net profit.')
  }

  return {
    data,
    counts: current.counts,
    warnings,
    exportRows: data.metrics.map((m) => ({ metric: m.metric, value: m.value })),
  }
}

// ── Profit & loss ───────────────────────────────────────────────────────────

async function buildProfitLoss(req: ResolvedReportRequest): Promise<BuiltReport> {
  const current = await loadMovesReport(req)
  const prior = await loadMovesReport({ ...req, period: req.comparePeriod })
  const t = current.totals
  const p = prior.totals

  const line = (section: string, label: string, cur: number, prev: number) => {
    const d = compareCents(cur, prev)
    return {
      section, line: label,
      currentCents: cur, current: centsToNum(cur),
      previousCents: prev, previous: centsToNum(prev),
      changeCents: d.changeCents, change: centsToNum(d.changeCents),
      changePct: d.changeBp == null ? null : pct(d.changeBp),
      changeNote: d.note,
    }
  }

  const lines = [
    line('Revenue', 'Net collected revenue', t.netCollectedRevenueCents, p.netCollectedRevenueCents),
    line('Revenue', 'Net billed revenue', t.netBilledRevenueCents, p.netBilledRevenueCents),
    line('Revenue', 'Outstanding balance', t.outstandingBalanceCents, p.outstandingBalanceCents),
    line('Direct costs', 'Crew labor', t.crewLaborCents, p.crewLaborCents),
    line('Direct costs', 'All direct job costs', t.directJobCostCents, p.directJobCostCents),
    line('Gross profit', 'Cash gross profit', t.cashGrossProfitCents, p.cashGrossProfitCents),
    line('Gross profit', 'Owner economic labor value', t.ownerEconomicLaborCents, p.ownerEconomicLaborCents),
    line('Gross profit', 'Economic profit', t.economicProfitCents, p.economicProfitCents),
    line('Overhead', 'Allocated overhead', t.allocatedOverheadCents, p.allocatedOverheadCents),
    line('Net profit', 'Company net profit', t.companyNetProfitCents, p.companyNetProfitCents),
    line('Net profit', 'Economic net profit', t.economicNetProfitCents, p.economicNetProfitCents),
    // EQUITY, not expense — labelled so nobody reads a distribution as a cost.
    line('Allocations below profit (equity activity, NOT expenses)', 'Tax reserve', t.taxReserveCents, p.taxReserveCents),
    line('Allocations below profit (equity activity, NOT expenses)', 'Business reserves', t.businessReserveCents, p.businessReserveCents),
    line('Allocations below profit (equity activity, NOT expenses)', 'Retained earnings', t.retainedEarningsCents, p.retainedEarningsCents),
    line('Allocations below profit (equity activity, NOT expenses)', 'Distributable profit', t.distributableProfitCents, p.distributableProfitCents),
  ]

  return {
    data: {
      lines,
      marginPct: pct(t.marginBp),
      comparePeriodLabel: req.comparePeriod.label,
      disclaimer: 'Internal management report. Not a tax return and not an audited financial statement.',
    },
    counts: current.counts,
    warnings: current.warnings,
    exportRows: lines.map((l) => ({
      section: l.section, line: l.line, currentCents: l.current,
      previousCents: l.previous, changeCents: l.change,
      changePct: l.changePct ?? l.changeNote,
    })),
  }
}

// ── Moves ───────────────────────────────────────────────────────────────────

async function buildMoves(req: ResolvedReportRequest): Promise<BuiltReport> {
  const res = await loadMovesReport(req, { includeVariance: true })
  const sorted = sortMoveRows(res.rows, req.query.sort, req.query.dir)
  const { slice, total, totalPages } = paginate(sorted, req.query.page, req.query.pageSize)

  const shaped = slice.map((r) => {
    const m = moveMoney(r)
    return {
      bookingId: r.bookingId,
      bookingReference: r.bookingReference ?? r.bookingId.slice(0, 8),
      customerName: r.customerName,
      moveDate: r.moveDate?.toISOString() ?? null,
      financialStatus: r.financialStatus,
      status: r.status,
      serviceType: r.serviceType,
      originCity: r.originCity,
      destCity: r.destCity,
      crewSize: r.crewSize,
      actualHours: m.crewHours,
      marketingSource: r.marketingSource,
      attributionInferred: r.attributionInferred,
      isRepeatCustomer: r.isRepeatCustomer,
      netBilledRevenueCents: m.netBilledRevenueCents ?? null,
      netCollectedRevenueCents: m.netCollectedRevenueCents ?? null,
      outstandingBalanceCents: m.outstandingBalanceCents ?? null,
      directJobCostCents: m.directJobCostCents ?? null,
      crewLaborCents: m.crewLaborCents ?? null,
      cashGrossProfitCents: m.cashGrossProfitCents ?? null,
      economicProfitCents: m.economicProfitCents ?? null,
      companyNetProfitCents: m.companyNetProfitCents ?? null,
      marginBp: m.marginBp,
      varianceSeverity: r.variance?.severity ?? null,
      scopeChanged: r.variance?.scopeChanged ?? false,
    }
  })

  return {
    data: { rows: shaped, totals: res.totals },
    counts: res.counts,
    warnings: res.warnings,
    page: { page: req.query.page, pageSize: req.query.pageSize, total, totalPages },
    exportRows: shaped.map((r) => ({
      ...r,
      moveDate: r.moveDate ? r.moveDate.slice(0, 10) : '',
      netBilledRevenueCents: centsToNum(r.netBilledRevenueCents),
      netCollectedRevenueCents: centsToNum(r.netCollectedRevenueCents),
      outstandingBalanceCents: centsToNum(r.outstandingBalanceCents),
      directJobCostCents: centsToNum(r.directJobCostCents),
      crewLaborCents: centsToNum(r.crewLaborCents),
      cashGrossProfitCents: centsToNum(r.cashGrossProfitCents),
      economicProfitCents: centsToNum(r.economicProfitCents),
      companyNetProfitCents: centsToNum(r.companyNetProfitCents),
      marginPct: pct(r.marginBp),
    })),
  }
}

// ── Revenue vs profit ───────────────────────────────────────────────────────

async function buildRevenueProfit(req: ResolvedReportRequest): Promise<BuiltReport> {
  const res = await loadMovesReport(req)
  const rows = res.rows.map((r) => {
    const m = moveMoney(r)
    const alerts: string[] = []
    if (m.companyNetProfitCents != null && m.companyNetProfitCents < 0) alerts.push('Lost money')
    // The case the owner most needs to see: looks fine on cash, negative once
    // the owners' own hours are valued.
    if (m.cashGrossProfitCents != null && m.economicProfitCents != null && m.cashGrossProfitCents > 0 && m.economicProfitCents < 0) {
      alerts.push('Profitable only because the owners worked unpaid')
    }
    if (m.netCollectedRevenueCents != null && m.marginBp != null && m.netCollectedRevenueCents > 100_000 && m.marginBp < 1000) {
      alerts.push('High revenue, thin margin')
    }
    if (r.financialStatus !== 'FINALIZED') alerts.push('Provisional — not closed out')
    return {
      bookingId: r.bookingId,
      bookingReference: r.bookingReference ?? r.bookingId.slice(0, 8),
      customerName: r.customerName,
      financialStatus: r.financialStatus,
      netCollectedRevenueCents: m.netCollectedRevenueCents ?? null,
      directJobCostCents: m.directJobCostCents ?? null,
      cashGrossProfitCents: m.cashGrossProfitCents ?? null,
      economicProfitCents: m.economicProfitCents ?? null,
      marginBp: m.marginBp,
      actualHours: m.crewHours,
      revenuePerCrewHourCents: m.revenuePerCrewHourCents,
      profitPerCrewHourCents: m.profitPerCrewHourCents,
      alerts,
    }
  })
  const sorted = rows.sort((a, b) => (b.netCollectedRevenueCents ?? 0) - (a.netCollectedRevenueCents ?? 0))
  return {
    data: { rows: sorted, totals: res.totals },
    counts: res.counts,
    warnings: res.warnings,
    exportRows: sorted.map((r) => ({
      bookingReference: r.bookingReference, customerName: r.customerName,
      netCollectedRevenueCents: centsToNum(r.netCollectedRevenueCents),
      directJobCostCents: centsToNum(r.directJobCostCents),
      cashGrossProfitCents: centsToNum(r.cashGrossProfitCents),
      economicProfitCents: centsToNum(r.economicProfitCents),
      marginPct: pct(r.marginBp), actualHours: r.actualHours,
      revenuePerCrewHourCents: centsToNum(r.revenuePerCrewHourCents),
      profitPerCrewHourCents: centsToNum(r.profitPerCrewHourCents),
      alert: r.alerts.join('; '),
    })),
  }
}

// ── Variance ────────────────────────────────────────────────────────────────

async function buildVariance(req: ResolvedReportRequest): Promise<BuiltReport> {
  const res = await loadMovesReport(req, { includeVariance: true })
  const withVariance = res.rows.filter((r) => r.variance)
  const rows = withVariance.map((r) => ({
    bookingId: r.bookingId,
    bookingReference: r.bookingReference ?? r.bookingId.slice(0, 8),
    customerName: r.customerName,
    financialStatus: r.financialStatus,
    severity: r.variance!.severity,
    scopeChanged: r.variance!.scopeChanged,
    scopeChangeReasons: r.variance!.scopeChangeReasons,
    insufficientEstimate: r.variance!.insufficientEstimate,
    lines: r.variance!.lines,
    flags: r.variance!.flags,
  }))
  const exportRows = rows.flatMap((r) =>
    r.lines.map((l) => ({
      bookingReference: r.bookingReference,
      customerName: r.customerName,
      metric: l.metric,
      estimated: l.unit === 'cents' ? centsToNum(l.estimated) : l.estimated,
      actual: l.unit === 'cents' ? centsToNum(l.actual) : l.actual,
      variance: l.unit === 'cents' ? centsToNum(l.varianceAbs) : l.varianceAbs,
      variancePct: pct(l.varianceBp) ?? l.note,
      status: l.severity,
      scopeChanged: r.scopeChanged ? r.scopeChangeReasons.join('; ') : '',
    })),
  )
  return { data: { rows }, counts: res.counts, warnings: res.warnings, exportRows }
}

// ── Marketing ───────────────────────────────────────────────────────────────

async function buildMarketing(req: ResolvedReportRequest, _role: Role): Promise<BuiltReport> {
  const { results, counts, warnings } = await loadMarketingReport(req)
  const rows = results.map((r) => ({
    sourceKey: r.sourceKey,
    spendCents: r.spendCents,
    leads: r.funnel.leads,
    quotes: r.funnel.quotes,
    bookings: r.funnel.bookings,
    completedMoves: r.funnel.completedMoves,
    finalizedMoves: r.funnel.finalizedMoves,
    netCollectedRevenueCents: r.money.netCollectedRevenueCents,
    finalizedNetProfitCents: r.money.finalizedNetProfitCents,
    provisionalNetProfitCents: r.money.provisionalNetProfitCents,
    costPerLeadCents: r.costPerLeadCents,
    costPerBookingCents: r.costPerBookingCents,
    revenueRoasBp: r.revenueRoasBp,
    profitRoasBp: r.profitRoasBp,
    revenueRoas: formatRoas(r.revenueRoasBp),
    profitRoas: formatRoas(r.profitRoasBp),
    netOfSpendCents: r.netOfSpendCents,
    profitable: r.profitable,
    caveat: r.caveat,
    // The headline the owner needs: revenue can look great while profit does not.
    verdict: r.profitable === false ? 'UNPROFITABLE' : r.profitable === true ? 'PROFITABLE' : 'NOT PROVEN',
  }))
  const sorted = rows.sort((a, b) => b.netOfSpendCents - a.netOfSpendCents)
  return {
    data: { rows: sorted },
    counts,
    warnings,
    exportRows: sorted.map((r) => ({
      sourceKey: r.sourceKey, spendCents: centsToNum(r.spendCents),
      leads: r.leads, quotes: r.quotes, bookings: r.bookings,
      completedMoves: r.completedMoves, finalizedMoves: r.finalizedMoves,
      netCollectedRevenueCents: centsToNum(r.netCollectedRevenueCents),
      costPerLeadCents: centsToNum(r.costPerLeadCents),
      costPerBookingCents: centsToNum(r.costPerBookingCents),
      revenueRoas: r.revenueRoas,
      finalizedNetProfitCents: centsToNum(r.finalizedNetProfitCents),
      profitRoas: r.profitRoas,
      verdict: r.verdict,
    })),
  }
}

// ── Customers ───────────────────────────────────────────────────────────────

async function buildCustomers(req: ResolvedReportRequest): Promise<BuiltReport> {
  const { rows, counts, warnings } = await loadCustomerReport(req)
  const shaped = rows.map((c) => ({
    customerId: c.customerId,
    customerName: c.customerName,
    moves: c.moves,
    completedMoves: c.completedMoves,
    finalizedMoves: c.finalizedMoves,
    netCollectedRevenueCents: c.totals.netCollectedRevenueCents,
    outstandingBalanceCents: c.totals.outstandingBalanceCents,
    directJobCostCents: c.totals.directJobCostCents,
    companyNetProfitCents: c.totals.companyNetProfitCents,
    marginBp: c.totals.marginBp,
    acquisitionSource: c.acquisitionSource,
    isRepeat: c.isRepeat,
  }))
  // Ranked by PROFIT, never by revenue alone.
  const sorted = shaped.sort((a, b) => b.companyNetProfitCents - a.companyNetProfitCents)
  return {
    data: { rows: sorted },
    counts,
    warnings,
    exportRows: sorted.map((c) => ({
      customerName: c.customerName, moves: c.moves, completedMoves: c.completedMoves,
      finalizedMoves: c.finalizedMoves,
      netCollectedRevenueCents: centsToNum(c.netCollectedRevenueCents),
      outstandingBalanceCents: centsToNum(c.outstandingBalanceCents),
      companyNetProfitCents: centsToNum(c.companyNetProfitCents),
      marginPct: pct(c.marginBp), acquisitionSource: c.acquisitionSource,
      isRepeat: c.isRepeat,
    })),
  }
}

// ── Pricing ─────────────────────────────────────────────────────────────────

async function buildPricing(req: ResolvedReportRequest): Promise<BuiltReport> {
  const comparables = await loadPricingComparables()
  const q = {
    serviceType: req.query.serviceType ?? null,
    city: req.query.city ?? null,
    crewSize: null,
    estimatedMinutes: null,
    stops: null,
  }
  const recommendation = recommendPrice(q, comparables)
  const breakEven = computeBreakEven({
    crewSize: 2, estimatedMinutes: 360, hourlyRateCents: 2500,
    ownerUnpaidMinutes: 0, ownerEconomicRateCents: 3000,
    overheadCents: 0, processingFeeBp: 290, targetMarginBp: 2000,
  })

  const warnings: string[] = []
  if (recommendation.confidence === 'INSUFFICIENT') {
    warnings.push('Not enough finalized comparable moves to recommend a price. Use the break-even figures and judgement.')
  }
  if (breakEven.expectedEconomicProfitCents < 0) {
    warnings.push('At this target margin the move would still lose money once the owners’ unpaid hours are valued. Raise the price or pay the owners.')
  }

  return {
    data: { recommendation, breakEven, comparablePool: comparables.length, quoteApplied: false },
    counts: { finalized: comparables.length, provisional: 0, incomplete: 0 },
    warnings,
    exportRows: [
      { field: 'Confidence', value: recommendation.confidence },
      { field: 'Comparable moves', value: recommendation.comparableCount },
      { field: 'Median price', value: centsToNum(recommendation.medianPriceCents) },
      { field: 'Median direct cost', value: centsToNum(recommendation.medianDirectCostCents) },
      { field: 'Break-even price', value: centsToNum(recommendation.breakEvenPriceCents) },
      { field: 'Suggested low', value: centsToNum(recommendation.suggestedRange?.lowCents ?? null) },
      { field: 'Suggested high', value: centsToNum(recommendation.suggestedRange?.highCents ?? null) },
      { field: 'Cash break-even', value: centsToNum(breakEven.cashBreakEvenCents) },
      { field: 'Economic break-even', value: centsToNum(breakEven.economicBreakEvenCents) },
      ...recommendation.assumptions.map((a) => ({ field: 'Assumption', value: a })),
      ...recommendation.caveats.map((c) => ({ field: 'Caveat', value: c })),
    ],
  }
}

// ── Action Center ───────────────────────────────────────────────────────────

async function buildActionCenter(req: ResolvedReportRequest): Promise<BuiltReport> {
  const res = await loadMovesReport(req)
  const now = new Date()
  const candidates = res.rows.flatMap((r) => {
    const f = figuresOf(r)
    return financialActionsForMove({
      bookingId: r.bookingId,
      bookingReference: r.bookingReference,
      customerName: r.customerName,
      status: r.status,
      completedAt: r.moveDate,
      isFinalized: r.isFinalized,
      blockerCodes: [],
      overriddenCodes: [],
      canFinalize: false,
      submittedForReview: false,
      companyNetProfitCents: f?.companyNetProfitCents ?? null,
      marginBp: f && f.netCollectedRevenueCents > 0
        ? Math.round((f.companyNetProfitCents / f.netCollectedRevenueCents) * 10_000) : null,
      outstandingBalanceCents: f?.outstandingBalanceCents ?? 0,
      unpaidLaborCents: 0,
      ownerReimbursementOwedCents: 0,
      pendingDistributionCents: 0,
      estimateSeverity: r.variance?.severity ?? null,
      marketingSourceUnknown: ['UNKNOWN', 'DIRECT'].includes(r.marketingSource),
      targetMarginBp: 2000,
      closeoutGraceDays: 3,
      now,
    })
  })
  const actions = dedupeActions(candidates)
  return {
    data: { actions },
    counts: res.counts,
    warnings: res.warnings,
    exportRows: actions.map((a) => ({
      severity: a.severity, rule: a.rule, title: a.title,
      description: a.description, category: a.category, sourceUrl: a.sourceUrl,
    })),
  }
}
