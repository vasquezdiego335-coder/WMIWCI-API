// ════════════════════════════════════════════════════════════════════════
//  MARKETING DISCOVERY AGENT — bounded, draft-only, approval-required.
//  (owner spec 2026-08-07)
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MARKETING_CHANNEL_ID,
  MIN_AUDIENCE,
  PLAYBOOK,
  SUGGESTION_COOLDOWN_DAYS,
  discoverCampaignOpportunities,
  marketingAgentEnabled,
} from '../email-marketing-agent'
import { templateAllowsSegment } from '../email-recipient-context'
import { classifyTemplate } from '../email-guard'

function src(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

// ── The agent cannot send, structurally ─────────────────────────────────

test('the marketing agent has NO path to a send: draft-only, no queue, no provider', () => {
  const s = src('email-marketing-agent.ts')
  assert.ok(!s.includes('guardedSend'), 'never calls the send gate')
  assert.ok(!s.includes('emailQueue'), 'never enqueues an email job')
  assert.ok(!s.includes('dispatchCampaign'), 'never dispatches a campaign')
  assert.ok(!s.includes('resend.emails'), 'never touches the provider')
  // The ONLY campaign status it may write is DRAFT.
  assert.match(s, /status: 'DRAFT'/)
  assert.ok(!/status: '(READY|ACTIVE|SCHEDULED|APPROVED)'/.test(s), 'no other campaign state is reachable')
})

test('every playbook entry pairs a segment with a template that is honest for it', () => {
  assert.ok(PLAYBOOK.length >= 2)
  for (const entry of PLAYBOOK) {
    const verdict = templateAllowsSegment(entry.template, entry.segment)
    assert.ok(verdict.ok, `${entry.template} must be allowed on ${entry.segment}: ${verdict.ok ? '' : verdict.error}`)
    // Every drafted template is promotional, so every send inherits the full
    // promotional gate (consent, caps, quiet hours, unsubscribe link).
    assert.equal(classifyTemplate(entry.template), 'promotional')
  }
})

test('the flag defaults OFF, and the sweep refuses without it', async () => {
  delete process.env.EMAIL_MARKETING_AGENT_ENABLED
  assert.equal(marketingAgentEnabled(), false)
  const report = await discoverCampaignOpportunities()
  assert.deepEqual(report, { ran: false, reason: 'disabled', considered: [], created: null })
})

test('the knobs have the owner-specified defaults', () => {
  assert.equal(MIN_AUDIENCE, 5, '1-2 eligible people is not a campaign')
  assert.equal(SUGGESTION_COOLDOWN_DAYS, 14, 'the same suggestion is not re-posted every cycle')
  assert.equal(MARKETING_CHANNEL_ID(), '1514630043605925938', 'the owner-designated marketing channel')
})

test('the AI receives aggregates only — no per-customer data enters the prompt', () => {
  const s = src('email-marketing-agent.ts')
  const draftFn = s.slice(s.indexOf('export async function draftCampaignCopy'), s.indexOf('async function postCampaignOpportunity'))
  // The prompt is built from the playbook entry + preview COUNTS. It must not
  // reference candidate rows, emails, names or samples.
  for (const forbidden of ['sample', '.email', 'candidate', 'name:', 'phone']) {
    assert.ok(!draftFn.includes(forbidden), `draftCampaignCopy must not interpolate ${forbidden}`)
  }
  assert.match(draftFn, /preview\.eligible/, 'counts are the only audience fact the model sees')
})

test('the Discord notice carries counts and campaign facts, never a customer identity', () => {
  const s = src('email-marketing-agent.ts')
  const poster = s.slice(s.indexOf('async function postCampaignOpportunity'), s.indexOf('export type DiscoveryReport'))
  for (const forbidden of ['sample', 'candidate', 'recipients.map', 'lead.email', 'customer.email']) {
    assert.ok(!poster.includes(forbidden), `the Discord notice must not include ${forbidden}`)
  }
  assert.match(poster, /input\.eligible/, 'aggregate count')
  assert.match(poster, /DRAFT — nothing sends until you approve it/)
})

test('AI copy failure keeps the deterministic draft — discovery works with zero AI', () => {
  const s = src('email-marketing-agent.ts')
  assert.match(s, /const copy: CampaignCopy = ai \?\? \{ \.\.\.entry\.draft, useDiscount: entry\.suggestDiscount \}/)
  // ...and the model may never grant a discount the playbook did not offer.
  assert.match(s, /if \(parsed\.data\.useDiscount && !entry\.suggestDiscount\) parsed\.data\.useDiscount = false/)
})

test('one campaign per sweep, cooldown before threshold work, bounded by construction', () => {
  const s = src('email-marketing-agent.ts')
  const sweep = s.slice(s.indexOf('export async function discoverCampaignOpportunities'))
  const cooldown = sweep.indexOf('cooldown')
  const preview = sweep.indexOf('previewAudience(')
  assert.ok(cooldown > -1 && preview > cooldown, 'the cheap cooldown check runs before the audience query')
  assert.match(sweep, /break\b/, 'the loop stops after the first drafted campaign')
})

test('the cron is registered and the worker dispatches it', () => {
  const worker = readFileSync(resolve(__dirname, '../../workers/scheduled.worker.ts'), 'utf8')
  assert.match(worker, /case 'marketing-discovery'/)
  assert.match(worker, /jobId: 'cron:marketing-discovery'/)
  assert.match(readFileSync(resolve(__dirname, '../queues/index.ts'), 'utf8'), /\| 'marketing-discovery'/)
})
