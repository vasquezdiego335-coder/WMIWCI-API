import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { Prisma, RoadmapCategory, RoadmapPriority, RoadmapStatus, TaskOwner } from '@prisma/client'
import { z } from 'zod'

// Roadmap item update (increment 2): status/priority/owner/fields + append-only
// comments. NO DELETE handler by design — REJECTED/ARCHIVED are the terminal
// states, so planning history is never lost.

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  problem: z.string().trim().max(2000).nullable().optional(),
  solution: z.string().trim().max(4000).nullable().optional(),
  benefit: z.string().trim().max(2000).nullable().optional(),
  risks: z.string().trim().max(2000).nullable().optional(),
  priority: z.nativeEnum(RoadmapPriority).optional(),
  status: z.nativeEnum(RoadmapStatus).optional(),
  category: z.nativeEnum(RoadmapCategory).optional(),
  impact: z.number().int().min(1).max(5).nullable().optional(),
  effort: z.number().int().min(1).max(5).nullable().optional(),
  dependencies: z.string().trim().max(1000).nullable().optional(),
  blockers: z.string().trim().max(1000).nullable().optional(),
  assignedOwner: z.nativeEnum(TaskOwner).nullable().optional(),
  targetIncrement: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  rejectionReason: z.string().trim().max(1000).nullable().optional(),
  comment: z.string().trim().min(1).max(1000).optional(), // append-only
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const existing = await prisma.roadmapItem.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const { comment, ...fields } = parsed.data

  // Rejecting requires a reason (owner spec: lost/rejected always carries why).
  if (fields.status === 'REJECTED' && !fields.rejectionReason && !existing.rejectionReason) {
    return NextResponse.json({ error: 'A rejection reason is required to reject an idea' }, { status: 422 })
  }

  const data: Record<string, unknown> = { ...fields }
  if (fields.status === 'COMPLETED' && existing.status !== 'COMPLETED') data.completedAt = new Date()
  if (comment) {
    const prev = Array.isArray(existing.comments) ? (existing.comments as Prisma.JsonArray) : []
    data.comments = [...prev, { by: session.name, at: new Date().toISOString(), text: comment }]
  }

  if (Object.keys(data).length === 0) return NextResponse.json(existing)

  const updated = await prisma.roadmapItem.update({ where: { id: params.id }, data })

  await prisma.auditLog.create({
    data: {
      action: 'ROADMAP_UPDATED',
      userId: session.userId,
      details: {
        roadmapItemId: existing.id,
        title: existing.title,
        changed: Object.keys(data),
        from: { status: existing.status, priority: existing.priority, assignedOwner: existing.assignedOwner },
        to: { status: updated.status, priority: updated.priority, assignedOwner: updated.assignedOwner },
        by: session.name,
      },
    },
  })

  apiLogger.info({ roadmapItemId: existing.id, changed: Object.keys(data) }, 'Roadmap item updated')
  return NextResponse.json(updated)
}
