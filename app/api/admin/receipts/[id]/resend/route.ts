import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'
import { effectiveWaitingFeeCents, resolveWaiting } from '@/lib/waiting-time'

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

  // Full price breakdown so the receipt separates deposit vs. move total vs.
  // what's due on move day (labor balance + truck add-on + travel fee). Every
  // money field is a formatted string; rows the booking doesn't have are omitted.
  const deposit = booking.depositAmount / 100
  const moveTotal = booking.totalEstimate ?? undefined
  const truckAddon = booking.truckAddonDueOnMoveDay && booking.truckAddonAmount ? booking.truckAddonAmount / 100 : undefined
  const travel = booking.travelFeeDueOnMoveDay && booking.travelFee ? booking.travelFee / 100 : undefined
  // Waiting fee (Late Arrival & Delay Policy) — its own line, never in labor.
  const waitingCents = effectiveWaitingFeeCents(booking)
  const waitingFee = waitingCents > 0 ? waitingCents / 100 : undefined
  const waitingMinutes = waitingFee ? resolveWaiting(booking).billableMinutes : undefined
  const laborBalance = moveTotal != null ? Math.max(0, moveTotal - deposit) : undefined
  const dueOnMoveDay =
    laborBalance != null ? laborBalance + (truckAddon ?? 0) + (travel ?? 0) + (waitingFee ?? 0) : undefined
  const money = (n?: number) => (n != null ? n.toFixed(2) : undefined)

  // Send the premium PAYMENT RECEIPT template (was mistakenly 'job-completion',
  // which the worker allowlist dropped — the receipt silently never sent).
  await emailQueue.add('resend-receipt', {
    template: 'payment-receipt',
    to: booking.customer.email,
    bookingId: booking.id,
    payload: {
      customerName: booking.customer.name,
      displayId: booking.displayId,
      amountPaid: deposit.toFixed(2),
      captured: booking.depositPaid,
      moveTotal: money(moveTotal),
      remainingBalance: money(laborBalance),
      truckAddon: money(truckAddon),
      travelFee: money(travel),
      waitingFee: money(waitingFee),
      waitingMinutes,
      dueOnMoveDay: money(dueOnMoveDay),
      date: booking.updatedAt.toISOString(),
      portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
      locale: booking.customer.locale,
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
