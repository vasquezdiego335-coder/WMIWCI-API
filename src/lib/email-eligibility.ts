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
import { classifyTemplate, inRolloutAllowlist, rolloutAllowlist } from './email-guard'
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
  /** Booking.startTimeKnown (item R2-1). FALSE = the move is scheduled by DATE
   *  and no crew hour exists; `effectiveMoveDate` then returns a 00:00 ET DAY
   *  ANCHOR whose time-of-day means nothing. Optional so a `select` written
   *  before migration 20260812010000_start_time_known — or against a DB where
   *  it is not applied yet — still satisfies this type. */
  startTimeKnown?: boolean | null
  // ── PROMOTIONAL CONSENT (owner spec 2026-08-06) ───────────────────────
  //  BOTH FIELDS ARE REQUIRED, and that is the point. A `select` that omits
  //  them does not compile, so a future send path cannot quietly re-open the
  //  hole described on `promotionalConsentBlockReason` below. This is the same
  //  discipline PR #31 applied to LeadState.emailMarketingConsent.
  /** TRI-STATE. null = never asked, false = asked and declined. Neither sends. */
  customerMarketingConsent: boolean | null
  /** The TCPA STOP mirror. True = stop all marketing, whatever consent says. */
  customerMarketingOptOut: boolean
}

/**
 * The move date, using the same precedence as the scheduling layer.
 *
 * ⚠ ITEM R2-1 — this is a DATE, and only sometimes a TIME. When
 * `moveTimeIsKnown(b)` is false the value is the booking's 00:00 ET day anchor
 * and its hour is not a fact about the job. Callers may sort, compare and do
 * day math on it freely; NOTHING may render its time-of-day without checking
 * `moveTimeIsKnown` first (scheduling.formatMoveWhen does that check for you).
 * Printing it blind is how "12:00 AM" reached the approval notification, the
 * daily digest and the Action Center copy.
 */
export function effectiveMoveDate(b: Pick<BookingSnapshot, 'scheduledStart' | 'confirmedDate' | 'requestedDate'>) {
  return b.scheduledStart ?? b.confirmedDate ?? b.requestedDate
}

/**
 * Does this booking have a real crew hour behind its move date (item R2-1)?
 * A stored `scheduledStart` is proof of one — nothing writes that column
 * without a committed time any more. Otherwise the column decides, and an
 * unreadable/absent `startTimeKnown` keeps the legacy assumption (true).
 */
export function moveTimeIsKnown(b: Pick<BookingSnapshot, 'scheduledStart' | 'startTimeKnown'>): boolean {
  if (b.scheduledStart) return true
  return b.startTimeKnown !== false
}

/** Has the move day fully passed? A job at 9am is still "today" all day.
 *  Day math only — safe on a day-anchor date (a day-level move "passes" at
 *  00:00 ET the day after, which is the honest reading of a date-only job). */
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

// ════════════════════════════════════════════════════════════════════════
//  PROMOTIONAL CONSENT ON BOOKING-SCOPED EMAIL (owner spec 2026-08-06)
//  ---------------------------------------------------------------------
//  THE HOLE THIS CLOSES, stated plainly. Seven templates in this system are
//  PROMOTIONAL by email-guard.classifyTemplate — abandoned-checkout 1/2/3,
//  review-request, review-reminder, referral and repeat-reminder. Everything
//  downstream treated them that way: frequency caps, quiet hours, an
//  unsubscribe link, a marketing compliance block. Everything EXCEPT the gate
//  that decides whether to send them.
//
//  `bookingBlockReason` checked status, deposit, completion and the move date,
//  and never asked whether the customer had agreed to be marketed to.
//  `followups.runFollowup` checked `Customer.marketingOptOut` — a flag set ONLY
//  by the inbound-SMS STOP webhook, so in practice always false. A customer who
//  booked before the checkbox existed (consent NULL, and deliberately kept
//  NULL) therefore received a review ask, a referral ask and a repeat-booking
//  ask, none of which they ever opted into.
//
//  This is the same defect PR #31 fixed for quote follow-ups, one layer down:
//  the LEAD side was closed and the BOOKING side was left open.
//
//  WHY IT LIVES HERE. `bookingEligibility()` is the recheck EVERY booking-scoped
//  send path already runs immediately before the provider call — the BullMQ
//  worker, the outbox and followups.ts all call it. Putting the rule here means
//  a path added tomorrow inherits it without knowing it exists.
//
//  THE CLASSIFICATION IS NOT RESTATED. It is read from classifyTemplate, so
//  moving a template between the promotional and transactional sets moves this
//  gate with it — there is no second list to drift.
// ════════════════════════════════════════════════════════════════════════

/** Consent verdict for a promotional booking-scoped send. Null = proceed. */
export function promotionalConsentBlockReason(booking: BookingSnapshot): string | null {
  // STOP beats consent: someone who texted STOP has withdrawn, whatever an
  // older checkbox says.
  if (booking.customerMarketingOptOut) return 'marketing_opted_out'
  // TRI-STATE, and both false and null refuse. Absence of a decision is not
  // permission — the rule the whole system is built on (src/lib/consent.ts).
  if (booking.customerMarketingConsent !== true) return 'no_marketing_consent'
  return null
}

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

  // 0. MAY WE MARKET TO THIS PERSON AT ALL? Checked before the template's own
  //    conditions because it is the more fundamental fact: for a promotional
  //    template, no amount of correct booking state makes the send permitted.
  if (classifyTemplate(template) === 'promotional') {
    const consent = promotionalConsentBlockReason(booking)
    if (consent) return consent
  }

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
    const row = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        isInternalTest: true,
        depositPaid: true,
        completedAt: true,
        requestedDate: true,
        confirmedDate: true,
        scheduledStart: true,
        // The consent columns the promotional gate needs. Loaded on EVERY
        // recheck, not only for promotional templates: one query, and a
        // template that changes class later cannot find the field missing.
        customer: { select: { emailMarketingConsent: true, marketingOptOut: true } },
      },
    })
    const booking: BookingSnapshot | null = row
      ? {
          status: row.status,
          isInternalTest: row.isInternalTest,
          depositPaid: row.depositPaid,
          completedAt: row.completedAt,
          requestedDate: row.requestedDate,
          confirmedDate: row.confirmedDate,
          scheduledStart: row.scheduledStart,
          // A booking with no customer row is not a person we may market to.
          // Defaulting to null (never asked) rather than true is the whole
          // point of failing closed.
          customerMarketingConsent: row.customer?.emailMarketingConsent ?? null,
          customerMarketingOptOut: row.customer?.marketingOptOut ?? false,
        }
      : null
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

/**
 * SCHEDULE-TIME consent check for a booking's customer.
 *
 * The send-time gate above is the guarantee. This exists so a sequence that is
 * certain to be refused is never queued at all — the reason lands in the log
 * the moment the trigger fires, rather than days later when three stages
 * silently do nothing. Exactly the two-gate shape PR #31 used for the quote
 * journey (scheduler + send gate), applied to the booking journeys.
 *
 * FAILS CLOSED: a read error reports a block, so an outage cannot enrol
 * somebody we could not verify.
 */
export async function bookingMarketingBlockReason(bookingId: string): Promise<string | null> {
  try {
    const row = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        isInternalTest: true,
        customer: { select: { email: true, emailMarketingConsent: true, marketingOptOut: true } },
      },
    })
    if (!row) return 'booking_deleted'
    if (row.isInternalTest) return 'internal_test_booking'
    // CONTROLLED ROLLOUT. During a canary, do not even queue a sequence for
    // somebody outside the allowlist — the send gate would refuse every stage
    // anyway, and a queue full of certain refusals hides the real ones.
    if (!inRolloutAllowlist(row.customer?.email ?? '', rolloutAllowlist())) return 'not_in_rollout_allowlist'
    return promotionalConsentBlockReason({
      // Only the consent fields are consulted; the rest are placeholders that
      // promotionalConsentBlockReason never reads.
      status: '',
      isInternalTest: false,
      depositPaid: false,
      completedAt: null,
      requestedDate: null,
      confirmedDate: null,
      scheduledStart: null,
      customerMarketingConsent: row.customer?.emailMarketingConsent ?? null,
      customerMarketingOptOut: row.customer?.marketingOptOut ?? false,
    })
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), bookingId },
      'marketing consent read failed — failing closed'
    )
    return 'consent_read_failed'
  }
}
