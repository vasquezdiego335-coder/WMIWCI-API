import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { ApprovalStatus } from '@prisma/client'
import { z } from 'zod'

// Approve / reject / delete an owner transaction (owner spec 2026-07-13).
// Changing a profit distribution and deleting a money record are on the "require
// confirmation" list — deletion is OWNER-only; the client confirms.

const PatchSchema = z.object({ approvalStatus: z.nativeEnum(ApprovalStatus) })

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const existing = await prisma.ownerTransaction.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const updated = await prisma.ownerTransaction.update({ where: { id: params.id }, data: { approvalStatus: parsed.data.approvalStatus } })
  await prisma.auditLog.create({
    data: {
      action: 'OWNER_TRANSACTION_UPDATED',
      userId: session.userId,
      details: { ownerTransactionId: existing.id, from: existing.approvalStatus, to: parsed.data.approvalStatus, by: session.name },
    },
  })
  apiLogger.info({ ownerTransactionId: existing.id, to: parsed.data.approvalStatus }, 'Owner transaction updated')
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only an owner can delete an owner transaction' }, { status: 403 })
  }
  const existing = await prisma.ownerTransaction.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.ownerTransaction.delete({ where: { id: params.id } })
  await prisma.auditLog.create({
    data: {
      action: 'OWNER_TRANSACTION_DELETED',
      userId: session.userId,
      details: { ownerTransactionId: existing.id, owner: existing.owner, type: existing.type, amountCents: existing.amount, by: session.name },
    },
  })
  apiLogger.info({ ownerTransactionId: existing.id }, 'Owner transaction deleted')
  return NextResponse.json({ ok: true })
}
