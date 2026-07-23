import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { isLiveStatus, isAcknowledged } from '@/lib/assignment-lifecycle'
import { isPortalEligible } from '@/lib/scheduling-guards'

// ════════════════════════════════════════════════════════════════════════════
//  A worker's OWN assignments (Stage 5). GET only. Returns ONLY authorized,
//  worker-safe fields — never owner allocations, other workers' pay, private
//  customer notes or full financials.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'assignment.view_own')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // The JWT outlives a deactivation — re-check the live row on every request.
  const worker = await prisma.user.findUnique({ where: { id: session.userId }, select: { active: true, workerStatus: true } })
  const eligible = isPortalEligible(worker ? { active: worker.active, workerStatus: String(worker.workerStatus) } : null)
  if (!eligible.allow) return NextResponse.json({ error: eligible.error }, { status: eligible.status })

  const rows = await prisma.jobCrew.findMany({
    where: { userId: session.userId },
    orderBy: { assignedAt: 'desc' },
    take: 100,
    select: {
      id: true, assignmentStatus: true, role: true, isDriver: true, crewLeader: true,
      reportTime: true, scheduledStartAt: true, scheduledEndAt: true, workerVisibleNotes: true,
      acknowledgedAt: true, acknowledgmentStaleAt: true, clockIn: true, clockOut: true,
      workedMinutes: true, approvalStatus: true,
      job: {
        select: {
          status: true,
          booking: { select: { bookingReference: true, scheduledStart: true, originCity: true, destCity: true } },
          staffingReq: { select: { reportTime: true, loadingLocation: true, unloadingLocation: true, workerInstructions: true } },
        },
      },
    },
  })

  const assignments = rows.map((r) => ({
    id: r.id,
    status: String(r.assignmentStatus),
    role: String(r.role),
    isDriver: r.isDriver,
    isLead: r.crewLeader,
    acknowledged: isAcknowledged(String(r.assignmentStatus), r.acknowledgedAt, r.acknowledgmentStaleAt),
    needsAcknowledgment: !!r.acknowledgmentStaleAt || String(r.assignmentStatus) === 'OFFERED',
    reportTime: r.reportTime ?? r.job?.staffingReq?.reportTime ?? null,
    scheduledStart: r.scheduledStartAt ?? r.job?.booking?.scheduledStart ?? null,
    scheduledEnd: r.scheduledEndAt ?? null,
    bookingReference: r.job?.booking?.bookingReference ?? null,
    originCity: r.job?.booking?.originCity ?? null,
    destCity: r.job?.booking?.destCity ?? null,
    loadingLocation: r.job?.staffingReq?.loadingLocation ?? null,
    unloadingLocation: r.job?.staffingReq?.unloadingLocation ?? null,
    // Worker-visible notes only — the private admin notes are never selected.
    notes: [r.workerVisibleNotes, r.job?.staffingReq?.workerInstructions].filter(Boolean).join('\n') || null,
    clockIn: r.clockIn,
    clockOut: r.clockOut,
    workedMinutes: r.workedMinutes,
    jobStatus: r.job ? String(r.job.status) : null,
    live: isLiveStatus(String(r.assignmentStatus)),
  }))

  return NextResponse.json({
    upcoming: assignments.filter((a) => a.live && String(a.status) !== 'COMPLETED'),
    completed: assignments.filter((a) => String(a.status) === 'COMPLETED'),
  })
}
