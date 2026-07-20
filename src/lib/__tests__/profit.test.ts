// Offline tests for the admin-OS money math (owner spec 2026-07-13).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtCents,
  dollarsToCents,
  stripeFeeCents,
  crewPayOwedCents,
  crewLaborCents,
  paidLaborCents,
  unpaidLaborCents,
  computeJobProfit,
  safeToDistributeCents,
  distributablePosition,
  taxReserveCentsFor,
  isStripePayment,
} from '../profit'

/** Every distributable test starts from a zeroed input so each case names only
 *  the one hold-back it is about. */
const NO_HOLDBACKS = {
  cashAvailableCents: 0,
  unpaidLaborCents: 0,
  upcomingBillsCents: 0,
  ownerReimbursementsOwedCents: 0,
  pendingRefundCents: 0,
  taxReserveCents: 0,
  emergencyReserveCents: 0,
}

test('fmtCents: cents -> money, null-safe, negative-aware', () => {
  assert.equal(fmtCents(70000), '$700.00')
  assert.equal(fmtCents(4900), '$49.00')
  assert.equal(fmtCents(123456), '$1,234.56')
  assert.equal(fmtCents(null), '$0.00')
  assert.equal(fmtCents(-500), '-$5.00')
})

test('dollarsToCents: parses plain, decimal, and formatted input', () => {
  assert.equal(dollarsToCents('700'), 70000)
  assert.equal(dollarsToCents('700.5'), 70050)
  assert.equal(dollarsToCents('$1,200.00'), 120000)
  assert.equal(dollarsToCents(45), 4500)
  assert.equal(dollarsToCents(''), null)
  assert.equal(dollarsToCents('abc'), null)
  assert.equal(dollarsToCents('-5'), null)
})

test('stripeFeeCents: 2.9% + 30c on captured charges only', () => {
  assert.equal(stripeFeeCents(70000), Math.round(70000 * 0.029) + 30) // $20.30 + $0.30
  assert.equal(stripeFeeCents(4900), Math.round(4900 * 0.029) + 30)
  assert.equal(stripeFeeCents(0), 0)
})

test('crewPayOwedCents: flat pay wins over hourly', () => {
  assert.equal(crewPayOwedCents({ flatPay: 20000, actualHours: 5, payRate: 3000 }), 20000)
})

test('crewPayOwedCents: hourly uses actual hours + JobCrew rate, adds tips/bonus, subtracts deductions', () => {
  // 4h * $30/h = $120, + $15 tip + $10 bonus - $5 deduction = $140
  assert.equal(
    crewPayOwedCents({ actualHours: 4, payRate: 3000, tips: 1500, bonus: 1000, deductions: 500 }),
    14000,
  )
})

test('crewPayOwedCents: falls back to scheduled hours and the user default rate', () => {
  // no actual hours -> scheduled 3h; no per-job rate -> user default $25/h = $75
  assert.equal(crewPayOwedCents({ scheduledHours: 3, userPayRate: 2500 }), 7500)
})

test('crewPayOwedCents: never negative', () => {
  assert.equal(crewPayOwedCents({ flatPay: 5000, deductions: 9000 }), 0)
})

test('computeJobProfit: worked example ($700 collected, $200 crew, $45+$20 exp, stripe on card)', () => {
  // $700 collected via CARD, crew $200, expenses $45 + $20, refunds $0.
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'COMPLETED', isStripe: true }],
    crew: [{ flatPay: 20000 }],
    expenses: [{ amount: 4500, status: 'APPROVED' }, { amount: 2000, status: 'APPROVED' }],
  })
  assert.equal(p.grossCapturedCents, 70000)
  assert.equal(p.netRevenueCents, 70000)
  assert.equal(p.crewPayCents, 20000)
  assert.equal(p.expenseCents, 6500)
  assert.equal(p.stripeFeeCents, Math.round(70000 * 0.029) + 30) // ~$20.60
  assert.equal(p.netProfitCents, 70000 - (20000 + 6500 + p.stripeFeeCents))
  assert.ok(p.marginPct !== null && p.marginPct > 0.5 && p.marginPct < 0.7)
})

test('computeJobProfit: internal-test payments are never revenue', () => {
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'COMPLETED', isInternalTest: true, isStripe: true }],
    crew: [],
    expenses: [],
  })
  assert.equal(p.netRevenueCents, 0)
  assert.equal(p.stripeFeeCents, 0)
  assert.equal(p.marginPct, null)
})

test('computeJobProfit: cash (non-Stripe) payment carries no processor fee', () => {
  const p = computeJobProfit({
    payments: [{ amount: 65100, status: 'COMPLETED', isStripe: false }],
    crew: [],
    expenses: [],
  })
  assert.equal(p.stripeFeeCents, 0)
  assert.equal(p.netProfitCents, 65100)
})

test('computeJobProfit: REJECTED job expenses are excluded from cost', () => {
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'COMPLETED', isStripe: false }],
    crew: [],
    expenses: [{ amount: 4500, status: 'APPROVED' }, { amount: 99900, status: 'REJECTED' }],
  })
  assert.equal(p.expenseCents, 4500)
  assert.equal(p.netProfitCents, 70000 - 4500)
})

// ── PHASE 0 REGRESSION: refunds net off REVENUE and are never a second cost ──
// The replaced behavior ("refunds count as a cost") excluded a refunded payment
// from revenue AND subtracted its full face value, reporting -$2,000 on a
// $2,000 payment with a $200 refund. That test was wrong, not the arithmetic.

test('REGRESSION: a $200 refund on a $2,000 job leaves $1,800 revenue, not -$2,000', () => {
  const p = computeJobProfit({
    payments: [{ amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: 20000, isStripe: false }],
    crew: [],
    expenses: [],
  })
  assert.equal(p.grossCapturedCents, 200000)
  assert.equal(p.refundedCents, 20000)
  assert.equal(p.netRevenueCents, 180000)
  assert.equal(p.netProfitCents, 180000)
})

test('REGRESSION: a fully refunded cash job nets to $0, not -$700', () => {
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'REFUNDED', refundedAmountCents: 70000, isStripe: false }],
    crew: [],
    expenses: [],
  })
  assert.equal(p.netRevenueCents, 0)
  assert.equal(p.netProfitCents, 0)
})

test('a refund is not subtracted twice across revenue and costs', () => {
  const p = computeJobProfit({
    payments: [
      { amount: 70000, status: 'COMPLETED', isStripe: false },
      { amount: 10000, status: 'REFUNDED', refundedAmountCents: 10000, isStripe: false },
    ],
    crew: [],
    expenses: [],
  })
  // $80k captured, $10k refunded => $70k net. Costs contain NO refund line.
  assert.equal(p.grossCapturedCents, 80000)
  assert.equal(p.refundedCents, 10000)
  assert.equal(p.netRevenueCents, 70000)
  assert.equal(p.totalCostsCents, 0)
  assert.equal(p.netProfitCents, 70000)
})

test('Stripe keeps its fee on a refunded charge, so a fully refunded card job is fee-negative', () => {
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'REFUNDED', refundedAmountCents: 70000, isStripe: true }],
    crew: [],
    expenses: [],
  })
  const fee = Math.round(70000 * 0.029) + 30
  assert.equal(p.netRevenueCents, 0)
  assert.equal(p.stripeFeeCents, fee)
  assert.equal(p.netProfitCents, -fee) // a real, honest loss
})

test('a lost chargeback removes the revenue; an open dispute does not', () => {
  const lost = computeJobProfit({
    payments: [{ amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_1', disputeStatus: 'lost', isStripe: false }],
    crew: [], expenses: [],
  })
  assert.equal(lost.netRevenueCents, 0)
  assert.equal(lost.chargebackCents, 200000)

  const open = computeJobProfit({
    payments: [{ amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_1', disputeStatus: 'needs_response', isStripe: false }],
    crew: [], expenses: [],
  })
  assert.equal(open.netRevenueCents, 200000)
  assert.equal(open.pendingDisputeCents, 200000)
})

test('an authorized-but-uncaptured hold is reported separately and is never revenue', () => {
  const p = computeJobProfit({
    payments: [{ amount: 4900, status: 'PENDING', isStripe: true }],
    crew: [], expenses: [],
  })
  assert.equal(p.netRevenueCents, 0)
  assert.equal(p.authorizedNotCapturedCents, 4900)
  assert.equal(p.stripeFeeCents, 0) // no capture, no fee
})

// ── Labor splits (paid vs accrued) ──────────────────────────────────────────

test('crewLaborCents / paidLaborCents / unpaidLaborCents partition the total', () => {
  const crew = [
    { flatPay: 20000, payStatus: 'PAID' },
    { actualHours: 4, payRate: 3000, payStatus: 'PAY_APPROVED' },
  ]
  assert.equal(crewLaborCents(crew), 32000)
  assert.equal(paidLaborCents(crew), 20000)
  assert.equal(unpaidLaborCents(crew), 12000)
  assert.equal(paidLaborCents(crew) + unpaidLaborCents(crew), crewLaborCents(crew))
})

test('isStripePayment: presence of a processor id decides', () => {
  assert.equal(isStripePayment({ stripePaymentIntentId: 'pi_1' }), true)
  assert.equal(isStripePayment({ stripeChargeId: 'ch_1' }), true)
  assert.equal(isStripePayment({}), false)
  assert.equal(isStripePayment({ stripePaymentIntentId: null, stripeChargeId: null }), false)
})

// ── Safe to distribute ──────────────────────────────────────────────────────

test('safeToDistribute: no labor -> only reserves are held back', () => {
  const p = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 1000000, taxReserveCents: 250000, emergencyReserveCents: 100000 })
  assert.equal(p.distributableCents, 650000)
  assert.equal(p.shortfallCents, 0)
})

test('safeToDistribute: reserves + every obligation are held back first', () => {
  // $10,000 cash; hold $2,000 unpaid labor, $500 bills, $300 reimbursements,
  // $400 disputed, $2,500 tax, $1,000 emergency = $6,700 held.
  const p = distributablePosition({
    cashAvailableCents: 1000000,
    unpaidLaborCents: 200000,
    upcomingBillsCents: 50000,
    ownerReimbursementsOwedCents: 30000,
    pendingRefundCents: 40000,
    taxReserveCents: 250000,
    emergencyReserveCents: 100000,
  })
  assert.equal(p.totalHeldBackCents, 670000)
  assert.equal(p.distributableCents, 330000)
})

test('safeToDistribute: an owner reimbursement owed reduces the distributable figure', () => {
  const without = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 500000 })
  const withOwed = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 500000, ownerReimbursementsOwedCents: 120000 })
  assert.equal(without.distributableCents - withOwed.distributableCents, 120000)
})

test('safeToDistribute: money at risk in an open dispute is held back', () => {
  const p = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 500000, pendingRefundCents: 200000 })
  assert.equal(p.distributableCents, 300000)
})

test('safeToDistribute: a shortfall is REPORTED, not silently clamped to zero', () => {
  const p = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 10000, unpaidLaborCents: 50000 })
  assert.equal(p.rawCents, -40000) // the signed truth, for display
  assert.equal(p.shortfallCents, 40000)
  assert.equal(p.distributableCents, 0) // nothing may actually be taken out
  assert.equal(safeToDistributeCents({ ...NO_HOLDBACKS, cashAvailableCents: 10000, unpaidLaborCents: 50000 }), -40000)
})

test('REGRESSION: paying labor must not increase what is distributable', () => {
  // The Phase 0 bug: paid labor left the business but was subtracted NOWHERE,
  // while safe-to-distribute only held back UNPAID labor. Marking a worker paid
  // therefore RAISED the distributable figure by their pay.
  const LABOR = 200000
  const CASH_BEFORE = 1000000

  // Before payment: labor is accrued, still inside cash, held back here.
  const accrued = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: CASH_BEFORE, unpaidLaborCents: LABOR })

  // After payment: the money has left cash (estimateBusinessCash subtracts
  // paidLaborCents), so it is no longer held back here.
  const settled = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: CASH_BEFORE - LABOR, unpaidLaborCents: 0 })

  assert.equal(accrued.distributableCents, settled.distributableCents)
  assert.equal(settled.distributableCents, 800000)
})

test('labor is never subtracted twice: a row is either paid or unpaid', () => {
  const LABOR = 150000
  const doubleCounted = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 1000000 - LABOR, unpaidLaborCents: LABOR })
  const correct = distributablePosition({ ...NO_HOLDBACKS, cashAvailableCents: 1000000 - LABOR, unpaidLaborCents: 0 })
  // Proving they DIFFER is the point: if a paid row also appeared as unpaid,
  // the figure would drop by the labor amount a second time.
  assert.equal(correct.distributableCents - doubleCounted.distributableCents, LABOR)
})

// ── Tax reserve base ────────────────────────────────────────────────────────

test('taxReserveCentsFor: reserves a percentage of OPERATING PROFIT', () => {
  assert.equal(taxReserveCentsFor(1000000, 25), 250000)
})

test('taxReserveCentsFor: a loss reserves nothing (never negative)', () => {
  assert.equal(taxReserveCentsFor(-500000, 25), 0)
  assert.equal(taxReserveCentsFor(0, 25), 0)
})
