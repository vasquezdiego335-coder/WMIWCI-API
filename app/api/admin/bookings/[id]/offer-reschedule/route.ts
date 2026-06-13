import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { offerRescheduleToCustomer } from '@/lib/reschedule'

// POST /api/admin/bookings/[id]/offer-reschedule
// Admin clicks "Offer New Dates" in the dashboard. Thin wrapper around the
// shared offerRescheduleToCustomer() helper (same logic the Discord button uses).
// Emails + texts the customer a self-service link; the $49 hold stays attached.
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({ where: { id: params.id }, select: { status: true } })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (['COMPLETED', 'ARCHIVED', 'CANCELLED'].includes(booking.status)) {
    return NextResponse.json({ error: `Cannot offer reschedule for a ${booking.status} booking` }, { status: 422 })
  }

  const result = await offerRescheduleToCustomer(params.id, {
    offeredBy: session.name,
    userId: session.userId,
    notifyDiscord: true,
  })
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    ok: true,
    message: `Reschedule link sent to ${result.customerEmail}`,
    offeredDates: result.offeredDates,
    rescheduleUrl: result.rescheduleUrl,
  })
}
