import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { validateTimeEntry, hasBlockingIssue } from '@/lib/labor-time'
import { recalcAssignment, loadLaborPolicy, otherShiftsFor } from '@/lib/labor-service'
import { buildClockUpdate, type ClockAction } from '@/lib/labor-clock'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Crew clock in / out / break (Stage 5). Reachable by CREW (unlike the admin
//  clock route, which middleware blocks for them). Ownership is enforced: a
//  worker may clock only their OWN assignment. Shares the pure state machine in
//  labor-clock.ts, so the rules match the admin path exactly.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END']),
  at: z.string().datetime().optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const a = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    include: { user: { select: { name: true } }, job: { select: { bookingId: true } } },
  })
  if (!a) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  // A crew member acts only on their own row. Owners/managers using this surface
  // may clock anyone (labor.enter_hours), matching the admin route.
  const isSelf = a.userId === session.userId
  if (!(isSelf && can(role, 'labor.clock_self')) && !can(role, 'labor.enter_hours')) {
    return NextResponse.json({ error: 'You can only clock your own assignment.' }, { status: 403 })
  }

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })
  const at = parsed.data.at ? new Date(parsed.data.at) : new Date()
  if (Number.isNaN(at.getTime())) return NextResponse.json({ error: 'Invalid timestamp' }, { status: 422 })

  const result = buildClockUpdate(a, parsed.data.action as ClockAction, at, session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  const { policy } = await loadLaborPolicy()
  const clockIn = (result.data.clockIn as Date | null | undefined) !== undefined ? (result.data.clockIn as Date | null) : a.clockIn
  const clockOut = (result.data.clockOut as Date | null | undefined) !== undefined ? (result.data.clockOut as Date | null) : a.clockOut
  const issues = validateTimeEntry(
    {
      clockIn, clockOut,
      breakMinutes: (result.data.actualBreakMinutes as number) ?? a.actualBreakMinutes,
      travelMinutes: a.travelMinutes, travelPayPolicy: a.travelPayPolicy as never, isAssigned: true,
      otherShifts: clockIn && clockOut ? await otherShiftsFor(a.userId, a.id) : [],
    },
    policy,
  )
  if (hasBlockingIssue(issues)) return NextResponse.json({ error: issues.find((i) => i.level === 'ERROR')?.message, issues }, { status: 422 })

  await prisma.$transaction(async (tx) => {
    await tx.jobCrew.update({ where: { id: a.id }, data: result.data })
    await tx.auditLog.create({
      data: { action: result.auditAction as never, userId: session.userId, bookingId: a.job?.bookingId ?? null, details: { jobCrewId: a.id, action: parsed.data.action, at, self: isSelf, by: session.name } as never },
    })
  })

  await recalcAssignment(a.id)
  return NextResponse.json({ ok: true, warnings: issues.filter((i) => i.level === 'WARNING') })
}
