import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { findAvailableSlots, formatEastern } from '@/lib/scheduling'

// GET /api/customer/booking/[token]/slots
// Returns the next open slots a customer can reschedule into. Token-gated (the
// same self-service token as the booking portal). No login required.
//
// Response: { slots: [{ iso, display }] }  — `iso` goes back in the PATCH body,
// `display` is the pre-formatted Eastern string for the UI.
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  const booking = await prisma.booking.findFirst({
    where: { customerToken: params.token, customerTokenExpiry: { gte: new Date() } },
    select: { id: true, status: true },
  })

  if (!booking) {
    return NextResponse.json({ error: 'Booking not found or link expired' }, { status: 404 })
  }

  if (!['CONFIRMED', 'SCHEDULED', 'PENDING_APPROVAL'].includes(booking.status)) {
    return NextResponse.json({ error: 'This booking cannot be rescheduled', slots: [] }, { status: 422 })
  }

  // Reschedules require ≥72h notice (mirrors the PATCH guard); start searching
  // from 72h out so every returned slot is actually selectable.
  const from = new Date(Date.now() + 72 * 60 * 60 * 1000)
  const dates = await findAvailableSlots(from, 6)

  const slots = dates.map((d) => ({ iso: d.toISOString(), display: formatEastern(d) }))
  return NextResponse.json({ slots })
}
