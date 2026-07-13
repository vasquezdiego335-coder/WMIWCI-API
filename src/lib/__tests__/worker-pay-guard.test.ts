// Offline tests for the server-side WORKER_PAY double-count guard (increment 2.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWorkerPayExpense } from '../worker-pay-guard'

test('non-WORKER_PAY expenses always pass', () => {
  const r = evaluateWorkerPayExpense({ category: 'GAS', bookingHasCrewLabor: true, override: false, role: 'MANAGER' })
  assert.deepEqual(r, { allow: true, overrideUsed: false })
})

test('WORKER_PAY on a job WITHOUT crew payroll passes (real non-crew helper)', () => {
  const r = evaluateWorkerPayExpense({ category: 'WORKER_PAY', bookingHasCrewLabor: false, override: false, role: 'MANAGER' })
  assert.deepEqual(r, { allow: true, overrideUsed: false })
})

test('WORKER_PAY duplicating crew payroll is BLOCKED (422) without override', () => {
  const r = evaluateWorkerPayExpense({ category: 'WORKER_PAY', bookingHasCrewLabor: true, override: false, role: 'OWNER' })
  assert.equal(r.allow, false)
  assert.equal(r.allow === false && r.status, 422)
})

test('override by a MANAGER is forbidden (403) even with a reason', () => {
  const r = evaluateWorkerPayExpense({ category: 'WORKER_PAY', bookingHasCrewLabor: true, override: true, role: 'MANAGER', reason: 'because' })
  assert.equal(r.allow, false)
  assert.equal(r.allow === false && r.status, 403)
})

test('owner override REQUIRES a reason', () => {
  const noReason = evaluateWorkerPayExpense({ category: 'WORKER_PAY', bookingHasCrewLabor: true, override: true, role: 'OWNER' })
  assert.equal(noReason.allow, false)
  assert.equal(noReason.allow === false && noReason.status, 422)
  const ok = evaluateWorkerPayExpense({ category: 'WORKER_PAY', bookingHasCrewLabor: true, override: true, role: 'OWNER', reason: 'Day helper, not on crew' })
  assert.deepEqual(ok, { allow: true, overrideUsed: true })
})
