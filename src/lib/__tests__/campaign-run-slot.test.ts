import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials } from './_disposable-test-env'
import { UNFINISHED_RUN_STATES, RUN_SLOT_INDEX } from '../email-campaign-run'
import { claimCampaignRunSlot } from '../email-campaign-dispatch'

// ════════════════════════════════════════════════════════════════════════
//  ONE UNFINISHED RUN PER CAMPAIGN — offline half (2026-09-15)
//
//  dispatchCampaign used to check for an unfinished run, do unlocked work, then
//  create one. Two concurrent dispatches (an admin double-click and the sweep)
//  could each create a run, and because the idempotency key is per RUN, every
//  recipient could be emailed twice. The fix is a per-campaign advisory lock
//  plus a partial unique index. This file pins the SQL, the claim function's
//  branches (with a fake transaction) and the source ordering; the real race
//  runs against Postgres in campaign-run-concurrency.test.ts.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

const root = resolve(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')
const stripSqlComments = (sql: string) => sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n')
const code = (t: string) =>
  t.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*') }).join('\n')

function migrationSql(suffix: string): string {
  const dir = readdirSync(resolve(root, 'prisma', 'migrations')).find((d) => d.endsWith(suffix))
  assert.ok(dir, `migration *${suffix} must exist`)
  return read(`prisma/migrations/${dir}/migration.sql`)
}

// ── The migration ───────────────────────────────────────────────────────

test('migration predicate equals UNFINISHED_RUN_STATES exactly', () => {
  const sql = stripSqlComments(migrationSql('_campaign_run_single_unfinished'))
  const m = /CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_runs_one_unfinished_per_campaign"\s+ON "email_campaign_runs" \("campaign_id"\)\s+WHERE "status" IN \(([^)]*)\)/.exec(sql)
  assert.ok(m, 'the partial unique index statement must be present')
  const literals = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  assert.deepEqual(literals, [...UNFINISHED_RUN_STATES], 'the SQL literals must be the application list, in order')
  assert.ok(sql.includes(RUN_SLOT_INDEX))
})

test('the run-slot migration is a single additive statement — no CONCURRENTLY, no data writes', () => {
  const sql = stripSqlComments(migrationSql('_campaign_run_single_unfinished'))
  assert.ok(!/CONCURRENTLY/i.test(sql), 'a failed concurrent build leaves an INVALID index IF NOT EXISTS would accept')
  for (const kw of ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${kw}\\b`, 'i').test(sql), `migration must not ${kw}`)
  }
  const header = migrationSql('_campaign_run_single_unfinished')
  assert.match(header, /Rollback: DROP INDEX IF EXISTS "email_campaign_runs_one_unfinished_per_campaign";/)
  assert.match(header, /migrate resolve --rolled-back 20260915120000_campaign_run_single_unfinished/, 'the failure runbook must be in the file')
})

test('the index is deliberately NOT in schema.prisma (a @@unique would forbid a second finished run)', () => {
  const schema = read('prisma/schema.prisma')
  const model = schema.slice(schema.indexOf('model EmailCampaignRun {'), schema.indexOf('model EmailCampaignRecipient {'))
  assert.ok(!/@@unique\(\[campaignId\]\)/.test(model))
})

test('the recipient retry migration is additive and matches the Prisma model', () => {
  const sql = stripSqlComments(migrationSql('_campaign_recipient_transient_retry'))
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP\(3\);/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "transient_attempts" INTEGER NOT NULL DEFAULT 0;/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "email_campaign_recipients_status_next_attempt_at_idx"\s+ON "email_campaign_recipients" \("status", "next_attempt_at"\);/)
  for (const kw of ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${kw}\\b`, 'i').test(sql), `migration must not ${kw}`)
  }
  const schema = read('prisma/schema.prisma')
  const model = schema.slice(schema.indexOf('model EmailCampaignRecipient {'))
  const body = model.slice(0, model.indexOf('\n}'))
  assert.match(body, /nextAttemptAt\s+DateTime\?\s+@map\("next_attempt_at"\)/)
  assert.match(body, /transientAttempts Int\s+@default\(0\) @map\("transient_attempts"\)/)
  assert.match(body, /@@index\(\[status, nextAttemptAt\]\)/)
})

test('the production preflight exists and is read-only', () => {
  const sql = read('scripts/campaign-run-duplicate-preflight.sql')
  const body = stripSqlComments(sql)
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE', 'TRUNCATE', 'GRANT']) {
    assert.ok(!new RegExp(`\\b${kw}\\b`, 'i').test(body), `preflight must not ${kw}`)
  }
  assert.match(body, /HAVING COUNT\(\*\) > 1/)
  assert.match(body, /indisvalid/, 'an INVALID same-named index must be visible')
  assert.match(body, /indisunique/)
})

// ── claimCampaignRunSlot branches (fake transaction) ────────────────────

type Call = { op: string; args?: unknown }

function fakeDb(opts: {
  existingInTx?: { id: string; totalRecipients: number; status: string } | null
  createThrows?: unknown
  txThrows?: unknown
  existingOutside?: { id: string; totalRecipients: number; status: string } | null
}) {
  const calls: Call[] = []
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ op: 'lock', args: { sql: strings.join('?'), values } })
      return 0
    },
    emailCampaignRun: {
      findFirst: async (args: unknown) => {
        calls.push({ op: 'tx.findFirst', args })
        return opts.existingInTx ?? null
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ op: 'tx.create', args })
        if (opts.createThrows) throw opts.createThrows
        return { id: 'run_new' }
      },
    },
  }
  const db = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>, options: unknown) => {
      calls.push({ op: 'transaction', args: options })
      if (opts.txThrows) throw opts.txThrows
      return fn(tx)
    },
    emailCampaignRun: {
      findFirst: async (args: unknown) => {
        calls.push({ op: 'outside.findFirst', args })
        return opts.existingOutside ?? null
      },
    },
  }
  return { db: db as never, calls }
}

const DATA = { snapshot: { template: 't' }, preflight: {}, startedById: null, startedByName: 'test' }

test('claim: an existing unfinished run inside the lock is returned, nothing is created', async () => {
  const existing = { id: 'run_old', totalRecipients: 4, status: 'QUEUED' }
  const { db, calls } = fakeDb({ existingInTx: existing })
  const out = await claimCampaignRunSlot('camp_1', DATA, db)
  assert.deepEqual(out, { claimed: false, existing })
  const ops = calls.map((c) => c.op)
  assert.ok(ops.indexOf('lock') >= 0 && ops.indexOf('lock') < ops.indexOf('tx.findFirst'), 'the lock must be taken BEFORE the check')
  assert.ok(!ops.includes('tx.create'))
  const lock = calls.find((c) => c.op === 'lock')!.args as { sql: string; values: unknown[] }
  assert.match(lock.sql, /pg_advisory_xact_lock\(hashtextextended\(/, 'transaction-scoped lock only — never a session lock')
  assert.deepEqual(lock.values, ['email_campaign_run:camp_1'])
  const where = (calls.find((c) => c.op === 'tx.findFirst')!.args as { where: { status: { in: string[] } } }).where
  assert.deepEqual(where.status.in, [...UNFINISHED_RUN_STATES])
})

test('claim: no existing run → a PREPARING run is created and claimed', async () => {
  const { db, calls } = fakeDb({})
  const out = await claimCampaignRunSlot('camp_1', DATA, db)
  assert.deepEqual(out, { claimed: true, runId: 'run_new' })
  const create = calls.find((c) => c.op === 'tx.create')!.args as { data: Record<string, unknown> }
  assert.equal(create.data.status, 'PREPARING')
  assert.equal(create.data.campaignId, 'camp_1')
  const txOpts = calls.find((c) => c.op === 'transaction')!.args as { maxWait: number; timeout: number }
  assert.equal(txOpts.maxWait, 5_000)
  assert.equal(txOpts.timeout, 10_000)
})

test('claim: the unique index firing (P2002) returns the winner, re-read outside the transaction', async () => {
  const winner = { id: 'run_winner', totalRecipients: 0, status: 'PREPARING' }
  const { db, calls } = fakeDb({ createThrows: { code: 'P2002', meta: { target: RUN_SLOT_INDEX } }, existingOutside: winner })
  const out = await claimCampaignRunSlot('camp_1', DATA, db)
  assert.deepEqual(out, { claimed: false, existing: winner })
  assert.ok(calls.some((c) => c.op === 'outside.findFirst'))
})

test('claim: P2002 with no readable winner is a conflict, not a crash', async () => {
  const { db } = fakeDb({ createThrows: { code: 'P2002' }, existingOutside: null })
  const out = await claimCampaignRunSlot('camp_1', DATA, db)
  assert.deepEqual(out, { claimed: false, existing: null, conflict: true, busy: false })
})

test('claim: a busy database (P2024/P2028/P2034) is a conflict, never an uncaught 500', async () => {
  for (const code of ['P2024', 'P2028', 'P2034']) {
    const { db } = fakeDb({ txThrows: { code } })
    const out = await claimCampaignRunSlot('camp_1', DATA, db)
    assert.deepEqual(out, { claimed: false, existing: null, conflict: true, busy: true }, code)
  }
})

test('claim: any other error propagates', async () => {
  const { db } = fakeDb({ createThrows: Object.assign(new Error('record not found'), { code: 'P2025' }) })
  await assert.rejects(() => claimCampaignRunSlot('camp_1', DATA, db), /record not found/)
})

// ── Source ordering the behaviour depends on ────────────────────────────

const dispatchSrc = () => code(read('src/lib/email-campaign-dispatch.ts'))

test('dispatchCampaign claims through claimCampaignRunSlot and never creates a run directly', () => {
  const d = dispatchSrc()
  const fn = d.slice(d.indexOf('export async function dispatchCampaign'), d.indexOf('export async function sendToRecipient'))
  assert.match(fn, /await claimCampaignRunSlot\(campaignId,/)
  assert.ok(!d.includes('prisma.emailCampaignRun.create('), 'the only run create is inside the locked transaction')
  assert.ok(fn.indexOf('isMarketingDispatchPaused') < fn.indexOf('claimCampaignRunSlot('), 'the kill switch still comes first')
})

test('PREPARING → QUEUED and SCHEDULED → ACTIVE are conditional and happen BEFORE any batch is enqueued', () => {
  const d = dispatchSrc()
  const fn = d.slice(d.indexOf('export async function dispatchCampaign'), d.indexOf('export async function sendToRecipient'))
  const queued = fn.indexOf("where: { id: run.id, status: 'PREPARING' },")
  const active = fn.indexOf("where: { id: campaignId, status: 'SCHEDULED' }, data: { status: 'ACTIVE' }")
  const enqueue = fn.indexOf("'campaign-batch',")
  assert.ok(queued > 0, 'the QUEUED write must be conditional on PREPARING')
  assert.ok(active > queued, 'the campaign leaves SCHEDULED in the same transaction')
  assert.ok(enqueue > active, 'batches are enqueued only after both writes committed')
  assert.ok(!d.includes('marketingCampaign.update({ where: { id: campaignId }'), 'no unconditional campaign write may remain')
  assert.match(fn, /if \(!queued\) return await abortSupersededPreparation\(/, 'a run that left PREPARING is never resurrected')
  // The FAILED write in the catch is conditional too.
  assert.match(fn, /updateMany\(\{ where: \{ id: run\.id, status: 'PREPARING' \}, data: \{ status: 'FAILED', completedAt: new Date\(\)/)
})

test('once QUEUED, dispatch never reports failure', () => {
  const d = dispatchSrc()
  const fn = d.slice(d.indexOf('export async function dispatchCampaign'), d.indexOf('export async function sendToRecipient'))
  const live = fn.slice(fn.indexOf("'campaign-batch',"))
  assert.ok(!/return \{ ok: false/.test(live), 'after the run is live every path returns ok:true')
  assert.match(live, /post-queue step failed — sweep will re-drive lost batches/)
})

test('retryFailedRecipients re-opens the RUN under the lock before any recipient', () => {
  const d = dispatchSrc()
  const fn = d.slice(d.indexOf('export async function retryFailedRecipients'), d.indexOf('const UNRESOLVED_SEND_STATUSES'))
  const lock = fn.indexOf('pg_advisory_xact_lock')
  const runReopen = fn.indexOf("data: { status: 'SENDING', completedAt: null }")
  const recipientReopen = fn.indexOf("status: 'PENDING', reason: 'manual_retry'")
  assert.ok(lock > 0 && lock < runReopen, 'the reopen must be serialised with dispatch')
  assert.ok(runReopen < recipientReopen, 'recipients are re-opened only after the run reopen succeeded')
})

test('recipient writes after a claim are compare-and-set on the claim token', () => {
  const d = dispatchSrc()
  assert.ok(!/emailCampaignRecipient\s*\.update\(/.test(d), 'no unconditional recipient update() may remain')
  assert.match(d, /where: recipientSettlementWhere\(recipientId, claimAttempt\)/)
  const send = d.slice(d.indexOf('export async function sendToRecipient'), d.indexOf('async function deferAfterThrow'))
  assert.ok(send.indexOf('claim superseded before provider call') < send.indexOf('deps.guardedSend('), 'ownership is checked before the provider can be reached')
})

test('the sweep does not auto re-dispatch a campaign whose run was already dispatched', () => {
  const d = dispatchSrc()
  const fn = d.slice(d.indexOf('export async function sweepCampaignRuns'))
  assert.ok(fn.indexOf('DISPATCHED_TERMINAL_RUN_STATES') < fn.indexOf('dispatchCampaign(c.id'), 'the prior-run check precedes the dispatch')
  assert.match(d, /const DISPATCHED_TERMINAL_RUN_STATES: RunState\[\] = \['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'\]/)
  assert.match(fn, /else if \(!result\.ok && result\.conflict\)/, 'a slot conflict is not written as a refusal')
})
