// ============================================================================
// labor-service.ts — the ONE place that writes derived labor state.
// Phase 1 (owner spec 2026-07-20).
//
// Every labor route funnels through `recalcAssignment` so the stored, queryable
// columns (minutes, calculated pay, payment status, and the LEGACY mirrors)
// can never drift from the pure math in labor-time.ts / labor-calc.ts.
//
// This is the only labor module that touches Prisma. Everything it depends on
// is pure and unit-tested.
// ============================================================================

import { prisma } from './db'
import { computeTimeBreakdown, DEFAULT_TIME_POLICY, minutesToHours, type TimePolicy } from './labor-time'
import {
  computeLaborPay,
  paidCentsOf,
  derivePaymentStatus,
  legacyPayStatusFor,
  type ApprovalStatus,
  type AssignmentStatus,
  type PaymentStatus,
} from './labor-calc'

/** Business labor policy, read once per request. Falls back to house defaults
 *  when BusinessConfig has not been created yet. */
export async function loadLaborPolicy(): Promise<{ policy: TimePolicy; overtimeMultiplierPct: number; ownerEconomicRateCents: number }> {
  const cfg = await prisma.businessConfig.findUnique({ where: { id: 'singleton' } }).catch(() => null)
  return {
    policy: {
      overtimeThresholdMinutes: cfg?.overtimeThresholdMinutes ?? DEFAULT_TIME_POLICY.overtimeThresholdMinutes,
      longShiftReviewMinutes: cfg?.longShiftReviewMinutes ?? DEFAULT_TIME_POLICY.longShiftReviewMinutes,
    },
    overtimeMultiplierPct: cfg?.overtimeMultiplierPct ?? 150,
    ownerEconomicRateCents: cfg?.ownerEconomicRateCents ?? 3000,
  }
}

/** The full assignment shape the recalculator needs. */
const ASSIGNMENT_INCLUDE = {
  laborPayments: { select: { amountCents: true, voided: true } },
  user: { select: { id: true, name: true, payRate: true } },
} as const

/**
 * Recompute and persist every DERIVED field on one assignment.
 *
 * Derived here, never trusted from the client:
 *  • minutes buckets (worked / regular / overtime / travel / paid)
 *  • calculatedPayCents
 *  • paymentStatus, from the actual non-voided payment rows
 *  • the legacy actualHours / payStatus mirrors, so pre-Phase-1 readers stay right
 *
 * Runs inside the caller's transaction when one is given.
 */
export async function recalcAssignment(
  jobCrewId: string,
  tx: { jobCrew: typeof prisma.jobCrew } = prisma,
  policyOverride?: { policy: TimePolicy; overtimeMultiplierPct: number },
): Promise<void> {
  const row = await tx.jobCrew.findUnique({ where: { id: jobCrewId }, include: ASSIGNMENT_INCLUDE })
  if (!row) return

  const { policy, overtimeMultiplierPct } = policyOverride ?? (await loadLaborPolicy())

  const time = computeTimeBreakdown(
    {
      clockIn: row.clockIn,
      clockOut: row.clockOut,
      workedMinutesOverride: row.clockIn && row.clockOut ? null : row.workedMinutes,
      breakMinutes: row.actualBreakMinutes,
      travelMinutes: row.travelMinutes,
      travelPayPolicy: row.travelPayPolicy as never,
    },
    policy,
  )

  const pay = computeLaborPay(
    {
      workerType: row.workerType as never,
      payModel: row.payModel as never,
      assignmentStatus: row.assignmentStatus as never,
      approvalStatus: row.approvalStatus as never,
      clockIn: row.clockIn,
      clockOut: row.clockOut,
      workedMinutes: row.clockIn && row.clockOut ? null : row.workedMinutes,
      actualBreakMinutes: row.actualBreakMinutes,
      travelMinutes: row.travelMinutes,
      travelPayPolicy: row.travelPayPolicy as never,
      hourlyRateCentsSnapshot: row.hourlyRateCentsSnapshot,
      overtimeRateCentsSnapshot: row.overtimeRateCentsSnapshot,
      flatPayCentsSnapshot: row.flatPayCentsSnapshot,
      dayRateCentsSnapshot: row.dayRateCentsSnapshot,
      travelRateCentsSnapshot: row.travelRateCentsSnapshot,
      economicRateCentsSnapshot: row.economicRateCentsSnapshot,
      driverBonusCentsSnapshot: row.driverBonusCentsSnapshot,
      crewLeaderBonusCentsSnapshot: row.crewLeaderBonusCentsSnapshot,
      otherBonusCents: row.otherBonusCents,
      reimbursementCents: row.reimbursementCents,
      approvedPayCents: row.approvedPayCents,
      zeroLaborConfirmed: row.zeroLaborConfirmed,
      legacyPayRate: row.payRate,
      legacyFlatPay: row.flatPay,
      legacyActualHours: row.actualHours,
      legacyTips: row.tips,
      legacyBonus: row.bonus,
      legacyDeductions: row.deductions,
      userProfilePayRate: row.user?.payRate,
    },
    policy,
    overtimeMultiplierPct,
  )

  const paid = paidCentsOf(row.laborPayments)
  // Payment status is derived from what was APPROVED (the agreed amount), not
  // from the calculated figure — you cannot over-settle a number nobody agreed.
  const approvedForPayment = row.approvalStatus === 'APPROVED' ? pay.effectivePayCents : 0
  const paymentStatus: PaymentStatus = derivePaymentStatus(approvedForPayment, paid)

  await tx.jobCrew.update({
    where: { id: jobCrewId },
    data: {
      workedMinutes: time.workedMinutes,
      regularMinutes: time.regularMinutes,
      overtimeMinutes: time.overtimeMinutes,
      paidMinutes: time.paidMinutes,
      calculatedPayCents: pay.calculatedPayCents,
      paymentStatus,
      // ── Legacy mirrors: derived, never authoritative. Kept in sync so the
      //    dashboards, reminder rules and reports written before Phase 1 keep
      //    reporting the same truth. ──
      actualHours: time.workedMinutes > 0 ? minutesToHours(time.workedMinutes) : row.actualHours,
      payStatus: legacyPayStatusFor(
        row.approvalStatus as ApprovalStatus,
        paymentStatus,
        row.assignmentStatus as AssignmentStatus,
      ) as never,
      paidAt: paymentStatus === 'PAID' ? (row.paidAt ?? new Date()) : null,
    },
  })
}

/** Recalculate every assignment on a move (after a policy or bulk change). */
export async function recalcJobAssignments(jobId: string): Promise<void> {
  const rows = await prisma.jobCrew.findMany({ where: { jobId }, select: { id: true } })
  const policy = await loadLaborPolicy()
  for (const r of rows) await recalcAssignment(r.id, prisma, policy)
}

/** Resolve (or create) the `Job` row for a booking — crew attach to the Job, and
 *  a booking that has not been approved yet has none. */
export async function ensureJobForBooking(bookingId: string): Promise<string> {
  const job = await prisma.job.upsert({
    where: { bookingId },
    update: {},
    create: { bookingId, status: 'SCHEDULED' },
    select: { id: true },
  })
  return job.id
}

/** Other shifts for the same worker, for the overlap check. Excludes the
 *  assignment being validated and any cancelled/declined ones. */
export async function otherShiftsFor(userId: string, excludeJobCrewId: string | null): Promise<{ start: Date; end: Date; label?: string }[]> {
  const rows = await prisma.jobCrew.findMany({
    where: {
      userId,
      id: excludeJobCrewId ? { not: excludeJobCrewId } : undefined,
      assignmentStatus: { notIn: ['CANCELLED', 'DECLINED', 'NO_SHOW'] },
      clockIn: { not: null },
      clockOut: { not: null },
    },
    select: { clockIn: true, clockOut: true, job: { select: { booking: { select: { bookingReference: true } } } } },
    take: 50,
    orderBy: { clockIn: 'desc' },
  })
  return rows
    .filter((r) => r.clockIn && r.clockOut)
    .map((r) => ({ start: r.clockIn as Date, end: r.clockOut as Date, label: r.job?.booking?.bookingReference ?? undefined }))
}
