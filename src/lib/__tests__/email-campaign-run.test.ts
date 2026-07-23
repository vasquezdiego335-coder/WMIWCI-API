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
