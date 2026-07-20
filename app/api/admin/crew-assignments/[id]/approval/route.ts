import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { computeLaborPay } from '@/lib/labor-calc'
import { recalcAssignment, loadLaborPolicy } from '@/lib/labor-service'
import { canApproveLabor, canConfirmZeroLabor } from '@/lib/labor-guards'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Labor approval workflow (Phase 1):
//     DRAFT → SUBMITTED → APPROVED → (paid)
//                      ↘ REJECTED
//  plus CONFIRM_ZERO — the deliberate, audited "$0 labor" that Phase 0 defined
//  as the only thing that may look like free labor.
//
//  THE RULE A WORKER CANNOT BEND: nobody approves their own pay. Submitting is
//  self-service; approving is owner authority, and self-approval is refused even
//  for an owner acting on their own assignment.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'REOPEN', 'CONFIRM_ZERO']),
  /** Owner-adjusted amount at approval time; defaults to the calculated figure. */
  approvedPayCents: z.number().int().min(0).max(100_000_00).optional(),
  reason: z.string().trim().max(500).optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const a = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    include: { user: { select: { id: true, name: true, payRate: true } }, job: { select: { bookingId: true } }, laborPayments: true },
  })
  if (!a) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const { action } = parsed.data
  const role = session.role as Role
  const isSelf = a.userId === session.userId

  const data: Record<string, unknown> = { updatedById: session.userId }
  let auditAction = 'CREW_HOURS_SUBMITTED'

  if (action === 'SUBMIT') {
    if (!can(role, 'labor.submit_hours') && !(isSelf && can(role, 'labor.clock_self'))) {
      return NextResponse.json({ error: 'You cannot submit hours for this assignment.' }, { status: 403 })
    }
    if (a.clockIn && !a.clockOut) {
      return NextResponse.json({ error: 'Clock out before submitting these hours.' }, { status: 422 })
    }
    if ((a.workedMinutes ?? 0) <= 0 && a.payModel === 'HOURLY') {
      return NextResponse.json({ error: 'Enter the hours worked before submitting.' }, { status: 422 })
    }
    data.approvalStatus = 'SUBMITTED'
    data.submittedAt = new Date()
    data.submittedById = session.userId
    auditAction = 'CREW_HOURS_SUBMITTED'
  }

  if (action === 'APPROVE') {
    const { policy, overtimeMultiplierPct } = await loadLaborPolicy()
    const pay = computeLaborPay(
      {
        payModel: a.payModel as never,
        workerType: a.workerType as never,
        clockIn: a.clockIn,
        clockOut: a.clockOut,
        workedMinutes: a.clockIn && a.clockOut ? null : a.workedMinutes,
        actualBreakMinutes: a.actualBreakMinutes,
        travelMinutes: a.travelMinutes,
        travelPayPolicy: a.travelPayPolicy as never,
        hourlyRateCentsSnapshot: a.hourlyRateCentsSnapshot,
        overtimeRateCentsSnapshot: a.overtimeRateCentsSnapshot,
        flatPayCentsSnapshot: a.flatPayCentsSnapshot,
        dayRateCentsSnapshot: a.dayRateCentsSnapshot,
        travelRateCentsSnapshot: a.travelRateCentsSnapshot,
        economicRateCentsSnapshot: a.economicRateCentsSnapshot,
        driverBonusCentsSnapshot: a.driverBonusCentsSnapshot,
        crewLeaderBonusCentsSnapshot: a.crewLeaderBonusCentsSnapshot,
        otherBonusCents: a.otherBonusCents,
        reimbursementCents: a.reimbursementCents,
        legacyPayRate: a.payRate,
        legacyFlatPay: a.flatPay,
        legacyActualHours: a.actualHours,
        userProfilePayRate: a.user.payRate,
      },
      policy,
      overtimeMultiplierPct,
    )
    // THE approval rule (pure + tested): owner-only, never self-approval, no
    // open shift, and an adjusted amount must say why.
    const gate = canApproveLabor({
      role,
      isSelf,
      hasOpenShift: !!a.clockIn && !a.clockOut,
      calculatedPayCents: pay.calculatedPayCents,
      approvedPayCents: parsed.data.approvedPayCents,
      reason: parsed.data.reason,
    })
    if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

    const approved = parsed.data.approvedPayCents ?? pay.calculatedPayCents
    data.approvalStatus = 'APPROVED'
    data.approvedPayCents = approved
    data.approvedById = session.userId
    data.approvedAt = new Date()
    data.rejectedReason = null
    if (parsed.data.reason) data.adjustmentReason = parsed.data.reason
    auditAction = 'CREW_HOURS_APPROVED'
  }

  if (action === 'REJECT') {
    if (!can(role, 'payroll.approve')) {
      return NextResponse.json({ error: 'Only an owner can reject labor.' }, { status: 403 })
    }
    if (!parsed.data.reason?.trim()) {
      return NextResponse.json({ error: 'A reason is required to reject labor.' }, { status: 422 })
    }
    if (a.laborPayments.some((p) => !p.voided)) {
      return NextResponse.json({ error: 'This labor has recorded payments; void them before rejecting it.' }, { status: 422 })
    }
    data.approvalStatus = 'REJECTED'
    data.rejectedReason = parsed.data.reason
    data.approvedPayCents = null
    auditAction = 'CREW_HOURS_REJECTED'
  }

  if (action === 'REOPEN') {
    if (!can(role, 'payroll.approve')) {
      return NextResponse.json({ error: 'Only an owner can reopen approved labor.' }, { status: 403 })
    }
    if (!parsed.data.reason?.trim()) {
      return NextResponse.json({ error: 'A reason is required to reopen approved labor.' }, { status: 422 })
    }
    if (a.laborPayments.some((p) => !p.voided)) {
      return NextResponse.json({ error: 'This labor has recorded payments; void them before reopening it.' }, { status: 422 })
    }
    data.approvalStatus = 'NEEDS_REVIEW'
    data.approvedPayCents = null
    data.approvedById = null
    data.approvedAt = null
    data.adjustmentReason = parsed.data.reason
    auditAction = 'CREW_HOURS_REJECTED'
  }

  if (action === 'CONFIRM_ZERO') {
    // "$0 labor" is a financial assertion, so it is owner-only and must carry a
    // reason. This is the ONLY way a move reads as complete with no labor cost.
    const zeroGate = canConfirmZeroLabor({ role, reason: parsed.data.reason })
    if (!zeroGate.allow) return NextResponse.json({ error: zeroGate.error }, { status: zeroGate.status })
    data.payModel = 'ZERO_CONFIRMED'
    data.zeroLaborConfirmed = true
    data.zeroLaborConfirmedById = session.userId
    data.zeroLaborConfirmedAt = new Date()
    data.zeroLaborConfirmedReason = parsed.data.reason
    data.approvalStatus = 'APPROVED'
    data.approvedPayCents = 0
    data.approvedById = session.userId
    data.approvedAt = new Date()
    auditAction = 'CREW_ZERO_LABOR_CONFIRMED'
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.jobCrew.update({ where: { id: a.id }, data })
    await tx.auditLog.create({
      data: {
        action: auditAction as never,
        userId: session.userId,
        bookingId: a.job?.bookingId ?? null,
        details: {
          jobCrewId: a.id,
          worker: a.user.name,
          previousApproval: a.approvalStatus,
          nextApproval: row.approvalStatus,
          calculatedPayCents: row.calculatedPayCents,
          approvedPayCents: row.approvedPayCents,
          reason: parsed.data.reason ?? null,
          by: session.name,
        },
      },
    })
    return row
  })

  await recalcAssignment(updated.id)
  const fresh = await prisma.jobCrew.findUnique({ where: { id: updated.id }, include: { laborPayments: true } })
  apiLogger.info({ jobCrewId: updated.id, action }, 'Labor approval updated')
  return NextResponse.json({ assignment: fresh })
}
