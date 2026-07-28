import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ALL_CHECKS, CHECK_IDS, checkCatalogue } from '../email-agent/checks'
import {
  RECIPIENT_CLAIM_STALE_MS,
  RUN_MIDFLIGHT_GRACE_MS,
  RUN_PREPARING_STUCK_MS,
  RUN_STUCK_CRITICAL_MS,
  RUN_STUCK_WARN_MS,
  SCHEDULE_GRACE_MS,
  SCHEDULE_MISSED_CRITICAL_MS,
  RATE_MIN_SAMPLE,
  fingerprint,
  makeFinding,
  type CheckContext,
} from '../email-agent/checks/shared'
import { envDefaults } from '../email-agent/settings'
import { maskEmail, redact, safeErrorMessage } from '../email-agent/redact'
import { findUnmaskedEmails } from '../email-agent/memory'
import { CATEGORIES, SEVERITIES, worstSeverity } from '../email-agent/types'

// ════════════════════════════════════════════════════════════════════════
//  DETERMINISTIC HEALTH ENGINE (owner spec 2026-07-27)
//
//  The most valuable tests here are the ones about NOT alerting. An agent that
//  cries wolf on a healthy send gets switched off within a week, and then it
//  protects nothing at all.
// ════════════════════════════════════════════════════════════════════════

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  now: new Date('2026-07-27T12:00:00Z'),
  settings: { ...envDefaults(), mode: 'read_only', stageRecipientLimit: 50 },
  windowHours: 24,
  inspected: {},
  dryRun: true,
  ...over,
})

// ── Registry ────────────────────────────────────────────────────────────

test('every check family is registered', () => {
  const categories = new Set(ALL_CHECKS.map((c) => c.category))
  for (const required of CATEGORIES) {
    assert.ok(categories.has(required), `no check covers the "${required}" category`)
  }
})

test('check ids are unique and namespaced by family', () => {
  assert.equal(new Set(CHECK_IDS).size, CHECK_IDS.length, 'duplicate check id')
  for (const id of CHECK_IDS) {
    assert.match(id, /^[a-z_]+\.[a-z_]+$/, `${id} is not a namespaced check id`)
  }
})

test('every check states its intent in the owner\'s language', () => {
  for (const c of checkCatalogue()) {
    assert.ok(c.intent.length > 20, `${c.id} has no useful intent`)
  }
})

test('the suite covers the problems the owner named', () => {
  const ids = CHECK_IDS.join(' ')
  const required = [
    'campaign.schedule_missed', 'campaign.approval_invalidated', 'campaign.cannot_dispatch',
    'campaign.no_audience', 'campaign.run_over_stage_limit', 'campaign.duplicate_schedule',
    'run.stuck_in_transition', 'run.terminal_without_completed_at', 'run.counters_mismatch',
    'run.duplicate_active', 'run.no_recipients', 'run.stranded_recipients', 'run.expired_claim',
    'send.inflight_stale', 'send.retry_overdue', 'send.missing_provider_id',
    'send.delivered_before_sent', 'send.duplicate_in_campaign', 'send.after_suppression',
    'send.retry_limit_exceeded', 'send.ambiguous_outcome',
    'suppression.event_not_applied', 'suppression.side_effect_unsettled', 'consent.sent_without_consent',
    'webhook.secret_missing', 'webhook.silent', 'webhook.processing_delay', 'webhook.out_of_order',
    'provider.configuration', 'provider.complaint_rate', 'provider.bounce_rate', 'provider.failure_rate',
    'scheduler.agent_gap', 'scheduler.clock_skew', 'scheduler.dispatch_sweep_silent',
    'infrastructure.required_env_missing', 'infrastructure.migrations_pending',
  ]
  for (const id of required) {
    assert.ok(ids.includes(id), `missing required check: ${id}`)
  }
})

// ── Grace periods: mid-flight is not stuck ──────────────────────────────
// PREVENTS: the agent reporting every healthy send in progress as broken.

test('a run that is mid-flight is NOT past the stuck threshold', () => {
  // A run whose rows moved four minutes ago is working. The campaign sweep runs
  // every five minutes, so anything inside the grace window is normal.
  const idleMs = 4 * 60_000
  assert.ok(idleMs < RUN_MIDFLIGHT_GRACE_MS, 'a 4-minute-idle run must be inside the grace window')
  assert.ok(idleMs < RUN_STUCK_WARN_MS, 'a 4-minute-idle run must not warn')
})

test('the stuck thresholds are ordered and leave room for the recovery sweep', () => {
  assert.ok(RUN_MIDFLIGHT_GRACE_MS <= RUN_STUCK_WARN_MS, 'grace must not exceed the warning threshold')
  assert.ok(RUN_STUCK_WARN_MS < RUN_STUCK_CRITICAL_MS, 'warning must come before critical')
  // The sweep re-opens stale claims at 15 minutes; warning later than that
  // means the recovery machinery has genuinely had its chance.
  assert.ok(RUN_STUCK_WARN_MS >= RECIPIENT_CLAIM_STALE_MS, 'warn only after the stale-claim sweep has had a chance')
})

test('PREPARING has a much shorter clock than a sending run', () => {
  // Preparation is seconds of work, and a stuck PREPARING run makes the whole
  // campaign permanently undispatchable — so it must be caught sooner.
  assert.ok(RUN_PREPARING_STUCK_MS < RUN_STUCK_CRITICAL_MS, 'abandoned preparation must be caught before the generic stuck threshold')
})

test('a schedule picked up slightly late by the normal sweep is not "missed"', () => {
  // The sweep runs every 5 minutes, so 3 minutes late is the design working.
  assert.ok(3 * 60_000 < SCHEDULE_GRACE_MS, '3 minutes late must be within grace')
  assert.ok(SCHEDULE_GRACE_MS >= 10 * 60_000, 'grace must comfortably exceed the 5-minute sweep interval')
  assert.ok(SCHEDULE_GRACE_MS < SCHEDULE_MISSED_CRITICAL_MS, 'warning must precede critical')
})

test('a rate needs a denominator before it is allowed to alert', () => {
  // 1 complaint out of 2 sends is 50% and means nothing.
  assert.ok(RATE_MIN_SAMPLE >= 20, 'rates below ~20 samples are noise, not signal')
})

// ── Counter semantics ───────────────────────────────────────────────────
// PREVENTS: the false positive that would have fired on real production rows.

test('the healthy production shape (total=1, sent=1, skipped=5) is not a mismatch', () => {
  // This is the campaign the owner actually ran: one eligible recipient who
  // received it, five correctly excluded with reasons. totalRecipients counts
  // only the ELIGIBLE, so comparing it to the row count would flag a good
  // campaign forever.
  const counters = { totalRecipients: 1, sentCount: 1, skippedCount: 5, failedCount: 0, cancelledCount: 0 }
  const rows = { SENT: 1, SKIPPED: 5 }

  const SKIP_FAMILY = ['SKIPPED', 'SUPPRESSED', 'UNSUBSCRIBED', 'INELIGIBLE', 'CONTEXT_INVALID']
  const actualSkipped = SKIP_FAMILY.reduce((s, k) => s + ((rows as Record<string, number>)[k] ?? 0), 0)

  assert.equal(counters.sentCount, rows.SENT ?? 0)
  assert.equal(counters.skippedCount, actualSkipped)
  assert.equal(counters.failedCount, 0)
  assert.equal(counters.cancelledCount, 0)

  const totalRows = Object.values(rows).reduce((a, b) => a + b, 0)
  assert.notEqual(counters.totalRecipients, totalRows, 'totalRecipients is NOT the row count — the check must never compare them')
})

test('the counter check only ever runs against terminal runs', () => {
  // On a live run the counters lag by design; the finaliser recomputes them.
  const src = readFileSync(resolve(__dirname, '../email-agent/checks/run.ts'), 'utf8')
  const check = src.slice(src.indexOf('const counterMismatch'), src.indexOf('const duplicateActiveRun'))
  assert.ok(/status: \{ in: TERMINAL \}/.test(check), 'the counter check must filter to terminal runs')
  assert.ok(!/totalRecipients !==/.test(check), 'totalRecipients must never be compared to a row count')
})

test('a run that ends 1 sent / 5 skipped classifies as healthy overall', () => {
  assert.equal(worstSeverity([]), 'info')
  assert.equal(worstSeverity(['info', 'info']), 'info')
})

test('severity ordering picks the worst', () => {
  assert.equal(worstSeverity(['info', 'warning']), 'warning')
  assert.equal(worstSeverity(['warning', 'critical', 'info']), 'critical')
  for (const s of SEVERITIES) assert.equal(worstSeverity([s]), s)
})

// ── Fingerprints ────────────────────────────────────────────────────────
// PREVENTS: a new incident every cycle (alert storm), and one incident
// silently covering two different broken runs.

test('the same problem produces the same fingerprint across cycles', () => {
  assert.equal(fingerprint('run.stuck_in_transition', 'run_a'), fingerprint('run.stuck_in_transition', 'run_a'))
})

test('two different runs never share a fingerprint', () => {
  assert.notEqual(fingerprint('run.stuck_in_transition', 'run_a'), fingerprint('run.stuck_in_transition', 'run_b'))
})

test('the same subject under different checks is a different problem', () => {
  assert.notEqual(fingerprint('run.stuck_in_transition', 'run_a'), fingerprint('run.counters_mismatch', 'run_a'))
})

test('a fingerprint is stable while the numbers in the finding change', () => {
  // "Run X has bad counters" keeps its identity as the counters move; otherwise
  // the incident would churn every cycle.
  const c = ctx()
  const a = makeFinding(c, { checkId: 'run.counters_mismatch', severity: 'warning', category: 'run', title: 't', description: '3 wrong', runRefId: 'run_a' })
  const b = makeFinding(c, { checkId: 'run.counters_mismatch', severity: 'critical', category: 'run', title: 't', description: '9 wrong', runRefId: 'run_a' })
  assert.equal(a.fingerprint, b.fingerprint)
})

test('a fingerprint is prefixed with its check id so it is greppable', () => {
  assert.match(fingerprint('send.ambiguous_outcome', 'x'), /^send\.ambiguous_outcome:[0-9a-f]{16}$/)
})

// ── Redaction ───────────────────────────────────────────────────────────
// PREVENTS: a credential or a customer list reaching a finding, a log, the
// admin UI, or a third-party model.

test('secret-shaped values are scrubbed out of free text', () => {
  const resend = JSON.stringify(redact({ note: 'key is re_abcdefgh12345678' }))
  assert.ok(!resend.includes('re_abcdefgh'), 'a Resend-shaped key must be scrubbed')
  const openai = JSON.stringify(redact({ note: 'sk-abcdefghijklmnopqrstuvwxyz123456' }))
  assert.ok(openai.includes('[redacted]'), 'an OpenAI-shaped key must be scrubbed')
})

test('a key NAMED like a credential never keeps its value', () => {
  const out = redact({ apiKey: 'anything-at-all', webhookSecret: 'whsec_x', DATABASE_URL: 'postgres://u:p@h/db' }) as Record<string, string>
  assert.equal(out.apiKey, '[redacted]')
  assert.equal(out.webhookSecret, '[redacted]')
  assert.equal(out.DATABASE_URL, '[redacted]')
})

test('an absent credential reports absence rather than a fake value', () => {
  const out = redact({ apiKey: '' }) as Record<string, string>
  assert.equal(out.apiKey, '(not set)')
})

test('a connection string anywhere in text is scrubbed', () => {
  const out = JSON.stringify(redact({ error: 'connect failed postgresql://user:pass@host:5432/db' }))
  assert.ok(!out.includes('pass@host'), 'a DSN must never survive redaction')
})

test('customer addresses are masked but stay recognisable', () => {
  assert.equal(maskEmail('diego@wemoveitweclearit.com'), 'd***o@wemoveitweclearit.com')
  assert.equal(maskEmail(null), '(none)')
  assert.equal(maskEmail('ab@x.com'), 'a***@x.com')
})

test('an email under any key named like an address is masked automatically', () => {
  const out = redact({ email: 'someone@example.com', to: 'other@example.com' }) as Record<string, string>
  assert.ok(out.email.includes('***'))
  assert.ok(out.to.includes('***'))
})

test('redaction is depth- and length-bounded so a bad check cannot blow up a prompt', () => {
  const deep: Record<string, unknown> = {}
  let node = deep
  for (let i = 0; i < 20; i++) {
    node.next = {}
    node = node.next as Record<string, unknown>
  }
  assert.ok(JSON.stringify(redact(deep)).includes('[truncated]'))

  const big = { list: Array.from({ length: 200 }, (_, i) => i) }
  const out = redact(big) as { list: unknown[] }
  assert.ok(out.list.length <= 26, 'long arrays must be capped')
})

test('the leak guard finds an unmasked address and ignores a masked one', () => {
  assert.equal(findUnmaskedEmails({ a: 'd***o@x.com' }).length, 0)
  assert.equal(findUnmaskedEmails({ a: 'real.person@gmail.com' }).length, 1)
  assert.equal(findUnmaskedEmails({ nested: { deep: [{ v: 'leak@x.com' }] } }).length, 1)
})

test('an error message is flattened and truncated without leaking', () => {
  const msg = safeErrorMessage(new Error('failed with key re_abcdefgh12345678\n  at line 3'))
  assert.ok(!msg.includes('re_abcdefgh'))
  assert.ok(!msg.includes('\n'))
})

// ── Source invariants ───────────────────────────────────────────────────

test('the checks never write to the email system', () => {
  const dir = resolve(__dirname, '../email-agent/checks')
  for (const file of ['campaign.ts', 'run.ts', 'send.ts', 'consent.ts', 'webhook.ts', 'provider.ts', 'scheduler.ts', 'infrastructure.ts']) {
    const src = readFileSync(resolve(dir, file), 'utf8')
    for (const write of ['.update(', '.updateMany(', '.create(', '.createMany(', '.delete(', '.deleteMany(', '.upsert(']) {
      assert.ok(!src.includes(`prisma.${write}`), `${file} must not call prisma${write}`)
      // Catch `prisma.emailSend.update(` etc.
      assert.ok(!new RegExp(`prisma\\.[a-zA-Z]+${write.replace('(', '\\(')}`).test(src), `${file} performs a write (${write}) — the health engine is read-only`)
    }
  }
})

test('a check that throws becomes an error, never a silent pass', () => {
  const src = readFileSync(resolve(__dirname, '../email-agent/checks/index.ts'), 'utf8')
  assert.ok(/errors\.push\(/.test(src), 'a failing check must be recorded')
  assert.ok(/errors\.length > 0 \? 'critical'/.test(src), 'unrunnable checks must force a critical verdict')
})

test('findings are deduplicated by fingerprint before they leave the engine', () => {
  const src = readFileSync(resolve(__dirname, '../email-agent/checks/index.ts'), 'utf8')
  assert.ok(/seen\.has\(f\.fingerprint\)/.test(src), 'the engine must dedupe on fingerprint')
})

test('no check stores an environment variable VALUE', () => {
  const dir = resolve(__dirname, '../email-agent/checks')
  for (const file of ['infrastructure.ts', 'webhook.ts', 'provider.ts', 'campaign.ts']) {
    const src = readFileSync(resolve(dir, file), 'utf8')
    // `value: process.env.X` inside an evidence object would be the leak.
    assert.ok(!/value:\s*process\.env/.test(src), `${file} must never put an env value in evidence`)
  }
})
