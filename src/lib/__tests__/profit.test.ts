// Offline tests for the admin-OS money math (owner spec 2026-07-13).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtCents,
  dollarsToCents,
  stripeFeeCents,
  crewPayOwedCents,
  computeJobProfit,
  safeToDistributeCents,
  isStripePayment,
} from '../profit'

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
    expenses: [{ amount: 4500 }, { amount: 2000 }],
  })
  assert.equal(p.grossRevenueCents, 70000)
  assert.equal(p.crewPayCents, 20000)
  assert.equal(p.expenseCents, 6500)
  assert.equal(p.stripeFeeCents, Math.round(70000 * 0.029) + 30) // ~$20.60
  assert.equal(p.netProfitCents, 70000 - (20000 + 6500 + p.stripeFeeCents + 0))
  assert.ok(p.marginPct !== null && p.marginPct > 0.5 && p.marginPct < 0.7)
})

test('computeJobProfit: internal-test payments are never revenue', () => {
  const p = computeJobProfit({
    payments: [{ amount: 70000, status: 'COMPLETED', isInternalTest: true, isStripe: true }],
    crew: [],
    expenses: [],
  })
  assert.equal(p.grossRevenueCents, 0)
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

test('computeJobProfit: refunds count as a cost', () => {
  const p = computeJobProfit({
    payments: [
      { amount: 70000, status: 'COMPLETED', isStripe: true },
      { amount: 10000, status: 'REFUNDED', isStripe: true },
    ],
    crew: [],
    expenses: [],
  })
  assert.equal(p.refundedCents, 10000)
  assert.equal(p.netProfitCents, 70000 - (p.stripeFeeCents + 10000))
})

test('isStripePayment: presence of a processor id decides', () => {
  assert.equal(isStripePayment({ stripePaymentIntentId: 'pi_1' }), true)
  assert.equal(isStripePayment({ stripeChargeId: 'ch_1' }), true)
  assert.equal(isStripePayment({}), false)
  assert.equal(isStripePayment({ stripePaymentIntentId: null, stripeChargeId: null }), false)
})

test('safeToDistributeCents: reserves + obligations are held back first', () => {
  // $10,000 cash, hold $2,000 worker pay + $500 bills + $2,500 tax + $1,000 emergency
  assert.equal(
    safeToDistributeCents({
      cashAvailableCents: 1000000,
      upcomingWorkerPayCents: 200000,
      upcomingBillsCents: 50000,
      taxReserveCents: 250000,
      emergencyReserveCents: 100000,
    }),
    400000,
  )
})

test('safeToDistributeCents: never negative when obligations exceed cash', () => {
  assert.equal(
    safeToDistributeCents({
      cashAvailableCents: 10000,
      upcomingWorkerPayCents: 50000,
      upcomingBillsCents: 0,
      taxReserveCents: 0,
      emergencyReserveCents: 0,
    }),
    0,
  )
})
