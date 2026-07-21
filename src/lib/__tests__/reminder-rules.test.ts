// Offline tests for the Action Center rule engine + sync diff (increment 2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateBooking,
  evaluateCrewOverlaps,
  evaluateExpenses,
  evaluateLeads,
  evaluateCustomers,
  computeSyncActions,
  hasLaborDoubleCountRisk,
  type RuleBooking,
  type RuleCrew,
  type ExistingReminder,
  type ReminderCandidate,
} from '../reminder-rules'

const NOW = new Date('2026-07-13T12:00:00-04:00')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function crew(over: Partial<RuleCrew> = {}): RuleCrew {
  return {
    userId: 'u1', userName: 'Marco', payStatus: 'SCHEDULED', payMethod: null,
    flatPay: null, payRate: 3000, userPayRate: null, actualHours: 4, scheduledHours: 4,
    ...over,
  }
}

function booking(over: Partial<RuleBooking> = {}): RuleBooking {
  return {
    id: 'b1', displayId: 'B-1', status: 'SCHEDULED',
    customerName: 'Maria Lopez', customerPhone: '(973) 555-0100', customerEmail: 'maria@example.com',
    originAddress: '12 Main St, Newark, NJ', destAddress: '99 Oak Ave, Montclair, NJ',
    originVerification: 'verified', destVerification: 'verified', manualReviewRequired: false,
    agreementAccepted: true, totalEstimate: 700,
    scheduledStart: new Date(NOW.getTime() + 3 * DAY), scheduledEnd: null,
    requestedDate: null, completedAt: null,
    truckAddonDueOnMoveDay: false, truckProvider: null, truckReservationStatus: null, truckReservationNumber: null,
    jobStartedAt: null, crew: [crew()], hasFailedPayment: false, hasWorkerPayExpense: false,
    moveDayDueCents: 0, netRevenueCents: 70000, netProfitCents: 40000,
    ...over,
  }
}

const types = (cands: ReminderCandidate[]) => cands.map((c) => c.reminderType).sort()

// ── Booking rules ─────────────────────────────────────────────────────────────

test('healthy scheduled booking produces no reminders', () => {
  assert.deepEqual(types(evaluateBooking(booking(), NOW)), [])
})

test('missing pickup address fires, CRITICAL when the move is within 72h', () => {
  const soon = evaluateBooking(booking({ originAddress: '', scheduledStart: new Date(NOW.getTime() + DAY) }), NOW)
  const hit = soon.find((c) => c.reminderType === 'booking-missing-address')
  assert.ok(hit)
  assert.equal(hit!.severity, 'CRITICAL')
  assert.match(hit!.description, /pickup/)
  // Far-out move: HIGH, not critical.
  const later = evaluateBooking(booking({ originAddress: '', scheduledStart: new Date(NOW.getTime() + 10 * DAY) }), NOW)
  assert.equal(later.find((c) => c.reminderType === 'booking-missing-address')!.severity, 'HIGH')
})

test('unverified address + manual review fire the verification reminder', () => {
  const c = evaluateBooking(booking({ destVerification: 'unverified' }), NOW)
  assert.ok(types(c).includes('booking-address-unverified'))
  // Legacy null verification does NOT spam.
  const legacy = evaluateBooking(booking({ originVerification: null, destVerification: null }), NOW)
  assert.ok(!types(legacy).includes('booking-address-unverified'))
})

test('job within 24h with no crew is CRITICAL', () => {
  const c = evaluateBooking(booking({ crew: [], scheduledStart: new Date(NOW.getTime() + 6 * HOUR) }), NOW)
  const hit = c.find((x) => x.reminderType === 'job-24h-no-crew')
  assert.ok(hit)
  assert.equal(hit!.severity, 'CRITICAL')
})

test('truck unresolved fires only when a truck is needed and the move is close', () => {
  const needed = booking({ truckAddonDueOnMoveDay: true, scheduledStart: new Date(NOW.getTime() + DAY) })
  assert.ok(types(evaluateBooking(needed, NOW)).includes('booking-truck-unresolved'))
  // Reserved: no reminder.
  const reserved = booking({ truckAddonDueOnMoveDay: true, truckReservationStatus: 'reserved', scheduledStart: new Date(NOW.getTime() + DAY) })
  assert.ok(!types(evaluateBooking(reserved, NOW)).includes('booking-truck-unresolved'))
  // No truck involved: no reminder.
  assert.ok(!types(evaluateBooking(booking({ scheduledStart: new Date(NOW.getTime() + DAY) }), NOW)).includes('booking-truck-unresolved'))
})

test('completed job with unpaid move-day balance + negative profit + missing hours', () => {
  const c = evaluateBooking(
    booking({
      status: 'COMPLETED', completedAt: new Date(NOW.getTime() - 2 * DAY),
      moveDayDueCents: 41000, netProfitCents: -5000,
      crew: [crew({ actualHours: null, flatPay: null })],
    }),
    NOW,
  )
  const t = types(c)
  assert.ok(t.includes('job-balance-unpaid'))
  assert.ok(t.includes('job-negative-profit'))
  assert.ok(t.includes('job-completed-no-hours'))
  const balance = c.find((x) => x.reminderType === 'job-balance-unpaid')!
  assert.match(balance.title, /\$410\.00/)
})

test('crew payroll rules: missing rate / approved-unpaid / paid-no-method', () => {
  const c = evaluateBooking(
    booking({
      crew: [
        crew({ userId: 'u1', userName: 'A', payRate: null, userPayRate: null, flatPay: null }),
        crew({ userId: 'u2', userName: 'B', payStatus: 'PAY_APPROVED' }),
        crew({ userId: 'u3', userName: 'C', payStatus: 'PAID', payMethod: null }),
      ],
    }),
    NOW,
  )
  const t = types(c)
  assert.ok(t.includes('crew-missing-rate'))
  assert.ok(t.includes('crew-pay-approved-unpaid'))
  assert.ok(t.includes('crew-paid-no-method'))
  // Per-crew dedupe keys are distinct.
  const keys = c.map((x) => x.dedupeKey)
  assert.equal(new Set(keys).size, keys.length)
})

test('labor double-count guardrail: crew payroll + WORKER_PAY expense = flagged', () => {
  assert.equal(hasLaborDoubleCountRisk({ hasWorkerPayExpense: true, crew: [crew()] }), true)
  // WORKER_PAY without crew pay data = legitimate non-crew helper, NOT flagged.
  assert.equal(hasLaborDoubleCountRisk({ hasWorkerPayExpense: true, crew: [crew({ payRate: null, userPayRate: null, flatPay: null, actualHours: null })] }), false)
  assert.equal(hasLaborDoubleCountRisk({ hasWorkerPayExpense: false, crew: [crew()] }), false)
  const c = evaluateBooking(booking({ hasWorkerPayExpense: true }), NOW)
  assert.ok(types(c).includes('worker-pay-double-count'))
})

test('crew double-booked fires once per person per overlapping pair', () => {
  const a = booking({ id: 'bA', customerName: 'A', scheduledStart: new Date(NOW.getTime() + DAY), crew: [crew()] })
  const b = booking({ id: 'bB', customerName: 'B', scheduledStart: new Date(NOW.getTime() + DAY + HOUR), crew: [crew()] })
  const c = evaluateCrewOverlaps([a, b], NOW)
  assert.equal(c.length, 1)
  assert.equal(c[0].severity, 'CRITICAL')
  // Non-overlapping (12h apart with 4h default duration): nothing.
  const far = booking({ id: 'bC', customerName: 'C', scheduledStart: new Date(NOW.getTime() + DAY + 12 * HOUR), crew: [crew()] })
  assert.equal(evaluateCrewOverlaps([a, far], NOW).length, 0)
})

// ── Expense / lead / customer rules ──────────────────────────────────────────

test('expense rules: stale review + missing receipt over $25', () => {
  const c = evaluateExpenses(
    [
      { id: 'e1', category: 'GAS', amount: 4500, status: 'SUBMITTED', receiptUrl: null, vendor: 'Shell', createdAt: new Date(NOW.getTime() - 4 * DAY) },
      { id: 'e2', category: 'TOLLS', amount: 500, status: 'APPROVED', receiptUrl: null, vendor: null, createdAt: new Date(NOW.getTime() - 10 * DAY) },
    ],
    NOW,
  )
  const t = types(c)
  assert.ok(t.includes('expense-needs-review'))
  assert.ok(t.includes('expense-missing-receipt'))
  // The $5 toll does NOT demand a receipt.
  assert.equal(c.filter((x) => x.reminderType === 'expense-missing-receipt').length, 1)
})

test('lead rules: uncontacted 24h+, quote follow-up 48h+, lost without reason', () => {
  const c = evaluateLeads(
    [
      { id: 'l1', name: 'John', status: 'NEW', lostReason: null, createdAt: new Date(NOW.getTime() - 2 * DAY), quotedAt: null, updatedAt: NOW },
      { id: 'l2', name: 'Ana', status: 'QUOTE_SENT', lostReason: null, createdAt: new Date(NOW.getTime() - 5 * DAY), quotedAt: new Date(NOW.getTime() - 3 * DAY), updatedAt: NOW },
      { id: 'l3', name: 'Bo', status: 'LOST', lostReason: null, createdAt: NOW, quotedAt: null, updatedAt: NOW },
      { id: 'l4', name: 'New', status: 'NEW', lostReason: null, createdAt: NOW, quotedAt: null, updatedAt: NOW },
    ],
    NOW,
  )
  assert.deepEqual(types(c), ['lead-followup-overdue', 'lead-lost-no-reason', 'lead-not-contacted'])
})

test('duplicate customers detected by shared 10-digit phone', () => {
  const c = evaluateCustomers([
    { id: 'c1', name: 'Maria L', phone: '(973) 555-0100' },
    { id: 'c2', name: 'Maria Lopez', phone: '19735550100' },
    { id: 'c3', name: 'Other', phone: '(201) 555-9999' },
  ])
  assert.equal(c.length, 1)
  assert.equal(c[0].reminderType, 'customer-duplicate-phone')
})

// ── Sync diff (the dedupe contract) ──────────────────────────────────────────

function cand(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    reminderType: 'job-24h-no-crew', category: 'JOBS_SCHEDULING', title: 'T', description: 'D',
    severity: 'CRITICAL', sourceEntityType: 'booking', sourceEntityId: 'b1', sourceUrl: '/admin/jobs/b1',
    dedupeKey: 'job-24h-no-crew:booking:b1', dueAt: null, ...over,
  }
}
function existing(over: Partial<ExistingReminder> = {}): ExistingReminder {
  return {
    id: 'r1', dedupeKey: 'job-24h-no-crew:booking:b1', status: 'OPEN', createdBy: 'system',
    snoozedUntil: null, title: 'T', description: 'D', severity: 'CRITICAL', dueAt: null, ...over,
  }
}

test('sync: new candidate creates; identical existing is a no-op', () => {
  const a1 = computeSyncActions([], [cand()], NOW)
  assert.equal(a1.create.length, 1)
  const a2 = computeSyncActions([existing()], [cand()], NOW)
  assert.equal(a2.create.length, 0)
  assert.equal(a2.update.length, 0)
  assert.equal(a2.autoResolve.length, 0)
})

test('sync: changed description updates in place — never duplicates', () => {
  const a = computeSyncActions([existing()], [cand({ description: 'D2' })], NOW)
  assert.equal(a.create.length, 0)
  assert.equal(a.update.length, 1)
})

test('sync: condition cleared auto-resolves system reminders (even snoozed), never manual ones', () => {
  const a = computeSyncActions([existing(), existing({ id: 'r2', dedupeKey: 'x:y:z', status: 'SNOOZED' })], [cand()], NOW)
  assert.deepEqual(a.autoResolve.map((r) => r.id), ['r2'])
  const manual = computeSyncActions([existing({ id: 'r3', dedupeKey: 'manual:1', createdBy: 'diego' })], [], NOW)
  assert.equal(manual.autoResolve.length, 0)
})

test('sync: DISMISSED is respected forever; RESOLVED reopens when the issue returns', () => {
  const dismissed = computeSyncActions([existing({ status: 'DISMISSED' })], [cand()], NOW)
  assert.equal(dismissed.create.length + dismissed.update.length + dismissed.reopen.length, 0)
  const resolved = computeSyncActions([existing({ status: 'RESOLVED' })], [cand()], NOW)
  assert.equal(resolved.reopen.length, 1)
})

test('sync: snooze holds until expiry, then wakes', () => {
  const future = new Date(NOW.getTime() + DAY)
  const held = computeSyncActions([existing({ status: 'SNOOZED', snoozedUntil: future })], [cand()], NOW)
  assert.equal(held.wake.length + held.update.length + held.create.length, 0)
  const past = new Date(NOW.getTime() - HOUR)
  const woken = computeSyncActions([existing({ status: 'SNOOZED', snoozedUntil: past })], [cand()], NOW)
  assert.equal(woken.wake.length, 1)
})

// ── Dismissal scopes (increment 2.1) ─────────────────────────────────────────

test('sync: PERMANENT_RULE_ENTITY dismissal never reopens, even if state changes', () => {
  const dismissed = existing({ status: 'DISMISSED', dismissalScope: 'PERMANENT_RULE_ENTITY', entityFingerprint: 'old' })
  const a = computeSyncActions([dismissed], [cand({ fingerprint: 'brand-new' })], NOW)
  assert.equal(a.reopen.length, 0)
  assert.equal(a.create.length, 0)
})

test('sync: legacy dismissal (null scope) is treated as permanent', () => {
  const legacy = existing({ status: 'DISMISSED', dismissalScope: null, entityFingerprint: null })
  const a = computeSyncActions([legacy], [cand({ fingerprint: 'anything' })], NOW)
  assert.equal(a.reopen.length, 0)
})

test('sync: UNTIL_ENTITY_CHANGES reopens only when the fingerprint changes', () => {
  const dismissed = existing({ status: 'DISMISSED', dismissalScope: 'UNTIL_ENTITY_CHANGES', entityFingerprint: 'fp-1' })
  // Same fingerprint → stays dismissed.
  assert.equal(computeSyncActions([dismissed], [cand({ fingerprint: 'fp-1' })], NOW).reopen.length, 0)
  // Changed fingerprint → reopens.
  assert.equal(computeSyncActions([dismissed], [cand({ fingerprint: 'fp-2' })], NOW).reopen.length, 1)
})

test('sync: OCCURRENCE reopens when the material state changed', () => {
  const dismissed = existing({ status: 'DISMISSED', dismissalScope: 'OCCURRENCE', entityFingerprint: 'fp-1' })
  assert.equal(computeSyncActions([dismissed], [cand({ fingerprint: 'fp-1' })], NOW).reopen.length, 0)
  assert.equal(computeSyncActions([dismissed], [cand({ fingerprint: 'fp-9' })], NOW).reopen.length, 1)
})

test('evaluateAll stamps a fingerprint on every candidate', () => {
  const { evaluateAll } = require('../reminder-rules') as typeof import('../reminder-rules')
  const cands = evaluateAll({ bookings: [], expenses: [], ownerTransactions: [], leads: [
    { id: 'l1', name: 'X', status: 'NEW', lostReason: null, createdAt: new Date(NOW.getTime() - 2 * DAY), quotedAt: null, updatedAt: NOW },
  ], customers: [] }, NOW)
  assert.ok(cands.length > 0)
  assert.ok(cands.every((c) => typeof c.fingerprint === 'string' && c.fingerprint.length > 0))
})
