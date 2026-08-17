import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'
import { effectiveWaitingFeeCents, resolveWaiting } from '@/lib/waiting-time'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from '@/lib/job-money'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: { customer: true, payments: { select: JOB_MONEY_PAYMENT_SELECT } },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Full price breakdown so the receipt separates deposit vs. final total vs.
  // what's due on move day. Every money field is a formatted string; rows the
  // booking doesn't have are omitted.
  //
  // THE TOTALS COME FROM customerBalance (owner spec 2026-08-14) — the same
  // calculation the admin, the job page and the Discord card use. Two bugs
  // died here: the discount was never applied to `moveTotal`, and
  // `dueOnMoveDay` added the travel fee ON TOP of a total that already
  // contained it, so a customer's receipt over-billed them by exactly the
  // travel fee.
  const balance = customerBalance(booking as never)
  const deposit = booking.depositAmount / 100
  const moveTotal = balance.finalBilledCents / 100
  const truckAddon = booking.truckAddonDueOnMoveDay && booking.truckAddonAmount ? booking.truckAddonAmount / 100 : undefined
  const travel = booking.travelFeeDueOnMoveDay && booking.travelFee ? booking.travelFee / 100 : undefined
  // Waiting fee (Late Arrival & Delay Policy) — its own line, never in labor.
  const waitingCents = effectiveWaitingFeeCents(booking)
  const waitingFee = waitingCents > 0 ? waitingCents / 100 : undefined
  const waitingMinutes = waitingFee ? resolveWaiting(booking).billableMinutes : undefined
  // What is still owed, and what will be collected on move day, are the same
  // number: Stripe only ever takes the $49.
  const laborBalance = balance.outstandingCents / 100
  const dueOnMoveDay = laborBalance
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
