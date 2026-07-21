import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { validateTimeEntry, hasBlockingIssue, minutesBetween, isClockedIn } from '@/lib/labor-time'
import { recalcAssignment, loadLaborPolicy, otherShiftsFor } from '@/lib/labor-service'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Clock in / out / break for ONE assignment (Phase 1).
//  Designed for a phone at a job site: one action per tap, no forms.
//
//  A worker may clock only THEMSELVES (labor.clock_self + row ownership).
//  An owner/manager may clock anyone (labor.enter_hours) — crew often hand a
//  phone over, and someone has to be able to fix a missed tap.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END']),
  at: z.string().datetime().optional(), // defaults to now
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const a = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    include: { user: { select: { name: true } }, job: { select: { bookingId: true } } },
  })
  if (!a) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const role = session.role as Role
  const isSelf = a.userId === session.userId
  if (!can(role, 'labor.enter_hours') && !(isSelf && can(role, 'labor.clock_self'))) {
    return NextResponse.json({ error: 'You can only clock your own assignment.' }, { status: 403 })
  }

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const at = parsed.data.at ? new Date(parsed.data.at) : new Date()
  if (Number.isNaN(at.getTime())) return NextResponse.json({ error: 'Invalid timestamp' }, { status: 422 })

  if (['CANCELLED', 'DECLINED', 'NO_SHOW'].includes(a.assignmentStatus)) {
    return NextResponse.json({ error: 'This assignment is not active, so time cannot be recorded against it.' }, { status: 422 })
  }

  const data: Record<string, unknown> = { timeEntrySource: 'CLOCK', timeAdjustedById: session.userId, timeAdjustedAt: new Date() }
  let auditAction: string

  switch (parsed.data.action) {
    case 'CLOCK_IN': {
      if (a.clockIn && !a.clockOut) return NextResponse.json({ error: 'Already clocked in.' }, { status: 409 })
      data.clockIn = at
      data.clockOut = null
      data.assignmentStatus = 'IN_PROGRESS'
      auditAction = 'CREW_CLOCK_IN'
      break
    }
    case 'CLOCK_OUT': {
      if (!a.clockIn) return NextResponse.json({ error: 'Cannot clock out without a clock-in.' }, { status: 422 })
      if (a.clockOut) return NextResponse.json({ error: 'Already clocked out.' }, { status: 409 })
      // An open break is auto-closed at clock-out rather than silently lost.
      let breakMinutes = a.actualBreakMinutes ?? 0
      if (a.breakStartedAt) {
        breakMinutes += Math.max(0, minutesBetween(a.breakStartedAt, at))
        data.breakStartedAt = null
      }
      data.actualBreakMinutes = breakMinutes
      data.clockOut = at
      data.assignmentStatus = 'COMPLETED'
      auditAction = 'CREW_CLOCK_OUT'
      break
    }
    case 'BREAK_START': {
      if (!isClockedIn(a)) return NextResponse.json({ error: 'Clock in before starting a break.' }, { status: 422 })
      if (a.breakStartedAt) return NextResponse.json({ error: 'A break is already running.' }, { status: 409 })
      data.breakStartedAt = at
      auditAction = 'CREW_BREAK_UPDATED'
      break
    }
    case 'BREAK_END': {
      if (!a.breakStartedAt) return NextResponse.json({ error: 'No break is running.' }, { status: 422 })
      data.actualBreakMinutes = (a.actualBreakMinutes ?? 0) + Math.max(0, minutesBetween(a.breakStartedAt, at))
      data.breakStartedAt = null
      auditAction = 'CREW_BREAK_UPDATED'
      break
    }
  }

  // Validate the resulting shape before writing it.
  const { policy } = await loadLaborPolicy()
  const clockIn = (data.clockIn as Date | null | undefined) !== undefined ? (data.clockIn as Date | null) : a.clockIn
  const clockOut = (data.clockOut as Date | null | undefined) !== undefined ? (data.clockOut as Date | null) : a.clockOut
  const issues = validateTimeEntry(
    {
      clockIn,
      clockOut,
      breakMinutes: (data.actualBreakMinutes as number) ?? a.actualBreakMinutes,
      travelMinutes: a.travelMinutes,
      travelPayPolicy: a.travelPayPolicy as never,
      isAssigned: true,
      otherShifts: clockIn && clockOut ? await otherShiftsFor(a.userId, a.id) : [],
    },
    policy,
  )
  if (hasBlockingIssue(issues)) {
    return NextResponse.json({ error: issues.find((i) => i.level === 'ERROR')?.message, issues }, { status: 422 })
  }

  await prisma.$transaction(async (tx) => {
    await tx.jobCrew.update({ where: { id: a.id }, data })
    await tx.auditLog.create({
      data: {
        action: auditAction as never,
        userId: session.userId,
        bookingId: a.job?.bookingId ?? null,
        details: { jobCrewId: a.id, worker: a.user.name, action: parsed.data.action, at, self: isSelf, by: session.name },
      },
    })
  })

  await recalcAssignment(a.id)
  const fresh = await prisma.jobCrew.findUnique({ where: { id: a.id } })
  return NextResponse.json({ assignment: fresh, warnings: issues.filter((i) => i.level === 'WARNING') })
}
