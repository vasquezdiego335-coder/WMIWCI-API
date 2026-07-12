import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingPricing, isRealPayment } from '../pricing'

test('internal-test payments are excluded from collected money', () => {
  const p = bookingPricing({
    baseRate: 409, totalEstimate: 409, depositAmount: 4900,
    payments: [
      { amount: 4900, status: 'COMPLETED' },                        // real customer deposit
      { amount: 4900, status: 'COMPLETED', isInternalTest: true },  // owner checkout test
      { amount: 100, status: 'COMPLETED', isInternalTest: true },   // $1 test
    ],
  })
  assert.equal(p.collectedDollars, 49) // only the real $49
})

test('internal-test refunds are excluded from refunded money', () => {
  const p = bookingPricing({ payments: [{ amount: 4900, status: 'REFUNDED', isInternalTest: true }] })
  assert.equal(p.refundedDollars, 0)
})

test('isRealPayment: captured+real true; test/pending/undefined-flag correct', () => {
  assert.equal(isRealPayment({ amount: 1, status: 'COMPLETED' }), true)
  assert.equal(isRealPayment({ amount: 1, status: 'COMPLETED', isInternalTest: true }), false)
  assert.equal(isRealPayment({ amount: 1, status: 'PENDING' }), false)
  assert.equal(isRealPayment({ amount: 1, status: 'COMPLETED', isInternalTest: null }), true)
})

test('a booking with ONLY test payments shows deposit as not captured-by-money', () => {
  const p = bookingPricing({
    depositPaid: false,
    payments: [{ amount: 4900, status: 'COMPLETED', isInternalTest: true }],
  })
  assert.equal(p.collectedDollars, 0)
  assert.equal(p.depositCaptured, false) // test money never fakes a captured deposit
})
