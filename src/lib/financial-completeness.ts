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
  isLiveAssignment,
  isApprovedLabor,
  isPaidCrew,
  hasPaySignal,
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
export const UNAPPROVED_LABOR_WARNING = 'Crew hours are entered but not approved yet, so they are not counted as a cost.'
export const MISSING_CLOCK_OUT_WARNING = 'A crew member has no clock-out, so their hours are incomplete.'
export const MISSING_RATE_WARNING = 'A crew member has hours but no pay rate, so their labor cannot be priced.'
export const MISSING_EXPENSES_WARNING = 'No job expenses recorded. If fuel, tolls, truck or supplies were paid, profit is overstated.'
export const MISSING_PAYMENT_WARNING = 'Payment information is incomplete. Collected revenue may be inaccurate.'
export const UNKNOWN_REFUND_WARNING = 'A partial refund on this move has no recorded amount. Revenue may be overstated.'
export const UNREVIEWED_EXPENSE_NOTICE = 'Some expenses on this move have not been reviewed yet.'
export const NO_PAYMENT_WARNING = 'This move is completed but no captured payment is recorded.'

export type FinancialStatus = 'COMPLETE' | 'INCOMPLETE' | 'NOT_APPLICABLE'

/**
 * PHASE 1: the distinct labor states a worked move can be in. The whole point
 * is that these are never collapsed into a single "$0".
 */
export type LaborState =
  | 'NOT_ASSIGNED' // nobody on the move — cost UNKNOWN
  | 'ASSIGNED_NO_HOURS' // people on it, no time ever entered — cost UNKNOWN
  | 'MISSING_CLOCK_OUT' // an open shift; the day isn't closed
  | 'MISSING_RATE' // time entered, nothing to price it with
  | 'HOURS_UNAPPROVED' // priced, awaiting owner approval — not yet a cost
  | 'APPROVED_UNPAID' // agreed cost, still owed
  | 'PAID' // agreed and settled
  | 'ZERO_CONFIRMED' // explicitly, deliberately $0

export const LABOR_STATE_LABELS: Record<LaborState, string> = {
  NOT_ASSIGNED: 'No crew assigned',
  ASSIGNED_NO_HOURS: 'Hours not entered',
  MISSING_CLOCK_OUT: 'Missing clock-out',
  MISSING_RATE: 'Missing pay rate',
  HOURS_UNAPPROVED: 'Hours awaiting approval',
  APPROVED_UNPAID: 'Approved — unpaid',
  PAID: 'Paid',
  ZERO_CONFIRMED: '$0 labor confirmed',
}

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
  /** PHASE 1: exactly which labor state this move is in — never a generic zero. */
  laborState: LaborState
  /** Hours entered but not yet approved by an owner. Not a cost yet. */
  laborUnapproved: boolean
  /** Approved labor that is still owed. */
  laborUnpaid: boolean
  /** Everything worth telling the owner, most severe first. */
  warnings: string[]
  /** The subset that must block financial finalization (Phase 2 closeout). */
  blockers: string[]
}

/**
 * Which single state best describes this move's labor. Ordered worst-first so
 * the most actionable problem is what the owner sees.
 */
export function deriveLaborState(crew: CrewRow[]): LaborState {
  const live = crew.filter(isLiveAssignment)
  if (live.length === 0) return 'NOT_ASSIGNED'
  if (isConfirmedZeroLabor(live)) return 'ZERO_CONFIRMED'
  if (live.some((c) => c.clockIn && !c.clockOut)) return 'MISSING_CLOCK_OUT'
  // Checked BEFORE "no hours": time that exists but cannot be priced is a
  // different problem with a different fix, and saying "hours not entered" when
  // the hours ARE entered sends the owner to the wrong place.
  const pricelessWithTime = live.some(
    (c) =>
      (c.workedMinutes != null || c.actualHours != null) &&
      c.hourlyRateCentsSnapshot == null &&
      c.flatPayCentsSnapshot == null &&
      c.dayRateCentsSnapshot == null &&
      c.payRate == null &&
      c.flatPay == null &&
      c.user?.payRate == null &&
      c.payModel !== 'UNPAID_OWNER' &&
      c.payModel !== 'ZERO_CONFIRMED' &&
      c.payModel !== 'CUSTOM',
  )
  if (pricelessWithTime) return 'MISSING_RATE'
  if (!live.some(hasPaySignal)) return 'ASSIGNED_NO_HOURS'
  if (!live.every(isApprovedLabor)) return 'HOURS_UNAPPROVED'
  if (live.every(isPaidCrew)) return 'PAID'
  return 'APPROVED_UNPAID'
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
      laborState: deriveLaborState(input.crew),
      laborUnapproved: false,
      laborUnpaid: false,
      warnings: [],
      blockers: [],
    }
  }

  const laborState = deriveLaborState(input.crew)
  const laborConfirmedZero = laborState === 'ZERO_CONFIRMED'
  const missingLabor =
    laborState === 'NOT_ASSIGNED' || laborState === 'ASSIGNED_NO_HOURS' || isLaborUnrecorded(input.crew)
  const laborUnapproved = laborState === 'HOURS_UNAPPROVED'
  const laborUnpaid = laborState === 'APPROVED_UNPAID'

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
  // PHASE 1: an open shift or an unpriceable one is just as blocking as no
  // labor at all — the cost is still unknown, only for a different reason.
  if (laborState === 'MISSING_CLOCK_OUT') {
    warnings.push(MISSING_CLOCK_OUT_WARNING)
    blockers.push(MISSING_CLOCK_OUT_WARNING)
  }
  if (laborState === 'MISSING_RATE') {
    warnings.push(MISSING_RATE_WARNING)
    blockers.push(MISSING_RATE_WARNING)
  }
  // Unapproved hours are a real number nobody has agreed to. Blocking, because
  // finalizing a move whose labor cost is still provisional defeats the point.
  if (laborUnapproved) {
    warnings.push(UNAPPROVED_LABOR_WARNING)
    blockers.push(UNAPPROVED_LABOR_WARNING)
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

  const isComplete = blockers.length === 0 && !missingExpenses

  return {
    isComplete,
    status: isComplete ? 'COMPLETE' : 'INCOMPLETE',
    missingLabor,
    missingExpenses,
    missingPaymentData,
    unreviewedExpenses,
    laborConfirmedZero,
    laborState,
    laborUnapproved,
    laborUnpaid,
    warnings,
    blockers,
  }
}

/** Short chip text for lists: "Complete", "Missing labor", … */
export function completenessLabel(c: FinancialCompleteness): string {
  if (c.status === 'NOT_APPLICABLE') return 'Not started'
  if (c.isComplete) return 'Complete'
  // PHASE 1: name the SPECIFIC labor problem before the generic one — "missing
  // labor" sends the owner looking for an assignment that already exists.
  if (c.laborState === 'MISSING_CLOCK_OUT') return 'Missing clock-out'
  if (c.laborState === 'MISSING_RATE') return 'Missing pay rate'
  if (c.missingLabor) return 'Missing labor'
  if (c.laborUnapproved) return 'Hours need approval'
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
