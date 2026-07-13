import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { ExpenseCategory, ExpenseStatus, PaymentMethod } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { evaluateWorkerPayExpense } from '@/lib/worker-pay-guard'
import { z } from 'zod'

// Admin operating system — expenses ledger (owner spec 2026-07-13; hardened 2.1).
// A job-linked expense (bookingId set) reduces THAT job's profit; a general
// expense (bookingId null) reduces monthly business profit. Receipt is the
// Cloudinary URL returned by /api/files/upload (uploaded client-side first).
// 2.1: WORKER_PAY on a job that already has crew payroll is blocked server-side
// (owner override with reason), and create+audit commit in one transaction.

const CreateSchema = z.object({
  amountCents: z.number().int().positive().max(100_000_00), // <= $100k sanity cap
  category: z.nativeEnum(ExpenseCategory),
  incurredOn: z.string().optional(), // 'YYYY-MM-DD' or ISO; default now
  vendor: z.string().trim().max(200).optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  paidBy: z.string().trim().max(120).optional(),
  bookingId: z.string().trim().optional(),
  purpose: z.string().trim().max(500).optional(),
  receiptUrl: z.string().url().max(1000).optional(),
  receiptPublicId: z.string().trim().max(300).optional(),
  reimbursable: z.boolean().optional(),
  status: z.nativeEnum(ExpenseStatus).optional(),
  notes: z.string().trim().max(2000).optional(),
  workerPayOverride: z.boolean().optional(), // owner-only escape hatch
  overrideReason: z.string().trim().max(500).optional(),
})

/** True when a booking's job already records crew labor (any pay signal). */
async function bookingHasCrewLabor(bookingId: string): Promise<boolean> {
  const crew = await prisma.jobCrew.findMany({
    where: { job: { bookingId } },
    select: { flatPay: true, actualHours: true, payRate: true, user: { select: { payRate: true } } },
  })
  return crew.some((c) => c.flatPay != null || c.actualHours != null || c.payRate != null || c.user?.payRate != null)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'money.create_expense')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  // A booking-linked expense must reference a real booking (else treat as general).
  let bookingId: string | null = null
  if (d.bookingId) {
    const b = await prisma.booking.findUnique({ where: { id: d.bookingId }, select: { id: true } })
    if (!b) return NextResponse.json({ error: 'Linked booking not found' }, { status: 422 })
    bookingId = b.id
  }

  // WORKER_PAY double-count guard (server-side, forgery-proof).
  const guard = evaluateWorkerPayExpense({
    category: d.category,
    bookingHasCrewLabor: bookingId ? await bookingHasCrewLabor(bookingId) : false,
    override: !!d.workerPayOverride,
    role: session.role as Role,
    reason: d.overrideReason,
  })
  if (!guard.allow) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const incurredOn = d.incurredOn ? new Date(d.incurredOn) : new Date()
  if (Number.isNaN(incurredOn.getTime())) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
  }

  // Create + audit (+ override audit when used) atomically: the log can never
  // record a create that rolled back, and vice versa.
  const overrideUsed = guard.allow && guard.overrideUsed
  const expense = await prisma.$transaction(async (tx) => {
    const e = await tx.expense.create({
      data: {
        amount: d.amountCents,
        category: d.category,
        incurredOn,
        vendor: d.vendor || null,
        paymentMethod: d.paymentMethod ?? null,
        paidBy: d.paidBy || null,
        bookingId,
        purpose: d.purpose || null,
        receiptUrl: d.receiptUrl || null,
        receiptPublicId: d.receiptPublicId || null,
        reimbursable: d.reimbursable ?? false,
        status: d.status ?? ExpenseStatus.SUBMITTED,
        notes: d.notes || null,
        createdById: session.userId,
        createdByName: session.name,
      },
    })
    await tx.auditLog.create({
      data: {
        action: 'EXPENSE_CREATED',
        userId: session.userId,
        bookingId,
        details: { expenseId: e.id, amountCents: e.amount, category: e.category, vendor: e.vendor, createdBy: session.name },
      },
    })
    if (overrideUsed) {
      await tx.auditLog.create({
        data: {
          action: 'WORKER_PAY_OVERRIDE',
          userId: session.userId,
          bookingId,
          details: { expenseId: e.id, amountCents: e.amount, reason: d.overrideReason, by: session.name },
        },
      })
    }
    return e
  })

  apiLogger.info({ expenseId: expense.id, bookingId, amount: expense.amount, override: overrideUsed }, 'Expense created')
  return NextResponse.json(expense, { status: 201 })
}
