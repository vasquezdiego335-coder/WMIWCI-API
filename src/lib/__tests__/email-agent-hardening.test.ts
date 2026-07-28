import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PRODUCTION_WRITE_OVERRIDE,
  canWriteAgentRecords,
  databaseLooksProduction,
  detectEnvironment,
  detectService,
  isPlatformRuntime,
  provenance,
} from '../email-agent/environment'
import { evidenceHash, rankForInvestigation, shouldInvestigate, stableStringify } from '../email-agent/investigation-policy'
import { PRICING_VERSION, WORST_CASE_PRICE, estimateCost, findPrice, projectMonthlyCost } from '../email-agent/pricing'
import { budgetAlertToRaise, dayKey, evaluateLimits, monthKey, type BudgetUsage } from '../email-agent/budget'
import { actionFingerprint, evaluateBlastRadius, isMutatingTool, shouldDowngradeSafeAuto } from '../email-agent/blast-radius'
import { effectiveStatus, heartbeatState, overallBadge } from '../email-agent/status'
import { buildRequestBody, DEFAULT_MAX_OUTPUT_TOKENS, PROVIDER_DEFAULT_MODELS, readUsage } from '../email-agent/providers'
import { envDefaults } from '../email-agent/settings'
import { redact, redactString, maskEmail } from '../email-agent/redact'
import { findUnmaskedEmails } from '../email-agent/memory'
import type { AgentFinding, FindingSeverity } from '../email-agent/types'

// ════════════════════════════════════════════════════════════════════════
//  ROLLOUT HARDENING (owner spec 2026-07-28)
//
//  Five families, each protecting a failure that has either already happened
//  or would cost real money the first time it did.
// ════════════════════════════════════════════════════════════════════════

const lib = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')

/**
 * Source assertions run on CODE, not comments.
 *
 * A recurring trap in this repository: a doc comment that explains why
 * something is NOT done ("there is no corresponding shouldUpgrade", "a session
 * lock is wrong here") makes a naive substring search fail. The prose is worth
 * keeping; the assertion just has to ignore it.
 */
const stripComments = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
const PROD_DB = 'postgresql://u:p@ep-polished-poetry-aq6tbdtp.c-8.us-east-1.aws.neon.tech/neondb'
const LOCAL_DB = 'postgresql://u:p@localhost:5432/dev'

// ════════════════════════════════════════════════════════════════════════
//  PHASE 1 — ENVIRONMENT ISOLATION
//  THE REAL INCIDENT: a laptop missing RESEND_WEBHOOK_SECRET wrote a
//  production compliance incident and an approval request.
// ════════════════════════════════════════════════════════════════════════

test('a LOCAL runtime pointed at the production database is refused', () => {
  const env = { DATABASE_URL: PROD_DB, NODE_ENV: 'production' } as never
  const decision = canWriteAgentRecords(env)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.match(decision.reason, /LOCAL runtime/)
})

test('NODE_ENV=production does NOT make a laptop production', () => {
  // THE EXACT TRAP: this repository sets NODE_ENV=production in the local .env,
  // so a guard keyed on it would have passed during the incident it prevents.
  const env = { DATABASE_URL: PROD_DB, NODE_ENV: 'production' } as never
  assert.equal(detectEnvironment(env), 'development', 'NODE_ENV must not be the production signal')
  assert.equal(canWriteAgentRecords(env).allowed, false)
})

test('a deployed platform runtime IS allowed to write', () => {
  const env = { DATABASE_URL: PROD_DB, RAILWAY_ENVIRONMENT: 'production', RAILWAY_SERVICE_NAME: 'worker' } as never
  assert.equal(isPlatformRuntime(env), true)
  assert.equal(detectEnvironment(env), 'production')
  assert.equal(canWriteAgentRecords(env).allowed, true)
})

test('a local runtime against a LOCAL database is fine', () => {
  const env = { DATABASE_URL: LOCAL_DB } as never
  assert.equal(databaseLooksProduction(env), false)
  assert.equal(canWriteAgentRecords(env).allowed, true)
})

test('the dangerous override works, is named loudly, and defaults to false', () => {
  const base = { DATABASE_URL: PROD_DB } as never
  assert.equal(canWriteAgentRecords(base).allowed, false, 'default must be refuse')

  const overridden = { DATABASE_URL: PROD_DB, [PRODUCTION_WRITE_OVERRIDE]: 'true' } as never
  const decision = canWriteAgentRecords(overridden)
  assert.equal(decision.allowed, true)
  assert.equal(decision.overridden, true, 'an overridden write must be flagged as such')
  assert.match(PRODUCTION_WRITE_OVERRIDE, /ALLOW.*PRODUCTION.*WRITES/)
})

test('the override does NOT work from a test runtime — there is no escape hatch', () => {
  // A test that can write to production is not a test.
  const env = { DATABASE_URL: PROD_DB, NODE_ENV: 'test', [PRODUCTION_WRITE_OVERRIDE]: 'true' } as never
  const decision = canWriteAgentRecords(env)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.match(decision.reason, /cannot be overridden/i)
})

test('an unparseable DATABASE_URL is treated as production', () => {
  // Conservative direction: being wrong costs a developer one variable.
  assert.equal(databaseLooksProduction({ DATABASE_URL: 'not-a-url' } as never), true)
})

test('branch and preview databases are recognised as non-production', () => {
  for (const host of ['ep-x-dev.neon.tech', 'ep-x.staging.neon.tech', 'test-db.internal', 'shadow.neon.tech']) {
    assert.equal(databaseLooksProduction({ DATABASE_URL: `postgresql://u:p@${host}/db` } as never), false, host)
  }
})

test('provenance distinguishes worker cycles, web actions, local and test', () => {
  const worker = provenance('scheduled', { RAILWAY_ENVIRONMENT: 'production', RAILWAY_SERVICE_NAME: 'worker' } as never)
  assert.deepEqual([worker.environment, worker.service, worker.source], ['production', 'worker', 'scheduled'])

  const web = provenance('api', { RAILWAY_ENVIRONMENT: 'production', RAILWAY_SERVICE_NAME: 'web-api' } as never)
  assert.equal(web.service, 'web')

  const local = provenance('dry_run', {} as never)
  assert.deepEqual([local.environment, local.service, local.source], ['development', 'cli', 'dry_run'])

  assert.equal(detectService({ NODE_ENV: 'test' } as never), 'test')
})

test('a deployment identifier is captured when the platform provides one', () => {
  const p = provenance('scheduled', { RAILWAY_ENVIRONMENT: 'production', RAILWAY_DEPLOYMENT_ID: 'dep_abc123' } as never)
  assert.equal(p.deploymentId, 'dep_abc123')
})

test('the runner refuses to run before it claims a cycle or writes anything', () => {
  const src = lib('email-agent/runner.ts')
  const guardAt = src.indexOf('const writeCheck = canWriteAgentRecords()')
  const claimAt = src.indexOf('claim = await claimCycle(')
  assert.ok(guardAt > 0 && claimAt > 0, 'both the guard and the claim must exist')
  assert.ok(guardAt < claimAt, 'the boundary check must precede the cycle claim, which is the first write')
})

test('the cycle lock survives a pooled connection', () => {
  // WHY THIS EXISTS: `pg_try_advisory_lock` is SESSION-scoped, and Prisma talks
  // to Neon through a pool, so the lock and the unlock can land on different
  // connections. Observed live: the first cycle worked and every later one was
  // refused against a lock nobody held. The claim is now a TRANSACTION-scoped
  // lock plus a durable lease row.
  // Comments legitimately explain WHY the session lock was abandoned, so the
  // assertion runs on CODE only.
  const src = lib('email-agent/runner.ts')
  const code = stripComments(src)
  assert.ok(!/pg_try_advisory_lock/.test(code), 'a session-scoped lock must not be used under a connection pool')
  assert.ok(/pg_advisory_xact_lock/.test(src), 'the claim must use a transaction-scoped lock')
  assert.ok(/\$executeRaw`SELECT pg_advisory_xact_lock/.test(src), 'it must use $executeRaw — the function returns void and $queryRaw cannot deserialise it')
  assert.ok(/status: 'running'/.test(src), 'the durable lease is a running run row')
  assert.ok(/CYCLE_LEASE_STALE_MS/.test(src), 'and an abandoned lease must go stale rather than block forever')
})

test('an abandoned cycle is superseded and recorded as failed, not forgotten', () => {
  const src = lib('email-agent/runner.ts')
  const fn = src.slice(src.indexOf('async function claimCycle'), src.indexOf('const count = ('))
  assert.ok(/status: 'failed'/.test(fn), 'a stale running row must be closed as failed')
  assert.ok(/interrupted/i.test(fn), 'and must say why')
})

test('the dry-run script cannot write: it imports no mutating agent module', () => {
  const src = readFileSync(resolve(__dirname, '../../../scripts/email-agent-dryrun.ts'), 'utf8')
  for (const forbidden of ['runAgentCycle', 'reconcileIncidents', 'executeTool', 'createApprovalRequest', 'alertForIncidents', 'investigate']) {
    assert.ok(!src.includes(forbidden), `the dry run must not import ${forbidden}`)
  }
  assert.ok(src.includes('runHealthChecks'), 'it should still run the real checks')
})

// ════════════════════════════════════════════════════════════════════════
//  PHASE 2 — AI DEDUPLICATION
//  THE COST BUG: 288 identical model calls a day, per incident.
// ════════════════════════════════════════════════════════════════════════

const finding = (over: Partial<AgentFinding> = {}): AgentFinding => ({
  checkId: 'run.stuck_in_transition',
  fingerprint: 'run.stuck_in_transition:abc',
  severity: 'critical',
  category: 'run',
  title: 'A run is stuck',
  description: 'Run x has not moved.',
  evidence: { runStatus: 'SENDING', openRows: 3 },
  runRefId: 'run_x',
  suggestedActions: [],
  detectedAt: new Date('2026-07-28T12:00:00Z'),
  ...over,
})

const state = (over: Partial<Parameters<typeof shouldInvestigate>[0]> = {}) => ({
  created: false,
  reopened: false,
  severity: 'critical' as FindingSeverity,
  previousSeverity: 'critical' as FindingSeverity | null,
  currentEvidenceHash: 'hash-a',
  investigatedEvidenceHash: 'hash-a',
  lastInvestigatedAt: new Date('2026-07-28T11:55:00Z'),
  reinvestigateRequestedAt: null as Date | null,
  ...over,
})
const opts = { now: new Date('2026-07-28T12:00:00Z'), cooldownHours: 12 }

test('IDENTICAL consecutive cycles do NOT call the model', () => {
  // The single most important cost test in the suite.
  const d = shouldInvestigate(state(), opts)
  assert.equal(d.investigate, false)
  if (!d.investigate) assert.match(d.reason, /Unchanged/)
})

test('a detection count rising is NOT a reason to investigate', () => {
  // "Seen again" is not "changed". Detection counts are not in the hash at all.
  const a = evidenceHash([finding()])
  const b = evidenceHash([finding()])
  assert.equal(a, b)
  assert.equal(shouldInvestigate(state({ currentEvidenceHash: a, investigatedEvidenceHash: b }), opts).investigate, false)
})

test('elapsed-time evidence does not create a false change', () => {
  // "stuck for 47 minutes" → "48 minutes" is the same problem. Hashing it
  // would put the bill straight back where it was.
  const a = evidenceHash([finding({ evidence: { minutesIdle: 47, status: 'SENDING' } })])
  const b = evidenceHash([finding({ evidence: { minutesIdle: 48, status: 'SENDING' } })])
  assert.equal(a, b, 'volatile timing keys must be excluded from the hash')
})

test('an ISO timestamp inside evidence does not create a false change', () => {
  const a = evidenceHash([finding({ evidence: { checkedAt: '2026-07-28T12:00:00Z', count: 3 } })])
  const b = evidenceHash([finding({ evidence: { checkedAt: '2026-07-28T12:05:00Z', count: 3 } })])
  assert.equal(a, b)
})

test('a NEW incident always earns an investigation', () => {
  const d = shouldInvestigate(state({ created: true, lastInvestigatedAt: null, investigatedEvidenceHash: null }), opts)
  assert.equal(d.investigate, true)
  if (d.investigate) assert.equal(d.trigger, 'new_incident')
})

test('MATERIAL new evidence triggers an investigation', () => {
  const d = shouldInvestigate(state({ currentEvidenceHash: 'hash-b' }), opts)
  assert.equal(d.investigate, true)
  if (d.investigate) assert.equal(d.trigger, 'evidence_changed')
})

test('a severity change triggers an investigation IN EITHER DIRECTION', () => {
  const worse = shouldInvestigate(state({ severity: 'critical', previousSeverity: 'warning' }), opts)
  assert.equal(worse.investigate, true)
  // Improvement matters too: the owner was alerted and should be told it eased.
  const better = shouldInvestigate(state({ severity: 'warning', previousSeverity: 'critical' }), opts)
  assert.equal(better.investigate, true)
  if (better.investigate) assert.equal(better.trigger, 'severity_changed')
})

test('a REOPENED incident triggers an investigation', () => {
  const d = shouldInvestigate(state({ reopened: true }), opts)
  assert.equal(d.investigate, true)
  if (d.investigate) assert.equal(d.trigger, 'reopened')
})

test('an expired cooldown allows one fresh look at an unchanged incident', () => {
  const d = shouldInvestigate(state({ lastInvestigatedAt: new Date('2026-07-27T12:00:00Z') }), opts)
  assert.equal(d.investigate, true)
  if (d.investigate) assert.equal(d.trigger, 'cooldown_expired')
})

test('a manual reinvestigation request always wins', () => {
  const d = shouldInvestigate(state({ reinvestigateRequestedAt: new Date('2026-07-28T11:59:00Z') }), opts)
  assert.equal(d.investigate, true)
  if (d.investigate) assert.equal(d.trigger, 'manual_request')
})

test('evidence hashing is order- and key-order-independent', () => {
  const a = evidenceHash([finding({ fingerprint: 'a' }), finding({ fingerprint: 'b' })])
  const b = evidenceHash([finding({ fingerprint: 'b' }), finding({ fingerprint: 'a' })])
  assert.equal(a, b, 'finding order must not change the hash')
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }), 'key order must not change the string')
})

test('the cycle spends its calls on the most deserving incidents first', () => {
  const ranked = rankForInvestigation([
    { severity: 'warning' as FindingSeverity, lastInvestigatedAt: null, trigger: 'cooldown_expired' as const },
    { severity: 'critical' as FindingSeverity, lastInvestigatedAt: null, trigger: 'new_incident' as const },
    { severity: 'info' as FindingSeverity, lastInvestigatedAt: null, trigger: 'manual_request' as const },
  ])
  assert.equal(ranked[0].trigger, 'manual_request', 'a human request outranks everything')
  assert.equal(ranked[1].trigger, 'new_incident')
})

test('concurrent cycles cannot both investigate: the cycle holds an advisory lock', () => {
  const src = lib('email-agent/runner.ts')
  assert.ok(/pg_try_advisory_lock/.test(src), 'the cycle must take a Postgres advisory lock, not an in-memory flag')
  assert.ok(/AGENT_LOCK_KEY/.test(src))
  const budget = lib('email-agent/budget.ts')
  assert.ok(/pg_advisory_xact_lock/.test(budget), 'budget reservation must be inside a transaction-scoped lock')
})

// ════════════════════════════════════════════════════════════════════════
//  PHASE 3 — COST AND BUDGET
// ════════════════════════════════════════════════════════════════════════

test('an UNKNOWN model is costed at the worst case, never at zero', () => {
  // A model with no price must never look free — that is how a budget
  // silently stops working.
  const cost = estimateCost({ provider: 'openai', model: 'gpt-9-experimental', promptTokens: 1_000_000, completionTokens: 1_000_000 })
  assert.equal(cost.unknownModel, true)
  assert.ok(cost.usd > 0, 'an unknown model must cost something')
  assert.equal(cost.usd, WORST_CASE_PRICE.inputPerMillion + WORST_CASE_PRICE.outputPerMillion)
  assert.match(cost.pricingVersion, /unknown-model-worst-case/)
})

test('cached input is billed cheaper but NOT free', () => {
  const uncached = estimateCost({ provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 0 })
  const cached = estimateCost({ provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 0, cachedInputTokens: 1_000_000 })
  assert.ok(cached.usd < uncached.usd, 'cached must be cheaper')
  assert.ok(cached.usd > 0, 'cached must not be free')
})

test('cached tokens are not billed twice', () => {
  // promptTokens INCLUDES the cached portion on both providers.
  const c = estimateCost({ provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 1000, completionTokens: 0, cachedInputTokens: 400 })
  assert.equal(c.inputTokens, 600, 'the fresh input must exclude the cached portion')
  assert.equal(c.cachedInputTokens, 400)
})

test('cached tokens are clamped to the prompt size', () => {
  const c = estimateCost({ provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 100, completionTokens: 0, cachedInputTokens: 999 })
  assert.equal(c.cachedInputTokens, 100)
  assert.equal(c.inputTokens, 0)
})

test('every priced model carries a basis and an effective date', () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5.6-luna']) {
    const price = findPrice(model.startsWith('deepseek') ? 'deepseek' : 'openai', model)
    assert.ok(price, `${model} must be priced`)
    assert.match(price!.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(['provider-listed', 'estimated'].includes(price!.basis))
  }
  assert.match(PRICING_VERSION, /^\d{4}-\d{2}-\d{2}$/)
})

test('DeepSeek Flash really is the cheapest option for this workload', () => {
  const shape = { investigationsPerDay: 25, avgPromptTokens: 3000, avgCompletionTokens: 700 }
  const flash = projectMonthlyCost({ provider: 'deepseek', model: 'deepseek-v4-flash', ...shape })
  const nano = projectMonthlyCost({ provider: 'openai', model: 'gpt-5.4-nano', ...shape })
  const mini = projectMonthlyCost({ provider: 'openai', model: 'gpt-5-mini', ...shape })
  const luna = projectMonthlyCost({ provider: 'openai', model: 'gpt-5.6-luna', ...shape })
  assert.ok(flash.perMonth < nano.perMonth, 'flash must beat nano')
  assert.ok(nano.perMonth < mini.perMonth, 'nano must beat mini')
  assert.ok(mini.perMonth < luna.perMonth)
  // And the whole point: the chosen primary fits the preferred target.
  assert.ok(flash.perMonth < 3, `deepseek-v4-flash projects $${flash.perMonth}/month, which must be under the $3 target`)
})

const usage = (over: Partial<BudgetUsage> = {}): BudgetUsage => ({
  day: { calls: 0, tokens: 0, costUsd: 0 },
  month: { calls: 0, tokens: 0, costUsd: 0 },
  dayKey: '2026-07-28',
  monthKey: '2026-07',
  limits: { callsPerCycle: 2, callsPerDay: 25, tokensPerDay: 150000, tokensPerMonth: 3000000, costPerDay: 0.2, costPerMonth: 3 },
  remaining: { callsToday: 25, tokensToday: 150000, tokensThisMonth: 3000000, costToday: 0.2, costThisMonth: 3 },
  monthlyPercentUsed: 0,
  projectedMonthEndUsd: null,
  ...over,
})

test('the per-cycle call limit is enforced', () => {
  assert.equal(evaluateLimits(usage(), 0).allowed, true)
  const blocked = evaluateLimits(usage(), 2)
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) assert.equal(blocked.limit, 'calls_per_cycle')
})

test('the daily call limit is enforced', () => {
  const blocked = evaluateLimits(usage({ day: { calls: 25, tokens: 0, costUsd: 0 } }), 0)
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) assert.equal(blocked.limit, 'calls_per_day')
})

test('the daily token limit is enforced', () => {
  const blocked = evaluateLimits(usage({ day: { calls: 1, tokens: 150000, costUsd: 0 } }), 0)
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) assert.equal(blocked.limit, 'tokens_per_day')
})

test('the monthly token limit is enforced', () => {
  const blocked = evaluateLimits(usage({ month: { calls: 1, tokens: 3000000, costUsd: 0 } }), 0)
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) assert.equal(blocked.limit, 'tokens_per_month')
})

test('the DAILY DOLLAR limit is enforced', () => {
  const blocked = evaluateLimits(usage({ day: { calls: 1, tokens: 10, costUsd: 0.2 } }), 0)
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) assert.equal(blocked.limit, 'cost_per_day')
})

test('the MONTHLY DOLLAR limit is enforced — the headline guarantee', () => {
  const blocked = evaluateLimits(usage({ month: { calls: 1, tokens: 10, costUsd: 3.0 } }), 0)
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) {
    assert.equal(blocked.limit, 'cost_per_month')
    assert.match(blocked.reason, /\$3\.00/)
  }
})

test('daily and monthly period keys roll over correctly', () => {
  assert.equal(dayKey(new Date('2026-07-28T23:59:59Z')), '2026-07-28')
  assert.equal(dayKey(new Date('2026-07-29T00:00:00Z')), '2026-07-29')
  assert.equal(monthKey(new Date('2026-07-31T23:59:59Z')), '2026-07')
  assert.equal(monthKey(new Date('2026-08-01T00:00:00Z')), '2026-08')
})

test('concurrent workers cannot overspend: reservation is read-and-write under one lock', () => {
  const src = lib('email-agent/budget.ts')
  const fn = src.slice(src.indexOf('export async function reserveModelCall'))
  const lockAt = fn.indexOf('pg_advisory_xact_lock')
  const readAt = fn.indexOf('await readUsage(')
  const writeAt = fn.indexOf('tx.emailAgentModelCall.create')
  assert.ok(lockAt > 0 && lockAt < readAt, 'the lock must be taken before the usage is read')
  assert.ok(readAt < writeAt, 'the reservation must be written after the read, inside the same transaction')
  assert.ok(/prisma\.\$transaction/.test(fn), 'reservation must be transactional')
})

test('a reservation that never reached a provider stops counting but is not deleted', () => {
  const src = lib('email-agent/budget.ts')
  assert.ok(/outcome: 'disabled'/.test(src), 'a released reservation is marked, not removed')
  assert.ok(!/emailAgentModelCall\.delete/.test(src), 'evidence must never be deleted to tidy a number')
  assert.ok(/outcome: \{ in: \['ok', 'invalid_output', 'error', 'timeout'\] \}/.test(src), 'only calls that reached a provider are billable')
})

test('remaining budget never renders negative, and never divides by zero', () => {
  // A negative "remaining" reads as credit; NaN reads as broken.
  const src = lib('email-agent/budget.ts')
  assert.ok(/const positive =/.test(src), 'remaining must be clamped')
  assert.ok(/limits\.costPerMonth > 0 \?/.test(src), 'the percentage must guard a zero limit')
  assert.ok(/Math\.max\(1, now\.getUTCDate\(\)\)/.test(src), 'the projection must never divide by zero on day one')
})

test('budget threshold alerts fire once each per billing period', () => {
  const base = { monthKey: '2026-07', monthlyLimitUsd: 3, monthSpendUsd: 1.6 }
  const first = budgetAlertToRaise({ ...base, monthlyPercentUsed: 55, lastAlertPeriod: null, lastAlertLevel: 0 })
  assert.equal(first?.level, 50)
  // Still above 50% but already alerted → silence.
  assert.equal(budgetAlertToRaise({ ...base, monthlyPercentUsed: 60, lastAlertPeriod: '2026-07', lastAlertLevel: 50 }), null)
  // Crossing 80% is new news.
  assert.equal(budgetAlertToRaise({ ...base, monthlyPercentUsed: 85, lastAlertPeriod: '2026-07', lastAlertLevel: 50 })?.level, 80)
  // A new month resets it.
  assert.equal(budgetAlertToRaise({ ...base, monthKey: '2026-08', monthlyPercentUsed: 55, lastAlertPeriod: '2026-07', lastAlertLevel: 100 })?.level, 50)
})

test('an exhausted budget stops the AI and NOTHING else', () => {
  const runner = lib('email-agent/runner.ts')
  const checksAt = runner.indexOf('await runHealthChecks(')
  const investigateAt = runner.indexOf('await investigate(')
  assert.ok(checksAt > 0 && checksAt < investigateAt, 'checks must complete before any spend decision')
  assert.ok(/deterministicSummary\(/.test(runner), 'a deterministic summary must exist for when the AI does not run')
})

test('budget exhaustion cannot authorise an action', () => {
  // The action path runs off the POLICY engine and the recommendation, and a
  // budget-exhausted cycle has no recommendation at all.
  const runner = lib('email-agent/runner.ts')
  assert.ok(/const recommendation = investigation\.decision\?\.recommendation/.test(runner))
  assert.ok(/if \(recommendation && recommendation\.type !== 'none' && leadIncident\)/.test(runner), 'no decision means no action is even considered')
})

test('the agent cannot raise its own spending limits', () => {
  const src = ['email-agent/tools.ts', 'email-agent/investigator.ts', 'email-agent/runner.ts'].map(lib).join('\n')
  for (const field of ['maxAiCostUsdPerMonth', 'maxAiCostUsdPerDay', 'maxTokensPerDay', 'maxTokensPerMonth', 'maxModelCallsPerDay']) {
    assert.ok(!new RegExp(`${field}\\s*:`).test(src), `no agent code path may write ${field}`)
  }
})

test('pricing metadata is never confused with a credential', () => {
  const src = lib('email-agent/pricing.ts')
  for (const secret of ['apiKey', 'API_KEY', 'process.env.OPENAI', 'process.env.DEEPSEEK', 'Authorization']) {
    assert.ok(!src.includes(secret), `the pricing table must not reference ${secret}`)
  }
  // And redaction does not mistake a price for a secret.
  const out = redact({ inputPerMillion: 0.14, model: 'deepseek-v4-flash' }) as Record<string, unknown>
  assert.equal(out.inputPerMillion, 0.14)
  assert.equal(out.model, 'deepseek-v4-flash')
})

// ════════════════════════════════════════════════════════════════════════
//  PROVIDER ADAPTERS — the live-verified 400 bug
// ════════════════════════════════════════════════════════════════════════

test('GPT-5 models get max_completion_tokens, NOT max_tokens', () => {
  // VERIFIED LIVE: sending max_tokens to any gpt-5 model returns
  // "400 Unsupported parameter". The fallback path was dead on arrival.
  for (const model of ['gpt-5.4-nano', 'gpt-5-mini', 'gpt-5.6-luna']) {
    const body = buildRequestBody({ model }, [])
    assert.ok('max_completion_tokens' in body, `${model} must use max_completion_tokens`)
    assert.ok(!('max_tokens' in body), `${model} must NOT send max_tokens`)
  }
})

test('older models still get max_tokens', () => {
  for (const model of ['gpt-4o-mini', 'deepseek-v4-flash', 'deepseek-chat']) {
    const body = buildRequestBody({ model }, [])
    assert.ok('max_tokens' in body, `${model} must use max_tokens`)
    assert.ok(!('max_completion_tokens' in body))
  }
})

test('the output ceiling is applied and leaves room for reasoning tokens', () => {
  const body = buildRequestBody({ model: 'deepseek-v4-flash' }, [])
  assert.equal(body.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS)
  // MEASURED: at 1200, 5 of 13 live deepseek-v4-flash calls returned
  // `invalid_output` because reasoning tokens are drawn from this same budget
  // and truncated the JSON mid-object. A truncated call is billed AND triggers
  // the paid fallback, so too low is more expensive than too high.
  assert.ok(DEFAULT_MAX_OUTPUT_TOKENS >= 2500, 'the ceiling must leave room for reasoning tokens')
  // But still bounded — output is the expensive half of the bill.
  assert.ok(DEFAULT_MAX_OUTPUT_TOKENS <= 4000, 'the answer ceiling must stay small')
  const custom = buildRequestBody({ model: 'deepseek-v4-flash', maxOutputTokens: 500 }, [])
  assert.equal(custom.max_tokens, 500)
})

test('a FAILED model call still records its token usage', () => {
  // A call that answered with unparseable JSON burned tokens and is on the
  // invoice. Costing it at zero lets the budget drift by exactly the amount
  // being wasted — measured: 5 such calls were recorded at $0.
  const src = lib('email-agent/providers/index.ts')
  const failures = (src.match(/outcome: 'invalid_output'/g) ?? []).length
  const usageOnFailure = (src.match(/usage: readUsage\(body\.usage\)/g) ?? []).length
  assert.ok(usageOnFailure >= failures, `every invalid_output path must report usage (${failures} paths, ${usageOnFailure} report usage)`)
  const inv = lib('email-agent/investigator.ts')
  // The settle call must read usage UNCONDITIONALLY — no `result.ok ? ... : undefined`.
  assert.ok(/promptTokens: result\.usage\?\.promptTokens,/.test(inv), 'the investigator must settle cost from usage regardless of success')
  assert.ok(!/result\.ok \? result\.usage/.test(inv), 'usage must not be discarded on failure')
})

test('a placeholder environment value is not treated as configuration', () => {
  // MEASURED: DISCORD_CHANNEL_ALERTS was the literal string
  // "PASTE_ALERTS_CHANNEL_ID". The old guard only looked for "REPLACE", so the
  // alert path reported itself configured and Discord answered 400.
  const status = effectiveStatus(
    { ...settings, alertsEnabled: true },
    { EMAIL_AGENT_ENABLED: 'true', DISCORD_BOT_TOKEN: 'realtoken1234567890', DISCORD_CHANNEL_ALERTS: 'PASTE_ALERTS_CHANNEL_ID' } as never
  )
  assert.equal(status.alertsConfigured, false, 'a PASTE_ placeholder must read as unconfigured')
  assert.match(status.alertsReason!, /nowhere to go/)
})

test('the defaults are the cheapest verified models', () => {
  assert.equal(PROVIDER_DEFAULT_MODELS.deepseek, 'deepseek-v4-flash')
  assert.equal(PROVIDER_DEFAULT_MODELS.openai, 'gpt-5.4-nano')
})

test('both providers usage shapes are read, including cache and reasoning', () => {
  // OpenAI shape.
  const oa = readUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 20 } })
  assert.equal(oa.cachedInputTokens, 40)
  assert.equal(oa.reasoningTokens, 20)
  // DeepSeek shape — different field names for the same facts.
  const ds = readUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 })
  assert.equal(ds.cachedInputTokens, 30, 'DeepSeek cache hits must be read from their own field')
})

test('json_object mode is off only for models that reject it', () => {
  assert.ok('response_format' in buildRequestBody({ model: 'deepseek-v4-flash' }, []))
  assert.ok(!('response_format' in buildRequestBody({ model: 'deepseek-reasoner', supportsJsonObjectMode: false }, [])))
})

// ════════════════════════════════════════════════════════════════════════
//  PHASE 4 — BLAST RADIUS
// ════════════════════════════════════════════════════════════════════════

const settings = { ...envDefaults({ EMAIL_AGENT_ENABLED: 'true' } as never) }
const counts = (over = {}) => ({
  actionsToday: 0,
  actionsForToolToday: 0,
  actionsForIncident: 0,
  lastActionOnResourceAt: null as Date | null,
  identicalActionExists: false,
  consecutiveFailures: 0,
  ...over,
})
const NOW = new Date('2026-07-28T12:00:00Z')

test('the global daily action limit is enforced', () => {
  const v = evaluateBlastRadius(counts({ actionsToday: 10 }), settings, { tool: 'reconcileRunCounters', now: NOW })
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.limit, 'per_day')
})

test('the per-tool daily limit is enforced', () => {
  const v = evaluateBlastRadius(counts({ actionsForToolToday: 4 }), settings, { tool: 'reconcileRunCounters', now: NOW })
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.limit, 'per_tool_day')
})

test('the per-incident action limit is enforced', () => {
  const v = evaluateBlastRadius(counts({ actionsForIncident: 3 }), settings, { tool: 'reconcileRunCounters', now: NOW })
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.limit, 'per_incident')
})

test('the per-resource cooldown is enforced', () => {
  const v = evaluateBlastRadius(
    counts({ lastActionOnResourceAt: new Date(NOW.getTime() - 10 * 60_000) }),
    settings,
    { tool: 'reconcileRunCounters', now: NOW }
  )
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.limit, 'resource_cooldown')
})

test('an identical action for identical evidence is refused FIRST', () => {
  // Better explanation than "the daily limit is full".
  const v = evaluateBlastRadius(counts({ identicalActionExists: true, actionsToday: 99 }), settings, { tool: 'reconcileRunCounters', now: NOW })
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.limit, 'identical_action')
})

test('the action fingerprint includes the EVIDENCE, not just the arguments', () => {
  // Re-running a repair is legitimate if the evidence changed, and a bug if
  // it did not. Arguments alone cannot tell those apart.
  const a = actionFingerprint('reconcileRunCounters', { runId: 'r1' }, 'evidence-1')
  const b = actionFingerprint('reconcileRunCounters', { runId: 'r1' }, 'evidence-2')
  const c = actionFingerprint('reconcileRunCounters', { runId: 'r1' }, 'evidence-1')
  assert.notEqual(a, b)
  assert.equal(a, c)
})

test('a clean slate allows the action', () => {
  assert.equal(evaluateBlastRadius(counts(), settings, { tool: 'reconcileRunCounters', now: NOW }).allowed, true)
})

test('repeated failures downgrade safe_auto to read_only', () => {
  const v = shouldDowngradeSafeAuto({
    mode: 'safe_auto', consecutiveFailures: 3, failureThreshold: 3,
    actionsInLastHour: 0, incidentsOpenedBeforeActions: 0, incidentsOpenedAfterActions: 0,
  })
  assert.equal(v.downgrade, true)
  if (v.downgrade) assert.match(v.reason, /failed in a row/)
})

test('an incident spike AFTER automatic actions downgrades safe_auto', () => {
  const v = shouldDowngradeSafeAuto({
    mode: 'safe_auto', consecutiveFailures: 0, failureThreshold: 3,
    actionsInLastHour: 2, incidentsOpenedBeforeActions: 1, incidentsOpenedAfterActions: 8,
  })
  assert.equal(v.downgrade, true)
})

test('an incident spike with NO preceding actions is just a bad day', () => {
  // Downgrading here would remove a capability for something the agent did not cause.
  const v = shouldDowngradeSafeAuto({
    mode: 'safe_auto', consecutiveFailures: 0, failureThreshold: 3,
    actionsInLastHour: 0, incidentsOpenedBeforeActions: 1, incidentsOpenedAfterActions: 20,
  })
  assert.equal(v.downgrade, false)
})

test('read_only is never downgraded, and never auto-UPgraded', () => {
  const v = shouldDowngradeSafeAuto({
    mode: 'read_only', consecutiveFailures: 99, failureThreshold: 3,
    actionsInLastHour: 50, incidentsOpenedBeforeActions: 0, incidentsOpenedAfterActions: 99,
  })
  assert.equal(v.downgrade, false)
  const src = lib('email-agent/blast-radius.ts')
  // Comments legitimately discuss the absence of an upgrade path ("there is no
  // corresponding shouldUpgrade"), so the assertion runs on CODE only.
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  assert.ok(!/shouldUpgrade|upgradeSafeAuto|promoteSafeAuto/.test(code), 'no upgrade function may exist')
  // The ONLY place this module writes a mode is the downgrade, and it writes
  // read_only. `beforeState: { mode: 'safe_auto' }` is a RECORD of what the
  // mode was, not an assignment, so the check is scoped to the settings update.
  const fn = src.slice(src.indexOf('export async function downgradeSafeAuto'))
  const settingsUpdate = fn.slice(fn.indexOf('emailAgentSettings.update'), fn.indexOf('emailAgentAction.create'))
  assert.ok(/mode: 'read_only'/.test(settingsUpdate), 'the downgrade must set read_only')
  assert.ok(!/mode: 'safe_auto'/.test(settingsUpdate), 'the settings update must never set safe_auto')
})

test('the downgrade goes to read_only, never to off', () => {
  // Losing the monitoring too would turn one problem into two.
  const src = lib('email-agent/blast-radius.ts')
  const fn = src.slice(src.indexOf('export async function downgradeSafeAuto'))
  assert.ok(/mode: 'read_only'/.test(fn))
  assert.ok(!/mode: 'off'/.test(fn))
})

test('an automatic downgrade leaves immutable evidence and a reason', () => {
  const src = lib('email-agent/blast-radius.ts')
  const fn = src.slice(src.indexOf('export async function downgradeSafeAuto'))
  assert.ok(/emailAgentAction\.create/.test(fn), 'it must write an audit action')
  assert.ok(/autoDowngradeReason/.test(fn), 'and record why on the settings row')
  assert.ok(/autoDowngradedAt/.test(fn))
})

test('safe-auto is OFF by default in every environment', () => {
  assert.equal(envDefaults({} as never).mode, 'off')
  assert.equal(envDefaults({ EMAIL_AGENT_ENABLED: 'true' } as never).mode, 'read_only')
  assert.notEqual(envDefaults({ EMAIL_AGENT_ENABLED: 'true' } as never).mode, 'safe_auto')
})

test('only mutating tools consume blast-radius budget', () => {
  assert.equal(isMutatingTool('reconcileRunCounters'), true)
  assert.equal(isMutatingTool('pauseMarketingDispatch'), true)
  assert.equal(isMutatingTool('inspectCampaign'), false, 'reading must not consume the action budget')
  assert.equal(isMutatingTool('createIncident'), false, 'agent bookkeeping must not consume it either')
})

// ════════════════════════════════════════════════════════════════════════
//  PHASE 6 + 8 — HEARTBEAT AND EFFECTIVE STATUS
// ════════════════════════════════════════════════════════════════════════

const hb = (over = {}) => ({
  enabled: true,
  lastRunAt: new Date('2026-07-28T11:58:00Z'),
  lastSuccessAt: new Date('2026-07-28T11:58:00Z'),
  lastStatus: 'completed',
  consecutiveFailures: 0,
  intervalMinutes: 15,
  now: NOW,
  ...over,
})

test('heartbeat: never run', () => {
  assert.equal(heartbeatState(hb({ lastRunAt: null })).state, 'never_run')
})
test('heartbeat: healthy', () => {
  assert.equal(heartbeatState(hb()).state, 'healthy')
})
test('heartbeat: delayed after 3 intervals', () => {
  assert.equal(heartbeatState(hb({ lastRunAt: new Date('2026-07-28T11:10:00Z') })).state, 'delayed')
})
test('heartbeat: stale after 6 intervals', () => {
  assert.equal(heartbeatState(hb({ lastRunAt: new Date('2026-07-28T09:00:00Z') })).state, 'stale')
})
test('heartbeat: disabled', () => {
  assert.equal(heartbeatState(hb({ enabled: false })).state, 'disabled')
})
test('heartbeat: a failed last cycle is not healthy', () => {
  assert.equal(heartbeatState(hb({ lastStatus: 'failed' })).state, 'delayed')
})
test('heartbeat: running on time but failing every time is FAILING, not healthy', () => {
  // The state that "healthy" would completely conceal.
  assert.equal(heartbeatState(hb({ consecutiveFailures: 3 })).state, 'failing')
})

test('the heartbeat counts PRODUCTION WORKER cycles only', () => {
  // A manual admin run must never make a dead cron look alive.
  const src = lib('email-agent/status.ts')
  assert.ok(/service: 'worker', source: 'scheduled'/.test(src), 'the heartbeat query must filter to scheduled worker cycles')
})

test('effective mode is OFF when the environment disables it, whatever the row says', () => {
  const s = { ...settings, mode: 'safe_auto' as const }
  const status = effectiveStatus(s, { DATABASE_URL: LOCAL_DB } as never)
  assert.equal(status.requestedMode, 'safe_auto')
  assert.equal(status.effectiveMode, 'off')
  assert.equal(status.safeAutoActive, false, 'safeAutoActive must be false when the agent is off')
  assert.match(status.reason!, /EMAIL_AGENT_ENABLED/)
})

test('effective mode follows the row when the environment allows it', () => {
  const status = effectiveStatus({ ...settings, mode: 'read_only' }, { EMAIL_AGENT_ENABLED: 'true', DATABASE_URL: LOCAL_DB } as never)
  assert.equal(status.effectiveMode, 'read_only')
  assert.equal(status.reason, null)
  assert.equal(status.safeAutoActive, false)
})

test('degraded settings are reported, not hidden', () => {
  const status = effectiveStatus({ ...settings, mode: 'read_only', degraded: true, degradedReason: 'table missing' }, { EMAIL_AGENT_ENABLED: 'true' } as never)
  assert.equal(status.settingsDegraded, true)
  assert.match(status.reason!, /pause is NOT being applied/)
})

test('AI status is reported independently of the mode', () => {
  const noKey = effectiveStatus({ ...settings, aiEnabled: true }, { EMAIL_AGENT_ENABLED: 'true', EMAIL_AGENT_PROVIDER: 'deepseek' } as never)
  assert.equal(noKey.aiEnabled, false)
  assert.match(noKey.aiReason!, /No API key/)

  const off = effectiveStatus({ ...settings, aiEnabled: false }, { EMAIL_AGENT_ENABLED: 'true', DEEPSEEK_API_KEY: 'x'.repeat(30) } as never)
  assert.equal(off.aiEnabled, false)
  assert.match(off.aiReason!, /switched off/)
})

test('alerting status is reported independently', () => {
  const unconfigured = effectiveStatus({ ...settings, alertsEnabled: true }, { EMAIL_AGENT_ENABLED: 'true' } as never)
  assert.equal(unconfigured.alertsConfigured, false)
  assert.match(unconfigured.alertsReason!, /nowhere to go/)
})

test('configuration is reported as PRESENCE only, never as a value', () => {
  const keyValue = shaped('sk' + '-', 24)
  const status = effectiveStatus(settings, { EMAIL_AGENT_ENABLED: 'true', DEEPSEEK_API_KEY: keyValue, DATABASE_URL: PROD_DB } as never)
  const serialised = JSON.stringify(status)
  assert.ok(!serialised.includes(keyValue), 'no key value may appear in the status object')
  assert.ok(!serialised.includes('neon.tech'), 'no database host may appear either')
  for (const c of status.configuration) {
    assert.equal(typeof c.present, 'boolean')
    assert.ok(!('value' in c))
  }
})

test('the badge is never "healthy" merely because the database answered', () => {
  // THE BUG THIS PREVENTS: a page that reads settings successfully claiming
  // the system is fine while no worker has run for a day.
  const status = effectiveStatus({ ...settings, mode: 'read_only' }, { EMAIL_AGENT_ENABLED: 'true' } as never)
  const stale = { state: 'stale' as const, message: 'no cycle for 3 hours' }
  const badge = overallBadge(status, stale as never, 'healthy')
  assert.equal(badge.badge, 'critical', 'a stale worker outranks a healthy last result')

  const neverRun = overallBadge(status, { state: 'never_run', message: 'x' } as never, null)
  assert.equal(neverRun.badge, 'unknown')
})

test('the badge says OFF when the agent is off', () => {
  const status = effectiveStatus({ ...settings, mode: 'read_only' }, {} as never)
  assert.equal(overallBadge(status, { state: 'disabled', message: 'x' } as never, 'healthy').badge, 'off')
})

test('the heartbeat endpoint fails closed without a token and returns 503 when stale', () => {
  const src = readFileSync(resolve(__dirname, '../../../app/api/email/agent-heartbeat/route.ts'), 'utf8')
  assert.ok(/EMAIL_AGENT_HEARTBEAT_TOKEN/.test(src))
  assert.ok(/expected\.length < 16/.test(src), 'a short or missing token must disable the endpoint')
  assert.ok(/timingSafeEqual/.test(src), 'token comparison must be constant-time')
  assert.ok(/status: 401/.test(src), 'a bad token must be rejected')
  assert.ok(/failing \? 503 : 200/.test(src), 'a stale worker must return a non-2xx for a plain uptime monitor')
})

test('the heartbeat endpoint exposes no findings or configuration values', () => {
  const src = readFileSync(resolve(__dirname, '../../../app/api/email/agent-heartbeat/route.ts'), 'utf8')
  // Comments legitimately mention what is excluded; the PAYLOAD is what matters.
  const payload = src.slice(src.indexOf('return NextResponse.json('), src.lastIndexOf('} catch'))
  for (const leak of ['findings', 'summary:', 'DATABASE_URL', 'apiKey', 'incident', 'campaign']) {
    assert.ok(!payload.includes(leak), `the heartbeat payload must not expose ${leak}`)
  }
  // And what it DOES expose is state, timings and booleans.
  for (const allowed of ['state:', 'ageSeconds:', 'effectiveMode:', 'consecutiveFailures:']) {
    assert.ok(payload.includes(allowed), `the heartbeat should expose ${allowed}`)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  PHASE 7 — PRIVACY, ADVERSARIALLY
// ════════════════════════════════════════════════════════════════════════

/**
 * Credential-shaped fixtures, ASSEMBLED AT RUNTIME.
 *
 * These are entirely synthetic, but a literal `sk-` followed by thirty
 * characters is a literal `sk-` followed by thirty characters as far as a
 * secret scanner is concerned — GitHub push protection blocked this file for
 * exactly that reason. Building each string from parts keeps the tests honest
 * (the regexes still see the real shape at runtime) without committing
 * anything that looks like a key at rest.
 */
const body = (n: number): string => 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3).slice(0, n)
const shaped = (prefix: string, n: number): string => prefix + body(n)

const secrets: Array<[string, string]> = [
  ['OpenAI', shaped('sk' + '-proj-', 30)],
  ['DeepSeek', shaped('sk' + '-', 32)],
  ['Stripe live', shaped('sk' + '_live_', 16)],
  ['Stripe webhook', shaped('whsec' + '_', 22)],
  ['Resend', shaped('re' + '_', 18)],
  ['GitHub', shaped('ghp' + '_', 26)],
  ['AWS', 'AKIA' + body(16).toUpperCase()],
  ['SendGrid', 'SG' + '.' + body(20) + '.' + body(20)],
  ['JWT', [body(24), body(24), body(24)].join('.')],
  ['Postgres DSN', 'postgresql://user:' + body(8) + '@db.example.com:5432/prod'],
  ['Redis DSN', 'redis://default:' + body(8) + '@redis.example.com:6379'],
]

for (const [name, secret] of secrets) {
  test(`${name} secret is scrubbed from free text`, () => {
    const out = redactString(`the error was: ${secret} — retry later`)
    assert.ok(!out.includes(secret), `${name} survived redaction`)
  })
}

test('a Discord webhook URL and bot token are scrubbed', () => {
  const hookBody = body(22)
  const hook = 'https://discord.com/api/webhooks/123456789/' + hookBody
  assert.ok(!redactString(`posting to ${hook}`).includes(hookBody))
  const botToken = body(24) + '.' + body(6)
  assert.ok(!redactString('Authorization: Bot ' + botToken).includes(body(24)))
})

test('an authorization header value is scrubbed wherever it appears', () => {
  const token = body(24)
  const out = JSON.stringify(redact({ headers: { Authorization: 'Bearer ' + token } }))
  assert.ok(!out.includes(token))
})

test('secrets nested in objects, arrays and JSON strings are all caught', () => {
  const openai = shaped('sk' + '-', 32)
  const resend = shaped('re' + '_', 18)
  const whsec = shaped('whsec' + '_', 20)
  const payload = {
    level1: { level2: { apiKey: openai } },
    list: [resend, { token: whsec }],
    // A secret hidden inside a serialised JSON string, not an object.
    raw: JSON.stringify({ api_key: openai, x: 1 }),
  }
  const out = JSON.stringify(redact(payload))
  assert.ok(!out.includes(openai), 'nested and stringified secrets must both be caught')
  assert.ok(!out.includes(resend))
  assert.ok(!out.includes(whsec))
})

test('MIXED-CASE key names are still recognised', () => {
  // The previous pattern was case-sensitive and let `EMAIL` through.
  for (const key of ['EMAIL', 'Email', 'customerEmail', 'customer_email', 'toEmail', 'RECIPIENT']) {
    const out = redact({ [key]: 'real.person@gmail.com' }) as Record<string, string>
    assert.ok(String(out[key]).includes('***'), `${key} was not masked`)
  }
})

test('a bare address in free text is masked even with no key to trigger on', () => {
  const out = redactString('the send to real.person@gmail.com failed')
  assert.ok(!out.includes('real.person@gmail.com'))
  assert.ok(out.includes('***'))
})

test('phone numbers are removed', () => {
  for (const phone of ['+1 (555) 123-4567', '555-123-4567', '+15551234567']) {
    assert.ok(!redactString(`call ${phone} now`).includes('123'), `${phone} survived`)
  }
})

test('customer message bodies are omitted, not truncated', () => {
  // A partial message body is still a message body.
  const body = 'Hi, my address is 12 Elm Street and my card ends 4242. '.repeat(5)
  const out = redact({ body }) as Record<string, string>
  assert.match(out.body, /^\[omitted \d+-character content\]$/)
  assert.ok(!out.body.includes('Elm Street'))
})

test('MULTILINE text is redacted throughout, not just the first line', () => {
  const key = shaped('sk' + '-', 32)
  const text = `line one\nkey: ${key}\nline three real.person@x.com`
  const out = redactString(text)
  assert.ok(!out.includes(key))
  assert.ok(!out.includes('real.person@x.com'))
})

test('ALREADY-MASKED content is left alone and never double-masked', () => {
  assert.equal(maskEmail('d***o@example.com').includes('***'), true)
  const out = redactString('contact d***o@example.com about this')
  assert.ok(out.includes('d***o@example.com'), 'a mask must survive a second pass unchanged')
  assert.equal(findUnmaskedEmails({ note: 'd***o@example.com' }).length, 0)
})

test('ordinary incident text stays readable — the guard is not too broad', () => {
  // A leak detector that makes real findings unusable gets turned off.
  const real =
    'Run cms3slo3p000buqcck0tegewc is COMPLETED but 3 recipients are still PENDING. ' +
    'The campaign "July Customer Update" was scheduled for 2026-07-28T09:00:00Z and the sweep refused it 4 times.'
  const out = redactString(real)
  assert.ok(out.includes('cms3slo3p000buqcck0tegewc'), 'entity ids must survive')
  assert.ok(out.includes('July Customer Update'), 'campaign names must survive')
  assert.ok(out.includes('COMPLETED') && out.includes('PENDING'), 'states must survive')
  assert.ok(out.includes('2026-07-28T09:00:00Z'), 'timestamps must survive')
})

test('the leak guard finds an unmasked address anywhere in the structure', () => {
  assert.equal(findUnmaskedEmails({ a: { b: [{ c: 'leak@x.com' }] } }).length, 1)
  assert.equal(findUnmaskedEmails({ note: 'text with leak@x.com inside' }).length, 1)
  assert.equal(findUnmaskedEmails({ ok: 'd***o@x.com' }).length, 0)
})

test('a provider CANNOT bypass the prompt builder', () => {
  // Every adapter routes through callOpenAiCompatible → buildMessages. There is
  // no second path from an adapter to fetch().
  for (const file of ['email-agent/providers/openai.ts', 'email-agent/providers/deepseek.ts']) {
    const src = lib(file)
    assert.ok(!/fetch\(/.test(src), `${file} must not call fetch directly`)
    assert.ok(/callOpenAiCompatible/.test(src), `${file} must go through the shared transport`)
  }
  const shared = lib('email-agent/providers/index.ts')
  assert.ok(/buildRequestBody\(config, buildMessages\(input\)\)/.test(shared), 'the transport must always build messages through the prompt builder')
})

test('the investigator refuses to send a prompt containing an unmasked address', () => {
  const src = lib('email-agent/investigator.ts')
  const gate = src.slice(src.indexOf('GATE 1'), src.indexOf('Attempt 1'))
  assert.ok(/findUnmaskedEmails/.test(gate), 'the leak gate must run')
  assert.ok(gate.indexOf('findUnmaskedEmails') < gate.length, 'and must run before any call')
  const leakAt = src.indexOf('findUnmaskedEmails')
  const callAt = src.indexOf('await attemptCall(')
  assert.ok(leakAt > 0 && leakAt < callAt, 'the leak gate must precede the provider call')
})

// ════════════════════════════════════════════════════════════════════════
//  PLACEHOLDER CONFIGURATION (owner rollout, 2026-07-28)
//
//  Two real near-misses: DISCORD_CHANNEL_ALERTS was the literal string
//  `PASTE_ALERTS_CHANNEL_ID`, which the old guard accepted and Discord
//  answered 400 to; and the documented heartbeat token placeholder
//  `PUT_A_RANDOM_32_PLUS_CHARACTER_SECRET_HERE` is long enough to pass a
//  length check while being public knowledge.
// ════════════════════════════════════════════════════════════════════════

test('common placeholder values are not accepted as configuration', () => {
  const placeholders = [
    'PASTE_ALERTS_CHANNEL_ID',
    'PUT_A_RANDOM_32_PLUS_CHARACTER_SECRET_HERE',
    'REPLACE_ME',
    'YOUR_API_KEY',
    'CHANGE_ME',
    'TODO_SET_THIS',
    'EXAMPLE_VALUE',
  ]
  for (const p of placeholders) {
    const status = effectiveStatus(
      { ...settings, alertsEnabled: true },
      { EMAIL_AGENT_ENABLED: 'true', DISCORD_BOT_TOKEN: 'a-real-looking-token-value', DISCORD_CHANNEL_ALERTS: p } as never
    )
    assert.equal(status.alertsConfigured, false, `${p} must read as unconfigured`)
  }
})

test('a genuine-looking value IS accepted', () => {
  // The guard must not be so broad that real configuration is rejected.
  const status = effectiveStatus(
    { ...settings, alertsEnabled: true },
    { EMAIL_AGENT_ENABLED: 'true', DISCORD_BOT_TOKEN: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.abcdef.ghijkl', DISCORD_CHANNEL_ALERTS: '1234567890123456789' } as never
  )
  assert.equal(status.alertsConfigured, true, 'a real channel id must be accepted')
})

test('the heartbeat endpoint rejects the documented placeholder token', () => {
  const src = readFileSync(resolve(__dirname, '../../../app/api/email/agent-heartbeat/route.ts'), 'utf8')
  assert.ok(/const placeholder = /.test(src), 'the route must detect a placeholder token')
  assert.ok(/\|\| placeholder/.test(src), 'and refuse to enable the endpoint with one')
  assert.ok(/PUT\|/.test(src) || /PUT/.test(src), 'PUT_ prefixed placeholders must be covered')
})

test('the fallback provider needs its PROVIDER name, not just a model', () => {
  // A rollout that sets EMAIL_AGENT_FALLBACK_MODEL but omits
  // EMAIL_AGENT_FALLBACK_PROVIDER gets NO fallback at all, silently.
  const src = lib('email-agent/investigator.ts')
  const fn = src.slice(src.indexOf('export function resolveFallbackProvider'))
  assert.ok(/EMAIL_AGENT_FALLBACK_PROVIDER/.test(fn), 'the provider name is what enables the fallback')
  assert.ok(/if \(!name\) return null/.test(fn), 'and its absence disables the fallback entirely')
})
