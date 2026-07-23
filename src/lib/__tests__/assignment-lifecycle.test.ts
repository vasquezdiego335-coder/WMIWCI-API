// assignment-lifecycle.test.ts — valid transitions and material-change detection
// over the EXISTING CrewAssignmentStatus enum.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canTransition, evaluateTransition, isLiveStatus, isAcknowledged, isMaterialChange,
  describeChanges,
} from '../assignment-lifecycle'
import { computeStaffingHealth as health } from '../staffing-health'

test('offer → accept → assign → in_progress → complete is a legal path', () => {
  assert.ok(canTransition('OFFERED', 'ACCEPTED'))
  assert.ok(canTransition('ACCEPTED', 'ASSIGNED'))
  assert.ok(canTransition('ASSIGNED', 'IN_PROGRESS'))
  assert.ok(canTransition('IN_PROGRESS', 'COMPLETED'))
})

test('a completed assignment is terminal', () => {
  assert.equal(canTransition('COMPLETED', 'ASSIGNED'), false)
  assert.equal(evaluateTransition('COMPLETED', 'IN_PROGRESS').allow, false)
})

test('a no-show is terminal', () => {
  assert.equal(canTransition('NO_SHOW', 'ASSIGNED'), false)
})

test('a declined or cancelled assignment may be re-offered', () => {
  assert.ok(canTransition('DECLINED', 'OFFERED'))
  assert.ok(canTransition('CANCELLED', 'ASSIGNED'))
})

test('an illegal transition is refused with a message', () => {
  const d = evaluateTransition('OFFERED', 'COMPLETED')
  assert.equal(d.allow, false)
  assert.match(d.error!, /cannot move/)
})

test('transitioning to the same status is refused', () => {
  assert.equal(evaluateTransition('ASSIGNED', 'ASSIGNED').allow, false)
})

test('live statuses include everything except declined/cancelled/no-show', () => {
  assert.equal(isLiveStatus('ASSIGNED'), true)
  assert.equal(isLiveStatus('OFFERED'), true)
  assert.equal(isLiveStatus('DECLINED'), false)
  assert.equal(isLiveStatus('CANCELLED'), false)
  assert.equal(isLiveStatus('NO_SHOW'), false)
})

test('acknowledgment is false once a material change marked it stale', () => {
  assert.equal(isAcknowledged('ACCEPTED'), true)
  assert.equal(isAcknowledged('ASSIGNED', new Date()), true)
  assert.equal(isAcknowledged('ASSIGNED', new Date(), new Date()), false) // stale
})

// ── Material change ─────────────────────────────────────────────────────────

const shape = { startAt: '2026-07-22T13:00:00Z', endAt: '2026-07-22T18:00:00Z', reportTime: '2026-07-22T12:30:00Z', originAddress: '1 Main', destAddress: '2 Elm', role: 'MOVER', isDriver: false, isLead: false }

test('changing the start time is material', () => {
  assert.equal(isMaterialChange(shape, { ...shape, startAt: '2026-07-22T14:00:00Z' }), true)
})

test('changing the driver designation is material', () => {
  assert.equal(isMaterialChange(shape, { ...shape, isDriver: true }), true)
})

test('changing a location is material', () => {
  assert.equal(isMaterialChange(shape, { ...shape, originAddress: '9 Far' }), true)
})

test('no change is not material', () => {
  assert.equal(isMaterialChange(shape, { ...shape }), false)
})

test('describeChanges lists exactly what moved', () => {
  const changes = describeChanges(shape, { ...shape, startAt: '2026-07-22T14:00:00Z', isLead: true })
  assert.deepEqual(changes.sort(), ['lead designation', 'start time'].sort())
})

// ── staffing-health re-export sanity ────────────────────────────────────────

test('a fully staffed, acknowledged, conflict-free job is READY', () => {
  const r = health({
    requirement: { minWorkers: 2, requiredWorkers: 2, requiredDrivers: 1, requiresLead: true, requiredSkills: [] },
    assigned: [
      { isDriver: true, isLead: true, skills: [], live: true, acknowledged: true },
      { isDriver: false, isLead: false, skills: [], live: true, acknowledged: true },
    ],
    conflicts: [],
  })
  assert.equal(r.status, 'READY')
})

test('an unstaffed job reads UNSTAFFED', () => {
  const r = health({ requirement: { minWorkers: 2, requiredWorkers: 2, requiredDrivers: 1, requiresLead: true, requiredSkills: [] }, assigned: [], conflicts: [] })
  assert.equal(r.status, 'UNSTAFFED')
})

test('a hard conflict makes a job CONFLICTED regardless of counts', () => {
  const r = health({
    requirement: { minWorkers: 2, requiredWorkers: 2, requiredDrivers: 0, requiresLead: false, requiredSkills: [] },
    assigned: [{ isDriver: false, isLead: false, skills: [], live: true, acknowledged: true }, { isDriver: false, isLead: false, skills: [], live: true, acknowledged: true }],
    conflicts: [{ code: 'INACTIVE_WORKER', severity: 'HARD_BLOCK', message: '' }],
  })
  assert.equal(r.status, 'CONFLICTED')
})
