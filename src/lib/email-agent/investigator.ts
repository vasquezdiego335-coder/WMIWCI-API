// ════════════════════════════════════════════════════════════════════════
//  AI INVESTIGATOR (owner spec 2026-07-27, cost-hardened 2026-07-28)
//  ---------------------------------------------------------------------
//  The ONLY place in the agent that talks to a model, and the only place that
//  can spend money. Every call passes three gates before a byte leaves:
//
//    1. LEAK GATE     — the assembled prompt is scanned for unmasked customer
//                       addresses. A hit abandons the call rather than sending.
//    2. BUDGET GATE   — a reservation is taken inside an advisory-locked
//                       transaction, so two Railway containers cannot each
//                       spend the same remaining dollar.
//    3. CONTRACT GATE — the reply is validated against the Zod schema and
//                       discarded whole if it does not conform.
//
//  FALLBACK IS ONE ATTEMPT, AND ONLY FOR A BROKEN PROVIDER. A timeout, an
//  outage, or output that failed the schema earns exactly one retry against the
//  configured fallback model. A model that answered correctly and recommended
//  nothing is a SUCCESS — falling back there would double the bill to be told
//  the same thing twice. The fallback consumes its own budget reservation and
//  is recorded as `isFallback` with the reason, so its cost is never hidden
//  inside the primary's.
//
//  IT DOES NOT STORE PROMPTS. The model-call row records provider, model,
//  outcome, tokens, cost and which tool was recommended. Storing the prompt
//  would duplicate the findings' evidence into a second place for no gain.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { queueLogger } from '../logger'
import { releaseReservation, reserveModelCall, settleModelCall } from './budget'
import { detectEnvironment } from './environment'
import { buildMemoryBundle, findUnmaskedEmails } from './memory'
import { POLICY_SUMMARY, availableTools } from './policy'
import { DisabledProvider } from './providers'
import { DeepSeekProvider } from './providers/deepseek'
import { OpenAiProvider } from './providers/openai'
import { redact, safeErrorMessage } from './redact'
import type { AgentSettings } from './settings'
import type { AgentAnalysisInput, AgentDecision, AgentFinding, AgentProviderResult, EmailAgentModelProvider } from './types'

const log = queueLogger.child({ mod: 'email-agent-investigator' })

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

/** Outcomes that mean the PROVIDER failed, not that the answer was unwelcome. */
const FALLBACK_WORTHY: ReadonlySet<string> = new Set(['error', 'timeout', 'invalid_output'])

type ProviderChoice = { provider: EmailAgentModelProvider; disabledReason?: string }

/** Build one named provider, or a DisabledProvider explaining why not. */
function buildProvider(name: string | null | undefined, model: string | null, env: NodeJS.ProcessEnv): ProviderChoice {
  const requested = (name ?? 'deepseek').trim().toLowerCase()
  if (requested === 'deepseek') {
    const key = env.DEEPSEEK_API_KEY
    if (!configured(key)) return { provider: new DisabledProvider('DEEPSEEK_API_KEY is not configured.'), disabledReason: 'no key' }
    return { provider: new DeepSeekProvider({ apiKey: key!.trim(), model }) }
  }
  if (requested === 'openai') {
    const key = env.OPENAI_API_KEY
    if (!configured(key)) return { provider: new DisabledProvider('OPENAI_API_KEY is not configured.'), disabledReason: 'no key' }
    return { provider: new OpenAiProvider({ apiKey: key!.trim(), model }) }
  }
  return {
    provider: new DisabledProvider(`"${requested}" is not a supported provider. Use "openai" or "deepseek".`),
    disabledReason: 'unknown provider',
  }
}

/** The primary provider named by settings, or a DisabledProvider. */
export function resolveProvider(settings: AgentSettings, env: NodeJS.ProcessEnv = process.env): EmailAgentModelProvider {
  if (!settings.aiEnabled) return new DisabledProvider('AI analysis is switched off. Deterministic checks are unaffected.')
  return buildProvider(settings.provider ?? env.EMAIL_AGENT_PROVIDER ?? 'deepseek', settings.model ?? env.EMAIL_AGENT_MODEL ?? null, env)
    .provider
}

/** The fallback provider, when one is configured and permitted. */
export function resolveFallbackProvider(settings: AgentSettings, env: NodeJS.ProcessEnv = process.env): EmailAgentModelProvider | null {
  if (!settings.allowProviderFallback) return null
  const name = settings.fallbackProvider ?? env.EMAIL_AGENT_FALLBACK_PROVIDER ?? null
  if (!name) return null
  const model = settings.fallbackModel ?? env.EMAIL_AGENT_FALLBACK_MODEL ?? null
  const built = buildProvider(name, model, env)
  // A fallback that is not configured is simply absent, not an error: the
  // primary working is the normal case and must not be blocked by it.
  return built.provider instanceof DisabledProvider ? null : built.provider
}

export type InvestigationResult = {
  invoked: boolean
  decision: AgentDecision | null
  provider: string
  model: string
  /** Why no decision came back, when none did. */
  skippedReason?: string
  outcome: 'ok' | 'invalid_output' | 'error' | 'timeout' | 'disabled' | 'skipped' | 'budget_exhausted'
  /** Calls actually dispatched (primary + at most one fallback). */
  callsMade: number
  costUsd: number
  usedFallback: boolean
}

export type InvestigateOptions = {
  settings: AgentSettings
  correlationId: string
  runId?: string
  incidentId?: string
  findingIds: Map<string, string>
  systemSummary?: string
  now?: Date
  /** Calls already spent this cycle, for the per-cycle ceiling. */
  callsThisCycle?: number
}

const skipped = (reason: string, provider: string, model: string): InvestigationResult => ({
  invoked: false,
  decision: null,
  provider,
  model,
  outcome: 'skipped',
  skippedReason: reason,
  callsMade: 0,
  costUsd: 0,
  usedFallback: false,
})

/**
 * Investigate one incident's findings.
 *
 * Returns a result in every path — a provider outage, an exhausted budget and
 * a leak-gate abort all produce a described outcome rather than an exception,
 * because the deterministic report is already complete and must survive
 * whatever happens here.
 */
export async function investigate(findings: AgentFinding[], options: InvestigateOptions): Promise<InvestigationResult> {
  const { settings, correlationId, runId } = options
  const now = options.now ?? new Date()
  const callsThisCycle = options.callsThisCycle ?? 0
  const environment = detectEnvironment()
  const primary = resolveProvider(settings)

  if (findings.length === 0) return skipped('No findings to investigate.', primary.name, primary.model)

  if (primary instanceof DisabledProvider) {
    const result = await primary.analyze()
    const reason = result.ok ? 'disabled' : result.error
    // Recorded as 'disabled', which readUsage EXCLUDES from the budget: a call
    // that never reached a provider cost nothing and must not consume budget.
    await prisma.emailAgentModelCall
      .create({
        data: {
          runId: runId ?? null,
          incidentId: options.incidentId ?? null,
          provider: 'disabled',
          model: 'none',
          purpose: 'investigate',
          outcome: 'disabled',
          error: safeErrorMessage(reason, 300),
          inputFindingCount: findings.length,
          environment,
          correlationId,
          estimatedCostUsd: 0,
        },
      })
      .catch((err) => log.error({ err: safeErrorMessage(err) }, 'could not record a disabled model call'))
    return { ...skipped(reason, primary.name, primary.model), outcome: 'disabled' }
  }

  // ── Assemble the input ────────────────────────────────────────────────
  const memory = await buildMemoryBundle(findings, { now, systemSummary: options.systemSummary })
  const input: AgentAnalysisInput = {
    mode: settings.mode,
    stageRecipientLimit: settings.stageRecipientLimit,
    findings: findings.map((f) => ({
      id: options.findingIds.get(f.fingerprint) ?? f.fingerprint,
      checkId: f.checkId,
      severity: f.severity,
      category: f.category,
      title: f.title,
      description: f.description,
      // Redacted a second time on the way out. The findings were redacted when
      // stored; doing it again costs nothing and means a future code path that
      // builds a finding without redacting still cannot leak.
      evidence: redact(f.evidence) as Record<string, unknown>,
      campaignId: f.campaignId,
      runRefId: f.runRefId,
      sendId: f.sendId,
      firstDetectedAt: f.detectedAt.toISOString(),
    })),
    availableTools: availableTools(settings.mode),
    policySummary: POLICY_SUMMARY,
    memory,
  }

  // ── GATE 1: the leak gate, BEFORE the request is made ────────────────
  const leaks = findUnmaskedEmails({ findings: input.findings, memory: input.memory })
  if (leaks.length > 0) {
    const reason = `Investigation abandoned: ${leaks.length} unmasked recipient address${leaks.length === 1 ? '' : 'es'} would have been sent to ${primary.name}.`
    log.error({ leaks: leaks.slice(0, 5), provider: primary.name }, 'BLOCKED an AI call that would have leaked customer addresses')
    return { ...skipped(reason, primary.name, primary.model), outcome: 'error' }
  }

  // ── Attempt 1: the primary ────────────────────────────────────────────
  const attempt = await attemptCall({
    provider: primary,
    input,
    settings,
    correlationId,
    runId,
    incidentId: options.incidentId,
    findingCount: findings.length,
    callsThisCycle,
    now,
    isFallback: false,
    fallbackReason: undefined,
  })

  if (attempt.kind === 'budget') {
    return {
      invoked: false,
      decision: null,
      provider: primary.name,
      model: primary.model,
      outcome: 'budget_exhausted',
      skippedReason: attempt.reason,
      callsMade: 0,
      costUsd: 0,
      usedFallback: false,
    }
  }

  if (attempt.result.ok) {
    return {
      invoked: true,
      decision: attempt.result.decision,
      provider: primary.name,
      model: primary.model,
      outcome: 'ok',
      callsMade: 1,
      costUsd: attempt.costUsd,
      usedFallback: false,
    }
  }

  // ── Attempt 2: at most ONE fallback, and only for a broken provider ──
  const failure = attempt.result
  const fallback = resolveFallbackProvider(settings)
  const eligible = FALLBACK_WORTHY.has(failure.outcome) && fallback !== null

  if (!eligible) {
    log.warn(
      { provider: primary.name, outcome: failure.outcome, fallbackConfigured: fallback !== null },
      'AI investigation produced no usable decision and no fallback was attempted'
    )
    return {
      invoked: true,
      decision: null,
      provider: primary.name,
      model: primary.model,
      outcome: failure.outcome,
      skippedReason: failure.error,
      callsMade: 1,
      costUsd: attempt.costUsd,
      usedFallback: false,
    }
  }

  const fallbackReason = `${primary.name}/${primary.model} returned ${failure.outcome}: ${failure.error}`.slice(0, 400)
  log.warn({ primary: primary.name, fallback: fallback!.name, outcome: failure.outcome }, 'primary provider failed — attempting the single permitted fallback')

  const second = await attemptCall({
    provider: fallback!,
    input,
    settings,
    correlationId,
    runId,
    incidentId: options.incidentId,
    findingCount: findings.length,
    callsThisCycle: callsThisCycle + 1,
    now,
    isFallback: true,
    fallbackReason,
  })

  const totalCost = attempt.costUsd + (second.kind === 'budget' ? 0 : second.costUsd)

  if (second.kind === 'budget') {
    return {
      invoked: true,
      decision: null,
      provider: primary.name,
      model: primary.model,
      outcome: failure.outcome,
      skippedReason: `${failure.error} The fallback could not run: ${second.reason}`,
      callsMade: 1,
      costUsd: totalCost,
      usedFallback: false,
    }
  }

  if (second.result.ok) {
    return {
      invoked: true,
      decision: second.result.decision,
      provider: fallback!.name,
      model: fallback!.model,
      outcome: 'ok',
      callsMade: 2,
      costUsd: totalCost,
      usedFallback: true,
    }
  }

  // Both failed. THE LOOP STOPS HERE — there is no third attempt.
  return {
    invoked: true,
    decision: null,
    provider: fallback!.name,
    model: fallback!.model,
    outcome: second.result.outcome,
    skippedReason: `Primary ${primary.name} ${failure.outcome}; fallback ${fallback!.name} ${second.result.outcome}: ${second.result.error}`,
    callsMade: 2,
    costUsd: totalCost,
    usedFallback: true,
  }
}

type AttemptOutcome =
  | { kind: 'budget'; reason: string }
  | { kind: 'called'; result: AgentProviderResult; costUsd: number }

/** Reserve budget, call, settle. Never throws. */
async function attemptCall(args: {
  provider: EmailAgentModelProvider
  input: AgentAnalysisInput
  settings: AgentSettings
  correlationId: string
  runId?: string
  incidentId?: string
  findingCount: number
  callsThisCycle: number
  now: Date
  isFallback: boolean
  fallbackReason?: string
}): Promise<AttemptOutcome> {
  // ── GATE 2: the budget, reserved atomically ──────────────────────────
  const reservation = await reserveModelCall(args.settings, {
    correlationId: args.correlationId,
    runId: args.runId,
    incidentId: args.incidentId,
    provider: args.provider.name,
    model: args.provider.model,
    callsThisCycle: args.callsThisCycle,
    now: args.now,
  }).catch((err) => {
    log.error({ err: safeErrorMessage(err) }, 'budget reservation failed')
    // A budget system that cannot be read must NOT be assumed to have room.
    return { ok: false as const, reason: `The budget could not be checked: ${safeErrorMessage(err, 120)}`, limit: 'unavailable', usage: null as never }
  })

  if (!reservation.ok) return { kind: 'budget', reason: reservation.reason }

  const callId = reservation.reservation.callId
  let result: AgentProviderResult
  try {
    result = await args.provider.analyze(args.input)
  } catch (err) {
    // Adapters are contracted never to throw; if one does, the reservation is
    // still settled so it is never left dangling as 'reserved'.
    result = { ok: false, outcome: 'error', error: safeErrorMessage(err, 200), latencyMs: 0 }
  }

  const settled = await settleModelCall(callId, {
    outcome: result.ok ? 'ok' : result.outcome,
    error: result.ok ? undefined : result.error,
    requestId: result.requestId,
    // Read from BOTH branches: a call that answered with unparseable JSON
    // burned tokens and is on the invoice. Costing it at zero would let the
    // budget drift by exactly the amount being wasted.
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    cachedInputTokens: result.usage?.cachedInputTokens,
    reasoningTokens: result.usage?.reasoningTokens,
    latencyMs: result.latencyMs,
    provider: args.provider.name,
    model: args.provider.model,
    inputFindingCount: args.findingCount,
    recommendedTool: result.ok && result.decision.recommendation.type !== 'none' ? result.decision.recommendation.toolName : null,
    isFallback: args.isFallback,
    fallbackReason: args.fallbackReason,
  })

  return { kind: 'called', result, costUsd: settled.costUsd }
}

export { releaseReservation }
