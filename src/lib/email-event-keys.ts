// ════════════════════════════════════════════════════════════════════════
//  BUSINESS EVENT KEYS — the `eventId` half of an email's idempotency key.
//  ---------------------------------------------------------------------
//  guardedSend keys a logical send on email|template|journey|eventId|version
//  (src/lib/email-guard.ts buildIdempotencyKey). When a job carries no
//  businessEventKey the email worker falls back to bookingId, then leadId,
//  then the queue job id. Two rules follow, and every builder here enforces
//  them:
//
//    UNIQUE — two DIFFERENT logical sends must never share a key. Several
//             stages reuse ONE template (the 72h and 24h reminders both render
//             'job-reminder'), so the stage must be part of the key or the
//             second stage is refused as a duplicate of the first.
//    STABLE — the SAME logical send must produce the same key on every retry
//             and every re-enqueue, so it can never be delivered twice. Never
//             derived from a timestamp, a random id or a queue job id.
//
//  These are DATABASE keys (email_sends.idempotency_key). Colons are legal
//  here; queue job ids are built separately (email-deferral.ts).
// ════════════════════════════════════════════════════════════════════════

export type JobReminderType = 'job-reminder-72h' | 'job-reminder-24h'

/**
 * Pre-move reminder — one key per booking, PER OFFSET, PER MOVE DATE.
 *
 * The move date is part of the identity because a rescheduled move is a new
 * logical reminder: onMoveDateSet re-anchors both stages, and keying on the
 * booking alone would refuse them as duplicates of the old date's reminders.
 * A retry for the SAME date still produces the same key.
 */
export function jobReminderEventKey(bookingId: string, type: JobReminderType, moveAt: Date | null): string {
  const date = moveAt && Number.isFinite(moveAt.getTime()) ? moveAt.toISOString() : 'no-date'
  return `booking:${bookingId}:${type}:${date}`
}

/**
 * Admin "resend receipt" — one logical send per deliberate click.
 * A minute bucket absorbs a double-click and stays stable across the queue's
 * own retries of that job; a later click is a new, intended send.
 */
export function receiptResendEventKey(bookingId: string, at: Date): string {
  return `booking:${bookingId}:payment-receipt:resend:${Math.floor(at.getTime() / 60_000)}`
}

/** Lead-scoped journey stage (quote follow-up, lead nurture). */
export function leadStageEventKey(leadId: string, stage: string): string {
  return `lead:${leadId}:${stage}`
}

/** Booking-scoped journey stage (abandoned checkout, balance reminder…). */
export function bookingStageEventKey(bookingId: string, stage: string): string {
  return `booking:${bookingId}:${stage}`
}
