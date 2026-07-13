import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { ExpenseCategory, ExpenseStatus, PaymentMethod } from '@prisma/client'
import { z } from 'zod'

// Update / delete a single expense (owner spec 2026-07-13). Status changes and
// deletions are logged to the audit trail (who / what / when). Deletion is
// OWNER-only — it's on the "require confirmation" list; the client confirms and
// only owners may remove a money record.

const PatchSchema = z.object({
  status: z.nativeEnum(ExpenseStatus).optional(),
  amountCents: z.number().int().positive().max(100_000_00).optional(),
  category: z.nativeEnum(ExpenseCategory).optional(),
  incurredOn: z.string().optional(),
  vendor: z.string().trim().max(200).nullable().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).nullable().optional(),
  paidBy: z.string().trim().max(120).nullable().optional(),
  purpose: z.string().trim().max(500).nullable().optional(),
  reimbursable: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const existing = await prisma.expense.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const data: Record<string, unknown> = {}
  if (d.amountCents !== undefined) data.amount = d.amountCents
  if (d.category !== undefined) data.category = d.category
  if (d.vendor !== undefined) data.vendor = d.vendor || null
  if (d.paymentMethod !== undefined) data.paymentMethod = d.paymentMethod
  if (d.paidBy !== undefined) data.paidBy = d.paidBy || null
  if (d.purpose !== undefined) data.purpose = d.purpose || null
  if (d.reimbursable !== undefined) data.reimbursable = d.reimbursable
  if (d.notes !== undefined) data.notes = d.notes || null
  if (d.status !== undefined) data.status = d.status
  if (d.incurredOn !== undefined) {
    const dt = new Date(d.incurredOn)
    if (Number.isNaN(dt.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
    data.incurredOn = dt
  }

  if (Object.keys(data).length === 0) return NextResponse.json(existing)

  const updated = await prisma.expense.update({ where: { id: params.id }, data })

  const action =
    d.status === 'APPROVED' ? 'EXPENSE_APPROVED' : d.status === 'REJECTED' ? 'EXPENSE_REJECTED' : 'EXPENSE_UPDATED'
  await prisma.auditLog.create({
    data: {
      action,
      userId: session.userId,
      bookingId: existing.bookingId,
      details: { expenseId: existing.id, changed: Object.keys(data), from: { status: existing.status, amountCents: existing.amount }, by: session.name },
    },
  })

  apiLogger.info({ expenseId: existing.id, action }, 'Expense updated')
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only an owner can delete an expense' }, { status: 403 })
  }

  const existing = await prisma.expense.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.expense.delete({ where: { id: params.id } })
  await prisma.auditLog.create({
    data: {
      action: 'EXPENSE_DELETED',
      userId: session.userId,
      bookingId: existing.bookingId,
      details: { expenseId: existing.id, amountCents: existing.amount, category: existing.category, by: session.name },
    },
  })

  apiLogger.info({ expenseId: existing.id }, 'Expense deleted')
  return NextResponse.json({ ok: true })
}
