import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { discordQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'

export async function GET(_req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const booking = await prisma.booking.findFirst({
    where: {
      customerToken: params.token,
      customerTokenExpiry: { gte: new Date() },
    },
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      payments: { select: { amount: true, status: true, createdAt: true } },
      job: { select: { status: true, startedAt: true, completedAt: true } },
      files: { select: { id: true, type: true, filename: true, cloudinaryUrl: true, createdAt: true } },
      receipt: { select: { cloudinaryUrl: true, sentAt: true } },
    },
  })

  if (!booking) {
    return NextResponse.json({ error: 'Booking not found or link expired' }, { status: 404 })
  }

  // Omit sensitive fields before returning to customer
  const { stripeCheckoutId, stripePaymentIntentId, ipAddress, userAgent, discordJobChannelId, discordPaperworkChannelId, discordPhotosChannelId, discordApprovalMessageId, internalNotes, ...safe } = booking as any

  return NextResponse.json(safe)
}

const RescheduleSchema = z.object({
  requestedDate: z.string().datetime(),
  notes: z.string().max(500).optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const booking = await prisma.booking.findFirst({
    where: {
      customerToken: params.token,
      customerTokenExpiry: { gte: new Date() },
    },
  })

  if (!booking) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // Allow reschedule for already-confirmed bookings AND for bookings where the
  // team offered new dates (PENDING_APPROVAL — the "Offer New Dates" flow).
  // The $49 hold stays attached the whole time; the customer never re-pays.
  if (!['CONFIRMED', 'SCHEDULED', 'PENDING_APPROVAL'].includes(booking.status)) {
    return NextResponse.json({ error: 'Booking cannot be rescheduled at this stage' }, { status: 422 })
  }

  const body = await req.json()
  const parsed = RescheduleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 422 })
  }

  const { requestedDate, notes } = parsed.data

  // Minimum 72h notice
  const newDate = new Date(requestedDate)
  const hoursDiff = (newDate.getTime() - Date.now()) / (1000 * 60 * 60)
  if (hoursDiff < 72) {
    return NextResponse.json({ error: 'Reschedule requires at least 72 hours notice' }, { status: 422 })
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      requestedDate: newDate,
      status: 'PENDING_APPROVAL', // requires (re-)approval for the new date
      customerNotes: notes ?? booking.customerNotes,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_STATE_CHANGED',
      bookingId: booking.id,
      details: { action: 'customer_reschedule_request', newDate: requestedDate, fromStatus: booking.status },
    },
  })

  // Re-fetch with customer so we can post a FRESH Discord approval card for the
  // newly chosen date (closes the reschedule loop: pick → new card → approve).
  const full = await prisma.booking.findUnique({
    where: { id: booking.id },
    include: { customer: true },
  })

  if (full) {
    try {
      await discordQueue.add('reschedule-offer', {
        type: 'reschedule-offer',
        bookingId: full.id,
        payload: {
          bookingId: full.id,
          displayId: full.displayId,
          customerName: full.customer.name,
          customerEmail: full.customer.email,
          customerPhone: full.customer.phone,
          originAddress: full.originAddress,
          destAddress: full.destAddress,
          requestedDate: full.requestedDate?.toISOString(),
          items: `🔁 RESCHEDULED by customer\n${full.itemsDescription ?? ''}`.trim(),
          amountPaid: ((full.depositAmount ?? 4900) / 100).toFixed(2),
          agreementAccepted: full.agreementAccepted,
          agreementVersion: full.agreementVersion,
          agreementName: full.agreementName,
          agreementAcceptedAt: full.agreementAcceptedAt?.toISOString(),
        },
      })
      apiLogger.info({ bookingId: full.id }, 'Reschedule → fresh Discord approval card queued')
    } catch (err) {
      apiLogger.error({ err, bookingId: full.id }, 'Reschedule card queue failed (non-fatal)')
    }
  }

  return NextResponse.json({ ok: true, message: 'New date submitted. We will confirm shortly — your $49 hold stays attached.' })
}
