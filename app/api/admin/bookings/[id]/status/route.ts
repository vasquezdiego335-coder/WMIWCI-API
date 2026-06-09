import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING_APPROVAL: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: ['ARCHIVED'],
}

const StatusSchema = z.object({
  status: z.string(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({ where: { id: params.id } })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const parsed = StatusSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const { status: newStatus } = parsed.data
  const allowed = VALID_TRANSITIONS[booking.status] ?? []
  if (!allowed.includes(newStatus)) {
    return NextResponse.json({ error: `Cannot transition from ${booking.status} to ${newStatus}` }, { status: 422 })
  }

  const data: Record<string, unknown> = { status: newStatus }

  // Set timestamps on the linked Job record if it exists
  if (newStatus === 'IN_PROGRESS') {
    await prisma.job.updateMany({
      where: { bookingId: params.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    })
  }
  if (newStatus === 'COMPLETED') {
    await prisma.job.updateMany({
      where: { bookingId: params.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
  }

  const updated = await prisma.booking.update({ where: { id: params.id }, data })

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_STATE_CHANGED',
      userId: session.userId,
      bookingId: params.id,
      details: { from: booking.status, to: newStatus, changedBy: session.name },
    },
  })

  return NextResponse.json(updated)
}
