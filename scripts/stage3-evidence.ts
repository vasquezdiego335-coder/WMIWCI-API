// Stage 3 staging scenarios — SYNTHETIC DATA ONLY, no database access.
// Runs the eight scenarios from the owner spec through the REAL centralized
// reporting modules. Nothing is hard-coded.
//   npx tsx scripts/stage3-evidence.ts

import { aggregateMoves, describeBasis, revenueForBasis, isMixedSource, type MoveFinancialRow } from '../src/lib/reporting-basis'
import { resolvePeriod, compareCents, inPeriod, formatBusinessDate } from '../src/lib/reporting-period'
import { scoreMarketingSource, formatRoas, resolveAttribution, canCorrectAttribution } from '../src/lib/marketing-profitability'
import { computeVariance } from '../src/lib/estimate-variance'
import { recommendPrice, computeBreakEven, type ComparableMove } from '../src/lib/pricing-intelligence'
import { sanitizeCell, toCsv, toXlsxXml, canExport, buildExportAudit, type ExportColumn, type ExportMeta } from '../src/lib/export-service'
import { financialActionsForMove, dedupeActions, resolvedKeys, type CloseoutActionInput } from '../src/lib/action-center-financial'
import { fmtCents } from '../src/lib/profit'

const rule = (t: string) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
const row = (l: string, v: string, n = '') => console.log(`  ${l.padEnd(40)}${v.padStart(15)}  ${n}`)

const fig = (o: Partial<NonNullable<MoveFinancialRow['snapshot']>>) => ({
  netBilledRevenueCents: 0, netCollectedRevenueCents: 0, outstandingBalanceCents: 0,
  directJobCostCents: 0, crewLaborCents: 0, ownerEconomicLaborCents: 0,
  allocatedOverheadCents: 0, cashGrossProfitCents: 0, economicProfitCents: 0,
  companyNetProfitCents: 0, economicNetProfitCents: 0, taxReserveCents: 0,
  businessReserveCents: 0, retainedEarningsCents: 0, distributableProfitCents: 0, ...o,
})

// ── 1. Monthly financial report ─────────────────────────────────────────────
rule('SCENARIO 1 — Monthly financial report from FINALIZED snapshots')

const profitable: MoveFinancialRow = { bookingId: 'm1', isFinalized: true, snapshot: fig({
  netBilledRevenueCents: 200000, netCollectedRevenueCents: 200000,
  directJobCostCents: 122500, crewLaborCents: 80000, allocatedOverheadCents: 3500,
  cashGrossProfitCents: 77500, economicProfitCents: 77500,
  companyNetProfitCents: 74000, economicNetProfitCents: 74000,
  taxReserveCents: 14800, distributableProfitCents: 59200 }) }

const lossMaking: MoveFinancialRow = { bookingId: 'm2', isFinalized: true, snapshot: fig({
  netBilledRevenueCents: 60000, netCollectedRevenueCents: 50000, outstandingBalanceCents: 10000,
  directJobCostCents: 91500, crewLaborCents: 70000, allocatedOverheadCents: 3500,
  cashGrossProfitCents: -41500, economicProfitCents: -41500,
  companyNetProfitCents: -45000, economicNetProfitCents: -45000 }) }

const refunded: MoveFinancialRow = { bookingId: 'm3', isFinalized: true, snapshot: fig({
  netBilledRevenueCents: 200000, netCollectedRevenueCents: 180000,
  directJobCostCents: 100000, crewLaborCents: 60000,
  cashGrossProfitCents: 80000, economicProfitCents: 80000,
  companyNetProfitCents: 80000, economicNetProfitCents: 80000,
  taxReserveCents: 16000, distributableProfitCents: 64000 }) }

const ownerWorked: MoveFinancialRow = { bookingId: 'm4', isFinalized: true, snapshot: fig({
  netBilledRevenueCents: 200000, netCollectedRevenueCents: 200000,
  directJobCostCents: 71000, crewLaborCents: 30000, ownerEconomicLaborCents: 30000,
  allocatedOverheadCents: 3500, cashGrossProfitCents: 129000, economicProfitCents: 99000,
  companyNetProfitCents: 125500, economicNetProfitCents: 95500,
  taxReserveCents: 25100, distributableProfitCents: 100400 }) }

const month = aggregateMoves([profitable, lossMaking, refunded, ownerWorked], 'FINALIZED_ONLY')
const label = describeBasis('CASH', 'FINALIZED_ONLY', { finalized: month.finalizedCount, provisional: month.provisionalCount })
console.log(`  Basis: ${label.label}`)
row('Net billed revenue (accrual)', fmtCents(revenueForBasis(month, 'ACCRUAL')))
row('Net collected revenue (cash)', fmtCents(revenueForBasis(month, 'CASH')))
row('Outstanding balances', fmtCents(month.outstandingBalanceCents), 'NOT profit')
row('Direct job costs', fmtCents(month.directJobCostCents))
row('Cash gross profit', fmtCents(month.cashGrossProfitCents))
row('- Unpaid owner labor', fmtCents(month.ownerEconomicLaborCents))
row('Economic profit', fmtCents(month.economicProfitCents))
row('Allocated overhead', fmtCents(month.allocatedOverheadCents))
row('Company net profit', fmtCents(month.companyNetProfitCents), `${((month.marginBp ?? 0) / 100).toFixed(1)}% margin`)
row('Tax reserves', fmtCents(month.taxReserveCents))
row('Distributable profit', fmtCents(month.distributableProfitCents))
console.log(`\n  Sum of snapshot net profit = ${fmtCents([profitable, lossMaking, refunded, ownerWorked].reduce((s, m) => s + (m.snapshot?.companyNetProfitCents ?? 0), 0))}`)
console.log(`  Report total               = ${fmtCents(month.companyNetProfitCents)}  <- must match`)
console.log(`  The loss-making move is included as a NEGATIVE, not hidden.`)

// ── 2. Finalized vs provisional ─────────────────────────────────────────────
rule('SCENARIO 2 — Finalized totals are never silently mixed with provisional')

const provisional: MoveFinancialRow = { bookingId: 'p1', isFinalized: false, provisional: fig({
  netBilledRevenueCents: 150000, netCollectedRevenueCents: 150000,
  directJobCostCents: 60000, cashGrossProfitCents: 90000,
  companyNetProfitCents: 90000, economicNetProfitCents: 90000 }) }
const openMove: MoveFinancialRow = { bookingId: 'p2', isFinalized: false, provisional: null }

const all = [profitable, refunded, provisional, openMove]
const finalOnly = aggregateMoves(all, 'FINALIZED_ONLY')
const combined = aggregateMoves(all, 'COMBINED')
row('FINALIZED_ONLY net profit', fmtCents(finalOnly.companyNetProfitCents), `${finalOnly.finalizedCount} moves`)
row('COMBINED net profit', fmtCents(combined.companyNetProfitCents), `${combined.finalizedCount} final + ${combined.provisionalCount} provisional`)
row('Moves with no usable figures', String(combined.unusableCount), 'counted, not dropped')
const cLabel = describeBasis('CASH', 'COMBINED', { finalized: combined.finalizedCount, provisional: combined.provisionalCount })
console.log(`\n  Mixed? ${isMixedSource(combined)}`)
console.log(`  Disclosure: "${cLabel.warning}"`)

// ── 3. Door-hanger campaign ─────────────────────────────────────────────────
rule('SCENARIO 3 — Door-hanger campaign: 5,000 printed')

const dh = scoreMarketingSource({
  sourceKey: 'DOOR_HANGER_SPRING_2026',
  spend: { totalSpendCents: 45000 }, // $300 print + $150 distribution
  funnel: { scans: 120, leads: 20, quotes: 12, bookings: 5, completedMoves: 4, finalizedMoves: 4 },
  money: { netCollectedRevenueCents: 600000, finalizedNetProfitCents: 180000, provisionalNetProfitCents: 0, directCostCents: 420000 },
})
row('Print quantity', '5,000')
row('Total spend', fmtCents(dh.spendCents))
row('QR scans / leads / quotes', `${dh.funnel.scans} / ${dh.funnel.leads} / ${dh.funnel.quotes}`)
row('Bookings / completed / finalized', `${dh.funnel.bookings} / ${dh.funnel.completedMoves} / ${dh.funnel.finalizedMoves}`)
row('Cost per lead', fmtCents(dh.costPerLeadCents ?? 0))
row('Cost per booking', fmtCents(dh.costPerBookingCents ?? 0))
row('Cost per completed move', fmtCents(dh.costPerCompletedMoveCents ?? 0))
row('Net collected revenue', fmtCents(dh.money.netCollectedRevenueCents))
row('FINALIZED net profit', fmtCents(dh.money.finalizedNetProfitCents))
row('Revenue ROAS', formatRoas(dh.revenueRoasBp))
row('Profit ROAS', formatRoas(dh.profitRoasBp), 'THE metric')
row('Profit after paying for it', fmtCents(dh.netOfSpendCents))
console.log(`\n  Profitable: ${dh.profitable}`)

const vanity = scoreMarketingSource({
  sourceKey: 'HIGH_REVENUE_LOSER', spend: { totalSpendCents: 45000 },
  funnel: { leads: 60, quotes: 40, bookings: 20, completedMoves: 20, finalizedMoves: 20 },
  money: { netCollectedRevenueCents: 1_000_000, finalizedNetProfitCents: -50000, provisionalNetProfitCents: 0, directCostCents: 1_050_000 },
})
console.log(`  Counter-example — revenue ROAS ${formatRoas(vanity.revenueRoasBp)} looks great, profit ROAS ${formatRoas(vanity.profitRoasBp)}: profitable=${vanity.profitable}`)

// ── 4. Estimate variance ────────────────────────────────────────────────────
rule('SCENARIO 4 — Estimated 6 hours, actual 10 hours')

const v = computeVariance({
  estimatedPriceCents: 90000, actualBilledCents: 90000,
  estimatedMinutes: 360, actualMinutes: 600,
  estimatedCrewMinutes: 720, actualCrewMinutes: 1200,
  estimatedLaborCents: 36000, actualLaborCents: 60000,
  estimatedTruckCents: 12000, actualTruckCents: 12000,
  estimatedExpenseCents: 5000, actualExpenseCents: 5200,
  actualMarginBp: 1200,
})
for (const l of v.lines) {
  const est = l.estimated == null ? '—' : l.unit === 'cents' ? fmtCents(l.estimated) : `${l.estimated}`
  const act = l.actual == null ? '—' : l.unit === 'cents' ? fmtCents(l.actual) : `${l.actual}`
  const varc = l.varianceBp == null ? (l.note ?? '—') : `${(l.varianceBp / 100).toFixed(1)}%`
  console.log(`  ${l.metric.padEnd(18)} est ${est.padStart(11)}  act ${act.padStart(11)}  ${varc.padStart(20)}  ${l.severity}`)
}
console.log(`\n  Overall: ${v.severity}`)
v.flags.forEach((f) => console.log(`    [${f.severity}] ${f.code}: ${f.message}`))

const scoped = computeVariance({ estimatedMinutes: 360, actualMinutes: 600, estimatedStops: 1, actualStops: 3 })
console.log(`\n  Same overrun WITH a scope change -> scopeChanged=${scoped.scopeChanged}: ${scoped.scopeChangeReasons.join('; ')}`)
console.log('  The estimate is not blamed for a move the customer changed.')

// ── 5. Customer lifetime value ──────────────────────────────────────────────
rule('SCENARIO 5 — Repeat customer: realized lifetime value')

const custMoves = [profitable, refunded, ownerWorked]
const cust = aggregateMoves(custMoves, 'FINALIZED_ONLY')
const acquisitionCostCents = dh.costPerBookingCents ?? 0
row('Completed (finalized) moves', String(cust.finalizedCount))
row('Total billed', fmtCents(cust.netBilledRevenueCents))
row('Total collected', fmtCents(cust.netCollectedRevenueCents))
row('Finalized company net profit', fmtCents(cust.companyNetProfitCents))
row('- Attributed acquisition cost', fmtCents(acquisitionCostCents), 'cost per booking')
row('= Realized customer value', fmtCents(cust.companyNetProfitCents - acquisitionCostCents))
console.log('\n  Realized, not projected. A forecast would be labelled as one.')

// ── 6. Export security ──────────────────────────────────────────────────────
rule('SCENARIO 6 — Export security: a hostile customer note')

const EVIL = '=HYPERLINK("http://evil.example/steal","Click for refund")'
const COLUMNS: ExportColumn[] = [
  { key: 'moveId', header: 'Move ID' },
  { key: 'customer', header: 'Customer' },
  { key: 'note', header: 'Customer note' },
  { key: 'netCollectedCents', header: 'Net collected', money: true },
  { key: 'companyNetProfitCents', header: 'Company net profit', money: true, roles: ['OWNER'] },
]
const ROWS = [{ moveId: 'WMIC-1042', customer: 'Sam Rivera', note: EVIL, netCollectedCents: 200000, companyNetProfitCents: 74000 }]
const META: ExportMeta = {
  businessName: 'Move It Clear It', reportTitle: 'Move profitability',
  generatedAt: new Date('2026-07-20T15:00:00Z'), basisLabel: describeBasis('CASH', 'FINALIZED_ONLY').label,
  periodLabel: 'June 2026', currency: 'USD', recordCount: 1,
}

console.log(`  Raw note   : ${EVIL}`)
console.log(`  Sanitized  : ${sanitizeCell(EVIL)}`)
console.log(`  Neutralized: ${sanitizeCell(EVIL).startsWith("'")}   Original preserved: ${sanitizeCell(EVIL).slice(1) === EVIL}`)

const ownerDec = canExport({ role: 'OWNER', allowed: true, columns: COLUMNS, rowCount: 1, format: 'CSV' })
const mgrDec = canExport({ role: 'MANAGER', allowed: true, columns: COLUMNS, rowCount: 1, format: 'CSV' })
console.log(`\n  OWNER columns  : ${ownerDec.allow ? ownerDec.columns.map((c) => c.key).join(', ') : 'denied'}`)
console.log(`  MANAGER columns: ${mgrDec.allow ? mgrDec.columns.map((c) => c.key).join(', ') : 'denied'}   <- profit withheld`)

if (mgrDec.allow) {
  const csv = toCsv(mgrDec.columns, ROWS, META)
  console.log(`\n  CSV excerpt:`)
  csv.split('\r\n').slice(0, 4).forEach((l) => console.log(`    ${l}`))
  console.log(`    ...`)
  console.log(`  CSV contains profit column: ${csv.includes('Company net profit')}`)
  const xml = toXlsxXml(mgrDec.columns, ROWS, META)
  console.log(`  XLSX neutralized + escaped: ${(xml.includes("'=") || xml.includes('&#039;=')) && !xml.includes('<script>')}`)
}
const bad = canExport({ role: 'OWNER', allowed: true, columns: [{ key: 'receiptUrl', header: 'Receipt' }], rowCount: 1, format: 'CSV' })
console.log(`  Private receiptUrl export : ${bad.allow ? 'ALLOWED' : 'BLOCKED'}`)
console.log(`  Audit record keys         : ${Object.keys(buildExportAudit({ userId: 'u', userName: 'Diego', reportType: 'move-profitability', format: 'CSV', periodLabel: 'June 2026', basisLabel: META.basisLabel, filters: {}, columnKeys: ['moveId'], recordCount: 1, success: true })).join(', ')}`)
console.log('  (no exported content is ever logged)')

// ── 7. Action Center ────────────────────────────────────────────────────────
rule('SCENARIO 7 — Action Center: appears once, resolves automatically')

const base: CloseoutActionInput = {
  bookingId: 'bk1', bookingReference: 'WMIC-1042', customerName: 'Sam Rivera',
  status: 'COMPLETED', completedAt: new Date('2026-07-10T20:00:00Z'), isFinalized: false,
  blockerCodes: ['RECEIPT_MISSING', 'OUTSTANDING_BALANCE'], overriddenCodes: [],
  canFinalize: false, submittedForReview: false, companyNetProfitCents: 5000, marginBp: 800,
  outstandingBalanceCents: 50000, unpaidLaborCents: 20000, ownerReimbursementOwedCents: 0,
  pendingDistributionCents: 0, estimateSeverity: 'OK', marketingSourceUnknown: false,
  targetMarginBp: 2000, closeoutGraceDays: 3, now: new Date('2026-07-20T15:00:00Z'),
}
const first = dedupeActions(financialActionsForMove(base))
first.forEach((a) => console.log(`  [${a.severity.padEnd(8)}] ${a.rule.padEnd(32)} -> ${a.sourceUrl}`))

const twice = dedupeActions([...financialActionsForMove(base), ...financialActionsForMove(base)])
console.log(`\n  Scanned twice: ${first.length} action(s) -> ${twice.length} after dedupe (no duplicates)`)

const fixed = financialActionsForMove({ ...base, blockerCodes: [], outstandingBalanceCents: 0, unpaidLaborCents: 0, companyNetProfitCents: 60000, marginBp: 3000, canFinalize: true })
const gone = resolvedKeys(first.map((a) => a.dedupeKey), fixed)
console.log(`  After fixing the conditions, auto-resolved:`)
gone.forEach((k) => console.log(`    ${k}`))
console.log(`  Remaining: ${fixed.map((a) => a.rule).join(', ')}`)

// ── 8. Pricing recommendation ───────────────────────────────────────────────
rule('SCENARIO 8 — Pricing recommendation from finalized comparables')

const cmp = (i: number, price: number, cost: number): ComparableMove => ({
  bookingId: `h${i}`, serviceType: 'APARTMENT', crewSize: 2, actualMinutes: 360, stops: 1,
  originCity: 'Newark', truckSource: 'CUSTOMER_PROVIDED',
  netCollectedRevenueCents: price, directJobCostCents: cost,
  crewLaborCents: Math.round(cost * 0.7), companyNetProfitCents: price - cost,
  marginBp: Math.round(((price - cost) / price) * 10_000),
})
const QUERY = { serviceType: 'APARTMENT', crewSize: 2, estimatedMinutes: 360, stops: 1, city: 'Newark', truckSource: 'CUSTOMER_PROVIDED' }

const thin = recommendPrice(QUERY, [cmp(1, 90000, 50000), cmp(2, 95000, 52000)])
console.log(`  With 2 comparables -> ${thin.confidence}: ${thin.confidenceText}`)
console.log(`    suggested range: ${thin.suggestedRange ? 'yes' : 'NONE'}`)
thin.caveats.forEach((c) => console.log(`    - ${c}`))

const rec = recommendPrice(QUERY, [cmp(1, 80000, 50000), cmp(2, 90000, 52000), cmp(3, 100000, 55000), cmp(4, 95000, 53000), cmp(5, 85000, 51000), cmp(6, 92000, 54000), cmp(7, 300000, 52000)])
console.log(`\n  With 7 comparables -> ${rec.confidence} (${rec.comparableCount} used, ${rec.outliersDropped} outlier dropped)`)
row('  Median customer price', fmtCents(rec.medianPriceCents ?? 0))
row('  Median direct cost', fmtCents(rec.medianDirectCostCents ?? 0))
row('  Median profit', fmtCents(rec.medianProfitCents ?? 0))
row('  Break-even price', fmtCents(rec.breakEvenPriceCents ?? 0))
row('  Lowest profitable price', fmtCents(rec.lowestProfitablePriceCents ?? 0))
row('  Suggested range', `${fmtCents(rec.suggestedRange!.lowCents)} – ${fmtCents(rec.suggestedRange!.highCents)}`)
console.log(`  Assumptions: ${rec.assumptions.join(' · ')}`)
rec.caveats.forEach((c) => console.log(`    - ${c}`))
console.log(`  Quote applied automatically: ${rec.quoteApplied}   <- always false`)

const be = computeBreakEven({
  crewSize: 2, estimatedMinutes: 360, hourlyRateCents: 2500,
  ownerUnpaidMinutes: 360, ownerEconomicRateCents: 3000,
  truckCents: 12000, fuelCents: 4000, tollsCents: 1500, suppliesCents: 2000,
  overheadCents: 3500, processingFeeBp: 290, targetMarginBp: 2000,
})
console.log(`\n  Break-even for this move:`)
row('  Direct-cost break-even', fmtCents(be.directCostBreakEvenCents))
row('  CASH break-even', fmtCents(be.cashBreakEvenCents), 'incl. overhead')
row('  ECONOMIC break-even', fmtCents(be.economicBreakEvenCents), 'incl. unpaid owner time')
row('  Target price (20% margin)', fmtCents(be.targetPriceCents))
row('  Expected cash profit', fmtCents(be.expectedCashProfitCents))
row('  Expected economic profit', fmtCents(be.expectedEconomicProfitCents))
console.log(`  Assumptions: ${be.assumptions.join(' · ')}`)

// ── Time zone + attribution integrity ───────────────────────────────────────
rule('INTEGRITY — time zone, safe comparison, immutable first-touch')

const lateJan = new Date('2026-02-01T01:00:00Z') // 31 Jan, 8pm ET
const jan = resolvePeriod('this_month', lateJan)
console.log(`  A move at 8pm on 31 Jan (01:00 UTC 1 Feb) falls in: ${jan.label} -> ${inPeriod(lateJan, jan)}`)
console.log(`  Period ${jan.label}: ${formatBusinessDate(jan.start)} .. ${formatBusinessDate(new Date(jan.end.getTime() - 1))}`)

const d0 = compareCents(50000, 0)
console.log(`  Change vs a zero prior period: changeBp=${d0.changeBp}  note="${d0.note}"`)

const attrib = { firstTouchSource: 'DOOR_HANGER', lastTouchSource: 'GOOGLE', bookingSource: 'WEBSITE', ownerAssignedSource: 'REFERRAL' }
console.log(`\n  first-touch=${resolveAttribution(attrib, 'FIRST_TOUCH').source}  last-touch=${resolveAttribution(attrib, 'LAST_TOUCH').source}  booking=${resolveAttribution(attrib, 'BOOKING').source}`)
const attempt = canCorrectAttribution('firstTouchSource', 'customer said Google')
console.log(`  Overwriting first touch: ${attempt.allow ? 'ALLOWED' : 'BLOCKED'}`)
if (!attempt.allow) console.log(`    -> ${attempt.error}`)

console.log('\n' + '='.repeat(78))
console.log('All figures are SYNTHETIC and produced by the real reporting modules.')
console.log('No database was read.')
console.log('='.repeat(78) + '\n')
