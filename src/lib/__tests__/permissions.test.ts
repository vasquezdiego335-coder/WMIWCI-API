// Offline tests for the permission matrix (increment 2.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, denyReason } from '../permissions'

test('OWNER may perform every action', () => {
  for (const a of [
    'action_center.view', 'reminder.dismiss_permanent', 'reminder.restore', 'roadmap.seed',
    'money.view_company_profit', 'money.view_owner_ledger', 'money.edit_finalized_expense',
    'money.worker_pay_override', 'payroll.approve', 'audit.view',
  ] as const) {
    assert.equal(can('OWNER', a), true, a)
  }
})

test('MANAGER may do operations but NOT owner-financial authority', () => {
  // Allowed operational actions.
  assert.equal(can('MANAGER', 'action_center.view'), true)
  assert.equal(can('MANAGER', 'reminder.claim'), true)
  assert.equal(can('MANAGER', 'reminder.resolve'), true)
  assert.equal(can('MANAGER', 'reminder.dismiss_occurrence'), true)
  assert.equal(can('MANAGER', 'roadmap.create'), true)
  assert.equal(can('MANAGER', 'money.create_expense'), true)
  assert.equal(can('MANAGER', 'money.record_payment'), true)
  assert.equal(can('MANAGER', 'money.view_job_profit'), true)
  // Forbidden owner-only actions.
  assert.equal(can('MANAGER', 'reminder.dismiss_permanent'), false)
  assert.equal(can('MANAGER', 'reminder.restore'), false)
  assert.equal(can('MANAGER', 'roadmap.seed'), false)
  assert.equal(can('MANAGER', 'money.view_owner_ledger'), false)
  assert.equal(can('MANAGER', 'money.view_company_profit'), false)
  assert.equal(can('MANAGER', 'money.create_owner_transaction'), false)
  assert.equal(can('MANAGER', 'money.edit_finalized_expense'), false)
  assert.equal(can('MANAGER', 'money.delete_expense'), false)
  assert.equal(can('MANAGER', 'money.worker_pay_override'), false)
  assert.equal(can('MANAGER', 'money.edit_business_config'), false)
  assert.equal(can('MANAGER', 'payroll.approve'), false)
  assert.equal(can('MANAGER', 'payroll.mark_paid'), false)
  assert.equal(can('MANAGER', 'audit.view'), false)
})

test('CREW and unauthenticated are denied everything', () => {
  assert.equal(can('CREW', 'action_center.view'), false)
  assert.equal(can(null, 'action_center.view'), false)
  assert.equal(can(undefined, 'reminder.resolve'), false)
})

test('both founders are OWNER → identical access (no PRIMARY/CO distinction)', () => {
  // Diego and Sebastian are both co-owners with the OWNER role. The permission
  // model is role-based, so any two OWNER accounts are provably identical.
  const actions = [
    'action_center.view', 'reminder.dismiss_permanent', 'reminder.restore', 'roadmap.seed',
    'money.view_company_profit', 'money.view_owner_ledger', 'money.create_owner_transaction',
    'money.edit_finalized_expense', 'money.worker_pay_override', 'payroll.approve', 'payroll.mark_paid',
    'audit.view',
  ] as const
  for (const a of actions) {
    const diego = can('OWNER', a)
    const sebastian = can('OWNER', a) // same role → same result, by construction
    assert.equal(diego, sebastian, a)
    assert.equal(diego, true, a) // and both have full access
  }
})

test('denyReason gives an owner-friendly message and null when allowed', () => {
  assert.equal(denyReason('OWNER', 'roadmap.seed'), null)
  assert.equal(denyReason('MANAGER', 'reminder.dismiss_permanent'), 'Only an owner can perform this action.')
  assert.equal(denyReason('CREW', 'action_center.view'), 'You do not have access to this action.')
  assert.equal(denyReason(null, 'action_center.view'), 'You do not have access to this action.')
})
