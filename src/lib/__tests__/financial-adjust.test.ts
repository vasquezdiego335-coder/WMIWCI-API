// Offline tests for finalized-record adjustment predicates (increment 2.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFinalizedExpenseStatus, financialFieldChanged } from '../financial-adjust'

test('finalized expense statuses are APPROVED and REIMBURSED only', () => {
  assert.equal(isFinalizedExpenseStatus('APPROVED'), true)
  assert.equal(isFinalizedExpenseStatus('REIMBURSED'), true)
  assert.equal(isFinalizedExpenseStatus('SUBMITTED'), false)
  assert.equal(isFinalizedExpenseStatus('NEEDS_REVIEW'), false)
  assert.equal(isFinalizedExpenseStatus('REJECTED'), false)
})

test('financialFieldChanged detects real changes, ignores no-ops', () => {
  assert.equal(financialFieldChanged(5000, 6000), true)
  assert.equal(financialFieldChanged(5000, 5000), false)
  assert.equal(financialFieldChanged(null, 5000), true)
  assert.equal(financialFieldChanged(undefined, undefined), false)
})
