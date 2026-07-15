import { test } from 'node:test'
import assert from 'node:assert/strict'
import { testPaymentsEnabled, resolveTestAmountCents, TEST_AMOUNT_DEFAULT_CENTS } from '../test-payments'

// Offline tests for the controlled test-payment gate + amount clamp.

test('testPaymentsEnabled is OFF unless explicitly "true"', () => {
  assert.equal(testPaymentsEnabled({}), false)
  assert.equal(testPaymentsEnabled({ ALLOW_TEST_PAYMENTS: 'false' }), false)
  assert.equal(testPaymentsEnabled({ ALLOW_TEST_PAYMENTS: '1' }), false)
  assert.equal(testPaymentsEnabled({ ALLOW_TEST_PAYMENTS: 'TRUE' }), false) // case-sensitive on purpose
  assert.equal(testPaymentsEnabled({ ALLOW_TEST_PAYMENTS: 'true' }), true)
})

test('resolveTestAmountCents defaults to $1', () => {
  assert.equal(resolveTestAmountCents({}), TEST_AMOUNT_DEFAULT_CENTS)
  assert.equal(resolveTestAmountCents({}), 100)
})

test('resolveTestAmountCents clamps to [50, 4900]', () => {
  assert.equal(resolveTestAmountCents({ TEST_PAYMENT_AMOUNT_CENTS: '0' }), 100) // invalid → default
  assert.equal(resolveTestAmountCents({ TEST_PAYMENT_AMOUNT_CENTS: '-500' }), 100) // invalid → default
  assert.equal(resolveTestAmountCents({ TEST_PAYMENT_AMOUNT_CENTS: '10' }), 50) // below min → floor
  assert.equal(resolveTestAmountCents({ TEST_PAYMENT_AMOUNT_CENTS: '999999' }), 4900) // above max → cap
  assert.equal(resolveTestAmountCents({ TEST_PAYMENT_AMOUNT_CENTS: '200' }), 200) // in-range
})
