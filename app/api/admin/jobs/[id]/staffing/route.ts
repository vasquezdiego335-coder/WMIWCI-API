import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { buildStaffingContext } from '@/lib/scheduling-service'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Job staffing requirement + live staffing context (Stage 5).
//  [id] is the JOB id.
//   GET  the full staffing picture (requirement + assignments + conflicts + health)
//   PUT  create/update the staffing requirement (owner or manager — operations)
// ════════════════════════════════════════════════════════════════════════════

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'schedule.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const ctx = await buildStaffingContext(params.id)
  if (!ctx) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  return NextResponse.json(ctx)
}

const Schema = z.object({
  minWorkers: z.number().int().min(0).max(50).optional(),
  requiredWorkers: z.number().int().min(0).max(50).optional(),
  preferredWorkers: z.number().int().min(0).max(50).nullable().optional(),
  requiredDrivers: z.number().int().min(0).max(50).optional(),
  requiresLead: z.boolean().optional(),
  requiredSkills: z.array(z.enum(['PACKING', 'FURNITURE_PROTECTION', 'ASSEMBLY', 'HEAVY_ITEMS', 'STAIR_CARRY', 'DRIVING', 'LEAD', 'LOADING', 'UNLOADING'])).optional(),
  estimatedStartAt: z.string().datetime().nullable().optional(),
  estimatedEndAt: z.string().datetime().nullable().optional(),
  reportTime: z.string().datetime().nullable().optional(),
  expectedBreakMinutes: z.number().int().min(0).max(480).nullable().optional(),
  additionalStops: z.number().int().min(0).max(20).optional(),
  hasStairs: z.boolean().optional(),
  hasElevator: z.boolean().optional(),
  longCarry: z.boolean().optional(),
  heavyItems: z.boolean().optional(),
  packing: z.boolean().optional(),
  assembly: z.boolean().optional(),
  customerProvidedTruck: z.boolean().optional(),
  rentalTruckPickup: z.boolean().optional(),
  drivingRequired: z.boolean().optional(),
  outOfState: z.boolean().optional(),
  loadingLocation: z.string().trim().max(300).nullable().optional(),
  unloadingLocation: z.string().trim().max(300).nullable().optional(),
  workerInstructions: z.string().trim().max(2000).nullable().optional(),
  privateNotes: z.string().trim().max(2000).nullable().optional(),
})

export async function PUT(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'schedule.manage')) return NextResponse.json({ error: 'Only an owner or manager can set staffing requirements.' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const job = await prisma.job.findUnique({ where: { id: params.id }, select: { id: true, bookingId: true, staffingReq: { select: { id: true } } } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const data: Record<string, unknown> = { updatedById: session.userId }
  for (const k of ['minWorkers', 'requiredWorkers', 'preferredWorkers', 'requiredDrivers', 'requiresLead', 'requiredSkills', 'expectedBreakMinutes', 'additionalStops', 'hasStairs', 'hasElevator', 'longCarry', 'heavyItems', 'packing', 'assembly', 'customerProvidedTruck', 'rentalTruckPickup', 'drivingRequired', 'outOfState', 'loadingLocation', 'unloadingLocation', 'workerInstructions', 'privateNotes'] as const) {
    if (d[k] !== undefined) data[k] = d[k]
  }
  for (const k of ['estimatedStartAt', 'estimatedEndAt', 'reportTime'] as const) {
    if (d[k] !== undefined) data[k] = d[k] ? new Date(d[k]!) : null
  }

  const before = job.staffingReq
  await prisma.$transaction(async (tx) => {
    await tx.jobStaffingRequirement.upsert({
      where: { jobId: params.id },
      create: { jobId: params.id, createdById: session.userId, ...data },
      update: data,
    })
    await tx.auditLog.create({
      data: {
        action: 'STAFFING_REQUIREMENT_CHANGED',
        userId: session.userId,
        bookingId: job.bookingId,
        details: { jobId: params.id, created: !before, changed: Object.keys(data), by: session.name } as never,
      },
    })
  })

  const ctx = await buildStaffingContext(params.id)
  return NextResponse.json(ctx)
}
