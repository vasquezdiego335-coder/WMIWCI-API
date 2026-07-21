// ============================================================================
// labor-calc.ts — THE labor-pay calculator (Phase 1, owner spec 2026-07-20).
//
// JobCrew is the canonical financial labor record for a customer move
// (docs/admin/discord-crew-integration.md). This module turns one assignment
// into money, using ONLY the rate SNAPSHOT stored on that assignment.
//
// THE SNAPSHOT RULE — the reason this file exists:
//   A worker's profile rate is a DEFAULT that seeds a snapshot at assignment
//   time. It is never read again for that assignment. Raising someone's rate
//   today must not change what a move cost last month. The legacy fallback to
//   User.payRate is preserved ONLY for rows that predate snapshots.
//
// Money is integer CENTS. Time is integer MINUTES. Pure functions, no Prisma.
// ============================================================================

import {
  computeTimeBreakdown,
  DEFAULT_TIME_POLICY,
  type TimeBreakdown,
  type TimePolicy,
  type TravelPolicy,
} from './labor-time'

export type PayModel = 'HOURLY' | 'FLAT' | 'DAY_RATE' | 'UNPAID_OWNER' | 'ZERO_CONFIRMED' | 'CUSTOM'
export type WorkerType = 'OWNER' | 'EMPLOYEE' | 'CONTRACTOR' | 'TEMP_HELPER'
export type ApprovalStatus = 'DRAFT' | 'SUBMITTED' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED'
export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'VOIDED'
export type AssignmentStatus =
  | 'INVITED' | 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'ASSIGNED'
  | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'

/** One crew assignment, as the calculator needs it. Mirrors the JobCrew columns. */
export interface LaborAssignment {
  workerType?: WorkerType | null
  payModel?: PayModel | null
  assignmentStatus?: AssignmentStatus | null
  approvalStatus?: ApprovalStatus | null
  paymentStatus?: PaymentStatus | null

  // time
  clockIn?: Date | null
  clockOut?: Date | null
  workedMinutes?: number | null
  actualBreakMinutes?: number | null
  travelMinutes?: number | null
  travelPayPolicy?: TravelPolicy | null

  // rate snapshots (authoritative)
  hourlyRateCentsSnapshot?: number | null
  overtimeRateCentsSnapshot?: number | null
  flatPayCentsSnapshot?: number | null
  dayRateCentsSnapshot?: number | null
  travelRateCentsSnapshot?: number | null
  economicRateCentsSnapshot?: number | null

  // bonuses
  driverBonusCentsSnapshot?: number | null
  crewLeaderBonusCentsSnapshot?: number | null
  otherBonusCents?: number | null
  reimbursementCents?: number | null

  // owner-adjusted outcome
  approvedPayCents?: number | null
  zeroLaborConfirmed?: boolean | null

  // ── LEGACY (pre-snapshot rows only) ──
  legacyPayRate?: number | null // JobCrew.payRate
  legacyFlatPay?: number | null // JobCrew.flatPay
  legacyActualHours?: number | null
  legacyScheduledHours?: number | null
  legacyTips?: number | null
  legacyBonus?: number | null
  legacyDeductions?: number | null
  /** ONLY used when the row has no snapshot at all. Never for snapshotted rows. */
  userProfilePayRate?: number | null
}

export interface LaborPayBreakdown {
  time: TimeBreakdown
  regularPayCents: number
  overtimePayCents: number
  travelPayCents: number
  basePayCents: number // regular + overtime + travel (or the flat/day amount)
  bonusCents: number
  reimbursementCents: number
  /** What the formula produced, before any owner adjustment. */
  calculatedPayCents: number
  /** What will actually be charged: approvedPayCents when set, else calculated. */
  effectivePayCents: number
  /** CASH cost — what the business actually owes/paid. Unpaid owner labor is 0. */
  cashCostCents: number
  /** ECONOMIC value of the labor, including unpaid owner time. Never cash. */
  economicValueCents: number
  /** economicValue − cashCost. The subsidy the owners are personally providing. */
  unpaidOwnerValueCents: number
  isUnpaidOwnerLabor: boolean
  usedLegacyFallback: boolean
}

const nn = (v: number | null | undefined): number => Math.max(0, Math.round(v ?? 0))

/** Cents for a span of minutes at a cents-per-HOUR rate. */
export function payForMinutes(minutes: number, ratePerHourCents: number): number {
  if (minutes <= 0 || ratePerHourCents <= 0) return 0
  return Math.round((minutes / 60) * ratePerHourCents)
}

/** The overtime rate: the explicit snapshot, else the multiplier on the regular
 *  snapshot. 150 = 1.5x. */
export function overtimeRateFor(assignment: LaborAssignment, multiplierPct = 150): number {
  if (assignment.overtimeRateCentsSnapshot != null) return nn(assignment.overtimeRateCentsSnapshot)
  const base = nn(assignment.hourlyRateCentsSnapshot)
  return base > 0 ? Math.round(base * (multiplierPct / 100)) : 0
}

/** True when this row carries a real Phase 1 rate snapshot. Rows without one are
 *  legacy and fall back to the old behavior (documented, not silent). */
export function hasRateSnapshot(a: LaborAssignment): boolean {
  return (
    a.hourlyRateCentsSnapshot != null ||
    a.flatPayCentsSnapshot != null ||
    a.dayRateCentsSnapshot != null ||
    a.payModel === 'UNPAID_OWNER' ||
    a.payModel === 'ZERO_CONFIRMED' ||
    a.payModel === 'CUSTOM'
  )
}

/** Assignment states that contribute NO labor cost, whatever else is recorded. */
export const NON_COSTING_ASSIGNMENT_STATUSES: AssignmentStatus[] = ['DECLINED', 'CANCELLED', 'NO_SHOW']

export function contributesLabor(a: LaborAssignment): boolean {
  if (a.assignmentStatus && NON_COSTING_ASSIGNMENT_STATUSES.includes(a.assignmentStatus)) return false
  if (a.approvalStatus === 'REJECTED') return false
  return true
}

/**
 * Price one assignment.
 *
 *   HOURLY   regular×rate + overtime×otRate + travel + bonuses
 *   FLAT     flat snapshot + bonuses
 *   DAY_RATE day rate + bonuses
 *   UNPAID_OWNER   cash 0, economic value = hours × economic rate
 *   ZERO_CONFIRMED cash 0, economic 0 — an explicit, documented $0
 *   CUSTOM   whatever the owner approved
 */
export function computeLaborPay(
  a: LaborAssignment,
  policy: TimePolicy = DEFAULT_TIME_POLICY,
  overtimeMultiplierPct = 150,
): LaborPayBreakdown {
  const usedLegacyFallback = !hasRateSnapshot(a)

  const time = computeTimeBreakdown(
    {
      clockIn: a.clockIn,
      clockOut: a.clockOut,
      workedMinutesOverride: a.workedMinutes ?? (usedLegacyFallback && a.legacyActualHours != null ? Math.round(a.legacyActualHours * 60) : null),
      breakMinutes: a.actualBreakMinutes,
      travelMinutes: a.travelMinutes,
      travelPayPolicy: a.travelPayPolicy ?? 'REGULAR',
    },
    policy,
  )

  const model: PayModel = a.payModel ?? (usedLegacyFallback ? (nn(a.legacyFlatPay) > 0 ? 'FLAT' : 'HOURLY') : 'HOURLY')

  const bonusCents = nn(a.driverBonusCentsSnapshot) + nn(a.crewLeaderBonusCentsSnapshot) + nn(a.otherBonusCents) + (usedLegacyFallback ? nn(a.legacyTips) + nn(a.legacyBonus) : 0)
  const reimbursementCents = nn(a.reimbursementCents)

  let regularPayCents = 0
  let overtimePayCents = 0
  let travelPayCents = 0
  let basePayCents = 0

  if (model === 'FLAT') {
    basePayCents = usedLegacyFallback ? nn(a.legacyFlatPay) : nn(a.flatPayCentsSnapshot)
  } else if (model === 'DAY_RATE') {
    basePayCents = nn(a.dayRateCentsSnapshot)
  } else if (model === 'UNPAID_OWNER' || model === 'ZERO_CONFIRMED') {
    basePayCents = 0
  } else if (model === 'CUSTOM') {
    basePayCents = 0 // the owner-approved amount is applied below
  } else {
    // HOURLY. Snapshot first; the profile rate ONLY for pre-snapshot rows.
    const hourly = usedLegacyFallback
      ? nn(a.legacyPayRate ?? a.userProfilePayRate)
      : nn(a.hourlyRateCentsSnapshot)
    regularPayCents = payForMinutes(time.regularMinutes + time.travelPaidAtRegular, hourly)
    overtimePayCents = payForMinutes(time.overtimeMinutes, overtimeRateFor(a, overtimeMultiplierPct))
    travelPayCents = payForMinutes(time.travelPaidSeparately, nn(a.travelRateCentsSnapshot))
    basePayCents = regularPayCents + overtimePayCents + travelPayCents
  }

  const legacyDeductions = usedLegacyFallback ? nn(a.legacyDeductions) : 0
  let calculatedPayCents = Math.max(0, basePayCents + bonusCents + reimbursementCents - legacyDeductions)
  if (model === 'CUSTOM') calculatedPayCents = nn(a.approvedPayCents)

  const effectivePayCents = a.approvedPayCents != null ? nn(a.approvedPayCents) : calculatedPayCents

  // ── Cash vs economic ──
  const isUnpaidOwnerLabor = model === 'UNPAID_OWNER'
  const cashCostCents = isUnpaidOwnerLabor ? 0 : effectivePayCents

  // Economic value: what this labor would cost if it had to be hired. For a paid
  // worker that IS the cash cost. For unpaid owner time it is hours × the
  // economic (replacement) rate — money that never moved but was really worth
  // something. ZERO_CONFIRMED is a genuine zero on both sides.
  let economicValueCents = cashCostCents
  if (isUnpaidOwnerLabor) {
    economicValueCents = payForMinutes(time.paidMinutes, nn(a.economicRateCentsSnapshot))
  } else if (model === 'ZERO_CONFIRMED') {
    economicValueCents = 0
  }

  return {
    time,
    regularPayCents,
    overtimePayCents,
    travelPayCents,
    basePayCents,
    bonusCents,
    reimbursementCents,
    calculatedPayCents,
    effectivePayCents,
    cashCostCents,
    economicValueCents,
    unpaidOwnerValueCents: Math.max(0, economicValueCents - cashCostCents),
    isUnpaidOwnerLabor,
    usedLegacyFallback,
  }
}

// ── Job-level rollup ────────────────────────────────────────────────────────

export interface LaborRollup {
  /** CASH labor that is a real cost: APPROVED assignments only. */
  approvedCashCents: number
  /** Calculated but not yet approved — shown, never counted as cost. */
  pendingCashCents: number
  /** Approved cash already settled (sum of non-voided labor payments). */
  paidCents: number
  /** Approved cash still owed. Held back from distributable cash. */
  unpaidCents: number
  /** Economic value including unpaid owner time. */
  economicCents: number
  /** economic − approvedCash. What the owners subsidized. */
  unpaidOwnerValueCents: number
  approvedCount: number
  pendingCount: number
  totalPaidMinutes: number
}

export interface RollupAssignment extends LaborAssignment {
  /** Non-voided labor payments recorded against this assignment. */
  paidCents?: number
}

/**
 * Roll a move's assignments into the numbers profit and cash need.
 *
 * ACCOUNTING RULE: only APPROVED labor is a cost. A DRAFT/SUBMITTED assignment
 * is visible and warned about, but it is not yet an agreed liability — the same
 * way an unapproved expense is money spent but an unagreed number. Completeness
 * (financial-completeness.ts) is what forces it to get approved.
 */
export function rollupLabor(
  assignments: RollupAssignment[],
  policy: TimePolicy = DEFAULT_TIME_POLICY,
  overtimeMultiplierPct = 150,
): LaborRollup {
  let approvedCashCents = 0
  let pendingCashCents = 0
  let paidCents = 0
  let economicCents = 0
  let unpaidOwnerValueCents = 0
  let approvedCount = 0
  let pendingCount = 0
  let totalPaidMinutes = 0

  for (const a of assignments) {
    if (!contributesLabor(a)) continue
    const b = computeLaborPay(a, policy, overtimeMultiplierPct)
    totalPaidMinutes += b.time.paidMinutes

    if (a.approvalStatus === 'APPROVED') {
      approvedCount++
      approvedCashCents += b.cashCostCents
      economicCents += b.economicValueCents
      unpaidOwnerValueCents += b.unpaidOwnerValueCents
      paidCents += nn(a.paidCents)
    } else {
      pendingCount++
      pendingCashCents += b.cashCostCents
    }
  }

  return {
    approvedCashCents,
    pendingCashCents,
    paidCents,
    // Never negative: an overpayment is a data problem, not negative debt.
    unpaidCents: Math.max(0, approvedCashCents - paidCents),
    economicCents,
    unpaidOwnerValueCents,
    approvedCount,
    pendingCount,
    totalPaidMinutes,
  }
}

// ── Payment rollup ──────────────────────────────────────────────────────────

export interface LaborPaymentRow {
  amountCents: number
  voided?: boolean | null
}

/** Sum of payments that actually moved money. Voided rows count nowhere and are
 *  never deleted, so the history stays intact. */
export function paidCentsOf(payments: LaborPaymentRow[]): number {
  return payments.filter((p) => !p.voided).reduce((s, p) => s + nn(p.amountCents), 0)
}

/** Derive the payment status from what was approved vs what was paid. Stored as
 *  a column for querying, but ALWAYS recomputed from the payment rows — a
 *  mutable total drifts, a derived one cannot. */
export function derivePaymentStatus(approvedCents: number, paidCents: number): PaymentStatus {
  if (paidCents <= 0) return 'UNPAID'
  if (paidCents >= approvedCents && approvedCents > 0) return 'PAID'
  return 'PARTIALLY_PAID'
}

/** Keep the legacy CrewPayStatus in sync so pre-Phase-1 readers stay correct. */
export function legacyPayStatusFor(approval: ApprovalStatus, payment: PaymentStatus, assignment: AssignmentStatus): string {
  if (payment === 'PAID') return 'PAID'
  if (approval === 'APPROVED') return 'PAY_APPROVED'
  if (assignment === 'COMPLETED') return 'COMPLETED'
  if (assignment === 'IN_PROGRESS') return 'WORKING'
  return 'SCHEDULED'
}

// ── Rate snapshot construction ──────────────────────────────────────────────

export interface SnapshotSource {
  payModel: PayModel
  userProfilePayRateCents?: number | null
  userDefaultFlatRateCents?: number | null
  /** Explicit override typed by the owner at assignment time. */
  hourlyRateCents?: number | null
  flatPayCents?: number | null
  dayRateCents?: number | null
  travelRateCents?: number | null
  overtimeMultiplierPct?: number
  /** Business-config replacement rate, used for OWNER labor. */
  ownerEconomicRateCents?: number | null
  workerType: WorkerType
}

export interface RateSnapshot {
  payModel: PayModel
  hourlyRateCentsSnapshot: number | null
  overtimeRateCentsSnapshot: number | null
  flatPayCentsSnapshot: number | null
  dayRateCentsSnapshot: number | null
  travelRateCentsSnapshot: number | null
  economicRateCentsSnapshot: number | null
  rateSnapshotSource: string
}

/**
 * Freeze the pay terms onto an assignment. Called ONCE at assignment; after
 * this the worker's profile is irrelevant to this move — which is why changing
 * a rate in /admin/staff can never restate what a past move cost.
 *
 * An explicit owner-typed rate wins over the profile default. OWNER workers get
 * an economic rate so unpaid owner labor can be valued later, even if they are
 * being paid cash today.
 *
 * STAGE 4: when nobody has configured an owner rate the snapshot records NULL,
 * not a number. It used to fall back to $30/h — a rate no owner had chosen,
 * which made unconfigured owner labor look priced and quietly understated the
 * cost of every move. Null flows through to LABOR_MISSING_RATE, which is the
 * honest answer: this labor cannot be priced yet.
 */
/** What an owner hour is worth here, or NULL when nobody has said. The cash
 *  rate is an acceptable stand-in (an owner being paid $X/h is evidence their
 *  hour is worth $X/h); a made-up house rate is not. */
function ownerEconomicRateOf(src: SnapshotSource): number | null {
  const configured = src.ownerEconomicRateCents ?? src.userProfilePayRateCents ?? null
  return configured != null && configured > 0 ? nn(configured) : null
}

export function buildRateSnapshot(src: SnapshotSource): RateSnapshot {
  const explicit = src.hourlyRateCents != null || src.flatPayCents != null || src.dayRateCents != null
  const hourly = src.hourlyRateCents ?? src.userProfilePayRateCents ?? null
  const flat = src.flatPayCents ?? src.userDefaultFlatRateCents ?? null
  const multiplier = src.overtimeMultiplierPct ?? 150

  return {
    payModel: src.payModel,
    hourlyRateCentsSnapshot: src.payModel === 'HOURLY' ? (hourly != null ? nn(hourly) : null) : null,
    overtimeRateCentsSnapshot: src.payModel === 'HOURLY' && hourly != null ? Math.round(nn(hourly) * (multiplier / 100)) : null,
    flatPayCentsSnapshot: src.payModel === 'FLAT' ? (flat != null ? nn(flat) : null) : null,
    dayRateCentsSnapshot: src.payModel === 'DAY_RATE' ? (src.dayRateCents != null ? nn(src.dayRateCents) : null) : null,
    travelRateCentsSnapshot: src.travelRateCents != null ? nn(src.travelRateCents) : null,
    economicRateCentsSnapshot: src.workerType === 'OWNER' ? ownerEconomicRateOf(src) : null,
    rateSnapshotSource: explicit ? 'manual' : 'user_profile',
  }
}

// ── Discord gig-board adapter (the seam; see discord-crew-integration.md) ────

export interface CrewJobAcceptance {
  crewJobId: string
  /** Resolved app User id. A Discord id alone is NOT enough — an unmapped
   *  worker must be rejected, never guessed at. */
  userId: string | null
  /** The payout the gig board locked in at accept time, in cents. */
  payoutTotalCents: number
  acceptedAt: Date
  /** The move this gig belongs to. `crew_jobs` has no booking column today, so
   *  this is null in practice and the adapter refuses — by design. */
  jobId: string | null
}

export type CrewJobLinkDecision =
  | { link: true; jobId: string; userId: string; snapshot: RateSnapshot; flatPayCents: number }
  | { link: false; reason: string }

/**
 * THE one adapter from a Discord gig acceptance to a canonical JobCrew row.
 *
 * Guarantees, in order:
 *  1. A gig with no move (`jobId === null`) is NEVER turned into move labor.
 *     Today every `crew_job` is in this state — the table has no booking column
 *     — so this returns `link:false` and the gig stays out of move profit,
 *     which is exactly correct. See docs/admin/discord-crew-integration.md.
 *  2. An unmapped Discord worker is refused rather than guessed.
 *  3. The locked gig payout becomes the assignment's FLAT-PAY SNAPSHOT, so the
 *     money is counted ONCE, in JobCrew, like any other flat-rate worker.
 *     `crew_jobs.payout_total` is then a record of what was promised — never a
 *     second cost.
 *  4. The caller upserts on the UNIQUE `crewJobId`, so a replayed acceptance
 *     cannot create a second assignment.
 */
export function linkCrewJobToAssignment(acceptance: CrewJobAcceptance): CrewJobLinkDecision {
  if (!acceptance.jobId) {
    return {
      link: false,
      reason:
        'This crew job is not attached to a customer move, so it cannot create move labor. Gig payouts belong in general business expenses, not job profit.',
    }
  }
  if (!acceptance.userId) {
    return { link: false, reason: 'This Discord worker is not mapped to a staff user, so labor cannot be recorded against them.' }
  }
  if (acceptance.payoutTotalCents <= 0) {
    return { link: false, reason: 'The crew job has no locked payout, so there is no agreed labor amount to record.' }
  }
  return {
    link: true,
    jobId: acceptance.jobId,
    userId: acceptance.userId,
    flatPayCents: nn(acceptance.payoutTotalCents),
    snapshot: {
      payModel: 'FLAT',
      hourlyRateCentsSnapshot: null,
      overtimeRateCentsSnapshot: null,
      flatPayCentsSnapshot: nn(acceptance.payoutTotalCents),
      dayRateCentsSnapshot: null,
      travelRateCentsSnapshot: null,
      economicRateCentsSnapshot: null,
      rateSnapshotSource: 'crew_job',
    },
  }
}
