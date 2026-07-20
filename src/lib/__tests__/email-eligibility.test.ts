// Offline tests for the CANONICAL booking eligibility predicate (EMAIL-P0-02).
// Pure decision function only — the live reload needs a database and is covered
// by the staging scenarios.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingBlockReason, movePassed, effectiveMoveDate, type BookingSnapshot } from '../email-eligibility'
import { CONFIRMED_STATES, PENDING_STATES, TEMPLATE_ALLOWED_STATUSES } from '../../emails/status'

const NOW = new Date('2026-07-20T15:00:00Z')
const FUTURE = new Date('2026-08-15T15:00:00Z')
const PAST = new Date('2026-07-10T15:00:00Z')

/** Every BookingStatus value in the Prisma enum. The gate must handle all of them. */
const ALL_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'ARCHIVED',
  'CANCELLED',
] as const

const snap = (over: Partial<BookingSnapshot> = {}): BookingSnapshot => ({
  status: 'CONFIRMED',
  isInternalTest: false,
  depositPaid: true,
  completedAt: null,
  requestedDate: FUTURE,
  confirmedDate: FUTURE,
  scheduledStart: FUTURE,
  ...over,
})

// ── THE P0-02 CORE: final-confirmation across every status ──────────────

test('final-confirmation is allowed ONLY in the confirmed states', () => {
  for (const status of ALL_STATUSES) {
    const reason = bookingBlockReason('final-confirmation', snap({ status }), NOW)
    const shouldAllow = (CONFIRMED_STATES as readonly string[]).includes(status)
    assert.equal(reason === null, shouldAllow, `${status} → ${reason}`)
  }
})

test('final-confirmation is blocked for every PENDING state — the exact P0-02 defect', () => {
  // The old hand-written switch blocked only CANCELLED, so all three of these
  // could ship a "your booking is approved" email for an unapproved booking.
  for (const status of PENDING_STATES) {
    const reason = bookingBlockReason('final-confirmation', snap({ status }), NOW)
    assert.equal(reason, `status_not_allowed:${status}`, status)
  }
})

test('final-confirmation is blocked for ARCHIVED and CANCELLED', () => {
  assert.equal(bookingBlockReason('final-confirmation', snap({ status: 'ARCHIVED' }), NOW), 'status_not_allowed:ARCHIVED')
  assert.equal(bookingBlockReason('final-confirmation', snap({ status: 'CANCELLED' }), NOW), 'status_not_allowed:CANCELLED')
})

test('a CONFIRMED status is NOT sufficient — the deposit must really be captured', () => {
  // A status is a label. "Your booking is approved" asserts money was captured;
  // an admin can flip status without that having happened.
  const reason = bookingBlockReason('final-confirmation', snap({ status: 'CONFIRMED', depositPaid: false }), NOW)
  assert.equal(reason, 'deposit_not_captured')
})

test('a fully confirmed, captured booking passes', () => {
  assert.equal(bookingBlockReason('final-confirmation', snap(), NOW), null)
})

// ── the gate is not opt-in: a missing booking blocks ────────────────────

test('a deleted booking blocks every template', () => {
  for (const t of ['final-confirmation', 'job-reminder', 'referral', 'abandoned-checkout']) {
    assert.equal(bookingBlockReason(t, null, NOW), 'booking_deleted', t)
  }
})

test('an internal-test booking blocks every template, in every status', () => {
  for (const status of ALL_STATUSES) {
    assert.equal(
      bookingBlockReason('final-confirmation', snap({ status, isInternalTest: true }), NOW),
      'internal_test_booking',
      status
    )
  }
})

// ── the status table is IMPORTED, not duplicated ────────────────────────

test('the predicate honours the status.ts table for every constrained template', () => {
  for (const [template, allowed] of Object.entries(TEMPLATE_ALLOWED_STATUSES)) {
    if (!allowed) continue
    for (const status of ALL_STATUSES) {
      const reason = bookingBlockReason(template, snap({ status, completedAt: NOW, depositPaid: true }), NOW)
      const statusOk = (allowed as readonly string[]).includes(status)
      if (!statusOk) {
        assert.equal(reason, `status_not_allowed:${status}`, `${template}/${status}`)
      }
    }
  }
})

// ── workflow conditions ─────────────────────────────────────────────────

test('post-job templates require a real completion timestamp, not just COMPLETED', () => {
  for (const t of ['job-completion', 'review-request', 'referral', 'repeat-reminder']) {
    assert.equal(bookingBlockReason(t, snap({ status: 'COMPLETED', completedAt: null }), NOW), 'not_completed', t)
    assert.equal(bookingBlockReason(t, snap({ status: 'COMPLETED', completedAt: PAST }), NOW), null, t)
  }
})

test('abandoned recovery stops the moment the deposit is paid', () => {
  for (const t of ['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3']) {
    assert.equal(
      bookingBlockReason(t, snap({ status: 'PENDING_PAYMENT', depositPaid: true }), NOW),
      'deposit_already_paid',
      t
    )
    assert.equal(bookingBlockReason(t, snap({ status: 'PENDING_PAYMENT', depositPaid: false }), NOW), null, t)
  }
})

// ── move-date sensitivity ───────────────────────────────────────────────

test('recovery and reminders stop once the move date has passed', () => {
  const past = snap({ status: 'PENDING_PAYMENT', depositPaid: false, scheduledStart: PAST, confirmedDate: PAST, requestedDate: PAST })
  assert.equal(bookingBlockReason('abandoned-checkout', past, NOW), 'move_date_passed')

  const reminderPast = snap({ status: 'CONFIRMED', scheduledStart: PAST, confirmedDate: PAST, requestedDate: PAST })
  assert.equal(bookingBlockReason('job-reminder', reminderPast, NOW), 'move_date_passed')
})

test('the move DAY itself is still in play — a full day of grace', () => {
  const today = new Date('2026-07-20T08:00:00Z')
  const b = snap({ status: 'PENDING_PAYMENT', depositPaid: false, scheduledStart: today, confirmedDate: today, requestedDate: today })
  assert.equal(bookingBlockReason('abandoned-checkout', b, NOW), null)
})

test('a post-job template is NOT blocked by a passed move date — that is the point', () => {
  const b = snap({ status: 'COMPLETED', completedAt: PAST, scheduledStart: PAST, confirmedDate: PAST, requestedDate: PAST })
  assert.equal(bookingBlockReason('review-request', b, NOW), null)
})

// ── helpers ─────────────────────────────────────────────────────────────

test('effectiveMoveDate follows scheduledStart → confirmedDate → requestedDate', () => {
  const a = new Date('2026-08-01T00:00:00Z')
  const b = new Date('2026-08-02T00:00:00Z')
  const c = new Date('2026-08-03T00:00:00Z')
  assert.equal(effectiveMoveDate({ scheduledStart: a, confirmedDate: b, requestedDate: c })?.toISOString(), a.toISOString())
  assert.equal(effectiveMoveDate({ scheduledStart: null, confirmedDate: b, requestedDate: c })?.toISOString(), b.toISOString())
  assert.equal(effectiveMoveDate({ scheduledStart: null, confirmedDate: null, requestedDate: c })?.toISOString(), c.toISOString())
  assert.equal(effectiveMoveDate({ scheduledStart: null, confirmedDate: null, requestedDate: null }), null)
})

test('a booking with no dates at all is never treated as "passed"', () => {
  const b = snap({ scheduledStart: null, confirmedDate: null, requestedDate: null })
  assert.equal(movePassed(b, NOW), false)
})

test('an unconstrained template with no workflow condition passes', () => {
  assert.equal(bookingBlockReason('information-required', snap({ status: 'PENDING_APPROVAL' }), NOW), null)
})
