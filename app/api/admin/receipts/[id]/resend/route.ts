import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: { customer: true },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await emailQueue.add('resend-receipt', {
    template: 'job-completion',
    to: booking.customer.email,
    bookingId: booking.id,
    payload: {
      customerName: booking.customer.name,
      completedAt: booking.updatedAt.toISOString(),
      portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
      items: booking.itemsDescription ?? undefined,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'RECEIPT_SENT',
      userId: session.userId,
      bookingId: booking.id,
      details: { resentBy: session.name, to: booking.customer.email },
    },
  })

  return NextResponse.json({ ok: true, message: `Receipt queued for ${booking.customer.email}` })
}
