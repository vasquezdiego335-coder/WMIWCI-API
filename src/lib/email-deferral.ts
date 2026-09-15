// ════════════════════════════════════════════════════════════════════════
//  EMAIL DEFERRAL + QUEUE JOB IDS — pure helpers (no prisma/redis/react)
//  ---------------------------------------------------------------------
//  Shared by src/workers/email.worker.ts and the transactional outbox, and
//  kept import-free of infrastructure so every rule here is unit-testable
//  offline.
//
//  1. WHEN TO RE-DRIVE A REFUSED SEND. A refusal is re-queued only when the
//     guard supplied a due time:
//       • `retryAt`      — a POLICY deferral (quiet hours, caps, kill switch);
//       • `notDueUntil`  — reason 'not_due': the logical send already has a
//                          scheduled attempt (e.g. after a definitive provider
//                          rejection set nextAttemptAt = now + 60s × attempts).
//     Before this, a BullMQ retry landing inside that backoff got 'not_due'
//     with no time attached, logged "refused" and COMPLETED — the email was
//     never attempted again, because nothing polls email_sends.
//     'in_flight' is deliberately never re-driven (a live claim must not be
//     raced into a stale takeover) and neither is 'ambiguous' (the provider
//     may already have accepted the message).
//
//  2. BULLMQ CUSTOM JOB IDS. BullMQ 5.x rejects a custom id containing ":"
//     unless it has exactly three ":"-separated parts — a compatibility carve
//     out for its own `repeat:<key>:<millis>` ids. The old deferral id
//     `${job.id}:deferred:${reason}` passed on the FIRST hop (3 parts) and threw
//     "Custom Id cannot contain :" on the SECOND (5 parts), exhausting the job's
//     attempts and dropping the email. Ids built here never contain ":".
// ════════════════════════════════════════════════════════════════════════

/** The subset of SendOutcome these helpers read (kept structural on purpose). */
export type RefusalLike =
  | { sent: true }
  | {
      sent: false
      reason: string
      retryAt?: Date
      notDueUntil?: Date
      outcomeClass?: string
      recorded?: boolean
    }

/** Small buffer so a delayed job never fires a hair before the row is due. */
export const DEFERRAL_BUFFER_MS = 1_000

/**
 * The epoch-ms time to re-drive a refused send at, or null when it must not be
 * re-driven automatically.
 */
export function deferralDueAt(outcome: RefusalLike, now: number = Date.now()): number | null {
  if (outcome.sent) return null
  if (outcome.reason === 'ambiguous' || outcome.reason === 'in_flight') return null
  const due = outcome.retryAt ?? (outcome.reason === 'not_due' ? outcome.notDueUntil : undefined)
  if (!due || !Number.isFinite(due.getTime())) return null
  return Math.max(due.getTime(), now) + DEFERRAL_BUFFER_MS
}

/**
 * Is this refusal TEMPORARY — i.e. should a durable record (an outbox row) stay
 * retryable rather than be closed?
 *
 *   true  → a due time exists, the claim lookup failed, or the guard classified
 *           the refusal 'retryable' (DB read failure, missing configuration…).
 *   false → terminal policy (suppressed, ineligible, duplicate), 'in_flight'
 *           (another attempt owns it) and 'ambiguous' (never auto-resend).
 */
export function isTransientRefusal(outcome: RefusalLike): boolean {
  if (outcome.sent) return false
  if (outcome.reason === 'ambiguous' || outcome.outcomeClass === 'ambiguous') return false
  if (outcome.reason === 'in_flight' || outcome.reason === 'duplicate') return false
  if (deferralDueAt(outcome) !== null) return true
  if (outcome.reason === 'claim_lookup_failed') return true
  if (outcome.recorded === false) return true
  return outcome.outcomeClass === 'retryable' || outcome.outcomeClass === 'deferred'
}

/** BullMQ's own rule for a custom job id (bullmq/dist/cjs/classes/job.js). */
export function isBullmqSafeCustomId(id: string): boolean {
  if (!id) return false
  if (`${parseInt(id, 10)}` === id) return false // "Custom Id cannot be integers"
  // Stricter than BullMQ on purpose: we never rely on its 3-part carve-out.
  return !id.includes(':')
}

/**
 * Turn any identity string (which may legitimately contain ":" — DB dedupe keys
 * do) into a deterministic BullMQ-safe job id. The DATABASE key is never
 * changed; only its queue spelling is.
 */
export function queueSafeJobId(identity: string): string {
  const safe = String(identity).replace(/:/g, '__')
  return `${parseInt(safe, 10)}` === safe ? `id__${safe}` : safe
}

/**
 * Colon-free, deterministic, per-hop-unique job id for a deferred email.
 *
 * Rooted at the ORIGINAL job id whatever hop shape (legacy colon or current)
 * the parent has, and carrying the due time, so every hop is unique and never
 * collides with its still-active parent — a same-id add is a silent no-op in
 * BullMQ, which would drop the email.
 */
export function deferredJobId(parentJobId: string | number | undefined, reason: string, dueAtMs: number): string {
  const parent = String(parentJobId ?? 'nojob')
  const root = parent.split(/__deferred__|:deferred:/)[0].replace(/:/g, '_') || 'nojob'
  const safeReason = (reason.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown').slice(0, 60)
  return `${root}__deferred__${safeReason}__${Math.floor(dueAtMs)}`
}
