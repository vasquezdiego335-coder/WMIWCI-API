// ============================================================================
// reporting-service.ts — the ONLY module that reads the database for reports
// (Stage 3B, owner spec 2026-07-20).
//
// It is a BRIDGE, not a calculator: it loads rows and hands them to the verified
// Stage 3 pure services. No money arithmetic lives here, so the reporting
// numbers cannot drift from the ones the unit tests pin.
//
// QUERY STRATEGY (documented per spec §30):
//  • SNAPSHOT AGGREGATION for finalized moves — reads the immutable
//    FinancialSnapshot, never recalculates.
//  • APPLICATION AGGREGATION for provisional moves — the Stage 2 closeout math
//    runs per move, bounded by the period and a hard row cap.
//  • DATABASE AGGREGATION for counts and marketing spend (groupBy/_sum).
//  • No caching. Every figure is computed from current rows so a report can
//    never serve a stale total.
// ============================================================================

import { prisma } from './db'
import { periodWhere, type Period } from './reporting-period'
import {
  aggregateMoves, type AggregateTotals, type MoveFinancialRow, type ReportScope,
} from './reporting-basis'
import { buildCloseoutView } from './closeout-service'
import { scoreMarketingSource, resolveAttribution, type AttributionModel, type MarketingResult } from './marketing-profitability'
import { computeVariance, type VarianceReport } from './estimate-variance'
import type { ComparableMove } from './pricing-intelligence'
import type { ResolvedReportRequest } from './reporting-filters'

/** Hard ceiling on provisional recomputation per request. Beyond this the
 *  report reports the truncation rather than silently taking minutes. */
export const MAX_PROVISIONAL_RECOMPUTE = 300
/** Hard ceiling on rows scanned for any single report. */
export const MAX_REPORT_ROWS = 5_000

export interface MoveReportRow extends MoveFinancialRow {
  bookingReference: string | null
  customerId: string
  customerName: string
  moveDate: Date | null
  status: string
  originCity: string | null
  destCity: string | null
  serviceType: string | null
  crewSize: number
  actualCrewMinutes: number
  marketingSource: string
  marketingCampaign: string | null
  attributionInferred: boolean
  isRepeatCustomer: boolean
  financialStatus: 'FINALIZED' | 'PROVISIONAL' | 'NOT_STARTED'
  /** Present only when the caller asked for variance. */
  variance?: VarianceReport | null
}

export interface MovesReportResult {
  rows: MoveReportRow[]
  totals: AggregateTotals
  counts: { finalized: number; provisional: number; incomplete: number }
  truncated: boolean
  warnings: string[]
}

/** The move columns every report needs. One select, so no page can drop a field. */
const MOVE_SELECT = {
  id: true,
  bookingReference: true,
  status: true,
  customerId: true,
  totalEstimate: true,
  estimatedHours: true,
  completedAt: true,
  confirmedDate: true,
  scheduledStart: true,
  originCity: true,
  destCity: true,
  itemsDescription: true,
  source: true,
  foundUs: true,
  firstTouchSource: true,
  firstTouchCampaign: true,
  lastTouchSource: true,
  lastTouchCampaign: true,
  bookingSource: true,
  bookingCampaign: true,
  ownerAssignedSource: true,
  customer: { select: { id: true, name: true } },
  closeout: {
    select: {
      status: true,
      snapshots: {
        where: { supersededAt: null },
        orderBy: { version: 'desc' as const },
        take: 1,
      },
    },
  },
  job: { select: { crew: { select: { id: true, paidMinutes: true, workedMinutes: true, assignmentStatus: true } } } },
} as const

/** Owner allocations off a snapshot's JSON column, defensively. A malformed or
 *  absent value reads as "nothing was allocated", never as a guess. */
function ownerAllocationsOf(raw: unknown): { owner: string; amountCents: number; percentBp: number }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is { owner: string; amountCents: number; percentBp?: number } =>
      !!v && typeof v === 'object' &&
      typeof (v as { owner?: unknown }).owner === 'string' &&
      typeof (v as { amountCents?: unknown }).amountCents === 'number')
    .map((v) => ({ owner: v.owner, amountCents: v.amountCents, percentBp: v.percentBp ?? 0 }))
}

/** The date a move belongs to for reporting: when it was actually worked. */
const moveDateOf = (b: { completedAt: Date | null; scheduledStart: Date | null; confirmedDate: Date | null }): Date | null =>
  b.completedAt ?? b.scheduledStart ?? b.confirmedDate

/**
 * Load the moves for a period and produce report rows + totals.
 *
 * Finalized moves read their snapshot. Provisional moves are recomputed with the
 * Stage 2 closeout math, bounded — beyond the cap the result is marked truncated
 * rather than quietly wrong.
 */
export async function loadMovesReport(
  req: ResolvedReportRequest,
  opts: { includeVariance?: boolean; attribution?: AttributionModel } = {},
): Promise<MovesReportResult> {
  const { period, scope, query } = req

  const where: Record<string, unknown> = {
    isInternalTest: false,
    status: { in: ['IN_PROGRESS', 'COMPLETED'] },
    OR: [
      { completedAt: periodWhere(period) },
      { AND: [{ completedAt: null }, { scheduledStart: periodWhere(period) }] },
    ],
  }
  if (query.city) where.originCity = query.city
  if (query.customerId) where.customerId = query.customerId
  if (query.source) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ ownerAssignedSource: query.source }, { bookingSource: query.source }, { source: query.source }, { firstTouchSource: query.source }] },
    ]
  }

  const bookings = await prisma.booking.findMany({
    where: where as never,
    select: MOVE_SELECT,
    orderBy: [{ completedAt: 'desc' }, { scheduledStart: 'desc' }],
    take: MAX_REPORT_ROWS,
  })

  // Repeat-customer detection in ONE query rather than per row (no N+1).
  const customerIds = Array.from(new Set(bookings.map((b) => b.customerId)))
  const priorCounts = customerIds.length
    ? await prisma.booking.groupBy({
        by: ['customerId'],
        where: { customerId: { in: customerIds }, status: 'COMPLETED', isInternalTest: false },
        _count: { _all: true },
      })
    : []
  const completedByCustomer = new Map(priorCounts.map((r) => [r.customerId, r._count._all]))

  const warnings: string[] = []
  let truncated = false
  let provisionalRecomputed = 0
  const rows: MoveReportRow[] = []

  for (const b of bookings) {
    const snap = b.closeout?.snapshots?.[0] ?? null
    const isFinalized = b.closeout?.status === 'FINALIZED' && !!snap

    const attribution = resolveAttribution(
      {
        firstTouchSource: b.firstTouchSource ?? b.source ?? b.foundUs,
        firstTouchCampaign: b.firstTouchCampaign,
        lastTouchSource: b.lastTouchSource,
        lastTouchCampaign: b.lastTouchCampaign,
        bookingSource: b.bookingSource,
        bookingCampaign: b.bookingCampaign,
        ownerAssignedSource: b.ownerAssignedSource,
      },
      opts.attribution ?? 'BOOKING',
    )

    const crew = b.job?.crew ?? []
    const liveCrew = crew.filter((c) => !['CANCELLED', 'DECLINED', 'NO_SHOW'].includes(String(c.assignmentStatus)))
    const actualCrewMinutes = liveCrew.reduce((s, c) => s + (c.paidMinutes ?? c.workedMinutes ?? 0), 0)

    let figures: MoveFinancialRow['snapshot'] = null
    let provisional: MoveFinancialRow['snapshot'] = null

    if (isFinalized && snap) {
      // SNAPSHOT AGGREGATION — never recalculated.
      figures = {
        netBilledRevenueCents: snap.netBilledRevenueCents,
        netCollectedRevenueCents: snap.netCollectedRevenueCents,
        outstandingBalanceCents: snap.outstandingBalanceCents,
        directJobCostCents: snap.directJobCostCents,
        crewLaborCents: snap.crewLaborCents,
        ownerEconomicLaborCents: snap.ownerEconomicLaborCents,
        allocatedOverheadCents: snap.allocatedOverheadCents,
        cashGrossProfitCents: snap.cashGrossProfitCents,
        economicProfitCents: snap.economicProfitCents,
        companyNetProfitCents: snap.companyNetProfitCents,
        economicNetProfitCents: snap.economicNetProfitCents,
        taxReserveCents: snap.taxReserveCents,
        businessReserveCents: snap.businessReserveCents,
        retainedEarningsCents: snap.retainedEarningsCents,
        distributableProfitCents: snap.distributableProfitCents,
        // The 40/30/30 allocation, read from the FROZEN snapshot. Changing the
        // retained share or the owner split today cannot move these.
        businessRetainedCents: snap.businessRetainedCents,
        businessRetainedBp: snap.businessRetainedBp,
        roundingRemainderCents: snap.roundingRemainderCents,
        ownerAllocations: ownerAllocationsOf(snap.ownerAllocations),
      }
    } else if (scope !== 'FINALIZED_ONLY') {
      // APPLICATION AGGREGATION — bounded.
      if (provisionalRecomputed >= MAX_PROVISIONAL_RECOMPUTE) {
        truncated = true
      } else {
        provisionalRecomputed++
        const view = await buildCloseoutView(b.id).catch(() => null)
        if (view) {
          const f = view.financials
          provisional = {
            netBilledRevenueCents: f.netBilledRevenueCents,
            netCollectedRevenueCents: f.netCollectedRevenueCents,
            outstandingBalanceCents: f.outstandingBalanceCents,
            directJobCostCents: f.directJobCostCents,
            crewLaborCents: f.crewLaborCents,
            ownerEconomicLaborCents: f.ownerEconomicLaborCents,
            allocatedOverheadCents: f.overhead.amountCents,
            cashGrossProfitCents: f.profit.cashGrossProfitCents,
            economicProfitCents: f.profit.economicProfitCents,
            companyNetProfitCents: f.profit.companyNetProfitCents,
            economicNetProfitCents: f.profit.economicNetProfitCents,
            taxReserveCents: f.reserves.taxReserveCents,
            businessReserveCents: f.reserves.businessReserveCents,
            retainedEarningsCents: f.reserves.retainedEarningsCents,
            distributableProfitCents: f.reserves.distributableProfitCents,
            // Live allocation. Labelled PROVISIONAL by the row's
            // financialStatus, and it may still change at closeout.
            businessRetainedCents: view.allocation.businessRetainedCents,
            businessRetainedBp: view.allocation.businessRetainedBp,
            roundingRemainderCents: view.allocation.roundingRemainderCents,
            ownerAllocations: view.allocation.lines
              .filter((l) => !l.isBusiness)
              .map((l) => ({
                owner: l.label.replace(/ allocation$/i, '').toUpperCase(),
                amountCents: l.amountCents,
                percentBp: l.ofNetProfitBp,
              })),
          }
        }
      }
    }

    const used = isFinalized ? figures : provisional
    const serviceType = extractService(b.itemsDescription)

    let variance: VarianceReport | null = null
    if (opts.includeVariance && used) {
      variance = computeVariance({
        estimatedPriceCents: b.totalEstimate != null ? Math.round(b.totalEstimate * 100) : null,
        actualBilledCents: used.netBilledRevenueCents,
        estimatedMinutes: b.estimatedHours != null ? Math.round(b.estimatedHours * 60) : null,
        actualMinutes: actualCrewMinutes > 0 && liveCrew.length > 0 ? Math.round(actualCrewMinutes / liveCrew.length) : null,
        estimatedCrewMinutes: b.estimatedHours != null ? Math.round(b.estimatedHours * 60) * Math.max(1, liveCrew.length) : null,
        actualCrewMinutes: actualCrewMinutes || null,
        actualLaborCents: used.crewLaborCents,
        actualExpenseCents: used.directJobCostCents - used.crewLaborCents,
        actualGrossProfitCents: used.cashGrossProfitCents,
        actualNetProfitCents: used.companyNetProfitCents,
        actualMarginBp: used.netCollectedRevenueCents > 0
          ? Math.round((used.companyNetProfitCents / used.netCollectedRevenueCents) * 10_000)
          : null,
      })
    }

    rows.push({
      bookingId: b.id,
      bookingReference: b.bookingReference,
      customerId: b.customerId,
      customerName: b.customer.name,
      moveDate: moveDateOf(b),
      status: b.status,
      originCity: b.originCity,
      destCity: b.destCity,
      serviceType,
      crewSize: liveCrew.length,
      actualCrewMinutes,
      marketingSource: attribution.source,
      marketingCampaign: attribution.campaign,
      attributionInferred: attribution.inferred,
      isRepeatCustomer: (completedByCustomer.get(b.customerId) ?? 0) > 1,
      isFinalized,
      snapshot: figures,
      provisional,
      financialStatus: isFinalized ? 'FINALIZED' : used ? 'PROVISIONAL' : 'NOT_STARTED',
      variance,
    })
  }

  if (bookings.length >= MAX_REPORT_ROWS) {
    truncated = true
    warnings.push(`Only the first ${MAX_REPORT_ROWS.toLocaleString()} moves were read. Narrow the period.`)
  }
  if (truncated && provisionalRecomputed >= MAX_PROVISIONAL_RECOMPUTE) {
    warnings.push(`Provisional figures were computed for the first ${MAX_PROVISIONAL_RECOMPUTE} unclosed moves only.`)
  }

  const filtered = applyRowFilters(rows, req)
  const totals = aggregateMoves(filtered, scope)

  return {
    rows: filtered,
    totals,
    counts: {
      finalized: totals.finalizedCount,
      provisional: totals.provisionalCount,
      incomplete: totals.unusableCount,
    },
    truncated,
    warnings,
  }
}

/** Filters that need computed money, applied after figures are resolved. */
function applyRowFilters(rows: MoveReportRow[], req: ResolvedReportRequest): MoveReportRow[] {
  const { query, scope } = req
  return rows.filter((r) => {
    const f = r.isFinalized ? r.snapshot : r.provisional
    if (query.profitability && f) {
      const p = f.companyNetProfitCents
      if (query.profitability === 'profitable' && p <= 0) return false
      if (query.profitability === 'loss' && p >= 0) return false
      if (query.profitability === 'break_even' && p !== 0) return false
    }
    if (query.flag === 'missing_closeout' && r.financialStatus === 'FINALIZED') return false
    if (query.flag === 'outstanding_balance' && (f?.outstandingBalanceCents ?? 0) <= 0) return false
    if (query.flag === 'missing_labor' && (f?.crewLaborCents ?? 0) > 0) return false
    if (query.flag === 'scope_changed' && !r.variance?.scopeChanged) return false
    if (query.flag === 'estimate_missed' && r.variance?.severity !== 'WARNING') return false
    if (query.serviceType && r.serviceType !== query.serviceType) return false
    if (scope === 'FINALIZED_ONLY' && !r.isFinalized) return false
    if (scope === 'PROVISIONAL_ONLY' && r.isFinalized) return false
    return true
  })
}

/** Service type lives inside the itemsDescription blob today. */
function extractService(blob: string | null): string | null {
  if (!blob) return null
  const line = blob.split('\n').find((l) => l.trim().toLowerCase().startsWith('service'))
  if (!line) return null
  const i = line.indexOf(': ')
  return i > 0 ? line.slice(i + 2).trim() : null
}

// ── Sorting ─────────────────────────────────────────────────────────────────

const SORTABLE: Record<string, (r: MoveReportRow) => number> = {
  revenue: (r) => figuresOf(r)?.netCollectedRevenueCents ?? 0,
  profit: (r) => figuresOf(r)?.companyNetProfitCents ?? 0,
  margin: (r) => {
    const f = figuresOf(r)
    return f && f.netCollectedRevenueCents > 0 ? (f.companyNetProfitCents / f.netCollectedRevenueCents) * 10_000 : 0
  },
  labor: (r) => figuresOf(r)?.crewLaborCents ?? 0,
  hours: (r) => r.actualCrewMinutes,
  outstanding: (r) => figuresOf(r)?.outstandingBalanceCents ?? 0,
  variance: (r) => Math.abs(r.variance?.lines.find((l) => l.metric === 'Duration')?.varianceBp ?? 0),
  date: (r) => r.moveDate?.getTime() ?? 0,
}

export const figuresOf = (r: MoveReportRow): MoveFinancialRow['snapshot'] => (r.isFinalized ? r.snapshot : r.provisional)

export function sortMoveRows(rows: MoveReportRow[], sort: string | undefined, dir: 'asc' | 'desc'): MoveReportRow[] {
  const key = sort && SORTABLE[sort] ? sort : 'date'
  const get = SORTABLE[key]
  const sorted = [...rows].sort((a, b) => get(a) - get(b))
  return dir === 'desc' ? sorted.reverse() : sorted
}

export function paginate<T>(rows: T[], page: number, pageSize: number): { slice: T[]; total: number; totalPages: number } {
  const total = rows.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const p = Math.min(page, totalPages)
  return { slice: rows.slice((p - 1) * pageSize, p * pageSize), total, totalPages }
}

// ── Marketing ───────────────────────────────────────────────────────────────

/** What one marketing source contributed to the 40/30/30 allocation. */
export interface SourceAllocation {
  companyNetProfitCents: number
  businessRetainedCents: number
  roundingRemainderCents: number
  distributableProfitCents: number
  ownerAllocationCents: Record<string, number>
  /** FINALIZED only when every attributed move is finalized. */
  allFinalized: boolean
}

export async function loadMarketingReport(req: ResolvedReportRequest, model: AttributionModel = 'BOOKING'): Promise<{ results: MarketingResult[]; allocations: Record<string, SourceAllocation>; counts: { finalized: number; provisional: number; incomplete: number }; warnings: string[] }> {
  const moves = await loadMovesReport(req, { attribution: model })

  const campaigns = await prisma.marketingCampaign.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] } },
    select: { id: true, name: true, sourceKey: true, spend: { select: { amountCents: true, incurredOn: true } } },
  })

  // Spend is period-bounded so a campaign is judged on the money spent in the
  // window being reported.
  const spendBySource = new Map<string, number>()
  for (const c of campaigns) {
    const total = c.spend
      .filter((s) => s.incurredOn >= req.period.start && s.incurredOn < req.period.end)
      .reduce((sum, s) => sum + s.amountCents, 0)
    spendBySource.set(c.sourceKey, (spendBySource.get(c.sourceKey) ?? 0) + total)
  }

  const bySource = new Map<string, { leads: number; quotes: number; bookings: number; completed: number; finalized: number; revenue: number; finalProfit: number; provProfit: number; cost: number }>()
  const bump = (k: string) => {
    if (!bySource.has(k)) bySource.set(k, { leads: 0, quotes: 0, bookings: 0, completed: 0, finalized: 0, revenue: 0, finalProfit: 0, provProfit: 0, cost: 0 })
    return bySource.get(k)!
  }

  // The 40/30/30 allocation attributable to each source, accumulated from the
  // same figures as the profit above — frozen values for finalized moves, live
  // for provisional ones.
  const allocations: Record<string, SourceAllocation> = {}
  const bumpAllocation = (k: string): SourceAllocation => {
    if (!allocations[k]) {
      allocations[k] = {
        companyNetProfitCents: 0, businessRetainedCents: 0, roundingRemainderCents: 0,
        distributableProfitCents: 0, ownerAllocationCents: {}, allFinalized: true,
      }
    }
    return allocations[k]
  }

  for (const r of moves.rows) {
    const e = bump(r.marketingSource)
    e.bookings++
    if (r.status === 'COMPLETED') e.completed++
    const f = figuresOf(r)
    if (!f) continue
    e.revenue += f.netCollectedRevenueCents
    e.cost += f.directJobCostCents
    if (r.isFinalized) { e.finalized++; e.finalProfit += f.companyNetProfitCents }
    else e.provProfit += f.companyNetProfitCents

    const a = bumpAllocation(r.marketingSource)
    a.companyNetProfitCents += f.companyNetProfitCents
    a.businessRetainedCents += f.businessRetainedCents ?? 0
    a.roundingRemainderCents += f.roundingRemainderCents ?? 0
    a.distributableProfitCents += f.distributableProfitCents
    for (const share of f.ownerAllocations ?? []) {
      a.ownerAllocationCents[share.owner] = (a.ownerAllocationCents[share.owner] ?? 0) + share.amountCents
    }
    if (!r.isFinalized) a.allFinalized = false
  }

  // Leads by source (DATABASE AGGREGATION).
  const leadGroups = await prisma.lead.groupBy({
    by: ['source'],
    where: { createdAt: periodWhere(req.period) },
    _count: { _all: true },
  }).catch(() => [] as { source: string | null; _count: { _all: number } }[])
  for (const g of leadGroups) bump(String(g.source ?? 'UNKNOWN')).leads += g._count._all

  for (const key of Array.from(spendBySource.keys())) bump(key)

  const results = Array.from(bySource.entries()).map(([sourceKey, e]) =>
    scoreMarketingSource({
      sourceKey,
      spend: { totalSpendCents: spendBySource.get(sourceKey) ?? 0 },
      funnel: { leads: e.leads, quotes: e.quotes || e.bookings, bookings: e.bookings, completedMoves: e.completed, finalizedMoves: e.finalized },
      money: {
        netCollectedRevenueCents: e.revenue,
        finalizedNetProfitCents: e.finalProfit,
        provisionalNetProfitCents: e.provProfit,
        directCostCents: e.cost,
      },
    }),
  )

  return { results, allocations, counts: moves.counts, warnings: moves.warnings }
}

// ── Pricing comparables ─────────────────────────────────────────────────────

/** FINALIZED moves only — a provisional move has not proven what it cost. */
export async function loadPricingComparables(limit = 400): Promise<ComparableMove[]> {
  const snaps = await prisma.financialSnapshot.findMany({
    where: { supersededAt: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      bookingId: true, netCollectedRevenueCents: true, directJobCostCents: true,
      crewLaborCents: true, companyNetProfitCents: true, marginBp: true,
    },
  })
  if (snaps.length === 0) return []

  const bookings = await prisma.booking.findMany({
    where: { id: { in: snaps.map((s) => s.bookingId) } },
    select: {
      id: true, itemsDescription: true, originCity: true, destCity: true,
      originStairCount: true, destStairCount: true, hasPiano: true, hasSafe: true,
      hasPoolTable: true, truckProvider: true, destState: true,
      job: { select: { crew: { select: { paidMinutes: true, assignmentStatus: true } } } },
    },
  })
  const byId = new Map(bookings.map((b) => [b.id, b]))

  return snaps.map((s) => {
    const b = byId.get(s.bookingId)
    const crew = (b?.job?.crew ?? []).filter((c) => !['CANCELLED', 'DECLINED', 'NO_SHOW'].includes(String(c.assignmentStatus)))
    const totalMinutes = crew.reduce((sum, c) => sum + (c.paidMinutes ?? 0), 0)
    return {
      bookingId: s.bookingId,
      serviceType: extractService(b?.itemsDescription ?? null),
      crewSize: crew.length || null,
      actualMinutes: crew.length ? Math.round(totalMinutes / crew.length) : null,
      stops: null,
      originCity: b?.originCity ?? null,
      destCity: b?.destCity ?? null,
      stairs: (b?.originStairCount ?? 0) > 0 || (b?.destStairCount ?? 0) > 0,
      heavyItems: !!(b?.hasPiano || b?.hasSafe || b?.hasPoolTable),
      truckSource: b?.truckProvider ?? null,
      outOfState: b?.destState != null && b.destState !== 'NJ',
      netCollectedRevenueCents: s.netCollectedRevenueCents,
      directJobCostCents: s.directJobCostCents,
      crewLaborCents: s.crewLaborCents,
      companyNetProfitCents: s.companyNetProfitCents,
      marginBp: s.marginBp,
    }
  })
}

// ── Customers ───────────────────────────────────────────────────────────────

export interface CustomerReportRow {
  customerId: string
  customerName: string
  moves: number
  completedMoves: number
  finalizedMoves: number
  totals: AggregateTotals
  acquisitionSource: string
  isRepeat: boolean
}

export async function loadCustomerReport(req: ResolvedReportRequest): Promise<{ rows: CustomerReportRow[]; counts: MovesReportResult['counts']; warnings: string[] }> {
  const moves = await loadMovesReport(req, { attribution: 'FIRST_TOUCH' })
  const byCustomer = new Map<string, MoveReportRow[]>()
  for (const r of moves.rows) {
    if (!byCustomer.has(r.customerId)) byCustomer.set(r.customerId, [])
    byCustomer.get(r.customerId)!.push(r)
  }
  const rows: CustomerReportRow[] = Array.from(byCustomer.entries()).map(([customerId, rs]) => ({
    customerId,
    customerName: rs[0].customerName,
    moves: rs.length,
    completedMoves: rs.filter((r) => r.status === 'COMPLETED').length,
    finalizedMoves: rs.filter((r) => r.isFinalized).length,
    totals: aggregateMoves(rs, req.scope),
    acquisitionSource: rs[rs.length - 1].marketingSource,
    isRepeat: rs[0].isRepeatCustomer,
  }))
  return { rows, counts: moves.counts, warnings: moves.warnings }
}
