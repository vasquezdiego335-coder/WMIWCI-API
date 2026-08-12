import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { LeadLostReason } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { applyLeadAction, LEAD_ACTIONS } from '@/lib/lead-transitions'
import { z } from 'zod'

// Lead pipeline transitions (Moving OS Phase 1, Stage 2C). Writes the
// previously-dead statuses (CONTACTED / FOLLOW_UP / LOST) + contactedAt /
// lostReason / assignedTo, and wires the dead LEAD_STATUS_CHANGED audit
// action. All transition POLICY lives in src/lib/lead-transitions.ts (pure,
// offline-tested) — this route only authenticates, validates shape, and
// commits update + audit in ONE transaction (house pattern, expenses route).
// BOOKED is never reachable from here: only markLeadConverted writes it.

const PatchSchema = z.object({
  action: z.enum(LEAD_ACTIONS as [string, ...string[]]),
  lostReason: z.nativeEnum(LeadLostReason).optional(),
  assignedTo: z.string().trim().max(120).nullable().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'lead.manage')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const lead = await prisma.lead.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, contactedAt: true, assignedTo: true, lostReason: true },
  })
  if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data
  const action = d.action as (typeof LEAD_ACTIONS)[number]

  const result = applyLeadAction(lead, action, { lostReason: d.lostReason, assignedTo: d.assignedTo })
  if (result.error !== undefined) return NextResponse.json({ error: result.error }, { status: 422 })

  const to = (result.data.status as string | undefined) ?? lead.status
  const [updated] = await prisma.$transaction([
    prisma.lead.update({
      where: { id: lead.id },
      data: result.data,
      select: { id: true, status: true, contactedAt: true, lostReason: true, lostAt: true, assignedTo: true },
    }),
    prisma.auditLog.create({
      data: {
        action: 'LEAD_STATUS_CHANGED',
        userId: session.userId,
        details: {
          leadId: lead.id,
          action,
          from: lead.status,
          to,
          // reason only carries a value for mark_lost; assignment changes record
          // the before → after assignee instead.
          reason: d.lostReason ?? undefined,
          ...(action === 'assign'
            ? { assignedFrom: lead.assignedTo, assignedTo: (result.data.assignedTo as string | null) ?? null }
            : {}),
          by: session.name,
        },
      },
    }),
  ])

  apiLogger.info({ leadId: lead.id, action, from: lead.status, to }, 'Lead pipeline action applied')
  return NextResponse.json(updated)
}
