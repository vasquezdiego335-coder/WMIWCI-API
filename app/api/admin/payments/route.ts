import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { PaymentMethod } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { z } from 'zod'

// Record a manual (cash / Zelle / move-day) payment against a booking (owner
// spec 2026-07-13). This is how non-Stripe money enters the ledger so per-job
// profit + "what was paid" are accurate. No stripe id is set, so profit.ts
// applies NO processor fee to it. It counts as real revenue (COMPLETED,
// non-test) exactly like a captured Stripe payment.

const Schema = z.object({
  bookingId: z.string().min(1),
  amountCents: z.number().int().positive().max(1_000_000_00),
  method: z.nativeEnum(PaymentMethod).optional(),
  note: z.string().trim().max(300).optional(),
  occurredOn: z.string().optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'money.record_payment')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const booking = await prisma.booking.findUnique({ where: { id: d.bookingId }, select: { id: true } })
  if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

  const createdAt = d.occurredOn ? new Date(d.occurredOn) : new Date()
  if (Number.isNaN(createdAt.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 422 })

  const method = d.method ?? PaymentMethod.CASH
  const payment = await prisma.$transaction(async (tx) => {
    const p = await tx.payment.create({
      data: {
        bookingId: d.bookingId,
        amount: d.amountCents,
        status: 'COMPLETED',
        // D1 (Stage 4): the method is now a real queryable column. `metadata`
        // keeps its copy for backward compatibility, but the column is the
        // source of truth — description text no longer carries data.
        method,
        description: `${method} payment${d.note ? ` — ${d.note}` : ''}`,
        metadata: { manual: true, method, recordedBy: session.name, recordedById: session.userId },
        createdAt,
      },
    })
    await tx.auditLog.create({
      data: {
        action: 'PAYMENT_RECEIVED',
        userId: session.userId,
        bookingId: d.bookingId,
        details: { paymentId: p.id, amountCents: p.amount, method, manual: true, by: session.name },
      },
    })
    return p
  })

  apiLogger.info({ paymentId: payment.id, bookingId: d.bookingId, amount: payment.amount }, 'Manual payment recorded')
  return NextResponse.json(payment, { status: 201 })
}
