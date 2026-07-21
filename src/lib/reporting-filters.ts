// ============================================================================
// reporting-filters.ts — parse and VALIDATE every reporting request parameter
// server-side (Stage 3B, owner spec 2026-07-20).
//
// THE RULE: never trust a value the frontend sent. Role, basis, scope, date
// range and pagination all arrive as strings on a URL that anyone with a session
// can edit. This module is the single choke point that turns them into safe,
// typed values — and it never reads a role from the request at all.
//
// Pure functions, offline-tested.
// ============================================================================

import { z } from 'zod'
import {
  resolvePeriod, previousComparablePeriod, BUSINESS_TIME_ZONE,
  type Period, type PeriodKey,
} from './reporting-period'
import { describeBasis, type ReportBasis, type ReportScope } from './reporting-basis'

export const PERIOD_KEYS: PeriodKey[] = [
  'today', 'yesterday', 'this_week', 'previous_week', 'this_month',
  'previous_month', 'this_quarter', 'previous_quarter', 'year_to_date',
  'previous_year', 'custom',
]

/** A custom range wider than this is refused — an unbounded report is a
 *  denial-of-service on our own database. */
export const MAX_CUSTOM_RANGE_DAYS = 800

export const ReportQuerySchema = z.object({
  period: z.enum(PERIOD_KEYS as [PeriodKey, ...PeriodKey[]]).default('this_month'),
  start: z.string().trim().max(40).optional(),
  end: z.string().trim().max(40).optional(),
  basis: z.enum(['CASH', 'ACCRUAL']).default('CASH'),
  scope: z.enum(['FINALIZED_ONLY', 'PROVISIONAL_ONLY', 'COMBINED']).default('COMBINED'),
  // list controls
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().trim().max(40).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  // filters — all optional, all validated
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(2).optional(),
  serviceType: z.string().trim().max(60).optional(),
  source: z.string().trim().max(80).optional(),
  customerId: z.string().trim().max(40).optional(),
  crewUserId: z.string().trim().max(40).optional(),
  profitability: z.enum(['profitable', 'break_even', 'loss']).optional(),
  flag: z.enum(['missing_closeout', 'missing_labor', 'outstanding_balance', 'refund', 'dispute', 'scope_changed', 'estimate_missed']).optional(),
})

export type ReportQuery = z.infer<typeof ReportQuerySchema>

export interface ResolvedReportRequest {
  query: ReportQuery
  period: Period
  comparePeriod: Period
  basis: ReportBasis
  scope: ReportScope
  timeZone: string
  /** Filters that were actually applied, for the response + export header. */
  appliedFilters: Record<string, string>
}

export type ParseResult =
  | { ok: true; request: ResolvedReportRequest }
  | { ok: false; status: 422; error: string; issues?: unknown }

/**
 * Turn raw search params into a safe, resolved request.
 *
 * `now` is injectable so every boundary is testable without faking the clock.
 */
export function parseReportRequest(params: URLSearchParams | Record<string, string | undefined>, now: Date = new Date()): ParseResult {
  const raw = params instanceof URLSearchParams ? Object.fromEntries(params.entries()) : params
  const parsed = ReportQuerySchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, status: 422, error: 'Invalid report filters.', issues: parsed.error.flatten() }
  }
  const q = parsed.data

  if (q.period === 'custom') {
    if (!q.start || !q.end) {
      return { ok: false, status: 422, error: 'A custom range needs both a start and an end date.' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.start) || !/^\d{4}-\d{2}-\d{2}$/.test(q.end)) {
      return { ok: false, status: 422, error: 'Custom dates must be YYYY-MM-DD.' }
    }
    if (q.end < q.start) {
      return { ok: false, status: 422, error: 'The end date is before the start date.' }
    }
  }

  const period = resolvePeriod(q.period, now, { start: q.start ?? null, end: q.end ?? null })
  const days = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000)
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    return { ok: false, status: 422, error: `That range covers ${days} days. Narrow it to ${MAX_CUSTOM_RANGE_DAYS} days or fewer.` }
  }

  const appliedFilters: Record<string, string> = {}
  for (const k of ['city', 'state', 'serviceType', 'source', 'customerId', 'crewUserId', 'profitability', 'flag'] as const) {
    const v = q[k]
    if (v) appliedFilters[k] = String(v)
  }

  return {
    ok: true,
    request: {
      query: q,
      period,
      comparePeriod: previousComparablePeriod(period, now),
      basis: q.basis as ReportBasis,
      scope: q.scope as ReportScope,
      timeZone: BUSINESS_TIME_ZONE,
      appliedFilters,
    },
  }
}

// ── Report metadata (the contract every response carries) ───────────────────

export interface ReportMetadata {
  accountingBasis: ReportBasis
  reportingMode: ReportScope
  timezone: string
  periodKey: PeriodKey
  periodLabel: string
  periodStart: string
  /** EXCLUSIVE — a move at 23:59:59.999 is in, one at 00:00:00.000 next day is out. */
  periodEndExclusive: string
  comparePeriodLabel: string
  finalizedMoveCount: number
  provisionalMoveCount: number
  /** Moves in range whose figures could not be used at all. */
  incompleteMoveCount: number
  /** The one disclosure line every surface and export repeats verbatim. */
  basisLabel: string
  warnings: string[]
  filters: Record<string, string>
  generatedAt: string
}

/**
 * Build the metadata block.
 *
 * The frontend must NEVER have to guess whether a number is finalized — that is
 * the entire reason this object is mandatory on every report response.
 */
export function buildReportMetadata(
  req: ResolvedReportRequest,
  counts: { finalized: number; provisional: number; incomplete: number },
  extraWarnings: string[] = [],
  generatedAt: Date = new Date(),
): ReportMetadata {
  const label = describeBasis(req.basis, req.scope, { finalized: counts.finalized, provisional: counts.provisional })
  const warnings = [...extraWarnings]
  if (label.warning) warnings.unshift(label.warning)
  if (counts.incomplete > 0) {
    warnings.push(
      `${counts.incomplete} move${counts.incomplete === 1 ? '' : 's'} in this period could not be included because ${counts.incomplete === 1 ? 'its' : 'their'} financial data is unusable.`,
    )
  }
  return {
    accountingBasis: req.basis,
    reportingMode: req.scope,
    timezone: req.timeZone,
    periodKey: req.period.key,
    periodLabel: req.period.label,
    periodStart: req.period.start.toISOString(),
    periodEndExclusive: req.period.end.toISOString(),
    comparePeriodLabel: req.comparePeriod.label,
    finalizedMoveCount: counts.finalized,
    provisionalMoveCount: counts.provisional,
    incompleteMoveCount: counts.incomplete,
    basisLabel: label.label,
    warnings,
    filters: req.appliedFilters,
    generatedAt: generatedAt.toISOString(),
  }
}

// ── Result envelopes ────────────────────────────────────────────────────────

export interface ReportEnvelope<T> {
  meta: ReportMetadata
  data: T
  /** Present only on list endpoints. */
  page?: { page: number; pageSize: number; total: number; totalPages: number }
}

/**
 * The difference between "we measured zero" and "we could not measure".
 * A report must never render $0.00 for the second case.
 */
export type DataState = 'OK' | 'EMPTY' | 'NO_VERIFIED_DATA' | 'UNAVAILABLE'

export function dataStateFor(counts: { finalized: number; provisional: number }, scope: ReportScope): DataState {
  const usable = scope === 'FINALIZED_ONLY' ? counts.finalized
    : scope === 'PROVISIONAL_ONLY' ? counts.provisional
      : counts.finalized + counts.provisional
  if (usable > 0) return 'OK'
  if (scope === 'FINALIZED_ONLY' && counts.provisional > 0) return 'NO_VERIFIED_DATA'
  return 'EMPTY'
}

export const DATA_STATE_MESSAGE: Record<DataState, string> = {
  OK: '',
  EMPTY: 'No moves in this period.',
  NO_VERIFIED_DATA: 'No verified data available — moves in this period exist but none have completed financial closeout.',
  UNAVAILABLE: 'Reporting data is unavailable right now.',
}
