// Phase 0 financial integrity — revenue recognition + expense eligibility.
// These are the rules that every money figure in the admin depends on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCapturedPayment,
  isAuthorizedNotCaptured,
  refundedCentsOf,
  hasUnknownRefundAmount,
  chargebackCentsOf,
  pendingDisputeCentsOf,
  netCollectedCentsOf,
  summarizeRevenue,
  isEligibleExpense,
  isUnreviewedExpense,
  eligibleExpenseCents,
  countUnreviewedExpenses,
  ELIGIBLE_EXPENSE_WHERE,
  hasPaySignal,
  isConfirmedZeroLabor,
  isLaborUnrecorded,
  isPaidCrew,
  isUnpaidCrew,
} from '../money-rules'

// ── The four scenarios the owner spec names explicitly ──────────────────────

test('REGRESSION: $2,000 captured, no refund -> $2,000 net collected', () => {
  assert.equal(netCollectedCentsOf({ amount: 200000, status: 'COMPLETED' }), 200000)
})

test('REGRESSION: $2,000 captured, $200 refunded -> $1,800 net collected', () => {
  // The bug this replaces reported -$2,000: the payment was dropped from
  // revenue (status != COMPLETED) AND its full face value became a cost.
  const p = { amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: 20000 }
  assert.equal(netCollectedCentsOf(p), 180000)
  assert.equal(refundedCentsOf(p), 20000)
})

test('REGRESSION: $2,000 captured, $2,000 refunded -> $0 net collected (never negative)', () => {
  const p = { amount: 200000, status: 'REFUNDED', refundedAmountCents: 200000 }
  assert.equal(netCollectedCentsOf(p), 0)
})

test('failed payment collects nothing', () => {
  assert.equal(netCollectedCentsOf({ amount: 200000, status: 'FAILED' }), 0)
  assert.equal(isCapturedPayment({ amount: 200000, status: 'FAILED' }), false)
})

test('authorized-but-not-captured is classified as a hold, never revenue', () => {
  const hold = { amount: 4900, status: 'PENDING' }
  assert.equal(isAuthorizedNotCaptured(hold), true)
  assert.equal(isCapturedPayment(hold), false)
  assert.equal(netCollectedCentsOf(hold), 0)
  const r = summarizeRevenue([hold])
  assert.equal(r.netCollectedCents, 0)
  assert.equal(r.authorizedNotCapturedCents, 4900)
})

test('multiple captures with one partial refund net correctly', () => {
  const r = summarizeRevenue([
    { amount: 4900, status: 'COMPLETED' }, // deposit
    { amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: 20000 }, // move-day
    { amount: 5000, status: 'FAILED' }, // ignored
  ])
  assert.equal(r.grossCapturedCents, 204900)
  assert.equal(r.refundedCents, 20000)
  assert.equal(r.netCollectedCents, 184900)
})

test('a refund is never subtracted twice within one payment', () => {
  // Refund AND a lost dispute on the same charge: the chargeback can only take
  // what the refund left, so the total deduction is capped at the capture.
  const p = { amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: 50000, stripeDisputeId: 'dp_1', disputeStatus: 'lost' }
  assert.equal(refundedCentsOf(p), 50000)
  assert.equal(chargebackCentsOf(p), 150000)
  assert.equal(netCollectedCentsOf(p), 0) // not -50000
})

// ── Refund-amount edge cases ────────────────────────────────────────────────

test('REFUNDED with a null amount infers a full refund', () => {
  const p = { amount: 200000, status: 'REFUNDED', refundedAmountCents: null }
  assert.equal(refundedCentsOf(p), 200000)
  assert.equal(netCollectedCentsOf(p), 0)
  assert.equal(hasUnknownRefundAmount(p), false)
})

test('PARTIALLY_REFUNDED with a null amount is flagged UNKNOWN, never guessed', () => {
  const p = { amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: null }
  assert.equal(hasUnknownRefundAmount(p), true)
  assert.equal(refundedCentsOf(p), 0) // no invented number
  assert.equal(summarizeRevenue([p]).hasUnknownRefund, true)
})

test('a refund larger than the capture is clamped, not allowed to go negative', () => {
  const p = { amount: 100000, status: 'REFUNDED', refundedAmountCents: 150000 }
  assert.equal(refundedCentsOf(p), 100000)
  assert.equal(netCollectedCentsOf(p), 0)
  assert.equal(hasUnknownRefundAmount(p), true) // out of range -> data problem
})

test('internal test payments are never revenue', () => {
  const p = { amount: 200000, status: 'COMPLETED', isInternalTest: true }
  assert.equal(isCapturedPayment(p), false)
  assert.equal(netCollectedCentsOf(p), 0)
})

// ── Disputes ────────────────────────────────────────────────────────────────

test('an OPEN dispute does not reduce revenue but is reported as at-risk', () => {
  const p = { amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_1', disputeStatus: 'needs_response' }
  assert.equal(chargebackCentsOf(p), 0)
  assert.equal(pendingDisputeCentsOf(p), 200000)
  assert.equal(netCollectedCentsOf(p), 200000)
})

test('a LOST dispute removes the money from revenue', () => {
  const p = { amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_1', disputeStatus: 'lost' }
  assert.equal(chargebackCentsOf(p), 200000)
  assert.equal(netCollectedCentsOf(p), 0)
})

test('a WON dispute leaves revenue intact', () => {
  const p = { amount: 200000, status: 'COMPLETED', stripeDisputeId: 'dp_1', disputeStatus: 'won' }
  assert.equal(chargebackCentsOf(p), 0)
  assert.equal(pendingDisputeCentsOf(p), 0)
  assert.equal(netCollectedCentsOf(p), 200000)
})

// ── Expense eligibility ─────────────────────────────────────────────────────

const EXPENSES = [
  { amount: 10000, status: 'APPROVED' },
  { amount: 5000, status: 'SUBMITTED' },
  { amount: 2500, status: 'NEEDS_REVIEW' },
  { amount: 7500, status: 'REIMBURSED' },
  { amount: 99900, status: 'REJECTED' },
]

test('approved expenses count', () => {
  assert.equal(isEligibleExpense({ amount: 1, status: 'APPROVED' }), true)
  assert.equal(isEligibleExpense({ amount: 1, status: 'REIMBURSED' }), true)
})

test('rejected expenses count NOWHERE', () => {
  assert.equal(isEligibleExpense({ amount: 99900, status: 'REJECTED' }), false)
  assert.equal(eligibleExpenseCents([{ amount: 99900, status: 'REJECTED' }]), 0)
})

test('pending expenses follow the documented policy: counted, flagged unreviewed', () => {
  assert.equal(isEligibleExpense({ amount: 5000, status: 'SUBMITTED' }), true)
  assert.equal(isUnreviewedExpense({ amount: 5000, status: 'SUBMITTED' }), true)
  assert.equal(isUnreviewedExpense({ amount: 5000, status: 'APPROVED' }), false)
  assert.equal(countUnreviewedExpenses(EXPENSES), 2)
})

test('the same expense set produces ONE eligible total (page parity)', () => {
  // 10000 + 5000 + 2500 + 7500 = 25000; the 99900 rejected row is excluded.
  const total = eligibleExpenseCents(EXPENSES)
  assert.equal(total, 25000)
  // Whatever a page does, it must go through this function — proven by every
  // caller using it rather than a local filter.
  assert.equal(eligibleExpenseCents(EXPENSES.filter(isEligibleExpense)), total)
})

test('flipping an approved expense to rejected removes it from the total', () => {
  const before = eligibleExpenseCents([{ amount: 30000, status: 'APPROVED' }])
  const after = eligibleExpenseCents([{ amount: 30000, status: 'REJECTED' }])
  assert.equal(before, 30000)
  assert.equal(after, 0)
})

test('an owner-paid REJECTED expense creates no cost anywhere', () => {
  // Reimbursement owed derives from OwnerTransaction, never from Expense rows,
  // so a rejected reimbursable expense cannot manufacture money owed.
  assert.equal(eligibleExpenseCents([{ amount: 45000, status: 'REJECTED' }]), 0)
})

test('the shared Prisma where-fragment excludes exactly REJECTED', () => {
  assert.deepEqual(ELIGIBLE_EXPENSE_WHERE, { status: { notIn: ['REJECTED'] } })
})

// ── Crew labor signals ──────────────────────────────────────────────────────

test('hasPaySignal: flat pay, or hours WITH a rate', () => {
  assert.equal(hasPaySignal({ flatPay: 20000 }), true)
  assert.equal(hasPaySignal({ actualHours: 4, payRate: 3000 }), true)
  assert.equal(hasPaySignal({ scheduledHours: 4, user: { payRate: 2500 } }), true)
  assert.equal(hasPaySignal({ actualHours: 4 }), false) // hours but no rate
  assert.equal(hasPaySignal({}), false)
})

test('no crew rows at all -> labor UNRECORDED (not zero)', () => {
  assert.equal(isLaborUnrecorded([]), true)
  assert.equal(isConfirmedZeroLabor([]), false)
})

test('crew assigned but no hours/rate ever entered -> labor UNRECORDED', () => {
  assert.equal(isLaborUnrecorded([{ payStatus: 'SCHEDULED' }]), true)
})

test('explicit zero labor is CONFIRMED, not missing', () => {
  const crew = [{ flatPay: 0, actualHours: 0, payRate: 0 }]
  assert.equal(isConfirmedZeroLabor(crew), true)
  assert.equal(isLaborUnrecorded(crew), false)
})

test('real labor is neither unrecorded nor confirmed-zero', () => {
  const crew = [{ actualHours: 8, payRate: 3000 }]
  assert.equal(isLaborUnrecorded(crew), false)
  assert.equal(isConfirmedZeroLabor(crew), false)
})

test('paid vs unpaid crew are mutually exclusive (no double subtraction)', () => {
  const crew = [{ payStatus: 'PAID' }, { payStatus: 'PAY_APPROVED' }, { payStatus: 'SCHEDULED' }]
  assert.equal(crew.filter(isPaidCrew).length, 1)
  assert.equal(crew.filter(isUnpaidCrew).length, 2)
  assert.equal(crew.filter(isPaidCrew).length + crew.filter(isUnpaidCrew).length, crew.length)
})
