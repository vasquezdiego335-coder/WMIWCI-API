// Stage 3 — export safety (formula injection, permissions, private fields) and
// Action Center financial wiring (dedupe + auto-resolve).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeCell, isFormulaRisk, csvEscape, toCsv, toXlsxXml, visibleColumns,
  assertNoForbiddenKeys, canExport, exportFilename, contentTypeFor,
  buildExportAudit, metaRows, MAX_EXPORT_ROWS, type ExportColumn, type ExportMeta,
} from '../export-service'
import {
  financialActionsForMove, financialActionsForCampaign, dedupeActions, resolvedKeys,
  type CloseoutActionInput,
} from '../action-center-financial'
import { can } from '../permissions'

// ── SCENARIO 6: spreadsheet formula injection ───────────────────────────────

test('SCENARIO 6: =HYPERLINK(...) is neutralized, not executed', () => {
  const evil = '=HYPERLINK("http://evil.example/steal","Click me")'
  assert.equal(isFormulaRisk(evil), true)
  const safe = sanitizeCell(evil)
  assert.equal(safe.startsWith("'="), true)
  // The original text is preserved — an export must stay a faithful record.
  assert.ok(safe.includes('HYPERLINK'))
})

test('every dangerous lead character is neutralized', () => {
  for (const p of ['=', '+', '-', '@']) {
    assert.equal(sanitizeCell(`${p}cmd|calc`).startsWith(`'${p}`), true, p)
  }
})

test('leading whitespace/control characters cannot smuggle a formula through', () => {
  // Detection looks PAST the noise; the quote is prefixed to the ORIGINAL, so
  // the customer's exact text survives into the file.
  for (const evil of ['\t=1+1', '   @SUM(A1)', '​+cmd', '﻿-2+3']) {
    assert.equal(isFormulaRisk(evil), true, evil)
    const out = sanitizeCell(evil)
    assert.equal(out.startsWith("'"), true, evil)
    assert.equal(out.slice(1), evil, 'original text must be preserved verbatim')
  }
})

test('ordinary text is untouched', () => {
  assert.equal(sanitizeCell('Newark to Montclair'), 'Newark to Montclair')
  assert.equal(sanitizeCell('2 guys, 3rd floor'), '2 guys, 3rd floor')
  assert.equal(isFormulaRisk('Newark'), false)
})

test('a negative NUMBER is not mangled — only text is quoted', () => {
  assert.equal(sanitizeCell(-4500), '-4500')
  assert.equal(isFormulaRisk(-4500), false)
})

test('CSV quoting happens AFTER sanitization', () => {
  assert.equal(csvEscape('=1+1,"x"'), `"'=1+1,""x"""`)
  assert.equal(csvEscape('plain'), 'plain')
  assert.equal(csvEscape(null), '')
})

const COLUMNS: ExportColumn[] = [
  { key: 'moveId', header: 'Move ID' },
  { key: 'customer', header: 'Customer' },
  { key: 'note', header: 'Note' },
  { key: 'netCollectedCents', header: 'Net collected', money: true },
  { key: 'companyNetProfitCents', header: 'Company net profit', money: true, roles: ['OWNER'] },
  { key: 'workerPayCents', header: 'Worker pay', money: true, roles: ['OWNER'] },
]

const META: ExportMeta = {
  businessName: 'Move It Clear It',
  reportTitle: 'Move profitability',
  generatedAt: new Date('2026-07-20T15:00:00Z'),
  basisLabel: 'Cash basis — money actually collected and paid · finalized moves only',
  periodLabel: 'June 2026',
  currency: 'USD',
  recordCount: 2,
}

test('a CSV export carries the header block: business, title, period, BASIS', () => {
  const csv = toCsv(COLUMNS.slice(0, 3), [{ moveId: 'WMIC-1', customer: 'A', note: 'ok' }], META)
  assert.ok(csv.includes('Move It Clear It'))
  assert.ok(csv.includes('Move profitability'))
  assert.ok(csv.includes('June 2026'))
  assert.ok(csv.includes('Cash basis'))
  assert.ok(csv.includes('USD'))
  assert.ok(csv.includes('2026-07-20T15:00:00.000Z'))
})

test('a mixed-source export carries the warning line', () => {
  const rows = metaRows({ ...META, warning: 'Includes 2 moves that have not been financially finalized.' })
  assert.ok(rows.some((r) => r[0] === 'Warning'))
})

test('SCENARIO 6: the XLSX path sanitizes AND xml-escapes', () => {
  const xml = toXlsxXml(
    [{ key: 'note', header: 'Note' }],
    [{ note: '=HYPERLINK("http://evil","x") & <script>' }],
    META,
  )
  assert.ok(xml.includes("&#039;=") || xml.includes("'="))
  assert.ok(xml.includes('&lt;script&gt;'))
  assert.ok(!xml.includes('<script>'))
  assert.ok(xml.includes('<?mso-application progid="Excel.Sheet"?>'))
})

// ── Column allow-listing + permissions ──────────────────────────────────────

test('a MANAGER does not receive owner-only profit or pay columns', () => {
  const cols = visibleColumns(COLUMNS, 'MANAGER')
  assert.equal(cols.some((c) => c.key === 'companyNetProfitCents'), false)
  assert.equal(cols.some((c) => c.key === 'workerPayCents'), false)
  assert.equal(cols.some((c) => c.key === 'netCollectedCents'), true)
})

test('an OWNER receives every column', () => {
  assert.equal(visibleColumns(COLUMNS, 'OWNER').length, COLUMNS.length)
})

test('forbidden fields can never be exported, even if requested', () => {
  const bad: ExportColumn[] = [{ key: 'receiptUrl', header: 'Receipt' }, { key: 'passwordHash', header: 'PW' }]
  const check = assertNoForbiddenKeys(bad)
  assert.equal(check.ok, false)
  assert.equal(check.ok === false && check.offending.length, 2)
  const decision = canExport({ role: 'OWNER', allowed: true, columns: bad, rowCount: 1, format: 'CSV' })
  assert.equal(decision.allow, false)
})

test('an unpermitted user cannot export at all', () => {
  const d = canExport({ role: 'MANAGER', allowed: false, columns: COLUMNS, rowCount: 10, format: 'CSV' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 403)
})

test('an unbounded export is refused with a helpful limit', () => {
  const d = canExport({ role: 'OWNER', allowed: true, columns: COLUMNS, rowCount: MAX_EXPORT_ROWS + 1, format: 'CSV' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 413)
})

test('an export with no visible columns for the role is refused', () => {
  const ownerOnly: ExportColumn[] = [{ key: 'companyNetProfitCents', header: 'Profit', roles: ['OWNER'] }]
  const d = canExport({ role: 'MANAGER', allowed: true, columns: ownerOnly, rowCount: 5, format: 'CSV' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
})

test('requested columns narrow but never widen access', () => {
  const cols = visibleColumns(COLUMNS, 'MANAGER', ['companyNetProfitCents', 'customer'])
  assert.deepEqual(cols.map((c) => c.key), ['customer'])
})

test('filenames and content types are format-correct', () => {
  assert.equal(exportFilename('Move profitability', 'CSV', new Date('2026-07-20T00:00:00Z')), 'move-profitability-2026-07-20.csv')
  assert.equal(contentTypeFor('CSV'), 'text/csv; charset=utf-8')
  assert.equal(contentTypeFor('PDF'), 'application/pdf')
})

test('the export audit records the SHAPE, never the content', () => {
  const a = buildExportAudit({
    userId: 'u1', userName: 'Diego', reportType: 'move-profitability', format: 'CSV',
    periodLabel: 'June 2026', basisLabel: 'Cash · finalized', filters: { city: 'Newark' },
    columnKeys: ['moveId', 'customer'], recordCount: 42, success: true,
  })
  assert.equal(a.recordCount, 42)
  assert.deepEqual(a.columns, ['moveId', 'customer'])
  assert.equal(JSON.stringify(a).includes('rows'), false)
  assert.equal('content' in a, false)
})

test('report permissions: manager runs operations, owner sees the money', () => {
  assert.equal(can('MANAGER', 'report.view_operational'), true)
  assert.equal(can('MANAGER', 'report.view_marketing'), true)
  assert.equal(can('MANAGER', 'report.view_financial'), false)
  assert.equal(can('MANAGER', 'report.view_owner_money'), false)
  assert.equal(can('MANAGER', 'report.view_worker_pay'), false)
  assert.equal(can('MANAGER', 'report.export_sensitive'), false)
  assert.equal(can('OWNER', 'report.view_financial'), true)
  assert.equal(can('OWNER', 'report.export_sensitive'), true)
  assert.equal(can('CREW', 'report.view_operational'), false)
  assert.equal(can(null, 'report.export'), false)
})

// ── Action Center ───────────────────────────────────────────────────────────

const NOW = new Date('2026-07-20T15:00:00Z')

const MOVE: CloseoutActionInput = {
  bookingId: 'bk1', bookingReference: 'WMIC-1042', customerName: 'Sam Rivera',
  status: 'COMPLETED', completedAt: new Date('2026-07-10T20:00:00Z'),
  isFinalized: false, blockerCodes: [], overriddenCodes: [], canFinalize: false,
  submittedForReview: false, companyNetProfitCents: 50000, marginBp: 3000,
  outstandingBalanceCents: 0, unpaidLaborCents: 0, ownerReimbursementOwedCents: 0,
  pendingDistributionCents: 0, estimateSeverity: 'OK', marketingSourceUnknown: false,
  targetMarginBp: 2000, closeoutGraceDays: 3, now: NOW,
}

test('SCENARIO 7: an unclosed completed move raises exactly one action', () => {
  const a = financialActionsForMove(MOVE)
  const unclosed = a.filter((x) => x.rule === 'move-not-closed-out')
  assert.equal(unclosed.length, 1)
  assert.equal(unclosed[0].dedupeKey, 'move-not-closed-out:booking:bk1')
  assert.match(unclosed[0].sourceUrl, /^\/admin\/jobs\/bk1#closeout-/)
})

test('SCENARIO 7: each blocker becomes its own action with the right severity', () => {
  const a = financialActionsForMove({ ...MOVE, blockerCodes: ['RECEIPT_MISSING', 'OUTSTANDING_BALANCE', 'LABOR_NOT_APPROVED'], outstandingBalanceCents: 50000 })
  assert.equal(a.find((x) => x.rule === 'closeout-receipt-missing')?.severity, 'MEDIUM')
  assert.equal(a.find((x) => x.rule === 'closeout-outstanding-balance')?.severity, 'HIGH')
  assert.equal(a.find((x) => x.rule === 'closeout-labor-unapproved')?.severity, 'HIGH')
  assert.match(a.find((x) => x.rule === 'closeout-outstanding-balance')?.description ?? '', /\$500\.00/)
})

test('an OVERRIDDEN blocker raises NOTHING — re-alerting teaches people to ignore', () => {
  const a = financialActionsForMove({
    ...MOVE, blockerCodes: ['OUTSTANDING_BALANCE'], overriddenCodes: ['OUTSTANDING_BALANCE'], outstandingBalanceCents: 50000,
  })
  assert.equal(a.some((x) => x.rule === 'closeout-outstanding-balance'), false)
})

test('SCENARIO 7: a losing move and a low-margin move raise different actions', () => {
  const loss = financialActionsForMove({ ...MOVE, companyNetProfitCents: -45000, marginBp: -900 })
  assert.equal(loss.find((x) => x.rule === 'move-lost-money')?.severity, 'HIGH')
  assert.equal(loss.some((x) => x.rule === 'move-margin-below-target'), false)

  const thin = financialActionsForMove({ ...MOVE, companyNetProfitCents: 5000, marginBp: 800 })
  assert.ok(thin.some((x) => x.rule === 'move-margin-below-target'))
  assert.equal(thin.some((x) => x.rule === 'move-lost-money'), false)
})

test('unpaid crew labor raises a payables action', () => {
  const a = financialActionsForMove({ ...MOVE, unpaidLaborCents: 20000 })
  const x = a.find((r) => r.rule === 'labor-payment-pending')
  assert.ok(x)
  assert.equal(x?.category, 'CREW_PAYROLL')
  assert.match(x?.title ?? '', /\$200\.00/)
})

test('a FINALIZED move raises nothing except reopen / pending distribution', () => {
  const a = financialActionsForMove({ ...MOVE, isFinalized: true, blockerCodes: ['RECEIPT_MISSING'], unpaidLaborCents: 5000, companyNetProfitCents: -1 })
  assert.equal(a.length, 0)
  const reopened = financialActionsForMove({ ...MOVE, isFinalized: true, reopenedAt: new Date('2026-07-18T12:00:00Z') })
  assert.equal(reopened[0].rule, 'closeout-reopened')
  const dist = financialActionsForMove({ ...MOVE, isFinalized: true, pendingDistributionCents: 30000 })
  assert.ok(dist.some((x) => x.rule === 'distribution-pending'))
})

test('a ready move nudges to finalize; a submitted one nudges the owner', () => {
  assert.ok(financialActionsForMove({ ...MOVE, canFinalize: true }).some((x) => x.rule === 'closeout-ready-to-finalize'))
  assert.ok(financialActionsForMove({ ...MOVE, canFinalize: true, submittedForReview: true }).some((x) => x.rule === 'closeout-ready-for-owner-review'))
})

test('an unknown marketing source is surfaced so campaigns stay measurable', () => {
  assert.ok(financialActionsForMove({ ...MOVE, marketingSourceUnknown: true }).some((x) => x.rule === 'lead-source-unknown'))
})

test('a badly-missed estimate is surfaced for future quoting', () => {
  assert.ok(financialActionsForMove({ ...MOVE, estimateSeverity: 'WARNING' }).some((x) => x.rule === 'estimate-significantly-off'))
})

test('a move within the closeout grace period is NOT nagged', () => {
  const fresh = financialActionsForMove({ ...MOVE, completedAt: new Date('2026-07-19T20:00:00Z') })
  assert.equal(fresh.some((x) => x.rule === 'move-not-closed-out'), false)
})

test('an overdue closeout escalates in severity', () => {
  const old = financialActionsForMove({ ...MOVE, completedAt: new Date('2026-06-01T20:00:00Z') })
  assert.equal(old.find((x) => x.rule === 'move-not-closed-out')?.severity, 'HIGH')
})

test('SCENARIO 7: running the scan twice produces NO duplicates', () => {
  const once = financialActionsForMove({ ...MOVE, blockerCodes: ['RECEIPT_MISSING'] })
  const twice = dedupeActions([...once, ...financialActionsForMove({ ...MOVE, blockerCodes: ['RECEIPT_MISSING'] })])
  assert.equal(twice.length, once.length)
  assert.equal(new Set(twice.map((x) => x.dedupeKey)).size, twice.length)
})

test('dedupe keeps the MOST SEVERE when two rules collide on one key', () => {
  const low = { ...financialActionsForMove(MOVE)[0], severity: 'LOW' as const }
  const high = { ...low, severity: 'CRITICAL' as const }
  assert.equal(dedupeActions([low, high])[0].severity, 'CRITICAL')
})

test('SCENARIO 7: fixing the condition auto-resolves the action', () => {
  const before = financialActionsForMove({ ...MOVE, blockerCodes: ['RECEIPT_MISSING'], unpaidLaborCents: 20000 })
  const keys = before.map((x) => x.dedupeKey)
  // Receipt attached and crew paid — those candidates simply stop being produced.
  const after = financialActionsForMove({ ...MOVE, blockerCodes: [], unpaidLaborCents: 0 })
  const resolved = resolvedKeys(keys, after)
  assert.ok(resolved.includes('closeout-receipt-missing:booking:bk1'))
  assert.ok(resolved.includes('labor-payment-pending:booking:bk1'))
})

test('actions sort most-severe first', () => {
  const a = dedupeActions(financialActionsForMove({ ...MOVE, blockerCodes: ['NO_PAYMENT_DATA', 'EXPENSES_PENDING_REVIEW'] }))
  assert.equal(a[0].severity, 'CRITICAL')
})

test('a campaign with no spend recorded cannot be measured, and says so', () => {
  const a = financialActionsForCampaign({ campaignId: 'c1', name: 'Spring hangers', status: 'ACTIVE', hasSpendRecorded: false, attributedBookings: 3 })
  assert.equal(a.length, 1)
  assert.equal(a[0].dedupeKey, 'campaign-missing-spend:campaign:c1')
  assert.equal(a[0].severity, 'MEDIUM')
  // Once spend is recorded, the candidate disappears.
  assert.equal(financialActionsForCampaign({ campaignId: 'c1', name: 'x', status: 'ACTIVE', hasSpendRecorded: true, attributedBookings: 3 }).length, 0)
})
