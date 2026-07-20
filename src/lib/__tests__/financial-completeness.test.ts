// Phase 0 — a move's profit must never render as final while its costs are
// missing. These tests pin the warning triggers and the finalization guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateFinancialCompleteness,
  completenessLabel,
  canFinalizeFinancials,
  isSettledForMoney,
  MISSING_LABOR_WARNING,
  MISSING_EXPENSES_WARNING,
} from '../financial-completeness'

const PAID = [{ amount: 200000, status: 'COMPLETED' }]
const EXPENSE = [{ amount: 6000, status: 'APPROVED' }]
const CREW = [{ actualHours: 8, payRate: 3000, payStatus: 'PAID' }]

test('completed move with NO JobCrew records warns about missing labor', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSE, payments: PAID })
  assert.equal(c.missingLabor, true)
  assert.equal(c.isComplete, false)
  assert.equal(c.status, 'INCOMPLETE')
  assert.ok(c.warnings.includes(MISSING_LABOR_WARNING))
  assert.ok(c.blockers.includes(MISSING_LABOR_WARNING))
  assert.equal(completenessLabel(c), 'Missing labor')
})

test('crew assigned but hours never entered still warns', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [{ payStatus: 'SCHEDULED' }], expenses: EXPENSE, payments: PAID })
  assert.equal(c.missingLabor, true)
})

test('move with valid labor records does NOT warn', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: CREW, expenses: EXPENSE, payments: PAID })
  assert.equal(c.missingLabor, false)
  assert.equal(c.isComplete, true)
  assert.equal(c.status, 'COMPLETE')
  assert.deepEqual(c.warnings, [])
  assert.equal(completenessLabel(c), 'Complete')
})

test('CONFIRMED $0 labor is distinguishable from MISSING labor', () => {
  const confirmed = evaluateFinancialCompleteness({
    status: 'COMPLETED',
    crew: [{ flatPay: 0, actualHours: 0, payRate: 0 }],
    expenses: EXPENSE,
    payments: PAID,
  })
  assert.equal(confirmed.laborConfirmedZero, true)
  assert.equal(confirmed.missingLabor, false)
  assert.equal(confirmed.isComplete, true)

  const missing = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSE, payments: PAID })
  assert.equal(missing.laborConfirmedZero, false)
  assert.equal(missing.missingLabor, true)
})

test('no eligible expenses is a warning but not a finalization blocker', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: CREW, expenses: [], payments: PAID })
  assert.equal(c.missingExpenses, true)
  assert.equal(c.isComplete, false)
  assert.ok(c.warnings.includes(MISSING_EXPENSES_WARNING))
  assert.equal(c.blockers.length, 0)
})

test('a REJECTED-only expense set counts as no expenses recorded', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: CREW, expenses: [{ amount: 5000, status: 'REJECTED' }], payments: PAID })
  assert.equal(c.missingExpenses, true)
})

test('unreviewed expenses are surfaced without blocking', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: CREW, expenses: [{ amount: 5000, status: 'SUBMITTED' }], payments: PAID })
  assert.equal(c.unreviewedExpenses, true)
  assert.equal(c.blockers.length, 0)
})

test('a completed move with no captured payment is a blocker', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: CREW, expenses: EXPENSE, payments: [] })
  assert.equal(c.missingPaymentData, true)
  assert.equal(c.blockers.length, 1)
})

test('an unknown partial-refund amount is a blocker', () => {
  const c = evaluateFinancialCompleteness({
    status: 'COMPLETED',
    crew: CREW,
    expenses: EXPENSE,
    payments: [{ amount: 200000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: null }],
  })
  assert.equal(c.missingPaymentData, true)
  assert.ok(c.blockers.length > 0)
})

test('bookings that have not been worked are NOT_APPLICABLE and never nag', () => {
  for (const status of ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'DRAFT', 'CANCELLED']) {
    const c = evaluateFinancialCompleteness({ status, crew: [], expenses: [], payments: [] })
    assert.equal(c.status, 'NOT_APPLICABLE', status)
    assert.deepEqual(c.warnings, [], status)
    assert.equal(c.missingLabor, false, status)
  }
  assert.equal(isSettledForMoney('IN_PROGRESS'), true)
  assert.equal(isSettledForMoney('COMPLETED'), true)
  assert.equal(isSettledForMoney('CONFIRMED'), false)
})

test('profit stays available even when incomplete — it is marked, not hidden', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: [], payments: PAID })
  assert.equal(c.isComplete, false)
  assert.ok(c.warnings.length >= 2)
  // Nothing in the shape suppresses the number; the caller still renders it.
  assert.equal(typeof c.status, 'string')
})

// ── Finalization guard ──────────────────────────────────────────────────────

test('finalization is BLOCKED when labor is missing', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSE, payments: PAID })
  const d = canFinalizeFinancials({ completeness: c, override: false, role: 'OWNER' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
})

test('finalization is ALLOWED when nothing is blocking', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: CREW, expenses: EXPENSE, payments: PAID })
  const d = canFinalizeFinancials({ completeness: c, override: false, role: 'OWNER' })
  assert.equal(d.allow, true)
  assert.equal(d.allow === true && d.overrideUsed, false)
})

test('a MANAGER can never override an incomplete finalization', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSE, payments: PAID })
  const d = canFinalizeFinancials({ completeness: c, override: true, role: 'MANAGER', reason: 'trust me' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 403)
})

test('an OWNER override REQUIRES a reason', () => {
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSE, payments: PAID })
  assert.equal(canFinalizeFinancials({ completeness: c, override: true, role: 'OWNER' }).allow, false)
  assert.equal(canFinalizeFinancials({ completeness: c, override: true, role: 'OWNER', reason: '   ' }).allow, false)
  const ok = canFinalizeFinancials({ completeness: c, override: true, role: 'OWNER', reason: 'Owners worked unpaid; labor is a draw.' })
  assert.equal(ok.allow, true)
  assert.equal(ok.allow === true && ok.overrideUsed, true)
})

test('a move that was never worked cannot be finalized at all', () => {
  const c = evaluateFinancialCompleteness({ status: 'CONFIRMED', crew: [], expenses: [], payments: [] })
  const d = canFinalizeFinancials({ completeness: c, override: true, role: 'OWNER', reason: 'x' })
  assert.equal(d.allow, false)
})
