import { handlePaymentCompleted } from './controllers/stripeController'
import { handleApprove } from './controllers/discordController'
import { offerNewDates, customerPicksDate } from './controllers/rescheduleController'

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

async function safe(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    console.error(`[outbox] ${label} failed (swallowed):`, err instanceof Error ? err.message : err)
    return false
  }
}

export async function emitPaymentCompleted(p: {
  bookingId: string
  /** ITEM C1 (round 8) — dollars STRIPE reported it authorized, or absent. It
   *  becomes the "$X hold" line in the customer's pre-approval email, so it may
   *  never be defaulted to the house fee. See PaymentCompletedPayload. */
  amountPaid?: string | null
  customerName: string
  customerEmail: string
  requestedDate: string | null
  items?: string
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitPaymentCompleted', () => handlePaymentCompleted(p))
}

export async function emitApproved(p: {
  bookingId: string
  approvedBy: string
  customerName: string
  customerEmail: string
  requestedDate: string | null
  items?: string
  /** ITEM D2 — the amount STRIPE reported for this capture, in cents, or null
   *  when it reported none. Optional so the approval path can be updated
   *  independently; omitted means the confirmation falls back to the COMPLETED
   *  Payment row and, failing that, names no amount. It must NEVER be filled
   *  from `booking.depositAmount`. */
  capturedAmountCents?: number | null
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitApproved', () => handleApprove(p))
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
  return safe('emitRescheduleRequested', () => offerNewDates(p))
}

export async function emitNewDatePicked(p: {
  bookingId: string
  newDate: string
  customerName: string
  customerEmail: string
}): Promise<boolean> {
  if (!outboxEnabled()) return false
  return safe('emitNewDatePicked', () => customerPicksDate(p))
}
