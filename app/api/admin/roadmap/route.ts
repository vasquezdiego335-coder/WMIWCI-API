import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { RoadmapCategory, RoadmapPriority, RoadmapStatus, TaskOwner } from '@prisma/client'
import { z } from 'zod'

// Ideas & Roadmap create (increment 2). Structured planning records — no hard
// delete anywhere (REJECTED/ARCHIVED are the terminal states).

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2000).optional(),
  problem: z.string().trim().max(2000).optional(),
  solution: z.string().trim().max(4000).optional(),
  benefit: z.string().trim().max(2000).optional(),
  risks: z.string().trim().max(2000).optional(),
  priority: z.nativeEnum(RoadmapPriority).optional(),
  status: z.nativeEnum(RoadmapStatus).optional(),
  category: z.nativeEnum(RoadmapCategory).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  effort: z.number().int().min(1).max(5).optional(),
  dependencies: z.string().trim().max(1000).optional(),
  blockers: z.string().trim().max(1000).optional(),
  assignedOwner: z.nativeEnum(TaskOwner).optional(),
  targetIncrement: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(4000).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })

  const item = await prisma.roadmapItem.create({
    data: { ...parsed.data, createdBy: session.name },
  })

  await prisma.auditLog.create({
    data: {
      action: 'ROADMAP_CREATED',
      userId: session.userId,
      details: { roadmapItemId: item.id, title: item.title, category: item.category, priority: item.priority, by: session.name },
    },
  })

  apiLogger.info({ roadmapItemId: item.id }, 'Roadmap item created')
  return NextResponse.json(item, { status: 201 })
}
