import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSystemSummary, lessonConfidence } from '../email-agent/memory'
import { STALE_INCIDENT_MS } from '../email-agent/incidents'
import { OPEN_INCIDENT_STATUSES, INCIDENT_STATUSES } from '../email-agent/types'

// ════════════════════════════════════════════════════════════════════════
//  MEMORY + INCIDENT MANAGEMENT (owner spec 2026-07-27)
//
//  Two failure modes these tests exist to prevent:
//    • the agent forgetting, so it re-investigates the same problem forever
//      and the owner gets the same alert 288 times a day;
//    • the agent remembering too much, so a stale conclusion outvotes fresh
//      evidence, or a customer list travels to a third-party model.
// ════════════════════════════════════════════════════════════════════════

const lib = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')

// ── Lesson confidence ───────────────────────────────────────────────────

test('a pattern seen once is never trusted highly, however right it was', () => {
  // PREVENTS: a single coincidence becoming an authoritative "lesson".
  assert.ok(lessonConfidence(1, 0) <= 0.55, 'one observation is an anecdote')
})

test('confidence rises with repeated confirmation', () => {
  const one = lessonConfidence(1, 0)
  const five = lessonConfidence(5, 0)
  const ten = lessonConfidence(10, 0)
  assert.ok(five > one)
  assert.ok(ten > five)
})

test('confidence falls when a pattern turns out to be a false positive', () => {
  assert.ok(lessonConfidence(10, 5) < lessonConfidence(10, 0))
  assert.ok(lessonConfidence(10, 9) < lessonConfidence(10, 5))
})

test('confidence never reaches certainty and never reaches zero', () => {
  // A lesson is experience, not a rule; and a pattern that was always wrong is
  // still worth showing so the model can recognise it as a known non-problem.
  for (const [occ, fp] of [[1, 0], [100, 0], [100, 100], [1, 1], [0, 0]] as const) {
    const c = lessonConfidence(occ, fp)
    assert.ok(c >= 0.05 && c <= 0.95, `confidence ${c} out of bounds for ${occ}/${fp}`)
  }
})

test('a repeated incident updates ONE lesson rather than accumulating duplicates', () => {
  const src = lib('email-agent/memory.ts')
  assert.ok(/findUnique\(\{ where: \{ patternKey/.test(src), 'patternKey must be looked up before creating')
  assert.ok(/occurrences: existing\.occurrences \+ 1/.test(src) || /const occurrences = existing\.occurrences \+ 1/.test(src), 'a repeat must increment, not insert')
})

// ── Retrieval scope ─────────────────────────────────────────────────────

test('memory is retrieved by RELEVANCE, not by dumping history', () => {
  // PREVENTS: an unbounded prompt, and a three-week-old conclusion outvoting
  // the evidence in front of the model right now.
  const src = lib('email-agent/memory.ts')
  const fn = src.slice(src.indexOf('export async function buildMemoryBundle'))
  assert.ok(/fingerprint: \{ in: fingerprints \}/.test(fn), 'must scope by the current findings\' fingerprints')
  assert.ok(/checkId: \{ in: checkIds \}/.test(fn), 'must scope by the current check ids')
  assert.ok(/campaignId: \{ in: campaignIds \}/.test(fn), 'must scope by the affected campaigns')
})

test('every memory list is capped so the prompt has a ceiling', () => {
  const src = lib('email-agent/memory.ts')
  for (const cap of ['MAX_OPEN_INCIDENTS', 'MAX_SIMILAR_INCIDENTS', 'MAX_RECENT_ACTIONS', 'MAX_PATTERNS']) {
    assert.ok(src.includes(cap), `${cap} must exist`)
    assert.ok(new RegExp(`take: ${cap}`).test(src), `${cap} must actually be applied as a take`)
  }
})

test('memory retrieval failing degrades the investigation but never stops the cycle', () => {
  const src = lib('email-agent/memory.ts')
  const fn = src.slice(src.indexOf('export async function buildMemoryBundle'))
  assert.ok(/catch \(err\)/.test(fn), 'retrieval must catch')
  assert.ok(/Memory retrieval failed/.test(fn), 'and must SAY it failed rather than pretending there was no history')
})

test('memory carries ids and sentences, never customer records', () => {
  // PREVENTS: unrelated personal information travelling to an AI provider.
  const src = lib('email-agent/memory.ts')
  const fn = src.slice(src.indexOf('export async function buildMemoryBundle'))
  for (const model of ['prisma.customer', 'prisma.lead', 'prisma.booking', 'prisma.emailSend', 'prisma.emailCampaignRecipient']) {
    assert.ok(!fn.includes(model), `memory retrieval must not read ${model}`)
  }
})

test('the recent-actions memory exposes only a subject id, not the row', () => {
  const src = lib('email-agent/memory.ts')
  assert.ok(/subject: a\.campaignId \?\? a\.runRefId \?\? a\.sendId \?\? null/.test(src), 'actions are summarised to an id')
})

// ── System summary ──────────────────────────────────────────────────────

test('the system summary states the mode and whether sending is paused', () => {
  const summary = buildSystemSummary({
    overallStatus: 'critical', findingCount: 3, criticalCount: 1, warningCount: 2,
    openIncidents: 2, pendingApprovals: 1, mode: 'read_only', dispatchPaused: true,
  })
  assert.match(summary, /critical/)
  assert.match(summary, /read_only/)
  assert.match(summary, /PAUSED/)
  assert.match(summary, /1 approval/)
})

test('the summary says dispatch is active when it is', () => {
  const summary = buildSystemSummary({
    overallStatus: 'healthy', findingCount: 0, criticalCount: 0, warningCount: 0,
    openIncidents: 0, pendingApprovals: 0, mode: 'safe_auto', dispatchPaused: false,
  })
  assert.match(summary, /Marketing dispatch is active/)
  assert.ok(!/approval/.test(summary), 'no approvals means the sentence is omitted, not zeroed')
})

// ── Incident lifecycle ──────────────────────────────────────────────────

test('the open statuses are the ones that mean "still a live problem"', () => {
  assert.deepEqual([...OPEN_INCIDENT_STATUSES].sort(), ['awaiting_approval', 'investigating', 'mitigated', 'open'])
  for (const closed of ['resolved', 'ignored']) {
    assert.ok(!OPEN_INCIDENT_STATUSES.includes(closed as never), `${closed} must not count as open`)
  }
  for (const s of OPEN_INCIDENT_STATUSES) {
    assert.ok((INCIDENT_STATUSES as readonly string[]).includes(s), `${s} must be a real status`)
  }
})

test('a repeated detection updates the existing incident instead of opening a new one', () => {
  // PREVENTS: one alert per cycle for one unchanged problem.
  const src = lib('email-agent/incidents.ts')
  const fn = src.slice(src.indexOf('export async function reconcileIncidents'))
  assert.ok(/findFirst\(\{[\s\S]{0,400}fingerprint: \{ in: fingerprints \}/.test(fn), 'an existing open incident must be looked up by fingerprint')
  assert.ok(/detectionCount: \{ increment: 1 \}/.test(fn), 'a repeat increments the detection count')
})

test('related findings about one campaign collapse into a single incident', () => {
  // A missed schedule and a stale approval on the same campaign are one story.
  const src = lib('email-agent/incidents.ts')
  assert.ok(/const subject = f\.campaignId \?\? f\.runRefId \?\? null/.test(src), 'grouping must key on the subject first')
  assert.ok(/RELATED_CATEGORIES/.test(src), 'and only merge related categories')
})

test('severity only ever RISES from a re-detection', () => {
  // PREVENTS: one quiet cycle downgrading a critical and silencing the alert.
  const src = lib('email-agent/incidents.ts')
  assert.ok(/severity: severityRose \? severity : existing\.severity/.test(src), 'severity must not fall on re-detection')
})

test('escalation is narrow — being still true is not news', () => {
  const src = lib('email-agent/incidents.ts')
  const fn = src.slice(src.indexOf('// ── ESCALATION'))
  assert.ok(/severityRose/.test(fn), 'severity rising escalates')
  assert.ok(/scopeGrew/.test(fn), 'scope growing escalates')
  assert.ok(/stale && !wasStaleBefore/.test(fn), 'being unresolved too long escalates ONCE, not every cycle')
})

test('an unresolved incident escalates after hours, not minutes', () => {
  assert.ok(STALE_INCIDENT_MS >= 60 * 60_000, 'escalating within the hour would be noise')
  assert.ok(STALE_INCIDENT_MS <= 24 * 60 * 60_000, 'but a full day of silence is too long for a critical')
})

test('an incident awaiting a human decision is never auto-resolved', () => {
  // PREVENTS: a compliance question quietly closing itself because the check
  // window moved on while the owner was driving.
  const src = lib('email-agent/incidents.ts')
  const fn = src.slice(src.indexOf('export async function autoResolveAbsent'))
  const statuses = fn.slice(0, fn.indexOf('select:'))
  assert.ok(!statuses.includes('awaiting_approval'), 'awaiting_approval must be excluded from auto-resolution')
  assert.ok(statuses.includes("'open'"), 'plain open incidents may auto-resolve')
})

test('an incident that cannot be recorded does not take the cycle down', () => {
  const src = lib('email-agent/incidents.ts')
  const fn = src.slice(src.indexOf('export async function reconcileIncidents'))
  assert.ok(/catch \(err\)/.test(fn), 'per-group failures must be caught so the other groups still process')
})

test('the incident timeline is append-only', () => {
  // PREVENTS: history being rewritten to make a report look clean.
  const src = lib('email-agent/incidents.ts')
  assert.ok(/emailAgentIncidentEvent\.create/.test(src), 'timeline entries are created')
  assert.ok(!/emailAgentIncidentEvent\.(update|delete|deleteMany)/.test(src), 'and never edited or deleted')
})

// ── Audit history survives its subject ──────────────────────────────────

test('agent tables hold NO foreign key to campaigns, sends or users', () => {
  // PREVENTS: deleting a campaign cascading away the record of what the agent
  // did about it. Retained identifiers are plain strings on purpose.
  const migration = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260727120000_email_ops_agent/migration.sql'),
    'utf8'
  )
  const fks = Array.from(migration.matchAll(/ADD CONSTRAINT "[^"]+" FOREIGN KEY \("[^"]+"\) REFERENCES "([^"]+)"/g)).map((m) => m[1])
  for (const target of fks) {
    assert.ok(target.startsWith('email_agent_'), `agent tables must not reference ${target}`)
  }
  assert.ok(fks.length > 0, 'the migration should still have internal foreign keys')
})

test('the agent migration is purely additive', () => {
  // PREVENTS: a monitoring feature altering or dropping production email tables.
  const migration = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260727120000_email_ops_agent/migration.sql'),
    'utf8'
  )
  const statements = migration
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
  for (const line of statements) {
    if (!/^(CREATE|ALTER|DROP|DELETE|UPDATE|INSERT|TRUNCATE)/i.test(line)) continue
    // The only ALTERs allowed are the agent's own internal foreign keys.
    if (/^ALTER TABLE "email_agent_/i.test(line)) continue
    assert.ok(/^CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(line), `unexpected non-additive statement: ${line.slice(0, 120)}`)
    assert.ok(/"email_agent_/.test(line), `statement touches a non-agent table: ${line.slice(0, 120)}`)
  }
})

test('the agent never deletes its own history', () => {
  const files = ['email-agent/tools.ts', 'email-agent/incidents.ts', 'email-agent/memory.ts', 'email-agent/runner.ts']
  const src = files.map((f) => lib(f)).join('\n')
  for (const model of ['emailAgentAction', 'emailAgentFinding', 'emailAgentIncident', 'emailAgentRun', 'emailAgentModelCall']) {
    assert.ok(!new RegExp(`${model}\\.delete`).test(src), `${model} history must never be deleted`)
  }
})
