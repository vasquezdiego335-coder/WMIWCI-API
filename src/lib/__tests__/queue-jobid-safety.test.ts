import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { campaignBatchJobId, campaignRecipientJobId } from '../email-campaign-run'
import { automationJobId } from '../email-automation'

// ════════════════════════════════════════════════════════════════════════
//  BULLMQ CUSTOM JOB IDS MAY NOT CONTAIN ":" (production 2026-07-25)
//
//  BullMQ uses ":" as its internal Redis key separator and REJECTS a custom job
//  id containing one. Every id builder used colons, so the first real campaign
//  dispatch failed with "Dispatch preparation failed: Custom Id cannot contain
//  :" — the campaign path could never have worked, which is why campaign_runs
//  had stayed at 0.
//
//  These test the BUILDERS (behaviour) and then sweep the SOURCE for inline
//  jobId templates, because the bug appeared in both places: three builders and
//  four hand-written ":resume:" / ":retry:" / ":sweep:" suffixes.
// ════════════════════════════════════════════════════════════════════════

test('every job-id builder produces a BullMQ-safe id', () => {
  const ids = [
    campaignBatchJobId('cms0abc123', 0),
    campaignBatchJobId('cms0abc123', 17),
    campaignRecipientJobId('rec_987', 3),
    automationJobId('auto_1', 2, 'stage-a', 'subject_9'),
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
})

test('no inline jobId template in the dispatch/runtime sources injects a colon', () => {
  for (const rel of ['../email-campaign-dispatch.ts', '../email-automation-runtime.ts']) {
    const src = readFileSync(resolve(__dirname, rel), 'utf8')
    // Find every `jobId: ...` up to the end of that line and reject a ":" that
    // sits inside the template (ignoring the `jobId:` key itself).
    for (const line of src.split('\n')) {
      const m = line.match(/jobId:\s*(.+)$/)
      if (!m) continue
      const value = m[1]
      assert.ok(!/`[^`]*:[^`]*`/.test(value), `inline jobId template contains ":" -> ${line.trim()}`)
    }
  }
})
