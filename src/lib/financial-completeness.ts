// ============================================================================
// financial-completeness.ts — "is this move's money story actually finished?"
// Phase 0 financial integrity (owner spec 2026-07-20).
//
// THE PROBLEM THIS SOLVES
// `JobCrew` has no write path anywhere in the application (see docs/admin/
// admin-pre-audit.md §1). So crew pay computes to $0 on every job — and a $0
// labor cost is indistinguishable from a real one. A $2,000 move with two
// owners working all day rendered as ~$1,942 profit with no indication that the
// single largest cost had never been entered.
//
// Phase 0 does NOT invent labor numbers. It returns the profit alongside an
// honest statement of what is missing, so no surface can present an incomplete
// figure as final.
//
// Pure functions, no Prisma, offline-tested.
// ============================================================================

import {
  isLaborUnrecorded,
  isConfirmedZeroLabor,
  isEligibleExpense,
  isUnreviewedExpense,
  isCapturedPayment,
  hasUnknownRefundAmount,
  type CrewRow,
  type ExpenseRow,
  type PaymentRow,
} from './money-rules'

/** Owner-facing copy. Kept here so every surface says the same sentence. */
export const MISSING_LABOR_WARNING = 'Crew labor has not been recorded for this move. Profit may be overstated.'
export const MISSING_EXPENSES_WARNING = 'No job expenses recorded. If fuel, tolls, truck or supplies were paid, profit is overstated.'
export const MISSING_PAYMENT_WARNING = 'Payment information is incomplete. Collected revenue may be inaccurate.'
export const UNKNOWN_REFUND_WARNING = 'A partial refund on this move has no recorded amount. Revenue may be overstated.'
export const UNREVIEWED_EXPENSE_NOTICE = 'Some expenses on this move have not been reviewed yet.'
export const NO_PAYMENT_WARNING = 'This move is completed but no captured payment is recorded.'

export type FinancialStatus = 'COMPLETE' | 'INCOMPLETE' | 'NOT_APPLICABLE'

export interface FinancialCompleteness {
  /** True only when nothing required is missing. Drives the Complete badge. */
  isComplete: boolean
  status: FinancialStatus
  missingLabor: boolean
  missingExpenses: boolean
  missingPaymentData: boolean
  /** Eligible expenses exist but nobody has reviewed them. Advisory only. */
  unreviewedExpenses: boolean
  /** Labor was explicitly recorded as costing nothing — NOT the same as
   *  missing. Lets the UI say "$0 confirmed" instead of "unknown". */
  laborConfirmedZero: boolean
  /** Everything worth telling the owner, most severe first. */
  warnings: string[]
  /** The subset that must block financial finalization (Phase 2 closeout). */
  blockers: string[]
}

export interface CompletenessInput {
  /** BookingStatus — only settled jobs are judged (see NOT_APPLICABLE below). */
  status: string
  crew: CrewRow[]
  expenses: ExpenseRow[]
  payments: PaymentRow[]
}

/** Statuses where the money story is expected to be finished. A booking still
 *  awaiting approval is not "missing" its expenses — it hasn't happened yet. */
const SETTLED_STATUSES = ['IN_PROGRESS', 'COMPLETED']

export function isSettledForMoney(status: string): boolean {
  return SETTLED_STATUSES.includes(status)
}

/**
 * Evaluate what is missing from one move's financial record.
 *
 * Deliberate choices:
 *  • Missing LABOR is a blocker — it is the largest cost in a moving job and
 *    its absence is currently guaranteed (no write path exists).
 *  • Missing PAYMENT DATA is a blocker — revenue would be wrong, not just low.
 *  • Missing EXPENSES is a warning, not a blocker: a labor-only move on a
 *    customer-provided truck can legitimately have none. It still flips
 *    isComplete to false so nothing renders as final.
 *  • Bookings that have not reached the field are NOT_APPLICABLE and produce no
 *    warnings at all — nagging about every pending quote would train the owner
 *    to ignore the banner.
 */
export function evaluateFinancialCompleteness(input: CompletenessInput): FinancialCompleteness {
  if (!isSettledForMoney(input.status)) {
    return {
      isComplete: false,
      status: 'NOT_APPLICABLE',
      missingLabor: false,
      missingExpenses: false,
      missingPaymentData: false,
      unreviewedExpenses: false,
      laborConfirmedZero: false,
      warnings: [],
      blockers: [],
    }
  }

  const laborConfirmedZero = isConfirmedZeroLabor(input.crew)
  const missingLabor = !laborConfirmedZero && isLaborUnrecorded(input.crew)

  const eligibleExpenses = input.expenses.filter(isEligibleExpense)
  const missingExpenses = eligibleExpenses.length === 0
  const unreviewedExpenses = eligibleExpenses.some(isUnreviewedExpense)

  const capturedPayments = input.payments.filter(isCapturedPayment)
  const unknownRefund = capturedPayments.some(hasUnknownRefundAmount)
  const noCapturedPayment = input.status === 'COMPLETED' && capturedPayments.length === 0
  const missingPaymentData = unknownRefund || noCapturedPayment

  const warnings: string[] = []
  const blockers: string[] = []

  if (missingLabor) {
    warnings.push(MISSING_LABOR_WARNING)
    blockers.push(MISSING_LABOR_WARNING)
  }
  if (noCapturedPayment) {
    warnings.push(NO_PAYMENT_WARNING)
    blockers.push(NO_PAYMENT_WARNING)
  }
  if (unknownRefund) {
    warnings.push(UNKNOWN_REFUND_WARNING)
    blockers.push(UNKNOWN_REFUND_WARNING)
  }
  if (missingExpenses) warnings.push(MISSING_EXPENSES_WARNING)
  if (unreviewedExpenses) warnings.push(UNREVIEWED_EXPENSE_NOTICE)

  const isComplete = !missingLabor && !missingExpenses && !missingPaymentData

  return {
    isComplete,
    status: isComplete ? 'COMPLETE' : 'INCOMPLETE',
    missingLabor,
    missingExpenses,
    missingPaymentData,
    unreviewedExpenses,
    laborConfirmedZero,
    warnings,
    blockers,
  }
}

/** Short chip text for lists: "Complete", "Missing labor", … */
export function completenessLabel(c: FinancialCompleteness): string {
  if (c.status === 'NOT_APPLICABLE') return 'Not started'
  if (c.isComplete) return 'Complete'
  if (c.missingLabor) return 'Missing labor'
  if (c.missingPaymentData) return 'Missing payment info'
  if (c.missingExpenses) return 'Missing expenses'
  return 'Financial data incomplete'
}

// ── Finalization guard ──────────────────────────────────────────────────────
//
// Phase 0 ships the RULE, not the workflow. There is no move-closeout model yet
// (Phase 2). This pure decision exists so the closeout route cannot be written
// without honoring it — the same pattern as worker-pay-guard.ts, which was
// written before the payroll UI it protects.

export interface FinalizeContext {
  completeness: FinancialCompleteness
  override: boolean
  role: 'OWNER' | 'MANAGER' | 'CREW' | null
  reason?: string
}

export type FinalizeDecision =
  | { allow: true; overrideUsed: boolean }
  | { allow: false; status: 403 | 422; error: string }

/**
 * May this move be marked financially finalized?
 *
 * Blocked when required financial data is missing, unless an OWNER explicitly
 * overrides WITH a reason (which the caller must write to the audit log as a
 * FINANCIAL_ADJUSTMENT). A MANAGER can never override — finalizing an
 * incomplete money record is owner-financial authority.
 */
export function canFinalizeFinancials(ctx: FinalizeContext): FinalizeDecision {
  if (ctx.completeness.status === 'NOT_APPLICABLE') {
    return { allow: false, status: 422, error: 'This move has not been worked yet, so its finances cannot be finalized.' }
  }
  if (ctx.completeness.blockers.length === 0) return { allow: true, overrideUsed: false }
  if (!ctx.override) {
    return {
      allow: false,
      status: 422,
      error: `This move cannot be finalized yet: ${ctx.completeness.blockers.join(' ')} Record the missing information, or override as an owner with a reason.`,
    }
  }
  if (ctx.role !== 'OWNER') {
    return { allow: false, status: 403, error: 'Only an owner can finalize a move with incomplete financial data.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'An override reason is required to finalize a move with incomplete financial data.' }
  }
  return { allow: true, overrideUsed: true }
}
