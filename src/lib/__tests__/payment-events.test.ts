import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  monotonicRefund,
  refundStatusFor,
  refundPatch,
  disputeOutcome,
  disputeIsAlertable,
} from '../payment-events'

// ════════════════════════════════════════════════════════════════════════
//  Pure refund/dispute state logic. These prove the money invariants used by
//  the Stripe webhook: monotonic cumulative refunds, correct full/partial
//  status, replay + out-of-order safety, and dispute classification.
// ════════════════════════════════════════════════════════════════════════

test('refundStatusFor: none / partial / full', () => {
  assert.equal(refundStatusFor(4900, 0), null)
  assert.equal(refundStatusFor(4900, 2000), 'PARTIALLY_REFUNDED')
  assert.equal(refundStatusFor(4900, 4900), 'REFUNDED')
  assert.equal(refundStatusFor(4900, 5000), 'REFUNDED') // over-refund still REFUNDED
})

test('monotonicRefund never decreases (replay / out-of-order safe)', () => {
  assert.equal(monotonicRefund(null, 2000), 2000)
  assert.equal(monotonicRefund(2000, 2000), 2000) // replay of same cumulative
  assert.equal(monotonicRefund(4900, 2000), 4900) // stale/out-of-order lower value ignored
  assert.equal(monotonicRefund(2000, 4900), 4900) // advances
})

test('refundPatch: full refund of a captured payment → REFUNDED', () => {
  const p = refundPatch({ amount: 4900, refundedAmountCents: null, status: 'COMPLETED' }, 4900, 're_1')
  assert.equal(p.refundedAmountCents, 4900)
  assert.equal(p.status, 'REFUNDED')
  assert.equal(p.stripeRefundId, 're_1')
})

test('refundPatch: partial refund → PARTIALLY_REFUNDED', () => {
  const p = refundPatch({ amount: 4900, refundedAmountCents: null, status: 'COMPLETED' }, 2000, 're_2')
  assert.equal(p.refundedAmountCents, 2000)
  assert.equal(p.status, 'PARTIALLY_REFUNDED')
})

test('refundPatch: repeated (replayed) refund webhook is idempotent', () => {
  const first = refundPatch({ amount: 4900, refundedAmountCents: null, status: 'COMPLETED' }, 2000, 're_2')
  // Replay the SAME cumulative amount → no change, still partial.
  const replay = refundPatch({ amount: 4900, refundedAmountCents: first.refundedAmountCents, status: first.status }, 2000, 're_2')
  assert.equal(replay.refundedAmountCents, 2000)
  assert.equal(replay.status, 'PARTIALLY_REFUNDED')
})

test('refundPatch: partial then full advances forward', () => {
  const partial = refundPatch({ amount: 4900, refundedAmountCents: null, status: 'COMPLETED' }, 2000)
  const full = refundPatch({ amount: 4900, refundedAmountCents: partial.refundedAmountCents, status: partial.status }, 4900)
  assert.equal(full.status, 'REFUNDED')
  assert.equal(full.refundedAmountCents, 4900)
})

test('refundPatch: out-of-order stale event never walks REFUNDED backward', () => {
  // Already fully refunded; a delayed partial-refund event arrives late.
  const stale = refundPatch({ amount: 4900, refundedAmountCents: 4900, status: 'REFUNDED' }, 2000)
  assert.equal(stale.refundedAmountCents, 4900) // monotonic
  assert.equal(stale.status, 'REFUNDED') // never downgraded to PARTIALLY_REFUNDED
})

test('disputeOutcome classifies won / lost / open', () => {
  assert.equal(disputeOutcome('won'), 'won')
  assert.equal(disputeOutcome('warning_closed'), 'won')
  assert.equal(disputeOutcome('lost'), 'lost')
  assert.equal(disputeOutcome('needs_response'), 'open')
  assert.equal(disputeOutcome('under_review'), 'open')
  assert.equal(disputeOutcome(null), 'open')
})

test('disputeIsAlertable: created + closed always alert; updated only on outcome', () => {
  assert.equal(disputeIsAlertable('needs_response', 'created'), true)
  assert.equal(disputeIsAlertable('under_review', 'updated'), false)
  assert.equal(disputeIsAlertable('lost', 'updated'), true)
  assert.equal(disputeIsAlertable('won', 'closed'), true)
})
