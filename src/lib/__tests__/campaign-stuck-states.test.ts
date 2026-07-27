import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RUN_SENDABLE_STATES, runIsSettled, settledRunState, type RunState } from '../email-campaign-run'

// ════════════════════════════════════════════════════════════════════════
//  STUCK RUN STATES (audit pass A, 2026-07-27)
//
//  Both defects here share a shape: a run enters a state that NOTHING advances,
//  while that same state blocks progress elsewhere. Neither throws, neither
//  logs an error, and both leave the owner with a campaign that looks busy
//  forever.
// ════════════════════════════════════════════════════════════════════════

const dispatch = () => readFileSync(resolve(__dirname, '..', 'email-campaign-dispatch.ts'), 'utf8')
const code = (t: string) =>
  t.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*') }).join('\n')

// ── A-1: CANCELLING never completes ─────────────────────────────────────

test('A-1 CANCELLING is not a sendable state — nothing will process its recipients', () => {
  // This is the premise of the bug: a recipient re-opened to PENDING on a
  // CANCELLING run can never be picked up again.
  assert.equal(RUN_SENDABLE_STATES.has('CANCELLING' as RunState), false)
  assert.equal(RUN_SENDABLE_STATES.has('QUEUED' as RunState), true)
  assert.equal(RUN_SENDABLE_STATES.has('SENDING' as RunState), true)
})

test('A-1 a PENDING recipient prevents settlement — so it must be closed, not left', () => {
  // runIsSettled is the gate. With one PENDING row it is false forever.
  assert.equal(runIsSettled({ PENDING: 1, SENT: 3 }), false)
  assert.equal(runIsSettled({ SENDING: 1 }), false)
  assert.equal(runIsSettled({ DEFERRED: 1 }), false)
  assert.equal(runIsSettled({ SENT: 3, CANCELLED: 1 }), true)
})

test('A-1 finalizeRunIfDone CLOSES recipients re-opened on a cancelling run', () => {
  // THE SEQUENCE THIS PREVENTS:
  //   cancel -> CANCELLING (SENDING row left alone, correctly — it may be
  //   mid-provider-call) -> worker dies -> sweep re-opens it to PENDING ->
  //   CANCELLING is not sendable so no batch takes it -> runIsSettled() false
  //   -> the run sits CANCELLING and the recipient sits PENDING, forever.
  const c = code(dispatch())
  const fn = c.slice(c.indexOf('export async function finalizeRunIfDone'), c.indexOf('const RECIPIENT_STALE_MS'))
  assert.match(fn, /state === 'CANCELLING'/, 'finalization must special-case a cancelling run')
  assert.match(fn, /status: \{ in: \['PENDING', 'DEFERRED'\] \}/, 'it must close the states that block settlement')
  assert.match(fn, /status: 'CANCELLED', reason: 'run_cancelled'/, 'closed with the same reason the cancel gives')
  // Must run BEFORE the counts are taken, or settlement still sees them open.
  assert.ok(fn.indexOf("state === 'CANCELLING'") < fn.indexOf('groupBy'), 'the close must precede the count')
})

test('A-1 a cancelled run settles as CANCELLED, not COMPLETED', () => {
  assert.equal(settledRunState({ SENT: 2, CANCELLED: 3 }, true), 'CANCELLED')
  assert.equal(settledRunState({ SENT: 2, CANCELLED: 3 }, false), 'COMPLETED')
  assert.equal(settledRunState({ SENT: 2, FAILED: 1 }, false), 'COMPLETED_WITH_ERRORS')
})

test('A-1 SENDING rows are NOT force-cancelled — an in-flight send is left alone', () => {
  // Cancelling a row that may be mid-provider-call would misreport a message
  // the customer received. The sweep re-opens it only after the stale window,
  // and only then does the close above apply.
  const c = code(dispatch())
  const fn = c.slice(c.indexOf('export async function finalizeRunIfDone'), c.indexOf('const RECIPIENT_STALE_MS'))
  assert.ok(!/in: \['PENDING', 'DEFERRED', 'SENDING'\]/.test(fn), 'an in-flight send must never be cancelled outright')
})

// ── A-5: abandoned PREPARING blocks the campaign forever ────────────────

test('A-5 PREPARING blocks new dispatch — so it MUST be recoverable', () => {
  const c = code(dispatch())
  assert.match(c, /const UNFINISHED_RUN_STATES: RunState\[\] = \['PREPARING'/, 'PREPARING blocks re-dispatch')
  // The premise: an interrupted process cannot run the catch that sets FAILED.
  assert.match(c, /status: 'PREPARING', startedAt: \{ lt: new Date\(Date\.now\(\) - RECIPIENT_STALE_MS\) \}/,
    'the sweep must reclaim PREPARING runs that outlived the stale window')
  assert.match(c, /status: 'FAILED',\s*completedAt: new Date\(\)/, 'and settle them with a terminal timestamp')
})

test('A-5 the recovery message tells the owner nothing was sent and what to do', () => {
  const c = dispatch()
  assert.match(c, /Preparation never completed/, 'the error must name the actual failure')
  assert.match(c, /No email was sent/, 'and state the customer impact')
  assert.match(c, /dispatch again/, 'and give the next action')
})

test('A-5 FAILED is not an unfinished state, so recovery genuinely unblocks dispatch', () => {
  const c = code(dispatch())
  const unfinished = /const UNFINISHED_RUN_STATES: RunState\[\] = \[([^\]]+)\]/.exec(c)?.[1] ?? ''
  assert.ok(!unfinished.includes('FAILED'), 'failing the run must actually free the campaign')
  assert.ok(unfinished.includes('PREPARING'), 'and PREPARING must still block while genuinely in progress')
})

test('A-5 recovery only touches runs past the stale window, never a live preparation', () => {
  // Preparation is seconds of work; the stale window is 15 minutes by default.
  // A run being prepared right now must not be failed out from under itself.
  const c = code(dispatch())
  // Anchor on the SWEEP's updateMany. The first `status: 'PREPARING'` in this
  // file is the run CREATION inside dispatchCampaign, which must not match.
  const start = c.indexOf('const abandoned = await prisma.emailCampaignRun.updateMany')
  assert.ok(start > 0, 'the abandoned-run reclaim must exist')
  const block = c.slice(start, start + 500)
  assert.match(block, /lt: new Date\(Date\.now\(\) - RECIPIENT_STALE_MS\)/, 'must be time-bounded')
  assert.ok(!/where: \{ status: 'PREPARING' \}/.test(block), 'must never match every PREPARING run')
})
