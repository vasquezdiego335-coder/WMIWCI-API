// conflict-engine.test.ts — the codes, the severities, and the override
// arithmetic. Travel time is proven to be flagged as ESTIMATED, never claimed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectAssignmentConflicts, detectJobStaffingConflicts, detectDeactivationConflicts,
  evaluateConflicts, ALL_CONFLICT_CODES,
  type AssignmentConflictContext, type WorkerSnapshotForConflict,
} from '../conflict-engine'

const worker: WorkerSnapshotForConflict = {
  active: true, workerStatus: 'ACTIVE', isDriverEligible: true, isLeadEligible: true,
  licenseExpiresAt: '2027-01-01', skills: ['DRIVING', 'HEAVY_ITEMS'], rateResolvable: true,
}

const base = (over: Partial<AssignmentConflictContext> = {}): AssignmentConflictContext => ({
  worker,
  assignment: {
    jobId: 'j1', startAt: '2026-07-22T13:00:00Z', endAt: '2026-07-22T18:00:00Z',
    reportTime: '2026-07-22T12:30:00Z', breakMinutes: 30, isDriver: false, isLead: false,
    originAddress: '1 Main St', destAddress: '2 Elm St',
  },
  jobStatus: 'SCHEDULED',
  availability: { available: true, tier: 'RECURRING', reason: '', hardBlock: false },
  otherShifts: [],
  ...over,
})

const has = (c: ReturnType<typeof detectAssignmentConflicts>, code: string) => c.find((x) => x.code === code)

test('a clean assignment has no conflicts', () => {
  assert.equal(detectAssignmentConflicts(base()).length, 0)
})

// ── HARD blocks ─────────────────────────────────────────────────────────────

test('inactive worker is a HARD block', () => {
  const c = detectAssignmentConflicts(base({ worker: { ...worker, active: false } }))
  assert.equal(has(c, 'INACTIVE_WORKER')?.severity, 'HARD_BLOCK')
})

test('suspended worker is a HARD block', () => {
  const c = detectAssignmentConflicts(base({ worker: { ...worker, workerStatus: 'SUSPENDED' } }))
  assert.equal(has(c, 'SUSPENDED_WORKER')?.severity, 'HARD_BLOCK')
})

test('duplicate assignment is a HARD block', () => {
  assert.equal(has(detectAssignmentConflicts(base({ alreadyAssigned: true })), 'DUPLICATE_ASSIGNMENT')?.severity, 'HARD_BLOCK')
})

test('assignment on a cancelled job is a HARD block', () => {
  assert.equal(has(detectAssignmentConflicts(base({ jobStatus: 'CANCELLED' })), 'ASSIGNMENT_ON_CANCELLED_JOB')?.severity, 'HARD_BLOCK')
})

test('start after end is a HARD block', () => {
  const c = detectAssignmentConflicts(base({ assignment: { ...base().assignment, startAt: '2026-07-22T18:00:00Z', endAt: '2026-07-22T13:00:00Z' } }))
  assert.equal(has(c, 'START_AFTER_END')?.severity, 'HARD_BLOCK')
})

test('assigning a non-driver as the driver is a HARD block', () => {
  const c = detectAssignmentConflicts(base({ worker: { ...worker, isDriverEligible: false }, assignment: { ...base().assignment, isDriver: true } }))
  assert.equal(has(c, 'INELIGIBLE_DRIVER')?.severity, 'HARD_BLOCK')
})

test('a driver whose license expires before the job is a HARD block', () => {
  const c = detectAssignmentConflicts(base({ worker: { ...worker, licenseExpiresAt: '2026-07-01' }, assignment: { ...base().assignment, isDriver: true } }))
  assert.equal(has(c, 'EXPIRED_LICENSE')?.severity, 'HARD_BLOCK')
})

test('an admin-blocked availability is a HARD block', () => {
  const c = detectAssignmentConflicts(base({ availability: { available: false, tier: 'ADMIN_BLOCK', reason: 'closed', hardBlock: true } }))
  assert.equal(has(c, 'ADMIN_UNAVAILABLE')?.severity, 'HARD_BLOCK')
})

// ── Overridable warnings ────────────────────────────────────────────────────

test('outside availability is an overridable warning', () => {
  const c = detectAssignmentConflicts(base({ availability: { available: false, tier: 'RECURRING', reason: 'no rule', hardBlock: false } }))
  assert.equal(has(c, 'OUTSIDE_AVAILABILITY')?.severity, 'OVERRIDABLE_WARNING')
})

test('date-unavailable is an overridable warning', () => {
  const c = detectAssignmentConflicts(base({ availability: { available: false, tier: 'DATE_UNAVAILABLE', reason: 'leave', hardBlock: false } }))
  assert.equal(has(c, 'DATE_UNAVAILABLE')?.severity, 'OVERRIDABLE_WARNING')
})

test('a missing rate is an overridable warning at scheduling time', () => {
  assert.equal(has(detectAssignmentConflicts(base({ worker: { ...worker, rateResolvable: false } })), 'MISSING_RATE')?.severity, 'OVERRIDABLE_WARNING')
})

test('an overlapping assignment is an overridable warning', () => {
  const c = detectAssignmentConflicts(base({
    otherShifts: [{ jobId: 'j2', startAt: '2026-07-22T14:00:00Z', endAt: '2026-07-22T20:00:00Z' }],
  }))
  assert.equal(has(c, 'OVERLAPPING_ASSIGNMENT')?.severity, 'OVERRIDABLE_WARNING')
})

test('an excessive shift is an overridable warning', () => {
  const c = detectAssignmentConflicts(base({ assignment: { ...base().assignment, startAt: '2026-07-22T06:00:00Z', endAt: '2026-07-22T23:00:00Z', breakMinutes: 60 } }))
  assert.equal(has(c, 'EXCESSIVE_SHIFT')?.severity, 'OVERRIDABLE_WARNING')
})

test('an insufficient break on a long shift is an overridable warning', () => {
  const c = detectAssignmentConflicts(base({ assignment: { ...base().assignment, startAt: '2026-07-22T08:00:00Z', endAt: '2026-07-22T18:00:00Z', breakMinutes: 5 } }))
  assert.equal(has(c, 'INSUFFICIENT_BREAK')?.severity, 'OVERRIDABLE_WARNING')
})

test('travel buffer: a short gap between two DIFFERENT addresses warns, and is flagged estimated', () => {
  const c = detectAssignmentConflicts(base({
    assignment: { ...base().assignment, reportTime: '2026-07-22T12:30:00Z', originAddress: '9 Far Away Rd' },
    otherShifts: [{ jobId: 'j2', startAt: '2026-07-22T08:00:00Z', endAt: '2026-07-22T12:15:00Z', originAddress: '1 Main St' }],
  }))
  const buf = has(c, 'INSUFFICIENT_TRAVEL_BUFFER')
  assert.equal(buf?.severity, 'OVERRIDABLE_WARNING')
  assert.equal(buf?.detail?.estimated, true)
  assert.match(buf!.message, /estimated/i)
})

test('travel buffer: same address uses the smaller buffer', () => {
  const c = detectAssignmentConflicts(base({
    assignment: { ...base().assignment, reportTime: '2026-07-22T12:30:00Z', originAddress: '1 Main St' },
    otherShifts: [{ jobId: 'j2', startAt: '2026-07-22T08:00:00Z', endAt: '2026-07-22T12:20:00Z', originAddress: '1 Main St' }],
  }))
  // 10-min gap ≥ 15-min same-address buffer? No, 10 < 15 → still warns; but a
  // 20-min gap at the same address would NOT warn where 20 < 60 would across town.
  const wide = detectAssignmentConflicts(base({
    assignment: { ...base().assignment, reportTime: '2026-07-22T12:40:00Z', originAddress: '1 Main St' },
    otherShifts: [{ jobId: 'j2', startAt: '2026-07-22T08:00:00Z', endAt: '2026-07-22T12:20:00Z', originAddress: '1 Main St' }],
  }))
  assert.ok(has(c, 'INSUFFICIENT_TRAVEL_BUFFER'))
  assert.equal(has(wide, 'INSUFFICIENT_TRAVEL_BUFFER'), undefined)
})

test('a schedule change after acknowledgment warns and demands re-ack', () => {
  const c = detectAssignmentConflicts(base({ ack: { acknowledgedAt: '2026-07-20T00:00:00Z', scheduleChangedSinceAck: true } }))
  assert.equal(has(c, 'TIME_CHANGED_AFTER_ACK')?.severity, 'OVERRIDABLE_WARNING')
})

test('a requirements change after acknowledgment is informational', () => {
  const c = detectAssignmentConflicts(base({ ack: { acknowledgedAt: '2026-07-20T00:00:00Z', requirementsChangedSinceAck: true } }))
  assert.equal(has(c, 'REQUIREMENTS_CHANGED_AFTER_ACK')?.severity, 'INFORMATIONAL')
})

// ── Job-level staffing conflicts ────────────────────────────────────────────

const req = { minWorkers: 2, requiredWorkers: 2, requiredDrivers: 1, requiresLead: true, requiredSkills: ['HEAVY_ITEMS'] }
const w = (o: Partial<{ isDriver: boolean; isLead: boolean; skills: string[]; live: boolean; acknowledged: boolean }> = {}) =>
  ({ isDriver: false, isLead: false, skills: [] as string[], live: true, acknowledged: true, ...o })

test('no requirement → informational only', () => {
  const c = detectJobStaffingConflicts({ requirement: null, assigned: [], jobStatus: 'SCHEDULED' })
  assert.equal(c[0].code, 'NO_STAFFING_REQUIREMENT')
  assert.equal(c[0].severity, 'INFORMATIONAL')
})

test('understaffed, missing driver, missing lead, missing skill all fire', () => {
  const c = detectJobStaffingConflicts({ requirement: req, assigned: [w()], jobStatus: 'SCHEDULED' })
  const codes = c.map((x) => x.code)
  assert.ok(codes.includes('UNDERSTAFFED'))
  assert.ok(codes.includes('MISSING_DRIVER'))
  assert.ok(codes.includes('MISSING_LEAD'))
  assert.ok(codes.includes('MISSING_SKILL'))
})

test('a fully-staffed job with driver, lead and skill has no warnings', () => {
  const c = detectJobStaffingConflicts({
    requirement: req,
    assigned: [w({ isDriver: true, skills: ['HEAVY_ITEMS'] }), w({ isLead: true })],
    jobStatus: 'SCHEDULED',
  })
  assert.equal(c.filter((x) => x.severity !== 'INFORMATIONAL').length, 0)
})

test('overstaffing beyond tolerance warns', () => {
  const c = detectJobStaffingConflicts({
    requirement: { ...req, requiredSkills: [] },
    assigned: [w({ isDriver: true }), w({ isLead: true }), w(), w()],
    jobStatus: 'SCHEDULED',
  })
  assert.equal(c.find((x) => x.code === 'OVERSTAFFING')?.severity, 'OVERRIDABLE_WARNING')
})

test('cancelled/declined workers do not count as live', () => {
  const c = detectJobStaffingConflicts({
    requirement: { ...req, requiredSkills: [], requiresLead: false, requiredDrivers: 0 },
    assigned: [w({ live: false }), w({ live: false })],
    jobStatus: 'SCHEDULED',
  })
  assert.ok(c.some((x) => x.code === 'UNDERSTAFFED'))
})

// ── Deactivation ─────────────────────────────────────────────────────────────

test('deactivating a worker with future assignments is a HARD block', () => {
  const c = detectDeactivationConflicts({ futureLiveAssignments: 2 })
  assert.equal(c[0].code, 'UNRESOLVED_FUTURE_ASSIGNMENT')
  assert.equal(c[0].severity, 'HARD_BLOCK')
})

test('deactivating a worker with no future assignments is clean', () => {
  assert.equal(detectDeactivationConflicts({ futureLiveAssignments: 0 }).length, 0)
})

// ── Override arithmetic ─────────────────────────────────────────────────────

test('a hard block can never be overridden', () => {
  const conflicts = detectAssignmentConflicts(base({ worker: { ...worker, active: false } }))
  const d = evaluateConflicts(conflicts, ['INACTIVE_WORKER'])
  assert.equal(d.canProceed, false)
  assert.equal(d.hard.length, 1)
})

test('a warning clears when its code is overridden', () => {
  const conflicts = detectAssignmentConflicts(base({ worker: { ...worker, rateResolvable: false } }))
  assert.equal(evaluateConflicts(conflicts, []).canProceed, false)
  assert.equal(evaluateConflicts(conflicts, ['MISSING_RATE']).canProceed, true)
})

test('every documented code is exported', () => {
  assert.ok(ALL_CONFLICT_CODES.length >= 26)
  assert.ok(new Set(ALL_CONFLICT_CODES).size === ALL_CONFLICT_CODES.length)
})
