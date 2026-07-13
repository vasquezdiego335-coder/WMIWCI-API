import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { ROADMAP_SEED } from '@/lib/roadmap-seed'
import { RoadmapCategory, RoadmapPriority, RoadmapStatus } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'

// Idempotent roadmap seeding (increment 2, owner-only in 2.1): loads the known
// admin gaps as structured items. seedKey uniqueness means re-running NEVER
// duplicates and NEVER overwrites owner edits — only missing keys are inserted.
// createMany(skipDuplicates) makes concurrent seed requests safe too.

export async function POST(): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'roadmap.seed')) {
    return NextResponse.json({ error: 'Only an owner can load the roadmap seed.' }, { status: 403 })
  }

  const existing = await prisma.roadmapItem.findMany({
    where: { seedKey: { in: ROADMAP_SEED.map((s) => s.seedKey) } },
    select: { seedKey: true },
  })
  const have = new Set(existing.map((e) => e.seedKey))
  const missing = ROADMAP_SEED.filter((s) => !have.has(s.seedKey))

  if (missing.length > 0) {
    await prisma.roadmapItem.createMany({
      data: missing.map((s) => ({
        seedKey: s.seedKey,
        title: s.title,
        summary: s.summary,
        problem: s.problem,
        solution: s.solution,
        benefit: s.benefit,
        risks: s.risks,
        priority: s.priority as RoadmapPriority,
        status: s.status as RoadmapStatus,
        category: s.category as RoadmapCategory,
        impact: s.impact,
        effort: s.effort,
        dependencies: s.dependencies,
        blockers: s.blockers,
        targetIncrement: s.targetIncrement,
        notes: s.notes,
        completedAt: s.status === 'COMPLETED' ? new Date() : null,
        createdBy: 'seed',
      })),
      skipDuplicates: true,
    })
    await prisma.auditLog.create({
      data: {
        action: 'ROADMAP_CREATED',
        userId: session.userId,
        details: { seeded: missing.length, keys: missing.map((m) => m.seedKey), by: session.name },
      },
    })
  }

  apiLogger.info({ seeded: missing.length, skipped: have.size }, 'Roadmap seed complete')
  return NextResponse.json({ seeded: missing.length, skipped: have.size })
}
