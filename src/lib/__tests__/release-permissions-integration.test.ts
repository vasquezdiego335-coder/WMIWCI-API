// release-permissions-integration.test.ts — cross-system regressions for the
// COMBINED permission registry after the Stage 5 + Email Marketing release
// merge. The branch-specific suites (stage5-permissions, email-admin) each
// assert their own block; this file locks the invariants that only exist once
// both blocks share one Action union and one OWNER_ONLY list — i.e. exactly
// what a bad conflict resolution would silently break.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, EMAIL_BETA_OWNER_ONLY, type Action } from '../permissions'

const EMAIL_ACTIONS: Action[] = [
  'email.view',
  'email.view_recipients',
  'email.view_attribution',
  'email.manage_journey',
  'email.cancel_scheduled',
  'email.retry_send',
  'email.manage_suppression',
  'email.manage_campaign',
  'email.send_test',
  'email.configure',
]

const STAGE5_ADMIN_ACTIONS: Action[] = [
  'staff.view',
  'staff.manage',
  'staff.invite',
  'staff.deactivate',
  'staff.manage_availability',
  'schedule.view',
  'schedule.manage',
  'schedule.override_conflicts',
]

const STAGE5_CREW_ACTIONS: Action[] = ['assignment.view_own', 'assignment.acknowledge_own']

// ── Owner keeps full access across BOTH systems ─────────────────────────────

test('owner can perform every email AND every stage5 action (merge dropped nothing)', () => {
  for (const a of [...EMAIL_ACTIONS, ...STAGE5_ADMIN_ACTIONS, ...STAGE5_CREW_ACTIONS]) {
    assert.equal(can('OWNER', a), true, a)
  }
})

// ── Crew is sealed off from admin email marketing entirely ──────────────────

test('crew is denied every email-marketing action', () => {
  for (const a of EMAIL_ACTIONS) {
    assert.equal(can('CREW', a), false, a)
  }
})

test('crew keeps exactly its own-assignment self-service and no scheduling admin', () => {
  for (const a of STAGE5_CREW_ACTIONS) {
    assert.equal(can('CREW', a), true, a)
  }
  for (const a of STAGE5_ADMIN_ACTIONS) {
    assert.equal(can('CREW', a), false, a)
  }
})

// ── Manager: the owner-only lines of BOTH systems survive side by side ──────

test('manager is denied the owner-only actions of BOTH systems', () => {
  // Email Marketing is owner-only in the Beta — including the operational trio.
  for (const a of EMAIL_ACTIONS) {
    assert.equal(can('MANAGER', a), false, `email beta owner-only: ${a}`)
  }
  // Stage 5 staff administration + conflict override are owner authority.
  for (const a of ['staff.manage', 'staff.invite', 'staff.deactivate', 'schedule.override_conflicts'] as const) {
    assert.equal(can('MANAGER', a), false, a)
  }
})

test('manager keeps schedule operations despite the email beta lockdown', () => {
  for (const a of ['schedule.view', 'schedule.manage', 'staff.view', 'staff.manage_availability'] as const) {
    assert.equal(can('MANAGER', a), true, a)
  }
})

// ── Beta contract: the post-beta unlock list is intact and owner-only today ──

test('EMAIL_BETA_OWNER_ONLY still names the manager-operational trio', () => {
  assert.deepEqual(
    [...EMAIL_BETA_OWNER_ONLY].sort(),
    ['email.cancel_scheduled', 'email.send_test', 'email.view'].sort()
  )
  for (const a of EMAIL_BETA_OWNER_ONLY) {
    assert.equal(can('MANAGER', a), false, `${a} must stay owner-only while in beta`)
  }
})
