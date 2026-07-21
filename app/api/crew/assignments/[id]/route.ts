import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { type Role } from '@/lib/permissions'
import { canActOnOwnAssignment } from '@/lib/scheduling-guards'
import { evaluateTransition, type AssignmentStatus } from '@/lib/assignment-lifecycle'
import { scheduleAssignmentNotification } from '@/lib/crew-notifications'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  A worker acknowledging / declining their OWN assignment (Stage 5).
//  Ownership is enforced here: a worker can only act on a row that is theirs.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['ACKNOWLEDGE', 'DECLINE']),
  reason: z.string().trim().max(1000).optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })
  const d = parsed.data

  const row = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    select: { id: true, userId: true, assignmentStatus: true, job: { select: { bookingId: true } } },
  })
  if (!row) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const gate = canActOnOwnAssignment({ role, isOwner: row.userId === session.userId, action: d.action === 'ACKNOWLEDGE' ? 'acknowledge' : 'decline', reason: d.reason })
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const to: AssignmentStatus = d.action === 'ACKNOWLEDGE' ? 'ACCEPTED' : 'DECLINED'
  const t = evaluateTransition(row.assignmentStatus as AssignmentStatus, to)
  if (!t.allow) return NextResponse.json({ error: t.error }, { status: 409 })

  await prisma.$transaction([
    prisma.jobCrew.update({
      where: { id: params.id },
      data: d.action === 'ACKNOWLEDGE'
        ? { assignmentStatus: 'ACCEPTED', acceptedAt: new Date(), acknowledgedAt: new Date(), acknowledgmentStaleAt: null }
        : { assignmentStatus: 'DECLINED', declinedAt: new Date(), declineReason: d.reason ?? null },
    }),
    prisma.auditLog.create({
      data: {
        action: (d.action === 'ACKNOWLEDGE' ? 'ASSIGNMENT_ACKNOWLEDGED' : 'ASSIGNMENT_DECLINED') as never,
        userId: session.userId, bookingId: row.job.bookingId,
        details: { jobCrewId: params.id, self: true, reason: d.reason ?? null, by: session.name } as never,
      },
    }),
  ])

  // Notify owners of a decline so they can re-staff.
  if (d.action === 'DECLINE') await scheduleAssignmentNotification({ jobCrewId: params.id, type: 'DECLINED' }).catch(() => {})
  return NextResponse.json({ ok: true })
}
