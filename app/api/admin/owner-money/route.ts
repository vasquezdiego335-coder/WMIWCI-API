import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { TaskOwner, OwnerTransactionType, PaymentMethod, ApprovalStatus } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { z } from 'zod'

// Owner money ledger (owner spec 2026-07-13). Kept OUT of business expenses on
// purpose so Diego's / Sebastian's personal cash never contaminates job profit.

const CreateSchema = z.object({
  owner: z.nativeEnum(TaskOwner),
  amountCents: z.number().int().positive().max(1_000_000_00),
  type: z.nativeEnum(OwnerTransactionType),
  occurredOn: z.string().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  explanation: z.string().trim().max(500).optional(),
  receiptUrl: z.string().url().max(1000).optional(),
  receiptPublicId: z.string().trim().max(300).optional(),
  bookingId: z.string().trim().optional(),
  approvalStatus: z.nativeEnum(ApprovalStatus).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  // Owner money is owner-only authority (managers do not manage owner cash).
  if (!can(session.role as Role, 'money.create_owner_transaction')) {
    return NextResponse.json({ error: 'Only an owner can record owner money.' }, { status: 403 })
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const occurredOn = d.occurredOn ? new Date(d.occurredOn) : new Date()
  if (Number.isNaN(occurredOn.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 422 })

  const tx = await prisma.$transaction(async (t) => {
    const created = await t.ownerTransaction.create({
      data: {
        owner: d.owner,
        amount: d.amountCents,
        type: d.type,
        occurredOn,
        paymentMethod: d.paymentMethod ?? null,
        explanation: d.explanation || null,
        receiptUrl: d.receiptUrl || null,
        receiptPublicId: d.receiptPublicId || null,
        bookingId: d.bookingId || null,
        approvalStatus: d.approvalStatus ?? ApprovalStatus.PENDING,
        createdById: session.userId,
        createdByName: session.name,
      },
    })
    await t.auditLog.create({
      data: {
        action: 'OWNER_TRANSACTION_CREATED',
        userId: session.userId,
        details: { ownerTransactionId: created.id, owner: created.owner, type: created.type, amountCents: created.amount, by: session.name },
      },
    })
    return created
  })

  apiLogger.info({ ownerTransactionId: tx.id, owner: tx.owner, type: tx.type }, 'Owner transaction created')
  return NextResponse.json(tx, { status: 201 })
}
