import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const Schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  blocked: z.enum(['true', 'false']),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const formData = await req.formData()
  const parsed = Schema.safeParse({
    date: formData.get('date'),
    blocked: formData.get('blocked'),
  })

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 422 })
  }

  const { date, blocked } = parsed.data
  const dateObj = new Date(`${date}T12:00:00.000Z`)

  await prisma.dayBlock.upsert({
    where: { date: dateObj },
    create: { date: dateObj, blocked: blocked === 'true', blockedBy: session.name },
    update: { blocked: blocked === 'true', blockedBy: session.name },
  })

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_STATE_CHANGED',
      userId: session.userId,
      details: { action: blocked === 'true' ? 'day_blocked' : 'day_unblocked', date, by: session.name },
    },
  })

  // Redirect back to schedule page
  return NextResponse.redirect(new URL('/admin/schedule', req.url))
}
