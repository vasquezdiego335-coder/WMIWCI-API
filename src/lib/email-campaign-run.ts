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

/** Every run state, in declaration order. */
export const RUN_STATES: readonly RunState[] = Object.keys(RUN_TRANSITIONS) as RunState[]

/**
 * Run states that block a NEW dispatch of the same campaign — RUN_STATES minus
 * RUN_TERMINAL_STATES.
 *
 * This list MUST equal the predicate of the partial unique index
 * "email_campaign_runs_one_unfinished_per_campaign"
 * (prisma/migrations/20260915120000_campaign_run_single_unfinished). The
 * status column is TEXT, not an enum, so a state added here without a NEW
 * migration silently falls outside the database's protection.
 * campaign-run-slot.test.ts ties the two together.
 */
export const UNFINISHED_RUN_STATES: readonly RunState[] = ['PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING']

/** The partial unique index that enforces one unfinished run per campaign. */
export const RUN_SLOT_INDEX = 'email_campaign_runs_one_unfinished_per_campaign'

/** Advisory-lock key serialising run-slot claims for ONE campaign. */
export function runSlotLockKey(campaignId: string): string {
  return `email_campaign_run:${campaignId}`
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * True when an error is the one-unfinished-run index firing.
 *
 * Prisma 5.22 maps Postgres 23505 from a model write to P2002; for an index the
 * datamodel does not know, meta.target carries the index name (or is absent).
 * A raw query surfaces it as P2010 with 23505 in the message. A P2002 on any
 * OTHER unique target (e.g. recipients' run_id+email) is not a slot conflict.
 * campaign-run-concurrency.test.ts pins the real shape against Postgres.
 */
export function isRunSlotConflict(err: unknown): boolean {
  const code = errorCode(err)
  if (!code && !(err instanceof Error)) return false
  const message = err instanceof Error ? err.message : String((err as { message?: unknown } | null)?.message ?? '')
  if (code === 'P2002') {
    const target = (err as { meta?: { target?: unknown } }).meta?.target
    if (target === undefined || target === null) return true
    const t = Array.isArray(target) ? target.join(',') : String(target)
    return t.includes(RUN_SLOT_INDEX) || t === 'campaign_id' || t === 'campaignId'
  }
  if (code === 'P2010' || message.includes('23505')) return message.includes(RUN_SLOT_INDEX)
  return false
}

/**
 * Transaction-level errors that mean "the database was busy", not "refused":
 * P2024 pool timeout, P2028 transaction API error (maxWait/timeout expired),
 * P2034 write conflict / deadlock. The caller retries later; nothing is wrong
 * with the campaign, so nothing is written to its statusNote.
 */
export function isTransientTxError(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'P2024' || code === 'P2028' || code === 'P2034'
}

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
  | 'DEFERRED' // quiet hours / cap / read failure / retryable refusal; ALWAYS retried at nextAttemptAt
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

// ── Recipient claim token ───────────────────────────────────────────────
//
// `attempts` is the claim token. Every move INTO SENDING increments it, and
// nothing else writes it (the stale sweep, cancel, reconcile and manual retry
// all leave it alone). So a claim made compare-and-set on the attempts value
// that was read owns token read+1, and a settlement conditioned on
// { status: SENDING, attempts: token } is refused once the sweep re-opened the
// row (status moved) or a newer attempt re-claimed it (attempts moved). A stale
// worker can therefore never overwrite a newer attempt's result.

/** CAS predicate for PENDING/DEFERRED → SENDING. */
export function recipientClaimWhere(id: string, from: 'PENDING' | 'DEFERRED', expectedAttempts: number) {
  return { id, status: from, attempts: expectedAttempts }
}

/** CAS predicate for settling a row this attempt still owns. */
export function recipientSettlementWhere(id: string, claimAttempt: number) {
  return { id, status: 'SENDING' as const, attempts: claimAttempt }
}

// ── Transient read failures (2026-09-15) ────────────────────────────────
//
// A failed database READ is not a verdict about the recipient. The guard
// already fails closed on `suppression_read_failed` (nothing is sent while the
// suppression status is unknown); what it must never become is a recorded
// SUPPRESSED row, or a spent automation stage. These reasons defer with a
// bounded backoff and are retried; after the budget they are FAILED — visible
// and re-openable — never SUPPRESSED.

/** Suppression reasons that are real, permanent verdicts. */
export const HARD_SUPPRESSION_REASONS: ReadonlySet<string> = new Set([
  'hard_bounce',
  'spam_complaint',
  'admin_block',
  'invalid_address',
  'provider_rejected',
])

/** A reason that means "a read failed", not "this person must not be mailed". */
export function isTransientReadFailure(reason: string | null | undefined): boolean {
  if (!reason) return false
  return reason.endsWith('_read_failed') || reason === 'claim_lookup_failed' || reason.startsWith('context_error:')
}

export const TRANSIENT_RETRY_BASE_MS = 5 * 60_000
export const TRANSIENT_RETRY_CAP_MS = 2 * 60 * 60_000

/** Exponential, capped: failure 1 waits 5m, then 10m, 20m, 40m, 80m, 120m… */
export function transientRetryDelayMs(failureNumber: number, baseMs = TRANSIENT_RETRY_BASE_MS, capMs = TRANSIENT_RETRY_CAP_MS): number {
  if (!Number.isFinite(failureNumber) || failureNumber < 1) return baseMs
  return Math.min(capMs, baseMs * 2 ** (failureNumber - 1))
}

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * How many consecutive transient failures a campaign recipient may have before
 * it is FAILED. With 6 the waits are 5, 10, 20, 40 and 80 minutes (about 2.6h)
 * and the sixth failure settles the row.
 */
export const CAMPAIGN_TRANSIENT_MAX_ATTEMPTS = positiveIntFromEnv(process.env.EMAIL_CAMPAIGN_TRANSIENT_MAX_ATTEMPTS, 6)

export type RecipientRetryPlan =
  | { action: 'none'; transientAttempts: number }
  | { action: 'policy'; at: Date; transientAttempts: number }
  | { action: 'transient'; at: Date; transientAttempts: number }
  | { action: 'exhausted'; status: 'FAILED'; reason: string; transientAttempts: number }

/**
 * Decide the retry for a recipient whose outcome mapped to `mappedStatus`.
 *
 *  - sent, or any non-DEFERRED state → none; the transient counter resets.
 *  - a guard retryAt (quiet hours, caps) → policy deferral at retryAt. The
 *    counter is KEPT, so flapping reads cannot reset the budget by landing in
 *    quiet hours between failures.
 *  - EVERY other DEFERRED mapping — a transient read failure, and equally a
 *    retryable refusal with no due time of its own (no_marketing_consent,
 *    not_in_rollout_allowlist, validation:, missing-configuration:, an
 *    unrecognised reason) → the next backoff step, or FAILED with
 *    `<reason>:retries_exhausted` once the budget is spent.
 *
 * THE INVARIANT THIS ENFORCES: a DEFERRED recipient row ALWAYS carries a due
 * time. Sweep step 3b re-drives only rows that have one, and runIsSettled
 * requires DEFERRED === 0 — so an undated DEFERRED row is unreachable, holds
 * its run in SENDING forever, and (SENDING being an unfinished state) makes the
 * campaign permanently undispatchable. Until 2026-09-15 this function answered
 * 'none' there, which wrote exactly such a row.
 */
export function planRecipientRetry(
  outcome: { sent: boolean; reason?: string | null; retryAt?: Date | null },
  mappedStatus: RecipientState,
  priorTransientAttempts: number,
  now: number = Date.now(),
  max: number = CAMPAIGN_TRANSIENT_MAX_ATTEMPTS
): RecipientRetryPlan {
  const prior = Math.max(0, priorTransientAttempts || 0)
  if (outcome.sent || mappedStatus !== 'DEFERRED') return { action: 'none', transientAttempts: 0 }
  if (outcome.retryAt) return { action: 'policy', at: outcome.retryAt, transientAttempts: prior }
  const n = prior + 1
  if (n >= max) {
    return { action: 'exhausted', status: 'FAILED', reason: `${outcome.reason ?? 'deferred'}:retries_exhausted`.slice(0, 300), transientAttempts: n }
  }
  return { action: 'transient', at: new Date(now + transientRetryDelayMs(n)), transientAttempts: n }
}

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
  // A failed READ (suppression list, state, claim lookup, context) is not a
  // verdict: nothing was sent, and the recipient is retried with backoff
  // (planRecipientRetry). It was SUPPRESSED until 2026-09-15, which closed the
  // recipient for good and made an outage look like a real suppression.
  if (isTransientReadFailure(reason)) return { status: 'DEFERRED', reason }

  if (reason === 'unsubscribed') return { status: 'UNSUBSCRIBED', reason }
  if (HARD_SUPPRESSION_REASONS.has(reason)) return { status: 'SUPPRESSED', reason }
  // Live-state recheck refusals: the audience claim is no longer true for them.
  if (
    /^status_not_allowed:|^booking_not_completed:|^booking_advanced:|^lead_status:/.test(reason) ||
    ['lead_converted', 'lead_lost', 'move_date_passed', 'deposit_already_paid', 'booking_deleted', 'lead_deleted', 'no_quote', 'no_email', 'has_quote', 'previous_customer', 'no_recheck_subject'].includes(reason)
  ) {
    return { status: 'INELIGIBLE', reason }
  }
  if (reason.startsWith('context_')) return { status: 'CONTEXT_INVALID', reason }
  if (reason === 'duplicate' || reason.startsWith('terminal:') || reason === 'invalid_email' || reason === 'blank_email' || reason === 'not_due' || reason === 'in_flight') {
    return { status: 'SKIPPED', reason }
  }
  if (reason === 'attempts_exhausted' || reason === 'ambiguous') return { status: 'FAILED', reason }
  // THE GUARD ALREADY CALLED IT FINAL. classifyBlock marks marketing_opted_out,
  // unsubscribed, status_not_allowed:… 'terminal'; a reason it classifies that
  // way will refuse identically forever, so deferring it only burns the retry
  // budget and holds the run open. SKIPPED is the "other terminal policy
  // refusal" bucket. The specific terminal states above still win.
  if (outcome.outcomeClass === 'terminal') return { status: 'SKIPPED', reason }
  // Retryable configuration/plumbing problems: keep the recipient re-drivable
  // by the retry sweep rather than closing them out. planRecipientRetry gives
  // this row a due time and a bounded budget — never an undated deferral.
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
  return `campaign-run__${runId}__batch__${batchIndex}`
}

/** Deterministic queue job id for one deferred-recipient retry. */
export function campaignRecipientJobId(recipientId: string, attempt: number): string {
  return `campaign-recipient__${recipientId}__attempt__${attempt}`
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
