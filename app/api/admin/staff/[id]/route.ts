import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

const Schema = z.object({
  active: z.boolean().optional(),
  role: z.enum(['OWNER', 'MANAGER', 'CREW']).optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Owner only' }, { status: 403 })
  }

  // Prevent owner from modifying their own account via this endpoint
  if (params.id === session.userId) {
    return NextResponse.json({ error: 'Cannot modify your own account here' }, { status: 422 })
  }

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const data: Record<string, unknown> = {}
  if (parsed.data.active !== undefined) data.active = parsed.data.active
  if (parsed.data.role !== undefined) data.role = parsed.data.role

  const updated = await prisma.user.update({ where: { id: params.id }, data })

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_STATE_CHANGED',
      userId: session.userId,
      details: { action: 'staff_updated', targetUserId: params.id, changes: data, by: session.name } as Prisma.InputJsonValue,
    },
  })

  return NextResponse.json({ ok: true, user: { id: updated.id, name: updated.name, role: updated.role, active: updated.active } })
}
