// Stage 3B — the ROUTE decisions: filter validation, report metadata, access
// control and response shaping. These are the exact predicates the reporting
// and export routes call, so a pass here is a statement about route behavior.
//
// NOTE: these are contract tests over pure functions. Database-backed
// integration tests are NOT included — no database is reachable (see
// docs/admin/reporting-staging-evidence.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseReportRequest, buildReportMetadata, dataStateFor, DATA_STATE_MESSAGE,
  MAX_CUSTOM_RANGE_DAYS,
} from '../reporting-filters'
import {
  canRunReport, canExportReport, shapeForRole, REPORT_COLUMNS, REPORT_ACCESS,
  OWNER_ONLY_FIELDS, type ReportType,
} from '../report-permissions'
import { assertNoForbiddenKeys, visibleColumns } from '../export-service'

const NOW = new Date('2026-07-20T16:00:00Z') // 12pm ET

// ── Filter parsing (never trust the client) ─────────────────────────────────

test('defaults are safe when nothing is supplied', () => {
  const r = parseReportRequest({}, NOW)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.basis, 'CASH')
  assert.equal(r.request.scope, 'COMBINED')
  assert.equal(r.request.period.label, 'July 2026')
  assert.equal(r.request.timeZone, 'America/New_York')
})

test('an unknown basis or scope is REJECTED, never coerced', () => {
  assert.equal(parseReportRequest({ basis: 'MAGIC' }, NOW).ok, false)
  assert.equal(parseReportRequest({ scope: 'EVERYTHING' }, NOW).ok, false)
  assert.equal(parseReportRequest({ period: 'forever' }, NOW).ok, false)
})

test('a custom range needs both dates, in order, in YYYY-MM-DD', () => {
  assert.equal(parseReportRequest({ period: 'custom', start: '2026-06-01' }, NOW).ok, false)
  assert.equal(parseReportRequest({ period: 'custom', start: '06/01/2026', end: '06/30/2026' }, NOW).ok, false)
  const backwards = parseReportRequest({ period: 'custom', start: '2026-06-30', end: '2026-06-01' }, NOW)
  assert.equal(backwards.ok, false)
  assert.match(backwards.ok === false ? backwards.error : '', /before the start/)
})

test('the custom end date is INCLUSIVE for the user', () => {
  const r = parseReportRequest({ period: 'custom', start: '2026-06-01', end: '2026-06-30' }, NOW)
  assert.equal(r.ok, true)
  if (!r.ok) return
  // 30 June 11:59pm ET = 1 July 03:59 UTC, must be inside.
  assert.ok(new Date('2026-07-01T03:59:00Z') < r.request.period.end)
  // 1 July 00:00 ET = 04:00 UTC, must be outside.
  assert.ok(new Date('2026-07-01T04:00:00Z') >= r.request.period.end)
})

test('an unbounded range is refused with the limit named', () => {
  const r = parseReportRequest({ period: 'custom', start: '2000-01-01', end: '2026-12-31' }, NOW)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : '', new RegExp(String(MAX_CUSTOM_RANGE_DAYS)))
})

test('pagination is clamped to sane bounds', () => {
  assert.equal(parseReportRequest({ pageSize: '9999' }, NOW).ok, false)
  assert.equal(parseReportRequest({ page: '0' }, NOW).ok, false)
  const ok = parseReportRequest({ page: '2', pageSize: '25' }, NOW)
  assert.equal(ok.ok && ok.request.query.pageSize, 25)
})

test('applied filters are echoed back for the response and export header', () => {
  const r = parseReportRequest({ city: 'Newark', profitability: 'loss' }, NOW)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.request.appliedFilters, { city: 'Newark', profitability: 'loss' })
})

test('an invalid filter value is rejected rather than ignored', () => {
  assert.equal(parseReportRequest({ profitability: 'amazing' }, NOW).ok, false)
  assert.equal(parseReportRequest({ flag: 'whatever' }, NOW).ok, false)
})

// ── Metadata contract ───────────────────────────────────────────────────────

test('metadata declares basis, mode, timezone and both counts', () => {
  const r = parseReportRequest({ scope: 'COMBINED', basis: 'ACCRUAL' }, NOW)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const m = buildReportMetadata(r.request, { finalized: 3, provisional: 2, incomplete: 0 }, [], NOW)
  assert.equal(m.accountingBasis, 'ACCRUAL')
  assert.equal(m.reportingMode, 'COMBINED')
  assert.equal(m.timezone, 'America/New_York')
  assert.equal(m.finalizedMoveCount, 3)
  assert.equal(m.provisionalMoveCount, 2)
  assert.ok(m.periodEndExclusive > m.periodStart)
  // The frontend must never have to guess.
  assert.match(m.basisLabel, /Accrual basis/)
})

test('a MIXED report carries the disclosure warning first', () => {
  const r = parseReportRequest({ scope: 'COMBINED' }, NOW)
  if (!r.ok) return
  const m = buildReportMetadata(r.request, { finalized: 2, provisional: 1, incomplete: 0 }, [], NOW)
  assert.match(m.warnings[0], /not been financially finalized/)
})

test('a finalized-only report with nothing provisional carries no mix warning', () => {
  const r = parseReportRequest({ scope: 'FINALIZED_ONLY' }, NOW)
  if (!r.ok) return
  const m = buildReportMetadata(r.request, { finalized: 4, provisional: 0, incomplete: 0 }, [], NOW)
  assert.equal(m.warnings.some((w) => /not been financially finalized/.test(w)), false)
})

test('unusable moves are disclosed, never silently dropped', () => {
  const r = parseReportRequest({}, NOW)
  if (!r.ok) return
  const m = buildReportMetadata(r.request, { finalized: 1, provisional: 0, incomplete: 2 }, [], NOW)
  assert.equal(m.incompleteMoveCount, 2)
  assert.ok(m.warnings.some((w) => /could not be included/.test(w)))
})

// ── "$0.00" vs "no verified data" ───────────────────────────────────────────

test('an empty period is EMPTY; finalized-only with provisional moves is NO_VERIFIED_DATA', () => {
  assert.equal(dataStateFor({ finalized: 0, provisional: 0 }, 'COMBINED'), 'EMPTY')
  assert.equal(dataStateFor({ finalized: 0, provisional: 3 }, 'FINALIZED_ONLY'), 'NO_VERIFIED_DATA')
  assert.equal(dataStateFor({ finalized: 2, provisional: 0 }, 'FINALIZED_ONLY'), 'OK')
  assert.equal(dataStateFor({ finalized: 0, provisional: 3 }, 'COMBINED'), 'OK')
  // The message must not read like a zero.
  assert.match(DATA_STATE_MESSAGE.NO_VERIFIED_DATA, /No verified data/)
  assert.notEqual(DATA_STATE_MESSAGE.NO_VERIFIED_DATA, DATA_STATE_MESSAGE.EMPTY)
})

// ── Report access ───────────────────────────────────────────────────────────

const ALL_REPORTS = Object.keys(REPORT_ACCESS) as ReportType[]

test('an unauthenticated caller can run NO report', () => {
  for (const r of ALL_REPORTS) {
    const d = canRunReport(null, r)
    assert.equal(d.allow, false, r)
    assert.equal(d.allow === false && d.status, 401, r)
  }
})

test('an OWNER can run every report', () => {
  for (const r of ALL_REPORTS) assert.equal(canRunReport('OWNER', r).allow, true, r)
})

test('a MANAGER runs operations but NOT company financial reports', () => {
  assert.equal(canRunReport('MANAGER', 'moves').allow, true)
  assert.equal(canRunReport('MANAGER', 'variance').allow, true)
  assert.equal(canRunReport('MANAGER', 'marketing').allow, true)
  for (const r of ['overview', 'profit-loss', 'revenue-profit'] as ReportType[]) {
    const d = canRunReport('MANAGER', r)
    assert.equal(d.allow, false, r)
    assert.equal(d.allow === false && d.status, 403, r)
  }
})

test('a CREW member can run no report at all', () => {
  for (const r of ALL_REPORTS) assert.equal(canRunReport('CREW', r).allow, false, r)
})

// ── Export access ───────────────────────────────────────────────────────────

test('sensitive exports are owner-only even when the on-screen report is not', () => {
  // A manager may VIEW marketing but may not EXPORT it (it carries profit).
  assert.equal(canRunReport('MANAGER', 'marketing').allow, true)
  const d = canExportReport('MANAGER', 'marketing')
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 403)
  assert.match(d.allow === false ? d.error : '', /limited to owners/)
})

test('a manager CAN export the operational reports', () => {
  assert.equal(canExportReport('MANAGER', 'moves').allow, true)
  assert.equal(canExportReport('MANAGER', 'variance').allow, true)
})

test('an owner can export everything', () => {
  for (const r of ALL_REPORTS) assert.equal(canExportReport('OWNER', r).allow, true, r)
})

test('export access still requires report access first', () => {
  assert.equal(canExportReport('MANAGER', 'profit-loss').allow, false)
  assert.equal(canExportReport(null, 'moves').allow, false)
})

// ── Response shaping ────────────────────────────────────────────────────────

test('owner-only money is STRIPPED from a non-owner response body', () => {
  const payload = {
    rows: [{ bookingReference: 'WMIC-1', netCollectedRevenueCents: 200000, companyNetProfitCents: 74000, crewLaborCents: 80000 }],
    totals: { netCollectedRevenueCents: 200000, economicProfitCents: 50000, marginBp: 3700 },
  }
  const forManager = shapeForRole(payload, 'MANAGER') as typeof payload
  assert.equal(forManager.rows[0].netCollectedRevenueCents, 200000)
  assert.equal('companyNetProfitCents' in forManager.rows[0], false)
  assert.equal('crewLaborCents' in forManager.rows[0], false)
  assert.equal('economicProfitCents' in forManager.totals, false)
  assert.equal('marginBp' in forManager.totals, false)
})

test('an OWNER receives the payload untouched', () => {
  const payload = { rows: [{ companyNetProfitCents: 74000 }] }
  assert.deepEqual(shapeForRole(payload, 'OWNER'), payload)
})

test('shaping walks nested arrays and objects', () => {
  const deep = { a: { b: [{ companyNetProfitCents: 1, keep: 2 }] } }
  const shaped = shapeForRole(deep, 'MANAGER') as typeof deep
  assert.equal('companyNetProfitCents' in shaped.a.b[0], false)
  assert.equal(shaped.a.b[0].keep, 2)
})

test('shaping preserves Date values rather than flattening them', () => {
  const d = new Date('2026-07-20T00:00:00Z')
  const shaped = shapeForRole({ when: d, companyNetProfitCents: 1 }, 'MANAGER') as { when: Date }
  assert.ok(shaped.when instanceof Date)
})

test('every owner-only field name is actually stripped', () => {
  const payload = Object.fromEntries(OWNER_ONLY_FIELDS.map((f) => [f, 1])) as Record<string, number>
  const shaped = shapeForRole(payload, 'MANAGER') as Record<string, number>
  assert.equal(Object.keys(shaped).length, 0)
})

// ── Export column safety ────────────────────────────────────────────────────

test('no report column set contains a forbidden field', () => {
  for (const [report, cols] of Object.entries(REPORT_COLUMNS)) {
    const check = assertNoForbiddenKeys(cols)
    assert.equal(check.ok, true, `${report}: ${check.ok === false ? check.offending.join(',') : ''}`)
  }
})

test('profit and pay columns are owner-tagged in every report that has them', () => {
  for (const [report, cols] of Object.entries(REPORT_COLUMNS)) {
    for (const c of cols) {
      if (/companyNetProfit|crewLabor|economicProfit|profitRoas|finalizedNetProfit|marginPct/i.test(c.key)) {
        assert.deepEqual(c.roles, ['OWNER'], `${report}.${c.key} must be owner-only`)
      }
    }
  }
})

test('a manager export of the moves report contains no profit column', () => {
  const cols = visibleColumns(REPORT_COLUMNS.moves, 'MANAGER')
  assert.equal(cols.some((c) => /profit|margin|crewLabor/i.test(c.key)), false)
  // …but still contains what they legitimately need.
  assert.equal(cols.some((c) => c.key === 'netCollectedRevenueCents'), true)
})
