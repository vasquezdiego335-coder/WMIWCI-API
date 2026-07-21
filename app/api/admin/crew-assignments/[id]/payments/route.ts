import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { PaymentMethod } from '@prisma/client'
import { paidCentsOf } from '@/lib/labor-calc'
import { recalcAssignment } from '@/lib/labor-service'
import { canRecordLaborPayment, canVoidLaborPayment, remainingPayableCents } from '@/lib/labor-guards'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Labor payment records (Phase 1). Full or PARTIAL payments against one
//  approved assignment.
//
//  THIS IS LABOR PAYMENT TRACKING, NOT PAYROLL. It records that money moved. It
//  does not withhold, file, or report taxes, and it is not a substitute for
//  payroll software.
//
//  Recording a payment NEVER creates a business Expense row: labor is recognized
//  once, when accrued (docs/financial-architecture.md). Paying it moves cash and
//  clears a liability — it is not a second cost.
// ════════════════════════════════════════════════════════════════════════════

const RecordSchema = z.object({
  amountCents: z.number().int().positive().max(100_000_00),
  method: z.nativeEnum(PaymentMethod),
  paidOn: z.string().optional(),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
  proofUrl: z.string().url().max(1000).optional(),
  proofPublicId: z.string().trim().max(300).optional(),
  /** Owners may deliberately overpay (a correction, a tip on top). Requires a note. */
  allowOverpay: z.boolean().optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const a = await prisma.jobCrew.findUnique({
    where: { id: params.id },
    include: { user: { select: { name: true } }, job: { select: { bookingId: true } }, laborPayments: true },
  })
  if (!a) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const parsed = RecordSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const approved = a.approvedPayCents ?? a.calculatedPayCents ?? 0
  const alreadyPaid = paidCentsOf(a.laborPayments)
  const remaining = remainingPayableCents(approved, alreadyPaid)

  // THE payment rule (pure + tested): approved-only, partial payments welcome,
  // overpayment requires an explicit confirmation AND a note.
  const gate = canRecordLaborPayment({
    role: session.role as Role,
    approvalStatus: a.approvalStatus,
    approvedCents: approved,
    alreadyPaidCents: alreadyPaid,
    amountCents: d.amountCents,
    allowOverpay: d.allowOverpay,
    notes: d.notes,
  })
  if (!gate.allow) return NextResponse.json({ error: gate.error, remainingCents: remaining }, { status: gate.status })

  const paidOn = d.paidOn ? new Date(d.paidOn) : new Date()
  if (Number.isNaN(paidOn.getTime())) return NextResponse.json({ error: 'Invalid payment date' }, { status: 422 })

  const payment = await prisma.$transaction(async (tx) => {
    const p = await tx.laborPayment.create({
      data: {
        jobCrewId: a.id,
        amountCents: d.amountCents,
        method: d.method,
        paidOn,
        reference: d.reference || null,
        notes: d.notes || null,
        proofUrl: d.proofUrl || null,
        proofPublicId: d.proofPublicId || null,
        recordedById: session.userId,
        recordedByName: session.name,
      },
    })
    await tx.auditLog.create({
      data: {
        action: 'CREW_PAYMENT_RECORDED',
        userId: session.userId,
        bookingId: a.job?.bookingId ?? null,
        details: {
          jobCrewId: a.id,
          laborPaymentId: p.id,
          worker: a.user.name,
          amountCents: p.amountCents,
          method: p.method,
          approvedCents: approved,
          previouslyPaidCents: alreadyPaid,
          remainingAfterCents: Math.max(0, approved - (alreadyPaid + p.amountCents)),
          by: session.name,
        },
      },
    })
    return p
  })

  // paymentStatus (UNPAID / PARTIALLY_PAID / PAID) is DERIVED from the rows.
  await recalcAssignment(a.id)
  const fresh = await prisma.jobCrew.findUnique({ where: { id: a.id }, include: { laborPayments: true } })
  apiLogger.info({ jobCrewId: a.id, laborPaymentId: payment.id, amount: payment.amountCents }, 'Labor payment recorded')
  return NextResponse.json({ payment, assignment: fresh }, { status: 201 })
}

const VoidSchema = z.object({ paymentId: z.string().min(1), reason: z.string().trim().min(1).max(500) })

/** Void a recorded payment. Never deletes — the row stays, flagged, forever. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const parsed = VoidSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'A reason is required to void a payment.' }, { status: 422 })

  const payment = await prisma.laborPayment.findUnique({
    where: { id: parsed.data.paymentId },
    include: { jobCrew: { select: { id: true, userId: true, job: { select: { bookingId: true } }, user: { select: { name: true } } } } },
  })
  if (!payment || payment.jobCrewId !== params.id) {
    return NextResponse.json({ error: 'Payment not found on this assignment' }, { status: 404 })
  }
  const voidGate = canVoidLaborPayment({ role: session.role as Role, alreadyVoided: payment.voided, reason: parsed.data.reason })
  if (!voidGate.allow) return NextResponse.json({ error: voidGate.error }, { status: voidGate.status })

  await prisma.$transaction(async (tx) => {
    await tx.laborPayment.update({
      where: { id: payment.id },
      data: { voided: true, voidedById: session.userId, voidedAt: new Date(), voidReason: parsed.data.reason },
    })
    await tx.auditLog.create({
      data: {
        action: 'CREW_PAYMENT_VOIDED',
        userId: session.userId,
        bookingId: payment.jobCrew.job?.bookingId ?? null,
        details: {
          jobCrewId: payment.jobCrewId,
          laborPaymentId: payment.id,
          worker: payment.jobCrew.user.name,
          amountCents: payment.amountCents,
          reason: parsed.data.reason,
          by: session.name,
        },
      },
    })
  })

  await recalcAssignment(params.id)
  const fresh = await prisma.jobCrew.findUnique({ where: { id: params.id }, include: { laborPayments: true } })
  return NextResponse.json({ ok: true, assignment: fresh })
}
