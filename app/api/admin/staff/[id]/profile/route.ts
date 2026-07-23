import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Staff profile: skills, driver eligibility, license, worker status, contact
//  (Stage 5). Owner-only (staff.manage). Separate from /rates (Stage 4 money)
//  and from the minimal role/active route so each concern is audited distinctly.
// ════════════════════════════════════════════════════════════════════════════

const SKILLS = ['PACKING', 'FURNITURE_PROTECTION', 'ASSEMBLY', 'HEAVY_ITEMS', 'STAIR_CARRY', 'DRIVING', 'LEAD', 'LOADING', 'UNLOADING'] as const

const Schema = z.object({
  phone: z.string().trim().max(40).nullable().optional(),
  workerStatus: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'UNAVAILABLE', 'SUSPENDED']).optional(),
  skills: z.array(z.enum(SKILLS)).optional(),
  canDrive: z.boolean().optional(),
  canDriveCustomerVehicle: z.boolean().optional(),
  canLeadCrew: z.boolean().optional(),
  licenseExpiresAt: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  preferredRole: z.string().trim().max(60).nullable().optional(),
  performanceNotes: z.string().trim().max(2000).nullable().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'staff.manage')) return NextResponse.json({ error: 'Only an owner can edit a staff profile.' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const before = await prisma.user.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, phone: true, workerStatus: true, skills: true, canDrive: true, canDriveCustomerVehicle: true, canLeadCrew: true, licenseExpiresAt: true, preferredRole: true },
  })
  if (!before) return NextResponse.json({ error: 'Staff member not found' }, { status: 404 })

  const data: Record<string, unknown> = { updatedById: session.userId }
  for (const k of ['phone', 'workerStatus', 'skills', 'canDrive', 'canDriveCustomerVehicle', 'canLeadCrew', 'preferredRole', 'performanceNotes'] as const) {
    if (d[k] !== undefined) data[k] = d[k]
  }
  for (const k of ['licenseExpiresAt', 'startDate'] as const) {
    if (d[k] === undefined) continue
    if (!d[k]) { data[k] = null; continue }
    const dt = new Date(d[k] as string)
    if (Number.isNaN(dt.getTime())) return NextResponse.json({ error: `${k} is not a valid date.` }, { status: 422 })
    data[k] = dt
  }

  const updated = await prisma.user.update({ where: { id: params.id }, data })

  const skillsChanged = d.skills !== undefined && JSON.stringify(before.skills) !== JSON.stringify(d.skills)
  const driverChanged = (d.canDrive !== undefined && d.canDrive !== before.canDrive) || (d.canDriveCustomerVehicle !== undefined && d.canDriveCustomerVehicle !== before.canDriveCustomerVehicle)

  await prisma.$transaction([
    prisma.auditLog.create({ data: { action: 'STAFF_PROFILE_UPDATED', userId: session.userId, details: { targetUserId: params.id, changed: Object.keys(data), by: session.name } as never } }),
    ...(skillsChanged ? [prisma.auditLog.create({ data: { action: 'STAFF_SKILLS_CHANGED', userId: session.userId, details: { targetUserId: params.id, from: before.skills, to: d.skills, by: session.name } as never } })] : []),
    ...(driverChanged ? [prisma.auditLog.create({ data: { action: 'STAFF_DRIVER_STATUS_CHANGED', userId: session.userId, details: { targetUserId: params.id, canDrive: updated.canDrive, canDriveCustomerVehicle: updated.canDriveCustomerVehicle, by: session.name } as never } })] : []),
  ])

  return NextResponse.json({
    ok: true,
    user: { id: updated.id, name: updated.name, workerStatus: updated.workerStatus, skills: updated.skills, canDrive: updated.canDrive, canLeadCrew: updated.canLeadCrew, licenseExpiresAt: updated.licenseExpiresAt },
  })
}
