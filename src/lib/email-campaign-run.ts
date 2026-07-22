// ════════════════════════════════════════════════════════════════════════
//  CAMPAIGN RUN + RECIPIENT STATE MACHINES (owner spec 2026-07-22)
//  ---------------------------------------------------------------------
//  Pure functions only. The dispatch SERVICE (email-campaign-dispatch.ts)
//  does the I/O; everything here takes data and returns verdicts, so the
//  state machines are offline-testable the same way email-campaign.ts is.
//
//  WHY A RUN IS A SEPARATE RECORD FROM THE CAMPAIGN: the campaign is the
//  editable CONFIGURATION; a run is one immutable EXECUTION of it. The run
//  carries a frozen snapshot of what was dispatched, so editing the campaign
//  afterwards can never silently change what an active run is sending —
//  the same reasoning as EmailAutomationVersion.
// ════════════════════════════════════════════════════════════════════════

import type { SendOutcome } from './email-guard'

// ── Run state machine ───────────────────────────────────────────────────

export type RunState =
  | 'PREPARING' // audience being resolved + recipient rows written
  | 'QUEUED' // batches enqueued, none processed yet
  | 'SENDING' // at least one batch has been processed
  | 'PAUSED' // owner paused; unprocessed recipients hold
  | 'CANCELLING' // owner cancelled; unprocessed recipients being marked
  | 'CANCELLED' // terminal
  | 'COMPLETED' // terminal — every recipient reached a terminal state, no failures
  | 'COMPLETED_WITH_ERRORS' // terminal — finished, but some recipients failed
  | 'FAILED' // terminal — preparation itself died

const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  PREPARING: ['QUEUED', 'FAILED', 'CANCELLING'],
  QUEUED: ['SENDING', 'PAUSED', 'CANCELLING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'],
  SENDING: ['PAUSED', 'CANCELLING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'],
  PAUSED: ['SENDING', 'QUEUED', 'CANCELLING'],
  CANCELLING: ['CANCELLED'],
  CANCELLED: [],
  COMPLETED: [],
  COMPLETED_WITH_ERRORS: [],
  FAILED: [],
}

export const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'CANCELLED',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
])

/** Run states in which a batch may still process recipients. */
export const RUN_SENDABLE_STATES: ReadonlySet<RunState> = new Set<RunState>(['QUEUED', 'SENDING'])

export const isRunState = (v: unknown): v is RunState =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(RUN_TRANSITIONS, v)

export function canTransitionRun(from: RunState, to: RunState): { ok: true } | { ok: false; error: string } {
  if (!isRunState(from)) return { ok: false, error: `Unknown run state "${from}".` }
  if (!isRunState(to)) return { ok: false, error: `Unknown run state "${to}".` }
  if (from === to) return { ok: false, error: `The run is already ${from}.` }
  if (!RUN_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: `A run cannot go from ${from} to ${to}. Allowed: ${RUN_TRANSITIONS[from].join(', ') || 'nothing — terminal'}.`,
    }
  }
  return { ok: true }
}

// ── Recipient state machine ─────────────────────────────────────────────

export type RecipientState =
  | 'PENDING' // created, not yet processed
  | 'SENDING' // claimed by a batch pass
  | 'SENT' // provider accepted (EmailSend went 'delivered')
  | 'DEFERRED' // quiet hours / frequency cap; retried at retryAt
  | 'SUPPRESSED' // on the suppression list
  | 'UNSUBSCRIBED' // unsubscribe-scope suppression
  | 'INELIGIBLE' // live recheck said the claim is no longer true
  | 'CONTEXT_INVALID' // real context could not be built
  | 'SKIPPED' // other terminal policy refusal (duplicate, invalid address…)
  | 'FAILED' // attempts exhausted / provider terminal failure
  | 'CANCELLED' // run cancelled before this recipient sent

/** Recipient states that will never be attempted again inside this run. */
export const RECIPIENT_TERMINAL_STATES: ReadonlySet<RecipientState> = new Set<RecipientState>([
  'SENT',
  'SUPPRESSED',
  'UNSUBSCRIBED',
  'INELIGIBLE',
  'CONTEXT_INVALID',
  'SKIPPED',
  'FAILED',
  'CANCELLED',
])

/** Recipient states a RETRY action may deliberately re-open. */
export const RECIPIENT_RETRYABLE_STATES: ReadonlySet<RecipientState> = new Set<RecipientState>(['FAILED', 'DEFERRED'])

/**
 * Map a guardedSend outcome onto a recipient state + machine-readable reason.
 *
 * The guard already wrote the canonical EmailSend row; this mapping is only
 * the ORCHESTRATION view of the same fact. It must never claim more than the
 * guard did — 'SENT' here means exactly "the guard reported sent:true".
 */
export function recipientStateForOutcome(outcome: SendOutcome): { status: RecipientState; reason: string | null } {
  if (outcome.sent) return { status: 'SENT', reason: null }

  const reason = outcome.reason
  // Deferrals carry a retryAt — the send is legitimate, just not now.
  if (outcome.retryAt) return { status: 'DEFERRED', reason }

  if (reason === 'unsubscribed') return { status: 'UNSUBSCRIBED', reason }
  if (reason === 'hard_bounce' || reason === 'spam_complaint' || reason === 'admin_block' || reason === 'suppression_read_failed') {
    return { status: 'SUPPRESSED', reason }
  }
  // Live-state recheck refusals: the audience claim is no longer true for them.
  if (
    /^status_not_allowed:|^booking_not_completed:|^booking_advanced:|^lead_status:/.test(reason) ||
    ['lead_converted', 'lead_lost', 'move_date_passed', 'deposit_already_paid', 'booking_deleted', 'lead_deleted', 'no_quote', 'no_email'].includes(reason)
  ) {
    return { status: 'INELIGIBLE', reason }
  }
  if (reason.startsWith('context_')) return { status: 'CONTEXT_INVALID', reason }
  if (reason === 'duplicate' || reason.startsWith('terminal:') || reason === 'invalid_email' || reason === 'blank_email' || reason === 'not_due' || reason === 'in_flight') {
    return { status: 'SKIPPED', reason }
  }
  if (reason === 'attempts_exhausted' || reason === 'ambiguous') return { status: 'FAILED', reason }
  // Retryable configuration/plumbing problems: keep the recipient re-drivable
  // by the retry sweep rather than closing them out.
  return { status: 'DEFERRED', reason }
}

// ── Finalization ────────────────────────────────────────────────────────

export type RecipientCounts = Partial<Record<RecipientState, number>>

/** True when no recipient can still make progress. */
export function runIsSettled(counts: RecipientCounts): boolean {
  return (counts.PENDING ?? 0) === 0 && (counts.SENDING ?? 0) === 0 && (counts.DEFERRED ?? 0) === 0
}

/** The terminal run state a settled run should land in. */
export function settledRunState(counts: RecipientCounts, wasCancelling: boolean): RunState {
  if (wasCancelling) return 'CANCELLED'
  return (counts.FAILED ?? 0) > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'
}

// ── Batching ────────────────────────────────────────────────────────────

/** Bounded batch size — one queue job processes at most this many recipients. */
export const CAMPAIGN_BATCH_SIZE = Math.max(1, Number(process.env.EMAIL_CAMPAIGN_BATCH_SIZE) || 25)

export function batchCount(totalRecipients: number, batchSize = CAMPAIGN_BATCH_SIZE): number {
  return totalRecipients <= 0 ? 0 : Math.ceil(totalRecipients / batchSize)
}

/** Deterministic queue job id for one batch of one run. */
export function campaignBatchJobId(runId: string, batchIndex: number): string {
  return `campaign-run:${runId}:batch:${batchIndex}`
}

/** Deterministic queue job id for one deferred-recipient retry. */
export function campaignRecipientJobId(recipientId: string, attempt: number): string {
  return `campaign-recipient:${recipientId}:attempt:${attempt}`
}

/**
 * The idempotency EVENT ID for every send in a run. Combined with the
 * recipient email + template inside buildIdempotencyKey, this makes a send
 * exactly-once PER RUN AND RECIPIENT: batch retries, worker restarts and
 * repeated dispatch calls all collapse onto the same EmailSend row.
 */
export function campaignRunEventId(runId: string): string {
  return `campaign-run:${runId}`
}

// ── Dispatch preconditions (pure parts) ─────────────────────────────────

/**
 * Detect a material edit after approval. The config's updatedAt moves on ANY
 * config write; approval clears on edit in the API — this is the belt to that
 * suspender, for rows that were changed by any other path.
 */
export function editedAfterApproval(config: { approvedAt: Date | null; updatedAt: Date }): boolean {
  if (!config.approvedAt) return true
  // 2s grace: the approval write itself bumps updatedAt.
  return config.updatedAt.getTime() > config.approvedAt.getTime() + 2000
}

/**
 * MASTER PROMOTIONAL SWITCH. Campaign dispatch and automation execution are
 * DISABLED until this is deliberately set — the fail-closed default the
 * staging rehearsal flips last. Lifecycle journeys keep their own flags.
 */
export function promotionsEnabled(): boolean {
  return process.env.EMAIL_PROMOTIONS_ENABLED === 'true'
}
