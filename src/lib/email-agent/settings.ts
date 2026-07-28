// ════════════════════════════════════════════════════════════════════════
//  AGENT SETTINGS + KILL SWITCHES (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Resolution order is deliberate and one-directional:
//
//      code defaults  →  environment  →  database row
//
//  ENVIRONMENT sets the deployment's ceiling and its defaults. The DATABASE
//  row is the operator's live control surface, so the owner can pause dispatch
//  from a phone without a redeploy.
//
//  TWO EXCEPTIONS, both fail-safe rather than fail-open:
//
//   1. EMAIL_AGENT_ENABLED=false in the environment forces mode `off` no
//      matter what the row says. A deployment must be able to switch the whole
//      thing off without a working database.
//
//   2. `loadSettings()` NEVER THROWS. If the agent tables do not exist yet, or
//      the database is unreachable, it returns the safe defaults with
//      `degraded: true`. This matters because `isMarketingDispatchPaused()` is
//      called from the real dispatch path: a missing migration must not be
//      able to stop the business sending email, and it must equally not be
//      able to silently ignore a pause the owner actually set — hence
//      `degraded` is surfaced, not swallowed.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { queueLogger } from '../logger'
import { AGENT_MODES, isAgentMode, type EmailAgentMode } from './types'

const log = queueLogger.child({ mod: 'email-agent-settings' })

export const SETTINGS_ID = 'singleton'

export type AgentSettings = {
  mode: EmailAgentMode
  aiEnabled: boolean
  autoActionsEnabled: boolean
  alertsEnabled: boolean
  digestWarnings: boolean
  marketingDispatchPaused: boolean
  pausedReason: string | null
  pausedAt: Date | null
  pausedBy: string | null
  maxAutoActionsPerRun: number
  stageRecipientLimit: number
  intervalMinutes: number
  memoryRetentionDays: number
  provider: string | null
  model: string | null

  // ── AI budget ──
  maxModelCallsPerCycle: number
  maxModelCallsPerDay: number
  maxTokensPerDay: number
  maxTokensPerMonth: number
  maxAiCostUsdPerDay: number
  maxAiCostUsdPerMonth: number
  aiReinvestigateHours: number
  fallbackProvider: string | null
  fallbackModel: string | null
  allowProviderFallback: boolean

  // ── Safe-auto blast radius ──
  maxAutoActionsPerDay: number
  maxAutoActionsPerToolDay: number
  maxAutoActionsPerIncident: number
  resourceActionCooldownMinutes: number
  autoFailureDowngradeThreshold: number
  autoDowngradeReason: string | null
  autoDowngradedAt: Date | null
  budgetAlertPeriod: string | null
  budgetAlertLevel: number
  /** True when the row could not be read and defaults are standing in. */
  degraded: boolean
  degradedReason?: string
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Take a stored number only when it really is one. */
const numberOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

const bool = (raw: string | undefined, fallback: boolean): boolean =>
  raw === undefined || raw.trim() === '' ? fallback : raw.trim().toLowerCase() === 'true'

/**
 * Defaults from the environment alone. Used when there is no row yet, and as
 * the base the row is layered onto.
 *
 * The mode default is `read_only` and that is a product decision, not a
 * placeholder: the first production deployment of anything that can touch
 * customer email observes before it acts.
 */
export function envDefaults(env: NodeJS.ProcessEnv = process.env): AgentSettings {
  const enabled = bool(env.EMAIL_AGENT_ENABLED, false)
  const requested = env.EMAIL_AGENT_MODE?.trim()
  const mode: EmailAgentMode = !enabled ? 'off' : isAgentMode(requested) ? requested : 'read_only'
  return {
    mode,
    aiEnabled: true,
    autoActionsEnabled: true,
    alertsEnabled: true,
    digestWarnings: true,
    marketingDispatchPaused: false,
    pausedReason: null,
    pausedAt: null,
    pausedBy: null,
    maxAutoActionsPerRun: num(env.EMAIL_AGENT_MAX_AUTO_ACTIONS_PER_RUN, 3, 0, 25),
    stageRecipientLimit: num(env.EMAIL_AGENT_STAGE_RECIPIENT_LIMIT, 50, 1, 100000),
    intervalMinutes: num(env.EMAIL_AGENT_INTERVAL_MINUTES, 5, 1, 1440),
    memoryRetentionDays: num(env.EMAIL_AGENT_MEMORY_RETENTION_DAYS, 365, 1, 3650),
    provider: env.EMAIL_AGENT_PROVIDER?.trim() || null,
    model: env.EMAIL_AGENT_MODEL?.trim() || null,

    // ── AI budget. Deliberately small: the preferred ceiling for this whole
    //    agent is under $3/month, and a limit nobody notices is not a limit.
    maxModelCallsPerCycle: num(env.EMAIL_AGENT_MAX_MODEL_CALLS_PER_CYCLE, 2, 0, 20),
    maxModelCallsPerDay: num(env.EMAIL_AGENT_MAX_MODEL_CALLS_PER_DAY, 25, 0, 5000),
    maxTokensPerDay: num(env.EMAIL_AGENT_MAX_TOKENS_PER_DAY, 150_000, 0, 50_000_000),
    maxTokensPerMonth: num(env.EMAIL_AGENT_MAX_TOKENS_PER_MONTH, 3_000_000, 0, 500_000_000),
    maxAiCostUsdPerDay: money(env.EMAIL_AGENT_MAX_AI_COST_USD_PER_DAY, 0.2, 0, 100),
    maxAiCostUsdPerMonth: money(env.EMAIL_AGENT_MAX_AI_COST_USD_PER_MONTH, 3.0, 0, 1000),
    aiReinvestigateHours: num(env.EMAIL_AGENT_AI_REINVESTIGATE_HOURS, 12, 1, 720),
    fallbackProvider: env.EMAIL_AGENT_FALLBACK_PROVIDER?.trim() || null,
    fallbackModel: env.EMAIL_AGENT_FALLBACK_MODEL?.trim() || null,
    allowProviderFallback: bool(env.EMAIL_AGENT_ALLOW_PROVIDER_FALLBACK, true),

    // ── Safe-auto blast radius. Enforced even though safe_auto is off. ──
    maxAutoActionsPerDay: num(env.EMAIL_AGENT_MAX_AUTO_ACTIONS_PER_DAY, 10, 0, 500),
    maxAutoActionsPerToolDay: num(env.EMAIL_AGENT_MAX_AUTO_ACTIONS_PER_TOOL_DAY, 4, 0, 200),
    maxAutoActionsPerIncident: num(env.EMAIL_AGENT_MAX_AUTO_ACTIONS_PER_INCIDENT, 3, 0, 100),
    resourceActionCooldownMinutes: num(env.EMAIL_AGENT_RESOURCE_ACTION_COOLDOWN_MINUTES, 60, 0, 10_080),
    autoFailureDowngradeThreshold: num(env.EMAIL_AGENT_AUTO_FAILURE_DOWNGRADE_THRESHOLD, 3, 1, 100),
    autoDowngradeReason: null,
    autoDowngradedAt: null,
    budgetAlertPeriod: null,
    budgetAlertLevel: 0,

    degraded: false,
  }
}

/** Bounded float parse for a dollar limit. */
const money = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** True when the deployment-level switch is off, whatever the database says. */
export const agentDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !bool(env.EMAIL_AGENT_ENABLED, false)

/**
 * Merge a stored row onto the environment defaults.
 *
 * Pure, so the precedence rules are testable without a database. The env
 * kill switch wins over a stored mode; everything else the row wins, because
 * the row is the operator's live control.
 */
export function mergeSettings(
  base: AgentSettings,
  row: Partial<Record<keyof AgentSettings, unknown>> | null,
  env: NodeJS.ProcessEnv = process.env
): AgentSettings {
  if (!row) return base
  const merged: AgentSettings = {
    ...base,
    mode: isAgentMode(row.mode) ? row.mode : base.mode,
    aiEnabled: typeof row.aiEnabled === 'boolean' ? row.aiEnabled : base.aiEnabled,
    autoActionsEnabled: typeof row.autoActionsEnabled === 'boolean' ? row.autoActionsEnabled : base.autoActionsEnabled,
    alertsEnabled: typeof row.alertsEnabled === 'boolean' ? row.alertsEnabled : base.alertsEnabled,
    digestWarnings: typeof row.digestWarnings === 'boolean' ? row.digestWarnings : base.digestWarnings,
    marketingDispatchPaused:
      typeof row.marketingDispatchPaused === 'boolean' ? row.marketingDispatchPaused : base.marketingDispatchPaused,
    pausedReason: typeof row.pausedReason === 'string' ? row.pausedReason : base.pausedReason,
    pausedAt: row.pausedAt instanceof Date ? row.pausedAt : base.pausedAt,
    pausedBy: typeof row.pausedBy === 'string' ? row.pausedBy : base.pausedBy,
    maxAutoActionsPerRun:
      typeof row.maxAutoActionsPerRun === 'number' ? row.maxAutoActionsPerRun : base.maxAutoActionsPerRun,
    stageRecipientLimit:
      typeof row.stageRecipientLimit === 'number' ? row.stageRecipientLimit : base.stageRecipientLimit,
    intervalMinutes: typeof row.intervalMinutes === 'number' ? row.intervalMinutes : base.intervalMinutes,
    memoryRetentionDays:
      typeof row.memoryRetentionDays === 'number' ? row.memoryRetentionDays : base.memoryRetentionDays,
    provider: typeof row.provider === 'string' && row.provider ? row.provider : base.provider,
    model: typeof row.model === 'string' && row.model ? row.model : base.model,

    maxModelCallsPerCycle: numberOr(row.maxModelCallsPerCycle, base.maxModelCallsPerCycle),
    maxModelCallsPerDay: numberOr(row.maxModelCallsPerDay, base.maxModelCallsPerDay),
    maxTokensPerDay: numberOr(row.maxTokensPerDay, base.maxTokensPerDay),
    maxTokensPerMonth: numberOr(row.maxTokensPerMonth, base.maxTokensPerMonth),
    maxAiCostUsdPerDay: numberOr(row.maxAiCostUsdPerDay, base.maxAiCostUsdPerDay),
    maxAiCostUsdPerMonth: numberOr(row.maxAiCostUsdPerMonth, base.maxAiCostUsdPerMonth),
    aiReinvestigateHours: numberOr(row.aiReinvestigateHours, base.aiReinvestigateHours),
    fallbackProvider: typeof row.fallbackProvider === 'string' && row.fallbackProvider ? row.fallbackProvider : base.fallbackProvider,
    fallbackModel: typeof row.fallbackModel === 'string' && row.fallbackModel ? row.fallbackModel : base.fallbackModel,
    allowProviderFallback: typeof row.allowProviderFallback === 'boolean' ? row.allowProviderFallback : base.allowProviderFallback,

    maxAutoActionsPerDay: numberOr(row.maxAutoActionsPerDay, base.maxAutoActionsPerDay),
    maxAutoActionsPerToolDay: numberOr(row.maxAutoActionsPerToolDay, base.maxAutoActionsPerToolDay),
    maxAutoActionsPerIncident: numberOr(row.maxAutoActionsPerIncident, base.maxAutoActionsPerIncident),
    resourceActionCooldownMinutes: numberOr(row.resourceActionCooldownMinutes, base.resourceActionCooldownMinutes),
    autoFailureDowngradeThreshold: numberOr(row.autoFailureDowngradeThreshold, base.autoFailureDowngradeThreshold),
    autoDowngradeReason: typeof row.autoDowngradeReason === 'string' ? row.autoDowngradeReason : base.autoDowngradeReason,
    autoDowngradedAt: row.autoDowngradedAt instanceof Date ? row.autoDowngradedAt : base.autoDowngradedAt,
    budgetAlertPeriod: typeof row.budgetAlertPeriod === 'string' ? row.budgetAlertPeriod : base.budgetAlertPeriod,
    budgetAlertLevel: numberOr(row.budgetAlertLevel, base.budgetAlertLevel),
  }
  // THE ENVIRONMENT KILL SWITCH IS ABSOLUTE. A stored `safe_auto` must not be
  // able to resurrect an agent the deployment turned off.
  if (agentDisabledByEnv(env)) merged.mode = 'off'
  return merged
}

/** Read the live settings. Never throws; degrades to safe defaults. */
export async function loadSettings(): Promise<AgentSettings> {
  const base = envDefaults()
  try {
    const row = await prisma.emailAgentSettings.findUnique({ where: { id: SETTINGS_ID } })
    return mergeSettings(base, row as never)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // A missing table is the expected case before the migration is applied and
    // is logged at warn, not error — but it is never silent.
    log.warn({ err: reason.slice(0, 200) }, 'agent settings unreadable — using environment defaults')
    return { ...base, degraded: true, degradedReason: 'settings row unreadable' }
  }
}

/** Create the singleton if it is missing, then return the live settings. */
export async function ensureSettings(): Promise<AgentSettings> {
  try {
    await prisma.emailAgentSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, mode: envDefaults().mode },
      update: {},
    })
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message.slice(0, 200) : String(err) }, 'could not ensure agent settings row')
  }
  return loadSettings()
}

export type SettingsPatch = Partial<{
  mode: EmailAgentMode
  aiEnabled: boolean
  autoActionsEnabled: boolean
  alertsEnabled: boolean
  digestWarnings: boolean
  marketingDispatchPaused: boolean
  pausedReason: string | null
  maxAutoActionsPerRun: number
  stageRecipientLimit: number
  provider: string | null
  model: string | null
}>

/**
 * Apply an operator change.
 *
 * `stageRecipientLimit` is accepted here because a HUMAN is changing it —
 * the agent itself cannot reach this function; `raiseStageRecipientLimit` is
 * classified `forbidden` in the policy engine and has no executor.
 */
export async function updateSettings(
  patch: SettingsPatch,
  actor: { userId: string | null; name: string | null }
): Promise<AgentSettings> {
  const data: Record<string, unknown> = { updatedById: actor.userId, updatedByName: actor.name }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) data[k] = v
  }
  if (patch.marketingDispatchPaused === true) {
    data.pausedAt = new Date()
    data.pausedBy = actor.name ?? actor.userId ?? 'unknown'
  }
  if (patch.marketingDispatchPaused === false) {
    data.pausedAt = null
    data.pausedBy = null
    data.pausedReason = patch.pausedReason ?? null
  }
  const create = { id: SETTINGS_ID, ...data } as Record<string, unknown>
  await prisma.emailAgentSettings.upsert({
    where: { id: SETTINGS_ID },
    create: create as never,
    update: data as never,
  })
  return loadSettings()
}

// ── The global email kill switch ────────────────────────────────────────

export type DispatchPause = { paused: boolean; reason: string | null; since: Date | null; by: string | null }

/**
 * Read by `dispatchCampaign` and by every campaign batch BEFORE any provider
 * call. This is what makes the switch a server-side stop rather than a hidden
 * button.
 *
 * FAILS OPEN, ON PURPOSE AND NARROWLY: if the settings row cannot be read at
 * all, this reports "not paused". The alternative — refusing to send whenever
 * the agent's own table is unavailable — would let a brand-new failure mode in
 * a monitoring feature take down transactional-adjacent email delivery. The
 * degraded read is logged, and `infra.agent_settings_unreadable` is a check, so
 * the condition is visible rather than assumed.
 */
export async function isMarketingDispatchPaused(): Promise<DispatchPause> {
  try {
    const row = await prisma.emailAgentSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { marketingDispatchPaused: true, pausedReason: true, pausedAt: true, pausedBy: true },
    })
    if (!row || !row.marketingDispatchPaused) return { paused: false, reason: null, since: null, by: null }
    return { paused: true, reason: row.pausedReason, since: row.pausedAt, by: row.pausedBy }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message.slice(0, 200) : String(err) },
      'dispatch pause flag unreadable — treating as NOT paused'
    )
    return { paused: false, reason: null, since: null, by: null }
  }
}

/** The sentence the dispatch path shows an operator when the switch is on. */
export function pauseRefusalMessage(pause: DispatchPause): string {
  const when = pause.since ? ` since ${pause.since.toISOString()}` : ''
  const who = pause.by ? ` by ${pause.by}` : ''
  const why = pause.reason ? ` Reason: ${pause.reason}` : ''
  return `Marketing dispatch is PAUSED${when}${who}.${why} Resume it in Email Marketing → Operations Agent before sending.`
}

export const ALL_MODES = AGENT_MODES
