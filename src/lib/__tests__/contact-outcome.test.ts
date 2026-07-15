import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideContactOutcome } from '../contact-outcome'

// The whole point: a lost lead must never look like a success to the customer.

test('persisted + discord ok → normal success (200)', () => {
  const o = decideContactOutcome(true, true)
  assert.deepEqual(o, { httpStatus: 200, ok: true, recoverable: false })
})

test('persisted but discord FAILED → still success (lead is durable)', () => {
  const o = decideContactOutcome(true, false)
  assert.equal(o.ok, true)
  assert.equal(o.httpStatus, 200)
})

test('DB write FAILED but discord ok → recoverable error, NOT success', () => {
  const o = decideContactOutcome(false, true)
  assert.equal(o.ok, false)
  assert.equal(o.recoverable, true)
  assert.equal(o.httpStatus, 503)
})

test('DB write FAILED and discord FAILED → recoverable error, NOT success', () => {
  const o = decideContactOutcome(false, false)
  assert.equal(o.ok, false)
  assert.equal(o.recoverable, true)
  assert.equal(o.httpStatus, 503)
})

test('a failed persistence is never reported ok regardless of discord', () => {
  for (const d of [true, false]) {
    assert.equal(decideContactOutcome(false, d).ok, false)
  }
})
