// ════════════════════════════════════════════════════════════════════════
//  THE AGENT CYCLE (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  One pass: lock, check, persist, group, remember, investigate, classify,
//  execute or ask, alert, summarise, unlock.
//
//  CONCURRENCY. The lock is a POSTGRES ADVISORY LOCK, not an in-memory flag.
//  This deploys to Railway where more than one container can exist, and two
//  containers each holding their own boolean is not a lock at all. The lock is
//  session-scoped and released in a `finally`; if the process dies holding it,
//  Postgres drops it when the connection closes. A cycle that cannot get the
//  lock records `skipped` and returns — it does not wait, because another
//  cycle is already doing the same work.
//
//  ORDER MATTERS AND IT IS NOT ARBITRARY.
//   • The deterministic report completes BEFORE the AI is called, so a
//     provider outage cannot cost a single finding.
//   • Incidents are created BEFORE investigation, so an incident exists to
//     attach the explanation to, and so a crash mid-investigation still leaves
//     the problem recorded.
//   • The policy engine classifies AFTER the model answers and BEFORE anything
//     executes. There is no path from a recommendation to an execution that
//     does not pass through it.
//   • Alerts go last, so they can say what the agent actually did.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { prisma } from '../db'
import { queueLogger } from '../logger'
import { alertForIncidents, sendWarningDigest } from './alerts'
import { runHealthChecks } from './checks'
import { autoResolveAbsent, addIncidentEvent, reconcileIncidents } from './incidents'
import { investigate } from './investigator'
import { buildSystemSummary, recordLesson } from './memory'
import { classify } from './policy'
import { redact, safeErrorMessage } from './redact'
import { budgetAlertToRaise, readUsage, recordBudgetAlert } from './budget'
import { downgradeSafeAuto, readBlastRadiusCounts, shouldDowngradeSafeAuto } from './blast-radius'
import { canWriteAgentRecords, describeRuntime, provenance, type AgentSource } from './environment'
import { evidenceHash, rankForInvestigation, shouldInvestigate, type InvestigationTrigger } from './investigation-policy'
import { postOpsAlert } from '../ops-alert'
import { ensureSettings, type AgentSettings } from './settings'
import { createApprovalRequest, executeTool, expireStaleApprovals, type ToolContext } from './tools'
import { severityRank, type AgentFinding, type FindingSeverity } from './types'

const log = queueLogger.child({ mod: 'email-agent-runner' })

/** The shape `investigate()` returns, so the runner can hold a default. */
type CycleInvestigation = Awaited<ReturnType<typeof investigate>>

/**
 * Advisory lock key for the agent cycle. A constant distinct from the Action
 * Center scan lock (92607131) so the two never block each other.
 */
export const AGENT_LOCK_KEY = BigInt(92607241)

export type CycleTrigger = 'scheduled' | 'manual' | 'dry_run'

export type CycleResult = {
  ran: boolean
  skippedReason?: string
  runId?: string
  correlationId: string
  overallStatus: 'healthy' | 'warning' | 'critical'
  findings: number
  criticals: number
  warnings: number
  incidentsOpened: number
  incidentsUpdated: number
  incidentsResolved: number
  actionsExecuted: number
  approvalsCreated: number
  alertsSent: number
  aiInvoked: boolean
  aiSkippedReason?: string
  /** Investigations deliberately not made because nothing changed. */
  aiSkippedCount: number
  /** Estimated USD this cycle spent on model calls. */
  aiCostUsd: number
  summary: string
  durationMs: number
}

/**
 * How long a `running` cycle row is trusted before it is treated as crashed.
 * A cycle is seconds of work; a minute is generous.
 */
export const CYCLE_LEASE_STALE_MS = 5 * 60_000

/**
 * Claim the right to run a cycle.
 *
 * WHY NOT A PLAIN SESSION ADVISORY LOCK. `pg_try_advisory_lock` is
 * SESSION-scoped, and Prisma talks to Neon through a CONNECTION POOL. The lock
 * and the later unlock are not guaranteed to run on the same connection, so the
 * unlock silently fails and the lock is held until that pooled connection is
 * recycled. Observed exactly that: the first cycle worked, and every subsequent
 * cycle was refused as "already running" against a lock nobody held.
 *
 * So the claim is TWO mechanisms, each doing what it is good at:
 *
 *   1. `pg_advisory_xact_lock` — TRANSACTION-scoped, released by the commit
 *      itself, so pooling cannot strand it. It makes the check-and-insert
 *      below atomic across containers.
 *   2. The `running` EmailAgentRun row — the durable lease. It outlives the
 *      transaction, so a second container sees it, and a crashed process
 *      leaves a row that goes stale and is superseded rather than a lock that
 *      is held forever.
 *
 * This is the same shape as the Action Center's ScanRun lease, deliberately.
 */
async function claimCycle(input: {
  trigger: CycleTrigger
  mode: string
  correlationId: string
  now: Date
  where: ReturnType<typeof provenance>
}): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
  return prisma.$transaction(async (tx) => {
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and
    // Prisma cannot deserialize a void column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AGENT_LOCK_KEY})`

    const cutoff = new Date(input.now.getTime() - CYCLE_LEASE_STALE_MS)
    const live = await tx.emailAgentRun.findFirst({
      where: { status: 'running', startedAt: { gte: cutoff } },
      select: { id: true, startedAt: true, correlationId: true },
    })
    if (live) {
      return { ok: false as const, reason: `Another agent cycle (${live.correlationId}) started at ${live.startedAt.toISOString()} and is still running.` }
    }

    // Close out anything abandoned, so a crashed cycle is visible as a FAILURE
    // rather than quietly forgotten.
    const abandoned = await tx.emailAgentRun.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: {
        status: 'failed',
        error: 'The cycle did not finish — the process was interrupted. Superseded by a later cycle.',
        completedAt: input.now,
      },
    })
    if (abandoned.count > 0) {
      log.warn({ abandoned: abandoned.count }, 'superseded abandoned agent cycles')
    }

    const row = await tx.emailAgentRun.create({
      data: {
        trigger: input.trigger,
        status: 'running',
        mode: input.mode,
        correlationId: input.correlationId,
        startedAt: input.now,
        environment: input.where.environment,
        service: input.where.service,
        source: input.where.source,
        deploymentId: input.where.deploymentId,
      },
      select: { id: true },
    })
    return { ok: true as const, runId: row.id }
  })
}

const count = (findings: AgentFinding[], severity: FindingSeverity): number => findings.filter((f) => f.severity === severity).length

/** The owner-facing paragraph when the AI did not write one. */
function deterministicSummary(input: {
  status: string
  findings: AgentFinding[]
  errors: number
  opened: number
  resolved: number
  aiReason?: string
}): string {
  const criticals = input.findings.filter((f) => f.severity === 'critical')
  const warnings = input.findings.filter((f) => f.severity === 'warning')

  if (input.findings.length === 0 && input.errors === 0) {
    return 'Every check passed. Campaigns, runs, sends, consent, suppression, webhooks, the provider and the scheduler all look correct.'
  }

  const parts: string[] = []
  if (criticals.length > 0) {
    parts.push(
      `${criticals.length} critical problem${criticals.length === 1 ? '' : 's'}: ${criticals.slice(0, 3).map((c) => c.title).join('; ')}${criticals.length > 3 ? `, and ${criticals.length - 3} more` : ''}.`
    )
  }
  if (warnings.length > 0) {
    parts.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings.slice(0, 2).map((w) => w.title).join('; ')}${warnings.length > 2 ? `, and ${warnings.length - 2} more` : ''}.`)
  }
  if (input.errors > 0) {
    parts.push(`${input.errors} check${input.errors === 1 ? '' : 's'} could not run, so part of the system is unverified rather than known-good.`)
  }
  if (input.opened > 0) parts.push(`${input.opened} new incident${input.opened === 1 ? '' : 's'} opened.`)
  if (input.resolved > 0) parts.push(`${input.resolved} incident${input.resolved === 1 ? '' : 's'} cleared.`)
  if (input.aiReason) parts.push(`Written analysis was not available this cycle (${input.aiReason}).`)
  return parts.join(' ')
}

/** Run one agent cycle. Never throws. */
export async function runAgentCycle(options: { trigger?: CycleTrigger; now?: Date; settings?: AgentSettings } = {}): Promise<CycleResult> {
  const started = Date.now()
  const now = options.now ?? new Date()
  const trigger: CycleTrigger = options.trigger ?? 'scheduled'
  const correlationId = `agent_${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`

  const base: CycleResult = {
    ran: false,
    correlationId,
    overallStatus: 'healthy',
    findings: 0,
    criticals: 0,
    warnings: 0,
    incidentsOpened: 0,
    incidentsUpdated: 0,
    incidentsResolved: 0,
    actionsExecuted: 0,
    approvalsCreated: 0,
    alertsSent: 0,
    aiInvoked: false,
    aiSkippedCount: 0,
    aiCostUsd: 0,
    summary: '',
    durationMs: 0,
  }

  const settings = options.settings ?? (await ensureSettings())

  if (settings.mode === 'off') {
    return { ...base, skippedReason: 'The agent is switched off.', summary: 'The agent is off. No checks ran.', durationMs: Date.now() - started }
  }

  // ── THE ENVIRONMENT BOUNDARY (owner spec 2026-07-28) ──────────────────
  // Checked BEFORE the lock and before any write. A local process pointed at
  // the production database produces findings that describe the LAPTOP —
  // a missing RESEND_WEBHOOK_SECRET on a developer machine became a production
  // compliance incident and an approval request once already. That is not a
  // theoretical risk; it is the bug this guard was written for.
  const writeCheck = canWriteAgentRecords()
  if (!writeCheck.allowed) {
    log.warn({ runtime: describeRuntime(), correlationId }, 'agent cycle refused: this runtime may not write agent records')
    return {
      ...base,
      skippedReason: writeCheck.reason,
      summary: `The cycle did not run. ${writeCheck.reason}`,
      durationMs: Date.now() - started,
    }
  }
  if (writeCheck.overridden) {
    log.warn({ runtime: describeRuntime(), correlationId }, 'WRITING AGENT RECORDS TO PRODUCTION FROM A LOCAL RUNTIME (override is set)')
  }

  const where = provenance(trigger as AgentSource)
  let claim: Awaited<ReturnType<typeof claimCycle>>
  try {
    claim = await claimCycle({ trigger, mode: settings.mode, correlationId, now, where })
  } catch (err) {
    log.error({ err: safeErrorMessage(err) }, 'could not claim a cycle')
    return { ...base, skippedReason: `Could not claim a cycle: ${safeErrorMessage(err)}`, summary: 'The cycle could not start.', durationMs: Date.now() - started }
  }
  if (!claim.ok) {
    log.info({ correlationId, reason: claim.reason }, 'another agent cycle is running — skipping')
    return { ...base, skippedReason: claim.reason, summary: 'Skipped: a cycle was already in progress.', durationMs: Date.now() - started }
  }

  let runId: string | undefined

  try {
    const runRow = { id: claim.runId }
    runId = runRow.id

    // ── 1. DETERMINISTIC TRUTH ──────────────────────────────────────────
    // This half never costs money and never depends on a provider. It runs
    // first and completes fully, so a budget or an outage downstream cannot
    // cost a single finding.
    const report = await runHealthChecks({ settings, now })
    const criticals = count(report.findings, 'critical')
    const warnings = count(report.findings, 'warning')
    await prisma.emailAgentRun.update({ where: { id: runRow.id }, data: { checksCompletedAt: new Date() } }).catch(() => undefined)

    // ── 2. INCIDENTS ────────────────────────────────────────────────────
    const { outcomes, opened, updated, findingIdsByFingerprint } = await reconcileIncidents(report.findings, {
      runId: runRow.id,
      correlationId,
      now,
    })
    const resolvedCount = await autoResolveAbsent(report.findings.map((f) => f.fingerprint), { now, correlationId })
    await expireStaleApprovals(now)

    // ── 3. MEMORY CONTEXT ───────────────────────────────────────────────
    const [openIncidents, pendingApprovals] = await Promise.all([
      prisma.emailAgentIncident.count({ where: { status: { in: ['open', 'investigating', 'awaiting_approval', 'mitigated'] } } }),
      prisma.emailAgentApproval.count({ where: { status: 'pending' } }),
    ])
    const systemSummary = buildSystemSummary({
      overallStatus: report.overallStatus,
      findingCount: report.findings.length,
      criticalCount: criticals,
      warningCount: warnings,
      openIncidents,
      pendingApprovals,
      mode: settings.mode,
      dispatchPaused: settings.marketingDispatchPaused,
    })

    // ── 4. WHICH INCIDENTS DESERVE A MODEL CALL ─────────────────────────
    //
    // THE CHANGE THAT MAKES THIS AGENT AFFORDABLE. Previously every cycle
    // investigated whatever it found — at a 5-minute cadence, 288 identical
    // model calls a day per open incident, re-reading evidence that had not
    // moved. Now an incident earns a call only when something MATERIAL
    // changed, or a human asked, or a long cooldown expired.
    //
    // The evidence hash deliberately excludes detection counts and elapsed
    // times: "still true, 47 minutes" becoming "still true, 48 minutes" is
    // not new information and must not cost anything.
    const candidates: Array<{
      incidentId: string
      findings: AgentFinding[]
      severity: FindingSeverity
      lastInvestigatedAt: Date | null
      trigger: InvestigationTrigger
      reason: string
      currentHash: string
    }> = []
    let aiSkippedCount = 0
    const skipReasons: string[] = []

    for (const outcome of outcomes) {
      // The findings that belong to THIS incident, by the ids just persisted.
      const forHash = report.findings.filter((f) => {
        const id = findingIdsByFingerprint.get(f.fingerprint)
        return id !== undefined && outcome.findingIds.includes(id)
      })
      if (forHash.length === 0) continue

      const currentHash = evidenceHash(forHash)
      const stored = await prisma.emailAgentIncident.findUnique({
        where: { id: outcome.incidentId },
        select: {
          severity: true,
          investigatedEvidenceHash: true,
          lastInvestigatedAt: true,
          reinvestigateRequestedAt: true,
          status: true,
          resolvedAt: true,
        },
      })
      if (!stored) continue

      // Record the current hash regardless, so the NEXT cycle can compare
      // even if this one never investigates.
      await prisma.emailAgentIncident
        .update({ where: { id: outcome.incidentId }, data: { evidenceHash: currentHash } })
        .catch(() => undefined)

      const decision = shouldInvestigate(
        {
          created: outcome.created,
          // Reopened = it had been closed, and this cycle put it back to open.
          reopened: stored.status === 'open' && stored.resolvedAt !== null,
          severity: outcome.severity,
          previousSeverity: stored.investigatedEvidenceHash ? (stored.severity as FindingSeverity) : null,
          currentEvidenceHash: currentHash,
          investigatedEvidenceHash: stored.investigatedEvidenceHash,
          lastInvestigatedAt: stored.lastInvestigatedAt,
          reinvestigateRequestedAt: stored.reinvestigateRequestedAt,
        },
        { now, cooldownHours: settings.aiReinvestigateHours }
      )

      if (decision.investigate) {
        candidates.push({
          incidentId: outcome.incidentId,
          findings: forHash,
          severity: outcome.severity,
          lastInvestigatedAt: stored.lastInvestigatedAt,
          trigger: decision.trigger,
          reason: decision.reason,
          currentHash,
        })
      } else {
        aiSkippedCount++
        skipReasons.push(`${outcome.reference}: ${decision.reason}`)
      }
    }

    if (aiSkippedCount > 0) {
      log.info({ skipped: aiSkippedCount, correlationId }, 'investigations skipped — evidence unchanged (this is the cost control working)')
    }

    // ONE INCIDENT PER CYCLE, deliberately.
    //
    // `maxModelCallsPerCycle` (default 2) budgets CALLS, not incidents: one
    // primary plus at most one fallback for the same investigation. Spending
    // it on two incidents instead would leave a failed primary with no
    // fallback, and would double the cost of a busy cycle for an owner who is
    // going to read one summary anyway.
    //
    // The ranking decides WHICH one, and a backlog drains at one per cycle —
    // four an hour at a 15-minute cadence, which clears any realistic number
    // of simultaneous incidents well inside a working day.
    const ranked = rankForInvestigation(candidates).slice(0, 1)

    // ── 4b. INVESTIGATION (optional; failure changes nothing above) ──────
    let investigation: CycleInvestigation = {
      invoked: false,
      decision: null,
      provider: 'none',
      model: 'none',
      outcome: 'skipped',
      skippedReason:
        candidates.length === 0
          ? 'No incident had materially new evidence, so no model call was needed. This is the cost control working, not a failure.'
          : undefined,
      callsMade: 0,
      costUsd: 0,
      usedFallback: false,
    }
    let investigatedIncidentId: string | null = null

    if (ranked.length > 0) {
      const target = ranked[0]
      const result = await investigate(target.findings, {
        settings,
        correlationId,
        runId: runRow.id,
        incidentId: target.incidentId,
        findingIds: findingIdsByFingerprint,
        systemSummary,
        now,
        callsThisCycle: 0,
      })
      investigation = result
      investigatedIncidentId = target.incidentId

      // Stamp the investigation state so the next cycle can skip it.
      if (result.invoked) {
        await prisma.emailAgentIncident
          .update({
            where: { id: target.incidentId },
            data: {
              lastInvestigatedAt: now,
              investigatedEvidenceHash: target.currentHash,
              investigationCount: { increment: 1 },
              reinvestigateRequestedAt: null,
            },
          })
          .catch(() => undefined)
        await addIncidentEvent(target.incidentId, 'investigated', `Investigated because: ${target.reason}`, {
          trigger: target.trigger,
          provider: result.provider,
          model: result.model,
          costUsd: result.costUsd,
          usedFallback: result.usedFallback,
          correlationId,
        })
      }
    }

    // Attach the explanation to the incident it is actually about.
    const leadIncident = investigatedIncidentId
      ? outcomes.find((o) => o.incidentId === investigatedIncidentId) ?? null
      : outcomes.slice().sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0] ?? null

    if (investigation.decision && leadIncident) {
      const d = investigation.decision
      await prisma.emailAgentIncident
        .update({
          where: { id: leadIncident.incidentId },
          data: {
            summary: d.summary.slice(0, 2000),
            technicalSummary: d.technicalExplanation.slice(0, 4000),
            probableCause: d.probableCause?.slice(0, 2000) ?? null,
            confidence: d.confidence,
            recommendation: redact(d.recommendation) as never,
            status: 'investigating',
          },
        })
        .catch((err) => log.warn({ err: safeErrorMessage(err) }, 'could not attach the investigation to its incident'))
      await addIncidentEvent(leadIncident.incidentId, 'investigated', `${investigation.provider}/${investigation.model}: ${d.summary.slice(0, 400)}`, {
        confidence: d.confidence,
        recommendation: d.recommendation.type,
        correlationId,
      })
    }

    // ── 5. POLICY, THEN EXECUTION OR A QUESTION ─────────────────────────
    // The recommendation is a REQUEST. classify() decides what happens to it,
    // and the mode decides whether it happens at all.
    let actionsExecuted = 0
    let approvalsCreated = 0
    const actionsByIncident = new Map<string, string>()
    const approvalsByIncident = new Map<string, string>()
    let recommendationText: string | null = null

    const recommendation = investigation.decision?.recommendation
    if (recommendation && recommendation.type !== 'none' && leadIncident) {
      const decision = classify(recommendation.toolName, settings.mode)
      recommendationText = `${recommendation.toolName} — ${recommendation.rationale.slice(0, 200)}`

      const ctx: ToolContext = {
        settings,
        correlationId,
        runId: runRow.id,
        incidentId: leadIncident.incidentId,
        actor: 'agent',
        actorName: 'operations agent',
        aiProvider: investigation.provider,
        aiModel: investigation.model,
        actionsUsed: actionsExecuted,
        now,
      }

      if (decision.classification === 'forbidden') {
        // Recorded, not executed, and the incident timeline says the model
        // asked for something it may not have.
        await addIncidentEvent(leadIncident.incidentId, 'note', `The agent recommended ${recommendation.toolName}, which policy forbids: ${decision.reason}`, {
          toolName: recommendation.toolName,
          correlationId,
        })
      } else if (recommendation.type === 'approval_request' || decision.classification === 'approval_required') {
        const created = await createApprovalRequest(
          recommendation.toolName,
          recommendation.arguments,
          ctx,
          recommendation.rationale,
          {
            question: recommendation.type === 'approval_request' ? recommendation.approvalQuestion : `Approve ${recommendation.toolName}?`,
            incidentId: leadIncident.incidentId,
          }
        )
        approvalsByIncident.set(leadIncident.incidentId, created.reference)
        approvalsCreated++
      } else if (settings.mode === 'safe_auto') {
        const result = await executeTool(recommendation.toolName, recommendation.arguments, ctx)
        if (result.status === 'succeeded') {
          actionsExecuted++
          actionsByIncident.set(leadIncident.incidentId, result.message)
          await prisma.emailAgentIncident
            .update({ where: { id: leadIncident.incidentId }, data: { status: 'mitigated' } })
            .catch(() => undefined)
        } else {
          actionsByIncident.set(leadIncident.incidentId, `attempted ${recommendation.toolName} — ${result.message}`)
        }
      } else {
        // read_only: the recommendation is recorded and nothing executes.
        await addIncidentEvent(
          leadIncident.incidentId,
          'note',
          `Recommended ${recommendation.toolName} but the agent is in ${settings.mode} mode, so nothing was executed.`,
          { toolName: recommendation.toolName, correlationId }
        )
      }
    }

    // ── 6. LESSONS ──────────────────────────────────────────────────────
    const lesson = investigation.decision?.memoryLessonCandidate
    if (lesson && leadIncident) {
      await recordLesson({
        patternKey: lesson.patternKey,
        title: investigation.decision!.summary.slice(0, 200),
        probableCause: investigation.decision!.probableCause ?? lesson.summary,
        symptoms: report.findings.slice(0, 8).map((f) => f.title),
        checkIds: Array.from(new Set(report.findings.map((f) => f.checkId))),
        now,
      }).catch((err) => log.warn({ err: safeErrorMessage(err) }, 'could not record a lesson'))
    }

    // ── 6b. BUDGET THRESHOLD ALERT ──────────────────────────────────────
    // Once per threshold per billing period. An owner should learn that AI
    // analysis is about to stop BEFORE it stops, and should not be told the
    // same thing every five minutes afterwards.
    try {
      const usage = await readUsage(settings, now)
      const alert = budgetAlertToRaise({
        monthlyPercentUsed: usage.monthlyPercentUsed,
        monthKey: usage.monthKey,
        lastAlertPeriod: settings.budgetAlertPeriod,
        lastAlertLevel: settings.budgetAlertLevel,
        monthlyLimitUsd: usage.limits.costPerMonth,
        monthSpendUsd: usage.month.costUsd,
      })
      if (alert && settings.alertsEnabled) {
        const delivered = await postOpsAlert(`EMAIL AGENT — AI budget at ${alert.level}%`, [
          { message: alert.message, action: alert.action },
        ])
        // Recorded whether or not Discord accepted it: re-alerting every cycle
        // because a webhook was down is worse than missing one notice.
        await recordBudgetAlert(alert.level, usage.monthKey)
        if (!delivered.delivered) {
          log.warn({ level: alert.level, reason: delivered.reason }, 'budget alert could not be delivered')
        }
      }
    } catch (err) {
      log.warn({ err: safeErrorMessage(err) }, 'budget alert evaluation failed')
    }

    // ── 6c. SAFE-AUTO SELF-DOWNGRADE ────────────────────────────────────
    // The agent may always REMOVE its own permission to act. It can never
    // grant it. Evaluated every cycle so a cascade is caught within minutes
    // rather than at the next time somebody looks at the dashboard.
    if (settings.mode === 'safe_auto') {
      try {
        const counts = await readBlastRadiusCounts({
          tool: 'any',
          argumentsHash: 'n/a',
          resourceId: null,
          now,
          settings,
        })
        const hourAgo = new Date(now.getTime() - 3600_000)
        const [incidentsAfter, actionsInLastHour] = await Promise.all([
          prisma.emailAgentIncident.count({ where: { createdAt: { gte: hourAgo }, environment: where.environment } }),
          prisma.emailAgentAction.count({
            where: { startedAt: { gte: hourAgo }, actor: 'agent', status: 'succeeded', environment: where.environment },
          }),
        ])
        const incidentsBefore = await prisma.emailAgentIncident.count({
          where: {
            createdAt: { gte: new Date(now.getTime() - 2 * 3600_000), lt: hourAgo },
            environment: where.environment,
          },
        })
        const verdict = shouldDowngradeSafeAuto({
          mode: settings.mode,
          consecutiveFailures: counts.consecutiveFailures,
          failureThreshold: settings.autoFailureDowngradeThreshold,
          actionsInLastHour,
          incidentsOpenedBeforeActions: incidentsBefore,
          incidentsOpenedAfterActions: incidentsAfter,
        })
        if (verdict.downgrade) {
          const done = await downgradeSafeAuto(verdict.reason, correlationId)
          if (done && settings.alertsEnabled) {
            await postOpsAlert('EMAIL AGENT — SAFE-AUTO DISABLED AUTOMATICALLY', [
              { message: verdict.reason, action: 'Review the actions the agent took, then re-enable safe-auto deliberately if it is right to.' },
            ])
          }
        }
      } catch (err) {
        log.warn({ err: safeErrorMessage(err) }, 'safe-auto downgrade evaluation failed')
      }
    }

    // ── 7. ALERTS ───────────────────────────────────────────────────────
    const alertResult = await alertForIncidents(outcomes, {
      settings,
      now,
      correlationId,
      actionsByIncident,
      approvalsByIncident,
      recommendation: recommendationText,
    })
    const digestSent = await sendWarningDigest({ settings, now })

    // ── 8. CLOSE THE RUN ────────────────────────────────────────────────
    const summary = investigation.decision?.summary
      ?? deterministicSummary({
        status: report.overallStatus,
        findings: report.findings,
        errors: report.errors.length,
        opened,
        resolved: resolvedCount,
        aiReason: investigation.skippedReason,
      })

    const durationMs = Date.now() - started
    await prisma.emailAgentRun.update({
      where: { id: runRow.id },
      data: {
        status: 'completed',
        overallStatus: report.overallStatus,
        checksRun: report.checksRun,
        checksFailed: report.errors.length,
        findingsTotal: report.findings.length,
        findingsInfo: count(report.findings, 'info'),
        findingsWarning: warnings,
        findingsCritical: criticals,
        incidentsOpened: opened,
        incidentsUpdated: updated,
        incidentsResolved: resolvedCount,
        actionsExecuted,
        approvalsCreated,
        alertsSent: alertResult.sent + (digestSent ? 1 : 0),
        aiInvoked: investigation.invoked,
        aiSkippedReason: investigation.skippedReason ?? null,
        aiSkippedCount,
        aiCostUsd: investigation.costUsd,
        summary: summary.slice(0, 4000),
        checkErrors: redact(report.errors) as never,
        report: redact({
          overallStatus: report.overallStatus,
          inspected: report.inspected,
          findings: report.findings.map((f) => ({ checkId: f.checkId, severity: f.severity, title: f.title, category: f.category })),
        }) as never,
        durationMs,
        completedAt: new Date(),
      },
    })

    log.info(
      {
        correlationId, status: report.overallStatus, findings: report.findings.length,
        opened, updated, resolved: resolvedCount, actionsExecuted, approvalsCreated,
        alerts: alertResult.sent, ai: investigation.outcome,
        aiCalls: investigation.callsMade, aiSkipped: aiSkippedCount,
        aiCostUsd: investigation.costUsd, usedFallback: investigation.usedFallback,
        environment: where.environment, service: where.service, durationMs,
      },
      'agent cycle complete'
    )

    return {
      ran: true,
      runId: runRow.id,
      correlationId,
      overallStatus: report.overallStatus,
      findings: report.findings.length,
      criticals,
      warnings,
      incidentsOpened: opened,
      incidentsUpdated: updated,
      incidentsResolved: resolvedCount,
      actionsExecuted,
      approvalsCreated,
      alertsSent: alertResult.sent + (digestSent ? 1 : 0),
      aiInvoked: investigation.invoked,
      aiSkippedReason: investigation.skippedReason,
      aiSkippedCount,
      aiCostUsd: investigation.costUsd,
      summary,
      durationMs,
    }
  } catch (err) {
    const message = safeErrorMessage(err)
    log.error({ err: message, correlationId }, 'agent cycle FAILED')
    if (runId) {
      await prisma.emailAgentRun
        .update({
          where: { id: runId },
          data: { status: 'failed', error: message, completedAt: new Date(), durationMs: Date.now() - started, summary: `The agent cycle failed: ${message}` },
        })
        .catch(() => undefined)
    }
    return { ...base, ran: false, runId, skippedReason: message, summary: `The agent cycle failed: ${message}`, durationMs: Date.now() - started }
  }
}
