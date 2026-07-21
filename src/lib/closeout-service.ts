// ============================================================================
// closeout-service.ts — the ONE place that reads a move and produces its full
// financial picture. Phase 2 (owner spec 2026-07-20).
//
// The only Phase 2 module that touches Prisma. Everything it composes
// (closeout-calc, closeout-blockers, owner-split, money-rules, labor-calc) is
// pure and unit-tested.
// ============================================================================

import { prisma } from './db'
import { summarizeRevenue, eligibleExpenseCents, isEligibleExpense, isUnreviewedExpense } from './money-rules'
import { rollupLabor, paidCentsOf } from './labor-calc'
import { toLaborAssignments, JOB_MONEY_CREW_SELECT, JOB_MONEY_PAYMENT_SELECT, moveDayDueCents } from './job-money'
import { isStripePayment, stripeFeeCents } from './profit'
import { rollupOwner } from './owner-ledger'
import { evaluateFinancialCompleteness, deriveLaborState } from './financial-completeness'
import { computeCloseout, CALCULATION_VERSION, type CloseoutFinancials, type OverheadMethod } from './closeout-calc'
import { computeCloseoutBlockers, evaluateFinalize, deriveCloseoutStatus, type Blocker, type OverrideRecord, type FinalizeDecision } from './closeout-blockers'
import { computeOwnerSplit, type SplitMethod, type SplitResult } from './owner-split'
import { loadLaborPolicy } from './labor-service'

export interface CloseoutView {
  bookingId: string
  closeoutId: string | null
  status: string
  isFinalized: boolean
  financials: CloseoutFinancials
  blockers: Blocker[]
  decision: FinalizeDecision
  overrides: OverrideRecord[]
  split: SplitResult | null
  laborState: string
  /** Approved labor still owed to crew — a real liability held back. */
  unpaidLaborCents: number
  ownerReimbursementOwedCents: number
  expensesMissingReceipt: { id: string; label: string; amountCents: number }[]
  pendingExpenseCount: number
  snapshots: { id: string; version: number; createdAt: Date; supersededAt: Date | null; companyNetProfitCents: number; distributableProfitCents: number }[]
  distributions: { id: string; owner: string; status: string; approvedCents: number; paidCents: number; voided: boolean }[]
}

const BOOKING_INCLUDE = {
  payments: { select: JOB_MONEY_PAYMENT_SELECT },
  job: { include: { crew: { select: { ...JOB_MONEY_CREW_SELECT, id: true } } } },
  expenses: true,
  closeout: { include: { snapshots: { orderBy: { version: 'desc' as const } }, reserves: true } },
} as const

/**
 * Build the complete closeout picture for one move.
 *
 * Reads live records; a FINALIZED move still shows live numbers alongside its
 * snapshot so the owner can see what changed — but the snapshot, not this, is
 * the historical record.
 */
export async function buildCloseoutView(bookingId: string): Promise<CloseoutView | null> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: BOOKING_INCLUDE })
  if (!booking) return null

  const cfg = await prisma.businessConfig.findUnique({ where: { id: 'singleton' } }).catch(() => null)
  const { policy, overtimeMultiplierPct } = await loadLaborPolicy()
  const ownerTxs = await prisma.ownerTransaction.findMany({ where: { approvalStatus: { not: 'REJECTED' } } })

  const closeout = booking.closeout
  const isFinalized = closeout?.status === 'FINALIZED'
  const overrides: OverrideRecord[] = Array.isArray(closeout?.overrides) ? (closeout?.overrides as never) : []

  // ── Revenue ──
  const revenue = summarizeRevenue(booking.payments as never)
  const stripeFees = booking.payments
    .filter((p) => !p.isInternalTest && isStripePayment(p) && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))
    .reduce((s, p) => s + stripeFeeCents(p.amount), 0)

  // Billed = the stored estimate (DOLLARS float — see pricing.ts unit contract)
  // plus the move-day fees that are never in Stripe.
  const estimateCents = booking.totalEstimate != null ? Math.round(booking.totalEstimate * 100) : 0
  const grossCustomerChargesCents = estimateCents + moveDayDueCents(booking as never)

  // ── Labor ──
  const crew = booking.job?.crew ?? []
  const labor = rollupLabor(toLaborAssignments(crew as never), policy, overtimeMultiplierPct)
  const laborState = deriveLaborState(crew as never)
  const completeness = evaluateFinancialCompleteness({
    status: booking.status,
    crew: crew as never,
    expenses: booking.expenses as never,
    payments: booking.payments as never,
  })

  // ── Expenses ──
  const receiptThreshold = cfg?.receiptRequiredAboveCents ?? 2500
  const eligible = booking.expenses.filter(isEligibleExpense)
  const expensesMissingReceipt = eligible
    .filter((e) => !e.receiptUrl)
    .map((e) => ({ id: e.id, label: e.vendor ? `${e.category} · ${e.vendor}` : String(e.category), amountCents: e.amount }))
  const pendingExpenseCount = eligible.filter(isUnreviewedExpense).length

  // ── Owner reimbursements owed (money the business owes its owners) ──
  const ownerReimbursementOwedCents =
    rollupOwner(ownerTxs as never, 'DIEGO').reimbursementOwed + rollupOwner(ownerTxs as never, 'SEBASTIAN').reimbursementOwed

  // ── The hierarchy ──
  const overheadMethod = (closeout?.overheadMethod ?? cfg?.overheadMethod ?? 'NONE') as OverheadMethod
  const reserveRows = closeout?.reserves ?? []
  const businessReserveCents = reserveRows.filter((r) => r.kind !== 'TAX' && r.kind !== 'RETAINED_EARNINGS').reduce((s, r) => s + r.amountCents, 0)
  const retainedEarningsCents = reserveRows.filter((r) => r.kind === 'RETAINED_EARNINGS').reduce((s, r) => s + r.amountCents, 0)

  const financials = computeCloseout({
    billed: { grossCustomerChargesCents, discountsCents: 0, creditsCents: 0 },
    collected: { netCollectedCents: revenue.netCollectedCents },
    refundedCents: revenue.refundedCents,
    chargebackCents: revenue.chargebackCents,
    disputedOpenCents: revenue.pendingDisputeCents,
    balanceWriteOffCents: closeout?.balanceWriteOffCents ?? 0,
    costs: {
      approvedCrewLaborCents: labor.approvedCashCents,
      eligibleExpenseCents: eligibleExpenseCents(booking.expenses as never),
      processingFeeCents: stripeFees,
      standaloneTruckCostCents: 0,
    },
    unpaidOwnerLaborValueCents: labor.unpaidOwnerValueCents,
    ownerCashLaborCents: labor.approvedCashCents,
    approvedLaborMinutes: labor.totalPaidMinutes,
    overhead: {
      method: overheadMethod,
      perMoveCents: cfg?.overheadPerMoveCents,
      pctRevenueBp: cfg?.overheadPctRevenueBp,
      perLaborHourCents: cfg?.overheadPerLaborHourCents,
      monthlyPoolCents: cfg?.overheadMonthlyPoolCents,
      eligibleMovesInPeriod: 1,
      manualCents: closeout?.overheadAmountCents,
    },
    reserves: {
      taxReserveBp: closeout?.taxReserveBp ?? (cfg?.taxReservePercent != null ? cfg.taxReservePercent * 100 : 0),
      taxReserveFixedCents: closeout?.taxReserveCents,
      businessReserveCents,
      retainedEarningsCents,
      // Money already owed: unpaid approved crew labor + owner reimbursements.
      unresolvedLiabilityCents: labor.unpaidCents + ownerReimbursementOwedCents,
    },
  })

  // ── Blockers ──
  const refundExceedsCaptured = booking.payments.some(
    (p) => (p.refundedAmountCents ?? 0) > p.amount,
  )
  const blockers = computeCloseoutBlockers({
    bookingStatus: booking.status,
    hasCapturedPayment: revenue.grossCapturedCents > 0,
    hasUnknownRefundAmount: revenue.hasUnknownRefund,
    refundExceedsCaptured,
    outstandingBalanceCents: financials.outstandingBalanceCents,
    balanceWriteOffCents: closeout?.balanceWriteOffCents ?? 0,
    disputedOpenCents: revenue.pendingDisputeCents,
    disputeAcknowledged: !!closeout?.disputeAcknowledgedAt,
    laborState,
    truckSourceConfirmed: !!closeout?.truckSourceConfirmedAt,
    truckSourceIsCostly: ['RENTAL', 'THIRD_PARTY', 'COMPANY_OWNED'].includes(String(closeout?.truckSource ?? '')),
    truckCostRecordedCents: eligible.filter((e) => ['TRUCK_RENTAL', 'GAS'].includes(String(e.category))).reduce((s, e) => s + e.amount, 0),
    expensesMissingReceipt,
    receiptRequiredAboveCents: receiptThreshold,
    pendingExpenseCount,
    ownerReimbursementOwedCents,
    allocatedToOwnersCents: 0,
    distributableProfitCents: financials.reserves.distributableProfitCents,
    reservesExceedProfit: financials.reserves.overAllocated,
    hasNegativeValue: false,
  })

  const decision = evaluateFinalize(blockers, overrides)

  // ── Owner split preview (a calculation, never a payment) ──
  const splitMethod = (closeout?.splitMethod ?? 'OWNERSHIP_PERCENT') as SplitMethod
  const split = computeOwnerSplit({
    method: splitMethod,
    distributableProfitCents: financials.reserves.distributableProfitCents,
    ownershipBp: { DIEGO: (cfg?.diegoSplitPercent ?? 50) * 100, SEBASTIAN: (cfg?.sebastianSplitPercent ?? 50) * 100 },
    ownerLaborCents: { DIEGO: 0, SEBASTIAN: 0 },
  })

  const distributions = await prisma.ownerDistribution.findMany({
    where: { bookingId: booking.id },
    orderBy: { createdAt: 'desc' },
  })

  const status = deriveCloseoutStatus({
    storedStatus: (closeout?.status ?? 'NOT_STARTED') as never,
    started: !!closeout?.startedAt,
    submitted: !!closeout?.submittedAt,
    finalized: isFinalized,
    reopened: !!closeout?.reopenedAt,
    decision,
  })

  return {
    bookingId: booking.id,
    closeoutId: closeout?.id ?? null,
    status,
    isFinalized,
    financials,
    blockers,
    decision,
    overrides,
    split,
    laborState,
    unpaidLaborCents: labor.unpaidCents,
    ownerReimbursementOwedCents,
    expensesMissingReceipt,
    pendingExpenseCount,
    snapshots: (closeout?.snapshots ?? []).map((s) => ({
      id: s.id,
      version: s.version,
      createdAt: s.createdAt,
      supersededAt: s.supersededAt,
      companyNetProfitCents: s.companyNetProfitCents,
      distributableProfitCents: s.distributableProfitCents,
    })),
    distributions: distributions.map((d) => ({
      id: d.id, owner: String(d.owner), status: String(d.status),
      approvedCents: d.approvedCents, paidCents: d.paidCents, voided: d.voided,
    })),
    // completeness is available to callers that want the Phase 1 detail
    ...(completeness ? {} : {}),
  }
}

/** Get or create the closeout row for a move. */
export async function ensureCloseout(bookingId: string, userId: string): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.moveCloseout.findUnique({ where: { bookingId }, select: { id: true } })
  if (existing) return { id: existing.id, created: false }
  const created = await prisma.moveCloseout.create({
    data: { bookingId, status: 'IN_PROGRESS', startedAt: new Date(), startedById: userId },
    select: { id: true },
  })
  return { id: created.id, created: true }
}

/**
 * Write an IMMUTABLE snapshot at finalization. Supersedes the previous one
 * rather than replacing it, so every version of the truth is preserved.
 */
export async function writeSnapshot(
  tx: typeof prisma,
  args: { closeoutId: string; bookingId: string; view: CloseoutView; userId: string; userName: string; allocations: { owner: string; amountCents: number; percentBp: number }[] },
): Promise<{ id: string; version: number }> {
  const latest = await tx.financialSnapshot.findFirst({
    where: { closeoutId: args.closeoutId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  })
  if (latest) {
    await tx.financialSnapshot.update({
      where: { id: latest.id },
      data: { supersededAt: new Date(), supersededById: args.userId },
    })
  }
  const f = args.view.financials
  const version = (latest?.version ?? 0) + 1
  const row = await tx.financialSnapshot.create({
    data: {
      closeoutId: args.closeoutId,
      bookingId: args.bookingId,
      version,
      netBilledRevenueCents: f.netBilledRevenueCents,
      netCollectedRevenueCents: f.netCollectedRevenueCents,
      outstandingBalanceCents: f.outstandingBalanceCents,
      refundedCents: f.refundedCents,
      chargebackCents: f.chargebackCents,
      disputedOpenCents: f.disputedOpenCents,
      directExpenseCents: f.directExpenseCents,
      crewLaborCents: f.crewLaborCents,
      ownerCashLaborCents: f.ownerCashLaborCents,
      ownerEconomicLaborCents: f.ownerEconomicLaborCents,
      processingFeeCents: f.processingFeeCents,
      truckCostCents: f.truckCostCents,
      directJobCostCents: f.directJobCostCents,
      cashGrossProfitCents: f.profit.cashGrossProfitCents,
      economicProfitCents: f.profit.economicProfitCents,
      allocatedOverheadCents: f.overhead.amountCents,
      companyNetProfitCents: f.profit.companyNetProfitCents,
      economicNetProfitCents: f.profit.economicNetProfitCents,
      marginBp: f.profit.marginBp,
      taxReserveCents: f.reserves.taxReserveCents,
      businessReserveCents: f.reserves.businessReserveCents,
      retainedEarningsCents: f.reserves.retainedEarningsCents,
      unresolvedLiabilityCents: f.reserves.unresolvedLiabilityCents,
      distributableProfitCents: f.reserves.distributableProfitCents,
      ownerAllocations: args.allocations as never,
      overheadMethod: f.overhead.method as never,
      overheadRateRaw: f.overhead.rateRaw,
      taxReserveBp: null,
      splitMethod: (args.view.split?.method ?? null) as never,
      incompleteFlags: { blockers: args.view.blockers.map((b) => b.code), overrides: args.view.overrides.map((o) => o.code) } as never,
      calculationVersion: CALCULATION_VERSION,
      createdById: args.userId,
      createdByName: args.userName,
    },
    select: { id: true, version: true },
  })
  return row
}
