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
import { classifyTemplate, inRolloutAllowlist, rolloutAllowlist, sendTimeEligibilityDeps } from './email-guard'
import { TEMPLATE_ALLOWED_STATUSES, type BookingStatus } from '../emails/status'
import {
  promotionalEligibility,
  type EligibilityContext,
  type EligibilityDb,
  type EligibilityDecision,
  type EligibilityDeps,
} from './consent/marketing-eligibility'
import type { SequenceKind } from './consent/notice-registry'

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

/** The move date, using the same precedence as the scheduling layer. */
export function effectiveMoveDate(b: Pick<BookingSnapshot, 'scheduledStart' | 'confirmedDate' | 'requestedDate'>) {
  return b.scheduledStart ?? b.confirmedDate ?? b.requestedDate
}

/** Has the move day fully passed? A job at 9am is still "today" all day. */
export function movePassed(b: BookingSnapshot, now: Date = new Date()): boolean {
  const d = effectiveMoveDate(b)
  return d ? d.getTime() + DAY_MS < now.getTime() : false
}

/** An abandoned-checkout email is only true while the booking still awaits its deposit. */
function stillAwaitingCheckout(b: BookingSnapshot): string | null {
  if (b.depositPaid) return 'deposit_already_paid'
  if (b.status !== 'PENDING_PAYMENT') return `booking_advanced:${b.status}`
  return null
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

  // Recovery mail is only honest while the checkout is genuinely unfinished.
  // `depositPaid` alone is NOT that proof: a paid $49 hold leaves the booking
  // PENDING_APPROVAL with depositPaid still false until the owner captures, and
  // a declined booking is CANCELLED with depositPaid false. A recovery stage
  // deferred by quiet hours or the transactional gap could therefore tell a
  // customer who had just paid "your date is still available" (2026-09-15).
  // Only PENDING_PAYMENT is still an abandoned checkout.
  'abandoned-checkout': stillAwaitingCheckout,
  'abandoned-checkout-2': stillAwaitingCheckout,
  'abandoned-checkout-3': stillAwaitingCheckout,

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

// ════════════════════════════════════════════════════════════════════════
//  THE SHARED ELIGIBILITY GATE ON BOOKING-SCOPED MAIL (DESIGN-v2 §5, 2026-09-16)
//  ---------------------------------------------------------------------
//  promotionalConsentBlockReason reads ONE customer row. The live paths below
//  now also ask src/lib/consent/marketing-eligibility for the PERSON: every
//  suppression reason, an opt-out or unsubscribe on record, a decline on any
//  row, a test/staff identity — and the basis the send may use in its context:
//
//    abandoned-checkout 1/2/3            → 'scenario_flow' (abandoned_checkout)
//    review/referral/repeat follow-ups   → 'post_move'
//    anything else promotional           → 'automation' (express only)
//
//  HOW THE TWO ANSWERS COMBINE, so nothing becomes looser than today:
//    • the decision refuses                → refused. The legacy reason is
//      reported when the legacy check refuses too (keeping today's ledger
//      classification, e.g. a retryable 'no_marketing_consent'); otherwise the
//      decision's own, terminal reason.
//    • the decision permits                → the legacy consent column is not
//      required. The decision already honours that same column for this
//      customer, and it only permits otherwise on a CONFIRMED express opt-in
//      (a token resubscribe), or on a notice/EBR basis
//      that is off unless its flag is set.
//  Status, workflow and move-date checks are unchanged and still apply.
// ════════════════════════════════════════════════════════════════════════

/** Templates of the booking-form scenario sequence (DESIGN-v2 §1, P3). */
const ABANDONED_CHECKOUT_TEMPLATES = new Set(['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3'])
/** Post-move follow-ups (followups.ts): context 'post_move', never a notice. */
const POST_MOVE_TEMPLATES = new Set(['review-request', 'review-reminder', 'referral', 'referral-ask', 'referral-reward', 'repeat-reminder'])

export type BookingEligibilityScope = { context: EligibilityContext; sequenceKind: SequenceKind | null }

/** The eligibility context a booking-scoped promotional template is sent in. */
export function bookingEligibilityScope(template: string): BookingEligibilityScope {
  if (ABANDONED_CHECKOUT_TEMPLATES.has(template)) return { context: 'scenario_flow', sequenceKind: 'abandoned_checkout' }
  if (POST_MOVE_TEMPLATES.has(template)) return { context: 'post_move', sequenceKind: null }
  return { context: 'automation', sequenceKind: null }
}

export type BookingEligibilityOptions = {
  /** Overrides the template's scope — e.g. a campaign recheck passes 'campaign'. */
  context?: EligibilityContext
  sequenceKind?: SequenceKind | null
  /** Injected in tests. Defaults to the real Prisma client and process.env. */
  deps?: EligibilityDeps
}

/** Decision reasons that are PROHIBITIONS on the person: they are reported over a legacy reason. */
const PROHIBITION_REASONS = new Set(['suppressed', 'opted_out', 'declined', 'test_identity', 'invalid_email'])

/** Combine the legacy per-row answer with the shared decision (see above). */
export function combinePromotional(legacy: string | null, decision: EligibilityDecision): string | null {
  if (decision.eligible) return null
  if (PROHIBITION_REASONS.has(decision.reason)) return decision.reason
  return legacy ?? decision.reason
}

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
  now: Date = new Date(),
  opts: { promotional?: EligibilityDecision } = {}
): string | null {
  if (!booking) return 'booking_deleted'

  // Internal test bookings never generate customer mail, in any state.
  if (booking.isInternalTest) return 'internal_test_booking'

  // 0. MAY WE MARKET TO THIS PERSON AT ALL? Checked before the template's own
  //    conditions because it is the more fundamental fact: for a promotional
  //    template, no amount of correct booking state makes the send permitted.
  //    With the shared decision supplied (the live paths), the two answers are
  //    combined as described above; without it, the per-row rule alone.
  if (classifyTemplate(template) === 'promotional') {
    const legacy = promotionalConsentBlockReason(booking)
    const consent = opts.promotional ? combinePromotional(legacy, opts.promotional) : legacy
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
export async function bookingEligibility(
  template: string,
  bookingId: string,
  opts: BookingEligibilityOptions = {}
): Promise<string | null> {
  const db = (opts.deps?.db ?? prisma) as EligibilityDb
  try {
    const row = await db.booking.findUnique({
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
        customer: { select: { email: true, emailMarketingConsent: true, marketingOptOut: true } },
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
    // The shared per-person decision, for promotional templates only. A booking
    // with no customer address has no person to decide for; the legacy rule
    // (consent null → refuse) still blocks it.
    let promotional: EligibilityDecision | undefined
    if (row && !row.isInternalTest && row.customer?.email && classifyTemplate(template) === 'promotional') {
      const scope = bookingEligibilityScope(template)
      promotional = await promotionalEligibility(
        {
          context: opts.context ?? scope.context,
          email: row.customer.email,
          subject: { type: 'booking', id: bookingId, sequenceKind: opts.sequenceKind ?? scope.sequenceKind },
        },
        sendTimeEligibilityDeps(opts.deps)
      )
    }
    let reason = bookingBlockReason(template, booking, new Date(), { promotional })
    //  A LATER booking by the same customer that was paid or moved past checkout
    //  supersedes this unpaid one: "finish your booking" must never reach
    //  someone who re-did the form and paid. (The recovery sequence belongs to
    //  the first booking, so the later one's payment cannot cancel it.)
    if (!reason && row && ABANDONED_CHECKOUT_TEMPLATES.has(template) && (await supersededByLaterBooking(db, bookingId))) {
      reason = 'booking_superseded'
    }
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

/**
 * Has the same customer created a real booking AFTER this one that was paid or
 * went past checkout? THROWS on a database error (the caller fails closed).
 */
export async function supersededByLaterBooking(db: EligibilityDb, bookingId: string): Promise<boolean> {
  const self = await db.booking.findUnique({ where: { id: bookingId }, select: { customerId: true, createdAt: true } })
  if (!self?.customerId || !self.createdAt) return false
  const later = await db.booking.findMany({
    where: {
      customerId: self.customerId,
      isInternalTest: false,
      createdAt: { gt: self.createdAt },
      OR: [{ depositPaid: true }, { status: { in: ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED'] } }],
    },
    select: { id: true },
    take: 1,
  })
  return later.length > 0
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
export async function bookingMarketingBlockReason(
  bookingId: string,
  opts: BookingEligibilityOptions = {}
): Promise<string | null> {
  const db = (opts.deps?.db ?? prisma) as EligibilityDb
  try {
    const row = await db.booking.findUnique({
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
    const legacy = promotionalConsentBlockReason({
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
    // No address → nobody to decide for; the legacy answer (a refusal) stands.
    if (!row.customer?.email) return legacy
    // The caller names the sequence it is scheduling. Without one this is
    // 'automation' — express only — so a notice basis is never assumed.
    const decision = await promotionalEligibility(
      {
        context: opts.context ?? 'automation',
        email: row.customer.email,
        subject: { type: 'booking', id: bookingId, sequenceKind: opts.sequenceKind ?? null },
      },
      sendTimeEligibilityDeps(opts.deps)
    )
    return combinePromotional(legacy, decision)
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), bookingId },
      'marketing consent read failed — failing closed'
    )
    return 'consent_read_failed'
  }
}
