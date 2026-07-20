// ============================================================================
// Money math for the admin operating system (owner spec 2026-07-13; corrected
// in Phase 0, owner spec 2026-07-20 — see docs/admin/phase0-financial-integrity.md).
//
// Everything is integer CENTS end-to-end — matches deposit_amount / travel_fee
// and the Expense / OwnerTransaction / JobCrew columns. No Prisma imports here
// on purpose: this stays a pile of pure functions so the profit math is
// unit-testable offline (see src/lib/__tests__/profit.test.ts).
//
// The owner rule this enforces: every dollar is JOB revenue, a JOB cost, an
// OWNER transaction, or a GENERAL business expense. Per-job profit =
//   net collected revenue − (crew pay + eligible job expenses + Stripe fees)
//
// PHASE 0 CORRECTION: refunds are netted off REVENUE, never added as a cost.
// The previous version excluded refunded payments from revenue AND subtracted
// their full face value as a cost, so a $2,000 payment with a $200 refund
// reported −$2,000 instead of +$1,800. Recognition rules now live in
// src/lib/money-rules.ts and are shared by every page.
// ============================================================================

import {
  summarizeRevenue,
  eligibleExpenseCents,
  isPaidCrew,
  isUnpaidCrew,
  type PaymentRow,
  type ExpenseRow,
  type CrewRow,
} from './money-rules'

// Standard US Stripe pricing for card charges (2.9% + 30¢). Used to ESTIMATE
// processing fees on Stripe-collected money only — cash / move-day money has no
// processor fee. Real fees come from Stripe payouts; this is the planning number.
export const STRIPE_PCT = 0.029
export const STRIPE_FLAT_CENTS = 30

/** cents -> "$1,234.56" (always 2 dp, thousands separators). */
export function fmtCents(cents: number | null | undefined): string {
  const n = Math.round(cents ?? 0) / 100
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** "700" | "700.5" | "$1,200.00" -> integer cents (70000 / 70050 / 120000).
 *  Returns null when the input isn't a parseable non-negative number. */
export function dollarsToCents(input: string | number | null | undefined): number | null {
  if (input == null) return null
  const s = String(input).replace(/[$,\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

/** Estimated Stripe processing fee for one captured card charge (2.9% + 30¢).
 *  Charged on the ORIGINAL capture: Stripe does not return processing fees when
 *  a charge is refunded, so a refunded job legitimately ends up fee-negative. */
export function stripeFeeCents(chargeCents: number): number {
  if (chargeCents <= 0) return 0
  return Math.round(chargeCents * STRIPE_PCT) + STRIPE_FLAT_CENTS
}

// ── Crew pay ────────────────────────────────────────────────────────────────

export interface CrewPayInput {
  actualHours?: number | null
  scheduledHours?: number | null
  payRate?: number | null // cents/hour — the JobCrew per-job override
  userPayRate?: number | null // cents/hour — the worker's default rate
  flatPay?: number | null // cents — a flat job rate; wins over hourly when set
  tips?: number | null // cents
  bonus?: number | null // cents
  deductions?: number | null // cents
}

/** Amount owed to ONE crew member for ONE job, in cents.
 *  flatPay wins over hourly; hours fall back to scheduled when actual isn't
 *  logged yet; the rate falls back to the worker's default. tips + bonus add,
 *  deductions subtract, never below zero.
 *
 *  NOTE: a result of 0 does NOT mean labor was free — it usually means no
 *  labor data exists at all. Use financial-completeness.ts to tell the two
 *  apart before showing a profit figure. */
export function crewPayOwedCents(c: CrewPayInput): number {
  const base =
    c.flatPay != null && c.flatPay > 0
      ? c.flatPay
      : Math.round((c.actualHours ?? c.scheduledHours ?? 0) * (c.payRate ?? c.userPayRate ?? 0))
  const owed = base + (c.tips ?? 0) + (c.bonus ?? 0) - (c.deductions ?? 0)
  return Math.max(0, Math.round(owed))
}

/** Total accrued labor for a set of crew rows (paid or not). */
export function crewLaborCents(crew: (CrewPayInput & CrewRow)[]): number {
  return crew.reduce((s, c) => s + crewPayOwedCents({ ...c, userPayRate: c.userPayRate ?? c.user?.payRate }), 0)
}

/** Labor already settled in cash — money that has LEFT the business. */
export function paidLaborCents(crew: (CrewPayInput & CrewRow)[]): number {
  return crewLaborCents(crew.filter(isPaidCrew))
}

/** Labor accrued but not yet paid — an obligation, still inside the cash. */
export function unpaidLaborCents(crew: (CrewPayInput & CrewRow)[]): number {
  return crewLaborCents(crew.filter(isUnpaidCrew))
}

// ── Per-job profit ───────────────────────────────────────────────────────────

export interface JobMoneyInput {
  payments: (PaymentRow & { isStripe?: boolean })[]
  crew: CrewPayInput[]
  expenses: ExpenseRow[] // job-linked Expense rows (any category)
}

export interface JobProfit {
  /** Captured money before refunds. */
  grossCapturedCents: number
  /** Actually refunded (from Payment.refundedAmountCents), NOT the face value. */
  refundedCents: number
  /** Money withdrawn by lost chargebacks. */
  chargebackCents: number
  /** THE revenue figure: gross − refunds − chargebacks. Never negative. */
  netRevenueCents: number
  /** Captured money at risk in an open dispute (not yet deducted). */
  pendingDisputeCents: number
  /** Authorized holds that were never captured. NOT revenue. */
  authorizedNotCapturedCents: number
  crewPayCents: number // sum of crew owed (0 usually means "not recorded")
  expenseCents: number // eligible job-linked expenses (REJECTED excluded)
  stripeFeeCents: number // estimated Stripe fees on Stripe-captured money
  totalCostsCents: number // crew + expenses + stripe  (refunds are NOT here)
  netProfitCents: number // netRevenue − totalCosts (can be negative)
  marginPct: number | null // netProfit / netRevenue; null when no revenue yet
}

export function computeJobProfit(input: JobMoneyInput): JobProfit {
  const rev = summarizeRevenue(input.payments)

  // Processing fees follow the CAPTURE, not the net: Stripe keeps its fee on a
  // refunded charge. Only rows that actually went through Stripe are charged.
  const stripeFeesCents = input.payments
    .filter((p) => p.isStripe && !p.isInternalTest)
    .filter((p) => ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))
    .reduce((s, p) => s + stripeFeeCents(p.amount), 0)

  const crewPayCents = input.crew.reduce((s, c) => s + crewPayOwedCents(c), 0)
  const expenseCents = eligibleExpenseCents(input.expenses)

  const totalCostsCents = crewPayCents + expenseCents + stripeFeesCents
  const netProfitCents = rev.netCollectedCents - totalCostsCents
  const marginPct = rev.netCollectedCents > 0 ? netProfitCents / rev.netCollectedCents : null

  return {
    grossCapturedCents: rev.grossCapturedCents,
    refundedCents: rev.refundedCents,
    chargebackCents: rev.chargebackCents,
    netRevenueCents: rev.netCollectedCents,
    pendingDisputeCents: rev.pendingDisputeCents,
    authorizedNotCapturedCents: rev.authorizedNotCapturedCents,
    crewPayCents,
    expenseCents,
    stripeFeeCents: stripeFeesCents,
    totalCostsCents,
    netProfitCents,
    marginPct,
  }
}

/** True when a payment row represents Stripe-collected money (has a processor
 *  id), vs. a manually-recorded cash / move-day payment. */
export function isStripePayment(p: { stripePaymentIntentId?: string | null; stripeChargeId?: string | null }): boolean {
  return !!(p.stripePaymentIntentId || p.stripeChargeId)
}

// ── Distributable owner cash (Owner Money page) ──────────────────────────────
// Business cash is NOT all splittable. Hold back what's already owed + reserves
// before showing a "safe to distribute" number.
//
// PHASE 0 CORRECTION: paid labor now leaves cash exactly once (inside
// cashAvailableCents, via estimateBusinessCash) and unpaid labor is held back
// here — a crew row is one or the other, never both, so double-subtraction is
// structurally impossible. Owner reimbursements owed and money at risk in open
// disputes are also held back. The result may be NEGATIVE and is reported as a
// shortfall rather than silently clamped to zero.

export interface DistributableInput {
  cashAvailableCents: number // money actually in the business (paid labor already out)
  unpaidLaborCents: number // accrued crew labor not yet settled
  upcomingBillsCents: number // known unpaid general expenses
  ownerReimbursementsOwedCents: number // personal purchases awaiting reimbursement
  pendingRefundCents: number // captured money at risk in an open dispute
  taxReserveCents: number // held for taxes
  emergencyReserveCents: number // rainy-day floor
}

export interface DistributablePosition {
  /** Signed result. Negative means obligations exceed cash. */
  rawCents: number
  /** What may actually be distributed today (never negative). */
  distributableCents: number
  /** How far short the business is when raw is negative. */
  shortfallCents: number
  /** Everything held back, for the "what's included" explanation. */
  totalHeldBackCents: number
}

/** Full distributable position, including a negative shortfall. */
export function distributablePosition(i: DistributableInput): DistributablePosition {
  const totalHeldBackCents =
    i.unpaidLaborCents +
    i.upcomingBillsCents +
    i.ownerReimbursementsOwedCents +
    i.pendingRefundCents +
    i.taxReserveCents +
    i.emergencyReserveCents
  const rawCents = i.cashAvailableCents - totalHeldBackCents
  return {
    rawCents,
    distributableCents: Math.max(0, rawCents),
    shortfallCents: Math.max(0, -rawCents),
    totalHeldBackCents,
  }
}

/** Signed safe-to-distribute. Callers that display it must handle the negative
 *  case (see distributablePosition) — a shortfall must never read as $0 "fine". */
export function safeToDistributeCents(i: DistributableInput): number {
  return distributablePosition(i).rawCents
}

/** Tax reserve on an operating-profit base, not on revenue-minus-expenses.
 *  Labor is a cost like any other; ignoring it inflated the reserve. Never
 *  negative — a loss-making period reserves nothing. */
export function taxReserveCentsFor(operatingProfitCents: number, taxPercent: number): number {
  if (operatingProfitCents <= 0) return 0
  return Math.max(0, Math.round(operatingProfitCents * (taxPercent / 100)))
}
