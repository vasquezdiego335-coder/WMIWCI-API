// Phase 0 evidence generator — SYNTHETIC DATA ONLY, no database access.
// Prints the exact figures the corrected admin now renders, next to what the
// pre-Phase-0 code produced, so the corrections are inspectable without a DB.
//
//   npx tsx scripts/phase0-evidence.ts

import { computeJobProfit, crewPayOwedCents, distributablePosition, taxReserveCentsFor, fmtCents } from '../src/lib/profit'
import { summarizeRevenue, eligibleExpenseCents } from '../src/lib/money-rules'
import { estimateBusinessCash, operatingProfitCents } from '../src/lib/owner-ledger'
import { evaluateFinancialCompleteness, completenessLabel, canFinalizeFinancials } from '../src/lib/financial-completeness'

const rule = (t: string) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`)
const row = (label: string, value: string, note = '') =>
  console.log(`  ${label.padEnd(38)}${value.padStart(14)}  ${note}`)

// ── 1. A COMPLETE move: the owner's real $2,000 example ─────────────────────
rule('1. MOVE WITH COMPLETE FINANCIAL DATA (the $2,000 -> $1,175 example)')

const completeCrew = [
  { flatPay: 40000, payStatus: 'PAID' },   // Diego, $400 flat
  { flatPay: 40000, payStatus: 'PAID' },   // Sebastian, $400 flat
]
const completeExpenses = [
  { amount: 22000, status: 'APPROVED' },   // U-Haul $220
  { amount: 8500, status: 'APPROVED' },    // fuel $85
  { amount: 2400, status: 'APPROVED' },    // tolls $24
  { amount: 3800, status: 'APPROVED' },    // crew food $38
  { amount: 4300, status: 'SUBMITTED' },   // supplies $43 (counts, unreviewed)
]
const completePayments = [
  { amount: 4900, status: 'COMPLETED', isStripe: true },     // $49 deposit
  { amount: 195100, status: 'COMPLETED', isStripe: false },  // $1,951 move-day cash
]

const complete = computeJobProfit({ payments: completePayments, crew: completeCrew, expenses: completeExpenses })
const completeStatus = evaluateFinancialCompleteness({
  status: 'COMPLETED', crew: completeCrew, expenses: completeExpenses, payments: completePayments,
})

row('Captured payments', fmtCents(complete.grossCapturedCents))
row('Net revenue collected', fmtCents(complete.netRevenueCents))
row('- Crew pay', fmtCents(complete.crewPayCents), '2 owners x $400 flat')
row('- Job expenses', fmtCents(complete.expenseCents), 'truck/fuel/tolls/food/supplies')
row('- Stripe fees (est.)', fmtCents(complete.stripeFeeCents), 'deposit only; cash has no fee')
row('= Gross profit', fmtCents(complete.netProfitCents))
row('Margin', `${Math.round((complete.marginPct ?? 0) * 100)}%`)
console.log(`\n  STATUS: ${completeStatus.status} -> badge "${completenessLabel(completeStatus)}"`)
console.log(`  Warnings: ${completeStatus.warnings.length ? completeStatus.warnings.join(' | ') : '(none)'}`)
console.log(`  Finalization: ${canFinalizeFinancials({ completeness: completeStatus, override: false, role: 'OWNER' }).allow ? 'ALLOWED' : 'BLOCKED'}`)

// ── 2. The SAME move with no labor recorded (today's reality) ───────────────
rule('2. THE SAME MOVE WITH NO CREW LABOR RECORDED (what the admin shows today)')

const noLabor = computeJobProfit({ payments: completePayments, crew: [], expenses: completeExpenses })
const noLaborStatus = evaluateFinancialCompleteness({
  status: 'COMPLETED', crew: [], expenses: completeExpenses, payments: completePayments,
})

row('Net revenue collected', fmtCents(noLabor.netRevenueCents))
row('- Crew pay', 'not recorded', 'was silently "$0.00" before Phase 0')
row('- Job expenses', fmtCents(noLabor.expenseCents))
row('- Stripe fees (est.)', fmtCents(noLabor.stripeFeeCents))
row('= Gross profit (incomplete)', fmtCents(noLabor.netProfitCents))
console.log(`\n  Overstated by ${fmtCents(noLabor.netProfitCents - complete.netProfitCents)} vs the complete record.`)
console.log(`  STATUS: ${noLaborStatus.status} -> badge "${completenessLabel(noLaborStatus)}"`)
noLaborStatus.warnings.forEach((w) => console.log(`    ! ${w}`))
const blocked = canFinalizeFinancials({ completeness: noLaborStatus, override: false, role: 'OWNER' })
console.log(`  Finalization: ${blocked.allow ? 'ALLOWED' : 'BLOCKED'}`)
if (!blocked.allow) console.log(`    -> ${blocked.error}`)
const overridden = canFinalizeFinancials({ completeness: noLaborStatus, override: true, role: 'OWNER', reason: 'Owners worked unpaid; treating labor as a draw this month.' })
console.log(`  Owner override with a reason: ${overridden.allow ? 'ALLOWED (audited)' : 'BLOCKED'}`)
console.log(`  Manager override attempt: ${canFinalizeFinancials({ completeness: noLaborStatus, override: true, role: 'MANAGER', reason: 'x' }).allow ? 'ALLOWED' : 'BLOCKED (403)'}`)

// ── 3. CONFIRMED zero labor is not the same thing ──────────────────────────
rule('3. CONFIRMED $0 LABOR vs MISSING LABOR')

const confirmedZero = evaluateFinancialCompleteness({
  status: 'COMPLETED', crew: [{ flatPay: 0, actualHours: 0, payRate: 0 }], expenses: completeExpenses, payments: completePayments,
})
row('Crew rows exist with explicit 0', confirmedZero.laborConfirmedZero ? 'CONFIRMED $0' : '-', 'renders "$0.00 (confirmed)"')
row('No crew rows at all', noLaborStatus.missingLabor ? 'UNKNOWN' : '-', 'renders "not recorded"')
console.log(`\n  Confirmed-zero move is complete: ${confirmedZero.isComplete}`)
console.log(`  Missing-labor move is complete:  ${noLaborStatus.isComplete}`)

// ── 4. Partial refund ──────────────────────────────────────────────────────
rule('4. PARTIAL REFUND: $2,000 captured, $200 refunded')

const refundPayments = [{ amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: 20000, isStripe: false }]
const refunded = computeJobProfit({ payments: refundPayments, crew: [], expenses: [] })

console.log('  BEFORE Phase 0:')
console.log('    revenue    $0.00      (status != COMPLETED, so the row was dropped)')
console.log('    - refunds  $2,000.00  (full face value charged as a cost)')
console.log('    = profit   -$2,000.00 <- WRONG')
console.log('\n  AFTER Phase 0:')
row('Captured', fmtCents(refunded.grossCapturedCents))
row('- Refunded (actual amount)', fmtCents(refunded.refundedCents), 'from Payment.refundedAmountCents')
row('= Net revenue collected', fmtCents(refunded.netRevenueCents), 'CORRECT')
row('Total costs (no refund line)', fmtCents(refunded.totalCostsCents), 'refunds are netted off revenue')
row('= Gross profit', fmtCents(refunded.netProfitCents))

console.log('\n  Other refund shapes:')
for (const [label, p] of [
  ['no refund', { amount: 200000, status: 'COMPLETED' }],
  ['full refund', { amount: 200000, status: 'REFUNDED', refundedAmountCents: 200000 }],
  ['failed payment', { amount: 200000, status: 'FAILED' }],
  ['authorized, not captured', { amount: 4900, status: 'PENDING' }],
  ['lost chargeback', { amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_1', disputeStatus: 'lost' }],
  ['open dispute', { amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_2', disputeStatus: 'needs_response' }],
] as const) {
  const r = summarizeRevenue([p as never])
  row(`  ${label}`, fmtCents(r.netCollectedCents), r.pendingDisputeCents > 0 ? `${fmtCents(r.pendingDisputeCents)} at risk` : r.authorizedNotCapturedCents > 0 ? `${fmtCents(r.authorizedNotCapturedCents)} held` : '')
}

// ── 5. Rejected expense ────────────────────────────────────────────────────
rule('5. REJECTED EXPENSE IS EXCLUDED EVERYWHERE')

const mixed = [
  { amount: 22000, status: 'APPROVED' },
  { amount: 8500, status: 'SUBMITTED' },
  { amount: 50000, status: 'REJECTED' }, // a $500 personal purchase, rejected
]
row('All rows, naive sum', fmtCents(mixed.reduce((s, e) => s + e.amount, 0)), 'what the dashboard used to show')
row('Eligible only', fmtCents(eligibleExpenseCents(mixed)), 'what Owner Money showed')
console.log('\n  Both pages now report the eligible figure — the $500 rejected row is')
console.log('  still listed (struck through) but counted in NO total.')

// ── 6. Safe to distribute ──────────────────────────────────────────────────
rule('6. SAFE TO DISTRIBUTE: paying a worker must not create distributable cash')

const LABOR = 80000 // $800 of crew labor
const REVENUE = 200000
const EXPENSES = 41000
const ownerTxs = [{ owner: 'DIEGO', type: 'CONTRIBUTION', amount: 100000, approvalStatus: 'APPROVED' }]

const cashAccrued = estimateBusinessCash({ netRevenueCents: REVENUE, expenseCents: EXPENSES, paidLaborCents: 0, ownerTxs })
const cashSettled = estimateBusinessCash({ netRevenueCents: REVENUE, expenseCents: EXPENSES, paidLaborCents: LABOR, ownerTxs })

const opAccrued = operatingProfitCents({ netRevenueCents: REVENUE, expenseCents: EXPENSES, laborCents: LABOR })
const tax = taxReserveCentsFor(opAccrued, 25)

const accrued = distributablePosition({
  cashAvailableCents: cashAccrued, unpaidLaborCents: LABOR, upcomingBillsCents: 0,
  ownerReimbursementsOwedCents: 0, pendingRefundCents: 0, taxReserveCents: tax, emergencyReserveCents: 50000,
})
const settled = distributablePosition({
  cashAvailableCents: cashSettled, unpaidLaborCents: 0, upcomingBillsCents: 0,
  ownerReimbursementsOwedCents: 0, pendingRefundCents: 0, taxReserveCents: tax, emergencyReserveCents: 50000,
})

console.log('  Labor of $800 ACCRUED (not yet paid):')
row('  Estimated business cash', fmtCents(cashAccrued))
row('  - Unpaid worker pay', fmtCents(LABOR))
row('  - Tax reserve (25% of op profit)', fmtCents(tax))
row('  - Emergency reserve', fmtCents(50000))
row('  = Safe to distribute', fmtCents(accrued.distributableCents))

console.log('\n  The SAME labor after being PAID:')
row('  Estimated business cash', fmtCents(cashSettled), 'cash dropped by the $800 paid')
row('  - Unpaid worker pay', fmtCents(0), 'nothing left owing')
row('  - Tax reserve', fmtCents(tax))
row('  - Emergency reserve', fmtCents(50000))
row('  = Safe to distribute', fmtCents(settled.distributableCents))

console.log(`\n  Difference: ${fmtCents(settled.distributableCents - accrued.distributableCents)}  <- must be $0.00`)
console.log('  BEFORE Phase 0 this jumped UP by $800.00 the moment a worker was paid,')
console.log('  because paid labor left the business but never left the calculation.')

const short = distributablePosition({
  cashAvailableCents: 10000, unpaidLaborCents: 50000, upcomingBillsCents: 0,
  ownerReimbursementsOwedCents: 12000, pendingRefundCents: 0, taxReserveCents: 0, emergencyReserveCents: 0,
})
console.log('\n  Negative position (obligations exceed cash):')
row('  Raw position', fmtCents(short.rawCents), 'displayed in red')
row('  Shortfall', fmtCents(short.shortfallCents), '"Do not distribute"')
row('  Actually distributable', fmtCents(short.distributableCents))
console.log('  A shortfall is reported, never silently clamped to a reassuring $0.00.')

console.log('\n' + '='.repeat(74))
console.log('All figures above are SYNTHETIC. No database was read.')
console.log('='.repeat(74) + '\n')
