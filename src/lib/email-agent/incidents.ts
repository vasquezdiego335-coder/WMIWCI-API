// ════════════════════════════════════════════════════════════════════════
//  INCIDENT MANAGER (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Findings are observations. Incidents are PROBLEMS. The difference is the
//  entire value of this file: a provider outage that fails two hundred sends
//  produces two hundred findings and must produce ONE incident and ONE alert.
//
//  GROUPING RULE, in order of strength:
//    1. Same fingerprint  → same incident, always. This is identity.
//    2. Same subject      → findings about the SAME campaign or the SAME run,
//                           within one cycle, join the existing open incident
//                           for that subject when their categories are related.
//                           A missed schedule and a stale approval on one
//                           campaign are one story, and telling it twice is
//                           how an owner learns to ignore alerts.
//    3. Otherwise         → its own incident.
//
//  ESCALATION is deliberately narrow. An incident escalates when something
//  about it got WORSE — severity rose, more subjects were hit, a mitigation
//  that used to work failed, or it has simply been open too long. Being
//  detected again is not escalation; that is just the problem still existing,
//  and treating it as news is what makes a channel get muted.
//
//  AUTO-RESOLUTION: an incident whose fingerprint stops appearing has stopped
//  happening, so it resolves itself and says so. The one exception is an
//  incident awaiting a human decision — that stays open, because a compliance
//  problem that scrolled out of a 24-hour window has not been dealt with.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { queueLogger } from '../logger'
import { redact, safeErrorMessage } from './redact'
import {
  OPEN_INCIDENT_STATUSES,
  severityRank,
  type AgentFinding,
  type FindingSeverity,
  type IncidentStatus,
} from './types'

const log = queueLogger.child({ mod: 'email-agent-incidents' })

/** How long an unresolved incident may stay quiet before it escalates. */
export const STALE_INCIDENT_MS = 6 * 60 * 60 * 1000

/** Categories that describe one another closely enough to share an incident. */
const RELATED_CATEGORIES: Record<string, string[]> = {
  campaign: ['campaign', 'run', 'scheduler'],
  run: ['run', 'campaign', 'send'],
  send: ['send', 'run', 'provider'],
  consent: ['consent', 'suppression'],
  suppression: ['suppression', 'consent', 'webhook'],
  webhook: ['webhook', 'suppression', 'provider'],
  provider: ['provider', 'send', 'webhook'],
  scheduler: ['scheduler', 'campaign', 'infrastructure'],
  infrastructure: ['infrastructure', 'scheduler'],
}

export type IncidentOutcome = {
  incidentId: string
  reference: string
  created: boolean
  escalated: boolean
  escalationReason?: string
  severity: FindingSeverity
  findingIds: string[]
}

/** INC-2026-00014. Sequential within the calendar year, stable to quote. */
async function nextReference(now: Date): Promise<string> {
  const year = now.getUTCFullYear()
  const startOfYear = new Date(Date.UTC(year, 0, 1))
  const count = await prisma.emailAgentIncident.count({ where: { createdAt: { gte: startOfYear } } })
  return `INC-${year}-${String(count + 1).padStart(5, '0')}`
}

const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
  const out: string[] = []
  for (const v of values) if (v && out.indexOf(v) === -1) out.push(v)
  return out
}

const mergeIds = (existing: unknown, incoming: Array<string | undefined>): string[] => {
  const prior: Array<string | undefined> = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === 'string')
    : []
  return uniqueStrings(prior.concat(incoming)).slice(0, 100)
}

/**
 * Turn one cycle's findings into incidents.
 *
 * Returns what happened per group so the runner can alert on exactly the
 * incidents that are new or that got worse, and stay silent about the rest.
 */
export async function reconcileIncidents(
  findings: AgentFinding[],
  context: { runId: string; correlationId: string; now: Date }
): Promise<{ outcomes: IncidentOutcome[]; opened: number; updated: number; findingIdsByFingerprint: Map<string, string> }> {
  const outcomes: IncidentOutcome[] = []
  const findingIdsByFingerprint = new Map<string, string>()
  let opened = 0
  let updated = 0

  // ── Group the cycle's findings ────────────────────────────────────────
  // Subject first (campaign or run), so related problems about one thing
  // become one incident. Findings with no subject group by fingerprint alone.
  const groups = new Map<string, AgentFinding[]>()
  for (const f of findings) {
    const subject = f.campaignId ?? f.runRefId ?? null
    const family = RELATED_CATEGORIES[f.category]?.[0] ?? f.category
    const key = subject ? `subject:${subject}:${family}` : `fp:${f.fingerprint}`
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }

  for (const group of Array.from(groups.values())) {
    // The most severe finding leads: it names the incident and sets severity.
    const sorted = group.slice().sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    const lead = sorted[0]
    const severity = lead.severity
    const fingerprints = uniqueStrings(group.map((f) => f.fingerprint))

    try {
      // ── Find the open incident this group belongs to ──────────────────
      const existing = await prisma.emailAgentIncident.findFirst({
        where: {
          status: { in: OPEN_INCIDENT_STATUSES as unknown as string[] },
          OR: [
            { fingerprint: { in: fingerprints } },
            ...(lead.campaignId ? [{ affectedCampaignIds: { array_contains: [lead.campaignId] } }] : []),
            ...(lead.runRefId ? [{ affectedRunIds: { array_contains: [lead.runRefId] } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
      })

      const campaignIds = uniqueStrings(group.map((f) => f.campaignId))
      const runIds = uniqueStrings(group.map((f) => f.runRefId))
      const sendIds = uniqueStrings(group.map((f) => f.sendId))
      const eventIds = uniqueStrings(group.map((f) => f.webhookEventId))
      const affectedCount = Math.max(1, campaignIds.length + runIds.length + sendIds.length + eventIds.length)

      let incidentId: string
      let reference: string
      let created = false
      let escalated = false
      let escalationReason: string | undefined

      if (!existing) {
        reference = await nextReference(context.now)
        const incident = await prisma.emailAgentIncident.create({
          data: {
            reference,
            status: 'open',
            severity,
            category: lead.category,
            fingerprint: lead.fingerprint,
            title: lead.title,
            summary: lead.description,
            technicalSummary: group.length > 1 ? group.map((f) => `${f.checkId}: ${f.description}`).join('\n') : null,
            affectedCampaignIds: campaignIds as never,
            affectedRunIds: runIds as never,
            affectedSendIds: sendIds as never,
            affectedEventIds: eventIds as never,
            affectedCount,
            firstDetectedAt: context.now,
            lastDetectedAt: context.now,
            detectionCount: 1,
          },
          select: { id: true },
        })
        incidentId = incident.id
        created = true
        opened++
        await addIncidentEvent(incidentId, 'detected', `Opened from ${group.length} finding${group.length === 1 ? '' : 's'}: ${lead.title}`, {
          checkIds: uniqueStrings(group.map((f) => f.checkId)),
          correlationId: context.correlationId,
        })
      } else {
        incidentId = existing.id
        reference = existing.reference

        // ── ESCALATION: only when something got worse ──────────────────
        const priorSeverity = existing.severity as FindingSeverity
        const severityRose = severityRank[severity] > severityRank[priorSeverity]
        const scopeGrew = affectedCount > existing.affectedCount
        const stale = context.now.getTime() - existing.firstDetectedAt.getTime() > STALE_INCIDENT_MS && existing.status === 'open'
        const wasStaleBefore = existing.lastDetectedAt.getTime() - existing.firstDetectedAt.getTime() > STALE_INCIDENT_MS

        if (severityRose) {
          escalated = true
          escalationReason = `Severity rose from ${priorSeverity} to ${severity}.`
        } else if (scopeGrew) {
          escalated = true
          escalationReason = `More is affected than before: ${existing.affectedCount} → ${affectedCount}.`
        } else if (stale && !wasStaleBefore) {
          escalated = true
          escalationReason = `Still unresolved after ${Math.round((context.now.getTime() - existing.firstDetectedAt.getTime()) / 3600_000)} hours.`
        }

        await prisma.emailAgentIncident.update({
          where: { id: incidentId },
          data: {
            // Severity only ever RISES from re-detection. A critical that looks
            // like a warning this cycle is not a recovery; it is one sample.
            severity: severityRose ? severity : existing.severity,
            lastDetectedAt: context.now,
            detectionCount: { increment: 1 },
            affectedCount: Math.max(existing.affectedCount, affectedCount),
            affectedCampaignIds: mergeIds(existing.affectedCampaignIds, campaignIds) as never,
            affectedRunIds: mergeIds(existing.affectedRunIds, runIds) as never,
            affectedSendIds: mergeIds(existing.affectedSendIds, sendIds) as never,
            affectedEventIds: mergeIds(existing.affectedEventIds, eventIds) as never,
            // A resolved-then-recurring incident is reopened by the caller;
            // a mitigated one that is still detected goes back to open.
            status: existing.status === 'mitigated' ? 'open' : existing.status,
            summary: lead.description,
          },
        })
        updated++
        if (escalated) {
          await addIncidentEvent(incidentId, 'escalated', escalationReason ?? 'Escalated.', { correlationId: context.correlationId })
        }
      }

      // ── Persist the findings, attached to their incident ──────────────
      for (const f of group) {
        // firstDetectedAt is carried forward from the earliest sighting of this
        // exact fingerprint, so "how long has this been true" survives restarts.
        const earliest = await prisma.emailAgentFinding.findFirst({
          where: { fingerprint: f.fingerprint },
          orderBy: { firstDetectedAt: 'asc' },
          select: { firstDetectedAt: true },
        })
        const row = await prisma.emailAgentFinding.create({
          data: {
            runId: context.runId,
            checkId: f.checkId,
            fingerprint: f.fingerprint,
            severity: f.severity,
            category: f.category,
            title: f.title,
            description: f.description,
            evidence: redact(f.evidence) as never,
            campaignId: f.campaignId ?? null,
            runRefId: f.runRefId ?? null,
            sendId: f.sendId ?? null,
            webhookEventId: f.webhookEventId ?? null,
            suggestedActions: f.suggestedActions as never,
            firstDetectedAt: earliest?.firstDetectedAt ?? f.detectedAt,
            detectedAt: f.detectedAt,
            incidentId,
          },
          select: { id: true },
        })
        findingIdsByFingerprint.set(f.fingerprint, row.id)
      }

      outcomes.push({
        incidentId,
        reference,
        created,
        escalated,
        escalationReason,
        severity,
        findingIds: group.map((f) => findingIdsByFingerprint.get(f.fingerprint) ?? '').filter(Boolean),
      })
    } catch (err) {
      // An incident that cannot be recorded must not take the cycle down with
      // it — the other groups still need to be processed and alerted on.
      log.error({ err: safeErrorMessage(err), fingerprint: lead.fingerprint }, 'could not reconcile an incident group')
    }
  }

  return { outcomes, opened, updated, findingIdsByFingerprint }
}

/** Append to an incident's timeline. Never throws. */
export async function addIncidentEvent(
  incidentId: string,
  kind: string,
  message: string,
  detail?: Record<string, unknown>,
  actor = 'agent'
): Promise<void> {
  try {
    await prisma.emailAgentIncidentEvent.create({
      data: { incidentId, kind, message: message.slice(0, 1000), detail: detail ? (redact(detail) as never) : undefined, actor },
    })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), incidentId, kind }, 'could not append an incident event')
  }
}

/**
 * Close incidents whose fingerprints did not appear this cycle.
 *
 * `awaiting_approval` is deliberately excluded: a problem a human was asked
 * about does not stop being a problem because the check window moved on.
 */
export async function autoResolveAbsent(
  seenFingerprints: string[],
  context: { now: Date; correlationId: string }
): Promise<number> {
  const open = await prisma.emailAgentIncident.findMany({
    where: { status: { in: ['open', 'investigating', 'mitigated'] } },
    select: { id: true, reference: true, fingerprint: true, title: true, lastDetectedAt: true, findings: { select: { fingerprint: true }, take: 50 } },
    take: 200,
  })
  let resolved = 0
  for (const incident of open) {
    const fingerprints = uniqueStrings([incident.fingerprint].concat(incident.findings.map((f) => f.fingerprint)))
    const stillSeen = fingerprints.some((fp) => seenFingerprints.indexOf(fp) !== -1)
    if (stillSeen) continue
    // One clear cycle is enough for a check that runs every five minutes; the
    // finding either reproduces or it does not.
    await prisma.emailAgentIncident.update({
      where: { id: incident.id },
      data: {
        status: 'resolved',
        resolvedAt: context.now,
        resolutionKind: 'auto_cleared',
        resolution: 'The condition that produced this incident was no longer detected. Closed automatically; it will reopen under a new incident if it recurs.',
      },
    })
    await addIncidentEvent(incident.id, 'resolved', 'The condition stopped being detected, so the incident closed automatically.', {
      correlationId: context.correlationId,
      lastDetectedAt: incident.lastDetectedAt.toISOString(),
    })
    resolved++
  }
  return resolved
}

/** Set an incident's status with a timeline entry. */
export async function setIncidentStatus(
  incidentId: string,
  status: IncidentStatus,
  message: string,
  actor = 'agent',
  extra: Record<string, unknown> = {}
): Promise<void> {
  const data: Record<string, unknown> = { status, ...extra }
  if (status === 'resolved') {
    data.resolvedAt = new Date()
    if (!data.resolution) data.resolution = message
  }
  await prisma.emailAgentIncident.update({ where: { id: incidentId }, data: data as never })
  await addIncidentEvent(incidentId, status === 'resolved' ? 'resolved' : 'note', message, extra, actor)
}
