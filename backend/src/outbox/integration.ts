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
  amountPaid: string
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
