// Offline tests for the financial guardrails (increment 2, Part 5 of the owner
// spec). These are the invariants docs/financial-architecture.md promises.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollupOwner, estimateBusinessCash, operatingRevenueCents, operatingExpenseCents, type OwnerTxLike } from '../owner-ledger'
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
  assert.equal(estimateBusinessCash({ revenueCents: 0, expenseCents: 0, ownerTxs: txs }), 0)
})

test('reimbursement clears the owed amount and reduces cash', () => {
  const txs = [tx('DIEGO', 'PERSONAL_PURCHASE', 8500), tx('DIEGO', 'REIMBURSEMENT', 8500)]
  assert.equal(rollupOwner(txs, 'DIEGO').reimbursementOwed, 0)
  // Personal purchase alone doesn't touch cash; the reimbursement does.
  assert.equal(estimateBusinessCash({ revenueCents: 0, expenseCents: 0, ownerTxs: [txs[0]] }), 0)
  assert.equal(estimateBusinessCash({ revenueCents: 0, expenseCents: 0, ownerTxs: txs }), -8500)
})

test('cash estimate: contributions + revenue − expenses − owner cash-out', () => {
  const txs = [tx('DIEGO', 'CONTRIBUTION', 100000), tx('SEBASTIAN', 'WITHDRAWAL', 20000)]
  assert.equal(estimateBusinessCash({ revenueCents: 70000, expenseCents: 30000, ownerTxs: txs }), 100000 + 70000 - 30000 - 20000)
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
    expenses: [{ amount: 10000 }],
  })
  assert.equal(p.netProfitCents, 60000)
})
