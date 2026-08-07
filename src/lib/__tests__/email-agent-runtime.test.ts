import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CRITICAL_COOLDOWN_MS, decideAlert, formatIncidentAlert } from '../email-agent/alerts'
import { APPROVAL_TTL_MS, IDEMPOTENCY_WINDOW_MS, TOOL_SCHEMAS } from '../email-agent/tools'
import { agentDisabledByEnv, envDefaults, mergeSettings, pauseRefusalMessage } from '../email-agent/settings'
import { DisabledProvider, PROVIDER_DEFAULT_MODELS, extractJson } from '../email-agent/providers'
import { OpenAiProvider } from '../email-agent/providers/openai'
import { DeepSeekProvider, NO_JSON_MODE } from '../email-agent/providers/deepseek'
import { buildMessages } from '../email-agent/providers/prompt'
import { OPERATING_RULES } from '../email-agent/memory'
import { AGENT_TOOL_NAMES, type AgentAnalysisInput } from '../email-agent/types'
import { ALL_CHECKS, CHECK_IDS } from '../email-agent/checks'
import { emittedIds } from '../email-agent/checks/shared'

// ════════════════════════════════════════════════════════════════════════
//  AGENT RUNTIME (owner spec 2026-07-27)
//
//  Settings precedence, the executor's gates, alert deduplication, and the
//  two provider adapters. Everything here runs offline — no database, no
//  network, no API key.
// ════════════════════════════════════════════════════════════════════════

const lib = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')

// ── Settings + kill switches ────────────────────────────────────────────

test('the agent is OFF unless the deployment turns it on', () => {
  // PREVENTS: shipping this and having it start acting because a default flipped.
  assert.equal(envDefaults({} as NodeJS.ProcessEnv).mode, 'off')
  assert.equal(envDefaults({ EMAIL_AGENT_ENABLED: 'false' } as never).mode, 'off')
})

test('an enabled agent defaults to read_only, never safe_auto', () => {
  assert.equal(envDefaults({ EMAIL_AGENT_ENABLED: 'true' } as never).mode, 'read_only')
  // An unrecognised mode must fall back to the safest live mode, not the widest.
  assert.equal(envDefaults({ EMAIL_AGENT_ENABLED: 'true', EMAIL_AGENT_MODE: 'yolo' } as never).mode, 'read_only')
})

test('EMAIL_AGENT_ENABLED=false overrides a stored safe_auto', () => {
  // PREVENTS: a database row keeping the agent alive after the deployment
  // deliberately switched it off.
  const env = { EMAIL_AGENT_ENABLED: 'false' } as never
  const merged = mergeSettings(envDefaults(env), { mode: 'safe_auto' }, env)
  assert.equal(merged.mode, 'off')
  assert.equal(agentDisabledByEnv(env), true)
})

test('the stored row wins over env for everything EXCEPT the kill switch', () => {
  const env = { EMAIL_AGENT_ENABLED: 'true', EMAIL_AGENT_MAX_AUTO_ACTIONS_PER_RUN: '3' } as never
  const merged = mergeSettings(envDefaults(env), { mode: 'safe_auto', maxAutoActionsPerRun: 1, marketingDispatchPaused: true }, env)
  assert.equal(merged.mode, 'safe_auto')
  assert.equal(merged.maxAutoActionsPerRun, 1)
  assert.equal(merged.marketingDispatchPaused, true)
})

test('numeric settings are clamped, so a bad env cannot unbound the agent', () => {
  const wild = envDefaults({ EMAIL_AGENT_ENABLED: 'true', EMAIL_AGENT_MAX_AUTO_ACTIONS_PER_RUN: '99999' } as never)
  assert.ok(wild.maxAutoActionsPerRun <= 25, 'the per-cycle action cap must be bounded')
  const junk = envDefaults({ EMAIL_AGENT_ENABLED: 'true', EMAIL_AGENT_INTERVAL_MINUTES: 'banana' } as never)
  assert.equal(junk.intervalMinutes, 5, 'unparseable values fall back to the default')
})

test('the pause message tells an operator what to do', () => {
  const msg = pauseRefusalMessage({ paused: true, reason: 'duplicate send risk', since: new Date('2026-07-27T10:00:00Z'), by: 'operations agent' })
  assert.match(msg, /PAUSED/)
  assert.match(msg, /duplicate send risk/)
  assert.match(msg, /operations agent/)
  assert.match(msg, /Resume it/i)
})

// ── The kill switch is enforced at the server, not the browser ──────────

test('the GLOBAL kill switch is checked inside the dispatcher itself', () => {
  // PREVENTS: a "pause" that only hides a button while the scheduler keeps
  // sending. This is the one test that proves the switch is real.
  const src = lib('email-campaign-dispatch.ts')
  assert.ok(src.includes('isMarketingDispatchPaused'), 'the dispatcher must consult the pause flag')

  const dispatchFn = src.slice(src.indexOf('export async function dispatchCampaign'), src.indexOf('async function sendToRecipient'))
  assert.ok(dispatchFn.includes('isMarketingDispatchPaused'), 'dispatchCampaign must check the pause')
  assert.ok(/pause\.paused/.test(dispatchFn), 'and must refuse when it is set')

  const batchFn = src.slice(src.indexOf('export async function processCampaignBatch'))
  const batchBody = batchFn.slice(0, batchFn.indexOf('export async function processRecipientRetry'))
  assert.ok(batchBody.includes('isMarketingDispatchPaused'), 'an in-flight batch must also halt when dispatch is paused')
})

test('the pause is checked BEFORE the campaign is even loaded', () => {
  // Ordering matters: refusing early means no partial work and no run row.
  const src = lib('email-campaign-dispatch.ts')
  const fn = src.slice(src.indexOf('export async function dispatchCampaign'), src.indexOf('async function sendToRecipient'))
  assert.ok(fn.indexOf('isMarketingDispatchPaused') < fn.indexOf('loadCampaign(campaignId)'), 'the pause check must come first')
})

test('reading the pause flag can never throw into the dispatch path', () => {
  const src = lib('email-agent/settings.ts')
  const fn = src.slice(src.indexOf('export async function isMarketingDispatchPaused'))
  assert.ok(/catch/.test(fn), 'the pause read must catch its own errors')
  assert.ok(/paused: false/.test(fn), 'and degrade to "not paused" rather than blocking all email')
})

// ── Executor gates (source-level: they need a live database to run) ──────

test('every executable tool has a strict argument schema', () => {
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    assert.ok(schema, `${name} has no schema`)
    const parsed = schema!.safeParse({ unexpectedKey: 'x' })
    assert.equal(parsed.success, false, `${name} accepted an unexpected argument`)
  }
})

test('the three forbidden tools have NO schema and NO executor', () => {
  // PREVENTS: a future edit making them callable by accident. No schema means
  // executeTool refuses before the policy engine is even consulted a second time.
  for (const name of ['removeSuppression', 'raiseStageRecipientLimit', 'enableSafeAutoMode'] as const) {
    assert.equal(TOOL_SCHEMAS[name], undefined, `${name} must not have an argument schema`)
  }
  const src = lib('email-agent/tools.ts')
  const executors = src.slice(src.indexOf('const EXECUTORS'), src.indexOf('// ── The gate'))
  for (const name of ['removeSuppression', 'raiseStageRecipientLimit', 'enableSafeAutoMode']) {
    assert.ok(!new RegExp(`^\\s+${name}:`, 'm').test(executors), `${name} must have no executor`)
  }
})

test('the executor checks policy before it checks anything else', () => {
  const src = lib('email-agent/tools.ts')
  const gate = src.slice(src.indexOf('export async function executeTool'))
  const policyAt = gate.indexOf('classify(toolName')
  const executorAt = gate.indexOf('const executor = EXECUTORS[toolName]')
  assert.ok(policyAt > 0 && policyAt < executorAt, 'policy must be consulted before an executor is selected')
})

test('read-only mode cannot reach a repair executor', () => {
  // The policy engine downgrades repairs to approval_required in read_only, and
  // the runner only executes when the mode is safe_auto. Both are required.
  const runner = lib('email-agent/runner.ts')
  assert.ok(/settings\.mode === 'safe_auto'/.test(runner), 'the runner must gate execution on safe_auto')
  assert.ok(/executeTool\(/.test(runner), 'and execution goes only through executeTool')
})

test('an approval-required tool without an approval becomes a REQUEST, not an execution', () => {
  const src = lib('email-agent/tools.ts')
  const gate = src.slice(src.indexOf("if (decision.classification === 'approval_required')"))
  assert.ok(/createApprovalRequest\(/.test(gate.slice(0, 900)), 'a missing approval must create a request')
  assert.ok(/status: 'refused'/.test(gate.slice(0, 1400)), 'and must not execute')
})

test('an approval is invalidated when the resource changed after it was reviewed', () => {
  // PREVENTS: approving "send to these 40 people", the audience being swapped,
  // and the old approval authorising the new send.
  const src = lib('email-agent/tools.ts')
  const fn = src.slice(src.indexOf('export async function validateApproval'))
  assert.ok(/resourceChecksum\(args\)/.test(fn), 'the checksum must be recomputed at execution time')
  assert.ok(/status: 'invalidated'/.test(fn), 'a drifted approval must be invalidated')
  assert.ok(/expiresAt <= now/.test(fn), 'an expired approval must be refused')
  assert.ok(/approval\.toolName !== toolName/.test(fn), 'an approval authorises ONE tool, not a category')
  assert.ok(/status !== 'approved'/.test(fn), 'a pending or rejected approval must not execute')
})

test('approvals expire, and quickly enough that a stale decision cannot act', () => {
  assert.ok(APPROVAL_TTL_MS <= 48 * 3600_000, 'an approval must not outlive the situation it was about')
  assert.ok(APPROVAL_TTL_MS >= 60 * 60_000, 'but must give a busy owner a realistic window')
})

test('the same repair against the same subject is idempotent within an hour', () => {
  assert.ok(IDEMPOTENCY_WINDOW_MS >= 30 * 60_000, 'the idempotency window must cover several cycles')
  const src = lib('email-agent/tools.ts')
  assert.ok(/idempotencyKey: \{ where/.test(src) || /findUnique\(\{ where: \{ idempotencyKey/.test(src), 'a repeat must be detected before execution')
  assert.ok(/skipped_idempotent/.test(src), 'and recorded as skipped rather than run twice')
})

test('the per-cycle action budget is enforced against the agent, not against a human', () => {
  const src = lib('email-agent/tools.ts')
  const gate = src.slice(src.indexOf('// ── GATE 5'))
  assert.ok(/actionsUsed >= ctx\.settings\.maxAutoActionsPerRun/.test(gate), 'the cap must be checked')
  assert.ok(/ctx\.actor === 'agent'/.test(gate), 'and must apply to the agent, so an owner is never rate-limited')
})

test('an action row is opened BEFORE the work and closed after', () => {
  // PREVENTS: a crash mid-action leaving no trace, or a failure being reported
  // as a success.
  const src = lib('email-agent/tools.ts')
  const gate = src.slice(src.indexOf('// ── The action record opens BEFORE the work'))
  assert.ok(gate.indexOf("status: 'started'") < gate.indexOf('await executor(args, ctx)'), 'the row must be written first')
  assert.ok(/status: 'failed'/.test(gate), 'a thrown executor must close the row as failed')
  assert.ok(/beforeState:/.test(gate) && /afterState:/.test(gate), 'both states must be recorded')
})

test('retrying a send refuses ambiguous and already-delivered outcomes', () => {
  // The single most dangerous automatic action, and its three guards.
  const src = lib('email-agent/tools.ts')
  const fn = src.slice(src.indexOf('retryTransientSendOnce: async'), src.indexOf('// ── Protective stops'))
  assert.ok(/already_delivered/.test(fn), 'a delivered message must never be resent')
  assert.ok(/refused: 'ambiguous'/.test(fn), 'an unknown outcome must never be resent')
  assert.ok(/attempts > 1/.test(fn), 'the agent gets ONE retry, not the whole budget')
})

test('reconciling counters never rewrites totalRecipients', () => {
  // totalRecipients is frozen at dispatch: it records what was CLAIMED, and
  // recomputing it from rows would erase the truth about the audience.
  const src = lib('email-agent/tools.ts')
  const fn = src.slice(src.indexOf('reconcileRunCounters: async'), src.indexOf('finalizeSettledRun: async'))
  assert.ok(!/totalRecipients:/.test(fn.slice(fn.indexOf('const after ='))), 'totalRecipients must not be written')
  assert.ok(/totalRecipientsUnchanged/.test(fn), 'and the record should say so explicitly')
})

test('finalising refuses a run that still has open recipients', () => {
  const src = lib('email-agent/tools.ts')
  const fn = src.slice(src.indexOf('finalizeSettledRun: async'), src.indexOf('releaseExpiredLock: async'))
  assert.ok(/not_settled/.test(fn), 'an unsettled run must not be closed')
  assert.ok(/finalizeRunIfDone\(runId\)/.test(fn), 'and closing must delegate to the production finaliser')
})

test('releasing a lock holds back anything with an unknown provider outcome', () => {
  const src = lib('email-agent/tools.ts')
  const fn = src.slice(src.indexOf('releaseExpiredLock: async'), src.indexOf('reprocessValidWebhookEvent: async'))
  assert.ok(/ambiguous/.test(fn), 'ambiguous sends must not be re-opened')
  assert.ok(/all_unresolved/.test(fn), 'and a fully-unresolved set must refuse outright')
})

// ── Alert deduplication ─────────────────────────────────────────────────

const alertBase = {
  severity: 'critical',
  created: false,
  escalated: false,
  needsApproval: false,
  mitigationFailed: false,
  lastAlertAt: new Date('2026-07-27T11:50:00Z'),
  lastAlertSeverity: 'critical',
  lastAlertScope: 1,
  affectedCount: 1,
  now: new Date('2026-07-27T12:00:00Z'),
  digestWarnings: true,
}

test('a NEW critical incident always alerts', () => {
  assert.equal(decideAlert({ ...alertBase, created: true }).send, true)
})

test('the SAME unchanged critical does not alert again inside the cooldown', () => {
  // PREVENTS: 288 identical pings a day, which is how a channel gets muted.
  assert.equal(decideAlert(alertBase).send, false)
})

test('an unchanged critical alerts again after the cooldown', () => {
  const later = new Date(alertBase.lastAlertAt.getTime() + CRITICAL_COOLDOWN_MS + 1000)
  assert.equal(decideAlert({ ...alertBase, now: later }).send, true)
})

test('a critical alerts again as soon as it gets WORSE', () => {
  assert.equal(decideAlert({ ...alertBase, affectedCount: 5 }).send, true, 'scope grew')
  assert.equal(decideAlert({ ...alertBase, lastAlertSeverity: 'warning' }).send, true, 'severity rose')
  assert.equal(decideAlert({ ...alertBase, mitigationFailed: true }).send, true, 'a mitigation failed')
  assert.equal(decideAlert({ ...alertBase, needsApproval: true }).send, true, 'a human is now needed')
})

test('warnings are digested and do not interrupt', () => {
  assert.equal(decideAlert({ ...alertBase, severity: 'warning', created: true }).send, false)
  assert.equal(decideAlert({ ...alertBase, severity: 'warning', created: true, digestWarnings: false }).send, true)
})

test('an alert always says what happened, whether the agent acted, and what to do', () => {
  const { title, lines } = formatIncidentAlert({
    reference: 'INC-2026-00014',
    severity: 'critical',
    title: 'Duplicate-send risk detected',
    summary: 'The scheduler attempted a second execution for a campaign that already has an active run.',
    probableCause: 'Two workers claimed the same campaign.',
    campaignNames: ['July Customer Update'],
    runIds: ['run_1'],
    actionTaken: 'Marketing dispatch was paused.',
    needsApproval: true,
    approvalReference: 'APR-2026-00003',
    recommendation: null,
    detectedAt: new Date('2026-07-27T18:58:00Z'),
  })
  const body = lines.map((l) => `${l.message} ${l.action ?? ''}`).join('\n')
  assert.match(title, /CRITICAL/)
  assert.match(body, /INC-2026-00014/)
  assert.match(body, /July Customer Update/)
  assert.match(body, /Automatic action: Marketing dispatch was paused/)
  assert.match(body, /HUMAN ACTION NEEDED/)
  assert.match(body, /APR-2026-00003/)
})

test('an alert states plainly when the agent did nothing', () => {
  const { lines } = formatIncidentAlert({
    reference: 'INC-1', severity: 'critical', title: 't', summary: 's', probableCause: null,
    campaignNames: [], runIds: [], actionTaken: null, needsApproval: false, approvalReference: null,
    recommendation: null, detectedAt: new Date(),
  })
  assert.ok(lines.some((l) => /Automatic action: none/.test(l.message)), 'silence about action is worse than saying none')
})

// ── Providers ───────────────────────────────────────────────────────────

test('both providers are constructible and carry sane defaults', () => {
  const openai = new OpenAiProvider({ apiKey: 'test-key' })
  assert.equal(openai.name, 'openai')
  assert.equal(openai.model, PROVIDER_DEFAULT_MODELS.openai)

  const deepseek = new DeepSeekProvider({ apiKey: 'test-key' })
  assert.equal(deepseek.name, 'deepseek')
  assert.equal(deepseek.model, PROVIDER_DEFAULT_MODELS.deepseek)
})

test('an explicit model overrides the provider default', () => {
  assert.equal(new OpenAiProvider({ apiKey: 'k', model: 'gpt-4o' }).model, 'gpt-4o')
  assert.equal(new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-reasoner' }).model, 'deepseek-reasoner')
})

test('deepseek-reasoner is detected as not supporting JSON mode', () => {
  // PREVENTS: the agent silently losing its investigator the day somebody
  // switches EMAIL_AGENT_MODEL to the reasoner, which rejects response_format.
  assert.equal(NO_JSON_MODE.test('deepseek-reasoner'), true)
  assert.equal(NO_JSON_MODE.test('deepseek-chat'), false)
})

test('a disabled provider answers rather than throwing', async () => {
  const result = await new DisabledProvider('no key').analyze()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.outcome, 'disabled')
})

test('JSON is extracted from a bare object, a fenced block, or surrounding prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('Here is my answer:\n{"a":1}\nHope that helps.'), { a: 1 })
})

test('unparseable output returns undefined instead of a guess', () => {
  // PREVENTS: a half-understood recommendation about customer email.
  assert.equal(extractJson('I cannot help with that.'), undefined)
  assert.equal(extractJson(''), undefined)
  assert.equal(extractJson('{ broken'), undefined)
})

test('a provider failure never throws — it returns a result object', () => {
  const src = readFileSync(resolve(__dirname, '../email-agent/providers/index.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export async function callOpenAiCompatible'))
  assert.ok(/catch \(err\)/.test(fn), 'transport errors must be caught')
  assert.ok(/outcome: aborted \? 'timeout' : 'error'/.test(fn), 'a timeout must be distinguishable from an error')
  assert.ok(/AbortController/.test(fn), 'a hung request must not hold the cycle open')
})

test('the provider validates against the schema before returning a decision', () => {
  const src = readFileSync(resolve(__dirname, '../email-agent/providers/index.ts'), 'utf8')
  assert.ok(/agentDecisionSchema\.safeParse/.test(src), 'output must be validated')
  assert.ok(/outcome: 'invalid_output'/.test(src), 'a non-conforming reply must be rejected, not patched')
})

test('there is AT MOST ONE fallback attempt, and no retry loop', () => {
  // PREVENTS: burning money re-asking a model that cannot answer. The spec
  // permits exactly one attempt against a DIFFERENT provider; it does not
  // permit a loop, and it does not permit re-asking the same provider.
  const src = lib('email-agent/investigator.ts')
  assert.ok(/FALLBACK_WORTHY/.test(src), 'fallback eligibility must be an explicit, named set')
  // Exactly two attemptCall sites: the primary and the single fallback.
  const attempts = src.match(/await attemptCall\(/g) ?? []
  assert.equal(attempts.length, 2, `expected exactly 2 attempt sites (primary + one fallback), found ${attempts.length}`)
  assert.ok(/THE LOOP STOPS HERE/.test(src), 'the terminal both-failed path must be explicit')
  // No while/for loop around the provider call.
  assert.ok(!/while\s*\([^)]*\)\s*\{[\s\S]{0,400}attemptCall/.test(src), 'the fallback must not be inside a loop')
})

test('fallback fires only for a BROKEN provider, never for an unwelcome answer', () => {
  // PREVENTS: doubling the bill to be told the same thing twice. A model that
  // answered correctly and recommended nothing is a SUCCESS.
  const src = lib('email-agent/investigator.ts')
  const set = src.slice(src.indexOf('const FALLBACK_WORTHY'), src.indexOf('type ProviderChoice'))
  for (const worthy of ['error', 'timeout', 'invalid_output']) {
    assert.ok(set.includes(`'${worthy}'`), `${worthy} must be fallback-worthy`)
  }
  assert.ok(!set.includes("'ok'"), 'a successful call must never trigger a fallback')
  assert.ok(!set.includes("'disabled'"), 'a disabled provider must not trigger a paid fallback')
})

test('the fallback is charged separately and recorded as a fallback', () => {
  const src = lib('email-agent/investigator.ts')
  assert.ok(/isFallback: args\.isFallback/.test(src), 'the model-call row must record that it was a fallback')
  assert.ok(/fallbackReason/.test(src), 'and why the primary failed')
  assert.ok(/attempt\.costUsd \+ \(second\.kind === 'budget' \? 0 : second\.costUsd\)/.test(src), 'both calls must be summed into the reported cost')
})

test('the fallback takes its OWN budget reservation', () => {
  // PREVENTS: a fallback slipping past a budget the primary already exhausted.
  const src = lib('email-agent/investigator.ts')
  const attempt = src.slice(src.indexOf('async function attemptCall'))
  assert.ok(/reserveModelCall\(/.test(attempt), 'every attempt reserves budget')
  assert.ok(/callsThisCycle: callsThisCycle \+ 1/.test(src), 'the fallback must count as the cycle\'s second call')
})

test('a model failure does not stop the deterministic checks', () => {
  const runner = lib('email-agent/runner.ts')
  const checksAt = runner.indexOf('await runHealthChecks(')
  const investigateAt = runner.indexOf('await investigate(')
  assert.ok(checksAt > 0 && checksAt < investigateAt, 'checks must complete before the AI is called')
  const incidentsAt = runner.indexOf('await reconcileIncidents(')
  assert.ok(incidentsAt < investigateAt, 'incidents must be recorded before the AI is called')
})

// ── Prompt safety ───────────────────────────────────────────────────────

const promptInput = (): AgentAnalysisInput => ({
  mode: 'read_only',
  stageRecipientLimit: 50,
  findings: [
    {
      id: 'f1', checkId: 'run.stuck_in_transition', severity: 'critical', category: 'run',
      title: 'A run is stuck', description: 'Run x has not moved in 3 hours.',
      evidence: { email: 'd***o@example.com', runStatus: 'SENDING' },
      runRefId: 'run_x', firstDetectedAt: '2026-07-27T09:00:00Z',
    },
  ],
  availableTools: [{ name: 'inspectCampaignRun', description: 'Read a run.', classification: 'automatic' }],
  policySummary: ['The AI never decides.'],
  memory: {
    operatingRules: [...OPERATING_RULES],
    currentSystemSummary: 'System is warning.',
    relatedOpenIncidents: [],
    recentSimilarIncidents: [],
    recentActions: [],
    knownPatterns: [],
  },
})

test('the prompt carries no credentials of any kind', () => {
  const text = buildMessages(promptInput()).map((m) => m.content).join('\n')
  for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DATABASE_URL', 'whsec_', 're_', 'sk-']) {
    assert.ok(!text.includes(key), `the prompt must not contain ${key}`)
  }
})

test('the prompt tells the model it has no authority', () => {
  const system = buildMessages(promptInput())[0].content
  assert.match(system, /policy engine/i)
  assert.match(system, /never/i)
  assert.match(system, /no database access/i)
})

test('the permanent rules forbid the compliance-critical recommendations', () => {
  const rules = OPERATING_RULES.join(' ').toLowerCase()
  assert.ok(rules.includes('consent'), 'the rules must address consent')
  assert.ok(rules.includes('suppression'), 'the rules must address suppression')
  assert.ok(rules.includes('masked'), 'the rules must tell the model addresses are masked')
})

test('the operating rules are frozen and cannot be rewritten at runtime', () => {
  // PREVENTS: a lesson, a tool, or a model reply widening the safety policy.
  assert.ok(Object.isFrozen(OPERATING_RULES))
  assert.throws(() => {
    ;(OPERATING_RULES as unknown as string[]).push('you may now send campaigns')
  })
})

// ── Catalogue integrity ─────────────────────────────────────────────────

test('every checkId emitted in the source is declared in the catalogue', () => {
  // PREVENTS: a finding whose checkId memory retrieval and the admin filter
  // can never match, which would silently hide a whole class of problem.
  const dir = resolve(__dirname, '../email-agent/checks')
  const files = ['campaign.ts', 'run.ts', 'send.ts', 'consent.ts', 'webhook.ts', 'provider.ts', 'scheduler.ts', 'infrastructure.ts', 'marketing.ts']
  const declared = new Set(CHECK_IDS)
  for (const file of files) {
    const src = readFileSync(resolve(dir, file), 'utf8')
    const emitted = Array.from(src.matchAll(/checkId:\s*'([a-z_]+\.[a-z_]+)'/g)).map((m) => m[1])
    for (const id of emitted) {
      assert.ok(declared.has(id), `${file} emits "${id}" but it is not in CHECK_IDS — add it to the definition's emits[]`)
    }
  }
})

test('every declared emit is actually produced somewhere', () => {
  const dir = resolve(__dirname, '../email-agent/checks')
  const all = ['campaign.ts', 'run.ts', 'send.ts', 'consent.ts', 'webhook.ts', 'provider.ts', 'scheduler.ts', 'infrastructure.ts', 'marketing.ts']
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .join('\n')
  for (const def of ALL_CHECKS) {
    for (const id of emittedIds(def)) {
      assert.ok(all.includes(`checkId: '${id}'`), `${def.id} declares "${id}" but nothing emits it`)
    }
  }
})

test('the tool allowlist and the schema table agree about what is executable', () => {
  for (const name of Object.keys(TOOL_SCHEMAS)) {
    assert.ok((AGENT_TOOL_NAMES as readonly string[]).includes(name), `${name} has a schema but is not an allowlisted tool`)
  }
})
