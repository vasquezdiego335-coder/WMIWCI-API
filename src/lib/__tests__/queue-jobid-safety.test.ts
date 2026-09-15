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
    // CRLF-safe split: `.` never matches "\r", so `(.+)$` found nothing on a Windows checkout.
    for (const line of read(rel).split(/\r?\n/)) {
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

// ════════════════════════════════════════════════════════════════════════
//  WORKER / ENQUEUE SURFACE (production fix 2026-09-15)
//
//  The deferral re-queue in email.worker.ts built `${job.id}:deferred:${reason}`.
//  BullMQ's 3-part colon carve-out let hop 1 through and threw "Custom Id cannot
//  contain :" on hop 2. The lead-notify requeues and the deposit-paid notice
//  passed raw DB dedupe keys (which contain ":") as queue ids. Every such id now
//  goes through deferredJobId() / queueSafeJobId() from src/lib/email-deferral.ts.
// ════════════════════════════════════════════════════════════════════════

const WORKER_SURFACE = [
  '../../workers/email.worker.ts',
  '../../workers/scheduled.worker.ts',
  '../../workers/discord.worker.ts',
  '../discord-payments.ts',
  '../followups.ts',
  '../journeys.ts',
  '../../outbox/integration.ts',
]

/** Does a `jobId:` / `jobId =` value expression inline a string literal with a ":"
 *  in the ID itself? `${…}` interpolations are stripped first (a ternary colon
 *  there is not part of the id), and values wrapped in the safe builders pass. */
function inlineColonId(value: string): boolean {
  const v = value.trim()
  if (/^(queueSafeJobId|deferredJobId)\(/.test(v)) return false
  const literals = v.match(/`[^`]*`|'[^']*'|"[^"]*"/g) ?? []
  return literals.some((lit) => lit.replace(/\$\{[^}]*\}/g, '').slice(1, -1).includes(':'))
}

test('detector self-check: it catches the old deferral shape and a raw dedupe-key id', () => {
  assert.equal(inlineColonId('`${job.id}:deferred:${outcome.reason}`,'), true)
  assert.equal(inlineColonId("'cron:x' }"), true)
  assert.equal(inlineColonId('`lead-notify:${leadId}`'), true)
  assert.equal(inlineColonId('queueSafeJobId(`deposit-paid:${id}`), removeOnComplete: 1'), false)
  assert.equal(inlineColonId('deferredJobId(job.id, outcome.reason, dueAt),'), false)
  assert.equal(inlineColonId('`followup__${type}__${bookingId}`'), false)
  assert.equal(inlineColonId('`journey__${a ? "x" : "y"}__${b}`'), false)
  assert.equal(inlineColonId('job.id, type })'), false)
})

test('no worker/enqueue jobId uses an inline literal containing ":" (repeatable crons exempt)', () => {
  let scanned = 0
  for (const rel of WORKER_SURFACE) {
    // Split on CRLF too: in a JS regex `.` does not match "\r", so on a Windows
    // checkout `(.+)$` silently matches NOTHING and the scan would prove nothing.
    const lines = read(rel).split(/\r?\n/)
    const cronStart = lines.findIndex((l) => /function\s+registerCronJobs\b/.test(l))
    const cronEnd = cronStart < 0 ? -1 : lines.findIndex((l, k) => k > cronStart && /^\}/.test(l))
    lines.forEach((line, i) => {
      const m = line.match(/\bjobId\s*(?::|=(?!=))\s*(.+)$/)
      if (!m) return
      if (/^\s*(\/\/|\*)/.test(line)) return // comments
      scanned++
      if (!inlineColonId(m[1])) return
      // EXEMPT: repeatable registrations. BullMQ keys repeat jobs itself and its
      // 3-part carve-out exists for exactly that. Look back to the start of the
      // surrounding `.add(` call for a `repeat:` option, inside registerCronJobs.
      let start = i
      while (start > 0 && !/\.add\(/.test(lines[start]) && i - start < 15) start--
      const call = lines.slice(start, i + 1).join('\n')
      const inCron = cronStart >= 0 && i > cronStart && i < cronEnd
      const exempt = inCron && /\.add\(/.test(call) && /\brepeat:/.test(call)
      assert.ok(exempt, `${rel}:${i + 1} inline jobId contains ":" -> ${line.trim()}`)
    })
  }
  assert.ok(scanned >= 5, `scan found too few jobId occurrences (${scanned}) — did the files move?`)
})

test('deferral path uses deferredJobId( and lead-notify / deposit requeues use queueSafeJobId(', () => {
  const email = read('../../workers/email.worker.ts')
  assert.ok(/jobId:\s*deferredJobId\(job\.id,/.test(email), 'email.worker deferral re-queue must use deferredJobId(job.id, …)')
  assert.ok(!/:deferred:/.test(email.replace(/\/\/.*$/gm, '')), 'the old `:deferred:` id shape must not survive outside comments')

  for (const rel of ['../../workers/discord.worker.ts', '../../workers/scheduled.worker.ts']) {
    const src = read(rel)
    assert.ok(/const jobId = queueSafeJobId\(dedupeKey\)/.test(src), `${rel}: lead-notify requeue must derive its id with queueSafeJobId(dedupeKey)`)
    // The same safe id must be used for BOTH the remove and the add, or the remove is a silent no-op.
    const block = src.slice(src.indexOf('const jobId = queueSafeJobId(dedupeKey)'))
    const nextAdd = block.slice(0, block.indexOf("'lead-notify'") + 200)
    assert.ok(/discordQueue\.remove\(jobId\)/.test(nextAdd), `${rel}: remove must use the safe id`)
    assert.ok(/\{\s*jobId(,|\s*\})/.test(nextAdd), `${rel}: add must use the safe id`)
  }

  assert.ok(
    read('../discord-payments.ts').includes('jobId: queueSafeJobId(`deposit-paid:${depositRequestId}`)'),
    'deposit-paid notice id must go through queueSafeJobId',
  )
})
