// Offline tests for the send guard's PURE parts: classification, idempotency
// keys, address validation, quiet hours. The DB-backed path (suppression,
// caps, the claim) is exercised in the staging scenarios, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTemplate,
  buildIdempotencyKey,
  isValidEmailAddress,
  inQuietHours,
  nextAllowedTime,
  etHour,
} from '../email-guard'

// ── classification: the legal + deliverability boundary ─────────────────

test('booking-lifecycle templates are TRANSACTIONAL', () => {
  for (const t of [
    'pre-approval',
    'final-confirmation',
    'booking-declined',
    'payment-receipt',
    'payment-failed',
    'booking-updated',
    'booking-cancellation',
    'reschedule-request',
    'job-reminder',
    'job-completion',
    'information-required',
    'operational-alert',
    'final-invoice',
  ]) {
    assert.equal(classifyTemplate(t), 'transactional', t)
  }
})

test('marketing templates are PROMOTIONAL', () => {
  for (const t of [
    'abandoned-checkout',
    'abandoned-checkout-2',
    'abandoned-checkout-3',
    'review-request',
    'review-reminder',
    'referral',
    'referral-reward',
    'repeat-reminder',
    'quote-followup-1',
    'quote-followup-2',
    'quote-followup-final',
    'reactivation',
  ]) {
    assert.equal(classifyTemplate(t), 'promotional', t)
  }
})

test('an UNKNOWN template defaults to promotional — the safer side', () => {
  // Promotional means: suppression checks, frequency caps, quiet hours, and an
  // unsubscribe link. Defaulting to transactional would let a new marketing
  // template skip all four just by not being listed.
  assert.equal(classifyTemplate('some-new-campaign'), 'promotional')
  assert.equal(classifyTemplate(''), 'promotional')
})

// ── idempotency keys ────────────────────────────────────────────────────

test('the same send produces the same key (address case + spacing ignored)', () => {
  const a = buildIdempotencyKey({ email: 'A@B.com', template: 'referral', journey: 'post-job', eventId: 'bk1' })
  const b = buildIdempotencyKey({ email: '  a@b.com ', template: 'referral', journey: 'post-job', eventId: 'bk1' })
  assert.equal(a, b)
})

test('every component changes the key', () => {
  const base = { email: 'a@b.com', template: 'referral', journey: 'post-job', eventId: 'bk1', version: 'v1' }
  const key = buildIdempotencyKey(base)
  assert.notEqual(key, buildIdempotencyKey({ ...base, email: 'z@b.com' }))
  assert.notEqual(key, buildIdempotencyKey({ ...base, template: 'review-request' }))
  assert.notEqual(key, buildIdempotencyKey({ ...base, journey: 'abandoned' }))
  assert.notEqual(key, buildIdempotencyKey({ ...base, eventId: 'bk2' }))
  assert.notEqual(key, buildIdempotencyKey({ ...base, version: 'v2' }))
})

test('two stages of one journey are different sends', () => {
  const s1 = buildIdempotencyKey({ email: 'a@b.com', template: 'abandoned-checkout', journey: 'abandoned', eventId: 'bk1' })
  const s2 = buildIdempotencyKey({ email: 'a@b.com', template: 'abandoned-checkout-2', journey: 'abandoned', eventId: 'bk1' })
  assert.notEqual(s1, s2)
})

test('missing optional parts are stable, not random', () => {
  const a = buildIdempotencyKey({ email: 'a@b.com', template: 'x' })
  const b = buildIdempotencyKey({ email: 'a@b.com', template: 'x' })
  assert.equal(a, b)
  assert.match(a, /none/)
})

// ── recipient validation ────────────────────────────────────────────────

test('real addresses pass', () => {
  for (const e of ['a@b.co', 'first.last@example.com', 'x+tag@sub.example.co.uk', ' Mixed@Case.COM ']) {
    assert.equal(isValidEmailAddress(e), true, e)
  }
})

test('the cases that actually reach send paths are rejected', () => {
  for (const e of ['', '   ', 'no-at-sign', '@example.com', 'a@', 'a@b', 'a b@example.com', 'a@ex ample.com']) {
    assert.equal(isValidEmailAddress(e), false, JSON.stringify(e))
  }
})

test('an absurdly long address is rejected', () => {
  assert.equal(isValidEmailAddress(`${'a'.repeat(250)}@example.com`), false)
})

// ── quiet hours (America/New_York, DST-safe) ────────────────────────────

test('etHour reads the New York hour regardless of host timezone', () => {
  // 2026-07-20T16:00Z = 12:00 EDT (UTC-4 in July).
  assert.equal(etHour(new Date('2026-07-20T16:00:00Z')), 12)
  // 2026-01-20T16:00Z = 11:00 EST (UTC-5 in January) — DST handled.
  assert.equal(etHour(new Date('2026-01-20T16:00:00Z')), 11)
})

test('midday is allowed; late night and early morning are quiet', () => {
  assert.equal(inQuietHours(new Date('2026-07-20T16:00:00Z')), false) // 12:00 ET
  assert.equal(inQuietHours(new Date('2026-07-21T05:00:00Z')), true) // 01:00 ET
  assert.equal(inQuietHours(new Date('2026-07-21T02:00:00Z')), true) // 22:00 ET
})

test('the quiet-hours boundaries are inclusive at 8am and exclusive at 9pm', () => {
  assert.equal(inQuietHours(new Date('2026-07-20T12:00:00Z')), false) // 08:00 ET — allowed
  assert.equal(inQuietHours(new Date('2026-07-20T11:00:00Z')), true) // 07:00 ET — quiet
  assert.equal(inQuietHours(new Date('2026-07-21T00:30:00Z')), false) // 20:30 ET — allowed
  assert.equal(inQuietHours(new Date('2026-07-21T01:00:00Z')), true) // 21:00 ET — quiet
})

test('nextAllowedTime walks a quiet moment forward into the window', () => {
  const quiet = new Date('2026-07-21T05:00:00Z') // 01:00 ET
  const allowed = nextAllowedTime(quiet)
  assert.ok(allowed.getTime() > quiet.getTime())
  assert.equal(inQuietHours(allowed), false)
  assert.equal(etHour(allowed), 8)
})

test('nextAllowedTime leaves an already-allowed moment untouched', () => {
  const ok = new Date('2026-07-20T16:00:00Z')
  assert.equal(nextAllowedTime(ok).getTime(), ok.getTime())
})
