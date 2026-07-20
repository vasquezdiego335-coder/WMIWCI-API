// ============================================================================
// labor-guards.ts — the pure decisions the labor routes enforce (Phase 1).
//
// Same pattern as worker-pay-guard.ts: the rule lives here as a pure function so
// it is unit-testable offline AND cannot be bypassed by a forged request — the
// route calls it, the test calls it, they cannot drift.
// ============================================================================

import type { Role } from './permissions'
import { can } from './permissions'

export type GuardDecision =
  | { allow: true; overrideUsed?: boolean }
  | { allow: false; status: 403 | 409 | 422; error: string }

const ok: GuardDecision = { allow: true }

// ── Approval ────────────────────────────────────────────────────────────────

export interface ApproveContext {
  role: Role | null
  /** Is the approver the same person the labor belongs to? */
  isSelf: boolean
  hasOpenShift: boolean // clocked in, never clocked out
  calculatedPayCents: number
  approvedPayCents?: number | null
  reason?: string
}

/**
 * NOBODY approves their own pay — not a worker, not a manager, and not an owner
 * on their own assignment. With two owners there is always someone else who can,
 * and self-approval is the single easiest way for a labor ledger to stop meaning
 * anything.
 */
export function canApproveLabor(ctx: ApproveContext): GuardDecision {
  if (!can(ctx.role, 'payroll.approve')) {
    return { allow: false, status: 403, error: 'Only an owner can approve labor.' }
  }
  if (ctx.isSelf) {
    return { allow: false, status: 403, error: 'You cannot approve your own labor. Ask the other owner to approve it.' }
  }
  if (ctx.hasOpenShift) {
    return { allow: false, status: 422, error: 'This shift has no clock-out. Complete the hours before approving.' }
  }
  // An owner may approve a different amount, but must say why.
  if (ctx.approvedPayCents != null && ctx.approvedPayCents !== ctx.calculatedPayCents && !ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'A reason is required to approve an amount different from the calculated pay.' }
  }
  return ok
}

// ── Rate snapshot ───────────────────────────────────────────────────────────

export interface RateChangeContext {
  role: Role | null
  changed: boolean
  reason?: string
}

/**
 * A locked-in rate is the integrity anchor of a past move's profit. Changing one
 * rewrites history, so it is owner-only and must carry a reason that lands in
 * the audit log as before → after.
 */
export function canChangeRateSnapshot(ctx: RateChangeContext): GuardDecision {
  if (!ctx.changed) return ok
  if (!can(ctx.role, 'labor.edit_rate_snapshot')) {
    return { allow: false, status: 403, error: 'Only an owner can change a rate that was already locked in for this move.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'A reason is required to change a locked-in rate — it changes what this move cost.' }
  }
  return ok
}

// ── Payments ────────────────────────────────────────────────────────────────

export interface PaymentContext {
  role: Role | null
  approvalStatus: string
  approvedCents: number
  alreadyPaidCents: number
  amountCents: number
  allowOverpay?: boolean
  notes?: string
}

export const remainingPayableCents = (approvedCents: number, alreadyPaidCents: number): number =>
  Math.max(0, approvedCents - alreadyPaidCents)

/**
 * You cannot pay an amount nobody agreed to, and you cannot quietly overpay.
 * Partial payments are first-class: paying $250 against $400 leaves $150 owed.
 */
export function canRecordLaborPayment(ctx: PaymentContext): GuardDecision {
  if (!can(ctx.role, 'labor.record_payment')) {
    return { allow: false, status: 403, error: 'You do not have permission to record labor payments.' }
  }
  if (ctx.approvalStatus !== 'APPROVED') {
    return { allow: false, status: 422, error: 'This labor has not been approved yet. Approve the hours before recording a payment.' }
  }
  if (ctx.amountCents <= 0) {
    return { allow: false, status: 422, error: 'A payment amount must be greater than zero.' }
  }
  const remaining = remainingPayableCents(ctx.approvedCents, ctx.alreadyPaidCents)
  if (ctx.amountCents > remaining) {
    if (!ctx.allowOverpay) {
      return {
        allow: false,
        status: 422,
        error: `That is more than the $${(remaining / 100).toFixed(2)} still owed on this assignment. Reduce the amount, or confirm the overpayment.`,
      }
    }
    if (!ctx.notes?.trim()) {
      return { allow: false, status: 422, error: 'A note is required when paying more than the approved amount.' }
    }
    return { allow: true, overrideUsed: true }
  }
  return ok
}

export interface VoidContext {
  role: Role | null
  alreadyVoided: boolean
  reason?: string
}

export function canVoidLaborPayment(ctx: VoidContext): GuardDecision {
  if (!can(ctx.role, 'labor.void_payment')) {
    return { allow: false, status: 403, error: 'Only an owner can void a labor payment.' }
  }
  if (ctx.alreadyVoided) {
    return { allow: false, status: 409, error: 'This payment is already voided.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'A reason is required to void a payment.' }
  }
  return ok
}

// ── $0 labor ────────────────────────────────────────────────────────────────

export function canConfirmZeroLabor(ctx: { role: Role | null; reason?: string }): GuardDecision {
  if (!can(ctx.role, 'labor.confirm_zero_labor')) {
    return { allow: false, status: 403, error: 'Only an owner can confirm $0 labor.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'A reason is required to confirm $0 labor cost.' }
  }
  return ok
}

// ── Assignment ──────────────────────────────────────────────────────────────

export interface AssignContext {
  role: Role | null
  workerActive: boolean
  workerName: string
  alreadyAssigned: boolean
  payModel: string
  /** Rate available from the request OR the worker's profile. */
  hasAnyRate: boolean
}

export function canAssignCrew(ctx: AssignContext): GuardDecision {
  if (!can(ctx.role, 'labor.assign_crew')) {
    return { allow: false, status: 403, error: 'Only an owner or manager can assign crew.' }
  }
  if (!ctx.workerActive) {
    return { allow: false, status: 422, error: `${ctx.workerName} is deactivated and cannot be assigned.` }
  }
  if (ctx.alreadyAssigned) {
    return { allow: false, status: 409, error: `${ctx.workerName} is already assigned to this move.` }
  }
  // The one combination that silently produces free labor. Owners may be
  // unpaid — that is a deliberate model, not a missing rate.
  if (ctx.payModel === 'HOURLY' && !ctx.hasAnyRate) {
    return {
      allow: false,
      status: 422,
      error: `${ctx.workerName} has no pay rate. Enter an hourly rate for this move, or set one on their staff profile.`,
    }
  }
  return ok
}

/** Deleting settled labor destroys financial history; cancel with a reason. */
export function canDeleteAssignment(ctx: { role: Role | null; hasPayments: boolean; approvalStatus: string }): GuardDecision {
  if (!can(ctx.role, 'labor.assign_crew')) {
    return { allow: false, status: 403, error: 'Forbidden' }
  }
  if (ctx.hasPayments) {
    return { allow: false, status: 422, error: 'This assignment has recorded payments and cannot be removed. Cancel it with a reason instead.' }
  }
  if (ctx.approvalStatus === 'APPROVED') {
    return { allow: false, status: 422, error: 'This labor was already approved. Cancel the assignment with a reason instead of deleting it.' }
  }
  return ok
}

// ── Time entry authority ────────────────────────────────────────────────────

/** Who may write time on an assignment: anyone with labor.enter_hours, or the
 *  worker themselves clocking their OWN row. Row ownership cannot live in the
 *  permission matrix, so it is a parameter here. */
export function canWriteTime(ctx: { role: Role | null; isSelf: boolean }): GuardDecision {
  if (can(ctx.role, 'labor.enter_hours')) return ok
  if (ctx.isSelf && can(ctx.role, 'labor.clock_self')) return ok
  return { allow: false, status: 403, error: 'You can only record time on your own assignment.' }
}
