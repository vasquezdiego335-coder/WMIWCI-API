import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'

// ════════════════════════════════════════════════════════════════════════════
//  Delete one availability rule OR exception (Stage 5).
//  [id] = user, [itemId] = rule or exception id. `?type=rule|exception`.
//  Availability is not financial history, so deletion is allowed (with audit).
// ════════════════════════════════════════════════════════════════════════════

export async function DELETE(req: NextRequest, { params }: { params: { id: string; itemId: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'staff.manage_availability')) return NextResponse.json({ error: 'You do not have permission to manage availability.' }, { status: 403 })

  const type = req.nextUrl.searchParams.get('type') ?? 'rule'
  if (type === 'exception') {
    const row = await prisma.availabilityException.findUnique({ where: { id: params.itemId }, select: { userId: true } })
    if (!row || row.userId !== params.id) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await prisma.availabilityException.delete({ where: { id: params.itemId } })
    await prisma.auditLog.create({ data: { action: 'AVAILABILITY_EXCEPTION_DELETED', userId: session.userId, details: { targetUserId: params.id, exceptionId: params.itemId, by: session.name } as never } })
    return NextResponse.json({ ok: true })
  }

  const row = await prisma.availabilityRule.findUnique({ where: { id: params.itemId }, select: { userId: true } })
  if (!row || row.userId !== params.id) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.availabilityRule.delete({ where: { id: params.itemId } })
  await prisma.auditLog.create({ data: { action: 'AVAILABILITY_RULE_DELETED', userId: session.userId, details: { targetUserId: params.id, ruleId: params.itemId, by: session.name } as never } })
  return NextResponse.json({ ok: true })
}
