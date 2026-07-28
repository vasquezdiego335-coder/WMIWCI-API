// ════════════════════════════════════════════════════════════════════════
//  AGENT APPROVALS — /api/admin/email-marketing/agent/approvals
//  ---------------------------------------------------------------------
//  GET   — pending decisions with everything a person needs to decide.
//  PATCH — approve, reject, or approve-and-execute.
//
//  THE SERVER IS THE GATE. Approving here sets a status; it does not perform
//  anything by itself. Execution still goes through `executeTool()`, which
//  re-validates the approval, re-computes the resource checksum, and refuses if
//  the campaign changed after the human looked at it. Two independent checks,
//  because "I approved this" and "this is still the thing I approved" are
//  different claims and only the second one protects a customer.
//
//  APPROVING IS NOT EXECUTING. They are separate request bodies on purpose:
//  an owner can bank a decision and let the next agent cycle act on it, or
//  approve and run it in the same click, and the audit trail distinguishes the
//  two.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import crypto from 'node:crypto'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { addIncidentEvent } from '@/lib/email-agent/incidents'
import { classify } from '@/lib/email-agent/policy'
import { safeErrorMessage } from '@/lib/email-agent/redact'
import { loadSettings } from '@/lib/email-agent/settings'
import { executeTool, resourceChecksum, type ToolContext } from '@/lib/email-agent/tools'

export const dynamic = 'force-dynamic'

const log = apiLogger.child({ route: 'admin/email-marketing/agent/approvals' })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const status = req.nextUrl.searchParams.get('status') ?? 'pending'
  try {
    const approvals = await prisma.emailAgentApproval.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { incident: { select: { id: true, reference: true, title: true, severity: true } } },
    })

    // Surface staleness in the LIST, not only at execution time. An owner
    // should be able to see that a decision has gone out of date before they
    // click, rather than being told after.
    const now = new Date()
    const withState = await Promise.all(
      approvals.map(async (a) => {
        const expired = a.expiresAt <= now
        let resourceChanged = false
        if (a.status === 'pending' && !expired) {
          const current = await resourceChecksum((a.arguments ?? {}) as Record<string, unknown>).catch(() => null)
          resourceChanged = current !== null && current !== a.resourceChecksum
        }
        return { ...a, expired, resourceChanged }
      })
    )
    return NextResponse.json({ approvals: withState })
  } catch (err) {
    log.error({ err: safeErrorMessage(err) }, 'approval read failed')
    return NextResponse.json({ error: safeErrorMessage(err) }, { status: 503 })
  }
}

const patchSchema = z.object({
  approvalId: z.string().min(1).max(64),
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(1000).optional(),
  /** Approve AND run it now, in one step. */
  execute: z.boolean().optional(),
})

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  // Approving an agent action authorises a production change. It requires the
  // permission to manage campaigns, not merely to view them.
  const deny = denyReason(session?.role as Role, 'email.manage_campaign')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 })
  }
  const { approvalId, decision, note, execute } = parsed.data
  const actorName = session?.name ?? session?.email ?? 'admin'
  const actorId = session?.userId ?? null

  try {
    const approval = await prisma.emailAgentApproval.findUnique({ where: { id: approvalId } })
    if (!approval) return NextResponse.json({ error: 'That approval request does not exist.' }, { status: 404 })
    if (approval.status !== 'pending') {
      return NextResponse.json({ error: `That request is already ${approval.status}. It cannot be decided again.` }, { status: 409 })
    }

    const now = new Date()
    if (approval.expiresAt <= now) {
      await prisma.emailAgentApproval.update({
        where: { id: approvalId },
        data: { status: 'expired', invalidationReason: 'It expired before it was answered.' },
      })
      return NextResponse.json({ error: 'That request expired before it was answered. The agent will ask again if the problem is still there.' }, { status: 409 })
    }

    if (decision === 'reject') {
      await prisma.emailAgentApproval.update({
        where: { id: approvalId },
        data: { status: 'rejected', decidedById: actorId, decidedByName: actorName, decidedAt: now, decisionNote: note ?? null },
      })
      if (approval.incidentId) {
        await addIncidentEvent(approval.incidentId, 'rejected', `${actorName} rejected ${approval.toolName}${note ? `: ${note}` : '.'}`, undefined, `owner:${actorId}`)
        // The incident goes back to open: rejecting the proposal does not make
        // the problem go away, and leaving it awaiting_approval would hide it.
        await prisma.emailAgentIncident.update({ where: { id: approval.incidentId }, data: { status: 'open' } }).catch(() => undefined)
      }
      log.info({ approval: approval.reference, by: actorName }, 'approval rejected')
      return NextResponse.json({ ok: true, status: 'rejected' })
    }

    // ── APPROVE. Re-verify the resource has not moved under the owner. ────
    const current = await resourceChecksum((approval.arguments ?? {}) as Record<string, unknown>)
    if (current !== approval.resourceChecksum) {
      await prisma.emailAgentApproval.update({
        where: { id: approvalId },
        data: { status: 'invalidated', invalidationReason: 'The campaign, run or send changed after the request was created.' },
      })
      return NextResponse.json(
        { error: 'The campaign, run or send changed since this request was created, so approving it would authorise something different from what was described. The request has been invalidated and the agent will ask again.' },
        { status: 409 }
      )
    }

    // ATOMIC CLAIM. Two concurrent requests (a double-click, two tabs, a retry)
    // both read `pending`; only the one whose UPDATE matches a still-pending row
    // wins. Reading and then writing would let both proceed.
    const claimed = await prisma.emailAgentApproval.updateMany({
      where: { id: approvalId, status: 'pending' },
      data: { status: 'approved', decidedById: actorId, decidedByName: actorName, decidedAt: now, decisionNote: note ?? null },
    })
    if (claimed.count !== 1) {
      return NextResponse.json({ error: 'That request was already decided by another request. Nothing was executed twice.' }, { status: 409 })
    }
    if (approval.incidentId) {
      await addIncidentEvent(approval.incidentId, 'approved', `${actorName} approved ${approval.toolName}${note ? `: ${note}` : '.'}`, undefined, `owner:${actorId}`)
    }
    log.warn({ approval: approval.reference, tool: approval.toolName, by: actorName }, 'approval GRANTED')

    if (!execute) {
      return NextResponse.json({ ok: true, status: 'approved', executed: false })
    }

    // ── EXECUTE UNDER THE HUMAN'S NAME ────────────────────────────────────
    // The actor is the owner, not the agent, because a person authorised this.
    // executeTool still runs every gate, including validating this very
    // approval a second time.
    const settings = await loadSettings()
    const policy = classify(approval.toolName, settings.mode)
    if (policy.classification === 'forbidden') {
      return NextResponse.json({ error: `Approved, but ${approval.toolName} is forbidden and cannot be executed: ${policy.reason}` }, { status: 403 })
    }

    // EXACTLY-ONCE EXECUTION. `executedAt` is claimed BEFORE the tool runs, in
    // a conditional update. A second request — or the same one retried — finds
    // executedAt already set and stops without executing. The tool's own
    // idempotency key is the second line of defence; this is the first.
    const executionClaim = await prisma.emailAgentApproval.updateMany({
      where: { id: approvalId, executedAt: null },
      data: { executedAt: now, executedById: actorId },
    })
    if (executionClaim.count !== 1) {
      return NextResponse.json(
        { ok: true, status: 'approved', executed: false, note: 'This approval has already been executed. It was not run a second time.' },
        { status: 200 }
      )
    }

    const ctx: ToolContext = {
      settings,
      correlationId: `approval_${approval.reference}_${crypto.randomBytes(3).toString('hex')}`,
      incidentId: approval.incidentId ?? undefined,
      actor: `owner:${actorId ?? 'unknown'}`,
      actorName,
      actionsUsed: 0,
      now,
      approvalId,
    }
    const result = await executeTool(approval.toolName, approval.arguments, ctx)

    if (result.status === 'succeeded') {
      await prisma.emailAgentApproval.update({ where: { id: approvalId }, data: { status: 'executed' } })
    } else {
      // The execution claim is RELEASED on failure so a legitimate retry is
      // possible — but the approval stays `approved`, not `pending`, so the
      // human decision is not silently re-requested.
      await prisma.emailAgentApproval.update({ where: { id: approvalId }, data: { executedAt: null, executedById: null } }).catch(() => undefined)
    }
    return NextResponse.json({ ok: result.ok, status: 'approved', executed: result.status === 'succeeded', result })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), approvalId }, 'approval decision failed')
    return NextResponse.json({ error: safeErrorMessage(err) }, { status: 500 })
  }
}
