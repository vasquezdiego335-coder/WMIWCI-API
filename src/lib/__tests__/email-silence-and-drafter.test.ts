import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials } from './_disposable-test-env'

// ════════════════════════════════════════════════════════════════════════
//  Incident 2026-09-14 — "did the emails stop, or did the customers stop?"
//  ---------------------------------------------------------------------
//  Covers the demand-anchored silence checks, the discovery runtime truth
//  (flag on here is not proof the worker runs discovery), the ops-activity
//  digest lines and subject parity between the worker and i18n.
//
//  OFFLINE: a fake Prisma is installed on globalThis BEFORE any module that
//  imports db.ts is loaded, so no Postgres, Redis or provider is touched.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

type AnyFn = (...args: any[]) => any
const fake: Record<string, Record<string, AnyFn>> = {
  lead: { findMany: async () => [], findFirst: async () => null },
  emailSend: { count: async () => 0, findFirst: async () => null },
  auditLog: { findFirst: async () => null, findMany: async () => [] },
  booking: { findFirst: async () => null },
}
;(globalThis as any).prisma = fake

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

const NOW = new Date('2026-09-15T15:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const ago = (ms: number) => new Date(NOW.getTime() - ms)

function makeCtx(): any {
  return { now: NOW, settings: {} as any, windowHours: 24, inspected: {}, dryRun: false }
}

// ── 1. silenceVerdict ───────────────────────────────────────────────────
test('silenceVerdict: demand anchored, never raw volume', async () => {
  const { silenceVerdict } = await import('../email-agent/checks/send')
  assert.equal(silenceVerdict(0, 0), 'ok')
  assert.equal(silenceVerdict(0, 5), 'ok')
  assert.equal(silenceVerdict(1, 0), 'warning')
  assert.equal(silenceVerdict(2, 0), 'critical')
  assert.equal(silenceVerdict(5, 1), 'ok')
})

// ── 2. confirmationStallSeverity ────────────────────────────────────────
test('confirmationStallSeverity: boundaries are exclusive and thresholds ordered', async () => {
  const s = await import('../email-agent/checks/send')
  assert.equal(s.confirmationStallSeverity(null), null)
  assert.equal(s.confirmationStallSeverity(30 * MIN), null)
  assert.equal(s.confirmationStallSeverity(31 * MIN), 'warning')
  assert.equal(s.confirmationStallSeverity(2 * HOUR), 'warning')
  assert.equal(s.confirmationStallSeverity(2 * HOUR + 1), 'critical')
  // A stall nobody has touched for a day stops paging hourly: warning, not critical.
  assert.equal(s.confirmationStallSeverity(30 * HOUR, 25 * HOUR), 'warning')
  // ...but a fresh stall alongside an old one is still critical.
  assert.equal(s.confirmationStallSeverity(30 * HOUR, 3 * HOUR), 'critical')
  assert.ok(s.CONFIRMATION_STALL_MS < s.CONFIRMATION_STALL_CRITICAL_MS)
  assert.ok(s.CONFIRMATION_STALL_MS >= 10 * MIN)
})

// ── 3. CHECK_IDS ────────────────────────────────────────────────────────
test('CHECK_IDS includes the new send checks and every id is namespaced', async () => {
  const { CHECK_IDS } = await import('../email-agent/checks/index')
  assert.ok(CHECK_IDS.includes('send.confirmation_stalled'))
  assert.ok(CHECK_IDS.includes('send.silence_with_demand'))
  for (const id of CHECK_IDS) assert.match(id, /^[a-z_]+\.[a-z0-9_]+$/, `id not namespaced: ${id}`)
})

// ── 4. confirmation check against a fake database ───────────────────────
type World = { stalledQueuedAt: Date[]; demandCreatedAt: Date[]; delivered: number }

function installWorld(w: World): { calls: any[] } {
  const calls: any[] = []
  fake.lead.findMany = async (args: any) => {
    calls.push(args)
    const where = args.where
    if ('quoteConfirmationStatus' in where) {
      const r = where.quoteConfirmationQueuedAt
      return w.stalledQueuedAt
        .filter((d) => d.getTime() >= r.gte.getTime() && d.getTime() < r.lt.getTime())
        .sort((a, b) => a.getTime() - b.getTime())
        .map((d, i) => ({ id: `lead_stall_${i}`, quoteConfirmationQueuedAt: d }))
    }
    if ('createdAt' in where) {
      const r = where.createdAt
      return w.demandCreatedAt
        .filter((d) => d.getTime() >= r.gte.getTime() && d.getTime() < r.lt.getTime())
        .map((d, i) => ({ id: `lead_demand_${i}`, createdAt: d }))
    }
    throw new Error('unexpected lead.findMany shape')
  }
  fake.emailSend.count = async () => w.delivered
  return { calls }
}

async function runConfirmationCheck(w: World) {
  const { sendChecks } = await import('../email-agent/checks/send')
  const check = sendChecks.find((c) => c.id === 'send.confirmation_stalled')
  assert.ok(check, 'send.confirmation_stalled definition must exist')
  const { calls } = installWorld(w)
  const findings = await check.run(makeCtx())
  return { findings, calls }
}

function assertNoAddresses(findings: any[]) {
  for (const f of findings) {
    const ev = JSON.stringify(f.evidence)
    assert.ok(!ev.includes('@'), `evidence must not carry an address: ${ev}`)
    for (const l of (f.evidence.leads ?? []) as any[]) {
      assert.ok(typeof l.leadId === 'string')
      assert.ok(!('email' in l))
    }
  }
}

test('confirmation check: zero demand and zero sends is healthy', async () => {
  const { findings } = await runConfirmationCheck({ stalledQueuedAt: [], demandCreatedAt: [], delivered: 0 })
  assert.deepEqual(findings, [])
})

test('confirmation check: a confirmation queued 45 minutes ago is a warning', async () => {
  const { findings, calls } = await runConfirmationCheck({ stalledQueuedAt: [ago(45 * MIN)], demandCreatedAt: [], delivered: 0 })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].checkId, 'send.confirmation_stalled')
  assert.equal(findings[0].severity, 'warning')
  assert.equal((findings[0].evidence as any).leads[0].leadId, 'lead_stall_0')
  assertNoAddresses(findings)
  for (const c of calls) assert.ok(!c.select?.email, 'must never select the email column')
})

test('confirmation check: a confirmation queued 3 hours ago is critical', async () => {
  const { findings } = await runConfirmationCheck({ stalledQueuedAt: [ago(3 * HOUR), ago(40 * MIN)], demandCreatedAt: [], delivered: 0 })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].checkId, 'send.confirmation_stalled')
  assert.equal(findings[0].severity, 'critical')
  assertNoAddresses(findings)
})

test('confirmation check: a confirmation queued 10 minutes ago is still in flight', async () => {
  const { findings } = await runConfirmationCheck({ stalledQueuedAt: [ago(10 * MIN)], demandCreatedAt: [], delivered: 0 })
  assert.deepEqual(findings, [])
})

test('confirmation check: 1 demand lead and nothing delivered is a silence warning', async () => {
  const { findings } = await runConfirmationCheck({ stalledQueuedAt: [], demandCreatedAt: [ago(5 * HOUR)], delivered: 0 })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].checkId, 'send.silence_with_demand')
  assert.equal(findings[0].severity, 'warning')
  assert.equal((findings[0].evidence as any).demand, 1)
  assertNoAddresses(findings)
})

test('confirmation check: 2 demand leads and nothing delivered is critical', async () => {
  const { findings } = await runConfirmationCheck({ stalledQueuedAt: [], demandCreatedAt: [ago(5 * HOUR), ago(20 * HOUR)], delivered: 0 })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].checkId, 'send.silence_with_demand')
  assert.equal(findings[0].severity, 'critical')
  assertNoAddresses(findings)
})

test('confirmation check: 2 demand leads with one delivery is healthy', async () => {
  const { findings } = await runConfirmationCheck({ stalledQueuedAt: [], demandCreatedAt: [ago(5 * HOUR), ago(20 * HOUR)], delivered: 1 })
  assert.deepEqual(findings, [])
})

// ── 5. structural: no email column selected ─────────────────────────────
test('confirmationStalled source never selects an email column', () => {
  const src = read('src/lib/email-agent/checks/send.ts')
  const start = src.indexOf('const confirmationStalled: CheckDefinition')
  assert.ok(start > -1)
  const end = src.indexOf('export const sendChecks', start)
  assert.ok(end > start)
  const block = src.slice(start, end)
  assert.ok(!/email:\s*true/.test(block), 'confirmationStalled must not select email')
})

// ── 6. discoveryRuntimeState ────────────────────────────────────────────
test('discoveryRuntimeState: off / not_running / active — the shared ledger outranks this process\'s flag', async () => {
  const { discoveryRuntimeState } = await import('../email-marketing-agent')
  assert.equal(discoveryRuntimeState({ enabled: false, lastSweepAt: null, now: NOW }), 'off')
  assert.equal(discoveryRuntimeState({ enabled: false, lastSweepAt: ago(40 * HOUR), now: NOW }), 'off')
  // Flag off on the API, on on the worker, which is sweeping: that is ACTIVE, not OFF.
  assert.equal(discoveryRuntimeState({ enabled: false, lastSweepAt: ago(1 * HOUR), now: NOW }), 'active')
  // ...unless the worker has skipped since that sweep.
  assert.equal(discoveryRuntimeState({ enabled: false, lastSweepAt: ago(20 * HOUR), lastSkipAt: ago(1 * HOUR), now: NOW }), 'off')
  assert.equal(discoveryRuntimeState({ enabled: true, lastSweepAt: null, now: NOW }), 'not_running')
  assert.equal(discoveryRuntimeState({ enabled: true, lastSweepAt: ago(10 * HOUR), now: NOW }), 'active')
  assert.equal(discoveryRuntimeState({ enabled: true, lastSweepAt: ago(10 * HOUR), lastSkipAt: ago(1 * HOUR), now: NOW }), 'not_running')
  assert.equal(discoveryRuntimeState({ enabled: true, lastSweepAt: ago(37 * HOUR), now: NOW }), 'not_running')
})

// ── 7. marketing.discovery_stale never-ran branch ───────────────────────
async function runDiscoveryStale(
  flag: string | undefined,
  uptimeSec: number,
  ledger: { sweepAt?: Date; skip?: { at: Date; service: string; reason: string } } = {}
) {
  const prev = process.env.EMAIL_MARKETING_AGENT_ENABLED
  if (flag === undefined) delete process.env.EMAIL_MARKETING_AGENT_ENABLED
  else process.env.EMAIL_MARKETING_AGENT_ENABLED = flag
  fake.auditLog.findFirst = (async (args: any) => {
    const event = args?.where?.details?.equals
    if (event === 'discovery_sweep' && ledger.sweepAt) return { createdAt: ledger.sweepAt, details: {} }
    if (event === 'discovery_skipped' && ledger.skip) {
      return { createdAt: ledger.skip.at, details: { event, reason: ledger.skip.reason, service: ledger.skip.service } }
    }
    return null
  }) as any
  const up = mock.method(process, 'uptime', () => uptimeSec)
  try {
    const { marketingChecks } = await import('../email-agent/checks/marketing')
    const check = marketingChecks.find((c) => c.id === 'marketing.discovery_stale')
    assert.ok(check)
    return await check.run(makeCtx())
  } finally {
    up.mock.restore()
    if (prev === undefined) delete process.env.EMAIL_MARKETING_AGENT_ENABLED
    else process.env.EMAIL_MARKETING_AGENT_ENABLED = prev
  }
}

test('marketing.discovery_stale: enabled, never swept, up 40h → never-run warning', async () => {
  const findings = await runDiscoveryStale('true', 40 * 3600)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].checkId, 'marketing.discovery_stale')
  assert.equal(findings[0].severity, 'warning')
  assert.match(findings[0].title, /never run/i)
})

test('marketing.discovery_stale: enabled, never swept, up 1h → fresh enablement, no finding', async () => {
  assert.deepEqual(await runDiscoveryStale('true', 3600), [])
})

test('marketing.discovery_stale: flag unset → no finding', async () => {
  assert.deepEqual(await runDiscoveryStale(undefined, 40 * 3600), [])
})

test('marketing.discovery_stale: the 2026-09-14 split (on here, skipped by the worker) is caught at ANY uptime', async () => {
  const findings = await runDiscoveryStale('true', 60, { skip: { at: ago(2 * HOUR), service: 'discord workers', reason: 'disabled' } })
  assert.equal(findings.length, 1)
  assert.match(findings[0].title, /skipped where it runs/)
  assert.equal((findings[0].evidence as any).skippedBy, 'discord workers')
})

test('marketing.discovery_stale: a skip OLDER than a recent sweep is history, not a finding', async () => {
  const findings = await runDiscoveryStale('true', 60, { sweepAt: ago(1 * HOUR), skip: { at: ago(30 * HOUR), service: 'discord workers', reason: 'disabled' } })
  assert.deepEqual(findings, [])
})

test('the runner never auto-resolves a discovery incident from a process that has the flag off', () => {
  const runner = read('src/lib/email-agent/runner.ts')
  assert.ok(runner.includes("unobservableCheckIds: marketingAgentEnabled() ? [] : ['marketing.discovery_stale']"))
  const inc = read('src/lib/email-agent/incidents.ts')
  assert.ok(inc.includes('unobservable.indexOf(f.checkId) !== -1)) continue'))
})

// ── 8. discoverCampaignOpportunities with the flag off ──────────────────
function throwingDeps(): any {
  const boom = async () => {
    throw new Error('disabled discovery must not touch deps')
  }
  return {
    now: () => NOW,
    preview: boom,
    recentAgentCampaign: boom,
    lastNotification: boom,
    draftCopy: boom,
    createDraft: boom,
    postDiscord: boom,
    recordNotification: boom,
    recordSweep: boom,
  }
}

test('discoverCampaignOpportunities: flag unset records exactly one skip', async () => {
  const prev = process.env.EMAIL_MARKETING_AGENT_ENABLED
  delete process.env.EMAIL_MARKETING_AGENT_ENABLED
  try {
    const { discoverCampaignOpportunities } = await import('../email-marketing-agent')
    const skips: string[] = []
    const deps = { ...throwingDeps(), recordSkip: async (r: string) => void skips.push(r) }
    const report = await discoverCampaignOpportunities(deps)
    assert.equal(report.ran, false)
    assert.equal(report.reason, 'disabled')
    assert.equal(report.created, null)
    assert.deepEqual(skips, ['disabled'])

    const report2 = await discoverCampaignOpportunities(throwingDeps())
    assert.equal(report2.ran, false)
    assert.equal(report2.reason, 'disabled')
    assert.deepEqual(report2, report)
  } finally {
    if (prev !== undefined) process.env.EMAIL_MARKETING_AGENT_ENABLED = prev
  }
})

// ── 9. campaigns page renders runtime truth ─────────────────────────────
test('campaigns page: ACTIVE is tied to runtimeState, never agent.enabled alone', () => {
  const src = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/page.tsx')
  assert.ok(src.includes('ENABLED — NOT RUNNING'))
  assert.ok(src.includes("agent.runtimeState === 'not_running'"))
  // The ACTIVE label must be the consequent of a runtimeState === 'active' test.
  assert.ok(/runtimeState === 'active' \? 'ACTIVE'/.test(src), "ACTIVE must be rendered only when runtimeState === 'active'")
  assert.ok(!/agent\.enabled\s*\?\s*'ACTIVE'/.test(src), 'ACTIVE must never be chosen from agent.enabled')
  // Every quoted 'ACTIVE' label (outside campaign status comparisons) is runtime-gated.
  const labels = [...src.matchAll(/\?\s*'ACTIVE'/g)]
  for (const m of labels) {
    const before = src.slice(Math.max(0, m.index! - 40), m.index!)
    assert.ok(before.includes("runtimeState === 'active'"), `ungated ACTIVE label near: ${before}`)
  }
})

// ── 10. ops-activity ────────────────────────────────────────────────────
test('ops-activity formatAge buckets', async () => {
  const { formatAge } = await import('../ops-activity')
  assert.equal(formatAge(null, NOW), 'never')
  assert.equal(formatAge(ago(5 * MIN), NOW), '5m ago')
  assert.equal(formatAge(ago(3 * HOUR), NOW), '3h ago')
  assert.equal(formatAge(ago(50 * HOUR), NOW), '2d ago')
})

test('ops-activity activityLines: four lines, fixed order, no addresses', async () => {
  const { activityLines } = await import('../ops-activity')
  const lines = activityLines(
    { lastQuickQuoteLeadAt: ago(2 * HOUR), lastPartialLeadAt: null, lastRealEmailAt: ago(50 * HOUR), lastBookingAt: ago(5 * MIN) },
    NOW
  )
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^Last quick-quote lead: 2h ago/)
  assert.match(lines[1], /^Last partial lead: never/)
  assert.match(lines[2], /^Last real email sent: 2d ago/)
  assert.match(lines[3], /^Last booking: 5m ago/)
  for (const l of lines) assert.ok(!l.includes('@'))
})

// ── 11. subject parity worker ↔ i18n ────────────────────────────────────
function parseWorkerSubjects(): Record<string, string> {
  const src = read('src/workers/email.worker.ts')
  const start = src.indexOf('export const SUBJECTS')
  assert.ok(start > -1, 'SUBJECTS must exist in the worker')
  const open = src.indexOf('{', src.indexOf('=', start))
  const close = src.indexOf('\n}', open)
  const body = src.slice(open + 1, close)
  const out: Record<string, string> = {}
  const re = /'([a-z0-9-]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
  for (const m of body.matchAll(re)) out[m[1]] = (m[2] ?? m[3]).replace(/\\(.)/g, '$1')
  return out
}

test('subject parity: every worker template has an identical English i18n subject', async () => {
  const subjects = parseWorkerSubjects()
  const keys = Object.keys(subjects)
  assert.ok(keys.length >= 20, `parsed only ${keys.length} subjects`)
  assert.ok(keys.includes('quote-followup-1'))
  const { EMAIL_SUBJECTS } = await import('../i18n')
  for (const k of keys) {
    assert.ok(EMAIL_SUBJECTS[k], `EMAIL_SUBJECTS missing ${k}`)
    assert.equal(EMAIL_SUBJECTS[k].en, subjects[k], `English subject drift for ${k}`)
  }
})

test('localizedSubject: known template returns its subject, unknown returns null', async () => {
  const { localizedSubject, BIZ_NAME } = await import('../i18n')
  const s = localizedSubject('quote-followup-1', 'en')
  assert.equal(s, 'Did your quote come through?')
  assert.notEqual(s, BIZ_NAME, 'never the bare business name')
  assert.equal(localizedSubject('unknown-template'), null)
})
