// ════════════════════════════════════════════════════════════════════════
//  AGENT INCIDENTS — /api/admin/email-marketing/agent/incidents
//  ---------------------------------------------------------------------
//  GET   — list, or one incident with its full timeline.
//  PATCH — a human's verdict on an incident: resolve, ignore, or reopen.
//
//  WHY A HUMAN CAN "IGNORE" BUT THE AGENT CANNOT: an owner marking something a
//  false positive is information the agent should learn from, so ignoring
//  records a LESSON with the false-positive flag set. The confidence of that
//  pattern falls, and future cycles weigh it accordingly. The agent itself has
//  no path to dismissing its own findings — that would let it quiet the alarm
//  instead of fixing the fire.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { addIncidentEvent } from '@/lib/email-agent/incidents'
import { recordLesson } from '@/lib/email-agent/memory'
import { safeErrorMessage } from '@/lib/email-agent/redact'

export const dynamic = 'force-dynamic'

const log = apiLogger.child({ route: 'admin/email-marketing/agent/incidents' })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  const status = req.nextUrl.searchParams.get('status')

  try {
    if (id) {
      const incident = await prisma.emailAgentIncident.findUnique({
        where: { id },
        include: {
          events: { orderBy: { createdAt: 'asc' }, take: 100 },
          findings: { orderBy: { detectedAt: 'desc' }, take: 50 },
          actions: { orderBy: { startedAt: 'desc' }, take: 50 },
          approvals: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      })
      if (!incident) return NextResponse.json({ error: 'That incident does not exist.' }, { status: 404 })
      return NextResponse.json({ incident })
    }

    const where =
      status === 'all'
        ? {}
        : status === 'resolved'
          ? { status: { in: ['resolved', 'ignored'] } }
          : { status: { in: ['open', 'investigating', 'awaiting_approval', 'mitigated'] } }

    const incidents = await prisma.emailAgentIncident.findMany({
      where,
      orderBy: [{ lastDetectedAt: 'desc' }],
      take: 100,
      include: { _count: { select: { findings: true, actions: true, approvals: true } } },
    })
    return NextResponse.json({ incidents })
  } catch (err) {
    log.error({ err: safeErrorMessage(err) }, 'incident read failed')
    return NextResponse.json({ error: safeErrorMessage(err) }, { status: 503 })
  }
}

const patchSchema = z.object({
  incidentId: z.string().min(1).max(64),
  action: z.enum(['resolve', 'ignore', 'reopen', 'reinvestigate']),
  note: z.string().min(1).max(2000),
})

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  // Closing an incident is an operational judgement, so it needs the same
  // permission as changing campaign state — not merely the right to look.
  const deny = denyReason(session?.role as Role, 'email.manage_campaign')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 })
  }
  const { incidentId, action, note } = parsed.data
  const actorName = session?.name ?? session?.email ?? 'admin'
  const actor = `owner:${session?.userId ?? 'unknown'}`

  try {
    const incident = await prisma.emailAgentIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, reference: true, status: true, title: true, fingerprint: true, findings: { select: { checkId: true }, take: 20 } },
    })
    if (!incident) return NextResponse.json({ error: 'That incident does not exist.' }, { status: 404 })

    // ── REINVESTIGATE ────────────────────────────────────────────────────
    // The escape hatch that makes aggressive AI deduplication safe. An
    // unchanged incident normally costs nothing because the agent will not
    // re-read identical evidence — but an operator who wants a fresh opinion
    // must be able to buy one. The next cycle honours the flag and clears it.
    if (action === 'reinvestigate') {
      await prisma.emailAgentIncident.update({
        where: { id: incidentId },
        data: { reinvestigateRequestedAt: new Date() },
      })
      await addIncidentEvent(incidentId, 'note', `${actorName} requested a fresh investigation: ${note}`, undefined, actor)
      return NextResponse.json({
        ok: true,
        note: 'The next agent cycle will investigate this incident, whether or not its evidence changed.',
      })
    }

    if (action === 'reopen') {
      await prisma.emailAgentIncident.update({ where: { id: incidentId }, data: { status: 'open', resolvedAt: null, resolution: null, resolutionKind: null } })
      await addIncidentEvent(incidentId, 'reopened', `Reopened by ${actorName}: ${note}`, undefined, actor)
      return NextResponse.json({ ok: true })
    }

    const resolved = action === 'resolve'
    await prisma.emailAgentIncident.update({
      where: { id: incidentId },
      data: {
        status: resolved ? 'resolved' : 'ignored',
        resolvedAt: new Date(),
        resolution: note.slice(0, 2000),
        resolutionKind: resolved ? 'human_resolved' : 'false_positive',
      },
    })
    await addIncidentEvent(incidentId, 'resolved', `${resolved ? 'Resolved' : 'Marked a false positive'} by ${actorName}: ${note}`, undefined, actor)

    // THE FEEDBACK LOOP. A human verdict teaches the pattern, in both
    // directions: a real fix records what worked, a false positive lowers the
    // confidence so the agent trusts that pattern less next time.
    const checkIds = Array.from(new Set(incident.findings.map((f) => f.checkId)))
    await recordLesson({
      patternKey: incident.fingerprint.split(':')[0] || incident.fingerprint,
      title: incident.title,
      probableCause: resolved ? note.slice(0, 1000) : `Reported by ${checkIds.join(', ')} but the owner judged it a false positive.`,
      successfulResolution: resolved ? note.slice(0, 1000) : null,
      checkIds,
      falsePositive: !resolved,
    }).catch((err) => log.warn({ err: safeErrorMessage(err) }, 'could not record the lesson from a human verdict'))

    log.info({ incident: incident.reference, action, by: actorName }, 'incident closed by a human')
    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), incidentId }, 'incident update failed')
    return NextResponse.json({ error: safeErrorMessage(err) }, { status: 500 })
  }
}
