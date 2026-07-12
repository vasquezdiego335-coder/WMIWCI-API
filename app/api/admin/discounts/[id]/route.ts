import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const Schema = z.object({ approve: z.boolean() })

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  // Door hanger discounts require OWNER approval
  if (!session || session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Owner approval required' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: { customer: true },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (booking.discountType !== 'DOOR_HANGER_PENDING') {
    return NextResponse.json({ error: 'No pending discount for this booking' }, { status: 422 })
  }

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const { approve } = parsed.data

  await prisma.booking.update({
    where: { id: params.id },
    data: {
      discountType: approve ? 'DOOR_HANGER_APPROVED' : 'DOOR_HANGER_DENIED',
      discountPercent: approve ? 10 : null,
    },
  })

  // No standalone "discount decision" customer email (it isn't one of the 15
  // active templates, and previously used the now-archived booking-confirmed
  // template — which the worker allowlist dropped, so it never sent). The
  // approved discount is reflected in the booking total the customer sees in
  // their portal and in the confirmation email.

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_STATE_CHANGED',
      userId: session.userId,
      bookingId: params.id,
      details: { action: approve ? 'discount_approved' : 'discount_denied', by: session.name },
    },
  })

  return NextResponse.json({ ok: true })
}
