import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { type Role } from '@/lib/permissions'
import { canDeactivateWorker } from '@/lib/scheduling-guards'
import { isLiveStatus } from '@/lib/assignment-lifecycle'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Deactivate / reactivate a worker (Stage 5). [id] = user id. Owner only.
//
//  Deactivation is NEVER a delete: historical assignments, labor and financial
//  records are preserved. It is HARD-BLOCKED when the worker has upcoming live
//  assignments, unless the owner confirms resolving them in the same request —
//  in which case those future assignments are cancelled with a reason.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['DEACTIVATE', 'REACTIVATE']),
  reason: z.string().trim().max(1000).optional(),
  resolveFutureWork: z.boolean().default(false),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  if (params.id === session.userId) return NextResponse.json({ error: 'You cannot deactivate your own account here.' }, { status: 422 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const worker = await prisma.user.findUnique({ where: { id: params.id }, select: { id: true, name: true, active: true } })
  if (!worker) return NextResponse.json({ error: 'Staff member not found' }, { status: 404 })

  if (d.action === 'REACTIVATE') {
    // Reactivation is owner authority; reuse the deactivate permission.
    const gate = canDeactivateWorker({ role, reason: 'reactivate', futureLiveAssignments: 0, resolveFutureWork: true })
    if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
    await prisma.$transaction([
      prisma.user.update({ where: { id: params.id }, data: { active: true, workerStatus: 'ACTIVE', deactivatedAt: null, deactivationReason: null, updatedById: session.userId } }),
      prisma.auditLog.create({ data: { action: 'STAFF_REACTIVATED', userId: session.userId, details: { targetUserId: params.id, by: session.name } as never } }),
    ])
    return NextResponse.json({ ok: true })
  }

  // Count upcoming LIVE assignments (future-dated, not in a dead state).
  const future = await prisma.jobCrew.findMany({
    where: { userId: params.id, assignmentStatus: { notIn: ['CANCELLED', 'DECLINED', 'NO_SHOW', 'COMPLETED'] as never } },
    select: { id: true, assignmentStatus: true, scheduledStartAt: true, job: { select: { booking: { select: { scheduledStart: true } } } } },
  })
  const now = Date.now()
  const upcoming = future.filter((a) => {
    const when = (a.scheduledStartAt ?? a.job?.booking?.scheduledStart)?.getTime()
    return isLiveStatus(String(a.assignmentStatus)) && (when == null || when >= now)
  })

  const gate = canDeactivateWorker({ role, reason: d.reason, futureLiveAssignments: upcoming.length, resolveFutureWork: d.resolveFutureWork })
  if (!gate.allow) return NextResponse.json({ error: gate.error, futureAssignments: upcoming.length }, { status: gate.status })

  await prisma.$transaction(async (tx) => {
    if (upcoming.length > 0 && d.resolveFutureWork) {
      for (const a of upcoming) {
        await tx.jobCrew.update({ where: { id: a.id }, data: { assignmentStatus: 'CANCELLED', cancelledAt: new Date(), cancelReason: `Worker deactivated: ${d.reason}` } })
        await tx.auditLog.create({ data: { action: 'CREW_ASSIGNMENT_CANCELLED', userId: session.userId, details: { jobCrewId: a.id, reason: 'worker deactivation', by: session.name } as never } })
      }
    }
    await tx.user.update({ where: { id: params.id }, data: { active: false, workerStatus: 'INACTIVE', deactivatedAt: new Date(), deactivationReason: d.reason, updatedById: session.userId } })
    await tx.auditLog.create({ data: { action: 'STAFF_DEACTIVATED', userId: session.userId, details: { targetUserId: params.id, reason: d.reason, cancelledFutureAssignments: d.resolveFutureWork ? upcoming.length : 0, by: session.name } as never } })
  })

  return NextResponse.json({ ok: true, cancelledFutureAssignments: d.resolveFutureWork ? upcoming.length : 0 })
}
