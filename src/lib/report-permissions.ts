// ============================================================================
// report-permissions.ts — which report a role may run, and which columns come
// back (Stage 3B, owner spec 2026-07-20).
//
// TWO LAYERS, deliberately:
//   1. ACCESS   — may this role run this report at all?
//   2. SHAPE    — which fields does the response contain for this role?
//
// Layer 2 exists because "can view the marketing report" must not imply "can see
// company net profit inside it". Hiding a column in the UI is not a control;
// this strips it server-side, before the JSON is written.
//
// Pure functions, offline-tested.
// ============================================================================

import { can, type Role, type Action } from './permissions'
import { ALLOCATION_EXPORT_COLUMNS } from './profit-allocation'
import type { ExportColumn } from './export-service'

/** The 40/30/30 block, spread into every export that carries profit. Defined
 *  once in profit-allocation.ts so no surface can ship half the policy. */
const ALLOCATION: ExportColumn[] = ALLOCATION_EXPORT_COLUMNS.map((c) => ({ ...c }))

export type ReportType =
  | 'overview' | 'profit-loss' | 'moves' | 'revenue-profit' | 'variance'
  | 'marketing' | 'customers' | 'pricing' | 'action-center'

/** The permission each report requires to run. */
export const REPORT_ACCESS: Record<ReportType, Action> = {
  overview: 'report.view_financial',
  'profit-loss': 'report.view_financial',
  moves: 'report.view_operational',
  'revenue-profit': 'report.view_financial',
  variance: 'report.view_operational',
  marketing: 'report.view_marketing',
  customers: 'report.view_operational',
  pricing: 'pricing.view_intelligence',
  'action-center': 'action_center.view',
}

/** Reports whose EXPORT is owner-only even when the on-screen view is not. */
const SENSITIVE_EXPORTS: ReportType[] = ['overview', 'profit-loss', 'revenue-profit', 'customers', 'marketing']

export type AccessDecision = { allow: true } | { allow: false; status: 401 | 403; error: string }

export function canRunReport(role: Role | null | undefined, report: ReportType): AccessDecision {
  if (!role) return { allow: false, status: 401, error: 'Authentication required' }
  const action = REPORT_ACCESS[report]
  if (!action) return { allow: false, status: 403, error: 'Unknown report.' }
  if (!can(role, action)) {
    return { allow: false, status: 403, error: 'You do not have permission to view this report.' }
  }
  return { allow: true }
}

export function canExportReport(role: Role | null | undefined, report: ReportType): AccessDecision {
  const access = canRunReport(role, report)
  if (!access.allow) return access
  if (!can(role, 'report.export')) {
    return { allow: false, status: 403, error: 'You do not have permission to export reports.' }
  }
  if (SENSITIVE_EXPORTS.includes(report) && !can(role, 'report.export_sensitive')) {
    return { allow: false, status: 403, error: 'This export contains profit or pay information and is limited to owners.' }
  }
  return { allow: true }
}

// ── Response shaping ────────────────────────────────────────────────────────

/** Money fields only an owner may ever receive, in ANY report response. */
export const OWNER_ONLY_FIELDS = [
  'companyNetProfitCents', 'economicNetProfitCents', 'economicProfitCents',
  'cashGrossProfitCents', 'ownerEconomicLaborCents', 'crewLaborCents',
  'taxReserveCents', 'businessReserveCents', 'retainedEarningsCents',
  'distributableProfitCents', 'marginBp',
  'finalizedNetProfitCents', 'provisionalNetProfitCents', 'profitRoasBp',
  'netOfSpendCents', 'averageProfitPerMoveCents',
] as const

/**
 * Strip owner-only money from a plain object tree for a non-owner.
 *
 * Applied to the RESPONSE, not the query, so a report can share one calculation
 * path across roles and still never leak. Arrays and nested objects are walked.
 */
export function shapeForRole<T>(value: T, role: Role | null | undefined): T {
  if (role === 'OWNER') return value
  const drop = new Set<string>(OWNER_ONLY_FIELDS)

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (drop.has(k)) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(value) as T
}

/** Column sets per report, allow-listed and role-tagged for exports. */
export const REPORT_COLUMNS: Record<ReportType, ExportColumn[]> = {
  overview: [
    { key: 'metric', header: 'Metric' },
    { key: 'value', header: 'Value', money: true },
    ...ALLOCATION,
  ],
  'profit-loss': [
    { key: 'section', header: 'Section' },
    { key: 'line', header: 'Line' },
    { key: 'currentCents', header: 'Current period', money: true },
    { key: 'previousCents', header: 'Previous period', money: true },
    { key: 'changeCents', header: 'Change', money: true },
    { key: 'changePct', header: 'Change %' },
    ...ALLOCATION,
  ],
  moves: [
    { key: 'bookingReference', header: 'Move' },
    { key: 'customerName', header: 'Customer' },
    { key: 'moveDate', header: 'Move date' },
    { key: 'financialStatus', header: 'Financial status' },
    { key: 'serviceType', header: 'Service' },
    { key: 'originCity', header: 'Pickup city' },
    { key: 'destCity', header: 'Drop-off city' },
    { key: 'crewSize', header: 'Crew size' },
    { key: 'actualHours', header: 'Actual crew hours' },
    { key: 'netBilledRevenueCents', header: 'Net billed', money: true },
    { key: 'netCollectedRevenueCents', header: 'Net collected', money: true },
    { key: 'outstandingBalanceCents', header: 'Outstanding', money: true },
    { key: 'directJobCostCents', header: 'Direct costs', money: true },
    { key: 'crewLaborCents', header: 'Labor cost', money: true, roles: ['OWNER'] },
    { key: 'cashGrossProfitCents', header: 'Cash gross profit', money: true, roles: ['OWNER'] },
    { key: 'economicProfitCents', header: 'Economic profit', money: true, roles: ['OWNER'] },
    { key: 'companyNetProfitCents', header: 'Company net profit', money: true, roles: ['OWNER'] },
    { key: 'marginPct', header: 'Margin %', roles: ['OWNER'] },
    { key: 'marketingSource', header: 'Marketing source' },
    { key: 'isRepeatCustomer', header: 'Repeat customer' },
    ...ALLOCATION,
  ],
  'revenue-profit': [
    { key: 'bookingReference', header: 'Move' },
    { key: 'customerName', header: 'Customer' },
    { key: 'netCollectedRevenueCents', header: 'Revenue', money: true },
    { key: 'directJobCostCents', header: 'Direct costs', money: true },
    { key: 'cashGrossProfitCents', header: 'Cash profit', money: true, roles: ['OWNER'] },
    { key: 'economicProfitCents', header: 'Economic profit', money: true, roles: ['OWNER'] },
    { key: 'marginPct', header: 'Margin %', roles: ['OWNER'] },
    { key: 'actualHours', header: 'Crew hours' },
    { key: 'revenuePerCrewHourCents', header: 'Revenue / crew hour', money: true },
    { key: 'profitPerCrewHourCents', header: 'Profit / crew hour', money: true, roles: ['OWNER'] },
    { key: 'alert', header: 'Alert' },
    ...ALLOCATION,
  ],
  variance: [
    { key: 'bookingReference', header: 'Move' },
    { key: 'customerName', header: 'Customer' },
    { key: 'metric', header: 'Metric' },
    { key: 'estimated', header: 'Estimate' },
    { key: 'actual', header: 'Actual' },
    { key: 'variance', header: 'Variance' },
    { key: 'variancePct', header: 'Variance %' },
    { key: 'status', header: 'Status' },
    { key: 'scopeChanged', header: 'Scope changed' },
  ],
  marketing: [
    { key: 'sourceKey', header: 'Source / campaign' },
    { key: 'spendCents', header: 'Spend', money: true },
    { key: 'leads', header: 'Leads' },
    { key: 'quotes', header: 'Quotes' },
    { key: 'bookings', header: 'Bookings' },
    { key: 'completedMoves', header: 'Completed moves' },
    { key: 'finalizedMoves', header: 'Finalized moves' },
    { key: 'netCollectedRevenueCents', header: 'Collected revenue', money: true },
    { key: 'costPerLeadCents', header: 'Cost per lead', money: true },
    { key: 'costPerBookingCents', header: 'Cost per booking', money: true },
    { key: 'revenueRoas', header: 'Revenue ROAS' },
    { key: 'finalizedNetProfitCents', header: 'Finalized profit', money: true, roles: ['OWNER'] },
    { key: 'profitRoas', header: 'Profit ROAS', roles: ['OWNER'] },
    { key: 'verdict', header: 'Verdict', roles: ['OWNER'] },
    ...ALLOCATION,
  ],
  customers: [
    { key: 'customerName', header: 'Customer' },
    { key: 'moves', header: 'Moves' },
    { key: 'completedMoves', header: 'Completed' },
    { key: 'finalizedMoves', header: 'Finalized' },
    { key: 'netCollectedRevenueCents', header: 'Collected revenue', money: true },
    { key: 'outstandingBalanceCents', header: 'Outstanding', money: true },
    { key: 'companyNetProfitCents', header: 'Company net profit', money: true, roles: ['OWNER'] },
    { key: 'marginPct', header: 'Avg margin %', roles: ['OWNER'] },
    { key: 'acquisitionSource', header: 'Acquisition source' },
    { key: 'isRepeat', header: 'Repeat customer' },
    ...ALLOCATION,
  ],
  pricing: [
    { key: 'field', header: 'Field' },
    { key: 'value', header: 'Value' },
  ],
  'action-center': [
    { key: 'severity', header: 'Severity' },
    { key: 'rule', header: 'Rule' },
    { key: 'title', header: 'Title' },
    { key: 'description', header: 'Description' },
    { key: 'category', header: 'Category' },
    { key: 'sourceUrl', header: 'Link' },
  ],
}
