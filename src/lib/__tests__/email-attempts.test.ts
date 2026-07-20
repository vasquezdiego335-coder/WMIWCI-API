// Offline tests for the attempt state machine's PURE logic
// (findings EMAIL-P1-03 and EMAIL-P1-04).
//
// The DB-backed claim/resume path needs Postgres and is covered by the staging
// scenarios; what is testable offline — and what actually encodes the fix — is
// the CLASSIFICATION of an outcome as terminal, retryable, or deferred. That
// classification is the whole difference between "this email will be sent
// later" and "this email is lost forever".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBlock, MAX_SEND_ATTEMPTS, SENDING_STALE_MS } from '../email-guard'

// ── EMAIL-P1-04: temporary conditions must NOT be terminal ──────────────

test('quiet hours and frequency caps are DEFERRALS, not blocks', () => {
  // These were the headline P1-04 cases: a cap or a quiet window permanently
  // consumed the delivery key, so the email could never be sent afterwards.
  for (const r of ['quiet_hours', 'transactional_gap', 'cap_daily', 'cap_weekly', 'cap_monthly']) {
    assert.equal(classifyBlock(r), 'deferred', r)
  }
})

test('infrastructure failures are RETRYABLE — the send must survive an outage', () => {
  for (const r of [
    'suppression_read_failed',
    'state_read_failed',
    'eligibility_read_failed',
    'claim_lookup_failed',
  ]) {
    assert.equal(classifyBlock(r), 'retryable', r)
  }
})

test('a validation failure is RETRYABLE — a missing URL is fixable', () => {
  // A missing portal URL or an unconfigured review link is a configuration gap.
  // Marking it terminal meant fixing the config could never rescue the email.
  assert.equal(classifyBlock('validation: final-confirmation: missing required field(s): portalUrl'), 'retryable')
  assert.equal(classifyBlock('validation: Unsafe email link(s): checkoutUrl: placeholder (empty/#)'), 'retryable')
  assert.equal(classifyBlock('missing-configuration:review-url'), 'retryable')
})

test('an UNKNOWN reason defaults to RETRYABLE — the safe direction', () => {
  // Wrongly terminal loses a real email. Wrongly retryable costs a re-check
  // that refuses again. The asymmetry decides the default.
  assert.equal(classifyBlock('something_nobody_has_written_yet'), 'retryable')
  assert.equal(classifyBlock(''), 'retryable')
})

// ── genuinely permanent conditions stay terminal ────────────────────────

test('hard suppression is TERMINAL — a bounce is not something to retry', () => {
  for (const r of ['hard_bounce', 'spam_complaint', 'invalid_address', 'admin_block', 'unsubscribed']) {
    assert.equal(classifyBlock(r), 'terminal', r)
  }
})

test('an unusable recipient is TERMINAL', () => {
  for (const r of ['invalid_email', 'blank_email', 'booking_deleted', 'internal_test_booking']) {
    assert.equal(classifyBlock(r), 'terminal', r)
  }
})

test('booking state that cannot come back is TERMINAL', () => {
  for (const r of [
    'status_not_allowed:CANCELLED',
    'status_not_allowed:PENDING_PAYMENT',
    'booking_not_completed:CANCELLED',
    'booking_advanced:CONFIRMED',
    'move_date_passed',
    'deposit_already_paid',
    'lead_converted',
    'lead_lost',
  ]) {
    assert.equal(classifyBlock(r), 'terminal', r)
  }
})

test('a duplicate is TERMINAL — the customer already has it', () => {
  assert.equal(classifyBlock('duplicate'), 'terminal')
})

// ── the deferred/terminal boundary is the whole point ───────────────────

test('no reason is classified in two categories', () => {
  const reasons = [
    'quiet_hours', 'cap_daily', 'cap_weekly', 'cap_monthly', 'transactional_gap',
    'hard_bounce', 'spam_complaint', 'invalid_email', 'duplicate', 'move_date_passed',
    'suppression_read_failed', 'validation: x', 'missing-configuration:review-url',
  ]
  for (const r of reasons) {
    const c = classifyBlock(r)
    assert.ok(['terminal', 'retryable', 'deferred'].includes(c), `${r} → ${c}`)
    // Stable across calls.
    assert.equal(classifyBlock(r), c, `${r} is not deterministic`)
  }
})

test('a cap is never terminal and a bounce is never deferred — the P1-04 invariant', () => {
  assert.notEqual(classifyBlock('cap_daily'), 'terminal')
  assert.notEqual(classifyBlock('quiet_hours'), 'terminal')
  assert.notEqual(classifyBlock('hard_bounce'), 'deferred')
  assert.notEqual(classifyBlock('spam_complaint'), 'deferred')
})

// ── attempt bounds ──────────────────────────────────────────────────────

test('attempt and staleness bounds are sane', () => {
  assert.ok(MAX_SEND_ATTEMPTS >= 2, 'at least one retry must be possible — that is P1-03')
  assert.ok(MAX_SEND_ATTEMPTS <= 20, 'bounded, so a poisoned send cannot loop forever')
  assert.ok(SENDING_STALE_MS >= 60_000, 'long enough that two workers do not race a live attempt')
})
