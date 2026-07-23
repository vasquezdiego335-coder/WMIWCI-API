// scheduling-guards.test.ts — the permission + conflict + transition gates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canManageSchedule, canSaveAssignment, canChangeAssignmentStatus,
  canActOnOwnAssignment, canDeactivateWorker, canInviteCrew, isPortalEligible,
} from '../scheduling-guards'
import type { Conflict } from '../conflict-engine'

const warn = (code: string): Conflict => ({ code, severity: 'OVERRIDABLE_WARNING', message: code })
const hard = (code: string): Conflict => ({ code, severity: 'HARD_BLOCK', message: code })

// ── canManageSchedule ───────────────────────────────────────────────────────

test('owner and manager may manage the schedule; crew and anon may not', () => {
  assert.equal(canManageSchedule('OWNER').allow, true)
  assert.equal(canManageSchedule('MANAGER').allow, true)
  assert.equal(canManageSchedule('CREW').allow, false)
  assert.equal(canManageSchedule(null).allow, false)
})

// ── canSaveAssignment ───────────────────────────────────────────────────────

test('a hard conflict blocks the save for anyone', () => {
  const d = canSaveAssignment({ role: 'OWNER', conflicts: [hard('INACTIVE_WORKER')], overriddenCodes: ['INACTIVE_WORKER'], overrideReason: 'x' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
})

test('an un-overridden warning blocks the save', () => {
  assert.equal(canSaveAssignment({ role: 'OWNER', conflicts: [warn('MISSING_RATE')], overriddenCodes: [] }).allow, false)
})

test('overriding a warning needs BOTH owner authority and a reason', () => {
  // Manager cannot override even with a reason.
  assert.equal(canSaveAssignment({ role: 'MANAGER', conflicts: [warn('MISSING_RATE')], overriddenCodes: ['MISSING_RATE'], overrideReason: 'ok' }).allow, false)
  // Owner without a reason cannot either.
  assert.equal(canSaveAssignment({ role: 'OWNER', conflicts: [warn('MISSING_RATE')], overriddenCodes: ['MISSING_RATE'], overrideReason: '' }).allow, false)
  // Owner with a reason can.
  assert.equal(canSaveAssignment({ role: 'OWNER', conflicts: [warn('MISSING_RATE')], overriddenCodes: ['MISSING_RATE'], overrideReason: 'accepted' }).allow, true)
})

test('a clean assignment saves with no override', () => {
  assert.equal(canSaveAssignment({ role: 'MANAGER', conflicts: [], overriddenCodes: [] }).allow, true)
})

// ── transitions ─────────────────────────────────────────────────────────────

test('a legal transition passes; an illegal one 409s', () => {
  assert.equal(canChangeAssignmentStatus({ role: 'OWNER', from: 'OFFERED', to: 'ACCEPTED' }).allow, true)
  const bad = canChangeAssignmentStatus({ role: 'OWNER', from: 'COMPLETED', to: 'ASSIGNED' })
  assert.equal(bad.allow, false)
  assert.equal(bad.allow === false && bad.status, 409)
})

// ── own-assignment ──────────────────────────────────────────────────────────

test('a worker may act only on their own assignment', () => {
  assert.equal(canActOnOwnAssignment({ role: 'CREW', isOwner: true, action: 'acknowledge' }).allow, true)
  assert.equal(canActOnOwnAssignment({ role: 'CREW', isOwner: false, action: 'acknowledge' }).allow, false)
})

test('declining needs a reason', () => {
  assert.equal(canActOnOwnAssignment({ role: 'CREW', isOwner: true, action: 'decline', reason: '' }).allow, false)
  assert.equal(canActOnOwnAssignment({ role: 'CREW', isOwner: true, action: 'decline', reason: 'sick' }).allow, true)
})

// ── deactivation ────────────────────────────────────────────────────────────

test('deactivation is owner-only, reason-required, and blocked on future work', () => {
  assert.equal(canDeactivateWorker({ role: 'MANAGER', reason: 'x', futureLiveAssignments: 0, resolveFutureWork: true }).allow, false)
  assert.equal(canDeactivateWorker({ role: 'OWNER', reason: '', futureLiveAssignments: 0, resolveFutureWork: true }).allow, false)
  const blocked = canDeactivateWorker({ role: 'OWNER', reason: 'left', futureLiveAssignments: 2, resolveFutureWork: false })
  assert.equal(blocked.allow, false)
  assert.equal(blocked.allow === false && blocked.status, 409)
  assert.equal(canDeactivateWorker({ role: 'OWNER', reason: 'left', futureLiveAssignments: 2, resolveFutureWork: true }).allow, true)
  assert.equal(canDeactivateWorker({ role: 'OWNER', reason: 'left', futureLiveAssignments: 0, resolveFutureWork: false }).allow, true)
})

// ── invitations ─────────────────────────────────────────────────────────────

test('inviting is owner-only and never grants OWNER', () => {
  assert.equal(canInviteCrew({ role: 'MANAGER', targetRole: 'CREW' }).allow, false)
  assert.equal(canInviteCrew({ role: 'OWNER', targetRole: 'CREW' }).allow, true)
  const owner = canInviteCrew({ role: 'OWNER', targetRole: 'OWNER' })
  assert.equal(owner.allow, false)
  assert.equal(owner.allow === false && owner.status, 422)
})

// ── crew portal eligibility (stateless JWT re-check) ────────────────────────

test('portal eligibility refuses deactivated, suspended and missing workers', () => {
  assert.equal(isPortalEligible({ active: true, workerStatus: 'ACTIVE' }).allow, true)
  assert.equal(isPortalEligible({ active: true, workerStatus: 'ON_LEAVE' }).allow, true)
  const gone = isPortalEligible(null)
  assert.equal(gone.allow, false)
  const inactive = isPortalEligible({ active: false, workerStatus: 'INACTIVE' })
  assert.equal(inactive.allow, false)
  assert.equal(inactive.allow === false && inactive.status, 403)
  const flagOnly = isPortalEligible({ active: false, workerStatus: 'ACTIVE' })
  assert.equal(flagOnly.allow, false) // the legacy boolean alone is enough to refuse
  const suspended = isPortalEligible({ active: true, workerStatus: 'SUSPENDED' })
  assert.equal(suspended.allow, false)
})
