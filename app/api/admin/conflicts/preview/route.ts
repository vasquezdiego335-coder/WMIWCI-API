import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { previewAssignmentConflicts } from '@/lib/scheduling-service'
import { evaluateConflicts } from '@/lib/conflict-engine'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Conflict preview (Stage 5) — run the conflict engine for a proposed
//  assignment WITHOUT saving. Powers the "before you assign" panel and the
//  scheduling board's drag preview. Read-only; no mutation, no audit.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  jobId: z.string().min(1),
  userId: z.string().min(1),
  startAt: z.string().datetime().nullable().optional(),
  endAt: z.string().datetime().nullable().optional(),
  reportTime: z.string().datetime().nullable().optional(),
  isDriver: z.boolean().default(false),
  isLead: z.boolean().default(false),
  breakMinutes: z.number().int().min(0).max(480).nullable().optional(),
  excludeJobCrewId: z.string().nullable().optional(),
  overrideCodes: z.array(z.string().max(80)).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'schedule.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const conflicts = await previewAssignmentConflicts({
    jobId: d.jobId, userId: d.userId,
    startAt: d.startAt ? new Date(d.startAt) : null,
    endAt: d.endAt ? new Date(d.endAt) : null,
    reportTime: d.reportTime ? new Date(d.reportTime) : null,
    isDriver: d.isDriver, isLead: d.isLead, breakMinutes: d.breakMinutes,
    excludeJobCrewId: d.excludeJobCrewId ?? null,
  })
  const decision = evaluateConflicts(conflicts, d.overrideCodes ?? [])
  return NextResponse.json({ conflicts, canProceed: decision.canProceed, hard: decision.hard, unresolvedWarnings: decision.unresolvedWarnings })
}
