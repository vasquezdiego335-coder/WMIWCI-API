// ════════════════════════════════════════════════════════════════════════
//  INCIDENT ALERTS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  A channel that pings for routine warnings gets muted, and a muted channel
//  is worse than no channel at all. So this file is mostly about NOT sending.
//
//  WHEN A CRITICAL ALERTS: the first time, when its severity rises, when its
//  scope grows, when a mitigation that used to work fails, when it starts
//  needing a human, and when it resolves. Not otherwise — an incident that is
//  simply still true is not news, and a cooldown stops a flapping condition
//  from becoming a notification storm.
//
//  WARNINGS DO NOT INTERRUPT. They collect into one digest, sent at most once
//  a day, so the owner reads them when they choose to. A warning that escalates
//  to critical alerts immediately, because then it has earned it.
//
//  The transport is the existing `postOpsAlert` — a bare HTTPS POST with no
//  SDK. Importing the Discord client here would drag discord.js into the
//  Next.js bundle and break the production build, which has happened before.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { queueLogger } from '../logger'
import { postOpsAlert, type AlertLine } from '../ops-alert'
import { addIncidentEvent } from './incidents'
import { safeErrorMessage } from './redact'
import type { AgentSettings } from './settings'
import type { IncidentOutcome } from './incidents'

const log = queueLogger.child({ mod: 'email-agent-alerts' })

/** The same critical incident does not alert twice inside this window. */
export const CRITICAL_COOLDOWN_MS = 60 * 60 * 1000
/** Warnings are digested at most this often. */
export const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000

const adminUrl = (path: string): string => {
  const base = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  return base ? `${base}${path}` : path
}

export type AlertDecision =
  | { send: true; reason: string }
  | { send: false; reason: string }

/**
 * Should this incident alert right now?
 *
 * Pure, so the whole dedupe policy is testable without Discord or a database.
 */
export function decideAlert(input: {
  severity: string
  created: boolean
  escalated: boolean
  needsApproval: boolean
  mitigationFailed: boolean
  lastAlertAt: Date | null
  lastAlertSeverity: string | null
  lastAlertScope: number | null
  affectedCount: number
  now: Date
  digestWarnings: boolean
}): AlertDecision {
  const { severity, lastAlertAt, now } = input

  // Warnings and info never interrupt when digesting is on.
  if (severity !== 'critical') {
    if (input.digestWarnings) return { send: false, reason: 'Warnings are collected into the daily digest.' }
    if (!input.created && !input.escalated) return { send: false, reason: 'Already reported and unchanged.' }
    return { send: true, reason: input.created ? 'New warning, digest disabled.' : 'Warning escalated.' }
  }

  // Critical: alert on anything that is new or worse, cooldown or not.
  if (input.created) return { send: true, reason: 'New critical incident.' }
  const severityRose = input.lastAlertSeverity !== null && input.lastAlertSeverity !== 'critical'
  if (severityRose) return { send: true, reason: 'Severity rose to critical since the last alert.' }
  if (input.lastAlertScope !== null && input.affectedCount > input.lastAlertScope) {
    return { send: true, reason: `Scope grew from ${input.lastAlertScope} to ${input.affectedCount}.` }
  }
  if (input.mitigationFailed) return { send: true, reason: 'A mitigation that previously worked has failed.' }
  if (input.needsApproval) return { send: true, reason: 'The incident now needs a human decision.' }
  if (input.escalated) return { send: true, reason: 'The incident escalated.' }

  // Still true, nothing worse. Re-alert only after the cooldown.
  if (!lastAlertAt) return { send: true, reason: 'Critical incident never alerted.' }
  const since = now.getTime() - lastAlertAt.getTime()
  if (since >= CRITICAL_COOLDOWN_MS) return { send: true, reason: `Still unresolved ${Math.round(since / 60_000)} minutes after the last alert.` }
  return { send: false, reason: `Alerted ${Math.round(since / 60_000)} minutes ago and nothing has got worse.` }
}

/** The message body. Owner-readable, and it always says what to do next. */
export function formatIncidentAlert(input: {
  reference: string
  severity: string
  title: string
  summary: string
  probableCause: string | null
  campaignNames: string[]
  runIds: string[]
  actionTaken: string | null
  needsApproval: boolean
  approvalReference: string | null
  recommendation: string | null
  detectedAt: Date
  resolved?: boolean
}): { title: string; lines: AlertLine[] } {
  const heading = input.resolved
    ? `RESOLVED — ${input.title}`
    : `${input.severity.toUpperCase()} — ${input.title}`

  const lines: AlertLine[] = []
  lines.push({ message: `Incident: ${input.reference} · detected ${input.detectedAt.toISOString()}` })
  lines.push({ message: input.summary })

  if (input.campaignNames.length > 0) lines.push({ message: `Campaign: ${input.campaignNames.slice(0, 3).join(', ')}` })
  if (input.runIds.length > 0) lines.push({ message: `Run: ${input.runIds.slice(0, 2).join(', ')}` })
  if (input.probableCause) lines.push({ message: `Probable cause: ${input.probableCause}` })

  lines.push({
    message: input.actionTaken
      ? `Automatic action: ${input.actionTaken}`
      : 'Automatic action: none — the agent did not change anything.',
  })

  if (input.needsApproval) {
    lines.push({
      message: `HUMAN ACTION NEEDED${input.approvalReference ? ` (${input.approvalReference})` : ''}.`,
      action: `Review and approve at ${adminUrl('/admin/email-marketing/agent')}`,
    })
  } else if (input.recommendation) {
    lines.push({ message: `Recommended next step: ${input.recommendation}`, action: adminUrl('/admin/email-marketing/agent') })
  } else if (!input.resolved) {
    lines.push({ message: 'No action is required yet.', action: adminUrl('/admin/email-marketing/agent') })
  }

  return { title: heading, lines }
}

export type AlertOutcome = { sent: number; suppressed: number }

/** Alert on the incidents that earned it, and record what was sent. */
export async function alertForIncidents(
  outcomes: IncidentOutcome[],
  context: {
    settings: AgentSettings
    now: Date
    correlationId: string
    /** Incident id → the action the agent took, for the "Automatic action" line. */
    actionsByIncident: Map<string, string>
    /** Incident id → approval reference, when one was created. */
    approvalsByIncident: Map<string, string>
    recommendation?: string | null
  }
): Promise<AlertOutcome> {
  if (!context.settings.alertsEnabled) return { sent: 0, suppressed: outcomes.length }

  let sent = 0
  let suppressed = 0

  for (const outcome of outcomes) {
    try {
      const incident = await prisma.emailAgentIncident.findUnique({
        where: { id: outcome.incidentId },
        select: {
          reference: true, severity: true, status: true, title: true, summary: true, probableCause: true,
          affectedCampaignIds: true, affectedRunIds: true, affectedCount: true,
          lastAlertAt: true, lastAlertSeverity: true, lastAlertScope: true, firstDetectedAt: true,
        },
      })
      if (!incident) continue

      const approvalReference = context.approvalsByIncident.get(outcome.incidentId) ?? null
      const decision = decideAlert({
        severity: incident.severity,
        created: outcome.created,
        escalated: outcome.escalated,
        needsApproval: incident.status === 'awaiting_approval' || approvalReference !== null,
        mitigationFailed: false,
        lastAlertAt: incident.lastAlertAt,
        lastAlertSeverity: incident.lastAlertSeverity,
        lastAlertScope: incident.lastAlertScope,
        affectedCount: incident.affectedCount,
        now: context.now,
        digestWarnings: context.settings.digestWarnings,
      })

      if (!decision.send) {
        suppressed++
        continue
      }

      const campaignIds = Array.isArray(incident.affectedCampaignIds) ? (incident.affectedCampaignIds as string[]) : []
      const campaignNames = campaignIds.length
        ? (await prisma.marketingCampaign.findMany({ where: { id: { in: campaignIds.slice(0, 3) } }, select: { name: true } })).map((c) => c.name)
        : []

      const { title, lines } = formatIncidentAlert({
        reference: incident.reference,
        severity: incident.severity,
        title: incident.title,
        summary: incident.summary,
        probableCause: incident.probableCause,
        campaignNames,
        runIds: Array.isArray(incident.affectedRunIds) ? (incident.affectedRunIds as string[]) : [],
        actionTaken: context.actionsByIncident.get(outcome.incidentId) ?? null,
        needsApproval: incident.status === 'awaiting_approval' || approvalReference !== null,
        approvalReference,
        recommendation: context.recommendation ?? null,
        detectedAt: incident.firstDetectedAt,
      })

      const result = await postOpsAlert(title, lines)
      // The alert state records what was ACTUALLY delivered. Marking an
      // undelivered alert as sent would suppress the retry that might reach
      // somebody, so a failure deliberately leaves the state untouched.
      if (result.delivered) {
        await prisma.emailAgentIncident.update({
          where: { id: outcome.incidentId },
          data: {
            lastAlertAt: context.now,
            lastAlertSeverity: incident.severity,
            lastAlertScope: incident.affectedCount,
            alertCount: { increment: 1 },
          },
        })
        await addIncidentEvent(outcome.incidentId, 'alerted', `Alert delivered: ${decision.reason}`, { correlationId: context.correlationId })
        sent++
      } else {
        await addIncidentEvent(outcome.incidentId, 'note', `Alert COULD NOT be delivered: ${result.reason ?? 'unknown reason'}`, {
          correlationId: context.correlationId,
        })
        log.error({ incident: incident.reference, reason: result.reason }, 'incident alert could not be delivered')
      }
    } catch (err) {
      log.error({ err: safeErrorMessage(err), incidentId: outcome.incidentId }, 'alerting failed for an incident')
    }
  }

  return { sent, suppressed }
}

/**
 * The warning digest. One message, at most once a day, listing what is open
 * and not urgent enough to interrupt for.
 */
export async function sendWarningDigest(context: { settings: AgentSettings; now: Date }): Promise<boolean> {
  if (!context.settings.alertsEnabled || !context.settings.digestWarnings) return false

  const cutoff = new Date(context.now.getTime() - DIGEST_INTERVAL_MS)
  const warnings = await prisma.emailAgentIncident.findMany({
    where: { status: { in: ['open', 'investigating', 'mitigated'] }, severity: 'warning' },
    select: { id: true, reference: true, title: true, lastAlertAt: true, firstDetectedAt: true, detectionCount: true },
    orderBy: { firstDetectedAt: 'asc' },
    take: 20,
  })
  if (warnings.length === 0) return false

  // Nothing new since the last digest → stay quiet.
  const undigested = warnings.filter((w) => !w.lastAlertAt || w.lastAlertAt < cutoff)
  if (undigested.length === 0) return false

  const lines: AlertLine[] = undigested.slice(0, 5).map((w) => ({
    message: `${w.reference}: ${w.title} (open since ${w.firstDetectedAt.toISOString().slice(0, 10)}, seen ${w.detectionCount}x)`,
  }))
  if (undigested.length > 5) lines.push({ message: `…and ${undigested.length - 5} more.` })
  lines.push({ message: 'None of these are urgent.', action: adminUrl('/admin/email-marketing/agent') })

  const result = await postOpsAlert(`EMAIL OPS — ${undigested.length} open warning${undigested.length === 1 ? '' : 's'}`, lines)
  if (!result.delivered) return false

  await prisma.emailAgentIncident.updateMany({
    where: { id: { in: undigested.map((w) => w.id) } },
    data: { lastAlertAt: context.now, lastAlertSeverity: 'warning' },
  })
  return true
}
