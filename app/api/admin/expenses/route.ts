import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { ExpenseCategory, ExpenseStatus, PaymentMethod } from '@prisma/client'
import { z } from 'zod'

// Admin operating system — expenses ledger (owner spec 2026-07-13).
// A job-linked expense (bookingId set) reduces THAT job's profit; a general
// expense (bookingId null) reduces monthly business profit. Receipt is the
// Cloudinary URL returned by /api/files/upload (uploaded client-side first).

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
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

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

  const incurredOn = d.incurredOn ? new Date(d.incurredOn) : new Date()
  if (Number.isNaN(incurredOn.getTime())) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
  }

  const expense = await prisma.expense.create({
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

  await prisma.auditLog.create({
    data: {
      action: 'EXPENSE_CREATED',
      userId: session.userId,
      bookingId,
      details: { expenseId: expense.id, amountCents: expense.amount, category: expense.category, vendor: expense.vendor, createdBy: session.name },
    },
  })

  apiLogger.info({ expenseId: expense.id, bookingId, amount: expense.amount }, 'Expense created')
  return NextResponse.json(expense, { status: 201 })
}
