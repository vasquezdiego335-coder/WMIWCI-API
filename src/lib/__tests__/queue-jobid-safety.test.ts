import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { campaignBatchJobId, campaignRecipientJobId } from '../email-campaign-run'
import { automationJobId } from '../email-automation'
import { jobIdFor } from '../journeys'

// ════════════════════════════════════════════════════════════════════════
//  BULLMQ CUSTOM JOB IDS MAY NOT CONTAIN ":" (production 2026-07-26)
//
//  BullMQ uses ":" as its internal Redis key separator and REJECTS a custom job
//  id containing one. EVERY id builder in the scheduling surface used colons, so
//  the first real campaign dispatch died with "Custom Id cannot contain :" — and
//  worse, journeys were ENABLED in production, meaning every 72h/24h reminder,
//  abandoned-checkout stage and quote follow-up had been failing to enqueue
//  silently. Nothing downstream (audience, consent, template, approval) was ever
//  reached; all of that was already correct.
//
//  The bug appeared in THREE shapes, so the tests check all three:
//    1. id builder functions,
//    2. hand-written `jobId:` templates at call sites,
//    3. an id rebuilt in a DIFFERENT module in order to CANCEL a job — where a
//       drifted separator is invisible, because cancelling a job that does not
//       exist is a silent no-op.
// ════════════════════════════════════════════════════════════════════════

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')

test('every job-id builder produces a BullMQ-safe id', () => {
  const ids = [
    campaignBatchJobId('cms0abc123', 0),
    campaignBatchJobId('cms0abc123', 17),
    campaignRecipientJobId('rec_987', 3),
    automationJobId('auto_1', 2, 'stage-a', 'subject_9'),
    jobIdFor('pre-move', 'job-reminder-72h', 'bk_123'),
    jobIdFor('abandoned', 'abandoned-checkout-recovery', 'bk_9'),
    jobIdFor('quote', 'quote-followup-1', 'lead_4'),
  ]
  for (const id of ids) {
    assert.ok(!id.includes(':'), `BullMQ rejects a custom id containing ":" — got ${id}`)
    assert.ok(id.length > 0)
  }
})

test('ids stay DETERMINISTIC (they are the dedup key)', () => {
  assert.equal(campaignBatchJobId('r1', 2), campaignBatchJobId('r1', 2))
  assert.notEqual(campaignBatchJobId('r1', 2), campaignBatchJobId('r1', 3))
  assert.notEqual(campaignRecipientJobId('x', 1), campaignRecipientJobId('x', 2))
  assert.equal(jobIdFor('a', 'b', 'c'), jobIdFor('a', 'b', 'c'))
  assert.notEqual(jobIdFor('a', 'b', 'c'), jobIdFor('a', 'b', 'd'))
})

test('no inline jobId template injects a colon', () => {
  for (const rel of ['../email-campaign-dispatch.ts', '../email-automation-runtime.ts']) {
    for (const line of read(rel).split('\n')) {
      const m = line.match(/jobId:\s*(.+)$/)
      if (!m) continue
      assert.ok(!/`[^`]*:[^`]*`/.test(m[1]), `inline jobId template contains ":" -> ${line.trim()}`)
    }
  }
})

test('CANCEL ids match CREATE ids for post-job follow-ups', () => {
  // followups.ts CREATES `followup__<type>__<bookingId>`; journeys.onBookingCancelled
  // REBUILDS that id to cancel it. If the two drift, a cancelled booking still
  // receives its review/referral email, and the failure is invisible because
  // cancelling a non-existent job is a silent no-op.
  const followups = read('../followups.ts')
  const journeys = read('../journeys.ts')
  assert.ok(followups.includes('followup__${type}__${bookingId}'), 'followups.ts must build followup__<type>__<bookingId>')
  assert.ok(journeys.includes('followup__${t}__${bookingId}'), 'journeys.ts cancel path must use the SAME shape')
})

test('a colon-separated id never appears in an ID position', () => {
  // Scoped to id positions on purpose: smsQueue.add('followup:<type>', …) passes
  // a job NAME, where colons are perfectly legal. Asserting on every occurrence
  // of "followup:" would fail on that and teach the wrong rule.
  const sources = [read('../followups.ts'), read('../journeys.ts')].join('\n')
  for (const line of sources.split('\n')) {
    if (!/addScheduled\(|jobIdFor|cancel\(/.test(line)) continue
    assert.ok(!/`followup:/.test(line), `colon-separated id in an id position -> ${line.trim()}`)
    assert.ok(!/`journey:/.test(line), `colon-separated id in an id position -> ${line.trim()}`)
  }
})

test('DB idempotency keys are deliberately NOT changed', () => {
  // campaignRunEventId / enrollmentDedupeKey are DATABASE keys, not queue ids.
  // Colons are legal there, and rewriting them would change idempotency
  // identity — which could let an already-sent email send a second time.
  assert.ok(read('../email-campaign-run.ts').includes('campaign-run:${runId}'), 'the DB event id must keep its original shape')
  assert.ok(read('../email-automation-runtime.ts').includes('automation:${automationId}:v${version}'), 'the DB dedupe key must keep its original shape')
})
