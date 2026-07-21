import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isConfirmed, isPending, isClosed, statusMismatchReason, paymentPhase, paymentLabel } from '../status'
import { assertEmailPayload, EmailValidationError } from '../validation'

// ── Truth predicates ─────────────────────────────────────────────────────────
test('isConfirmed / isPending / isClosed partition the states honestly', () => {
  assert.ok(isConfirmed('CONFIRMED'))
  assert.ok(isConfirmed('COMPLETED'))
  assert.ok(!isConfirmed('PENDING_APPROVAL'))
  assert.ok(isPending('PENDING_APPROVAL'))
  assert.ok(isPending('PENDING_PAYMENT'))
  assert.ok(!isPending('CONFIRMED'))
  assert.ok(isClosed('CANCELLED'))
  assert.ok(!isClosed('CONFIRMED'))
  // no status → all false, never throws
  assert.ok(!isConfirmed(undefined))
})

// ── Template ↔ status honesty ────────────────────────────────────────────────
test('final-confirmation is a mismatch for a pending booking', () => {
  assert.ok(statusMismatchReason('final-confirmation', 'PENDING_APPROVAL'))
  assert.equal(statusMismatchReason('final-confirmation', 'CONFIRMED'), null)
  assert.equal(statusMismatchReason('final-confirmation', 'SCHEDULED'), null)
})
test('cancellation/completion/invoice honesty gates', () => {
  assert.ok(statusMismatchReason('booking-cancellation', 'CONFIRMED'))
  assert.equal(statusMismatchReason('booking-cancellation', 'CANCELLED'), null)
  assert.ok(statusMismatchReason('job-completion', 'SCHEDULED'))
  assert.equal(statusMismatchReason('final-invoice', 'COMPLETED'), null)
})
test('unconstrained templates + missing status are never a mismatch', () => {
  assert.equal(statusMismatchReason('pre-approval', 'PENDING_APPROVAL'), null)
  assert.equal(statusMismatchReason('final-confirmation', undefined), null)
})

// ── Wired into the send gate ─────────────────────────────────────────────────
test('assertEmailPayload BLOCKS a confirmation for a pending booking', () => {
  assert.throws(
    () =>
      assertEmailPayload('final-confirmation', {
        bookingStatus: 'PENDING_APPROVAL',
        displayId: 'W', date: 'x', timeLabel: '8-10', amountPaid: '1', portalUrl: 'https://moveitclearit.com/x',
      }),
    EmailValidationError,
  )
})
test('assertEmailPayload ALLOWS a confirmation for a confirmed booking', () => {
  assert.doesNotThrow(() =>
    assertEmailPayload('final-confirmation', {
      bookingStatus: 'CONFIRMED',
      displayId: 'W', date: '2026-08-01T15:00:00Z', timeLabel: '8-10', amountPaid: '1', portalUrl: 'https://moveitclearit.com/x',
    }),
  )
})

// ── Payment language ─────────────────────────────────────────────────────────
test('payment phase/label never calls a hold a charge', () => {
  assert.equal(paymentPhase('PENDING'), 'hold')
  assert.equal(paymentPhase('COMPLETED'), 'charged')
  assert.equal(paymentPhase('PARTIALLY_REFUNDED'), 'partially_refunded')
  assert.equal(paymentLabel('PENDING'), 'Authorization hold')
  assert.equal(paymentLabel('PENDING', true), 'Autorización (retención)')
  assert.equal(paymentLabel('COMPLETED'), 'Payment received')
  assert.notEqual(paymentLabel('PENDING'), paymentLabel('COMPLETED'))
})
