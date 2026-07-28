// ════════════════════════════════════════════════════════════════════════
//  HEARTBEAT + EFFECTIVE STATUS (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  TWO QUESTIONS THE ADMIN MUST NEVER GET WRONG:
//    "is the agent actually running?"  and  "what is it actually allowed to do?"
//
//  Both were previously answerable only by inference, and inference lied in the
//  same direction every time — towards "fine". A page that reads the settings
//  row successfully is a page that proved the DATABASE works, which says
//  nothing whatsoever about whether a worker is alive. A settings row saying
//  `safe_auto` while EMAIL_AGENT_ENABLED is unset means the agent is OFF, and
//  showing "safe_auto" there is not a cosmetic problem: it is telling an owner
//  their email system is being watched when nothing is watching it.
//
//  So this file separates three things that were one thing:
//
//    REQUESTED  — what the database row asks for (the operator's intent)
//    ALLOWED    — what the environment permits (the deployment's ceiling)
//    EFFECTIVE  — what will actually happen, with the REASON when they differ
//
//  And it computes the heartbeat from PRODUCTION WORKER cycles only. A manual
//  run from the admin proves a person clicked a button; it does not prove the
//  cron is alive, and counting it would hide exactly the failure the heartbeat
//  exists to catch.
//
//  THE AGENT CANNOT DETECT ITS OWN DEATH FROM INSIDE ITSELF. A dead worker
//  writes nothing, including "I am dead". That is why `heartbeatState()` is
//  computed by the READER from the age of the last record, and why the health
//  endpoint is meant to be polled by something outside this deployment.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { detectEnvironment, isPlatformRuntime, type AgentEnvironment } from './environment'
import { safeErrorMessage } from './redact'
import { agentDisabledByEnv, type AgentSettings } from './settings'
import type { EmailAgentMode } from './types'

/** Multiples of the configured interval before a heartbeat is called late. */
export const HEARTBEAT_DELAYED_INTERVALS = 3
export const HEARTBEAT_STALE_INTERVALS = 6

export type HeartbeatState = 'never_run' | 'healthy' | 'delayed' | 'stale' | 'disabled' | 'failing'

export type Heartbeat = {
  state: HeartbeatState
  /** One sentence for a human. */
  message: string
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastChecksCompletedAt: string | null
  lastInvestigationAt: string | null
  ageSeconds: number | null
  expectedIntervalSeconds: number
  lastStatus: string | null
  lastDurationMs: number | null
  environment: string | null
  service: string | null
  deploymentId: string | null
  consecutiveFailures: number
}

/**
 * Pure heartbeat classification.
 *
 * Separated from the query so every state is testable without a database, and
 * so the thresholds are visible in one place rather than buried in a `where`.
 */
export function heartbeatState(input: {
  enabled: boolean
  lastRunAt: Date | null
  lastSuccessAt: Date | null
  lastStatus: string | null
  consecutiveFailures: number
  intervalMinutes: number
  now: Date
}): { state: HeartbeatState; message: string; ageSeconds: number | null } {
  const intervalMs = Math.max(1, input.intervalMinutes) * 60_000

  if (!input.enabled) {
    return {
      state: 'disabled',
      message: 'The agent is switched off, so no cycles are expected. Nothing is being checked.',
      ageSeconds: input.lastRunAt ? Math.round((input.now.getTime() - input.lastRunAt.getTime()) / 1000) : null,
    }
  }

  if (!input.lastRunAt) {
    return {
      state: 'never_run',
      message: 'The agent is enabled but has never completed a cycle. If the worker has been running for more than a few minutes, it is not picking up the job.',
      ageSeconds: null,
    }
  }

  const ageMs = input.now.getTime() - input.lastRunAt.getTime()
  const ageSeconds = Math.round(ageMs / 1000)
  const minutes = Math.round(ageMs / 60_000)

  // FAILING outranks the age check: a worker that runs on time and fails every
  // time is alive and useless, which "healthy" would completely conceal.
  if (input.consecutiveFailures >= 3) {
    return {
      state: 'failing',
      message: `The agent is running on schedule but its last ${input.consecutiveFailures} cycles all failed. It is alive and producing nothing.`,
      ageSeconds,
    }
  }

  if (ageMs > intervalMs * HEARTBEAT_STALE_INTERVALS) {
    return {
      state: 'stale',
      message: `No agent cycle for ${minutes} minutes, against a ${input.intervalMinutes}-minute schedule. The worker is almost certainly not running — nothing is watching the email system.`,
      ageSeconds,
    }
  }
  if (ageMs > intervalMs * HEARTBEAT_DELAYED_INTERVALS) {
    return {
      state: 'delayed',
      message: `The last agent cycle was ${minutes} minutes ago, later than the ${input.intervalMinutes}-minute schedule. One slow cycle or a deploy explains this; a rising number does not.`,
      ageSeconds,
    }
  }
  if (input.lastStatus === 'failed') {
    return { state: 'delayed', message: `The agent ran ${minutes} minutes ago but that cycle FAILED. The next cycle may recover.`, ageSeconds }
  }
  return { state: 'healthy', message: `The agent completed a cycle ${minutes} minute${minutes === 1 ? '' : 's'} ago, on schedule.`, ageSeconds }
}

/**
 * Read the heartbeat from PRODUCTION WORKER cycles.
 *
 * `service: 'worker'` and `source: 'scheduled'` are the filter that makes this
 * meaningful: a manual admin run or a local cycle must never make a dead cron
 * look alive.
 */
export async function readHeartbeat(settings: AgentSettings, now: Date = new Date()): Promise<Heartbeat> {
  const environment = detectEnvironment()
  const expectedIntervalSeconds = settings.intervalMinutes * 60
  const enabled = settings.mode !== 'off'

  const base: Heartbeat = {
    state: 'never_run',
    message: '',
    lastRunAt: null,
    lastSuccessAt: null,
    lastChecksCompletedAt: null,
    lastInvestigationAt: null,
    ageSeconds: null,
    expectedIntervalSeconds,
    lastStatus: null,
    lastDurationMs: null,
    environment,
    service: null,
    deploymentId: null,
    consecutiveFailures: 0,
  }

  try {
    const scheduled = { environment, service: 'worker', source: 'scheduled' }
    const [latest, lastSuccess, recent] = await Promise.all([
      prisma.emailAgentRun.findFirst({ where: scheduled, orderBy: { startedAt: 'desc' } }),
      prisma.emailAgentRun.findFirst({ where: { ...scheduled, status: 'completed' }, orderBy: { startedAt: 'desc' } }),
      prisma.emailAgentRun.findMany({ where: scheduled, orderBy: { startedAt: 'desc' }, select: { status: true }, take: 10 }),
    ])

    let consecutiveFailures = 0
    for (const r of recent) {
      if (r.status === 'failed') consecutiveFailures++
      else break
    }

    const classified = heartbeatState({
      enabled,
      lastRunAt: latest?.startedAt ?? null,
      lastSuccessAt: lastSuccess?.startedAt ?? null,
      lastStatus: latest?.status ?? null,
      consecutiveFailures,
      intervalMinutes: settings.intervalMinutes,
      now,
    })

    return {
      ...base,
      state: classified.state,
      message: classified.message,
      ageSeconds: classified.ageSeconds,
      lastRunAt: latest?.startedAt.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.startedAt.toISOString() ?? null,
      lastChecksCompletedAt: latest?.checksCompletedAt?.toISOString() ?? null,
      lastInvestigationAt: latest?.aiInvoked ? latest.startedAt.toISOString() : null,
      lastStatus: latest?.status ?? null,
      lastDurationMs: latest?.durationMs ?? null,
      service: latest?.service ?? null,
      deploymentId: latest?.deploymentId ?? null,
      consecutiveFailures,
    }
  } catch (err) {
    return {
      ...base,
      state: enabled ? 'stale' : 'disabled',
      message: `The heartbeat could not be read: ${safeErrorMessage(err, 160)}. Treat this as unknown, not healthy.`,
    }
  }
}

// ── Effective status ────────────────────────────────────────────────────

export type EffectiveStatus = {
  /** What the database row asks for. */
  requestedMode: EmailAgentMode
  /** The ceiling the environment permits. */
  allowedMode: EmailAgentMode
  /** What will actually happen. */
  effectiveMode: EmailAgentMode
  /** Why effective differs from requested. Null when they agree. */
  reason: string | null
  environment: AgentEnvironment
  platformRuntime: boolean
  aiEnabled: boolean
  aiReason: string | null
  alertsConfigured: boolean
  alertsReason: string | null
  dispatchPaused: boolean
  safeAutoActive: boolean
  settingsDegraded: boolean
  autoDowngradeReason: string | null
  /** Names only — never a value. */
  configuration: Array<{ key: string; present: boolean; requiredFor: string }>
}

/**
 * Is this value REALLY configured?
 *
 * Placeholder-aware. A literal `PASTE_ALERTS_CHANNEL_ID` was previously treated
 * as a real channel id, so the alert path reported itself configured and
 * Discord answered `400 Invalid Form Body`. Unconfigured must LOOK
 * unconfigured, not broken.
 */
const configured = (v?: string): boolean => {
  const t = v?.trim()
  if (!t) return false
  return !/^(REPLACE|PASTE|YOUR|CHANGE_?ME|TODO|XXX)/i.test(t) && !t.includes('REPLACE')
}

/**
 * Reconcile intent, permission and reality.
 *
 * Pure over (settings, env), so every precedence combination is testable.
 */
export function effectiveStatus(settings: AgentSettings, env: NodeJS.ProcessEnv = process.env): EffectiveStatus {
  const environment = detectEnvironment(env)
  const envDisabled = agentDisabledByEnv(env)

  // The environment sets a CEILING; the row cannot exceed it.
  const allowedMode: EmailAgentMode = envDisabled ? 'off' : 'safe_auto'
  const requestedMode = settings.mode
  const effectiveMode: EmailAgentMode = envDisabled ? 'off' : requestedMode

  let reason: string | null = null
  if (envDisabled && requestedMode !== 'off') {
    reason = `EMAIL_AGENT_ENABLED is not "true", so the agent is off regardless of the stored mode (${requestedMode}). Set it on the worker service to activate.`
  } else if (settings.degraded) {
    reason = `The settings row could not be read (${settings.degradedReason ?? 'unknown'}), so environment defaults are in force and any stored pause is NOT being applied.`
  }

  const provider = (settings.provider ?? env.EMAIL_AGENT_PROVIDER ?? 'deepseek').toLowerCase()
  const providerKey = provider === 'openai' ? env.OPENAI_API_KEY : env.DEEPSEEK_API_KEY
  const aiKeyPresent = configured(providerKey)
  const aiEnabled = settings.aiEnabled && aiKeyPresent && effectiveMode !== 'off'
  const aiReason = !settings.aiEnabled
    ? 'AI analysis is switched off. Deterministic checks, incidents and alerts are unaffected.'
    : !aiKeyPresent
      ? `No API key is configured for ${provider}, so investigation is skipped every cycle.`
      : effectiveMode === 'off'
        ? 'The agent is off, so nothing is investigated.'
        : null

  const alertsConfigured =
    configured(env.DISCORD_BOT_TOKEN) && (configured(env.DISCORD_CHANNEL_ALERTS) || configured(env.DISCORD_CHANNEL_OPERATIONS))
  const alertsReason = !settings.alertsEnabled
    ? 'Alerts are switched off in settings.'
    : !alertsConfigured
      ? 'No Discord bot token or channel is configured, so alerts have nowhere to go.'
      : null

  return {
    requestedMode,
    allowedMode,
    effectiveMode,
    reason,
    environment,
    platformRuntime: isPlatformRuntime(env),
    aiEnabled,
    aiReason,
    alertsConfigured: alertsConfigured && settings.alertsEnabled,
    alertsReason,
    dispatchPaused: settings.marketingDispatchPaused,
    // The one flag an operator scans for. True ONLY when it is genuinely live.
    safeAutoActive: effectiveMode === 'safe_auto',
    settingsDegraded: settings.degraded,
    autoDowngradeReason: settings.autoDowngradeReason,
    configuration: [
      { key: 'EMAIL_AGENT_ENABLED', present: !envDisabled, requiredFor: 'the agent to run at all' },
      { key: 'DATABASE_URL', present: configured(env.DATABASE_URL), requiredFor: 'everything' },
      { key: provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY', present: aiKeyPresent, requiredFor: 'AI investigation' },
      { key: 'DISCORD_BOT_TOKEN', present: configured(env.DISCORD_BOT_TOKEN), requiredFor: 'alert delivery' },
      { key: 'RESEND_WEBHOOK_SECRET', present: configured(env.RESEND_WEBHOOK_SECRET), requiredFor: 'bounce and complaint suppression' },
      { key: 'BUSINESS_POSTAL_ADDRESS', present: configured(env.BUSINESS_POSTAL_ADDRESS), requiredFor: 'promotional compliance' },
    ],
  }
}

/**
 * The single word an operator sees at the top of the page.
 *
 * `healthy` requires the agent to be ON, the worker to be ALIVE, and the last
 * cycle to have PASSED. Any one of those missing produces something else —
 * "the database answered" is never enough.
 */
export function overallBadge(
  status: EffectiveStatus,
  heartbeat: Heartbeat,
  lastOverallStatus: string | null
): { badge: 'healthy' | 'warning' | 'critical' | 'off' | 'unknown'; message: string } {
  if (status.effectiveMode === 'off') {
    return { badge: 'off', message: status.reason ?? 'The agent is switched off. Nothing is being checked.' }
  }
  if (heartbeat.state === 'never_run') return { badge: 'unknown', message: heartbeat.message }
  if (heartbeat.state === 'stale' || heartbeat.state === 'failing') return { badge: 'critical', message: heartbeat.message }
  if (heartbeat.state === 'delayed') return { badge: 'warning', message: heartbeat.message }
  if (status.settingsDegraded) return { badge: 'critical', message: status.reason ?? 'The agent cannot read its own settings.' }

  if (lastOverallStatus === 'critical') return { badge: 'critical', message: 'The last cycle found critical problems.' }
  if (lastOverallStatus === 'warning') return { badge: 'warning', message: 'The last cycle found warnings.' }
  if (lastOverallStatus === 'healthy') return { badge: 'healthy', message: heartbeat.message }
  return { badge: 'unknown', message: 'No cycle result has been recorded yet.' }
}
