import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { ExpenseCategory, ExpenseStatus, PaymentMethod } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { isFinalizedExpenseStatus, financialFieldChanged } from '@/lib/financial-adjust'
import { z } from 'zod'

// Update / delete a single expense (owner spec 2026-07-13; hardened 2.1).
// Status changes and deletions are audited. 2.1: editing the AMOUNT or CATEGORY
// of a FINALIZED expense (APPROVED/REIMBURSED) is an owner-only adjustment that
// requires a reason and records the before→after values (FINANCIAL_ADJUSTMENT).
// Every write + its audit commit in one transaction. Deletion stays OWNER-only.

const PatchSchema = z.object({
  status: z.nativeEnum(ExpenseStatus).optional(),
  itemTitle: z.string().trim().max(120).nullable().optional(),
  amountCents: z.number().int().positive().max(100_000_00).optional(),
  category: z.nativeEnum(ExpenseCategory).optional(),
  subcategory: z.string().trim().max(80).nullable().optional(),
  incurredOn: z.string().optional(),
  vendor: z.string().trim().max(200).nullable().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).nullable().optional(),
  paidBy: z.string().trim().max(120).nullable().optional(),
  bookingId: z.string().trim().nullable().optional(), // '' / null unlinks; a real id relinks
  purpose: z.string().trim().max(500).nullable().optional(),
  receiptUrl: z.string().url().max(1000).nullable().optional(),
  receiptPublicId: z.string().trim().max(300).nullable().optional(),
  reimbursable: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  adjustmentReason: z.string().trim().max(500).optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'money.approve_expense')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const existing = await prisma.expense.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  // Resolve a job re-link: a real booking id must reference an existing booking;
  // '' / null unlinks (turns it into a general business expense).
  let resolvedBookingId: string | null | undefined
  if (d.bookingId !== undefined) {
    if (d.bookingId) {
      const b = await prisma.booking.findUnique({ where: { id: d.bookingId }, select: { id: true } })
      if (!b) return NextResponse.json({ error: 'Linked booking not found' }, { status: 422 })
      resolvedBookingId = b.id
    } else {
      resolvedBookingId = null
    }
  }
  const bookingChanged = resolvedBookingId !== undefined && (resolvedBookingId ?? null) !== (existing.bookingId ?? null)

  const data: Record<string, unknown> = {}
  if (d.itemTitle !== undefined) data.itemTitle = d.itemTitle || null
  if (d.amountCents !== undefined) data.amount = d.amountCents
  if (d.category !== undefined) data.category = d.category
  if (d.subcategory !== undefined) data.subcategory = d.subcategory || null
  if (d.vendor !== undefined) data.vendor = d.vendor || null
  if (d.paymentMethod !== undefined) data.paymentMethod = d.paymentMethod
  if (d.paidBy !== undefined) data.paidBy = d.paidBy || null
  if (bookingChanged) data.bookingId = resolvedBookingId
  if (d.purpose !== undefined) data.purpose = d.purpose || null
  if (d.receiptUrl !== undefined) data.receiptUrl = d.receiptUrl || null
  if (d.receiptPublicId !== undefined) data.receiptPublicId = d.receiptPublicId || null
  if (d.reimbursable !== undefined) data.reimbursable = d.reimbursable
  if (d.notes !== undefined) data.notes = d.notes || null
  if (d.status !== undefined) data.status = d.status
  if (d.incurredOn !== undefined) {
    const dt = new Date(d.incurredOn)
    if (Number.isNaN(dt.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
    data.incurredOn = dt
  }

  if (Object.keys(data).length === 0) return NextResponse.json(existing)

  const changedFields = Object.keys(data) // real field changes, before the edit stamp
  // Stamp who last edited (drives the details drawer's "last edited by").
  data.updatedById = session.userId
  data.updatedByName = session.name

  // Finalized-record integrity: changing the money — amount, category, or which
  // job it hits — on an APPROVED/REIMBURSED expense is an owner-only adjustment
  // that preserves history.
  const editsFinancials =
    (d.amountCents !== undefined && financialFieldChanged(existing.amount, d.amountCents)) ||
    (d.category !== undefined && existing.category !== d.category) ||
    bookingChanged
  const isAdjustment = isFinalizedExpenseStatus(existing.status) && editsFinancials
  if (isAdjustment) {
    if (!can(session.role as Role, 'money.edit_finalized_expense')) {
      return NextResponse.json({ error: 'This expense is finalized. Only an owner can adjust its amount or category, with a reason.' }, { status: 403 })
    }
    if (!d.adjustmentReason?.trim()) {
      return NextResponse.json({ error: 'A reason is required to adjust a finalized expense.' }, { status: 422 })
    }
  }

  const action = isAdjustment
    ? 'FINANCIAL_ADJUSTMENT' as const
    : d.status === 'APPROVED' ? 'EXPENSE_APPROVED' as const
    : d.status === 'REJECTED' ? 'EXPENSE_REJECTED' as const
    : 'EXPENSE_UPDATED' as const

  const [updated] = await prisma.$transaction([
    prisma.expense.update({ where: { id: params.id }, data }),
    prisma.auditLog.create({
      data: {
        action,
        userId: session.userId,
        bookingId: bookingChanged ? resolvedBookingId : existing.bookingId,
        details: {
          expenseId: existing.id,
          changed: changedFields,
          // before → after for the money fields, so history is recoverable.
          before: { status: existing.status, amountCents: existing.amount, category: existing.category, bookingId: existing.bookingId },
          after: {
            status: (data.status as string) ?? existing.status,
            amountCents: (data.amount as number) ?? existing.amount,
            category: (data.category as string) ?? existing.category,
            bookingId: bookingChanged ? resolvedBookingId : existing.bookingId,
          },
          reason: d.adjustmentReason ?? undefined,
          by: session.name,
        },
      },
    }),
  ])

  apiLogger.info({ expenseId: existing.id, action, adjustment: isAdjustment }, 'Expense updated')
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !can(session.role as Role, 'money.delete_expense')) {
    return NextResponse.json({ error: 'Only an owner can delete an expense' }, { status: 403 })
  }

  const existing = await prisma.expense.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.$transaction([
    prisma.expense.delete({ where: { id: params.id } }),
    prisma.auditLog.create({
      data: {
        action: 'EXPENSE_DELETED',
        userId: session.userId,
        bookingId: existing.bookingId,
        details: { expenseId: existing.id, amountCents: existing.amount, category: existing.category, by: session.name },
      },
    }),
  ])

  apiLogger.info({ expenseId: existing.id }, 'Expense deleted')
  return NextResponse.json({ ok: true })
}
