// ════════════════════════════════════════════════════════════════════════
//  SAFE-AUTO BLAST RADIUS (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  SAFE-AUTO IS OFF AND STAYS OFF. This file exists anyway, and that ordering
//  is the point: the time to build the limit is before somebody enables the
//  thing it limits. Shipping safe_auto and its guards together means the guards
//  were never exercised before the day they mattered.
//
//  THE FAILURE MODE THESE PREVENT is not one bad action — the policy engine and
//  the per-tool executors already handle that. It is a CASCADE: a check starts
//  misfiring, produces the same finding against forty runs, and the agent
//  "repairs" forty things nobody asked it to touch. Every limit below caps a
//  different axis of that cascade:
//
//      per day        — total damage in 24 hours
//      per tool/day   — one misfiring check cannot spend the whole budget
//      per incident   — a single incident cannot be repaired indefinitely
//      per resource   — the same run is not touched twice in an hour
//      identical      — the same tool + arguments + evidence never repeats
//
//  AND ONE THAT CAPS THE AGENT ITSELF: repeated failures, or an incident spike
//  that FOLLOWS automatic actions, drop safe_auto back to read_only. The agent
//  can always take away its own permission. It can never grant it — that
//  direction is `enableSafeAutoMode`, which is forbidden and has no executor.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { prisma } from '../db'
import { queueLogger } from '../logger'
import { detectEnvironment } from './environment'
import { safeErrorMessage } from './redact'
import type { AgentSettings } from './settings'
import type { AgentToolName } from './types'

const log = queueLogger.child({ mod: 'email-agent-blast-radius' })

/** Tools that change something and therefore consume blast-radius budget. */
const MUTATING_TOOLS: AgentToolName[] = [
  'reconcileRunCounters',
  'finalizeSettledRun',
  'releaseExpiredLock',
  'reprocessValidWebhookEvent',
  'retryTransientSendOnce',
  'pauseCampaign',
  'pauseMarketingDispatch',
]

export const isMutatingTool = (tool: string): boolean => (MUTATING_TOOLS as string[]).includes(tool)

/**
 * Identity of "this exact action, for this exact reason".
 *
 * Includes the EVIDENCE hash, not just the arguments: re-running
 * `reconcileRunCounters` on run X is legitimate if the counters drifted again,
 * and is a bug if nothing changed. Arguments alone cannot tell those apart.
 */
export function actionFingerprint(tool: string, args: Record<string, unknown>, evidenceHash: string | null): string {
  const subject = Object.entries(args)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&')
  return crypto.createHash('sha256').update(`${tool}::${subject}::${evidenceHash ?? 'no-evidence'}`).digest('hex').slice(0, 32)
}

export type BlastRadiusVerdict =
  | { allowed: true }
  | { allowed: false; limit: string; reason: string }

export type BlastRadiusCounts = {
  actionsToday: number
  actionsForToolToday: number
  actionsForIncident: number
  lastActionOnResourceAt: Date | null
  identicalActionExists: boolean
  consecutiveFailures: number
}

/**
 * Pure evaluation, so every ceiling is testable without a database.
 *
 * Ordered cheapest-signal-first, and the identical-action check comes before
 * the count limits deliberately: "we already did exactly this" is a better
 * explanation to an operator than "the daily limit is full".
 */
export function evaluateBlastRadius(
  counts: BlastRadiusCounts,
  settings: AgentSettings,
  options: { tool: string; now: Date }
): BlastRadiusVerdict {
  if (counts.identicalActionExists) {
    return {
      allowed: false,
      limit: 'identical_action',
      reason: `${options.tool} has already been performed against this exact resource for this exact evidence. Repeating it would change nothing and hide the fact that the first attempt did not help.`,
    }
  }

  if (counts.lastActionOnResourceAt) {
    const sinceMs = options.now.getTime() - counts.lastActionOnResourceAt.getTime()
    const cooldownMs = settings.resourceActionCooldownMinutes * 60_000
    if (sinceMs < cooldownMs) {
      const waitMin = Math.ceil((cooldownMs - sinceMs) / 60_000)
      return {
        allowed: false,
        limit: 'resource_cooldown',
        reason: `This resource was touched by ${options.tool} ${Math.round(sinceMs / 60_000)} minutes ago. A ${settings.resourceActionCooldownMinutes}-minute cooldown applies; ${waitMin} minutes remain.`,
      }
    }
  }

  if (counts.actionsForIncident >= settings.maxAutoActionsPerIncident) {
    return {
      allowed: false,
      limit: 'per_incident',
      reason: `${counts.actionsForIncident} automatic actions have already been taken for this incident (limit ${settings.maxAutoActionsPerIncident}). If it is still not fixed, it needs a person, not another attempt.`,
    }
  }

  if (counts.actionsForToolToday >= settings.maxAutoActionsPerToolDay) {
    return {
      allowed: false,
      limit: 'per_tool_day',
      reason: `${options.tool} has run ${counts.actionsForToolToday} times today (limit ${settings.maxAutoActionsPerToolDay}). One repeatedly-firing check must not consume the whole day's budget.`,
    }
  }

  if (counts.actionsToday >= settings.maxAutoActionsPerDay) {
    return {
      allowed: false,
      limit: 'per_day',
      reason: `The agent has taken ${counts.actionsToday} automatic actions today (limit ${settings.maxAutoActionsPerDay}). Further repairs wait for tomorrow or for a person.`,
    }
  }

  return { allowed: true }
}

/** Gather the counts the evaluation needs. Environment-scoped. */
export async function readBlastRadiusCounts(input: {
  tool: string
  incidentId?: string
  argumentsHash: string
  resourceId: string | null
  now: Date
  settings: AgentSettings
}): Promise<BlastRadiusCounts> {
  const environment = detectEnvironment()
  const dayStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()))
  // Only SUCCEEDED actions consume budget. A refused attempt changed nothing
  // and must not lock out a legitimate repair.
  const consumed = { environment, actor: 'agent', status: 'succeeded' as const }

  const [actionsToday, actionsForToolToday, actionsForIncident, lastOnResource, identical, recent] = await Promise.all([
    prisma.emailAgentAction.count({ where: { ...consumed, startedAt: { gte: dayStart } } }),
    prisma.emailAgentAction.count({ where: { ...consumed, toolName: input.tool, startedAt: { gte: dayStart } } }),
    input.incidentId
      ? prisma.emailAgentAction.count({ where: { ...consumed, incidentId: input.incidentId } })
      : Promise.resolve(0),
    input.resourceId
      ? prisma.emailAgentAction.findFirst({
          where: {
            ...consumed,
            toolName: input.tool,
            OR: [{ campaignId: input.resourceId }, { runRefId: input.resourceId }, { sendId: input.resourceId }],
          },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true },
        })
      : Promise.resolve(null),
    prisma.emailAgentAction.findFirst({
      where: { environment, argumentsHash: input.argumentsHash, status: 'succeeded' },
      select: { id: true },
    }),
    // Consecutive failures, newest first — the auto-downgrade signal.
    prisma.emailAgentAction.findMany({
      where: { environment, actor: 'agent', status: { in: ['succeeded', 'failed'] }, startedAt: { gte: dayStart } },
      orderBy: { startedAt: 'desc' },
      select: { status: true },
      take: 20,
    }),
  ])

  let consecutiveFailures = 0
  for (const a of recent) {
    if (a.status === 'failed') consecutiveFailures++
    else break
  }

  return {
    actionsToday,
    actionsForToolToday,
    actionsForIncident,
    lastActionOnResourceAt: lastOnResource?.startedAt ?? null,
    identicalActionExists: identical !== null,
    consecutiveFailures,
  }
}

// ── Automatic downgrade ─────────────────────────────────────────────────

export type DowngradeDecision = { downgrade: false } | { downgrade: true; reason: string }

/**
 * Should safe_auto drop back to read_only right now?
 *
 * Pure. Two independent signals, and either alone is enough:
 *
 *   REPEATED FAILURE — automatic actions failing in a row means the agent's
 *   model of the system is wrong. Continuing to act on a wrong model is how a
 *   small problem becomes a large one.
 *
 *   POST-ACTION INCIDENT SPIKE — incidents rising sharply AFTER the agent
 *   started acting is the signature of an agent causing harm. The ordering
 *   matters: a spike with no preceding actions is just a bad day, and
 *   downgrading for that would remove a capability for no reason.
 *
 * The direction is one-way. There is no corresponding `shouldUpgrade`.
 */
export function shouldDowngradeSafeAuto(input: {
  mode: string
  consecutiveFailures: number
  failureThreshold: number
  actionsInLastHour: number
  incidentsOpenedBeforeActions: number
  incidentsOpenedAfterActions: number
}): DowngradeDecision {
  if (input.mode !== 'safe_auto') return { downgrade: false }

  if (input.consecutiveFailures >= input.failureThreshold) {
    return {
      downgrade: true,
      reason:
        `${input.consecutiveFailures} automatic actions failed in a row (threshold ${input.failureThreshold}). ` +
        `Repeated failure means the agent's understanding of the system is wrong, and acting on a wrong understanding makes things worse. ` +
        `Safe-auto is off; the agent will keep watching and reporting.`,
    }
  }

  // A spike only counts when the agent had actually been acting.
  const spiked =
    input.actionsInLastHour > 0 &&
    input.incidentsOpenedAfterActions >= 3 &&
    input.incidentsOpenedAfterActions >= input.incidentsOpenedBeforeActions * 2 + 2

  if (spiked) {
    return {
      downgrade: true,
      reason:
        `Incidents rose sharply after the agent took ${input.actionsInLastHour} automatic action(s) ` +
        `(${input.incidentsOpenedBeforeActions} before → ${input.incidentsOpenedAfterActions} after). ` +
        `That pattern is what an agent causing harm looks like, so safe-auto turned itself off pending a human review.`,
    }
  }

  return { downgrade: false }
}

/**
 * Perform the downgrade: flip the mode, record why, and leave an immutable
 * trace. Never throws — failing to downgrade must not also crash the cycle.
 */
export async function downgradeSafeAuto(reason: string, correlationId: string): Promise<boolean> {
  try {
    const current = await prisma.emailAgentSettings.findUnique({ where: { id: 'singleton' }, select: { mode: true } })
    if (current?.mode !== 'safe_auto') return false

    await prisma.emailAgentSettings.update({
      where: { id: 'singleton' },
      data: {
        // THE SAFE DIRECTION, always. Never `off` — losing the monitoring too
        // would turn one problem into two.
        mode: 'read_only',
        autoDowngradeReason: reason.slice(0, 1000),
        autoDowngradedAt: new Date(),
        updatedByName: 'operations agent (automatic downgrade)',
      },
    })

    // Immutable evidence, in the same append-only table as everything else.
    await prisma.emailAgentAction.create({
      data: {
        toolName: 'downgradeSafeAuto',
        arguments: { reason: reason.slice(0, 500) } as never,
        policyClassification: 'automatic',
        policyReason: 'The agent may always REMOVE its own permission to act. It may never grant it.',
        status: 'succeeded',
        beforeState: { mode: 'safe_auto' } as never,
        afterState: { mode: 'read_only' } as never,
        result: { reason: reason.slice(0, 500) } as never,
        actor: 'agent',
        actorName: 'operations agent',
        correlationId,
        environment: detectEnvironment(),
        completedAt: new Date(),
      },
    })

    log.error({ reason, correlationId }, 'SAFE-AUTO AUTOMATICALLY DISABLED — agent dropped to read_only')
    return true
  } catch (err) {
    log.error({ err: safeErrorMessage(err) }, 'could not perform the safe-auto downgrade')
    return false
  }
}
