// Offline tests for the financial guardrails (increment 2, Part 5 of the owner
// spec). These are the invariants docs/financial-architecture.md promises.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollupOwner, estimateBusinessCash, operatingRevenueCents, operatingExpenseCents, operatingProfitCents, totalReimbursementOwed, type OwnerTxLike } from '../owner-ledger'
import { computeJobProfit, crewPayOwedCents } from '../profit'

const tx = (owner: string, type: string, amount: number, approvalStatus = 'APPROVED'): OwnerTxLike => ({ owner, type, amount, approvalStatus })

test('owner contributions are NEVER revenue', () => {
  const txs = [tx('DIEGO', 'CONTRIBUTION', 90000)]
  // $500 of real customer payments stays $500 no matter what owners put in.
  assert.equal(operatingRevenueCents(50000, txs), 50000)
})

test('owner withdrawals / distributions are NEVER operating expenses', () => {
  const txs = [tx('DIEGO', 'WITHDRAWAL', 30000), tx('SEBASTIAN', 'DISTRIBUTION', 25000)]
  assert.equal(operatingExpenseCents(10000, txs), 10000)
})

test('rollup: contributions / withdrawals / reimbursement owed per owner', () => {
  const txs = [
    tx('DIEGO', 'CONTRIBUTION', 90000),
    tx('DIEGO', 'WITHDRAWAL', 30000),
    tx('DIEGO', 'PERSONAL_PURCHASE', 8500),
    tx('SEBASTIAN', 'CONTRIBUTION', 60000),
    tx('SEBASTIAN', 'DISTRIBUTION', 25000),
    tx('SEBASTIAN', 'PERSONAL_PURCHASE', 4000),
  ]
  const d = rollupOwner(txs, 'DIEGO')
  assert.equal(d.contributed, 90000) // $900
  assert.equal(d.withdrawn, 30000) // $300
  assert.equal(d.reimbursementOwed, 8500) // $85
  const s = rollupOwner(txs, 'SEBASTIAN')
  assert.equal(s.contributed, 60000)
  assert.equal(s.withdrawn, 25000)
  assert.equal(s.reimbursementOwed, 4000)
})

test('rejected transactions never count anywhere', () => {
  const txs = [tx('DIEGO', 'CONTRIBUTION', 90000, 'REJECTED')]
  assert.equal(rollupOwner(txs, 'DIEGO').contributed, 0)
  assert.equal(estimateBusinessCash({ netRevenueCents: 0, expenseCents: 0, paidLaborCents: 0, ownerTxs: txs }), 0)
})

test('reimbursement clears the owed amount and reduces cash', () => {
  const txs = [tx('DIEGO', 'PERSONAL_PURCHASE', 8500), tx('DIEGO', 'REIMBURSEMENT', 8500)]
  assert.equal(rollupOwner(txs, 'DIEGO').reimbursementOwed, 0)
  // Personal purchase alone doesn't touch cash; the reimbursement does.
  assert.equal(estimateBusinessCash({ netRevenueCents: 0, expenseCents: 0, paidLaborCents: 0, ownerTxs: [txs[0]] }), 0)
  assert.equal(estimateBusinessCash({ netRevenueCents: 0, expenseCents: 0, paidLaborCents: 0, ownerTxs: txs }), -8500)
})

test('cash estimate: contributions + revenue − expenses − owner cash-out', () => {
  const txs = [tx('DIEGO', 'CONTRIBUTION', 100000), tx('SEBASTIAN', 'WITHDRAWAL', 20000)]
  assert.equal(estimateBusinessCash({ netRevenueCents: 70000, expenseCents: 30000, paidLaborCents: 0, ownerTxs: txs }), 100000 + 70000 - 30000 - 20000)
})

// ── PHASE 0: paid labor must leave the cash estimate ─────────────────────────

test('REGRESSION: cash drops by exactly the labor paid', () => {
  // Before Phase 0 paidLaborCents did not exist, so money paid to a worker
  // never left this estimate — and because safe-to-distribute only held back
  // UNPAID labor, settling a worker made the business look RICHER.
  const before = estimateBusinessCash({ netRevenueCents: 200000, expenseCents: 0, paidLaborCents: 0, ownerTxs: [] })
  const after = estimateBusinessCash({ netRevenueCents: 200000, expenseCents: 0, paidLaborCents: 60000, ownerTxs: [] })
  assert.equal(before, 200000)
  assert.equal(after, 140000)
  assert.equal(before - after, 60000)
})

test('cash estimate uses NET revenue, so a refund reduces cash exactly once', () => {
  // $2,000 captured with a $200 refund => $1,800 net collected.
  assert.equal(estimateBusinessCash({ netRevenueCents: 180000, expenseCents: 0, paidLaborCents: 0, ownerTxs: [] }), 180000)
})

test('operatingProfitCents: labor is a cost in the tax-reserve base', () => {
  // $2,000 revenue − $300 expenses − $500 labor = $1,200 operating profit.
  assert.equal(operatingProfitCents({ netRevenueCents: 200000, expenseCents: 30000, laborCents: 50000 }), 120000)
  // The old base ignored labor entirely and would have said $1,700.
  assert.notEqual(operatingProfitCents({ netRevenueCents: 200000, expenseCents: 30000, laborCents: 50000 }), 170000)
})

test('totalReimbursementOwed sums what the business owes every owner', () => {
  const txs = [
    tx('DIEGO', 'PERSONAL_PURCHASE', 8000),
    tx('SEBASTIAN', 'PERSONAL_PURCHASE', 5000),
    tx('SEBASTIAN', 'REIMBURSEMENT', 2000),
    tx('DIEGO', 'PERSONAL_PURCHASE', 40000, 'REJECTED'), // never counts
  ]
  assert.equal(totalReimbursementOwed(txs, ['DIEGO', 'SEBASTIAN']), 8000 + 3000)
})

// ── The labor double-count invariant, end to end ─────────────────────────────

test('JobCrew labor is counted exactly once in job profit', () => {
  // $150 of crew labor: 5h × $30/h.
  const crew = { actualHours: 5, payRate: 3000 }
  assert.equal(crewPayOwedCents(crew), 15000)
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'COMPLETED', isStripe: false }],
    crew: [crew],
    expenses: [],
  })
  // Labor hits costs once — profit is exactly revenue − 150, not − 300.
  assert.equal(p.crewPayCents, 15000)
  assert.equal(p.netProfitCents, 70000 - 15000)
})

test('marking crew PAID must not create a second expense (settlement is cash-only)', () => {
  // Pay status is NOT an input to profit — the same crew record before and
  // after payment produces the same job profit. Settlement only moves cash.
  const before = computeJobProfit({ payments: [{ amount: 70000, status: 'COMPLETED' }], crew: [{ actualHours: 5, payRate: 3000 }], expenses: [] })
  const after = computeJobProfit({ payments: [{ amount: 70000, status: 'COMPLETED' }], crew: [{ actualHours: 5, payRate: 3000 }], expenses: [] })
  assert.equal(before.netProfitCents, after.netProfitCents)
})

test('a WORKER_PAY expense for a NON-crew helper is a legitimate job cost', () => {
  // No crew payroll on the job — the $100 helper expense is the labor cost.
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'COMPLETED' }],
    crew: [],
    expenses: [{ amount: 10000, status: 'APPROVED' }],
  })
  assert.equal(p.netProfitCents, 60000)
})
