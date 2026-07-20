import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { validateTimeEntry, hasBlockingIssue, hasReviewIssue, hoursToMinutes } from '@/lib/labor-time'
import { recalcAssignment, loadLaborPolicy, otherShiftsFor } from '@/lib/labor-service'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  One crew assignment: edit, enter hours, change the rate snapshot, cancel.
//  Phase 1 (owner spec 2026-07-20).
//
//  Two integrity rules are enforced here and nowhere else:
//   1. Changing a FROZEN rate snapshot is an owner-only adjustment that REQUIRES
//      a reason and records before→after — it rewrites a historical cost.
//   2. Editing an APPROVED assignment's money is the same kind of adjustment;
//      approval is un-set so the change is re-reviewed rather than slipping
//      into a finalized figure.
// ════════════════════════════════════════════════════════════════════════════

const PatchSchema = z.object({
  // assignment
  role: z.enum(['CREW_MEMBER', 'CREW_LEADER', 'DRIVER', 'HELPER', 'OWNER_OPERATOR', 'OTHER']).optional(),
  assignmentStatus: z
    .enum(['INVITED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  assignmentNotes: z.string().trim().max(1000).nullable().optional(),
  cancelReason: z.string().trim().max(500).optional(),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  scheduledEndAt: z.string().datetime().nullable().optional(),
  scheduledBreakMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),

  // time — minutes are authoritative; `workedHours` is a convenience input
  clockIn: z.string().datetime().nullable().optional(),
  clockOut: z.string().datetime().nullable().optional(),
  workedMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
  workedHours: z.number().min(0).max(24).nullable().optional(),
  actualBreakMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
  travelMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
  travelPayPolicy: z.enum(['UNPAID', 'REGULAR', 'SEPARATE_RATE']).optional(),
  timeAdjustReason: z.string().trim().max(500).optional(),

  // money — a rate change is gated (see rateAdjustReason)
  payModel: z.enum(['HOURLY', 'FLAT', 'DAY_RATE', 'UNPAID_OWNER', 'ZERO_CONFIRMED', 'CUSTOM']).optional(),
  hourlyRateCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  overtimeRateCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  flatPayCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  dayRateCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  travelRateCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  economicRateCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  driverBonusCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  crewLeaderBonusCentsSnapshot: z.number().int().min(0).max(100_000_00).nullable().optional(),
  otherBonusCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  otherBonusReason: z.string().trim().max(300).nullable().optional(),
  reimbursementCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  reimbursementReason: z.string().trim().max(300).nullable().optional(),
  rateAdjustReason: z.string().trim().max(500).optional(),
})

/** Snapshot fields whose change rewrites a historical labor cost. */
const RATE_FIELDS = [
  'hourlyRateCentsSnapshot',
  'overtimeRateCentsSnapshot',
  'flatPayCentsSnapshot',
  'dayRateCentsSnapshot',
  'travelRateCentsSnapshot',
  'payModel',
] as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const existing = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    include: { user: { select: { id: true, name: true, payRate: true } }, job: { select: { bookingId: true } } },
  })
  if (!existing) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  // CREW may only touch their OWN assignment; a matrix cannot express "own",
  // so ownership is checked here.
  const isSelf = existing.userId === session.userId
  const role = session.role as Role
  if (!can(role, 'labor.enter_hours') && !(isSelf && can(role, 'labor.clock_self'))) {
    return NextResponse.json({ error: 'You cannot edit this assignment.' }, { status: 403 })
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  // ── Rate-snapshot integrity gate ──
  const rateChanged = RATE_FIELDS.some((f) => d[f] !== undefined && d[f] !== (existing as never as Record<string, unknown>)[f])
  if (rateChanged) {
    if (!can(role, 'labor.edit_rate_snapshot')) {
      return NextResponse.json(
        { error: 'Only an owner can change a rate that was already locked in for this move.' },
        { status: 403 },
      )
    }
    if (!d.rateAdjustReason?.trim()) {
      return NextResponse.json(
        { error: 'A reason is required to change a locked-in rate — it changes what this move cost.' },
        { status: 422 },
      )
    }
  }

  // Only an owner may set what an owner's hour is worth.
  if (d.economicRateCentsSnapshot !== undefined && !can(role, 'labor.set_owner_labor_value')) {
    return NextResponse.json({ error: 'Only an owner can set the value of owner labor.' }, { status: 403 })
  }

  const data: Record<string, unknown> = {}
  const assign = <K extends keyof typeof d>(k: K, col = k as string) => {
    if (d[k] !== undefined) data[col] = d[k]
  }

  assign('role')
  assign('assignmentNotes')
  assign('travelPayPolicy')
  assign('payModel')
  for (const f of RATE_FIELDS) if (f !== 'payModel') assign(f)
  assign('economicRateCentsSnapshot')
  assign('driverBonusCentsSnapshot')
  assign('crewLeaderBonusCentsSnapshot')
  assign('otherBonusCents')
  assign('otherBonusReason')
  assign('reimbursementCents')
  assign('reimbursementReason')
  assign('actualBreakMinutes')
  assign('travelMinutes')

  if (d.role !== undefined) data.crewLeader = d.role === 'CREW_LEADER'
  if (d.scheduledStartAt !== undefined) data.scheduledStartAt = d.scheduledStartAt ? new Date(d.scheduledStartAt) : null
  if (d.scheduledEndAt !== undefined) data.scheduledEndAt = d.scheduledEndAt ? new Date(d.scheduledEndAt) : null
  if (d.scheduledBreakMinutes !== undefined) data.scheduledBreakMinutes = d.scheduledBreakMinutes
  if (d.clockIn !== undefined) data.clockIn = d.clockIn ? new Date(d.clockIn) : null
  if (d.clockOut !== undefined) data.clockOut = d.clockOut ? new Date(d.clockOut) : null
  if (d.workedMinutes !== undefined) data.workedMinutes = d.workedMinutes
  if (d.workedHours !== undefined && d.workedHours != null) data.workedMinutes = hoursToMinutes(d.workedHours)

  if (d.assignmentStatus !== undefined) {
    data.assignmentStatus = d.assignmentStatus
    if (d.assignmentStatus === 'CANCELLED') {
      if (!d.cancelReason?.trim()) {
        return NextResponse.json({ error: 'A reason is required to cancel an assignment.' }, { status: 422 })
      }
      data.cancelledAt = new Date()
      data.cancelReason = d.cancelReason
    }
    if (d.assignmentStatus === 'ACCEPTED') data.acceptedAt = new Date()
    if (d.assignmentStatus === 'DECLINED') data.declinedAt = new Date()
  }

  if (Object.keys(data).length === 0) return NextResponse.json(existing)

  // ── Time validation ──
  const timeTouched = ['clockIn', 'clockOut', 'workedMinutes', 'workedHours', 'actualBreakMinutes', 'travelMinutes'].some(
    (k) => (d as Record<string, unknown>)[k] !== undefined,
  )
  let issues: ReturnType<typeof validateTimeEntry> = []
  if (timeTouched) {
    const { policy } = await loadLaborPolicy()
    const clockIn = (data.clockIn as Date | null | undefined) ?? existing.clockIn
    const clockOut = (data.clockOut as Date | null | undefined) ?? existing.clockOut
    issues = validateTimeEntry(
      {
        clockIn,
        clockOut,
        workedMinutesOverride: clockIn && clockOut ? null : ((data.workedMinutes as number | null | undefined) ?? existing.workedMinutes),
        breakMinutes: (data.actualBreakMinutes as number | null | undefined) ?? existing.actualBreakMinutes,
        travelMinutes: (data.travelMinutes as number | null | undefined) ?? existing.travelMinutes,
        travelPayPolicy: ((data.travelPayPolicy as string) ?? existing.travelPayPolicy) as never,
        assignmentStatus: (data.assignmentStatus as string) ?? existing.assignmentStatus,
        isAssigned: true,
        hasRate:
          existing.hourlyRateCentsSnapshot != null ||
          existing.flatPayCentsSnapshot != null ||
          existing.dayRateCentsSnapshot != null ||
          ['UNPAID_OWNER', 'ZERO_CONFIRMED', 'CUSTOM'].includes(((data.payModel as string) ?? existing.payModel) as string),
        otherShifts: clockIn && clockOut ? await otherShiftsFor(existing.userId, existing.id) : [],
      },
      policy,
    )
    if (hasBlockingIssue(issues)) {
      return NextResponse.json({ error: issues.find((i) => i.level === 'ERROR')?.message, issues }, { status: 422 })
    }
    data.timeEntrySource = isSelf && !can(role, 'labor.enter_hours') ? 'CLOCK' : d.timeAdjustReason ? 'OWNER_OVERRIDE' : 'MANUAL'
    data.timeAdjustedById = session.userId
    data.timeAdjustedAt = new Date()
    if (d.timeAdjustReason) data.timeAdjustReason = d.timeAdjustReason
    // A warning routes the record to review rather than rejecting a legitimate
    // long move day.
    if (hasReviewIssue(issues) && existing.approvalStatus !== 'APPROVED') data.approvalStatus = 'NEEDS_REVIEW'
  }

  // Editing money on an ALREADY-APPROVED assignment re-opens it for review, so a
  // changed cost can never slip silently into a figure someone already agreed.
  const moneyTouched = rateChanged || ['driverBonusCentsSnapshot', 'crewLeaderBonusCentsSnapshot', 'otherBonusCents', 'reimbursementCents'].some(
    (k) => (d as Record<string, unknown>)[k] !== undefined,
  )
  if (existing.approvalStatus === 'APPROVED' && (moneyTouched || timeTouched)) {
    data.approvalStatus = 'NEEDS_REVIEW'
    data.approvedPayCents = null
    data.approvedById = null
    data.approvedAt = null
    data.adjustmentReason = d.rateAdjustReason ?? d.timeAdjustReason ?? 'Edited after approval'
  }

  if (rateChanged) {
    data.rateAdjustedById = session.userId
    data.rateAdjustedAt = new Date()
    data.rateAdjustReason = d.rateAdjustReason
  }
  data.updatedById = session.userId

  const before = RATE_FIELDS.reduce<Record<string, unknown>>((acc, f) => {
    acc[f] = (existing as never as Record<string, unknown>)[f]
    return acc
  }, {})

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.jobCrew.update({ where: { id: params.id }, data })
    if (rateChanged) {
      await tx.auditLog.create({
        data: {
          action: 'CREW_RATE_SNAPSHOT_CHANGED',
          userId: session.userId,
          bookingId: existing.job?.bookingId ?? null,
          details: {
            jobCrewId: row.id,
            worker: existing.user.name,
            previous: before,
            next: RATE_FIELDS.reduce<Record<string, unknown>>((acc, f) => {
              acc[f] = (row as never as Record<string, unknown>)[f]
              return acc
            }, {}),
            reason: d.rateAdjustReason ?? null,
            by: session.name,
          } as never,
        },
      })
    }
    if (timeTouched) {
      await tx.auditLog.create({
        data: {
          action: (isSelf && !can(role, 'labor.enter_hours') ? 'CREW_CLOCK_OUT' : 'CREW_HOURS_EDITED') as never,
          userId: session.userId,
          bookingId: existing.job?.bookingId ?? null,
          details: {
            jobCrewId: row.id,
            worker: existing.user.name,
            previous: { clockIn: existing.clockIn, clockOut: existing.clockOut, workedMinutes: existing.workedMinutes, breakMinutes: existing.actualBreakMinutes },
            next: { clockIn: row.clockIn, clockOut: row.clockOut, workedMinutes: row.workedMinutes, breakMinutes: row.actualBreakMinutes },
            reason: d.timeAdjustReason ?? null,
            warnings: issues.filter((i) => i.level === 'WARNING').map((i) => i.code),
            by: session.name,
          },
        },
      })
    }
    if (d.assignmentStatus !== undefined) {
      await tx.auditLog.create({
        data: {
          action: (d.assignmentStatus === 'CANCELLED' ? 'CREW_ASSIGNMENT_CANCELLED' : 'CREW_ASSIGNMENT_UPDATED') as never,
          userId: session.userId,
          bookingId: existing.job?.bookingId ?? null,
          details: { jobCrewId: row.id, worker: existing.user.name, previous: existing.assignmentStatus, next: d.assignmentStatus, reason: d.cancelReason ?? null, by: session.name },
        },
      })
    }
    return row
  })

  await recalcAssignment(updated.id)
  const fresh = await prisma.jobCrew.findUnique({ where: { id: updated.id }, include: { laborPayments: true } })
  apiLogger.info({ jobCrewId: updated.id, rateChanged, timeTouched }, 'Crew assignment updated')
  return NextResponse.json({ assignment: fresh, warnings: issues.filter((i) => i.level === 'WARNING') })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'labor.assign_crew')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const existing = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    include: { user: { select: { name: true } }, job: { select: { bookingId: true } }, laborPayments: { where: { voided: false } } },
  })
  if (!existing) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  // Settled labor is history — it is cancelled with a reason, never deleted.
  if (existing.laborPayments.length > 0) {
    return NextResponse.json(
      { error: 'This assignment has recorded payments and cannot be removed. Cancel it with a reason instead.' },
      { status: 422 },
    )
  }
  if (existing.approvalStatus === 'APPROVED') {
    return NextResponse.json(
      { error: 'This labor was already approved. Cancel the assignment with a reason instead of deleting it.' },
      { status: 422 },
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.jobCrew.delete({ where: { id: params.id } })
    await tx.auditLog.create({
      data: {
        action: 'CREW_ASSIGNMENT_CANCELLED',
        userId: session.userId,
        bookingId: existing.job?.bookingId ?? null,
        details: { jobCrewId: existing.id, worker: existing.user.name, removed: true, by: session.name },
      },
    })
  })

  return NextResponse.json({ ok: true })
}
