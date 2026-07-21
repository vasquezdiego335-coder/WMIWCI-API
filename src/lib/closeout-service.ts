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
import { toLaborAssignments, JOB_MONEY_CREW_SELECT, JOB_MONEY_PAYMENT_SELECT, customerBalance } from './job-money'
import { isStripePayment, stripeFeeCents } from './profit'
import { rollupOwner } from './owner-ledger'
import { evaluateFinancialCompleteness, deriveLaborState } from './financial-completeness'
import { computeCloseout, CALCULATION_VERSION, type CloseoutFinancials, type OverheadMethod } from './closeout-calc'
import { computeCloseoutBlockers, evaluateFinalize, deriveCloseoutStatus, type Blocker, type OverrideRecord, type FinalizeDecision } from './closeout-blockers'
import { computeOwnerSplit, type SplitMethod, type SplitResult } from './owner-split'
import { buildProfitAllocation, allocationFromSnapshot, type ProfitAllocationView, type AllocationBasis } from './profit-allocation'
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
  /**
   * THE owner-facing 40/30/30 view. Every surface renders this, never the raw
   * 50/50 split percentages.
   *
   * On a FINALIZED move this comes from the snapshot, not from live settings —
   * changing the policy today must not restate a closed move. `allocationBasis`
   * says which it is, and `liveAllocation` carries the live recomputation so
   * the owner can still see what changed since.
   */
  allocation: ProfitAllocationView
  allocationBasis: AllocationBasis
  /** Live recomputation. Equal to `allocation` on a move that is not finalized. */
  liveAllocation: ProfitAllocationView
  /** Version of the snapshot `allocation` came from; null when provisional. */
  allocationSnapshotVersion: number | null
  laborState: string
  /** Why the move was last reopened, if it has been. Shown against the version
   *  that superseded the one in force at the time. */
  reopenReason: string | null
  /** Approved labor still owed to crew — a real liability held back. */
  unpaidLaborCents: number
  ownerReimbursementOwedCents: number
  expensesMissingReceipt: { id: string; label: string; amountCents: number }[]
  pendingExpenseCount: number
  /** Newest first. Every entry carries its own FROZEN 40/30/30 view, so the
   *  history table never restates an old version with today's policy. */
  snapshots: {
    id: string
    version: number
    createdAt: Date
    supersededAt: Date | null
    companyNetProfitCents: number
    distributableProfitCents: number
    createdByName: string | null
    calculationVersion: string
    configSource: string | null
    configVersion: string | null
    allocation: ProfitAllocationView
    /** Change in company net profit against the previous version. */
    deltaFromPreviousCents: number | null
  }[]
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

  // Billed = the ONE customer-balance model (job-money.customerBalance): the
  // stored quote plus every approved charge that is NOT already inside it.
  // This used to be `estimate + moveDayDueCents`, which counted the travel fee
  // twice — estimate.ts folds travel INTO estimatedTotal.
  const balance = customerBalance(booking as never)
  const grossCustomerChargesCents = balance.quotedCents + balance.additionalChargeCents

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
    billed: { grossCustomerChargesCents, discountsCents: balance.discountCents, creditsCents: 0 },
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
      // D4 — the company-retained share (owner policy 2026-07-21: 40%).
      // SNAPSHOT on a finalized closeout so a later config change cannot
      // rewrite history; live config only for a move not yet finalized.
      businessRetainedBp: closeout?.businessRetainedBp ?? cfg?.generalReserveBp ?? 0,
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
    // D3 — only an internal-test booking may rehearse past NO_PAYMENT_DATA.
    isInternalTest: !!booking.isInternalTest,
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

  // THE owner-facing 40/30/30 view. Built once here so the closeout panel,
  // Owner Money, reports and exports can never disagree about the policy.
  const liveAllocation = buildProfitAllocation({
    companyNetProfitCents: financials.profit.companyNetProfitCents,
    businessRetainedCents: financials.reserves.businessRetainedCents,
    businessRetainedBp: financials.reserves.businessRetainedBp,
    distributableProfitCents: financials.reserves.distributableProfitCents,
    ownerShares: (split?.shares ?? []).map((sh) => ({ owner: sh.owner, amountCents: sh.amountCents, percentBp: sh.percentBp })),
  })

  // A FINALIZED move reads its snapshot. This is the difference between a
  // historical record and a live opinion: after this line, changing the
  // retained share, the owner split or an owner's labor rate cannot move a
  // single number on a closed move.
  const currentSnapshot = (closeout?.snapshots ?? []).find((s) => !s.supersededAt) ?? null
  const useSnapshot = isFinalized && !!currentSnapshot
  const allocation = useSnapshot ? allocationFromSnapshot(currentSnapshot as never) : liveAllocation
  const allocationBasis: AllocationBasis = useSnapshot ? 'FINALIZED' : 'PROVISIONAL'

  // Snapshot history, newest first, each with its OWN frozen allocation and the
  // change against the version before it.
  const ordered = [...(closeout?.snapshots ?? [])].sort((a, b) => b.version - a.version)
  const snapshotHistory = ordered.map((s, idx) => {
    const previous = ordered[idx + 1] ?? null
    return {
      id: s.id,
      version: s.version,
      createdAt: s.createdAt,
      supersededAt: s.supersededAt,
      companyNetProfitCents: s.companyNetProfitCents,
      distributableProfitCents: s.distributableProfitCents,
      createdByName: s.createdByName ?? null,
      calculationVersion: s.calculationVersion,
      configSource: s.configSource ?? null,
      configVersion: s.configVersion ?? null,
      allocation: allocationFromSnapshot(s as never),
      deltaFromPreviousCents: previous ? s.companyNetProfitCents - previous.companyNetProfitCents : null,
    }
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
    allocation,
    allocationBasis,
    liveAllocation,
    allocationSnapshotVersion: useSnapshot ? currentSnapshot!.version : null,
    laborState,
    reopenReason: closeout?.reopenReason ?? null,
    unpaidLaborCents: labor.unpaidCents,
    ownerReimbursementOwedCents,
    expensesMissingReceipt,
    pendingExpenseCount,
    snapshots: snapshotHistory,
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
  args: {
    closeoutId: string; bookingId: string; view: CloseoutView; userId: string; userName: string
    allocations: { owner: string; amountCents: number; percentBp: number }[]
    /** Where the retained rate came from, and which config produced it. */
    configSource?: string | null
    configVersion?: string | null
  },
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

  // Provenance of the retained share, resolved HERE so the route cannot forget
  // it. `closeout.frozen` means this move had already been finalized once and
  // kept its original rate; `business_config` means it took today's policy;
  // `default` means no policy was configured and the share is zero.
  const frozenBp = await tx.moveCloseout
    .findUnique({ where: { id: args.closeoutId }, select: { businessRetainedBp: true } })
    .catch(() => null)
  const cfg = await tx.businessConfig
    .findUnique({ where: { id: 'singleton' }, select: { updatedAt: true, generalReserveBp: true } })
    .catch(() => null)
  const configSource =
    args.configSource ??
    (frozenBp?.businessRetainedBp != null ? 'closeout.frozen' : cfg ? 'business_config' : 'default')
  const configVersion = args.configVersion ?? cfg?.updatedAt?.toISOString() ?? null
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
      // ── The 40/30/30 policy AS APPLIED to this move at this moment.
      //    Rate + resolved dollars + remainder are all stored, so the snapshot
      //    explains itself without re-reading BusinessConfig — and a later
      //    policy change can never rewrite it. ──
      businessRetainedBp: f.reserves.businessRetainedBp,
      businessRetainedCents: f.reserves.businessRetainedCents,
      roundingRemainderCents: Math.max(
        0,
        f.reserves.distributableProfitCents - args.allocations.reduce((s, a) => s + a.amountCents, 0),
      ),
      businessReserveCents: f.reserves.businessReserveCents,
      retainedEarningsCents: f.reserves.retainedEarningsCents,
      unresolvedLiabilityCents: f.reserves.unresolvedLiabilityCents,
      distributableProfitCents: f.reserves.distributableProfitCents,
      ownerAllocations: args.allocations as never,
      // The lines EXACTLY as the owner saw them at finalization. Storing the
      // presentation — not just the inputs — is what lets a report, an export
      // or a printed summary restate this move years later without ever
      // consulting live configuration.
      allocationLines: args.view.liveAllocation.lines as never,
      overheadMethod: f.overhead.method as never,
      overheadRateRaw: f.overhead.rateRaw,
      taxReserveBp: null,
      splitMethod: (args.view.split?.method ?? null) as never,
      incompleteFlags: { blockers: args.view.blockers.map((b) => b.code), overrides: args.view.overrides.map((o) => o.code) } as never,
      calculationVersion: CALCULATION_VERSION,
      configSource,
      configVersion,
      createdById: args.userId,
      createdByName: args.userName,
    },
    select: { id: true, version: true },
  })
  return row
}
