import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { offerRescheduleToCustomer } from '@/lib/reschedule'
import { outboxEnabled, emitRescheduleRequested } from '@/outbox/integration'

// POST /api/admin/bookings/[id]/offer-reschedule
// Admin clicks "Offer New Dates" in the dashboard. Thin wrapper around the
// shared offerRescheduleToCustomer() helper (same logic the Discord button uses),
// plus the SAME outbox emit the Discord path makes, so the customer gets the
// reschedule email from either surface. The $49 hold stays attached.
//
// TRUTHFUL RESPONSE (2026-09-15): this used to answer "Reschedule link sent to
// <email>" without ever emitting the email. It now says whether an email was
// actually queued — and when it was not (outbox off, or this booking was already
// offered once), tells the operator to share the link by hand.
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    select: { status: true, requestedDate: true, customer: { select: { name: true, email: true } } },
  })
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

  const emailQueued =
    outboxEnabled() &&
    (await emitRescheduleRequested({
      bookingId: params.id,
      offeredDates: result.offeredDatesIso,
      rescheduleUrl: result.rescheduleUrl,
      customerName: booking.customer.name,
      customerEmail: booking.customer.email,
      requestedDate: booking.requestedDate?.toISOString() ?? null,
    }))

  return NextResponse.json({
    ok: true,
    emailQueued,
    message: emailQueued
      ? `Reschedule offer recorded — email queued to ${result.customerEmail}`
      : 'Reschedule link is ready, but NO email was sent (the outbox is off, or this booking was already offered new dates once). Share the link with the customer directly.',
    offeredDates: result.offeredDates,
    rescheduleUrl: result.rescheduleUrl,
  })
}
