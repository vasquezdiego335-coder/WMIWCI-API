// ════════════════════════════════════════════════════════════════════════
//  CANONICAL BOOKING ELIGIBILITY — finding EMAIL-P0-02.
//  ---------------------------------------------------------------------
//  THE DEFECT THIS REPLACES: there were THREE different answers to "may this
//  template go out for this booking?"
//
//    1. src/emails/status.ts `TEMPLATE_ALLOWED_STATUSES` — the correct, tested
//       table (final-confirmation ⇒ CONFIRMED_STATES). But `statusMismatchReason`
//       returns null when no status is supplied, so it is an OPT-IN gate that
//       only fires if a sender happens to put `bookingStatus` in the payload.
//    2. src/workers/email.worker.ts `stillWantedForBooking` — a hand-written
//       switch that, for final-confirmation, blocked ONLY 'CANCELLED'. A
//       confirmation could therefore be sent for DRAFT, PENDING_PAYMENT,
//       PENDING_APPROVAL or ARCHIVED.
//    3. src/outbox/services/emailService.ts — passed NEITHER a payload (so gate
//       1 never ran) NOR a recheck (so gate 2 never ran). The outbox is the path
//       production actually uses when OUTBOX_ENABLED=true. It had no gate at all.
//
//  THIS MODULE IS NOW THE ONLY ANSWER. Both the queue worker and the outbox call
//  `bookingEligibility()`, which RELOADS the booking from the database
//  immediately before the idempotency claim. A status value carried in a queue
//  payload is never trusted — it may be days old.
//
//  Two things are checked, not one:
//    • the booking STATUS is in the template's allowed set (status.ts owns that
//      table — it is imported, never duplicated here), and
//    • the WORKFLOW CONDITION the template asserts is really true (a
//      "your booking is approved" email requires the deposit to be captured,
//      not merely a status that happens to be CONFIRMED).
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { TEMPLATE_ALLOWED_STATUSES, type BookingStatus } from '../emails/status'

const log = queueLogger.child({ mod: 'email-eligibility' })

const DAY_MS = 24 * 60 * 60 * 1000

/** The booking facts every template gate is allowed to reason about. */
export type BookingSnapshot = {
  status: BookingStatus | string
  isInternalTest: boolean
  depositPaid: boolean
  completedAt: Date | null
  requestedDate: Date | null
  confirmedDate: Date | null
  scheduledStart: Date | null
}

/** The move date, using the same precedence as the scheduling layer. */
export function effectiveMoveDate(b: Pick<BookingSnapshot, 'scheduledStart' | 'confirmedDate' | 'requestedDate'>) {
  return b.scheduledStart ?? b.confirmedDate ?? b.requestedDate
}

/** Has the move day fully passed? A job at 9am is still "today" all day. */
export function movePassed(b: BookingSnapshot, now: Date = new Date()): boolean {
  const d = effectiveMoveDate(b)
  return d ? d.getTime() + DAY_MS < now.getTime() : false
}

/**
 * Templates whose truthfulness needs MORE than a status match.
 * A status is a label; these are the conditions the copy actually asserts.
 */
const WORKFLOW_CONDITIONS: Record<string, (b: BookingSnapshot) => string | null> = {
  // "Your booking is approved" asserts the deposit was captured. A booking can
  // be flipped to CONFIRMED by an admin without the capture having happened, so
  // the status alone is not proof of what this email claims.
  'final-confirmation': (b) => (b.depositPaid ? null : 'deposit_not_captured'),

  // Recovery mail is only honest while the deposit is genuinely outstanding.
  'abandoned-checkout': (b) => (b.depositPaid ? 'deposit_already_paid' : null),
  'abandoned-checkout-2': (b) => (b.depositPaid ? 'deposit_already_paid' : null),
  'abandoned-checkout-3': (b) => (b.depositPaid ? 'deposit_already_paid' : null),

  // Post-job mail requires the job to have actually finished.
  'job-completion': (b) => (b.completedAt ? null : 'not_completed'),
  'review-request': (b) => (b.completedAt ? null : 'not_completed'),
  'review-reminder': (b) => (b.completedAt ? null : 'not_completed'),
  referral: (b) => (b.completedAt ? null : 'not_completed'),
  'referral-ask': (b) => (b.completedAt ? null : 'not_completed'),
  'repeat-reminder': (b) => (b.completedAt ? null : 'not_completed'),
}

/** Templates that must never be sent once the move date has gone by. */
const MOVE_DATE_SENSITIVE = new Set([
  'abandoned-checkout',
  'abandoned-checkout-2',
  'abandoned-checkout-3',
  'job-reminder',
])

/**
 * PURE eligibility decision over an already-loaded booking.
 * Returns a machine-readable block reason, or null to proceed.
 * Unit-testable offline against every BookingStatus value.
 */
export function bookingBlockReason(
  template: string,
  booking: BookingSnapshot | null,
  now: Date = new Date()
): string | null {
  if (!booking) return 'booking_deleted'

  // Internal test bookings never generate customer mail, in any state.
  if (booking.isInternalTest) return 'internal_test_booking'

  // 1. STATUS — the single table in src/emails/status.ts. A template with no
  //    entry there has no status constraint; its other gates still apply.
  const allowed = TEMPLATE_ALLOWED_STATUSES[template]
  if (allowed && !(allowed as readonly string[]).includes(booking.status)) {
    return `status_not_allowed:${booking.status}`
  }

  // 2. WORKFLOW CONDITION — is the thing the copy asserts actually true?
  const condition = WORKFLOW_CONDITIONS[template]
  if (condition) {
    const failed = condition(booking)
    if (failed) return failed
  }

  // 3. MOVE DATE — never chase or remind about a date that has gone.
  if (MOVE_DATE_SENSITIVE.has(template) && movePassed(booking, now)) return 'move_date_passed'

  return null
}

/**
 * LIVE eligibility: reload the booking and decide.
 *
 * This is what every booking-scoped send path calls as its `recheck`, so the
 * decision is made against the database state at SEND time — not against a
 * status copied into a queue payload when the job was created.
 *
 * FAILS CLOSED: a read error blocks the send. A booking we cannot verify is a
 * booking we must not email about.
 */
export async function bookingEligibility(template: string, bookingId: string): Promise<string | null> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        isInternalTest: true,
        depositPaid: true,
        completedAt: true,
        requestedDate: true,
        confirmedDate: true,
        scheduledStart: true,
      },
    })
    const reason = bookingBlockReason(template, booking)
    if (reason) log.info({ bookingId, template, reason }, 'booking eligibility BLOCKED the send')
    return reason
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), bookingId, template },
      'eligibility read failed — failing closed'
    )
    return 'eligibility_read_failed'
  }
}

/** Convenience: bind a template + booking into a `recheck` callback. */
export const bookingRecheck = (template: string, bookingId: string) => () => bookingEligibility(template, bookingId)
