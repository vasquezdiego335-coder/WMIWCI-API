// ════════════════════════════════════════════════════════════════════════
//  MARKETING DISCOVERY CHECKS (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  The operations agent watches the MARKETING agent. The failure that matters
//  is silence: a campaign system nobody is told about is no campaign system,
//  and every failure mode here — a stopped cron, a dead Discord channel, a
//  draft the owner never saw — looks exactly like "nothing to do" from the
//  outside. These checks make that silence loud.
//
//  Read-only, like every check in this directory.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { safeErrorMessage } from '../redact'
import {
  DISCOVERY_SKIPPED_EVENT,
  DISCOVERY_SWEEP_EVENT,
  LEDGER_ACTION,
  NOTIFY_EVENT,
  marketingAgentEnabled,
} from '../../email-marketing-agent'
import type { AgentFinding } from '../types'
import { countInspected, hours, makeFinding, plural, type CheckContext, type CheckDefinition } from './shared'

const DAY_MS = 24 * 3600_000

/** The cron runs daily; a sweep older than this means the schedule is broken.
 *  36h = one full day plus generous restart slack. */
const SWEEP_STALE_MS = 36 * 3600_000

/** How long THIS process has been running (the flag's effective age here). */
const processUptimeMs = (): number => Math.round(process.uptime() * 1000)

// ── 1. The discovery cron stopped running ───────────────────────────────

const discoveryStale: CheckDefinition = {
  id: 'marketing.discovery_stale',
  category: 'scheduler',
  intent: 'Campaign discovery is switched on but has not actually run — opportunities are silently accumulating unseen.',
  run: async (ctx) => {
    // Off is a choice, not a failure. The runner does NOT auto-resolve this
    // check's incidents from a process where it is off: such a process cannot
    // observe the problem (see UNOBSERVABLE_WHEN_FLAG_OFF), so its silence is
    // not evidence of a fix.
    if (!marketingAgentEnabled()) return []
    let last: { createdAt: Date } | null
    try {
      last = await prisma.auditLog.findFirst({
        where: { action: LEDGER_ACTION, details: { path: ['event'], equals: DISCOVERY_SWEEP_EVENT } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
    } catch (err) {
      return [
        makeFinding(ctx, {
          checkId: 'marketing.discovery_stale',
          severity: 'warning',
          category: 'scheduler',
          title: 'Cannot read the discovery ledger',
          description: `The marketing agent is enabled but its sweep ledger could not be read: ${safeErrorMessage(err, 160)}`,
          evidence: {},
        }),
      ]
    }
    countInspected(ctx, 'marketingSweeps', last ? 1 : 0)
    // SPLIT CONFIGURATION (incident 2026-09-14): the flag is true HERE, but the
    // service that runs the daily sweep recorded that it skipped because the
    // flag is off THERE. The skip row is shared evidence, so this does not
    // depend on how long either process has been up.
    const skip = await prisma.auditLog
      .findFirst({
        where: { action: LEDGER_ACTION, details: { path: ['event'], equals: DISCOVERY_SKIPPED_EVENT } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, details: true },
      })
      .catch(() => null)
    if (skip && (!last || skip.createdAt > last.createdAt)) {
      const d = (skip.details ?? {}) as { reason?: string; service?: string | null }
      return [
        makeFinding(ctx, {
          checkId: 'marketing.discovery_stale',
          severity: 'warning',
          category: 'scheduler',
          title: 'Campaign discovery is enabled here but skipped where it runs',
          description:
            `EMAIL_MARKETING_AGENT_ENABLED is true in this service, but the daily sweep was skipped by ${d.service ?? 'the worker'} (${d.reason ?? 'unknown reason'}) ` +
            `on ${skip.createdAt.toISOString()}. The flag must be set on the service that runs the discovery cron, or removed here.`,
          evidence: { lastSweepAt: last?.createdAt.toISOString() ?? null, skippedAt: skip.createdAt.toISOString(), skippedBy: d.service ?? null, reason: d.reason ?? null },
        }),
      ]
    }
    // NEVER RAN AT ALL (incident 2026-09-14: this used to return [] here, so
    // a drafter that had never run looked healthy forever). A fresh enablement
    // has simply not reached 10:05 ET yet, so the anchor is how long the flag
    // has been in effect in THIS process: an environment change redeploys the
    // service, so process uptime is exactly "enabled since". Past the stale
    // window with no sweep ever recorded, the schedule is not running.
    if (!last) {
      const enabledForMs = processUptimeMs()
      if (enabledForMs <= SWEEP_STALE_MS) return []
      return [
        makeFinding(ctx, {
          checkId: 'marketing.discovery_stale',
          severity: 'warning',
          category: 'scheduler',
          title: 'Campaign discovery is enabled but has never run',
          description: `EMAIL_MARKETING_AGENT_ENABLED is true and this process has been up ${hours(enabledForMs)}h, but no discovery sweep has ever been recorded (expected daily at 10:05 ET). The cron or the worker that runs it is not running, or the flag is missing on that service.`,
          evidence: { lastSweepAt: null, enabledForHours: hours(enabledForMs) },
        }),
      ]
    }
    const age = ctx.now.getTime() - last.createdAt.getTime()
    if (age <= SWEEP_STALE_MS) return []
    return [
      makeFinding(ctx, {
        checkId: 'marketing.discovery_stale',
        severity: 'warning',
        category: 'scheduler',
        title: 'Campaign discovery has stopped running',
        description: `EMAIL_MARKETING_AGENT_ENABLED is true, but the last discovery sweep was ${hours(age)}h ago (expected daily at 10:05 ET). The cron or the worker is not running, and new campaign opportunities are going unnoticed.`,
        evidence: { lastSweepAt: last.createdAt.toISOString(), staleHours: hours(age) },
      }),
    ]
  },
}

// ── 2. A draft the owner was never told about ───────────────────────────

const unnotifiedDraft: CheckDefinition = {
  id: 'marketing.notification_failed',
  category: 'campaign',
  intent: 'A campaign draft exists but the Discord notice failed, so the owner may not know it is waiting.',
  run: async (ctx) => {
    let drafts: Array<{ id: string; name: string; createdAt: Date }>
    try {
      drafts = await prisma.marketingCampaign.findMany({
        where: {
          channel: 'EMAIL',
          status: 'DRAFT',
          createdByName: 'marketing-agent',
          // Give the create-time notice and one daily retry a chance first.
          createdAt: { lt: new Date(ctx.now.getTime() - 2 * 3600_000) },
        },
        select: { id: true, name: true, createdAt: true },
        take: 10,
      })
    } catch (err) {
      return [
        makeFinding(ctx, {
          checkId: 'marketing.notification_failed',
          severity: 'warning',
          category: 'campaign',
          title: 'Cannot read agent campaign drafts',
          description: safeErrorMessage(err, 160),
          evidence: {},
        }),
      ]
    }
    countInspected(ctx, 'agentDrafts', drafts.length)
    if (drafts.length === 0) return []

    const findings: AgentFinding[] = []
    for (const d of drafts) {
      let delivered = false
      try {
        const rows = await prisma.auditLog.findMany({
          where: { action: LEDGER_ACTION, details: { path: ['campaignId'], equals: d.id } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { details: true },
        })
        delivered = rows.some((r) => {
          const det = r.details as { event?: string; delivered?: boolean } | null
          return det?.event === NOTIFY_EVENT && det.delivered === true
        })
      } catch {
        // Ledger unreadable — the stale check above already reports that.
        continue
      }
      if (delivered) continue
      findings.push(
        makeFinding(ctx, {
          checkId: 'marketing.notification_failed',
          severity: 'warning',
          category: 'campaign',
          title: 'A campaign draft is waiting and Discord was never told',
          description: `"${d.name}" has been in DRAFT since ${d.createdAt.toISOString().slice(0, 16)}Z and no successful Discord notice is recorded. The owner may not know it exists — it is visible on the admin Campaigns page.`,
          evidence: { campaignId: d.id, createdAt: d.createdAt.toISOString() },
          campaignId: d.id,
        })
      )
    }
    return findings
  },
}

// ── 3. A draft the owner has been ignoring ──────────────────────────────

const staleDraft: CheckDefinition = {
  id: 'marketing.draft_stalled',
  category: 'campaign',
  intent: 'An agent-drafted campaign has waited a long time for a decision — approve it or archive it.',
  run: async (ctx) => {
    let stalled: Array<{ id: string; name: string; createdAt: Date }>
    try {
      stalled = await prisma.marketingCampaign.findMany({
        where: {
          channel: 'EMAIL',
          status: 'DRAFT',
          createdByName: 'marketing-agent',
          createdAt: { lt: new Date(ctx.now.getTime() - 7 * DAY_MS) },
        },
        select: { id: true, name: true, createdAt: true },
        take: 5,
      })
    } catch {
      return [] // draft readability is already covered above
    }
    if (stalled.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'marketing.draft_stalled',
        severity: 'info',
        category: 'campaign',
        title: `${stalled.length} agent ${plural(stalled.length, 'draft has', 'drafts have')} waited over a week`,
        description: `${stalled.map((s) => `"${s.name}"`).join(', ')} — the audience was eligible when drafted and is aging. Approve, edit, or archive; the cooldown will not suggest the segment again while a draft exists.`,
        evidence: { campaignIds: stalled.map((s) => s.id) },
        fingerprintParts: [stalled.map((s) => s.id).join(',')],
      }),
    ]
  },
}

export const marketingChecks: CheckDefinition[] = [discoveryStale, unnotifiedDraft, staleDraft]
