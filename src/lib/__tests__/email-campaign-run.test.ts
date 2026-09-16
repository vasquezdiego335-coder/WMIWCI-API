// Offline tests for the campaign dispatch runtime's PURE parts: the run and
// recipient state machines, guard-outcome mapping, finalization, batching and
// idempotency identifiers. The DB-backed path (recipient claims, batch
// processing, the sweep) is exercised in the staging rehearsal, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canTransitionRun,
  RUN_TERMINAL_STATES,
  RUN_SENDABLE_STATES,
  recipientStateForOutcome,
  runIsSettled,
  settledRunState,
  batchCount,
  campaignBatchJobId,
  campaignRecipientJobId,
  campaignRunEventId,
  editedAfterApproval,
  promotionsEnabled,
  RUN_STATES,
  UNFINISHED_RUN_STATES,
  RUN_SLOT_INDEX,
  RECIPIENT_TERMINAL_STATES,
  RECIPIENT_RETRYABLE_STATES,
  CAMPAIGN_TRANSIENT_MAX_ATTEMPTS,
  isRunSlotConflict,
  isTransientTxError,
  isTransientReadFailure,
  planRecipientRetry,
  recipientClaimWhere,
  recipientSettlementWhere,
  runSlotLockKey,
  transientRetryDelayMs,
  type RunState,
} from '../email-campaign-run'

// ── Run state machine ───────────────────────────────────────────────────

test('the happy path PREPARING → QUEUED → SENDING → COMPLETED is legal', () => {
  assert.ok(canTransitionRun('PREPARING', 'QUEUED').ok)
  assert.ok(canTransitionRun('QUEUED', 'SENDING').ok)
  assert.ok(canTransitionRun('SENDING', 'COMPLETED').ok)
})

test('pause and resume are legal from the sendable states', () => {
  assert.ok(canTransitionRun('QUEUED', 'PAUSED').ok)
  assert.ok(canTransitionRun('SENDING', 'PAUSED').ok)
  assert.ok(canTransitionRun('PAUSED', 'QUEUED').ok)
  assert.ok(canTransitionRun('PAUSED', 'SENDING').ok)
})

test('cancellation is two-phase: CANCELLING → CANCELLED only', () => {
  assert.ok(canTransitionRun('SENDING', 'CANCELLING').ok)
  assert.ok(canTransitionRun('CANCELLING', 'CANCELLED').ok)
  assert.ok(!canTransitionRun('SENDING', 'CANCELLED').ok)
})

test('terminal run states allow nothing', () => {
  for (const s of Array.from(RUN_TERMINAL_STATES)) {
    for (const to of ['QUEUED', 'SENDING', 'PAUSED', 'PREPARING'] as RunState[]) {
      assert.ok(!canTransitionRun(s, to).ok, `${s} → ${to} must be refused`)
    }
  }
})

test('a run cannot jump backwards to PREPARING', () => {
  assert.ok(!canTransitionRun('SENDING', 'PREPARING').ok)
  assert.ok(!canTransitionRun('PAUSED', 'PREPARING').ok)
})

test('unknown states are refused, not treated as anything', () => {
  assert.ok(!canTransitionRun('BOGUS' as RunState, 'QUEUED').ok)
  assert.ok(!canTransitionRun('QUEUED', 'BOGUS' as RunState).ok)
})

test('only QUEUED and SENDING are sendable', () => {
  assert.deepEqual(Array.from(RUN_SENDABLE_STATES).sort(), ['QUEUED', 'SENDING'])
})

// ── Guard-outcome → recipient-state mapping ─────────────────────────────

test('a sent outcome maps to SENT with no reason', () => {
  assert.deepEqual(recipientStateForOutcome({ sent: true, providerId: 'p1', emailSendId: 'e1' }), {
    status: 'SENT',
    reason: null,
  })
})

test('a deferral with a retryAt maps to DEFERRED and keeps the reason', () => {
  const out = recipientStateForOutcome({ sent: false, reason: 'quiet_hours', retryAt: new Date() })
  assert.equal(out.status, 'DEFERRED')
  assert.equal(out.reason, 'quiet_hours')
})

test('unsubscribe and suppression map to their own states', () => {
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'unsubscribed' }).status, 'UNSUBSCRIBED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'hard_bounce' }).status, 'SUPPRESSED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'spam_complaint' }).status, 'SUPPRESSED')
})

test('live-state recheck refusals map to INELIGIBLE', () => {
  for (const reason of ['lead_converted', 'lead_lost', 'move_date_passed', 'status_not_allowed:CANCELLED', 'booking_advanced:CONFIRMED']) {
    assert.equal(recipientStateForOutcome({ sent: false, reason }).status, 'INELIGIBLE', reason)
  }
})

test('context failures map to CONTEXT_INVALID', () => {
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'context_missing:reviewUrl' }).status, 'CONTEXT_INVALID')
})

test('duplicates and terminal claims map to SKIPPED — never a second send', () => {
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'duplicate' }).status, 'SKIPPED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'terminal:ambiguous' }).status, 'SKIPPED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'invalid_email' }).status, 'SKIPPED')
})

test('ambiguous and exhausted map to FAILED', () => {
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'ambiguous' }).status, 'FAILED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'attempts_exhausted' }).status, 'FAILED')
})

test('an unknown refusal stays DEFERRED (re-drivable), never silently terminal', () => {
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'some_new_reason' }).status, 'DEFERRED')
})

test('a refusal the guard itself classified terminal is SKIPPED, never DEFERRED', () => {
  // classifyBlock (email-guard.ts) calls these final; deferring one would burn
  // the whole retry budget on a refusal that can only repeat, and hold the run
  // open while it did.
  for (const reason of ['marketing_opted_out', 'some_future_terminal_reason']) {
    const out = recipientStateForOutcome({ sent: false, reason, outcomeClass: 'terminal' })
    assert.deepEqual(out, { status: 'SKIPPED', reason }, reason)
    assert.equal(RECIPIENT_TERMINAL_STATES.has(out.status), true, `${reason} must close the recipient`)
  }
  // The more specific states still win over the generic SKIPPED bucket.
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'unsubscribed', outcomeClass: 'terminal' }).status, 'UNSUBSCRIBED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'hard_bounce', outcomeClass: 'terminal' }).status, 'SUPPRESSED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'spam_complaint', outcomeClass: 'terminal' }).status, 'SUPPRESSED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'admin_block', outcomeClass: 'terminal' }).status, 'SUPPRESSED')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'lead_converted', outcomeClass: 'terminal' }).status, 'INELIGIBLE')
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'status_not_allowed:CANCELLED', outcomeClass: 'terminal' }).status, 'INELIGIBLE')
  // A policy deferral carries a due time and stays DEFERRED whatever the class.
  const at = new Date(Date.now() + 3_600_000)
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'quiet_hours', retryAt: at, outcomeClass: 'deferred' }).status, 'DEFERRED')
})

test('a RETRYABLE refusal stays DEFERRED — a canary exclusion or a missing config must not close the person out', () => {
  for (const reason of ['no_marketing_consent', 'not_in_rollout_allowlist', 'validation: to', 'missing-configuration:marketing-context:address']) {
    assert.equal(recipientStateForOutcome({ sent: false, reason, outcomeClass: 'retryable' }).status, 'DEFERRED', reason)
  }
})

// ── Finalization ────────────────────────────────────────────────────────

test('a run with pending, sending or deferred recipients is not settled', () => {
  assert.ok(!runIsSettled({ PENDING: 1 }))
  assert.ok(!runIsSettled({ SENDING: 1 }))
  assert.ok(!runIsSettled({ DEFERRED: 1 }))
  assert.ok(runIsSettled({ SENT: 10, FAILED: 1, SKIPPED: 2 }))
})

test('settled state: COMPLETED clean, COMPLETED_WITH_ERRORS on failures, CANCELLED when cancelling', () => {
  assert.equal(settledRunState({ SENT: 5 }, false), 'COMPLETED')
  assert.equal(settledRunState({ SENT: 5, FAILED: 1 }, false), 'COMPLETED_WITH_ERRORS')
  assert.equal(settledRunState({ SENT: 5, FAILED: 1 }, true), 'CANCELLED')
})

// ── Batching + idempotency identifiers ──────────────────────────────────

test('batch count is ceil(total/size) and zero for an empty audience', () => {
  assert.equal(batchCount(0, 25), 0)
  assert.equal(batchCount(1, 25), 1)
  assert.equal(batchCount(25, 25), 1)
  assert.equal(batchCount(26, 25), 2)
  assert.equal(batchCount(5000, 25), 200)
})

test('job ids and the run event id are deterministic — the queue-level dedupe', () => {
  assert.equal(campaignBatchJobId('run1', 3), campaignBatchJobId('run1', 3))
  assert.notEqual(campaignBatchJobId('run1', 3), campaignBatchJobId('run1', 4))
  assert.notEqual(campaignBatchJobId('run1', 3), campaignBatchJobId('run2', 3))
  assert.equal(campaignRecipientJobId('r1', 2), campaignRecipientJobId('r1', 2))
  assert.equal(campaignRunEventId('runX'), campaignRunEventId('runX'))
  assert.notEqual(campaignRunEventId('runX'), campaignRunEventId('runY'))
})

// ── Dispatch preconditions ──────────────────────────────────────────────

test('editedAfterApproval: unapproved is always stale; the approval write itself is not', () => {
  const now = Date.now()
  assert.ok(editedAfterApproval({ approvedAt: null, updatedAt: new Date(now) }))
  // The approval write bumps updatedAt by ~ms — inside the grace window.
  assert.ok(!editedAfterApproval({ approvedAt: new Date(now), updatedAt: new Date(now + 500) }))
  // A real edit minutes later invalidates the approval.
  assert.ok(editedAfterApproval({ approvedAt: new Date(now), updatedAt: new Date(now + 60_000) }))
})

test('promotional dispatch is DISABLED unless the switch is exactly "true"', () => {
  const prev = process.env.EMAIL_PROMOTIONS_ENABLED
  try {
    delete process.env.EMAIL_PROMOTIONS_ENABLED
    assert.ok(!promotionsEnabled())
    process.env.EMAIL_PROMOTIONS_ENABLED = 'false'
    assert.ok(!promotionsEnabled())
    process.env.EMAIL_PROMOTIONS_ENABLED = 'TRUE'
    assert.ok(!promotionsEnabled(), 'case-sensitive on purpose — an accidental value must not enable sending')
    process.env.EMAIL_PROMOTIONS_ENABLED = 'true'
    assert.ok(promotionsEnabled())
  } finally {
    if (prev === undefined) delete process.env.EMAIL_PROMOTIONS_ENABLED
    else process.env.EMAIL_PROMOTIONS_ENABLED = prev
  }
})

// ── One unfinished run per campaign (2026-09-15) ────────────────────────

test('UNFINISHED_RUN_STATES is exactly every non-terminal run state', () => {
  const expected = RUN_STATES.filter((s) => !RUN_TERMINAL_STATES.has(s)).slice().sort()
  assert.deepEqual(UNFINISHED_RUN_STATES.slice().sort(), expected)
  assert.deepEqual(UNFINISHED_RUN_STATES.slice().sort(), ['CANCELLING', 'PAUSED', 'PREPARING', 'QUEUED', 'SENDING'])
  assert.equal(RUN_STATES.length, 9)
})

test('isRunSlotConflict recognises the index violation and nothing else', () => {
  const yes: unknown[] = [
    { code: 'P2002' },
    { code: 'P2002', meta: { target: RUN_SLOT_INDEX } },
    { code: 'P2002', meta: { target: ['campaign_id'] } },
    { code: 'P2010', message: `Raw query failed. Code: 23505. duplicate key value violates unique constraint "${RUN_SLOT_INDEX}"` },
  ]
  for (const e of yes) assert.equal(isRunSlotConflict(e), true, JSON.stringify(e))
  const no: unknown[] = [
    { code: 'P2002', meta: { target: ['run_id', 'email'] } },
    { code: 'P2002', meta: { target: 'email_campaign_recipients_run_id_email_key' } },
    { code: 'P2025' },
    { code: 'P2010', message: '23505 on some_other_index' },
    new Error('boom'),
    null,
    undefined,
  ]
  for (const e of no) assert.equal(isRunSlotConflict(e), false, String(e && JSON.stringify(e)))
})

test('isTransientTxError is the busy-database family only', () => {
  for (const code of ['P2024', 'P2028', 'P2034']) assert.equal(isTransientTxError({ code }), true, code)
  for (const e of [{ code: 'P2002' }, { code: 'P2025' }, new Error('P2024'), null]) assert.equal(isTransientTxError(e), false)
})

test('recipient claim and settlement predicates carry the attempt token', () => {
  assert.deepEqual(recipientClaimWhere('r', 'PENDING', 3), { id: 'r', status: 'PENDING', attempts: 3 })
  assert.deepEqual(recipientClaimWhere('r', 'DEFERRED', 0), { id: 'r', status: 'DEFERRED', attempts: 0 })
  assert.deepEqual(recipientSettlementWhere('r', 4), { id: 'r', status: 'SENDING', attempts: 4 })
})

test('runSlotLockKey is namespaced and deterministic', () => {
  assert.equal(runSlotLockKey('c1'), runSlotLockKey('c1'))
  assert.notEqual(runSlotLockKey('c1'), runSlotLockKey('c2'))
  assert.match(runSlotLockKey('c1'), /^email_campaign_run:c1$/)
})

// ── Transient read failures are retried, never suppressed (2026-09-15) ──

test('suppression_read_failed maps to DEFERRED, never SUPPRESSED', () => {
  const out = recipientStateForOutcome({ sent: false, reason: 'suppression_read_failed', outcomeClass: 'retryable' })
  assert.deepEqual(out, { status: 'DEFERRED', reason: 'suppression_read_failed' })
  assert.notEqual(out.status, 'SUPPRESSED')
  assert.equal(RECIPIENT_TERMINAL_STATES.has(out.status), false)
})

test('every *_read_failed, claim_lookup_failed and context_error: is DEFERRED', () => {
  for (const reason of ['state_read_failed', 'eligibility_read_failed', 'consent_read_failed', 'claim_lookup_failed', 'context_error:connection reset']) {
    assert.equal(recipientStateForOutcome({ sent: false, reason }).status, 'DEFERRED', reason)
  }
})

test('hard suppressions stay terminal SUPPRESSED; unsubscribe stays UNSUBSCRIBED', () => {
  for (const reason of ['hard_bounce', 'spam_complaint', 'admin_block', 'invalid_address', 'provider_rejected']) {
    assert.equal(recipientStateForOutcome({ sent: false, reason, outcomeClass: 'terminal' }).status, 'SUPPRESSED', reason)
  }
  assert.equal(recipientStateForOutcome({ sent: false, reason: 'unsubscribed' }).status, 'UNSUBSCRIBED')
  assert.equal(RECIPIENT_RETRYABLE_STATES.has('SUPPRESSED'), false)
  assert.equal(RECIPIENT_TERMINAL_STATES.has('SUPPRESSED'), true)
})

test('isTransientReadFailure: reads only, never a verdict', () => {
  for (const r of ['suppression_read_failed', 'state_read_failed', 'claim_lookup_failed', 'context_error:connection']) assert.equal(isTransientReadFailure(r), true, r)
  for (const r of ['hard_bounce', 'quiet_hours', 'no_marketing_consent', 'validation: x', 'context_missing:reviewUrl', 'context_ineligible:x', '', null, undefined]) {
    assert.equal(isTransientReadFailure(r), false, String(r))
  }
})

test('transientRetryDelayMs is exponential and capped', () => {
  const m = 60_000
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => transientRetryDelayMs(n)), [5 * m, 10 * m, 20 * m, 40 * m, 80 * m, 120 * m, 120 * m, 120 * m])
  assert.equal(transientRetryDelayMs(0), 5 * m)
})

test('planRecipientRetry: transient backoff grows per failure', () => {
  const now = 1_700_000_000_000
  const out = { sent: false, reason: 'suppression_read_failed' }
  const p0 = planRecipientRetry(out, 'DEFERRED', 0, now, 6)
  assert.equal(p0.action, 'transient')
  if (p0.action === 'transient') {
    assert.equal(p0.at.getTime(), now + 5 * 60_000)
    assert.equal(p0.transientAttempts, 1)
  }
  const p3 = planRecipientRetry(out, 'DEFERRED', 3, now, 6)
  assert.equal(p3.action === 'transient' && p3.at.getTime(), now + 40 * 60_000)
})

test('planRecipientRetry: exhaustion is FAILED (re-openable), never SUPPRESSED', () => {
  const p = planRecipientRetry({ sent: false, reason: 'suppression_read_failed' }, 'DEFERRED', 5, Date.now(), 6)
  assert.equal(p.action, 'exhausted')
  if (p.action === 'exhausted') {
    assert.equal(p.status, 'FAILED')
    assert.equal(p.reason, 'suppression_read_failed:retries_exhausted')
    assert.equal(p.transientAttempts, 6)
  }
  assert.ok(RECIPIENT_RETRYABLE_STATES.has('FAILED'), 'an operator can re-open an exhausted recipient')
  assert.ok(CAMPAIGN_TRANSIENT_MAX_ATTEMPTS >= 2, 'the budget must allow at least one retry')
})

test('planRecipientRetry: a policy deferral wins and does NOT reset the transient budget', () => {
  const retryAt = new Date(Date.now() + 3_600_000)
  const p = planRecipientRetry({ sent: false, reason: 'quiet_hours', retryAt }, 'DEFERRED', 4, Date.now(), 6)
  assert.deepEqual(p, { action: 'policy', at: retryAt, transientAttempts: 4 })
})

test('planRecipientRetry: sent and terminal outcomes never retry and reset the budget', () => {
  assert.deepEqual(planRecipientRetry({ sent: true }, 'SENT', 3), { action: 'none', transientAttempts: 0 })
  assert.deepEqual(planRecipientRetry({ sent: false, reason: 'hard_bounce' }, 'SUPPRESSED', 3), { action: 'none', transientAttempts: 0 })
  assert.deepEqual(planRecipientRetry({ sent: false, reason: 'marketing_opted_out' }, 'SKIPPED', 3), { action: 'none', transientAttempts: 0 })
})

// ── A DEFERRED row ALWAYS carries a due time (2026-09-15) ───────────────
//
// THE DEFECT THIS PINS. planRecipientRetry used to answer `action: 'none'` for
// any DEFERRED mapping that carried neither a guard retryAt nor a transient
// read reason — a consent withdrawal caught by the send-time recheck, a canary
// `not_in_rollout_allowlist` exclusion, `validation:`, `missing-configuration:`,
// or simply an unrecognised reason. applyOutcome then settled the row DEFERRED
// with next_attempt_at NULL and queued nothing. Sweep step 3b re-drives only
// dated rows, and runIsSettled requires DEFERRED === 0 — so the run never
// finalized, stayed SENDING, and (SENDING being in UNFINISHED_RUN_STATES, now
// enforced by the partial unique index) the campaign could never be dispatched
// again. One recipient could strand a whole campaign; during the documented
// canary, the whole audience did.

/** Refusals the guard can return with no retryAt of its own, with the class classifyBlock gives them. */
const UNDATED_REFUSALS: Array<{ reason: string; outcomeClass: 'terminal' | 'retryable' }> = [
  { reason: 'suppression_read_failed', outcomeClass: 'retryable' },
  { reason: 'state_read_failed', outcomeClass: 'retryable' },
  { reason: 'claim_lookup_failed', outcomeClass: 'retryable' },
  { reason: 'context_error:connection terminated unexpectedly', outcomeClass: 'retryable' },
  { reason: 'no_marketing_consent', outcomeClass: 'retryable' },
  { reason: 'not_in_rollout_allowlist', outcomeClass: 'retryable' },
  { reason: 'validation: to', outcomeClass: 'retryable' },
  { reason: 'missing-configuration:marketing-context:address', outcomeClass: 'retryable' },
  { reason: 'some_new_reason', outcomeClass: 'retryable' },
  { reason: 'marketing_opted_out', outcomeClass: 'terminal' },
  { reason: 'some_future_terminal_reason', outcomeClass: 'terminal' },
]

test('EVERY reason that maps to DEFERRED gets a plan with a due time — never action "none"', () => {
  const now = 1_700_000_000_000
  let deferred = 0
  for (const outcome of UNDATED_REFUSALS) {
    // Driven through the REAL mapping, so a reason reclassified later is
    // re-checked here rather than silently escaping the invariant.
    const mapped = recipientStateForOutcome({ sent: false, ...outcome })
    if (mapped.status !== 'DEFERRED') continue
    deferred++
    for (const prior of [0, 1, 4, 5, 9]) {
      const p = planRecipientRetry({ sent: false, reason: outcome.reason }, mapped.status, prior, now, 6)
      assert.notEqual(p.action, 'none', `${outcome.reason} @${prior} would be written DEFERRED with no due time`)
      if (p.action === 'exhausted') assert.equal(p.status, 'FAILED', outcome.reason)
      else assert.ok(p.action !== 'none' && p.at instanceof Date && Number.isFinite(p.at.getTime()), `${outcome.reason} @${prior} must carry a due time`)
    }
  }
  assert.ok(deferred >= 8, 'the list must still exercise the DEFERRED fall-through, not just terminal reasons')
})

test('planRecipientRetry: a retryable refusal is bounded too — FAILED at the cap, so the run can finalize', () => {
  const now = 1_700_000_000_000
  const p1 = planRecipientRetry({ sent: false, reason: 'not_in_rollout_allowlist' }, 'DEFERRED', 0, now, 6)
  assert.equal(p1.action, 'transient')
  if (p1.action === 'transient') {
    assert.equal(p1.at.getTime(), now + 5 * 60_000, 'the same bounded backoff a read failure gets')
    assert.equal(p1.transientAttempts, 1)
  }
  const p6 = planRecipientRetry({ sent: false, reason: 'not_in_rollout_allowlist' }, 'DEFERRED', 5, now, 6)
  assert.equal(p6.action, 'exhausted')
  if (p6.action === 'exhausted') {
    assert.equal(p6.status, 'FAILED', 'FAILED is visible on the run and re-openable — a stuck DEFERRED is neither')
    assert.equal(p6.reason, 'not_in_rollout_allowlist:retries_exhausted')
    assert.equal(p6.transientAttempts, 6)
  }
  // A reason-less deferral is bounded too, and its reason is still readable.
  const bare = planRecipientRetry({ sent: false }, 'DEFERRED', 5, now, 6)
  assert.equal(bare.action === 'exhausted' && bare.reason, 'deferred:retries_exhausted')
  assert.ok(runIsSettled({ SENT: 3, FAILED: 1, SKIPPED: 1 }), 'and the run settles once nothing is DEFERRED')
})

test('a transient-DEFERRED recipient blocks settlement; exhaustion settles COMPLETED_WITH_ERRORS', () => {
  assert.equal(runIsSettled({ SENT: 3, DEFERRED: 1 }), false)
  assert.equal(settledRunState({ SENT: 3, FAILED: 1 }, false), 'COMPLETED_WITH_ERRORS')
})
