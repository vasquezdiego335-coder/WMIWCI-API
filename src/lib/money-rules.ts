// ============================================================================
// money-rules.ts — THE eligibility layer for every money figure in the admin.
// Phase 0 financial integrity (owner spec 2026-07-20, docs/admin/
// phase0-financial-integrity.md).
//
// WHY THIS FILE EXISTS
// Before Phase 0 each page decided for itself which payments counted as revenue
// and which expenses counted as costs. That produced three real defects:
//   1. A refunded payment was dropped from revenue AND subtracted again as a
//      cost (double penalty). A PARTIALLY_REFUNDED payment vanished from revenue
//      entirely while its full face value was charged as a cost.
//   2. The dashboard counted REJECTED expenses; Owner Money excluded them —
//      two different totals from the same rows.
//   3. Nothing distinguished "this payment's refund amount is unknown" from
//      "nothing was refunded".
//
// Every revenue/cost aggregate MUST come through this module. Pages must not
// write their own `status:` filters. Pure functions only (no Prisma, no I/O) so
// the rules are unit-testable offline — same pattern as profit.ts.
//
// UNITS: integer CENTS everywhere.
// ============================================================================

import { disputeOutcome } from './payment-events'

// ── Payments ────────────────────────────────────────────────────────────────

/** The three statuses that mean money was actually CAPTURED. A capture that was
 *  later refunded is still a capture — the refund is netted off, not erased. */
export const CAPTURED_PAYMENT_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const

/** Statuses that are NOT collected money:
 *   PENDING — authorized/held but not captured (the $49 deposit before approval)
 *   FAILED  — declined / cancelled
 *  Prisma `where` fragment for aggregates that must only see captured money. */
export const CAPTURED_PAYMENT_WHERE = { status: { in: [...CAPTURED_PAYMENT_STATUSES] } }

export interface PaymentRow {
  amount: number // captured cents
  status: string // PaymentStatus
  isInternalTest?: boolean | null
  refundedAmountCents?: number | null
  stripeDisputeId?: string | null
  disputeStatus?: string | null
  stripePaymentIntentId?: string | null
  stripeChargeId?: string | null
}

/** True when this row represents money that reached the business bank/cash.
 *  Internal owner checkout tests are never real money, anywhere. */
export function isCapturedPayment(p: PaymentRow): boolean {
  if (p.isInternalTest) return false
  return (CAPTURED_PAYMENT_STATUSES as readonly string[]).includes(p.status)
}

/** True when the payment is merely AUTHORIZED (a hold), not captured. The $49
 *  deposit sits here between checkout and owner approval. Never revenue. */
export function isAuthorizedNotCaptured(p: PaymentRow): boolean {
  return !p.isInternalTest && p.status === 'PENDING'
}

/**
 * How much of this payment was actually refunded.
 *
 * `refundedAmountCents` is the truth (maintained monotonically by
 * payment-events.refundPatch from Stripe's cumulative amount_refunded). It is
 * nullable because the column is newer than some rows, so:
 *   • status REFUNDED + null  → the whole capture was refunded (safe inference)
 *   • status PARTIALLY_REFUNDED + null → amount UNKNOWN. We return 0 and the
 *     caller flags `missingPaymentData` — guessing a partial amount would
 *     silently invent a number, which is exactly what Phase 0 exists to stop.
 * Clamped to the captured amount so a bad webhook can never push revenue below
 * zero or manufacture a negative cost.
 */
export function refundedCentsOf(p: PaymentRow): number {
  if (p.refundedAmountCents != null) return Math.min(Math.max(0, p.refundedAmountCents), p.amount)
  if (p.status === 'REFUNDED') return p.amount
  return 0
}

/** True when this row's refund amount cannot be determined (a partial refund
 *  recorded before refundedAmountCents existed, or an out-of-range value). */
export function hasUnknownRefundAmount(p: PaymentRow): boolean {
  if (p.status === 'PARTIALLY_REFUNDED' && p.refundedAmountCents == null) return true
  if (p.refundedAmountCents != null && (p.refundedAmountCents < 0 || p.refundedAmountCents > p.amount)) return true
  return false
}

/**
 * Money withdrawn by a LOST chargeback. A lost dispute takes back whatever of
 * the capture is still with us, so it is computed as "the rest after refunds" —
 * that construction makes double-subtraction with a refund arithmetically
 * impossible. An OPEN dispute takes nothing yet (see pendingDisputeCents).
 */
export function chargebackCentsOf(p: PaymentRow): number {
  if (!p.stripeDisputeId) return 0
  if (disputeOutcome(p.disputeStatus) !== 'lost') return 0
  return Math.max(0, p.amount - refundedCentsOf(p))
}

/** Captured money currently at risk in an OPEN dispute. Not yet deducted from
 *  revenue (it may be won) but held back from distributable cash. */
export function pendingDisputeCentsOf(p: PaymentRow): number {
  if (!p.stripeDisputeId) return 0
  if (disputeOutcome(p.disputeStatus) !== 'open') return 0
  return Math.max(0, p.amount - refundedCentsOf(p))
}

/**
 * THE revenue number for ONE payment.
 *
 *   captured − refunded − chargeback = net collected
 *
 * Never negative. A refunded payment nets to $0 (not −$amount). A partially
 * refunded $2,000 payment with a $200 refund nets to $1,800.
 */
export function netCollectedCentsOf(p: PaymentRow): number {
  if (!isCapturedPayment(p)) return 0
  const deducted = Math.min(p.amount, refundedCentsOf(p) + chargebackCentsOf(p))
  return Math.max(0, p.amount - deducted)
}

export interface RevenueTotals {
  grossCapturedCents: number // captured before refunds
  refundedCents: number // actually refunded
  chargebackCents: number // lost disputes
  netCollectedCents: number // gross − refunded − chargebacks
  authorizedNotCapturedCents: number // holds; NOT revenue
  pendingDisputeCents: number // captured money at risk in an open dispute
  hasUnknownRefund: boolean // a refund amount could not be determined
}

/** Roll a set of payments into every revenue figure the admin displays. THE
 *  single derivation — the Revenue page, the job Profit card, the dashboard and
 *  Owner Money all call this so their totals cannot diverge. */
export function summarizeRevenue(payments: PaymentRow[]): RevenueTotals {
  const captured = payments.filter(isCapturedPayment)
  const grossCapturedCents = captured.reduce((s, p) => s + p.amount, 0)
  const refundedCents = captured.reduce((s, p) => s + refundedCentsOf(p), 0)
  const chargebackCents = captured.reduce((s, p) => s + chargebackCentsOf(p), 0)
  const netCollectedCents = captured.reduce((s, p) => s + netCollectedCentsOf(p), 0)
  const authorizedNotCapturedCents = payments
    .filter(isAuthorizedNotCaptured)
    .reduce((s, p) => s + p.amount, 0)
  const pendingDisputeCents = captured.reduce((s, p) => s + pendingDisputeCentsOf(p), 0)
  return {
    grossCapturedCents,
    refundedCents,
    chargebackCents,
    netCollectedCents,
    authorizedNotCapturedCents,
    pendingDisputeCents,
    hasUnknownRefund: captured.some(hasUnknownRefundAmount),
  }
}

// ── Expenses ────────────────────────────────────────────────────────────────
//
// POLICY (Phase 0): an expense row records money that LEFT the business. The
// approval workflow is a review state, not a truth state — so SUBMITTED,
// NEEDS_REVIEW, APPROVED and REIMBURSED all count as real spend.
//
// REJECTED means "this is not a business expense" and counts NOWHERE: not job
// cost, not company expense, not cash, not safe-to-distribute.
//
// There is no soft-delete on Expense — DELETE is a hard, owner-only, audited
// removal, so a deleted row cannot be counted by construction.

export const ELIGIBLE_EXPENSE_STATUSES = ['SUBMITTED', 'NEEDS_REVIEW', 'APPROVED', 'REIMBURSED'] as const
export const EXCLUDED_EXPENSE_STATUSES = ['REJECTED'] as const
/** Eligible but not yet reviewed by an owner — counted, and surfaced as an
 *  advisory so "unreviewed" is never mistaken for "verified". */
export const UNREVIEWED_EXPENSE_STATUSES = ['SUBMITTED', 'NEEDS_REVIEW'] as const

/** THE Prisma `where` fragment for every expense aggregate. Use this instead of
 *  hand-writing a status filter on a page. */
export const ELIGIBLE_EXPENSE_WHERE = { status: { notIn: [...EXCLUDED_EXPENSE_STATUSES] } }

export interface ExpenseRow {
  amount: number
  status: string
}

export function isEligibleExpense(e: ExpenseRow): boolean {
  return !(EXCLUDED_EXPENSE_STATUSES as readonly string[]).includes(e.status)
}

export function isUnreviewedExpense(e: ExpenseRow): boolean {
  return (UNREVIEWED_EXPENSE_STATUSES as readonly string[]).includes(e.status)
}

/** Sum of expenses that count. Rejected rows contribute nothing. */
export function eligibleExpenseCents(expenses: ExpenseRow[]): number {
  return expenses.filter(isEligibleExpense).reduce((s, e) => s + e.amount, 0)
}

export function countUnreviewedExpenses(expenses: ExpenseRow[]): number {
  return expenses.filter((e) => isEligibleExpense(e) && isUnreviewedExpense(e)).length
}

// ── Crew labor ──────────────────────────────────────────────────────────────
//
// Labor's single source of truth is JobCrew payroll (docs/financial-
// architecture.md, Option A). Phase 0 does NOT add a write path — it makes the
// ABSENCE of labor data visible instead of silently reporting $0.

export interface CrewRow {
  // legacy columns (pre-Phase-1 rows)
  actualHours?: number | null
  scheduledHours?: number | null
  payRate?: number | null
  flatPay?: number | null
  payStatus?: string | null
  user?: { payRate?: number | null } | null
  // ── Phase 1 (owner spec 2026-07-20) ──
  payModel?: string | null
  assignmentStatus?: string | null
  approvalStatus?: string | null
  paymentStatus?: string | null
  workedMinutes?: number | null
  clockIn?: Date | null
  clockOut?: Date | null
  hourlyRateCentsSnapshot?: number | null
  flatPayCentsSnapshot?: number | null
  dayRateCentsSnapshot?: number | null
  economicRateCentsSnapshot?: number | null
  zeroLaborConfirmed?: boolean | null
}

/** Assignment states that are not labor at all — the person did not work. */
const NON_COSTING_ASSIGNMENT = ['DECLINED', 'CANCELLED', 'NO_SHOW']

/** True when this assignment counts toward the move's labor picture at all. */
export function isLiveAssignment(c: CrewRow): boolean {
  if (c.assignmentStatus && NON_COSTING_ASSIGNMENT.includes(c.assignmentStatus)) return false
  if (c.approvalStatus === 'REJECTED') return false
  return true
}

/**
 * True when this crew row carries enough information to price the labor —
 * INCLUDING an explicit zero. A confirmed $0, an unpaid-owner assignment, and a
 * rate snapshot are all real information; `null` is an absence of it. Phase 0
 * exists to keep those apart, and Phase 1 gives them each a state.
 */
export function hasPaySignal(c: CrewRow): boolean {
  if (c.zeroLaborConfirmed) return true
  if (c.payModel === 'ZERO_CONFIRMED' || c.payModel === 'UNPAID_OWNER' || c.payModel === 'CUSTOM') return true
  // A rate snapshot alone is not enough — we also need time (or a flat amount).
  if (c.flatPayCentsSnapshot != null || c.dayRateCentsSnapshot != null) return true
  const hasTime = c.workedMinutes != null || (c.clockIn != null && c.clockOut != null)
  if (hasTime && c.hourlyRateCentsSnapshot != null) return true
  // legacy rows
  if (c.flatPay != null) return true
  if (c.actualHours != null || c.scheduledHours != null) {
    return c.payRate != null || c.user?.payRate != null
  }
  return false
}

/** True when the crew data says, explicitly, that labor cost nothing. Phase 1
 *  makes this a deliberate, audited act rather than an inference from zeros. */
export function isConfirmedZeroLabor(crew: CrewRow[]): boolean {
  const live = crew.filter(isLiveAssignment)
  if (live.length === 0) return false
  if (live.some((c) => c.zeroLaborConfirmed || c.payModel === 'ZERO_CONFIRMED')) {
    return live.every((c) => c.zeroLaborConfirmed || c.payModel === 'ZERO_CONFIRMED')
  }
  // Legacy inference: every row priced, every price zero.
  if (!live.every(hasPaySignal)) return false
  return live.every((c) => (c.flatPay ?? 0) === 0 && (c.actualHours ?? c.scheduledHours ?? 0) === 0 && (c.workedMinutes ?? 0) === 0)
}

/** True when labor cost for this job is UNKNOWN: nobody assigned, or people
 *  assigned with no hours/rate ever entered. NOT the same as zero. */
export function isLaborUnrecorded(crew: CrewRow[]): boolean {
  const live = crew.filter(isLiveAssignment)
  if (live.length === 0) return true
  return !live.some(hasPaySignal)
}

/** Crew labor already settled in cash (money has left the business). Phase 1's
 *  paymentStatus wins; the legacy payStatus is the fallback for old rows. */
export const isPaidCrew = (c: CrewRow): boolean =>
  c.paymentStatus ? c.paymentStatus === 'PAID' : c.payStatus === 'PAID'

/** Crew labor still owed (accrued but unsettled). */
export const isUnpaidCrew = (c: CrewRow): boolean => !isPaidCrew(c)

/** True when the money on this assignment has been AGREED by an owner. Only
 *  approved labor is a cost — see labor-calc.rollupLabor. */
export const isApprovedLabor = (c: CrewRow): boolean =>
  c.approvalStatus ? c.approvalStatus === 'APPROVED' : c.payStatus === 'PAY_APPROVED' || c.payStatus === 'PAID'
