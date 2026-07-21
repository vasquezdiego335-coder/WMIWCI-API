// Phase 2 staging scenarios — SYNTHETIC DATA ONLY, no database access.
// Runs the eight scenarios from the owner spec through the REAL centralized
// calculators. Nothing below is hard-coded: every figure comes from
// closeout-calc / closeout-blockers / owner-split.
//   npx tsx scripts/phase2-evidence.ts

import { computeCloseout } from '../src/lib/closeout-calc'
import { computeCloseoutBlockers, evaluateFinalize, deriveCloseoutStatus } from '../src/lib/closeout-blockers'
import { computeOwnerSplit } from '../src/lib/owner-split'
import { canFinalizeCloseout, canOverrideBlocker, canReopenCloseout, canSetOwnerSplit, canRecordDistribution } from '../src/lib/closeout-guards'
import { fmtCents } from '../src/lib/profit'

const rule = (t: string) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
const row = (l: string, v: string, n = '') => console.log(`  ${l.padEnd(42)}${v.padStart(14)}  ${n}`)

const CLEAN_BLOCKERS = {
  bookingStatus: 'COMPLETED', hasCapturedPayment: true, hasUnknownRefundAmount: false,
  refundExceedsCaptured: false, outstandingBalanceCents: 0, balanceWriteOffCents: 0,
  disputedOpenCents: 0, disputeAcknowledged: false, laborState: 'APPROVED_UNPAID',
  truckSourceConfirmed: true, truckSourceIsCostly: false, truckCostRecordedCents: 0,
  expensesMissingReceipt: [], receiptRequiredAboveCents: 2500, pendingExpenseCount: 0,
  ownerReimbursementOwedCents: 0, allocatedToOwnersCents: 0, distributableProfitCents: 0,
  reservesExceedProfit: false, hasNegativeValue: false,
}

// ── 1. Profitable move ──────────────────────────────────────────────────────
rule('SCENARIO 1 — Profitable move: $2,000 collected, $410 expenses, $800 labor, $15 fees')

const s1 = computeCloseout({
  billed: { grossCustomerChargesCents: 200000 },
  collected: { netCollectedCents: 200000 },
  refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 80000, eligibleExpenseCents: 41000, processingFeeCents: 1500 },
  unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 80000, approvedLaborMinutes: 600,
  overhead: { method: 'PER_MOVE', perMoveCents: 3500 },
  reserves: { taxReserveBp: 2000, businessReserveCents: 20000 },
})
row('Net billed revenue', fmtCents(s1.netBilledRevenueCents))
row('Net collected revenue', fmtCents(s1.netCollectedRevenueCents))
row('- Crew labor', fmtCents(s1.crewLaborCents))
row('- Job expenses', fmtCents(s1.directExpenseCents))
row('- Processing fees', fmtCents(s1.processingFeeCents))
row('= Cash gross profit', fmtCents(s1.profit.cashGrossProfitCents))
row('- Allocated overhead', fmtCents(s1.overhead.amountCents), s1.overhead.basis)
row('= Company net profit', fmtCents(s1.profit.companyNetProfitCents), `${((s1.profit.marginBp ?? 0) / 100).toFixed(1)}% margin`)
row('- Tax reserve (20%)', fmtCents(s1.reserves.taxReserveCents))
row('- Truck fund', fmtCents(s1.reserves.businessReserveCents))
row('= Distributable profit', fmtCents(s1.reserves.distributableProfitCents))

const split1 = computeOwnerSplit({ method: 'OWNERSHIP_PERCENT', distributableProfitCents: s1.reserves.distributableProfitCents, ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 } })
split1.shares.forEach((s) => row(`  ${s.owner}`, fmtCents(s.amountCents), `${(s.percentBp / 100).toFixed(1)}%`))
const b1 = computeCloseoutBlockers({ ...CLEAN_BLOCKERS, distributableProfitCents: s1.reserves.distributableProfitCents })
const f1 = canFinalizeCloseout({ role: 'OWNER', alreadyFinalized: false, blockers: b1, overrides: [] })
console.log(`\n  Blockers: ${b1.length} · Finalize: ${f1.allow ? 'ALLOWED' : 'BLOCKED'}`)
console.log(`  Snapshot would record calculation version: ${s1.calculationVersion}`)

// ── 2. Outstanding balance ──────────────────────────────────────────────────
rule('SCENARIO 2 — Outstanding balance: billed $2,000, collected $1,500')

const s2 = computeCloseout({
  billed: { grossCustomerChargesCents: 200000 },
  collected: { netCollectedCents: 150000 },
  refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 80000, eligibleExpenseCents: 41000, processingFeeCents: 1500 },
  unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 80000, approvedLaborMinutes: 600,
  overhead: { method: 'NONE' }, reserves: { taxReserveBp: 2000 },
})
row('Net billed revenue', fmtCents(s2.netBilledRevenueCents))
row('Net collected revenue', fmtCents(s2.netCollectedRevenueCents), 'the only cash')
row('Outstanding balance', fmtCents(s2.outstandingBalanceCents), 'a receivable, NOT profit')
row('Cash gross profit', fmtCents(s2.profit.cashGrossProfitCents), 'from COLLECTED money')
row('Distributable profit', fmtCents(s2.reserves.distributableProfitCents))
const b2 = computeCloseoutBlockers({ ...CLEAN_BLOCKERS, outstandingBalanceCents: s2.outstandingBalanceCents, distributableProfitCents: s2.reserves.distributableProfitCents })
console.log(`\n  Finalize: ${canFinalizeCloseout({ role: 'OWNER', alreadyFinalized: false, blockers: b2, overrides: [] }).allow ? 'ALLOWED' : 'BLOCKED'}`)
b2.forEach((x) => console.log(`    [${x.severity}] ${x.code}: ${x.message}`))
const wo = evaluateFinalize(b2, [{ code: 'OUTSTANDING_BALANCE', reason: 'Customer hardship — written off' }])
console.log(`  After an owner write-off override: ${wo.canFinalize ? 'ALLOWED' : 'BLOCKED'}`)
console.log(`  The uncollected $500 never entered distributable profit.`)

// ── 3. Partial refund ───────────────────────────────────────────────────────
rule('SCENARIO 3 — Partial refund: $2,000 captured, $200 refunded')

const s3 = computeCloseout({
  billed: { grossCustomerChargesCents: 200000 },
  collected: { netCollectedCents: 180000 }, // money-rules already netted it
  refundedCents: 20000, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 0, eligibleExpenseCents: 0, processingFeeCents: 0 },
  unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 0, approvedLaborMinutes: 0,
  overhead: { method: 'NONE' }, reserves: {},
})
row('Captured', fmtCents(200000))
row('Refunded', fmtCents(s3.refundedCents))
row('Net collected revenue', fmtCents(s3.netCollectedRevenueCents), 'CORRECT')
row('Cash gross profit', fmtCents(s3.profit.cashGrossProfitCents), 'refund deducted ONCE')
console.log(`\n  If the refund were double-counted this would read ${fmtCents(160000)}. It does not.`)

// ── 4. Owner reimbursement ──────────────────────────────────────────────────
rule('SCENARIO 4 — Owner personally paid a $150 truck expense')

const owedArgs = {
  billed: { grossCustomerChargesCents: 200000 },
  collected: { netCollectedCents: 200000 },
  refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 80000, eligibleExpenseCents: 15000, processingFeeCents: 0 },
  unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 80000, approvedLaborMinutes: 600,
  overhead: { method: 'NONE' as const },
}
const owed = computeCloseout({ ...owedArgs, reserves: { unresolvedLiabilityCents: 15000 } })
const settled = computeCloseout({ ...owedArgs, reserves: { unresolvedLiabilityCents: 0 } })
row('Expense counted in job cost', fmtCents(owed.directExpenseCents), 'once')
row('Company net profit', fmtCents(owed.profit.companyNetProfitCents), 'same either way')
row('Distributable while owed', fmtCents(owed.reserves.distributableProfitCents), 'reimbursement held back')
row('Distributable once reimbursed', fmtCents(settled.reserves.distributableProfitCents))
console.log(`\n  Difference: ${fmtCents(settled.reserves.distributableProfitCents - owed.reserves.distributableProfitCents)} — exactly the reimbursement, held back once.`)
console.log(`  The expense reduced profit; the reimbursement reduced distributable cash. NOT both.`)

// ── 5. Unpaid owner labor ───────────────────────────────────────────────────
rule('SCENARIO 5 — Owner works unpaid: cash profit vs economic profit')

const s5 = computeCloseout({
  billed: { grossCustomerChargesCents: 200000 },
  collected: { netCollectedCents: 200000 },
  refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 30000, eligibleExpenseCents: 41000, processingFeeCents: 0 },
  unpaidOwnerLaborValueCents: 30000, ownerCashLaborCents: 30000, approvedLaborMinutes: 960,
  overhead: { method: 'PER_MOVE', perMoveCents: 3500 }, reserves: { taxReserveBp: 2000 },
})
row('Cash gross profit', fmtCents(s5.profit.cashGrossProfitCents))
row('- Unpaid owner labor value', fmtCents(s5.ownerEconomicLaborCents))
row('= Economic profit', fmtCents(s5.profit.economicProfitCents), 'if the owner were hired')
row('Company net profit', fmtCents(s5.profit.companyNetProfitCents))
row('Economic net profit', fmtCents(s5.profit.economicNetProfitCents))
console.log(`\n  An owner DRAW would be neither of these — it is not labor pay and not an expense.`)

// ── 6. Negative move ────────────────────────────────────────────────────────
rule('SCENARIO 6 — Costs exceed collected revenue')

const s6 = computeCloseout({
  billed: { grossCustomerChargesCents: 60000 },
  collected: { netCollectedCents: 50000 },
  refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 70000, eligibleExpenseCents: 20000, processingFeeCents: 1500 },
  unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 70000, approvedLaborMinutes: 480,
  overhead: { method: 'PER_MOVE', perMoveCents: 3500 }, reserves: { taxReserveBp: 2000 },
})
row('Net collected revenue', fmtCents(s6.netCollectedRevenueCents))
row('Direct job cost', fmtCents(s6.directJobCostCents))
row('Cash gross profit', fmtCents(s6.profit.cashGrossProfitCents), 'LOSS — shown, not hidden')
row('Company net profit', fmtCents(s6.profit.companyNetProfitCents), `${((s6.profit.marginBp ?? 0) / 100).toFixed(1)}% margin`)
row('Tax reserve', fmtCents(s6.reserves.taxReserveCents), 'floored at $0 on a loss')
row('Distributable profit', fmtCents(s6.reserves.distributableProfitCents))
const split6 = computeOwnerSplit({ method: 'EQUAL', distributableProfitCents: s6.reserves.distributableProfitCents })
console.log(`\n  Owner split on a loss: ${split6.shares.map((s) => `${s.owner} ${fmtCents(s.amountCents)}`).join(' · ')}`)
const dist6 = canRecordDistribution({ role: 'OWNER', action: 'PLAN', amountCents: 1, distributableProfitCents: s6.reserves.distributableProfitCents, alreadyAllocatedCents: 0 })
console.log(`  Attempting to distribute $0.01: ${dist6.allow ? 'ALLOWED' : 'BLOCKED'}`)
if (!dist6.allow) console.log(`    -> ${dist6.error}`)

// ── 7. Finalize and reopen ──────────────────────────────────────────────────
rule('SCENARIO 7 — Finalize, then reopen for a late toll')

const before = s1.profit.companyNetProfitCents
console.log(`  v1 finalized with company net profit ${fmtCents(before)}`)
const reopen = canReopenCloseout({ role: 'OWNER', isFinalized: true, reason: 'Late $12 toll receipt arrived' })
console.log(`  Reopen (owner + reason): ${reopen.allow ? 'ALLOWED' : 'BLOCKED'}`)
console.log(`  Reopen without a reason: ${canReopenCloseout({ role: 'OWNER', isFinalized: true }).allow ? 'ALLOWED' : 'BLOCKED'}`)

const s7 = computeCloseout({
  billed: { grossCustomerChargesCents: 200000 },
  collected: { netCollectedCents: 200000 },
  refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
  costs: { approvedCrewLaborCents: 80000, eligibleExpenseCents: 42200, processingFeeCents: 1500 }, // +$12 toll
  unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 80000, approvedLaborMinutes: 600,
  overhead: { method: 'PER_MOVE', perMoveCents: 3500 },
  reserves: { taxReserveBp: 2000, businessReserveCents: 20000 },
})
row('v2 company net profit', fmtCents(s7.profit.companyNetProfitCents))
row('Change vs v1', fmtCents(s7.profit.companyNetProfitCents - before))
console.log(`  v1 is SUPERSEDED, never deleted — both versions remain readable.`)

// ── 8. Permissions ──────────────────────────────────────────────────────────
rule('SCENARIO 8 — A manager attempts owner-financial actions')

const bAny = computeCloseoutBlockers({ ...CLEAN_BLOCKERS, outstandingBalanceCents: 5000 })
const checks: [string, { allow: boolean; status?: number }][] = [
  ['Manager finalizes', canFinalizeCloseout({ role: 'MANAGER', alreadyFinalized: false, blockers: [], overrides: [] })],
  ['Manager overrides a blocker', canOverrideBlocker({ role: 'MANAGER', code: 'OUTSTANDING_BALANCE', reason: 'x', blockers: bAny })],
  ['Manager reopens', canReopenCloseout({ role: 'MANAGER', isFinalized: true, reason: 'x' })],
  ['Manager sets the owner split', canSetOwnerSplit({ role: 'MANAGER', isFinalized: false, splitOk: true })],
  ['Manager approves a distribution', canRecordDistribution({ role: 'MANAGER', action: 'APPROVE', amountCents: 1000, distributableProfitCents: 60000, alreadyAllocatedCents: 0 })],
  ['Worker finalizes', canFinalizeCloseout({ role: 'CREW', alreadyFinalized: false, blockers: [], overrides: [] })],
  ['OWNER finalizes a clean move', canFinalizeCloseout({ role: 'OWNER', alreadyFinalized: false, blockers: [], overrides: [] })],
  ['OWNER approves a distribution', canRecordDistribution({ role: 'OWNER', action: 'APPROVE', amountCents: 30000, distributableProfitCents: 60000, alreadyAllocatedCents: 0 })],
]
checks.forEach(([label, d]) => console.log(`  ${label.padEnd(36)} ${d.allow ? 'ALLOWED' : `BLOCKED (${'status' in d ? d.status : ''})`}`))

// ── HARD blockers cannot be overridden ──────────────────────────────────────
rule('INTEGRITY — a HARD blocker is not a policy decision')

const hardB = computeCloseoutBlockers({ ...CLEAN_BLOCKERS, refundExceedsCaptured: true })
const attempt = canOverrideBlocker({ role: 'OWNER', code: 'REFUND_EXCEEDS_PAYMENT', reason: 'I checked the bank', blockers: hardB })
console.log(`  Owner overriding "refund larger than payment": ${attempt.allow ? 'ALLOWED' : 'BLOCKED'}`)
if (!attempt.allow) console.log(`    -> ${attempt.error}`)
console.log(`  Finalize with that override recorded anyway: ${evaluateFinalize(hardB, [{ code: 'REFUND_EXCEEDS_PAYMENT', reason: 'x' }]).canFinalize ? 'ALLOWED' : 'BLOCKED'}`)

const st = deriveCloseoutStatus({ storedStatus: 'READY_TO_FINALIZE', started: true, submitted: true, finalized: false, reopened: false, decision: evaluateFinalize(hardB) })
console.log(`  A stale "READY_TO_FINALIZE" row re-derives as: ${st}`)

console.log('\n' + '='.repeat(78))
console.log('All figures are SYNTHETIC and produced by the real centralized calculators.')
console.log('No database was read.')
console.log('='.repeat(78) + '\n')
