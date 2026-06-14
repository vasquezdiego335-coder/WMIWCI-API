import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: {
      customer: true,
      payments: true,
      job: { include: { crew: { include: { user: { select: { name: true, role: true } } } } } },
      files: true,
      receipt: true,
      notifications: { orderBy: { createdAt: 'desc' }, take: 20 },
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { name: true } } } },
    },
  })

  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(booking)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const allowed = ['internalNotes', 'confirmedDate', 'scheduledStart', 'scheduledEnd', 'estimatedHours', 'baseRate']
  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in (body as Record<string, unknown>)) data[key] = (body as Record<string, unknown>)[key]
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 422 })
  }

  const [updated] = await prisma.$transaction([
    prisma.booking.update({ where: { id: params.id }, data }),
    prisma.auditLog.create({
      data: {
        action: 'BOOKING_STATE_CHANGED',
        userId: session.userId,
        bookingId: params.id,
        details: { updatedFields: Object.keys(data), updatedBy: session.name },
      },
    }),
  ])

  return NextResponse.json(updated)
}
