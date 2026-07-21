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

// ── PHASE 1: the distinct labor states (owner spec 2026-07-20) ──────────────
// The whole point is that these are never collapsed into a generic "$0".

import { deriveLaborState } from '../financial-completeness'
import { can } from '../permissions'

const APPROVED = { approvalStatus: 'APPROVED', paymentStatus: 'UNPAID', hourlyRateCentsSnapshot: 2500, workedMinutes: 480 }

test('labor state: no assignments at all', () => {
  assert.equal(deriveLaborState([]), 'NOT_ASSIGNED')
})

test('labor state: assigned but no hours ever entered', () => {
  assert.equal(deriveLaborState([{ assignmentStatus: 'ASSIGNED', hourlyRateCentsSnapshot: 2500 }]), 'ASSIGNED_NO_HOURS')
})

test('labor state: an open shift is MISSING_CLOCK_OUT, and it blocks', () => {
  const crew = [{ ...APPROVED, clockIn: new Date(), clockOut: null }]
  assert.equal(deriveLaborState(crew), 'MISSING_CLOCK_OUT')
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew, expenses: EXPENSE, payments: PAID })
  assert.equal(c.isComplete, false)
  assert.ok(c.blockers.length > 0)
  assert.equal(completenessLabel(c), 'Missing clock-out')
})

test('labor state: hours with no rate is MISSING_RATE, and it blocks', () => {
  const crew = [{ assignmentStatus: 'ASSIGNED', workedMinutes: 480, payModel: 'HOURLY' }]
  assert.equal(deriveLaborState(crew), 'MISSING_RATE')
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew, expenses: EXPENSE, payments: PAID })
  assert.ok(c.blockers.length > 0)
})

test('labor state: entered but unapproved is NOT yet a cost, and blocks finalization', () => {
  const crew = [{ approvalStatus: 'SUBMITTED', hourlyRateCentsSnapshot: 2500, workedMinutes: 480 }]
  assert.equal(deriveLaborState(crew), 'HOURS_UNAPPROVED')
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew, expenses: EXPENSE, payments: PAID })
  assert.equal(c.laborUnapproved, true)
  assert.equal(c.isComplete, false)
  assert.equal(completenessLabel(c), 'Hours need approval')
  assert.equal(canFinalizeFinancials({ completeness: c, override: false, role: 'OWNER' }).allow, false)
})

test('labor state: approved and unpaid is COMPLETE — the cost is agreed', () => {
  const crew = [APPROVED]
  assert.equal(deriveLaborState(crew), 'APPROVED_UNPAID')
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew, expenses: EXPENSE, payments: PAID })
  assert.equal(c.isComplete, true)
  assert.equal(c.laborUnpaid, true)
  assert.equal(canFinalizeFinancials({ completeness: c, override: false, role: 'OWNER' }).allow, true)
})

test('labor state: fully paid', () => {
  assert.equal(deriveLaborState([{ ...APPROVED, paymentStatus: 'PAID' }]), 'PAID')
})

test('labor state: an explicit $0 confirmation is COMPLETE, a missing one is not', () => {
  const confirmed = [{ payModel: 'ZERO_CONFIRMED', zeroLaborConfirmed: true, approvalStatus: 'APPROVED', paymentStatus: 'UNPAID' }]
  assert.equal(deriveLaborState(confirmed), 'ZERO_CONFIRMED')
  const c = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: confirmed, expenses: EXPENSE, payments: PAID })
  assert.equal(c.laborConfirmedZero, true)
  assert.equal(c.isComplete, true)
  // vs. nobody assigned at all
  const missing = evaluateFinancialCompleteness({ status: 'COMPLETED', crew: [], expenses: EXPENSE, payments: PAID })
  assert.equal(missing.laborState, 'NOT_ASSIGNED')
  assert.equal(missing.isComplete, false)
})

test('cancelled and declined assignments are ignored when deriving the state', () => {
  const crew = [{ assignmentStatus: 'CANCELLED', hourlyRateCentsSnapshot: 2500 }, { assignmentStatus: 'DECLINED' }]
  assert.equal(deriveLaborState(crew), 'NOT_ASSIGNED')
})

// ── Permissions for the labor actions ───────────────────────────────────────

test('a WORKER may clock and submit their own hours, and nothing else', () => {
  assert.equal(can('CREW', 'labor.clock_self'), true)
  assert.equal(can('CREW', 'labor.submit_hours'), true)
  assert.equal(can('CREW', 'labor.view_own_labor'), true)
  for (const a of ['payroll.approve', 'labor.record_payment', 'labor.view_all_labor', 'labor.assign_crew', 'money.view_job_profit', 'money.view_owner_ledger'] as const) {
    assert.equal(can('CREW', a), false, a)
  }
})

test('a MANAGER runs operations but holds no owner-financial labor authority', () => {
  assert.equal(can('MANAGER', 'labor.assign_crew'), true)
  assert.equal(can('MANAGER', 'labor.enter_hours'), true)
  assert.equal(can('MANAGER', 'labor.record_payment'), true)
  for (const a of ['labor.edit_rate_snapshot', 'labor.confirm_zero_labor', 'labor.set_owner_labor_value', 'labor.void_payment', 'labor.finalize_override', 'payroll.approve'] as const) {
    assert.equal(can('MANAGER', a), false, a)
  }
})

test('an OWNER can do everything labor-related', () => {
  for (const a of ['labor.assign_crew', 'labor.edit_rate_snapshot', 'labor.confirm_zero_labor', 'labor.set_owner_labor_value', 'labor.void_payment', 'payroll.approve', 'labor.finalize_override'] as const) {
    assert.equal(can('OWNER', a), true, a)
  }
})

test('an unauthenticated caller can do nothing', () => {
  assert.equal(can(null, 'labor.clock_self'), false)
  assert.equal(can(undefined, 'labor.view_own_labor'), false)
})
