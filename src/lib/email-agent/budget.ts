// ════════════════════════════════════════════════════════════════════════
//  AI BUDGET (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  Six independent ceilings — calls per cycle, calls per day, tokens per day,
//  tokens per month, dollars per day, dollars per month — and the first one to
//  bite stops the spend.
//
//  WHY SIX AND NOT ONE. They fail differently. A prompt-size bug blows the
//  token limit while the call count looks fine. A retry storm blows the call
//  count while tokens look fine. A model swap blows the dollar limit while
//  both token counts look fine. One ceiling would catch one of those.
//
//  MULTI-CONTAINER CORRECTNESS. Railway can run more than one worker. Two
//  containers each reading "we have spent $2.90 of $3.00" and each deciding
//  they can afford one more call is exactly how a budget gets exceeded. So the
//  reservation is made INSIDE a Postgres advisory-locked transaction: the
//  aggregate is read and the placeholder row is written while the lock is
//  held, so the second container reads the first one's reservation.
//
//  WHAT A BUDGET MUST NEVER DO:
//    • stop the deterministic health checks — they cost nothing and they are
//      the part that actually protects customers;
//    • authorise an action it would otherwise have refused;
//    • hide the fact that it is refusing. Every skip has a written reason.
//
//  THE AGENT CANNOT RAISE ITS OWN LIMITS. There is no tool that writes these
//  fields, `raiseStageRecipientLimit` is forbidden, and a test asserts that no
//  executor touches the settings row's budget block.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { queueLogger } from '../logger'
import { detectEnvironment } from './environment'
import { PRICING_VERSION, estimateCost } from './pricing'
import { safeErrorMessage } from './redact'
import type { AgentSettings } from './settings'

const log = queueLogger.child({ mod: 'email-agent-budget' })

/** Advisory lock for budget reservation. Distinct from the cycle lock. */
export const BUDGET_LOCK_KEY = BigInt(92607242)

/** Thresholds that produce an owner alert, each once per billing period. */
export const BUDGET_ALERT_THRESHOLDS = [50, 80, 100] as const

export type BudgetWindow = {
  calls: number
  tokens: number
  costUsd: number
}

export type BudgetUsage = {
  day: BudgetWindow
  month: BudgetWindow
  /** ISO day and month keys the counts were taken for. */
  dayKey: string
  monthKey: string
  limits: {
    callsPerCycle: number
    callsPerDay: number
    tokensPerDay: number
    tokensPerMonth: number
    costPerDay: number
    costPerMonth: number
  }
  remaining: {
    callsToday: number
    tokensToday: number
    tokensThisMonth: number
    costToday: number
    costThisMonth: number
  }
  /** 0..100+, share of the MONTHLY dollar budget consumed. */
  monthlyPercentUsed: number
  /** Straight-line projection to month end. Null before there is any data. */
  projectedMonthEndUsd: number | null
}

export type BudgetVerdict =
  | { allowed: true; usage: BudgetUsage }
  | { allowed: false; reason: string; limit: string; usage: BudgetUsage }

const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
const startOfUtcMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
export const dayKey = (now: Date): string => now.toISOString().slice(0, 10)
export const monthKey = (now: Date): string => now.toISOString().slice(0, 7)

const round = (n: number, dp = 6): number => Math.round(n * 10 ** dp) / 10 ** dp
const positive = (n: number): number => (n > 0 ? n : 0)

/**
 * Read spend for the current day and month.
 *
 * Scoped to THIS environment: a developer's local experiments must not consume
 * production's budget, and production must not be throttled by them.
 */
export async function readUsage(settings: AgentSettings, now: Date = new Date()): Promise<BudgetUsage> {
  const environment = detectEnvironment()
  const dayStart = startOfUtcDay(now)
  const monthStart = startOfUtcMonth(now)

  // Only calls that actually reached a provider count against the budget. A
  // call refused before dispatch ('disabled') cost nothing and must not.
  const billable = { environment, outcome: { in: ['ok', 'invalid_output', 'error', 'timeout'] } }

  const [dayAgg, monthAgg] = await Promise.all([
    prisma.emailAgentModelCall.aggregate({
      where: { ...billable, createdAt: { gte: dayStart } },
      _count: { _all: true },
      _sum: { totalTokens: true, estimatedCostUsd: true },
    }),
    prisma.emailAgentModelCall.aggregate({
      where: { ...billable, createdAt: { gte: monthStart } },
      _count: { _all: true },
      _sum: { totalTokens: true, estimatedCostUsd: true },
    }),
  ])

  const day: BudgetWindow = {
    calls: dayAgg._count._all,
    tokens: dayAgg._sum.totalTokens ?? 0,
    costUsd: round(dayAgg._sum.estimatedCostUsd ?? 0),
  }
  const month: BudgetWindow = {
    calls: monthAgg._count._all,
    tokens: monthAgg._sum.totalTokens ?? 0,
    costUsd: round(monthAgg._sum.estimatedCostUsd ?? 0),
  }

  const limits = {
    callsPerCycle: settings.maxModelCallsPerCycle,
    callsPerDay: settings.maxModelCallsPerDay,
    tokensPerDay: settings.maxTokensPerDay,
    tokensPerMonth: settings.maxTokensPerMonth,
    costPerDay: settings.maxAiCostUsdPerDay,
    costPerMonth: settings.maxAiCostUsdPerMonth,
  }

  // Remaining is CLAMPED AT ZERO. A negative "remaining budget" in the admin
  // reads as credit and is the opposite of the truth.
  const remaining = {
    callsToday: positive(limits.callsPerDay - day.calls),
    tokensToday: positive(limits.tokensPerDay - day.tokens),
    tokensThisMonth: positive(limits.tokensPerMonth - month.tokens),
    costToday: round(positive(limits.costPerDay - day.costUsd)),
    costThisMonth: round(positive(limits.costPerMonth - month.costUsd)),
  }

  // Guarded against a zero or negative configured limit, which would otherwise
  // divide by zero and render as NaN or Infinity in the admin.
  const monthlyPercentUsed = limits.costPerMonth > 0 ? round((month.costUsd / limits.costPerMonth) * 100, 2) : 0

  // Straight-line projection. Day 1 of a month has elapsed=1, never 0.
  const daysElapsed = Math.max(1, now.getUTCDate())
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const projectedMonthEndUsd = month.calls === 0 ? null : round((month.costUsd / daysElapsed) * daysInMonth, 4)

  return { day, month, dayKey: dayKey(now), monthKey: monthKey(now), limits, remaining, monthlyPercentUsed, projectedMonthEndUsd }
}

/** Pure limit evaluation, so every ceiling is testable without a database. */
export function evaluateLimits(
  usage: BudgetUsage,
  callsThisCycle: number
): { allowed: true } | { allowed: false; reason: string; limit: string } {
  const l = usage.limits
  if (callsThisCycle >= l.callsPerCycle) {
    return {
      allowed: false,
      limit: 'calls_per_cycle',
      reason: `This cycle has already made its ${l.callsPerCycle} model call${l.callsPerCycle === 1 ? '' : 's'}. Further investigation waits for the next cycle.`,
    }
  }
  if (usage.day.calls >= l.callsPerDay) {
    return {
      allowed: false,
      limit: 'calls_per_day',
      reason: `The daily limit of ${l.callsPerDay} model calls is used up (${usage.day.calls} today). Deterministic checks continue; written analysis resumes tomorrow.`,
    }
  }
  if (usage.day.tokens >= l.tokensPerDay) {
    return {
      allowed: false,
      limit: 'tokens_per_day',
      reason: `The daily token budget of ${l.tokensPerDay.toLocaleString()} is used up (${usage.day.tokens.toLocaleString()} today).`,
    }
  }
  if (usage.month.tokens >= l.tokensPerMonth) {
    return {
      allowed: false,
      limit: 'tokens_per_month',
      reason: `The monthly token budget of ${l.tokensPerMonth.toLocaleString()} is used up (${usage.month.tokens.toLocaleString()} this month).`,
    }
  }
  if (usage.day.costUsd >= l.costPerDay) {
    return {
      allowed: false,
      limit: 'cost_per_day',
      reason: `The daily AI budget of $${l.costPerDay.toFixed(2)} is used up ($${usage.day.costUsd.toFixed(4)} today).`,
    }
  }
  if (usage.month.costUsd >= l.costPerMonth) {
    return {
      allowed: false,
      limit: 'cost_per_month',
      reason: `The monthly AI budget of $${l.costPerMonth.toFixed(2)} is used up ($${usage.month.costUsd.toFixed(4)} this month). No further model calls until the next billing period.`,
    }
  }
  return { allowed: true }
}

export type Reservation = {
  /** The placeholder model-call row to settle once the call returns. */
  callId: string
  usage: BudgetUsage
}

/**
 * Reserve one model call, atomically across containers.
 *
 * The read-and-reserve happens inside ONE advisory-locked transaction. A second
 * container asking at the same moment blocks on the lock, then reads a total
 * that already includes this reservation.
 *
 * The placeholder row is written with `outcome: 'reserved'` and zero cost, and
 * is UPDATED when the call settles. A crash between reserve and settle leaves a
 * row that says 'reserved' forever — visible, attributable, and conservative,
 * because it counts against the call budget rather than vanishing.
 */
export async function reserveModelCall(
  settings: AgentSettings,
  context: { correlationId: string; runId?: string; incidentId?: string; provider: string; model: string; callsThisCycle: number; now?: Date }
): Promise<{ ok: true; reservation: Reservation } | { ok: false; reason: string; limit: string; usage: BudgetUsage }> {
  const now = context.now ?? new Date()
  const environment = detectEnvironment()

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`

    const usage = await readUsage(settings, now)
    const verdict = evaluateLimits(usage, context.callsThisCycle)
    if (!verdict.allowed) {
      return { ok: false as const, reason: verdict.reason, limit: verdict.limit, usage }
    }

    const row = await tx.emailAgentModelCall.create({
      data: {
        runId: context.runId ?? null,
        incidentId: context.incidentId ?? null,
        provider: context.provider,
        model: context.model,
        purpose: 'investigate',
        // Counted immediately against the CALL budget so a concurrent
        // container sees it. Tokens and cost land when the call settles.
        outcome: 'reserved',
        estimatedCostUsd: 0,
        pricingVersion: PRICING_VERSION,
        environment,
        correlationId: context.correlationId,
        createdAt: now,
      },
      select: { id: true },
    })

    return { ok: true as const, reservation: { callId: row.id, usage } }
  })
}

/** Close a reservation with what the call actually cost. Never throws. */
export async function settleModelCall(
  callId: string,
  result: {
    outcome: string
    error?: string
    requestId?: string
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    latencyMs?: number
    provider: string
    model: string
    inputFindingCount?: number
    recommendedTool?: string | null
    isFallback?: boolean
    fallbackReason?: string
  }
): Promise<{ costUsd: number; unknownModel: boolean }> {
  const cost = estimateCost({
    provider: result.provider,
    model: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    cachedInputTokens: result.cachedInputTokens,
  })
  try {
    await prisma.emailAgentModelCall.update({
      where: { id: callId },
      data: {
        outcome: result.outcome,
        error: result.error ? safeErrorMessage(result.error, 400) : null,
        requestId: result.requestId ?? null,
        promptTokens: result.promptTokens ?? null,
        completionTokens: result.completionTokens ?? null,
        totalTokens: result.totalTokens ?? (result.promptTokens ?? 0) + (result.completionTokens ?? 0),
        cachedInputTokens: result.cachedInputTokens ?? null,
        reasoningTokens: result.reasoningTokens ?? null,
        latencyMs: result.latencyMs ?? null,
        estimatedCostUsd: cost.usd,
        pricingVersion: cost.pricingVersion,
        inputFindingCount: result.inputFindingCount ?? null,
        recommendedTool: result.recommendedTool ?? null,
        isFallback: result.isFallback ?? false,
        fallbackReason: result.fallbackReason ?? null,
      },
    })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), callId }, 'could not settle a model-call reservation')
  }
  if (cost.unknownModel) {
    log.warn({ provider: result.provider, model: result.model }, 'model is not in the pricing table — costed at the worst-case rate')
  }
  return { costUsd: cost.usd, unknownModel: cost.unknownModel }
}

/**
 * Release a reservation that never reached a provider.
 *
 * Marked 'disabled' rather than deleted: `readUsage` excludes that outcome, so
 * it stops counting against the budget while the attempt stays auditable.
 * Deleting it would erase evidence to tidy a number.
 */
export async function releaseReservation(callId: string, reason: string): Promise<void> {
  try {
    await prisma.emailAgentModelCall.update({
      where: { id: callId },
      data: { outcome: 'disabled', error: safeErrorMessage(reason, 300), estimatedCostUsd: 0 },
    })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), callId }, 'could not release a model-call reservation')
  }
}

// ── Threshold alerting ──────────────────────────────────────────────────

export type BudgetAlert = { level: number; message: string; action: string }

/**
 * Which budget threshold, if any, deserves an alert right now.
 *
 * Pure. `lastLevel` and `lastPeriod` come from the settings row, so each
 * threshold alerts ONCE per billing period: crossing 50% alerts, staying above
 * 50% does not, and a new month resets it.
 */
export function budgetAlertToRaise(input: {
  monthlyPercentUsed: number
  monthKey: string
  lastAlertPeriod: string | null
  lastAlertLevel: number
  monthlyLimitUsd: number
  monthSpendUsd: number
}): BudgetAlert | null {
  const periodChanged = input.lastAlertPeriod !== input.monthKey
  const alreadyAlerted = periodChanged ? 0 : input.lastAlertLevel

  let crossed = 0
  for (const t of BUDGET_ALERT_THRESHOLDS) {
    if (input.monthlyPercentUsed >= t) crossed = t
  }
  if (crossed === 0 || crossed <= alreadyAlerted) return null

  const spend = `$${input.monthSpendUsd.toFixed(4)} of $${input.monthlyLimitUsd.toFixed(2)}`
  if (crossed >= 100) {
    return {
      level: 100,
      message: `The monthly AI budget is EXHAUSTED (${spend}). The agent's deterministic health checks, incidents and alerts all continue — only the written AI analysis stops until the next billing period.`,
      action: 'No action needed unless you want analysis back sooner, in which case raise the monthly limit in Email Marketing → Operations Agent.',
    }
  }
  if (crossed >= 80) {
    return {
      level: 80,
      message: `AI spend has reached 80% of the monthly budget (${spend}).`,
      action: 'Nothing is wrong. If the month is young, consider whether an incident is being re-investigated more often than it needs to be.',
    }
  }
  return {
    level: 50,
    message: `AI spend has reached half the monthly budget (${spend}).`,
    action: 'Informational only.',
  }
}

/** Record that a threshold alert was sent, so it is not sent again. */
export async function recordBudgetAlert(level: number, period: string): Promise<void> {
  try {
    await prisma.emailAgentSettings.update({
      where: { id: 'singleton' },
      data: { budgetAlertPeriod: period, budgetAlertLevel: level },
    })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), level, period }, 'could not record the budget alert level')
  }
}
