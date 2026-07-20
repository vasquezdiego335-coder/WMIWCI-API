// Offline tests for the referral eligibility rules (gap audit G1, severity HIGH).
// Pure decision function only — no database, no clock beyond the injected `now`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateReferralEligibility, type ReferralFacts } from '../referral-eligibility'

const NOW = new Date('2026-07-20T12:00:00Z')
const YESTERDAY = new Date('2026-07-19T12:00:00Z')

/** A booking that satisfies EVERY rule. Each test breaks exactly one thing. */
const eligible = (over: Partial<ReferralFacts> = {}): ReferralFacts => ({
  bookingExists: true,
  bookingStatus: 'COMPLETED',
  isInternalTest: false,
  hasStripePayment: true,
  paymentStatus: 'COMPLETED',
  refundedAmountCents: 0,
  receiptSentAt: YESTERDAY,
  programEnabled: true,
  requireStripe: true,
  referralUrl: 'https://www.moveitclearit.com/refer',
  referralCode: 'REFER15',
  ...over,
})

test('a completed, paid, receipted Stripe booking IS eligible', () => {
  const d = evaluateReferralEligibility(eligible(), NOW)
  assert.equal(d.eligible, true)
  assert.equal(d.reason, 'eligible')
})

// ── Every ineligible state the prompt requires a test for ────────────────

test('no booking → not eligible', () => {
  assert.equal(evaluateReferralEligibility(eligible({ bookingExists: false }), NOW).eligible, false)
})

test('booking not completed → not eligible (each non-terminal status)', () => {
  for (const status of ['PENDING_PAYMENT', 'PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']) {
    const d = evaluateReferralEligibility(eligible({ bookingStatus: status }), NOW)
    assert.equal(d.eligible, false, status)
    assert.match(d.reason, /^booking_not_completed:/)
  }
})

test('CANCELLED booking → not eligible', () => {
  const d = evaluateReferralEligibility(eligible({ bookingStatus: 'CANCELLED' }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'booking_not_completed:CANCELLED')
})

test('internal test booking never generates customer marketing', () => {
  const d = evaluateReferralEligibility(eligible({ isInternalTest: true }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'internal_test_booking')
})

test('non-Stripe payment is suppressed when Stripe is required', () => {
  const d = evaluateReferralEligibility(eligible({ hasStripePayment: false }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'no_stripe_payment')
})

test('non-Stripe payment is ALLOWED when the business turns that requirement off', () => {
  const d = evaluateReferralEligibility(eligible({ hasStripePayment: false, requireStripe: false }), NOW)
  assert.equal(d.eligible, true)
})

test('pending payment suppresses', () => {
  const d = evaluateReferralEligibility(eligible({ paymentStatus: 'PENDING' }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'payment_not_completed:PENDING')
})

test('failed payment suppresses', () => {
  assert.equal(evaluateReferralEligibility(eligible({ paymentStatus: 'FAILED' }), NOW).eligible, false)
})

test('missing payment suppresses with an informative reason', () => {
  const d = evaluateReferralEligibility(eligible({ paymentStatus: null }), NOW)
  assert.equal(d.reason, 'payment_not_completed:none')
})

test('a refunded job never asks for referrals', () => {
  const d = evaluateReferralEligibility(eligible({ refundedAmountCents: 4900 }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'payment_refunded')
})

test('missing receipt event suppresses', () => {
  const d = evaluateReferralEligibility(eligible({ receiptSentAt: null }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'no_receipt_event')
})

test('a receipt event dated in the FUTURE is bad data, not proof', () => {
  const future = new Date(NOW.getTime() + 60 * 60 * 1000)
  const d = evaluateReferralEligibility(eligible({ receiptSentAt: future }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'receipt_event_in_future')
})

test('a receipt event at exactly `now` is accepted (boundary)', () => {
  assert.equal(evaluateReferralEligibility(eligible({ receiptSentAt: NOW }), NOW).eligible, true)
})

test('referral program disabled suppresses', () => {
  const d = evaluateReferralEligibility(eligible({ programEnabled: false }), NOW)
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'referral_program_disabled')
})

test('an invalid or placeholder referral URL suppresses', () => {
  for (const url of [null, '', '#', 'javascript:alert(1)', 'http://insecure.example.com', 'https://x.vercel.app/refer']) {
    const d = evaluateReferralEligibility(eligible({ referralUrl: url }), NOW)
    assert.equal(d.eligible, false, String(url))
    assert.equal(d.reason, 'invalid_referral_url')
  }
})

test('a missing referral code suppresses', () => {
  for (const code of [null, '', '   ']) {
    const d = evaluateReferralEligibility(eligible({ referralCode: code }), NOW)
    assert.equal(d.eligible, false, JSON.stringify(code))
    assert.equal(d.reason, 'missing_referral_code')
  }
})

test('the FIRST failing rule is reported, so the admin sees the real blocker', () => {
  // Cancelled AND unpaid AND no receipt — status is checked first.
  const d = evaluateReferralEligibility(
    eligible({ bookingStatus: 'CANCELLED', paymentStatus: 'FAILED', receiptSentAt: null }),
    NOW
  )
  assert.equal(d.reason, 'booking_not_completed:CANCELLED')
})
