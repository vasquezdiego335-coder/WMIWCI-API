import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'
import { onBookingCompleted } from '@/lib/followups'
import { onBookingCancelled } from '@/lib/journeys'
import { confirmationScheduleData } from '@/lib/scheduling'
import { approveBooking, declineBooking } from '@/lib/booking-approval'
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

  const booking = await prisma.booking.findUnique({ where: { id: params.id }, include: { customer: true } })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const parsed = StatusSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const { status: newStatus } = parsed.data
  const allowed = VALID_TRANSITIONS[booking.status] ?? []
  if (!allowed.includes(newStatus)) {
    return NextResponse.json({ error: `Cannot transition from ${booking.status} to ${newStatus}` }, { status: 422 })
  }

  // ── PENDING_APPROVAL → CONFIRMED goes through the ONE shared approval service
  //    (src/lib/booking-approval.ts). It CAPTURES the $49 hold, records the
  //    Payment, upserts the Job, writes the audit log, and sends the customer
  //    confirmation — byte-identical to the Discord approve path. A bare status
  //    flip here used to skip the capture entirely, so an admin-confirmed
  //    booking could leave the authorization to expire (money lost). ──
  if (booking.status === 'PENDING_APPROVAL' && newStatus === 'CONFIRMED') {
    const result = await approveBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId, role: session.role },
      source: 'admin',
    })
    if (!result.ok) {
      const status = result.code === 'forbidden' ? 403 : result.code === 'capture_failed' ? 502 : 409
      return NextResponse.json({ error: result.message }, { status })
    }
    const updated = await prisma.booking.findUnique({ where: { id: params.id } })
    return NextResponse.json(updated)
  }

  // ── PENDING_APPROVAL → CANCELLED goes through the shared decline service so the
  //    uncaptured $49 hold is RELEASED (not left to expire) and the customer gets
  //    the booking-declined email — identical to the Discord "Deny" button. Other
  //    cancellations (e.g. CONFIRMED → CANCELLED, already captured) fall through to
  //    the generic path below, which sends the cancellation email. ──
  if (booking.status === 'PENDING_APPROVAL' && newStatus === 'CANCELLED') {
    const result = await declineBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId, role: session.role },
      source: 'admin',
    })
    if (!result.ok) {
      const status = result.code === 'forbidden' ? 403 : 409
      return NextResponse.json({ error: result.message }, { status })
    }
    const updated = await prisma.booking.findUnique({ where: { id: params.id } })
    return NextResponse.json(updated)
  }

  const data: Record<string, unknown> = { status: newStatus }

  // Confirming here must schedule the booking exactly like the Discord approve
  // path does: populate scheduledStart (what every schedule view queries on) and
  // ensure a Job record exists. Without this, an admin-confirmed booking would be
  // invisible to the daily digest + dashboards.
  if (newStatus === 'CONFIRMED') {
    const sched = confirmationScheduleData(booking)
    if (sched) Object.assign(data, sched)
    await prisma.job.upsert({
      where: { bookingId: params.id },
      update: { status: 'SCHEDULED' },
      create: { bookingId: params.id, status: 'SCHEDULED' },
    })
  }

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

  // ── Customer emails on terminal transitions (guarded, never fatal) ───────
  //   CANCELLED: honest by capture state — a not-yet-captured booking is a
  //     "declined" (auth hold releases, no charge); a captured one is a
  //     "cancellation" (owner follows up on the $49 deposit — no auto-refund is
  //     issued here, so we never claim one). COMPLETED: the move-complete email.
  const appBase = (process.env.APP_URL ?? 'https://moveitclearit.com').replace(/\/+$/, '')
  const es = booking.customer.locale === 'es'
  const amount = String(Math.round(booking.depositAmount / 100))
  if (booking.customer.email && newStatus === 'CANCELLED') {
    const label: 'booking-cancellation' | 'booking-declined' = booking.depositPaid ? 'booking-cancellation' : 'booking-declined'
    const payload = booking.depositPaid
      ? {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          date: (booking.scheduledStart ?? booking.confirmedDate ?? booking.requestedDate)?.toISOString(),
          amount,
          refundStatus: 'custom' as const,
          statusText: es
            ? `Nuestro equipo se comunicará contigo sobre tu depósito de $${amount}. Si tienes preguntas, escríbenos cuando quieras.`
            : `Our team will follow up with you about your $${amount} deposit. If you have any questions, reach out any time.`,
          rebookUrl: `${appBase}/book`,
          locale: booking.customer.locale,
        }
      : {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
          amountHold: amount,
          rebookUrl: `${appBase}/book`,
          locale: booking.customer.locale,
        }
    await emailQueue
      .add(label, { template: label, to: booking.customer.email, bookingId: params.id, payload })
      .catch((err) => apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, `${label} email enqueue failed (non-fatal)`))
  }
  if (booking.customer.email && newStatus === 'COMPLETED') {
    await emailQueue
      .add('job-completion', {
        template: 'job-completion',
        to: booking.customer.email,
        bookingId: params.id,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          completedAt: new Date().toISOString(),
          portalUrl: `${appBase}/my-booking/${booking.customerToken}`,
          items: booking.itemsDescription ?? undefined,
          locale: booking.customer.locale,
        },
      })
      .catch((err) => apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'job-completion email enqueue failed (non-fatal)'))
  }

  // Phase 3: kick off the post-move follow-up sequence (review/repeat/referral).
  // Idempotent + self-guarded; awaited so the queue writes happen before we
  // respond, but never allowed to fail the status change.
  if (newStatus === 'COMPLETED') {
    try {
      await onBookingCompleted(params.id)
    } catch (err) {
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'onBookingCompleted failed (non-fatal)')
    }
  }

  // STOP RULE: a cancelled booking must not keep receiving recovery emails,
  // move-day reminders, or post-job review/referral asks. Best-effort queue
  // cleanup; the send-time rechecks are the real guarantee.
  if (newStatus === 'CANCELLED') {
    try {
      await onBookingCancelled(params.id)
    } catch (err) {
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'onBookingCancelled failed (non-fatal)')
    }
  }

  return NextResponse.json(updated)
}
