import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, type StripeChargeLite, type PaymentLite, type BookingLite } from '../reconciliation'

// Offline tests for the pure reconciliation detector.

const charge = (o: Partial<StripeChargeLite> = {}): StripeChargeLite => ({
  paymentIntentId: 'pi_1', chargeId: 'ch_1', amountCaptured: 4900, amountRefunded: 0, captured: true, disputed: false, status: 'succeeded', ...o,
})
const payment = (o: Partial<PaymentLite> = {}): PaymentLite => ({
  id: 'pay_1', bookingId: 'bk_1', stripePaymentIntentId: 'pi_1', stripeChargeId: 'ch_1', amount: 4900, status: 'COMPLETED', refundedAmountCents: null, stripeDisputeId: null, isInternalTest: false, ...o,
})
const booking = (o: Partial<BookingLite> = {}): BookingLite => ({
  id: 'bk_1', displayId: 'WMIC-1001', status: 'CONFIRMED', isInternalTest: false, ...o,
})

test('clean state → no issues', () => {
  const issues = reconcile({ stripeCharges: [charge()], payments: [payment()], bookings: [booking()] })
  assert.equal(issues.length, 0)
})

test('captured charge with no Payment row → critical', () => {
  const issues = reconcile({ stripeCharges: [charge()], payments: [], bookings: [] })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].type, 'captured_no_payment_row')
  assert.equal(issues[0].severity, 'critical')
})

test('confirmed booking with no COMPLETED payment → high', () => {
  const issues = reconcile({ stripeCharges: [], payments: [], bookings: [booking({ status: 'SCHEDULED' })] })
  assert.equal(issues.some((i) => i.type === 'confirmed_no_payment'), true)
})

test('internal-test booking is NOT flagged for missing payment', () => {
  const issues = reconcile({ stripeCharges: [], payments: [], bookings: [booking({ isInternalTest: true })] })
  assert.equal(issues.length, 0)
})

test('amount mismatch → high', () => {
  const issues = reconcile({ stripeCharges: [charge({ amountCaptured: 4900 })], payments: [payment({ amount: 4800 })], bookings: [booking()] })
  assert.equal(issues.some((i) => i.type === 'amount_mismatch'), true)
})

test('duplicate payments for one intent → flagged', () => {
  const issues = reconcile({
    stripeCharges: [charge()],
    payments: [payment({ id: 'pay_1' }), payment({ id: 'pay_2' })],
    bookings: [booking()],
  })
  assert.equal(issues.some((i) => i.type === 'duplicate_payment'), true)
})

test('two COMPLETED payments on one booking → flagged', () => {
  const issues = reconcile({
    stripeCharges: [],
    payments: [payment({ id: 'pay_1', stripePaymentIntentId: 'pi_1' }), payment({ id: 'pay_2', stripePaymentIntentId: 'pi_2', stripeChargeId: 'ch_2' })],
    bookings: [booking()],
  })
  assert.equal(issues.some((i) => i.type === 'duplicate_payment' && i.ref === 'bk_1'), true)
})

test('refund on Stripe but DB not marked refunded → high', () => {
  const issues = reconcile({
    stripeCharges: [charge({ amountRefunded: 2000 })],
    payments: [payment({ status: 'COMPLETED', refundedAmountCents: null })],
    bookings: [booking()],
  })
  assert.equal(issues.some((i) => i.type === 'refund_state_mismatch'), true)
})

test('refund correctly recorded → no refund mismatch', () => {
  const issues = reconcile({
    stripeCharges: [charge({ amountRefunded: 2000 })],
    payments: [payment({ status: 'PARTIALLY_REFUNDED', refundedAmountCents: 2000 })],
    bookings: [booking()],
  })
  assert.equal(issues.some((i) => i.type === 'refund_state_mismatch'), false)
})

test('dispute on Stripe but no disputeId in DB → high', () => {
  const issues = reconcile({
    stripeCharges: [charge({ disputed: true })],
    payments: [payment({ stripeDisputeId: null })],
    bookings: [booking()],
  })
  assert.equal(issues.some((i) => i.type === 'dispute_state_mismatch'), true)
})
