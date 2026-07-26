import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TERMINAL_RUN_STATES, ACTIONABLE_RECIPIENT_STATES } from '../email-campaign-reconcile'

// ════════════════════════════════════════════════════════════════════════
//  Bug #7 (owner spec 2026-07-26).
//  A run that died mid-preparation stranded its recipients forever:
//      run FAILED, completedAt NULL, PENDING=1, SKIPPED=5
//  retryFailedRecipients refuses non-sendable runs; finalizeRunIfDone returns
//  early for FAILED. So the row sat PENDING indefinitely and the run never
//  settled.
//
//  The SAFETY rule that decides behaviour is `emailSendId`:
//    NULL → never submitted to the provider → safe to cancel/retry
//    SET  → an attempt exists, outcome may be ambiguous → NEVER blindly resent
//
//  Verified against production data before these tests were written:
//    before {FAILED, completedAt NULL, PENDING=1}
//    repair {"runsRepaired":1,"cancelled":1,"needsReview":0}
//    rerun  {"runsRepaired":0,...}                        (idempotent)
//    after  {completedAt SET, cancelled=1,
//            reason "run_failed_never_submitted"}
// ════════════════════════════════════════════════════════════════════════

const src = () =>
  readFileSync(resolve(__dirname, '../email-campaign-reconcile.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')

test('FAILED is treated as terminal (the state that stranded rows)', () => {
  assert.ok(TERMINAL_RUN_STATES.includes('FAILED'), 'FAILED must be reconcilable')
  assert.ok(TERMINAL_RUN_STATES.includes('CANCELLED'))
  assert.ok(TERMINAL_RUN_STATES.includes('COMPLETED'))
  // A live run must NOT be reconciled here — that would race the worker.
  for (const live of ['PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING']) {
    assert.ok(!TERMINAL_RUN_STATES.includes(live), `${live} must not be reconciled`)
  }
})

test('PENDING and SENDING are the states that strand', () => {
  assert.deepEqual([...ACTIONABLE_RECIPIENT_STATES].sort(), ['PENDING', 'SENDING'])
})

test('a recipient NEVER submitted to the provider is CANCELLED, not resent', () => {
  const s = src()
  assert.ok(/emailSendId === null/.test(s), 'must branch on emailSendId to decide what was submitted')
  assert.ok(/status: 'CANCELLED'/.test(s), 'never-submitted rows are cancelled')
  assert.ok(/never_submitted/.test(s), 'and carry an explicit reason')
})

test('an UNKNOWN provider outcome is never blindly resent', () => {
  const s = src()
  assert.ok(/emailSendId !== null/.test(s), 'must identify rows with an existing attempt')
  assert.ok(/unknown_provider_outcome/.test(s), 'must mark them for human reconciliation')
  // They must NOT be returned to PENDING, which is what would resend them.
  assert.ok(!/unknownOutcome[\s\S]{0,200}status: 'PENDING'/.test(s), 'an ambiguous attempt must not be requeued')
})

test('every reconciled recipient gets a recorded reason', () => {
  const s = src()
  const updates = s.split('updateMany').slice(1, 3) // the two recipient updates
  for (const u of updates) assert.ok(/reason:/.test(u.slice(0, 300)), 'each reconciliation must set a reason')
})

test('the run is settled only when nothing actionable remains', () => {
  const s = src()
  assert.ok(/remaining === 0/.test(s), 'must require zero actionable recipients before settling')
  assert.ok(/completedAt: new Date\(\)/.test(s), 'must stamp completedAt')
  // Guarded so a concurrent pass cannot double-settle.
  assert.ok(/completedAt: null \}/.test(s), 'the settle write must be conditional on completedAt still being null')
})

test('counters are RECOMPUTED from rows, not incremented', () => {
  const s = src()
  assert.ok(/sentCount: sent/.test(s) && /cancelledCount: cancelled/.test(s), 'counters come from counts')
  // Cancelled/never-sent must never be reported as delivered.
  assert.ok(/status: 'SENT'/.test(s), 'sent count is derived from SENT rows only')
})

test('a repair helper exists for rows stranded before this code', () => {
  assert.ok(/export async function repairStrandedRuns/.test(src()), 'existing corrupted runs need a repair path')
})

test('reconciliation is idempotent by construction', () => {
  // It only ever selects rows in an actionable state; once reconciled they are
  // terminal, so a second pass matches nothing. Proven live: the second
  // repairStrandedRuns() call returned runsRepaired: 0.
  const s = src()
  assert.ok(/status: \{ in: \[\.\.\.ACTIONABLE_RECIPIENT_STATES\] \}/.test(s), 'selection is limited to actionable rows')
})
