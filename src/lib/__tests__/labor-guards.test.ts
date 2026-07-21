// Phase 1 — the ROUTE decisions. These are the exact predicates the labor API
// routes call (src/lib/labor-guards.ts), so a passing test here is a statement
// about the route's behavior, not a parallel re-implementation of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canApproveLabor,
  canChangeRateSnapshot,
  canRecordLaborPayment,
  canVoidLaborPayment,
  canConfirmZeroLabor,
  canAssignCrew,
  canDeleteAssignment,
  canWriteTime,
  remainingPayableCents,
} from '../labor-guards'

const deny = (d: ReturnType<typeof canApproveLabor>) => (d.allow ? null : d.status)

// ── Approval ────────────────────────────────────────────────────────────────

const APPROVE_OK = { role: 'OWNER' as const, isSelf: false, hasOpenShift: false, calculatedPayCents: 20000 }

test('an owner can approve someone else’s labor', () => {
  assert.equal(canApproveLabor(APPROVE_OK).allow, true)
})

test('NOBODY approves their own labor — not even an owner', () => {
  const d = canApproveLabor({ ...APPROVE_OK, isSelf: true })
  assert.equal(d.allow, false)
  assert.equal(deny(d), 403)
})

test('a manager cannot approve labor', () => {
  assert.equal(deny(canApproveLabor({ ...APPROVE_OK, role: 'MANAGER' })), 403)
})

test('a worker cannot approve labor', () => {
  assert.equal(deny(canApproveLabor({ ...APPROVE_OK, role: 'CREW' })), 403)
})

test('an unauthenticated caller cannot approve labor', () => {
  assert.equal(deny(canApproveLabor({ ...APPROVE_OK, role: null })), 403)
})

test('labor with an open shift cannot be approved', () => {
  assert.equal(deny(canApproveLabor({ ...APPROVE_OK, hasOpenShift: true })), 422)
})

test('approving a DIFFERENT amount requires a reason', () => {
  assert.equal(deny(canApproveLabor({ ...APPROVE_OK, approvedPayCents: 18000 })), 422)
  assert.equal(canApproveLabor({ ...APPROVE_OK, approvedPayCents: 18000, reason: 'Agreed discount' }).allow, true)
  // Approving the SAME amount needs no reason.
  assert.equal(canApproveLabor({ ...APPROVE_OK, approvedPayCents: 20000 }).allow, true)
})

// ── Rate snapshot ───────────────────────────────────────────────────────────

test('an unchanged rate needs no permission at all', () => {
  assert.equal(canChangeRateSnapshot({ role: 'MANAGER', changed: false }).allow, true)
})

test('only an owner may rewrite a locked-in rate, and only with a reason', () => {
  assert.equal(deny(canChangeRateSnapshot({ role: 'MANAGER', changed: true, reason: 'x' })), 403)
  assert.equal(deny(canChangeRateSnapshot({ role: 'OWNER', changed: true })), 422)
  assert.equal(canChangeRateSnapshot({ role: 'OWNER', changed: true, reason: 'Rate was mistyped at assignment' }).allow, true)
})

// ── Payments ────────────────────────────────────────────────────────────────

const PAY_BASE = { role: 'OWNER' as const, approvalStatus: 'APPROVED', approvedCents: 40000, alreadyPaidCents: 0 }

test('remainingPayableCents never goes negative', () => {
  assert.equal(remainingPayableCents(40000, 25000), 15000)
  assert.equal(remainingPayableCents(40000, 50000), 0)
})

test('unapproved labor cannot be paid', () => {
  assert.equal(deny(canRecordLaborPayment({ ...PAY_BASE, approvalStatus: 'SUBMITTED', amountCents: 10000 })), 422)
})

test('SCENARIO 7: approve $400, pay $250 -> allowed, $150 still owed', () => {
  assert.equal(canRecordLaborPayment({ ...PAY_BASE, amountCents: 25000 }).allow, true)
  assert.equal(remainingPayableCents(40000, 25000), 15000)
  // The remaining $150 can then be paid.
  assert.equal(canRecordLaborPayment({ ...PAY_BASE, alreadyPaidCents: 25000, amountCents: 15000 }).allow, true)
})

test('paying MORE than is owed is blocked unless explicitly confirmed WITH a note', () => {
  assert.equal(deny(canRecordLaborPayment({ ...PAY_BASE, alreadyPaidCents: 25000, amountCents: 20000 })), 422)
  assert.equal(deny(canRecordLaborPayment({ ...PAY_BASE, alreadyPaidCents: 25000, amountCents: 20000, allowOverpay: true })), 422)
  const okOverpay = canRecordLaborPayment({ ...PAY_BASE, alreadyPaidCents: 25000, amountCents: 20000, allowOverpay: true, notes: 'Rounded up as a thank-you' })
  assert.equal(okOverpay.allow, true)
  assert.equal(okOverpay.allow === true && okOverpay.overrideUsed, true)
})

test('a zero or negative payment is refused', () => {
  assert.equal(deny(canRecordLaborPayment({ ...PAY_BASE, amountCents: 0 })), 422)
})

test('a worker cannot record a labor payment', () => {
  assert.equal(deny(canRecordLaborPayment({ ...PAY_BASE, role: 'CREW', amountCents: 1000 })), 403)
})

test('only an owner voids a payment, with a reason, and never twice', () => {
  assert.equal(deny(canVoidLaborPayment({ role: 'MANAGER', alreadyVoided: false, reason: 'x' })), 403)
  assert.equal(deny(canVoidLaborPayment({ role: 'OWNER', alreadyVoided: false })), 422)
  assert.equal(deny(canVoidLaborPayment({ role: 'OWNER', alreadyVoided: true, reason: 'x' })), 409)
  assert.equal(canVoidLaborPayment({ role: 'OWNER', alreadyVoided: false, reason: 'Paid twice by mistake' }).allow, true)
})

// ── $0 labor ────────────────────────────────────────────────────────────────

test('SCENARIO 6: confirming $0 labor is owner-only and needs a reason', () => {
  assert.equal(deny(canConfirmZeroLabor({ role: 'MANAGER', reason: 'x' })), 403)
  assert.equal(deny(canConfirmZeroLabor({ role: 'OWNER' })), 422)
  assert.equal(deny(canConfirmZeroLabor({ role: 'OWNER', reason: '   ' })), 422)
  assert.equal(canConfirmZeroLabor({ role: 'OWNER', reason: 'Owners worked; treating labor as a draw' }).allow, true)
})

// ── Assignment ──────────────────────────────────────────────────────────────

const ASSIGN_OK = { role: 'OWNER' as const, workerActive: true, workerName: 'Sam', alreadyAssigned: false, payModel: 'HOURLY', hasAnyRate: true }

test('an owner or manager can assign crew; a worker cannot', () => {
  assert.equal(canAssignCrew(ASSIGN_OK).allow, true)
  assert.equal(canAssignCrew({ ...ASSIGN_OK, role: 'MANAGER' }).allow, true)
  assert.equal(deny(canAssignCrew({ ...ASSIGN_OK, role: 'CREW' })), 403)
})

test('a deactivated worker cannot be assigned', () => {
  assert.equal(deny(canAssignCrew({ ...ASSIGN_OK, workerActive: false })), 422)
})

test('the same worker cannot be assigned to one move twice', () => {
  assert.equal(deny(canAssignCrew({ ...ASSIGN_OK, alreadyAssigned: true })), 409)
})

test('an HOURLY worker with no rate anywhere is refused — free labor is never assumed', () => {
  assert.equal(deny(canAssignCrew({ ...ASSIGN_OK, hasAnyRate: false })), 422)
})

test('an UNPAID_OWNER assignment needs no rate — that model is deliberate', () => {
  assert.equal(canAssignCrew({ ...ASSIGN_OK, payModel: 'UNPAID_OWNER', hasAnyRate: false }).allow, true)
})

test('settled or approved labor is cancelled, never deleted', () => {
  assert.equal(deny(canDeleteAssignment({ role: 'OWNER', hasPayments: true, approvalStatus: 'DRAFT' })), 422)
  assert.equal(deny(canDeleteAssignment({ role: 'OWNER', hasPayments: false, approvalStatus: 'APPROVED' })), 422)
  assert.equal(canDeleteAssignment({ role: 'OWNER', hasPayments: false, approvalStatus: 'DRAFT' }).allow, true)
})

// ── Time-entry authority ────────────────────────────────────────────────────

test('SCENARIO 8: a worker may clock THEMSELVES but not another worker', () => {
  assert.equal(canWriteTime({ role: 'CREW', isSelf: true }).allow, true)
  assert.equal(deny(canWriteTime({ role: 'CREW', isSelf: false })), 403)
})

test('an owner or manager may record time for anyone', () => {
  assert.equal(canWriteTime({ role: 'OWNER', isSelf: false }).allow, true)
  assert.equal(canWriteTime({ role: 'MANAGER', isSelf: false }).allow, true)
})

test('an unauthenticated caller may record no time at all', () => {
  assert.equal(deny(canWriteTime({ role: null, isSelf: true })), 403)
})
