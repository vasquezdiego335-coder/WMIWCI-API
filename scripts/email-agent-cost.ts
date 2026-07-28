/**
 * AI COST ANALYSIS — measured, then projected.
 *
 *   npx tsx scripts/email-agent-cost.ts [--json]
 *
 * READ-ONLY. It reads EmailAgentModelCall and projects forward. It writes
 * nothing and calls no provider.
 *
 * EVERY NUMBER IS LABELLED. `measured` came from this database.
 * `provider-listed` is a published rate. `calculated` is arithmetic over the
 * two. `unknown` means the data to answer honestly is not here — and saying
 * so is the point, because an invented monthly cost is worse than none.
 */

import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { MODEL_PRICES, PRICING_VERSION, estimateCost, projectMonthlyCost } from '../src/lib/email-agent/pricing'
import { detectEnvironment } from '../src/lib/email-agent/environment'
import { envDefaults } from '../src/lib/email-agent/settings'

const asJson = process.argv.includes('--json')
const line = (s = '') => console.log(s)
const rule = (c = '─') => line(c.repeat(78))
const usd = (n: number) => `$${n.toFixed(4)}`

async function main() {
  const settings = envDefaults()
  const environment = detectEnvironment()

  // ── MEASURED: what has actually been spent ───────────────────────────
  const billable = { outcome: { in: ['ok', 'invalid_output', 'error', 'timeout'] } }
  const calls = await prisma.emailAgentModelCall.findMany({
    where: billable,
    select: {
      provider: true, model: true, promptTokens: true, completionTokens: true, totalTokens: true,
      cachedInputTokens: true, reasoningTokens: true, estimatedCostUsd: true, outcome: true,
      isFallback: true, createdAt: true, incidentId: true, environment: true, latencyMs: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  })

  const ok = calls.filter((c) => c.outcome === 'ok')
  const totalPrompt = ok.reduce((s, c) => s + (c.promptTokens ?? 0), 0)
  const totalCompletion = ok.reduce((s, c) => s + (c.completionTokens ?? 0), 0)
  const totalCached = ok.reduce((s, c) => s + (c.cachedInputTokens ?? 0), 0)
  const totalReasoning = ok.reduce((s, c) => s + (c.reasoningTokens ?? 0), 0)
  const totalCost = calls.reduce((s, c) => s + c.estimatedCostUsd, 0)
  const fallbacks = calls.filter((c) => c.isFallback).length

  const avgPrompt = ok.length ? Math.round(totalPrompt / ok.length) : 0
  const avgCompletion = ok.length ? Math.round(totalCompletion / ok.length) : 0
  const avgCached = ok.length ? Math.round(totalCached / ok.length) : 0
  const avgLatency = ok.length ? Math.round(ok.reduce((s, c) => s + (c.latencyMs ?? 0), 0) / ok.length) : 0

  // Days of history, so calls/day is measured rather than assumed.
  const oldest = calls.length ? calls[calls.length - 1].createdAt : null
  const daysOfHistory = oldest ? Math.max(1, (Date.now() - oldest.getTime()) / 86_400_000) : 0
  const callsPerDayMeasured = daysOfHistory > 0 ? calls.length / daysOfHistory : 0

  // ── DEDUPLICATION HEADROOM ───────────────────────────────────────────
  // How many calls were spent on an incident that already had one. Before the
  // dedupe layer this was the entire waste; after it, it should trend to zero.
  const byIncident = new Map<string, number>()
  for (const c of calls) if (c.incidentId) byIncident.set(c.incidentId, (byIncident.get(c.incidentId) ?? 0) + 1)
  const repeatCalls = Array.from(byIncident.values()).reduce((s, n) => s + Math.max(0, n - 1), 0)
  const repeatShare = calls.length > 0 ? repeatCalls / calls.length : 0

  const openIncidents = await prisma.emailAgentIncident.count({
    where: { status: { in: ['open', 'investigating', 'awaiting_approval', 'mitigated'] } },
  })

  // ── PROJECTIONS ──────────────────────────────────────────────────────
  // Token shape: measured when there is data, otherwise the planning shape
  // stated in the spec. Which one was used is reported.
  const haveMeasured = ok.length >= 1
  const shape = haveMeasured
    ? { avgPromptTokens: avgPrompt, avgCompletionTokens: avgCompletion, avgCachedTokens: avgCached }
    : { avgPromptTokens: 3000, avgCompletionTokens: 700, avgCachedTokens: 0 }

  // WORKLOAD after deduplication. With a 15-minute cadence there are 96 cycles
  // a day and at most `maxModelCallsPerCycle` calls each — but dedupe means a
  // call happens only on a material change. A realistic steady state is a few
  // incidents changing per day, so the honest planning figure is the DAILY CAP,
  // which is also the number the hard limit actually enforces.
  const scenarios = [
    { name: 'Low (2 investigations/day)', perDay: 2 },
    { name: 'Expected (6 investigations/day)', perDay: 6 },
    { name: 'Hard cap (25 calls/day, the enforced ceiling)', perDay: settings.maxModelCallsPerDay },
  ]

  const models = [
    { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'PRIMARY' },
    { provider: 'openai', model: 'gpt-5.4-nano', role: 'FALLBACK' },
    { provider: 'deepseek', model: 'deepseek-v4-pro', role: 'alternative' },
    { provider: 'openai', model: 'gpt-5-mini', role: 'alternative' },
    { provider: 'openai', model: 'gpt-5.6-luna', role: 'not recommended' },
  ]

  const projections = models.map((m) => ({
    ...m,
    scenarios: scenarios.map((s) => {
      const projected = projectMonthlyCost({ provider: m.provider, model: m.model, investigationsPerDay: s.perDay, ...shape })
      // `perDay` is the SCENARIO's call count; `projected.perDay` is dollars.
      // Spreading the projection last would silently overwrite the first.
      return { name: s.name, callsPerDay: s.perDay, ...projected }
    }),
  }))

  // Absolute ceiling: what the enforced caps allow, whichever binds first.
  const capByCalls = projectMonthlyCost({
    provider: 'deepseek', model: 'deepseek-v4-flash',
    investigationsPerDay: settings.maxModelCallsPerDay, ...shape,
  }).perMonth
  const hardMaxUsd = Math.min(settings.maxAiCostUsdPerMonth, settings.maxAiCostUsdPerDay * 30, capByCalls)

  const payload = {
    generatedAt: new Date().toISOString(),
    environment,
    pricingVersion: PRICING_VERSION,
    measured: {
      basis: haveMeasured ? 'measured' : 'unknown — no successful model calls recorded yet',
      totalCalls: calls.length,
      successfulCalls: ok.length,
      fallbackCalls: fallbacks,
      avgPromptTokens: avgPrompt,
      avgCompletionTokens: avgCompletion,
      avgCachedInputTokens: avgCached,
      avgReasoningTokens: ok.length ? Math.round(totalReasoning / ok.length) : 0,
      avgLatencyMs: avgLatency,
      totalEstimatedCostUsd: Number(totalCost.toFixed(6)),
      daysOfHistory: Number(daysOfHistory.toFixed(2)),
      callsPerDayMeasured: Number(callsPerDayMeasured.toFixed(2)),
      repeatCallsOnSameIncident: repeatCalls,
      repeatShare: Number((repeatShare * 100).toFixed(1)),
      openIncidents,
    },
    limits: {
      callsPerCycle: settings.maxModelCallsPerCycle,
      callsPerDay: settings.maxModelCallsPerDay,
      tokensPerDay: settings.maxTokensPerDay,
      tokensPerMonth: settings.maxTokensPerMonth,
      costPerDayUsd: settings.maxAiCostUsdPerDay,
      costPerMonthUsd: settings.maxAiCostUsdPerMonth,
      reinvestigateHours: settings.aiReinvestigateHours,
      intervalMinutes: settings.intervalMinutes,
    },
    tokenShapeUsed: { ...shape, basis: haveMeasured ? 'measured' : 'planning assumption (spec)' },
    projections,
    hardMaxMonthlyUsd: Number(hardMaxUsd.toFixed(4)),
  }

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  rule('═')
  line('  EMAIL OPERATIONS AGENT — AI COST ANALYSIS')
  rule('═')
  line()
  line(`Generated        ${payload.generatedAt}`)
  line(`Environment      ${environment}`)
  line(`Pricing table    ${PRICING_VERSION}`)
  line()

  line('MEASURED (from this database)')
  rule()
  if (!haveMeasured) {
    line('  No successful model calls are recorded yet.')
    line('  Token averages below are the PLANNING ASSUMPTION, not measurements.')
  }
  line(`  Model calls recorded            ${calls.length} (${ok.length} successful, ${fallbacks} fallback)`)
  line(`  Days of history                 ${daysOfHistory.toFixed(2)}`)
  line(`  Calls per day (measured)        ${callsPerDayMeasured.toFixed(2)}`)
  line(`  Avg input tokens                ${avgPrompt}`)
  line(`  Avg output tokens               ${avgCompletion}${totalReasoning > 0 ? ` (incl. ${Math.round(totalReasoning / Math.max(ok.length, 1))} reasoning)` : ''}`)
  line(`  Avg cached input tokens         ${avgCached}`)
  line(`  Avg latency                     ${avgLatency} ms`)
  line(`  Total estimated spend to date   ${usd(totalCost)}`)
  line(`  Repeat calls on same incident   ${repeatCalls} (${(repeatShare * 100).toFixed(1)}% of all calls)`)
  line(`  Open incidents right now        ${openIncidents}`)
  line()

  line('ENFORCED HARD CAPS')
  rule()
  line(`  Calls per cycle                 ${settings.maxModelCallsPerCycle}`)
  line(`  Calls per day                   ${settings.maxModelCallsPerDay}`)
  line(`  Tokens per day / month          ${settings.maxTokensPerDay.toLocaleString()} / ${settings.maxTokensPerMonth.toLocaleString()}`)
  line(`  USD per day / month             $${settings.maxAiCostUsdPerDay.toFixed(2)} / $${settings.maxAiCostUsdPerMonth.toFixed(2)}`)
  line(`  Re-investigate cooldown         ${settings.aiReinvestigateHours}h`)
  line(`  Deterministic cycle interval    ${settings.intervalMinutes} min (costs $0)`)
  line()

  line(`PROJECTIONS  (token shape: ${shape.avgPromptTokens} in / ${shape.avgCompletionTokens} out — ${payload.tokenShapeUsed.basis})`)
  rule()
  for (const p of projections) {
    line(`  ${p.model.padEnd(20)} [${p.role}]`)
    for (const s of p.scenarios) {
      line(`      ${s.name.padEnd(46)} ${usd(s.perCall).padStart(10)}/call  ${('$' + s.perMonth.toFixed(2)).padStart(9)}/month`)
    }
    line()
  }

  line('CEILING')
  rule()
  line(`  Maximum possible AI spend under the enforced caps: $${hardMaxUsd.toFixed(2)}/month`)
  line(`  (the tightest of: monthly USD cap, daily USD cap x30, and the daily call cap)`)
  line()

  line('PRICING TABLE')
  rule()
  for (const p of MODEL_PRICES) {
    line(`  ${p.provider}/${p.model}`.padEnd(36) + `in $${p.inputPerMillion}/M  cached $${p.cachedInputPerMillion}/M  out $${p.outputPerMillion}/M  [${p.basis}]`)
  }
  line()
  rule('═')
}

main()
  .catch((err) => {
    console.error('COST ANALYSIS FAILED:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    process.exit(process.exitCode ?? 0)
  })
