// ============================================================================
// internal-rehearsal.test.ts — Stage 4 D3.
//
// This pathway exists so the closeout can be exercised end to end without
// charging a real card. Its whole value is in what it REFUSES and in the side
// effects it does not have, so that is what these tests pin.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateRehearsal, rehearsalEnabled, buildRehearsalAudit,
  countsTowardCompanyReporting, partitionSynthetic,
  REHEARSAL_SIDE_EFFECTS, REHEARSABLE_BLOCKER,
} from '../internal-rehearsal'
import { computeCloseoutBlockers } from '../closeout-blockers'

const ok = { role: 'OWNER' as const, isInternalTest: true, reason: 'Stage 4 rehearsal', blockerCode: REHEARSABLE_BLOCKER }

// ── Eligibility ─────────────────────────────────────────────────────────────

test('an internal-test move, an owner and a written reason passes eligibility', () => {
  const d = evaluateRehearsal(ok)
  assert.equal(d.allow, true)
  assert.equal(d.allow && d.reason, 'Stage 4 rehearsal')
})

test('a REAL customer booking is denied, and the message blames the booking not the person', () => {
  const d = evaluateRehearsal({ ...ok, isInternalTest: false })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
  assert.match(d.allow === false ? d.error : '', /real customer booking/i)
})

test('omitting the internal-test flag defaults to the SAFE answer', () => {
  const d = evaluateRehearsal({ role: 'OWNER', reason: 'please' })
  assert.equal(d.allow, false)
})

test('OWNER is required — a manager is denied', () => {
  const d = evaluateRehearsal({ ...ok, role: 'MANAGER' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 403)
})

test('crew are denied', () => {
  assert.equal(evaluateRehearsal({ ...ok, role: 'CREW' }).allow, false)
})

test('a reason is required, and whitespace is not a reason', () => {
  assert.equal(evaluateRehearsal({ ...ok, reason: '' }).allow, false)
  assert.equal(evaluateRehearsal({ ...ok, reason: '   ' }).allow, false)
  assert.equal(evaluateRehearsal({ ...ok, reason: undefined }).allow, false)
})

test('a rehearsal covers NO_PAYMENT_DATA and nothing else', () => {
  const d = evaluateRehearsal({ ...ok, blockerCode: 'LABOR_MISSING_RATE' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
})

test('the real-booking check runs BEFORE the role check', () => {
  // A manager on a real booking must be told the booking is real — not that
  // they are the wrong role, which would imply an owner could do it.
  const d = evaluateRehearsal({ ...ok, role: 'MANAGER', isInternalTest: false })
  assert.equal(d.allow === false && d.status, 422)
})

// ── The configuration guard ─────────────────────────────────────────────────

test('the kill switch turns the pathway off entirely', () => {
  const d = evaluateRehearsal({ ...ok, enabled: false })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 503)
})

test('forgetting to set the variable does NOT unlock anything — it stays on, and the other gates still apply', () => {
  assert.equal(rehearsalEnabled(undefined), true)
  assert.equal(rehearsalEnabled(''), true)
  assert.equal(rehearsalEnabled('true'), false)
  assert.equal(rehearsalEnabled('TRUE'), false)
  // Enabled is not permission: a real booking is still refused.
  assert.equal(evaluateRehearsal({ ...ok, isInternalTest: false, enabled: true }).allow, false)
})

// ── Side effects: none ──────────────────────────────────────────────────────

test('no Stripe operation, no customer email, no customer SMS', () => {
  assert.equal(REHEARSAL_SIDE_EFFECTS.stripe, false)
  assert.equal(REHEARSAL_SIDE_EFFECTS.customerEmail, false)
  assert.equal(REHEARSAL_SIDE_EFFECTS.customerSms, false)
  assert.equal(REHEARSAL_SIDE_EFFECTS.discordCustomerMessage, false)
  // And the record of the rehearsal carries that fact with it.
  const audit = buildRehearsalAudit({ bookingId: 'b1', reason: 'rehearsal', byName: 'Diego' })
  assert.deepEqual(audit.sideEffects, { ...REHEARSAL_SIDE_EFFECTS })
})

test('the side-effect declaration cannot be mutated at runtime', () => {
  assert.throws(() => {
    // @ts-expect-error deliberately attempting the mutation this must prevent
    REHEARSAL_SIDE_EFFECTS.stripe = true
  })
})

test('an audit event is recorded, with the reason and the booking', () => {
  const audit = buildRehearsalAudit({ bookingId: 'b1', reason: 'proving the workflow', byName: 'Diego' })
  assert.equal(audit.bookingId, 'b1')
  assert.equal(audit.reason, 'proving the workflow')
  assert.equal(audit.internalTest, true)
  assert.equal(audit.excludedFromReporting, true)
  assert.equal(audit.blockerCode, REHEARSABLE_BLOCKER)
  assert.equal(audit.by, 'Diego')
})

// ── Reporting exclusion ─────────────────────────────────────────────────────

test('synthetic records are excluded from company reporting', () => {
  assert.equal(countsTowardCompanyReporting({ isInternalTest: true }), false)
  assert.equal(countsTowardCompanyReporting({ isInternalTest: false }), true)
  assert.equal(countsTowardCompanyReporting({}), true)
  // Unknown provenance is not evidence of a real sale.
  assert.equal(countsTowardCompanyReporting(null), false)
})

test('a mixed set partitions cleanly, and nothing is lost', () => {
  const rows = [
    { id: 'a', isInternalTest: false },
    { id: 'b', isInternalTest: true },
    { id: 'c' },
  ]
  const { real, synthetic } = partitionSynthetic(rows)
  assert.deepEqual(real.map((r) => r.id), ['a', 'c'])
  assert.deepEqual(synthetic.map((r) => r.id), ['b'])
  assert.equal(real.length + synthetic.length, rows.length)
})

// ── The blocker severity this rides on ──────────────────────────────────────

const base = {
  bookingStatus: 'COMPLETED', hasCapturedPayment: false, hasUnknownRefundAmount: false,
  refundExceedsCaptured: false, outstandingBalanceCents: 0, balanceWriteOffCents: 0,
  disputedOpenCents: 0, disputeAcknowledged: false, laborState: 'PAID',
  truckSourceConfirmed: true, truckSourceIsCostly: false, truckCostRecordedCents: 0,
  expensesMissingReceipt: [], receiptRequiredAboveCents: 2500, pendingExpenseCount: 0,
  ownerReimbursementOwedCents: 0, allocatedToOwnersCents: 0, distributableProfitCents: 0,
  reservesExceedProfit: false, hasNegativeValue: false,
}

test('NO_PAYMENT_DATA is NOT weakened for a real customer booking', () => {
  const real = computeCloseoutBlockers({ ...base, isInternalTest: false })
  assert.equal(real.find((b) => b.code === 'NO_PAYMENT_DATA')?.severity, 'HARD')
})

test('a rehearsal never softens a data-integrity blocker', () => {
  const bad = computeCloseoutBlockers({ ...base, refundExceedsCaptured: true, isInternalTest: true })
  assert.equal(bad.find((b) => b.code === 'REFUND_EXCEEDS_PAYMENT')?.severity, 'HARD')
})
