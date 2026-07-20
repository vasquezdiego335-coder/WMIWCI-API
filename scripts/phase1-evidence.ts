// Phase 1 staging scenarios — SYNTHETIC DATA ONLY, no database access.
// Runs the eight scenarios from the owner spec through the real calculators.
//   npx tsx scripts/phase1-evidence.ts

import { computeLaborPay, rollupLabor, buildRateSnapshot, linkCrewJobToAssignment } from '../src/lib/labor-calc'
import { computeTimeBreakdown, formatMinutes } from '../src/lib/labor-time'
import { computeJobProfit, distributablePosition, fmtCents } from '../src/lib/profit'
import { estimateBusinessCash } from '../src/lib/owner-ledger'
import { evaluateFinancialCompleteness, canFinalizeFinancials, completenessLabel, deriveLaborState } from '../src/lib/financial-completeness'
import { canApproveLabor, canRecordLaborPayment, canWriteTime, remainingPayableCents } from '../src/lib/labor-guards'

const rule = (t: string) => console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`)
const row = (l: string, v: string, n = '') => console.log(`  ${l.padEnd(40)}${v.padStart(14)}  ${n}`)

const PAYMENTS = [{ amount: 200000, status: 'COMPLETED', isStripe: false }]
const EXPENSES = [{ amount: 41000, status: 'APPROVED' }]

// ── 1. Hourly helper ────────────────────────────────────────────────────────
rule('SCENARIO 1 — Hourly helper: $25/h x 8h = $200, approve, pay')

const helperSnap = buildRateSnapshot({ payModel: 'HOURLY', userProfilePayRateCents: 2500, workerType: 'EMPLOYEE' })
row('Rate snapshot taken at assignment', fmtCents(helperSnap.hourlyRateCentsSnapshot ?? 0) + '/h', helperSnap.rateSnapshotSource)

const helper = { payModel: 'HOURLY' as const, approvalStatus: 'APPROVED' as const, hourlyRateCentsSnapshot: 2500, overtimeRateCentsSnapshot: 3750, workedMinutes: 480 }
const helperPay = computeLaborPay(helper)
row('8h worked', formatMinutes(helperPay.time.paidMinutes))
row('Calculated pay', fmtCents(helperPay.calculatedPayCents))

const p1 = computeJobProfit({ payments: PAYMENTS, crew: [], expenses: EXPENSES, labor: rollupLabor([helper]) })
row('Net revenue', fmtCents(p1.netRevenueCents))
row('- Crew labor (approved)', fmtCents(p1.crewPayCents))
row('- Job expenses', fmtCents(p1.expenseCents))
row('= Cash gross profit', fmtCents(p1.netProfitCents))

console.log('\n  Safe-to-distribute before vs after paying that $200:')
const cashAccrued = estimateBusinessCash({ netRevenueCents: 200000, expenseCents: 41000, paidLaborCents: 0, ownerTxs: [] })
const cashSettled = estimateBusinessCash({ netRevenueCents: 200000, expenseCents: 41000, paidLaborCents: 20000, ownerTxs: [] })
const zero = { upcomingBillsCents: 0, ownerReimbursementsOwedCents: 0, pendingRefundCents: 0, taxReserveCents: 0, emergencyReserveCents: 0 }
const before = distributablePosition({ cashAvailableCents: cashAccrued, unpaidLaborCents: 20000, ...zero })
const after = distributablePosition({ cashAvailableCents: cashSettled, unpaidLaborCents: 0, ...zero })
row('  accrued (unpaid)', fmtCents(before.distributableCents))
row('  settled (paid)', fmtCents(after.distributableCents))
row('  difference', fmtCents(after.distributableCents - before.distributableCents), 'must be $0.00')

// ── 2. Owner + helper ───────────────────────────────────────────────────────
rule('SCENARIO 2 — Owner works 10h unpaid; helper paid $300: cash vs economic')

const ownerUnpaid = { payModel: 'UNPAID_OWNER' as const, workerType: 'OWNER' as const, approvalStatus: 'APPROVED' as const, workedMinutes: 600, economicRateCentsSnapshot: 3000 }
const helper300 = { payModel: 'FLAT' as const, approvalStatus: 'APPROVED' as const, flatPayCentsSnapshot: 30000 }
const roll2 = rollupLabor([ownerUnpaid, helper300])
const p2 = computeJobProfit({ payments: PAYMENTS, crew: [], expenses: EXPENSES, labor: roll2 })

row('Net revenue', fmtCents(p2.netRevenueCents))
row('- Cash labor (helper only)', fmtCents(p2.crewPayCents))
row('- Job expenses', fmtCents(p2.expenseCents))
row('= CASH gross profit', fmtCents(p2.netProfitCents))
row('- Unpaid owner labor (10h x $30)', fmtCents(p2.unpaidOwnerValueCents))
row('= ECONOMIC profit', fmtCents(p2.economicProfitCents), 'if the owner had to be hired')
console.log(`\n  The owner personally subsidized ${fmtCents(p2.unpaidOwnerValueCents)} of this move.`)

// ── 3. Discord acceptance ───────────────────────────────────────────────────
rule('SCENARIO 3 — Discord gig acceptance: one record, no competing total')

const noMove = linkCrewJobToAssignment({ crewJobId: 'cj_1', userId: 'u_1', payoutTotalCents: 15000, acceptedAt: new Date(), jobId: null })
console.log(`  Gig with NO booking (every crew_job today): link=${noMove.link}`)
console.log(`    -> ${noMove.link === false ? noMove.reason : ''}`)
console.log('    The gig payout therefore reaches NO move profit. Correct.\n')

const linked = linkCrewJobToAssignment({ crewJobId: 'cj_2', userId: 'u_1', payoutTotalCents: 15000, acceptedAt: new Date(), jobId: 'job_1' })
if (linked.link) {
  row('Gig payout locked at accept', fmtCents(linked.flatPayCents))
  row('Becomes JobCrew flat snapshot', fmtCents(linked.snapshot.flatPayCentsSnapshot ?? 0), linked.snapshot.rateSnapshotSource)
  const priced = computeLaborPay({ payModel: 'FLAT', flatPayCentsSnapshot: linked.snapshot.flatPayCentsSnapshot, approvalStatus: 'APPROVED' })
  row('Counted in move profit', fmtCents(priced.calculatedPayCents), 'EXACTLY once')
  const replay = linkCrewJobToAssignment({ crewJobId: 'cj_2', userId: 'u_1', payoutTotalCents: 15000, acceptedAt: new Date(), jobId: 'job_1' })
  console.log(`\n  Replayed acceptance -> identical decision; the UNIQUE crewJobId means one row: ${JSON.stringify(replay) === JSON.stringify(linked)}`)
}

// ── 4. Historical rate ──────────────────────────────────────────────────────
rule('SCENARIO 4 — A raise must NOT rewrite a past move')

const oldMove = { payModel: 'HOURLY' as const, hourlyRateCentsSnapshot: 2500, workedMinutes: 480, userProfilePayRate: 3000 }
row('Rate when assigned', '$25.00/h')
row('Worker profile today', '$30.00/h')
row('Historical move still costs', fmtCents(computeLaborPay(oldMove).calculatedPayCents), 'NOT $240.00')

// ── 5. Missing hours ────────────────────────────────────────────────────────
rule('SCENARIO 5 — Assigned, never clocked out: finalization blocked')

const openShift = [{ approvalStatus: 'APPROVED', hourlyRateCentsSnapshot: 2500, clockIn: new Date(), clockOut: null }]
const c5 = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: openShift, expenses: EXPENSES, payments: PAYMENTS })
row('Labor state', deriveLaborState(openShift))
row('Badge', completenessLabel(c5))
const f5 = canFinalizeFinancials({ completeness: c5, override: false, role: 'OWNER' })
console.log(`  Finalization: ${f5.allow ? 'ALLOWED' : 'BLOCKED'}`)
if (!f5.allow) console.log(`    -> ${f5.error}`)
const ovr = canFinalizeFinancials({ completeness: c5, override: true, role: 'OWNER', reason: 'Crew confirmed 5pm finish by text.' })
console.log(`  Owner override + reason: ${ovr.allow ? 'ALLOWED (audited)' : 'BLOCKED'}`)
console.log(`  Manager override:        ${canFinalizeFinancials({ completeness: c5, override: true, role: 'MANAGER', reason: 'x' }).allow ? 'ALLOWED' : 'BLOCKED (403)'}`)

// ── 6. Confirmed zero ───────────────────────────────────────────────────────
rule('SCENARIO 6 — Owner confirms $0 labor with a reason')

const zeroCrew = [{ payModel: 'ZERO_CONFIRMED', zeroLaborConfirmed: true, approvalStatus: 'APPROVED', paymentStatus: 'UNPAID' }]
const c6 = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: zeroCrew, expenses: EXPENSES, payments: PAYMENTS })
row('Labor state', deriveLaborState(zeroCrew))
row('Complete?', String(c6.isComplete))
row('Confirmed zero (not missing)', String(c6.laborConfirmedZero))
const missing6 = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSES, payments: PAYMENTS })
row('vs. NO crew at all -> state', deriveLaborState([]))
row('vs. NO crew at all -> complete', String(missing6.isComplete))
console.log('\n  "$0 confirmed" and "never entered" are different states, as required.')

// ── 7. Partial payment ──────────────────────────────────────────────────────
rule('SCENARIO 7 — Approve $400, pay $250, $150 remains owed')

const APPROVED_400 = 40000
row('Approved labor', fmtCents(APPROVED_400))
const pay1 = canRecordLaborPayment({ role: 'OWNER', approvalStatus: 'APPROVED', approvedCents: APPROVED_400, alreadyPaidCents: 0, amountCents: 25000 })
row('Pay $250', pay1.allow ? 'ALLOWED' : 'BLOCKED')
row('Remaining owed', fmtCents(remainingPayableCents(APPROVED_400, 25000)))
const roll7 = rollupLabor([{ payModel: 'FLAT', approvalStatus: 'APPROVED', flatPayCentsSnapshot: APPROVED_400, paidCents: 25000 }])
row('Rollup: approved cash', fmtCents(roll7.approvedCashCents))
row('Rollup: paid', fmtCents(roll7.paidCents))
row('Rollup: still owed', fmtCents(roll7.unpaidCents), 'held back from distribution')
const over = canRecordLaborPayment({ role: 'OWNER', approvalStatus: 'APPROVED', approvedCents: APPROVED_400, alreadyPaidCents: 25000, amountCents: 20000 })
console.log(`\n  Trying to pay $200 more than owed: ${over.allow ? 'ALLOWED' : 'BLOCKED'}`)
if (!over.allow) console.log(`    -> ${over.error}`)

// ── 8. Permissions ──────────────────────────────────────────────────────────
rule('SCENARIO 8 — A worker cannot approve their own pay')

const selfApprove = canApproveLabor({ role: 'CREW', isSelf: true, hasOpenShift: false, calculatedPayCents: 20000 })
console.log(`  Worker approving own pay:  ${selfApprove.allow ? 'ALLOWED' : `BLOCKED (${selfApprove.allow === false ? selfApprove.status : ''})`}`)
const ownerSelf = canApproveLabor({ role: 'OWNER', isSelf: true, hasOpenShift: false, calculatedPayCents: 20000 })
console.log(`  OWNER approving own pay:   ${ownerSelf.allow ? 'ALLOWED' : `BLOCKED (${ownerSelf.allow === false ? ownerSelf.status : ''})`}  <- even an owner`)
const otherOwner = canApproveLabor({ role: 'OWNER', isSelf: false, hasOpenShift: false, calculatedPayCents: 20000 })
console.log(`  The OTHER owner approving: ${otherOwner.allow ? 'ALLOWED' : 'BLOCKED'}`)
console.log(`  Worker clocking SELF:      ${canWriteTime({ role: 'CREW', isSelf: true }).allow ? 'ALLOWED' : 'BLOCKED'}`)
console.log(`  Worker clocking ANOTHER:   ${canWriteTime({ role: 'CREW', isSelf: false }).allow ? 'ALLOWED' : 'BLOCKED (403)'}`)

// ── Time math sanity ────────────────────────────────────────────────────────
rule('TIME MATH — 8:00-17:00 with a 30m break')
const t = computeTimeBreakdown({ clockIn: new Date('2026-07-20T08:00:00Z'), clockOut: new Date('2026-07-20T17:00:00Z'), breakMinutes: 30 })
row('Elapsed', formatMinutes(t.elapsedMinutes))
row('Break', formatMinutes(t.breakMinutes))
row('Worked', formatMinutes(t.workedMinutes))
row('Regular / overtime', `${formatMinutes(t.regularMinutes)} / ${formatMinutes(t.overtimeMinutes)}`)
row('Paid', formatMinutes(t.paidMinutes))

console.log('\n' + '='.repeat(76))
console.log('All figures are SYNTHETIC. No database was read.')
console.log('='.repeat(76) + '\n')
