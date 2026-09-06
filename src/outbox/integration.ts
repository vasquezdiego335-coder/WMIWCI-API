import { handlePaymentCompleted } from './controllers/stripeController'
import { handleApprove } from './controllers/discordController'
import { offerNewDates, customerPicksDate } from './controllers/rescheduleController'
import { scheduledQueue } from '../lib/queues'

// ════════════════════════════════════════════════════════════════════════
//  Outbox integration facade.
//  A single feature flag (OUTBOX_ENABLED) cuts live trigger points over to the
//  outbox. When ON, the existing email at that point is skipped and the outbox
//  emits the event instead — never both (no duplicate emails). When OFF
//  (default), these are all no-ops and behavior is unchanged.
//
//  Every emit is NEVER-THROWING: a failure (e.g. the migration hasn't run) is
//  logged and swallowed so it can't break the live payment/approval flow.
//  ⚠️ Consequence: with the flag ON, a swallowed emit means that email is
//  skipped — monitor email_jobs for failed/missing rows.
// ════════════════════════════════════════════════════════════════════════

export function outboxEnabled(): boolean {
  return process.env.OUTBOX_ENABLED === 'true'
}

/**
 * Wake the durable outbox only when a real business event is written.
 *
 * The worker host used to query Postgres every three seconds even when there
 * was no email to send. That kept Neon's compute active around the clock. A
 * BullMQ nudge preserves immediate delivery without any idle database traffic;
 * the aligned recovery cron in scheduled.worker.ts covers Redis outages and a
 * process dying after the transaction commits but before this enqueue.
 */
async function nudgeOutbox(label: string, bookingId: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      scheduledQueue.add(
        'outbox-email-drain',
        { type: 'outbox-email-drain', bookingId, payload: { trigger: label } },
        // A nudge has no durable value after it succeeds. The email_jobs row is
        // the durable record and is independently re-driven by the recovery cron.
        { removeOnComplete: true, removeOnFail: { count: 100 } },
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('outbox drain nudge timed out after 3s')),
          3000,
        )
      }),
    ])
  } catch (err) {
    // The event is already committed at this point. Do not make the booking
    // request fail or fall back to a duplicate legacy email. Recovery runs on
    // the next aligned interval and will claim the durable row.
    console.error(
      `[outbox] ${label} committed but its immediate drain nudge failed; ` +
        `the recovery sweep will retry:`,
      err instanceof Error ? err.message : err,
    )
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function safe(
  label: string,
  bookingId: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await fn()
    await nudgeOutbox(label, bookingId)
    return true
  } catch (err) {
    console.error(`[outbox] ${label} failed (swallowed):`, err instanceof Error ? err.message : err)
    return false
  }
}

export async function emitPaymentCompleted(p: {
  bookingId: string
  amountPaid: string
  customerName: string
  customerEmail: string
  requestedDate: string | null
  items?: string
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitPaymentCompleted', p.bookingId, () => handlePaymentCompleted(p))
}

export async function emitApproved(p: {
  bookingId: string
  approvedBy: string
  customerName: string
  customerEmail: string
  requestedDate: string | null
  items?: string
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitApproved', p.bookingId, () => handleApprove(p))
}

export async function emitRescheduleRequested(p: {
  bookingId: string
  offeredDates: string[]
  rescheduleUrl: string
  customerName: string
  customerEmail: string
  requestedDate: string | null
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitRescheduleRequested', p.bookingId, () => offerNewDates(p))
}

export async function emitNewDatePicked(p: {
  bookingId: string
  newDate: string
  customerName: string
  customerEmail: string
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitNewDatePicked', p.bookingId, () => customerPicksDate(p))
}
