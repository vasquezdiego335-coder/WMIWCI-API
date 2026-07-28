// ════════════════════════════════════════════════════════════════════════
//  EMAIL OPERATIONS AGENT — /api/admin/email-marketing/agent
//  ---------------------------------------------------------------------
//  GET   — current status: settings, last cycle, open incidents, approvals.
//  POST  — operator controls (run now, mode, kill switches, pause/resume).
//
//  AUTHORISATION IS SERVER-SIDE AND PER-ACTION. `email.view` reads;
//  `email.configure` changes settings and switches. The UI hides what a role
//  cannot do, but hiding is not enforcement — every branch below re-checks,
//  because a hidden button is one curl away from being pressed.
//
//  THE ONE RULE THIS ROUTE EXISTS TO ENFORCE: SAFE-AUTO IS NOT A FORM FIELD.
//  Switching the agent from read_only to safe_auto grants it permission to
//  change production data, so it requires `email.configure` AND an explicit
//  typed confirmation string in the body. A client-side toggle cannot do it by
//  accident, and neither can a mis-sent request.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { checkCatalogue } from '@/lib/email-agent/checks'
import { AGENT_MODES, isAgentMode } from '@/lib/email-agent/types'
import { ensureSettings, loadSettings, updateSettings } from '@/lib/email-agent/settings'
import { safeErrorMessage } from '@/lib/email-agent/redact'

export const dynamic = 'force-dynamic'

const log = apiLogger.child({ route: 'admin/email-marketing/agent' })

/** The phrase an operator must type to hand the agent write access. */
const SAFE_AUTO_CONFIRMATION = 'ENABLE SAFE AUTO'

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  try {
    const settings = await loadSettings()
    const [lastRun, openIncidents, pendingApprovals, recentActions, lastModelCall] = await Promise.all([
      prisma.emailAgentRun.findFirst({ orderBy: { startedAt: 'desc' } }).catch(() => null),
      prisma.emailAgentIncident
        .count({ where: { status: { in: ['open', 'investigating', 'awaiting_approval', 'mitigated'] } } })
        .catch(() => 0),
      prisma.emailAgentApproval.count({ where: { status: 'pending' } }).catch(() => 0),
      prisma.emailAgentAction.findMany({ orderBy: { startedAt: 'desc' }, take: 5 }).catch(() => []),
      prisma.emailAgentModelCall.findFirst({ orderBy: { createdAt: 'desc' } }).catch(() => null),
    ])

    return NextResponse.json({
      settings: {
        ...settings,
        // Never echo a provider key, and never imply one is configured when the
        // agent could not read its own row.
        providerKeyConfigured:
          (settings.provider ?? 'openai') === 'deepseek'
            ? !!process.env.DEEPSEEK_API_KEY
            : !!process.env.OPENAI_API_KEY,
      },
      lastRun,
      openIncidents,
      pendingApprovals,
      recentActions,
      lastModelCall,
      checks: checkCatalogue(),
      modes: AGENT_MODES,
    })
  } catch (err) {
    log.error({ err: safeErrorMessage(err) }, 'agent status failed')
    return NextResponse.json({ error: safeErrorMessage(err) }, { status: 503 })
  }
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run_now') }),
  z.object({ action: z.literal('set_mode'), mode: z.string(), confirmation: z.string().optional() }),
  z.object({ action: z.literal('set_ai_enabled'), enabled: z.boolean() }),
  z.object({ action: z.literal('set_auto_actions'), enabled: z.boolean() }),
  z.object({ action: z.literal('set_alerts'), enabled: z.boolean() }),
  z.object({ action: z.literal('set_digest'), enabled: z.boolean() }),
  z.object({ action: z.literal('pause_dispatch'), reason: z.string().min(3).max(500) }),
  z.object({ action: z.literal('resume_dispatch'), confirmation: z.string() }),
  z.object({ action: z.literal('test_alert') }),
])

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}` }, { status: 400 })
  }
  const body = parsed.data

  // Reading the health is `email.view`; everything else changes behaviour.
  const required = body.action === 'run_now' ? 'email.view' : 'email.configure'
  const deny = denyReason(session?.role as Role, required)
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const actor = { userId: session?.userId ?? null, name: session?.name ?? session?.email ?? 'admin' }

  try {
    switch (body.action) {
      case 'run_now': {
        await ensureSettings()
        // Imported lazily: the runner pulls in the whole check suite, and this
        // route must stay cheap for the common GET path.
        const { runAgentCycle } = await import('@/lib/email-agent/runner')
        const result = await runAgentCycle({ trigger: 'manual' })
        return NextResponse.json({ ok: result.ran, result })
      }

      case 'set_mode': {
        if (!isAgentMode(body.mode)) {
          return NextResponse.json({ error: `"${body.mode}" is not a mode. Use one of: ${AGENT_MODES.join(', ')}.` }, { status: 400 })
        }
        // SAFE-AUTO NEEDS A TYPED CONFIRMATION. This is the moment the agent
        // gains the ability to change production data; a checkbox is not
        // enough of a decision for that.
        if (body.mode === 'safe_auto' && body.confirmation !== SAFE_AUTO_CONFIRMATION) {
          return NextResponse.json(
            {
              error: `Switching to safe_auto lets the agent make narrow, policy-approved repairs by itself. To confirm, send confirmation: "${SAFE_AUTO_CONFIRMATION}".`,
              confirmationRequired: SAFE_AUTO_CONFIRMATION,
            },
            { status: 400 }
          )
        }
        const settings = await updateSettings({ mode: body.mode }, actor)
        log.warn({ mode: body.mode, by: actor.name }, 'email agent mode changed')
        return NextResponse.json({ ok: true, settings })
      }

      case 'set_ai_enabled':
        return NextResponse.json({ ok: true, settings: await updateSettings({ aiEnabled: body.enabled }, actor) })
      case 'set_auto_actions':
        return NextResponse.json({ ok: true, settings: await updateSettings({ autoActionsEnabled: body.enabled }, actor) })
      case 'set_alerts':
        return NextResponse.json({ ok: true, settings: await updateSettings({ alertsEnabled: body.enabled }, actor) })
      case 'set_digest':
        return NextResponse.json({ ok: true, settings: await updateSettings({ digestWarnings: body.enabled }, actor) })

      case 'pause_dispatch': {
        const settings = await updateSettings({ marketingDispatchPaused: true, pausedReason: body.reason }, actor)
        log.warn({ by: actor.name, reason: body.reason }, 'MARKETING DISPATCH PAUSED from the admin')
        return NextResponse.json({ ok: true, settings })
      }

      case 'resume_dispatch': {
        // Resuming restarts real sending, so it is typed too.
        if (body.confirmation !== 'RESUME SENDING') {
          return NextResponse.json(
            { error: 'Resuming restarts campaign dispatch immediately. To confirm, send confirmation: "RESUME SENDING".', confirmationRequired: 'RESUME SENDING' },
            { status: 400 }
          )
        }
        const settings = await updateSettings({ marketingDispatchPaused: false, pausedReason: null }, actor)
        log.warn({ by: actor.name }, 'marketing dispatch RESUMED from the admin')
        return NextResponse.json({ ok: true, settings })
      }

      case 'test_alert': {
        // Clearly synthetic. It must be impossible to mistake this for a real
        // incident in the channel, so the text says so twice.
        const { postOpsAlert } = await import('@/lib/ops-alert')
        const result = await postOpsAlert('TEST ALERT — this is not a real incident', [
          {
            message: `Synthetic test sent by ${actor.name} at ${new Date().toISOString()}. No campaign, run or customer is involved.`,
            action: 'No action required. This message only proves the alert channel works.',
          },
        ])
        return NextResponse.json({ ok: result.delivered, delivered: result.delivered, reason: result.reason ?? null })
      }
    }
  } catch (err) {
    log.error({ err: safeErrorMessage(err), action: body.action }, 'agent control failed')
    return NextResponse.json({ error: safeErrorMessage(err) }, { status: 500 })
  }
}
