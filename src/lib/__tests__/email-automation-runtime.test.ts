// Offline tests for the automation runtime's PURE parts: enrollment identity
// (dedupe + version pinning), stage scheduling anchored to enrollment time,
// per-stage idempotency ids, and the live stop-rule evaluator. The DB-backed
// path (enrollment writes, stage execution, the sweep) is exercised in the
// staging rehearsal, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enrollmentDedupeKey,
  subjectKeyFor,
  subjectTypeFor,
  stageDueAt,
  stageEventId,
  evaluateStopRules,
  MOVE_DATE_LEAD_MS,
  type AutomationSubject,
  type LiveSubjectState,
} from '../email-automation-runtime'
import { validateAutomationDefinition, automationJobId, type AutomationDefinition } from '../email-automation'

// ── Fixtures ────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const DAY = 24 * HOUR

function definition(trigger: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  const validated = validateAutomationDefinition({
    trigger,
    audience: null,
    stages: [
      { key: 'stage-1', template: 'quote-followup-1', delayMs: HOUR },
      { key: 'stage-2', template: 'quote-followup-2', delayMs: 3 * DAY },
    ],
    stopRules: {},
    caps: { perRecipientPerMonth: 4 },
    respectQuietHours: true,
    maxStages: 4,
  })
  assert.ok(validated.ok, JSON.stringify(validated))
  return { ...(validated as { definition: AutomationDefinition }).definition, ...overrides }
}

const leadSubject: AutomationSubject = { email: 'Jordan@Example.com', leadId: 'lead1' }
const bookingSubject: AutomationSubject = { email: 'sam@example.com', bookingId: 'bk1', customerId: 'cust1' }

// ── Enrollment identity ─────────────────────────────────────────────────

test('subject identity: booking wins over lead, lead over customer, email last', () => {
  assert.equal(subjectKeyFor({ email: 'a@b.co', bookingId: 'bk', leadId: 'ld', customerId: 'cu' }), 'bk')
  assert.equal(subjectKeyFor({ email: 'a@b.co', leadId: 'ld', customerId: 'cu' }), 'ld')
  assert.equal(subjectKeyFor({ email: 'a@b.co', customerId: 'cu' }), 'cu')
  assert.equal(subjectKeyFor({ email: 'A@B.co' }), 'a@b.co')
  assert.equal(subjectTypeFor(bookingSubject), 'booking')
  assert.equal(subjectTypeFor(leadSubject), 'lead')
  assert.equal(subjectTypeFor({ email: 'x@y.co' }), 'customer')
})

test('the dedupe key is deterministic per automation VERSION and subject', () => {
  const k1 = enrollmentDedupeKey('auto1', 1, leadSubject)
  assert.equal(k1, enrollmentDedupeKey('auto1', 1, leadSubject), 'a re-fired trigger reproduces the same key — no duplicate enrollment')
  // A NEW version deliberately mints a NEW key: re-entry under new rules is
  // possible without rewriting the old enrollment's history.
  assert.notEqual(k1, enrollmentDedupeKey('auto1', 2, leadSubject))
  assert.notEqual(k1, enrollmentDedupeKey('auto2', 1, leadSubject))
  assert.notEqual(k1, enrollmentDedupeKey('auto1', 1, bookingSubject))
})

test('stage queue ids ride automationJobId — version is part of the identity', () => {
  const v1 = automationJobId('auto1', 1, 'stage-1', 'enr1')
  assert.equal(v1, automationJobId('auto1', 1, 'stage-1', 'enr1'))
  assert.notEqual(v1, automationJobId('auto1', 2, 'stage-1', 'enr1'))
  assert.notEqual(v1, automationJobId('auto1', 1, 'stage-2', 'enr1'))
})

test('per-stage send idempotency ids are unique per version, stage and enrollment', () => {
  const id = stageEventId('auto1', 1, 'stage-1', 'enr1')
  assert.equal(id, stageEventId('auto1', 1, 'stage-1', 'enr1'))
  assert.notEqual(id, stageEventId('auto1', 1, 'stage-2', 'enr1'))
  assert.notEqual(id, stageEventId('auto1', 2, 'stage-1', 'enr1'))
  assert.notEqual(id, stageEventId('auto1', 1, 'stage-1', 'enr2'))
})

// ── Stage scheduling ────────────────────────────────────────────────────

test('stage due times anchor to ENROLLMENT time — a restart cannot stretch the sequence', () => {
  const def = definition('quote_created')
  const enrolledAt = new Date('2026-07-22T10:00:00Z')
  assert.equal(stageDueAt(enrolledAt, def, 0).getTime(), enrolledAt.getTime() + HOUR)
  assert.equal(stageDueAt(enrolledAt, def, 1).getTime(), enrolledAt.getTime() + 3 * DAY)
})

// ── Live stop-rule evaluation ───────────────────────────────────────────

const openLead: LiveSubjectState = {
  lead: { status: 'QUOTE_SENT', bookedAt: null, convertedBookingId: null, lostAt: null, moveDate: new Date(Date.now() + 10 * DAY) },
}

test('an open lead does not stop', () => {
  assert.deepEqual(evaluateStopRules(definition('quote_created'), openLead), { stop: false })
})

test('STOP on booking conversion', () => {
  const state: LiveSubjectState = { lead: { ...openLead.lead!, convertedBookingId: 'bk9' } }
  const v = evaluateStopRules(definition('quote_created'), state)
  assert.ok(v.stop && v.reason === 'lead_converted')
})

test('STOP on lead loss and on move-date passage', () => {
  const lost = evaluateStopRules(definition('quote_created'), { lead: { ...openLead.lead!, lostAt: new Date() } })
  assert.ok(lost.stop && lost.reason === 'lead_lost')
  const passed = evaluateStopRules(definition('quote_created'), {
    lead: { ...openLead.lead!, moveDate: new Date(Date.now() - 3 * DAY) },
  })
  assert.ok(passed.stop && passed.reason === 'move_date_passed')
})

test('STOP on cancellation for booking subjects', () => {
  const def = definition('booking_confirmed')
  const v = evaluateStopRules(def, {
    booking: { status: 'CANCELLED', depositPaid: true, moveDate: null, hasReview: false, cancelled: true },
  })
  assert.ok(v.stop && v.reason === 'booking_cancelled')
})

test('a paid deposit stops ABANDONMENT automations — and only those', () => {
  const paid: LiveSubjectState = {
    booking: { status: 'CONFIRMED', depositPaid: true, moveDate: new Date(Date.now() + 5 * DAY), hasReview: false, cancelled: false },
  }
  const abandoned = evaluateStopRules(definition('booking_abandoned'), paid)
  assert.ok(abandoned.stop && abandoned.reason === 'deposit_paid')
  const started = evaluateStopRules(definition('booking_started'), paid)
  assert.ok(started.stop && started.reason === 'booking_advanced')
  // The normal path: a paid deposit must NOT stop a move-date automation.
  const approaching = evaluateStopRules(definition('move_date_approaching'), paid)
  assert.deepEqual(approaching, { stop: false })
})

test('suppression stops EVERYTHING — the locked rule has no off switch', () => {
  const def = definition('customer_inactive')
  // Even a definition that tried to disable every rule cannot disable this.
  const v = evaluateStopRules(def, { suppressed: { reason: 'SPAM_COMPLAINT' } })
  assert.ok(v.stop && v.reason === 'suppressed:spam_complaint')
})

test('a recorded review stops review-eligible automations', () => {
  const def = definition('review_eligible')
  const v = evaluateStopRules(def, {
    booking: { status: 'COMPLETED', depositPaid: true, moveDate: new Date(Date.now() - 2 * DAY - HOUR), hasReview: true, cancelled: false },
  })
  assert.ok(v.stop && v.reason === 'review_exists')
})

test('an already-sent referral ask stops referral-eligible automations', () => {
  const def = definition('referral_eligible')
  const v = evaluateStopRules(def, {
    booking: { status: 'COMPLETED', depositPaid: true, moveDate: null, hasReview: true, cancelled: false },
    referralAskSent: true,
  })
  assert.ok(v.stop && v.reason === 'referral_already_sent')
})

test('a disabled (unlocked) stop rule really is off', () => {
  const def = definition('quote_created')
  def.stopRules.stopAfterBooking = false
  const state: LiveSubjectState = { lead: { ...openLead.lead!, bookedAt: new Date() } }
  assert.deepEqual(evaluateStopRules(def, state), { stop: false })
})

// ── Constants that document behaviour ───────────────────────────────────

test('move_date_approaching fires inside a 7-day window (documented constant)', () => {
  assert.equal(MOVE_DATE_LEAD_MS, 7 * DAY)
})
