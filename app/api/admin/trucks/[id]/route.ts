import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { TruckSource, TruckStatus } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { z } from 'zod'

// Moving OS Phase 1 — edit one fleet truck (owner spec 2026-08-11).
// PATCH name/size/source/status/capacityNotes/active — truck.manage. Update +
// TRUCK_UPDATED audit (before → after) commit in ONE transaction, mirroring
// /api/admin/expenses/[id]. There is no DELETE: trucks are deactivated
// (active=false) or RETIRED so historical bookings keep their assignment.

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  size: z.string().trim().min(1).max(40).optional(),
  source: z.nativeEnum(TruckSource).optional(),
  status: z.nativeEnum(TruckStatus).optional(),
  capacityNotes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'truck.manage')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const existing = await prisma.truck.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (d.name !== undefined) data.name = d.name
  if (d.size !== undefined) data.size = d.size
  if (d.source !== undefined) data.source = d.source
  if (d.status !== undefined) data.status = d.status
  if (d.capacityNotes !== undefined) data.capacityNotes = d.capacityNotes || null
  if (d.active !== undefined) data.active = d.active

  if (Object.keys(data).length === 0) return NextResponse.json(existing)

  const [updated] = await prisma.$transaction([
    prisma.truck.update({ where: { id: params.id }, data }),
    prisma.auditLog.create({
      data: {
        action: 'TRUCK_UPDATED',
        userId: session.userId,
        details: {
          truckId: existing.id,
          changed: Object.keys(data),
          // before → after for the operational fields, so history is recoverable.
          before: { name: existing.name, size: existing.size, source: existing.source, status: existing.status, active: existing.active },
          after: {
            name: (data.name as string) ?? existing.name,
            size: (data.size as string) ?? existing.size,
            source: (data.source as string) ?? existing.source,
            status: (data.status as string) ?? existing.status,
            active: (data.active as boolean) ?? existing.active,
          },
          by: session.name,
        },
      },
    }),
  ])

  apiLogger.info({ truckId: existing.id, changed: Object.keys(data) }, 'Truck updated')
  return NextResponse.json(updated)
}
