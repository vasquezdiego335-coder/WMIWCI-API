// Per-job money + attention flags for the admin operating system (owner spec
// 2026-07-13). Bridges Prisma booking rows to the pure math in profit.ts, and
// centralizes the "what's still owed on move day" + "what needs attention"
// logic so the Jobs list and the job-detail Profit card agree exactly.

import { effectiveWaitingFeeCents } from './waiting-time'
import { summarizeRevenue } from './money-rules'
import { computeJobProfit, isStripePayment, type JobProfit } from './profit'
import { evaluateFinancialCompleteness, type FinancialCompleteness } from './financial-completeness'
import { rollupLabor, paidCentsOf, type RollupAssignment, type LaborRollup } from './labor-calc'
import { DEFAULT_TIME_POLICY, type TimePolicy } from './labor-time'

/** Map Prisma JobCrew rows to the labor calculator's shape. ONE place, so a
 *  forgotten field cannot silently change a move's labor cost. */
export function toLaborAssignments(crew: JobCrewShape[]): RollupAssignment[] {
  return crew.map((c) => ({
    workerType: (c.workerType ?? undefined) as never,
    payModel: (c.payModel ?? undefined) as never,
    assignmentStatus: (c.assignmentStatus ?? undefined) as never,
    approvalStatus: (c.approvalStatus ?? undefined) as never,
    paymentStatus: (c.paymentStatus ?? undefined) as never,
    clockIn: c.clockIn ?? null,
    clockOut: c.clockOut ?? null,
    workedMinutes: c.workedMinutes ?? null,
    actualBreakMinutes: c.actualBreakMinutes ?? null,
    travelMinutes: c.travelMinutes ?? null,
    travelPayPolicy: (c.travelPayPolicy ?? undefined) as never,
    hourlyRateCentsSnapshot: c.hourlyRateCentsSnapshot ?? null,
    overtimeRateCentsSnapshot: c.overtimeRateCentsSnapshot ?? null,
    flatPayCentsSnapshot: c.flatPayCentsSnapshot ?? null,
    dayRateCentsSnapshot: c.dayRateCentsSnapshot ?? null,
    travelRateCentsSnapshot: c.travelRateCentsSnapshot ?? null,
    economicRateCentsSnapshot: c.economicRateCentsSnapshot ?? null,
    driverBonusCentsSnapshot: c.driverBonusCentsSnapshot ?? null,
    crewLeaderBonusCentsSnapshot: c.crewLeaderBonusCentsSnapshot ?? null,
    otherBonusCents: c.otherBonusCents ?? null,
    reimbursementCents: c.reimbursementCents ?? null,
    approvedPayCents: c.approvedPayCents ?? null,
    zeroLaborConfirmed: c.zeroLaborConfirmed ?? null,
    // legacy
    legacyPayRate: c.payRate ?? null,
    legacyFlatPay: c.flatPay ?? null,
    legacyActualHours: c.actualHours ?? null,
    legacyScheduledHours: c.scheduledHours ?? null,
    legacyTips: c.tips ?? null,
    legacyBonus: c.bonus ?? null,
    legacyDeductions: c.deductions ?? null,
    userProfilePayRate: c.user?.payRate ?? null,
    paidCents: paidCentsOf(c.laborPayments ?? []),
  }))
}

/** The canonical labor rollup for ONE move. THE labor number — profit, cash and
 *  completeness all read this, and nothing reads `crew_jobs`. */
export function jobLabor(b: BookingMoneyShape, policy: TimePolicy = DEFAULT_TIME_POLICY, otMultiplierPct = 150): LaborRollup {
  return rollupLabor(toLaborAssignments(b.job?.crew ?? []), policy, otMultiplierPct)
}

export interface BookingMoneyShape {
  status: string
  /** DOLLARS (pricing.ts unit contract) — base labor + access add-ons + travel. */
  totalEstimate?: number | null
  /** DOLLARS — flat move-size labor price. Fallback when totalEstimate is null. */
  baseRate?: number | null
  /** CENTS — the Stripe deposit ($49), applied against the total. */
  depositAmount?: number | null
  /** Whole percent off the quote (10 = 10%). Stored at booking/approval time. */
  discountPercent?: number | null
  truckAddonAmount?: number | null
  truckAddonDueOnMoveDay?: boolean | null
  travelFee?: number | null
  additionalTruckFees?: number | null
  stairFee?: number | null
  longCarryFee?: number | null
  heavyItemFee?: number | null
  packingFee?: number | null
  assemblyFee?: number | null
  disassemblyFee?: number | null
  taxAmount?: number | null
  // waiting fields consumed by effectiveWaitingFeeCents
  waitingFee?: number | null
  waitingFeeOverride?: number | null
  waitingFeeWaived?: boolean | null
  crewArrivedAt?: Date | null
  customerReadyAt?: Date | null
  waitingStartedAt?: Date | null
  waitingEndedAt?: Date | null
  originAddress?: string | null
  destAddress?: string | null
  truckProvider?: string | null
  truckReservationStatus?: string | null
  truckReservationNumber?: string | null
  payments: {
    amount: number
    status: string
    isInternalTest?: boolean | null
    stripePaymentIntentId?: string | null
    stripeChargeId?: string | null
    // Phase 0: the REAL refunded amount + dispute state drive net revenue.
    // A page that forgets to select these under-reports refunds, so
    // JOB_MONEY_PAYMENT_SELECT below is the one blessed selection.
    refundedAmountCents?: number | null
    stripeDisputeId?: string | null
    disputeStatus?: string | null
  }[]
  job?: { crew: JobCrewShape[] } | null
  expenses?: { amount: number; status: string }[]
}

/** THE Prisma `select` for payments feeding job money. Use this everywhere so
 *  no surface silently drops the refund/dispute columns. */
export const JOB_MONEY_PAYMENT_SELECT = {
  amount: true,
  status: true,
  isInternalTest: true,
  stripePaymentIntentId: true,
  stripeChargeId: true,
  refundedAmountCents: true,
  stripeDisputeId: true,
  disputeStatus: true,
} as const

/** THE Prisma `select` for job-linked expenses (status is required so rejected
 *  rows can be excluded by money-rules, not by an ad-hoc page filter). */
export const JOB_MONEY_EXPENSE_SELECT = { amount: true, status: true } as const

export interface JobCrewShape {
  actualHours?: number | null
  scheduledHours?: number | null
  payRate?: number | null
  flatPay?: number | null
  tips?: number | null
  bonus?: number | null
  deductions?: number | null
  payStatus?: string | null
  user?: { payRate?: number | null } | null
  // ── PHASE 1 canonical labor columns ──
  workerType?: string | null
  role?: string | null
  payModel?: string | null
  assignmentStatus?: string | null
  approvalStatus?: string | null
  paymentStatus?: string | null
  clockIn?: Date | null
  clockOut?: Date | null
  workedMinutes?: number | null
  actualBreakMinutes?: number | null
  travelMinutes?: number | null
  travelPayPolicy?: string | null
  hourlyRateCentsSnapshot?: number | null
  overtimeRateCentsSnapshot?: number | null
  flatPayCentsSnapshot?: number | null
  dayRateCentsSnapshot?: number | null
  travelRateCentsSnapshot?: number | null
  economicRateCentsSnapshot?: number | null
  driverBonusCentsSnapshot?: number | null
  crewLeaderBonusCentsSnapshot?: number | null
  otherBonusCents?: number | null
  reimbursementCents?: number | null
  approvedPayCents?: number | null
  zeroLaborConfirmed?: boolean | null
  laborPayments?: { amountCents: number; voided?: boolean | null }[]
}

/** THE Prisma `select` for crew rows feeding job money. Every money surface uses
 *  it, so no page can silently drop a rate snapshot and mis-price a move. */
export const JOB_MONEY_CREW_SELECT = {
  id: true,
  userId: true,
  workerType: true,
  role: true,
  payModel: true,
  assignmentStatus: true,
  approvalStatus: true,
  paymentStatus: true,
  payStatus: true,
  clockIn: true,
  clockOut: true,
  workedMinutes: true,
  regularMinutes: true,
  overtimeMinutes: true,
  paidMinutes: true,
  actualBreakMinutes: true,
  travelMinutes: true,
  travelPayPolicy: true,
  hourlyRateCentsSnapshot: true,
  overtimeRateCentsSnapshot: true,
  flatPayCentsSnapshot: true,
  dayRateCentsSnapshot: true,
  travelRateCentsSnapshot: true,
  economicRateCentsSnapshot: true,
  driverBonusCentsSnapshot: true,
  crewLeaderBonusCentsSnapshot: true,
  otherBonusCents: true,
  reimbursementCents: true,
  approvedPayCents: true,
  zeroLaborConfirmed: true,
  // legacy columns, for rows that predate the labor system
  actualHours: true,
  scheduledHours: true,
  payRate: true,
  flatPay: true,
  tips: true,
  bonus: true,
  deductions: true,
  laborPayments: { select: { amountCents: true, voided: true } },
  user: { select: { name: true, payRate: true } },
} as const

// ── THE customer balance ────────────────────────────────────────────────────
//
// One model, one formula, every surface. Before this existed, the job page, the
// jobs list, the dashboard KPI and the Action Center reminder each summed a bag
// of fee columns and called the result "due on move day" — which silently
// EXCLUDED the unpaid base-service balance. A $409 move with a $49 deposit
// reported "$100 due" when the customer owed $460.
//
//   quoted (Booking.totalEstimate: base labor + access add-ons + travel)
//   + additional charges (everything NOT already inside the quote)
//   − discount
//   = final billed
//   − collected (captured − refunds − lost chargebacks)
//   = outstanding
//
// The ONLY money Stripe ever takes is the $49 deposit, so the entire
// outstanding balance is settled on move day. "Due on move day" and
// "outstanding" are the same number by construction — they can no longer drift.

/**
 * Charges that are NOT already inside `Booking.totalEstimate`.
 *
 * The travel fee is deliberately absent: `estimate.ts` folds it into
 * `estimatedTotal`, so counting it here would bill it twice (it did — the
 * closeout's billed revenue was over by exactly the travel fee).
 */
export function additionalChargeCents(b: BookingMoneyShape): number {
  return (
    (b.truckAddonDueOnMoveDay === false ? 0 : (b.truckAddonAmount ?? 0)) +
    (b.additionalTruckFees ?? 0) +
    effectiveWaitingFeeCents(b) +
    (b.stairFee ?? 0) +
    (b.longCarryFee ?? 0) +
    (b.heavyItemFee ?? 0) +
    (b.packingFee ?? 0) +
    (b.assemblyFee ?? 0) +
    (b.disassemblyFee ?? 0) +
    (b.taxAmount ?? 0)
  )
}

export interface CustomerBalance {
  /** The quote the customer accepted (base + access add-ons + travel). */
  quotedCents: number
  /** Approved charges added on top of the quote (truck, waiting, itemized). */
  additionalChargeCents: number
  /** Percentage discount applied to the quote + additional charges. */
  discountCents: number
  /** quoted + additional − discount. An entitlement, never cash. */
  finalBilledCents: number
  /** Captured − refunds − lost chargebacks. Real money in the bank. */
  collectedCents: number
  refundedCents: number
  /** Authorized but not captured — never counted as collected. */
  authorizedNotCapturedCents: number
  /** finalBilled − collected. What the customer still owes. */
  outstandingCents: number
  /**
   * The whole outstanding balance: Stripe only ever holds the $49 deposit, so
   * everything still owed is collected in person on move day.
   */
  dueOnMoveDayCents: number
  /** Of the outstanding balance, the part that is not the base quote. */
  moveDayFeeCents: number
  /** No quote is stored — the balance is a floor, not the full amount. */
  quoteMissing: boolean
}

/**
 * THE customer balance for one move. Every surface that shows an amount owed
 * must originate it here rather than re-summing fee columns.
 */
export function customerBalance(b: BookingMoneyShape): CustomerBalance {
  // totalEstimate is DOLLARS (pricing.ts unit contract); everything else CENTS.
  const quoteMissing = b.totalEstimate == null
  const quotedCents = quoteMissing
    // Legacy / "need a quote" rows: rebuild the quote from its parts so the
    // base labor is still billed rather than silently dropped.
    ? Math.round((b.baseRate ?? 0) * 100) + (b.travelFee ?? 0)
    : Math.round((b.totalEstimate ?? 0) * 100)

  const additional = additionalChargeCents(b)
  const pct = b.discountPercent ?? 0
  const discountCents = pct > 0 ? Math.round(((quotedCents + additional) * pct) / 100) : 0
  const finalBilledCents = Math.max(0, quotedCents + additional - discountCents)

  const revenue = summarizeRevenue(b.payments as never)
  const outstandingCents = Math.max(0, finalBilledCents - revenue.netCollectedCents)

  return {
    quotedCents,
    additionalChargeCents: additional,
    discountCents,
    finalBilledCents,
    collectedCents: revenue.netCollectedCents,
    refundedCents: revenue.refundedCents,
    authorizedNotCapturedCents: revenue.authorizedNotCapturedCents,
    outstandingCents,
    dueOnMoveDayCents: outstandingCents,
    moveDayFeeCents: Math.min(additional, outstandingCents),
    quoteMissing,
  }
}

/** Recorded per-job profit: NET collected revenue (captured − refunds −
 *  chargebacks) − crew pay − eligible job expenses − Stripe fees.
 *  Reflects money actually recorded as Payment rows + logged crew pay/expenses;
 *  move-day cash only counts once it's recorded via "Record payment".
 *
 *  A crewPayCents of 0 almost always means labor was never recorded, NOT that
 *  it was free — always pair this with jobFinancialCompleteness() before
 *  presenting the number. */
export function jobProfit(b: BookingMoneyShape, policy: TimePolicy = DEFAULT_TIME_POLICY, otMultiplierPct = 150): JobProfit {
  const labor = jobLabor(b, policy, otMultiplierPct)
  return computeJobProfit({
    payments: b.payments.map((p) => ({
      amount: p.amount,
      status: p.status,
      isInternalTest: !!p.isInternalTest,
      refundedAmountCents: p.refundedAmountCents ?? null,
      stripeDisputeId: p.stripeDisputeId ?? null,
      disputeStatus: p.disputeStatus ?? null,
      isStripe: isStripePayment(p),
    })),
    // Legacy path retained for rows without a rate snapshot; the `labor` rollup
    // below supersedes it whenever crew rows exist.
    crew: (b.job?.crew ?? []).map((c) => ({
      actualHours: c.actualHours,
      scheduledHours: c.scheduledHours,
      payRate: c.payRate,
      userPayRate: c.user?.payRate,
      flatPay: c.flatPay,
      tips: c.tips,
      bonus: c.bonus,
      deductions: c.deductions,
    })),
    labor: {
      approvedCashCents: labor.approvedCashCents,
      pendingCashCents: labor.pendingCashCents,
      economicCents: labor.economicCents,
      unpaidOwnerValueCents: labor.unpaidOwnerValueCents,
    },
    expenses: (b.expenses ?? []).map((e) => ({ amount: e.amount, status: e.status })),
  })
}

/** What is still missing from this move's financial record. Every surface that
 *  shows job profit must show this too — see docs/admin/phase0-financial-integrity.md. */
export function jobFinancialCompleteness(b: BookingMoneyShape): FinancialCompleteness {
  return evaluateFinancialCompleteness({
    status: b.status,
    crew: b.job?.crew ?? [],
    expenses: b.expenses ?? [],
    payments: b.payments.map((p) => ({
      amount: p.amount,
      status: p.status,
      isInternalTest: !!p.isInternalTest,
      refundedAmountCents: p.refundedAmountCents ?? null,
      stripeDisputeId: p.stripeDisputeId ?? null,
      disputeStatus: p.disputeStatus ?? null,
    })),
  })
}

/** Attention flags shown on the job card / dashboard. Only surfaces on jobs
 *  where the flag actually matters (e.g. crew is only "incomplete" once a job is
 *  confirmed/scheduled/in-progress). */
export function jobWarnings(b: BookingMoneyShape): string[] {
  const w: string[] = []
  const live = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'].includes(b.status)

  if (!b.originAddress?.trim() || !b.destAddress?.trim()) {
    w.push('Missing pickup or drop-off address')
  }
  if (b.truckAddonDueOnMoveDay && b.truckReservationStatus !== 'reserved' && !b.truckReservationNumber) {
    w.push('Truck not confirmed')
  }
  const crewCount = b.job?.crew?.length ?? 0
  if (live && crewCount === 0) {
    w.push('Crew assignment incomplete')
  }
  const due = customerBalance(b).outstandingCents
  if (due > 0 && (b.status === 'COMPLETED' || b.status === 'IN_PROGRESS')) {
    w.push('Balance due after job')
  }
  return w
}

/** True when this crew member's pay is still owed (not yet marked PAID). */
export function crewUnpaid(c: JobCrewShape): boolean {
  return c.payStatus !== 'PAID'
}
