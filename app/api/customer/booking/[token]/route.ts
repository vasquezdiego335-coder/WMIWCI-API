import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { discordQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'
import { isDayAvailable, formatEastern } from '@/lib/scheduling'
import { BIZ_PHONE } from '@/lib/i18n'
import { outboxEnabled, emitNewDatePicked } from '@/outbox/integration'

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

const MAX_RESCHEDULES = parseInt(process.env.MAX_RESCHEDULES ?? '2', 10)

export async function PATCH(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const booking = await prisma.booking.findFirst({
    where: {
      customerToken: params.token,
      customerTokenExpiry: { gte: new Date() },
    },
    include: { customer: true },
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

  // Cap reschedules to curb abuse — past the limit, route them to a human.
  if (booking.rescheduleCount >= MAX_RESCHEDULES) {
    return NextResponse.json(
      { error: `You've reached the reschedule limit. Please call us at ${BIZ_PHONE} and we'll help.` },
      { status: 409 }
    )
  }

  const body = await req.json()
  const parsed = RescheduleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 422 })
  }

  const { requestedDate, notes } = parsed.data
  const newDate = new Date(requestedDate)

  // Minimum 72h notice.
  const hoursDiff = (newDate.getTime() - Date.now()) / (1000 * 60 * 60)
  if (hoursDiff < 72) {
    return NextResponse.json({ error: 'Reschedule requires at least 72 hours notice' }, { status: 422 })
  }

  // Validate the chosen day still has capacity (no admin block, under MAX_JOBS).
  // Prevents a customer grabbing a slot that filled up since /slots was loaded.
  const dayOk = await isDayAvailable(newDate)
  if (!dayOk) {
    return NextResponse.json(
      { error: 'That date just filled up — please pick another from your available options.' },
      { status: 409 }
    )
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      previousRequestedDate: booking.requestedDate,
      requestedDate: newDate,
      rescheduledAt: new Date(),
      rescheduleCount: { increment: 1 },
      status: 'PENDING_APPROVAL', // requires (re-)approval for the new date
      customerNotes: notes ?? booking.customerNotes,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'SCHEDULE_MODIFIED',
      bookingId: booking.id,
      details: {
        action: 'customer_reschedule',
        from: booking.requestedDate?.toISOString(),
        to: newDate.toISOString(),
        fromStatus: booking.status,
        rescheduleCount: booking.rescheduleCount + 1,
      },
    },
  })

  const whenDisplay = formatEastern(newDate)

  // Re-post a fresh Discord approval card for the new date so an admin can
  // approve it. MESSAGING POLICY: no customer email/SMS is sent here — the
  // system sends exactly four customer messages (pre-approval + final-
  // confirmation). When the admin approves the re-posted card, the customer
  // gets the PRE-APPROVAL pair as usual. (Re-enable by adding 'booking-
  // rescheduled' to ALLOWED_TEMPLATES and restoring the smsQueue.add.)
  try {
    await discordQueue.add('reschedule-offer', {
      type: 'reschedule-offer',
      bookingId: booking.id,
      payload: {
        bookingId: booking.id,
        displayId: booking.displayId,
        customerName: booking.customer.name,
        customerEmail: booking.customer.email,
        customerPhone: booking.customer.phone,
        originAddress: booking.originAddress,
        destAddress: booking.destAddress,
        requestedDate: newDate.toISOString(),
        items: `🔁 RESCHEDULED by customer\n${booking.itemsDescription ?? ''}`.trim(),
        amountPaid: ((booking.depositAmount ?? 4900) / 100).toFixed(2),
        agreementAccepted: booking.agreementAccepted,
        agreementVersion: booking.agreementVersion,
        agreementName: booking.agreementName,
        agreementAcceptedAt: booking.agreementAcceptedAt?.toISOString(),
      },
    })

    apiLogger.info({ bookingId: booking.id }, 'Reschedule → Discord card re-posted (no customer email/SMS per messaging policy)')
  } catch (err) {
    apiLogger.error({ err, bookingId: booking.id }, 'Reschedule Discord card failed (non-fatal)')
  }

  // OUTBOX_ENABLED → record NEW_DATE_PICKED (state → PENDING_APPROVAL). No-op +
  // swallowed when the flag is off.
  if (outboxEnabled()) {
    await emitNewDatePicked({
      bookingId: booking.id,
      newDate: newDate.toISOString(),
      customerName: booking.customer.name,
      customerEmail: booking.customer.email,
    })
  }

  return NextResponse.json({
    ok: true,
    message: 'New date submitted. We will confirm shortly — your $49 hold stays attached.',
    newDate: whenDisplay,
  })
}
