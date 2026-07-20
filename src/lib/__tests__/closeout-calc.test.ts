// Phase 2 — the financial hierarchy from revenue to distributable profit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  netBilledRevenueCents,
  outstandingBalanceCents,
  directJobCostCents,
  computeProfit,
  computeOverhead,
  computeReserves,
  computeCloseout,
  applyBp,
  CALCULATION_VERSION,
} from '../closeout-calc'

// ── Revenue ─────────────────────────────────────────────────────────────────

test('net billed revenue = gross charges − discounts − credits', () => {
  assert.equal(netBilledRevenueCents({ grossCustomerChargesCents: 200000, discountsCents: 20000, creditsCents: 5000 }), 175000)
})

test('net billed revenue never goes negative', () => {
  assert.equal(netBilledRevenueCents({ grossCustomerChargesCents: 10000, discountsCents: 50000 }), 0)
})

test('SCENARIO 2: an outstanding balance is a receivable, never cash', () => {
  // Billed $2,000, collected $1,500 → $500 still owed.
  assert.equal(outstandingBalanceCents(200000, 150000), 50000)
})

test('a written-off balance reduces what is outstanding', () => {
  assert.equal(outstandingBalanceCents(200000, 150000, 50000), 0)
})

test('collecting more than billed produces no negative receivable', () => {
  assert.equal(outstandingBalanceCents(150000, 200000), 0)
})

// ── Costs + profit ──────────────────────────────────────────────────────────

const COSTS = { approvedCrewLaborCents: 80000, eligibleExpenseCents: 41000, processingFeeCents: 1500 }

test('SCENARIO 1: direct job cost sums labor + expenses + fees', () => {
  assert.equal(directJobCostCents(COSTS), 122500)
})

test('SCENARIO 1: the owner’s worked example computes end to end', () => {
  // $2,000 collected, $410 expenses, $800 labor, $15 fees.
  const p = computeProfit({
    netCollectedRevenueCents: 200000,
    directJobCostCents: directJobCostCents(COSTS),
    unpaidOwnerLaborValueCents: 0,
    allocatedOverheadCents: 0,
  })
  assert.equal(p.cashGrossProfitCents, 77500) // $775.00
  assert.equal(p.companyNetProfitCents, 77500)
  assert.equal(p.economicProfitCents, 77500)
  assert.equal(p.marginBp, 3875) // 38.75%
})

test('SCENARIO 5: unpaid owner labor lowers ECONOMIC profit but not cash profit', () => {
  const p = computeProfit({
    netCollectedRevenueCents: 200000,
    directJobCostCents: 100000,
    unpaidOwnerLaborValueCents: 30000,
    allocatedOverheadCents: 0,
  })
  assert.equal(p.cashGrossProfitCents, 100000)
  assert.equal(p.economicProfitCents, 70000)
  assert.equal(p.economicNetProfitCents, 70000)
})

test('overhead reduces company net profit but not cash GROSS profit', () => {
  const p = computeProfit({ netCollectedRevenueCents: 200000, directJobCostCents: 100000, unpaidOwnerLaborValueCents: 0, allocatedOverheadCents: 3500 })
  assert.equal(p.cashGrossProfitCents, 100000)
  assert.equal(p.companyNetProfitCents, 96500)
})

test('SCENARIO 6: a losing move reports a NEGATIVE profit and margin', () => {
  const p = computeProfit({ netCollectedRevenueCents: 50000, directJobCostCents: 90000, unpaidOwnerLaborValueCents: 0, allocatedOverheadCents: 0 })
  assert.equal(p.cashGrossProfitCents, -40000)
  assert.equal(p.companyNetProfitCents, -40000)
  assert.ok(p.marginBp !== null && p.marginBp < 0)
})

test('margin is null when nothing was collected', () => {
  assert.equal(computeProfit({ netCollectedRevenueCents: 0, directJobCostCents: 5000, unpaidOwnerLaborValueCents: 0, allocatedOverheadCents: 0 }).marginBp, null)
})

// ── Overhead ────────────────────────────────────────────────────────────────

const OH = { netCollectedRevenueCents: 200000, approvedLaborMinutes: 600 }

test('overhead NONE allocates nothing', () => {
  assert.equal(computeOverhead({ method: 'NONE', ...OH }).amountCents, 0)
})

test('overhead PER_MOVE is a flat amount', () => {
  assert.equal(computeOverhead({ method: 'PER_MOVE', perMoveCents: 3500, ...OH }).amountCents, 3500)
})

test('overhead PCT_REVENUE uses basis points of NET COLLECTED revenue', () => {
  // 5% of $2,000 = $100
  assert.equal(computeOverhead({ method: 'PCT_REVENUE', pctRevenueBp: 500, ...OH }).amountCents, 10000)
})

test('overhead PER_LABOR_HOUR uses approved crew hours', () => {
  // 10h × $4 = $40
  assert.equal(computeOverhead({ method: 'PER_LABOR_HOUR', perLaborHourCents: 400, ...OH }).amountCents, 4000)
})

test('overhead MONTHLY_POOL divides by eligible moves, never by zero', () => {
  assert.equal(computeOverhead({ method: 'MONTHLY_POOL', monthlyPoolCents: 100000, eligibleMovesInPeriod: 10, ...OH }).amountCents, 10000)
  assert.equal(computeOverhead({ method: 'MONTHLY_POOL', monthlyPoolCents: 100000, eligibleMovesInPeriod: 0, ...OH }).amountCents, 100000)
})

test('overhead MANUAL uses the owner-entered amount', () => {
  assert.equal(computeOverhead({ method: 'MANUAL', manualCents: 12345, ...OH }).amountCents, 12345)
})

test('every overhead result records the rate for the snapshot', () => {
  assert.equal(computeOverhead({ method: 'PCT_REVENUE', pctRevenueBp: 500, ...OH }).rateRaw, 500)
  assert.equal(computeOverhead({ method: 'PER_MOVE', perMoveCents: 3500, ...OH }).rateRaw, 3500)
})

// ── Reserves ────────────────────────────────────────────────────────────────

test('a percentage tax reserve comes off COMPANY NET PROFIT, not revenue', () => {
  // 20% of $1,175 net profit = $235 — the owner's worked example.
  const r = computeReserves({ companyNetProfitCents: 117500, taxReserveBp: 2000 })
  assert.equal(r.taxReserveCents, 23500)
  assert.equal(r.distributableProfitCents, 94000)
})

test('a FIXED tax reserve overrides the percentage', () => {
  const r = computeReserves({ companyNetProfitCents: 117500, taxReserveBp: 2000, taxReserveFixedCents: 10000 })
  assert.equal(r.taxReserveCents, 10000)
})

test('zero reserve leaves the whole profit distributable', () => {
  const r = computeReserves({ companyNetProfitCents: 100000 })
  assert.equal(r.taxReserveCents, 0)
  assert.equal(r.distributableProfitCents, 100000)
})

test('SCENARIO 6: a LOSS reserves nothing and distributes nothing', () => {
  const r = computeReserves({ companyNetProfitCents: -40000, taxReserveBp: 2000 })
  assert.equal(r.taxReserveCents, 0) // never reserve tax on money you did not make
  assert.equal(r.distributableProfitCents, 0)
})

test('multiple reserve categories all reduce distributable profit', () => {
  const r = computeReserves({
    companyNetProfitCents: 117500,
    taxReserveBp: 2000, // $235
    businessReserveCents: 20000, // truck fund $200
    retainedEarningsCents: 14000, // $140
  })
  assert.equal(r.totalHeldBackCents, 23500 + 20000 + 14000)
  assert.equal(r.distributableProfitCents, 117500 - 57500)
  assert.equal(r.distributableProfitCents, 60000) // the owner's $600 example
})

test('reserves exceeding profit floor distributable at zero and FLAG it', () => {
  const r = computeReserves({ companyNetProfitCents: 10000, businessReserveCents: 50000 })
  assert.equal(r.distributableProfitCents, 0)
  assert.equal(r.overAllocated, true)
})

test('SCENARIO 4: an owner reimbursement owed is held back before distribution', () => {
  const withOwed = computeReserves({ companyNetProfitCents: 100000, unresolvedLiabilityCents: 15000 })
  const without = computeReserves({ companyNetProfitCents: 100000 })
  assert.equal(without.distributableProfitCents - withOwed.distributableProfitCents, 15000)
})

test('applyBp converts basis points correctly', () => {
  assert.equal(applyBp(100000, 500), 5000) // 5%
  assert.equal(applyBp(100000, 10000), 100000) // 100%
  assert.equal(applyBp(-5000, 2000), 0)
})

// ── The whole hierarchy ─────────────────────────────────────────────────────

test('computeCloseout runs revenue → costs → profit → reserves in one pass', () => {
  const c = computeCloseout({
    billed: { grossCustomerChargesCents: 200000 },
    collected: { netCollectedCents: 200000 },
    refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
    costs: COSTS,
    unpaidOwnerLaborValueCents: 0,
    ownerCashLaborCents: 80000,
    approvedLaborMinutes: 600,
    overhead: { method: 'PER_MOVE', perMoveCents: 3500 },
    reserves: { taxReserveBp: 2000 },
  })
  assert.equal(c.netCollectedRevenueCents, 200000)
  assert.equal(c.outstandingBalanceCents, 0)
  assert.equal(c.directJobCostCents, 122500)
  assert.equal(c.profit.cashGrossProfitCents, 77500)
  assert.equal(c.overhead.amountCents, 3500)
  assert.equal(c.profit.companyNetProfitCents, 74000)
  assert.equal(c.reserves.taxReserveCents, 14800) // 20% of $740
  assert.equal(c.reserves.distributableProfitCents, 59200)
  assert.equal(c.calculationVersion, CALCULATION_VERSION)
})

test('SCENARIO 3: a $200 refund on $2,000 leaves $1,800 and is deducted ONCE', () => {
  // netCollectedCents already nets the refund (money-rules). It must not be
  // subtracted a second time anywhere in the hierarchy.
  const c = computeCloseout({
    billed: { grossCustomerChargesCents: 200000 },
    collected: { netCollectedCents: 180000 },
    refundedCents: 20000, chargebackCents: 0, disputedOpenCents: 0,
    costs: { approvedCrewLaborCents: 0, eligibleExpenseCents: 0, processingFeeCents: 0 },
    unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 0, approvedLaborMinutes: 0,
    overhead: { method: 'NONE' }, reserves: {},
  })
  assert.equal(c.netCollectedRevenueCents, 180000)
  assert.equal(c.profit.cashGrossProfitCents, 180000) // NOT 160000
  assert.equal(c.refundedCents, 20000) // reported, not re-deducted
})

test('SCENARIO 2: profit is computed from COLLECTED money, never from billed', () => {
  const c = computeCloseout({
    billed: { grossCustomerChargesCents: 200000 },
    collected: { netCollectedCents: 150000 }, // customer still owes $500
    refundedCents: 0, chargebackCents: 0, disputedOpenCents: 0,
    costs: { approvedCrewLaborCents: 50000, eligibleExpenseCents: 0, processingFeeCents: 0 },
    unpaidOwnerLaborValueCents: 0, ownerCashLaborCents: 0, approvedLaborMinutes: 0,
    overhead: { method: 'NONE' }, reserves: {},
  })
  assert.equal(c.outstandingBalanceCents, 50000)
  assert.equal(c.profit.cashGrossProfitCents, 100000) // $1,500 − $500, not $2,000 − $500
  // The uncollected $500 can never reach a distribution.
  assert.equal(c.reserves.distributableProfitCents, 100000)
})
