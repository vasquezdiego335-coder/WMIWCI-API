// stage5-permissions.test.ts — the owner/manager/crew matrix for the new
// scheduling actions, plus a regression that Stage 4 masking is untouched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can } from '../permissions'

// ── Owner: everything ───────────────────────────────────────────────────────

test('an owner can do every Stage 5 action', () => {
  for (const a of ['staff.view', 'staff.manage', 'staff.invite', 'staff.deactivate', 'staff.manage_availability', 'schedule.view', 'schedule.manage', 'schedule.override_conflicts'] as const) {
    assert.equal(can('OWNER', a), true, a)
  }
})

// ── Manager: operations, not staff administration or overrides ──────────────

test('a manager runs the schedule but cannot administer staff or override conflicts', () => {
  assert.equal(can('MANAGER', 'schedule.view'), true)
  assert.equal(can('MANAGER', 'schedule.manage'), true)
  assert.equal(can('MANAGER', 'staff.view'), true)
  assert.equal(can('MANAGER', 'staff.manage_availability'), true)
  // Denied:
  assert.equal(can('MANAGER', 'staff.manage'), false)
  assert.equal(can('MANAGER', 'staff.invite'), false)
  assert.equal(can('MANAGER', 'staff.deactivate'), false)
  assert.equal(can('MANAGER', 'schedule.override_conflicts'), false)
})

test('a manager still cannot see owner money or set owner labor rates (Stage 4 unchanged)', () => {
  assert.equal(can('MANAGER', 'money.view_company_profit'), false)
  assert.equal(can('MANAGER', 'money.view_owner_ledger'), false)
  assert.equal(can('MANAGER', 'labor.set_owner_labor_value'), false)
  assert.equal(can('MANAGER', 'closeout.finalize'), false)
})

// ── Crew: only their own assignments ────────────────────────────────────────

test('crew may view and acknowledge their OWN assignments, and nothing else', () => {
  assert.equal(can('CREW', 'assignment.view_own'), true)
  assert.equal(can('CREW', 'assignment.acknowledge_own'), true)
  assert.equal(can('CREW', 'labor.clock_self'), true)
  // Denied — the whole point of the crew boundary:
  assert.equal(can('CREW', 'schedule.view'), false)
  assert.equal(can('CREW', 'schedule.manage'), false)
  assert.equal(can('CREW', 'staff.view'), false)
  assert.equal(can('CREW', 'money.view_company_profit'), false)
  assert.equal(can('CREW', 'labor.view_all_labor'), false)
  assert.equal(can('CREW', 'closeout.view'), false)
})

test('no role null falls through to false', () => {
  assert.equal(can(null, 'schedule.view'), false)
  assert.equal(can(undefined, 'assignment.view_own'), false)
})
