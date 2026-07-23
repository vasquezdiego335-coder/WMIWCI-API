import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import { canChangeAssignmentStatus, canSaveAssignment } from '@/lib/scheduling-guards'
import { previewAssignmentConflicts } from '@/lib/scheduling-service'
import { isMaterialChange, describeChanges, type AssignmentStatus } from '@/lib/assignment-lifecycle'
import { replaceAssignmentReminders, scheduleAssignmentNotification } from '@/lib/crew-notifications'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Scheduling actions on ONE assignment (Stage 5). [id] is the JobCrew id.
//   OFFER · ACKNOWLEDGE (manual) · DECLINE (record) · CANCEL · NO_SHOW · COMPLETE
//   SET_DRIVER · SET_LEAD · UPDATE_SCHEDULE (report time / window)
//
//  Every mutation re-runs the conflict engine server-side and audits. A material
//  schedule change resets the worker's acknowledgment and replaces reminders.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['OFFER', 'ACKNOWLEDGE', 'DECLINE', 'CANCEL', 'NO_SHOW', 'COMPLETE', 'SET_DRIVER', 'SET_LEAD', 'UPDATE_SCHEDULE']),
  reason: z.string().trim().max(1000).optional(),
  isDriver: z.boolean().optional(),
  isLead: z.boolean().optional(),
  reportTime: z.string().datetime().nullable().optional(),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  scheduledEndAt: z.string().datetime().nullable().optional(),
  overrideCodes: z.array(z.string().max(80)).optional(),
})

const STATUS_FOR: Record<string, AssignmentStatus> = {
  OFFER: 'OFFERED', DECLINE: 'DECLINED', CANCEL: 'CANCELLED', NO_SHOW: 'NO_SHOW', COMPLETE: 'COMPLETED', ACKNOWLEDGE: 'ACCEPTED',
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const row = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    select: {
      id: true, userId: true, jobId: true, assignmentStatus: true, isDriver: true, crewLeader: true,
      reportTime: true, scheduledStartAt: true, scheduledEndAt: true, acknowledgedAt: true,
      job: { select: { bookingId: true, booking: { select: { originAddress: true, destAddress: true } } } },
    },
  })
  if (!row) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const audit = async (action: string, details: Record<string, unknown>, tx = prisma) =>
    tx.auditLog.create({ data: { action: action as never, userId: session.userId, bookingId: row.job.bookingId, details: { ...details, by: session.name } as never } })

  // ── Status transitions ──
  if (STATUS_FOR[d.action]) {
    const to = STATUS_FOR[d.action]
    const gate = canChangeAssignmentStatus({ role, from: row.assignmentStatus as AssignmentStatus, to })
    if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

    const data: Record<string, unknown> = { assignmentStatus: to }
    const auditAction =
      d.action === 'OFFER' ? 'ASSIGNMENT_OFFERED'
        : d.action === 'DECLINE' ? 'ASSIGNMENT_DECLINED'
          : d.action === 'CANCEL' ? 'CREW_ASSIGNMENT_CANCELLED'
            : d.action === 'NO_SHOW' ? 'ASSIGNMENT_NO_SHOW'
              : d.action === 'COMPLETE' ? 'ASSIGNMENT_COMPLETED'
                : 'ASSIGNMENT_ACKNOWLEDGED'
    if (d.action === 'OFFER') data.offeredAt = new Date()
    if (d.action === 'ACKNOWLEDGE') { data.acknowledgedAt = new Date(); data.acknowledgmentStaleAt = null; data.acceptedAt = new Date() }
    if (d.action === 'DECLINE') { data.declinedAt = new Date(); data.declineReason = d.reason ?? null }
    if (d.action === 'CANCEL') { data.cancelledAt = new Date(); data.cancelReason = d.reason ?? null }
    if (d.action === 'NO_SHOW') data.noShowAt = new Date()
    if (d.action === 'COMPLETE') data.completedAt = new Date()

    await prisma.$transaction(async (tx) => {
      await tx.jobCrew.update({ where: { id: params.id }, data })
      await audit(auditAction, { previous: row.assignmentStatus, next: to, reason: d.reason ?? null }, tx as never)
    })
    if (d.action === 'OFFER') await scheduleAssignmentNotification({ jobCrewId: params.id, type: 'OFFERED' }).catch(() => {})
    if (d.action === 'CANCEL') await scheduleAssignmentNotification({ jobCrewId: params.id, type: 'CANCELLED' }).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  // ── Designations + schedule edits (re-run conflicts) ──
  const nextIsDriver = d.action === 'SET_DRIVER' ? (d.isDriver ?? !row.isDriver) : row.isDriver
  const nextIsLead = d.action === 'SET_LEAD' ? (d.isLead ?? !row.crewLeader) : row.crewLeader
  const nextReportTime = d.action === 'UPDATE_SCHEDULE' && d.reportTime !== undefined ? (d.reportTime ? new Date(d.reportTime) : null) : row.reportTime
  const nextStart = d.action === 'UPDATE_SCHEDULE' && d.scheduledStartAt !== undefined ? (d.scheduledStartAt ? new Date(d.scheduledStartAt) : null) : row.scheduledStartAt
  const nextEnd = d.action === 'UPDATE_SCHEDULE' && d.scheduledEndAt !== undefined ? (d.scheduledEndAt ? new Date(d.scheduledEndAt) : null) : row.scheduledEndAt

  const conflicts = await previewAssignmentConflicts({
    jobId: row.jobId, userId: row.userId, startAt: nextStart, endAt: nextEnd, reportTime: nextReportTime,
    isDriver: nextIsDriver, isLead: nextIsLead, excludeJobCrewId: params.id,
  })
  const gate = canSaveAssignment({ role, conflicts, overriddenCodes: d.overrideCodes ?? [], overrideReason: d.reason })
  if (!gate.allow) return NextResponse.json({ error: gate.error, conflicts }, { status: gate.status })

  const before = { startAt: row.scheduledStartAt, endAt: row.scheduledEndAt, reportTime: row.reportTime, originAddress: row.job.booking?.originAddress, destAddress: row.job.booking?.destAddress, role: '', isDriver: row.isDriver, isLead: row.crewLeader }
  const after = { startAt: nextStart, endAt: nextEnd, reportTime: nextReportTime, originAddress: row.job.booking?.originAddress, destAddress: row.job.booking?.destAddress, role: '', isDriver: nextIsDriver, isLead: nextIsLead }
  const material = row.acknowledgedAt ? isMaterialChange(before, after) : false

  const data: Record<string, unknown> = { isDriver: nextIsDriver, crewLeader: nextIsLead, reportTime: nextReportTime, scheduledStartAt: nextStart, scheduledEndAt: nextEnd }
  if (material) data.acknowledgmentStaleAt = new Date()

  await prisma.$transaction(async (tx) => {
    await tx.jobCrew.update({ where: { id: params.id }, data })
    if (d.action === 'SET_DRIVER') await audit('ASSIGNMENT_DRIVER_CHANGED', { previous: row.isDriver, next: nextIsDriver }, tx as never)
    if (d.action === 'SET_LEAD') await audit('ASSIGNMENT_LEAD_CHANGED', { previous: row.crewLeader, next: nextIsLead }, tx as never)
    if (d.action === 'UPDATE_SCHEDULE') await audit('CREW_ASSIGNMENT_UPDATED', { changes: describeChanges(before, after), material }, tx as never)
    for (const code of d.overrideCodes ?? []) {
      const found = conflicts.find((c) => c.code === code)
      await tx.conflictOverride.create({ data: { jobId: row.jobId, jobCrewId: params.id, userId: row.userId, code, details: (found?.detail ?? {}) as never, reason: d.reason ?? '', overriddenById: session.userId } })
      await audit('CONFLICT_OVERRIDDEN', { jobCrewId: params.id, workerUserId: row.userId, code, reason: d.reason ?? null }, tx as never)
    }
  })

  if (material) await replaceAssignmentReminders({ jobCrewId: params.id, reportTime: nextReportTime }).catch((e) => apiLogger.error({ err: String(e) }, 'reminder replace failed'))
  return NextResponse.json({ ok: true, conflicts, materialChange: material })
}
