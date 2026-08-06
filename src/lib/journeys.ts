// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE JOURNEYS — owner spec 2026-07-20.
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES: the templates and the worker allowlist for abandoned-
//  checkout recovery and the 72h/24h move reminder were BUILT AND READY, but
//  nothing ever enqueued them. `abandoned-checkout-recovery`, `job-reminder-24h`
//  and `review-request-48h` were handled in src/workers/scheduled.worker.ts and
//  scheduled by NOBODY — verified by grep across src/ and app/. The registry
//  called this "scheduler pending"; this module is that scheduler.
//
//  DESIGN PRINCIPLES
//   • A journey is a NAMED SEQUENCE of stages with delays. Scheduling one is
//     idempotent: every job carries a STABLE jobId (`journey:stage:subject`), so
//     a re-fired trigger overwrites rather than duplicates.
//   • Cancellation is BEST-EFFORT, never the only protection. Removing the queue
//     job is an optimization; the authoritative stop is the send-time recheck in
//     the worker (stillWantedForBooking) plus the guard's idempotency claim.
//     A queue we failed to clean can still not produce a wrong email.
//   • Delays are computed from the ANCHOR event, not from "now at each step", so
//     a worker restart cannot compress or stretch a sequence.
//   • Everything is flag-gated and OFF by default. Turning the marketing engine
//     on is a deliberate act.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { scheduledQueue } from './queues'
import { queueLogger } from './logger'
import { nextAllowedTime } from './email-guard'
import { bookingMarketingBlockReason, effectiveMoveDate } from './email-eligibility'
import { fireBookingTrigger, fireLeadTrigger, stopEnrollmentsFor } from './email-automation-runtime'
import { hasEverBooked, hasPromotionalConsent } from './leads'

const log = queueLogger.child({ mod: 'journeys' })

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Master switch for the behaviour-based journeys added in this pass. */
export const JOURNEYS_ENABLED = process.env.EMAIL_JOURNEYS_ENABLED === 'true'

/** Individual journeys can be disabled without turning everything off. */
const enabled = (name: string): boolean => {
  if (!JOURNEYS_ENABLED) return false
  return process.env[`EMAIL_JOURNEY_${name.toUpperCase().replace(/-/g, '_')}_DISABLED`] !== 'true'
}

export type JourneyStage = {
  /** Scheduled-job type the worker dispatches on. */
  type: string
  /** Delay from the ANCHOR event, in milliseconds. */
  delay: number
}

// ── ABANDONED BOOKING RECOVERY ──────────────────────────────────────────
//  Anchor: the Stripe checkout session was created and the booking parked in
//  PENDING_PAYMENT. Every stage re-checks that it is STILL PENDING_PAYMENT at
//  send time, so the moment the customer pays, the rest of the sequence dies.
//
//  Timing follows the owner spec: fast-follow, then a day, then three days.
//  There is no 4th "final" stage by default — a fourth unanswered email to
//  someone who abandoned a checkout is noise, and the frequency caps would
//  likely drop it anyway. Enable it deliberately if the data justifies it.
export const ABANDONED_STAGES: JourneyStage[] = [
  { type: 'abandoned-checkout-recovery', delay: 45 * 60_000 }, // ~45 min
  { type: 'abandoned-checkout-recovery-2', delay: 24 * HOUR },
  { type: 'abandoned-checkout-recovery-3', delay: 72 * HOUR },
]

// ── PRE-MOVE REMINDERS (transactional) ──────────────────────────────────
//  Anchor: the move date. These are NOT marketing — they are operational, so
//  they bypass the frequency caps and carry no unsubscribe link.
export const REMINDER_OFFSETS = [
  { type: 'job-reminder-72h', before: 72 * HOUR },
  { type: 'job-reminder-24h', before: 24 * HOUR },
]

// ── QUOTE FOLLOW-UP ─────────────────────────────────────────────────────
//  Anchor: Lead.quotedAt.
//
//  IMPORTANT LIMITATION, stated plainly: this schema has NO Quote model. A Lead
//  carries `quotedAt` and `estimatedValue` and nothing else — no quoted service
//  breakdown, no crew size, no validity window. The copy for these emails
//  therefore must NEVER restate quote details we do not store. See
//  docs/email-marketing/segmentation.md for the fields a full Stage-B sequence
//  would need.
export const QUOTE_STAGES: JourneyStage[] = [
  { type: 'quote-followup-1', delay: 24 * HOUR },
  { type: 'quote-followup-2', delay: 3 * DAY },
  { type: 'quote-followup-final', delay: 7 * DAY },
]

// ── NON-QUOTE LEAD NURTURE (owner spec 2026-08-06) ──────────────────────
//  Anchor: the lead was captured (contact form, coupon, tracker, an in-person
//  estimate request — anywhere someone gave us an email and an intent but no
//  number came out the other end).
//
//  WHY IT IS A SEPARATE JOURNEY AND NOT A LOOSER QUOTE JOURNEY. The quote
//  sequence's copy says "we sent you a quote". For these leads that sentence is
//  false, and a sequence that has to lie about its own premise is the wrong
//  sequence. The eligibility rule below is the mirror image of the quote one:
//  it refuses a lead that HAS a quote, so the two can never both fire.
//
//  Three stages, matching the three the quote journey already proved out —
//  a fourth unanswered email is noise the frequency caps would drop anyway.
//    +4h   what we need in order to price it accurately
//    +24h  what labor-only actually means (trust + process)
//    +72h  do you still need an estimate? (permission to say no, then stop)
export const LEAD_NURTURE_STAGES: JourneyStage[] = [
  { type: 'lead-nurture-1', delay: 4 * HOUR },
  { type: 'lead-nurture-2', delay: 24 * HOUR },
  { type: 'lead-nurture-final', delay: 72 * HOUR },
]

/** Stable job id — the anti-duplication guarantee at the queue level. */
export function jobIdFor(journey: string, stage: string, subjectId: string): string {
  return `journey__${journey}__${stage}__${subjectId}`
}

/** Enqueue one stage. Guarded so a Redis stall can never hang the caller. */
async function enqueue(
  stage: string,
  data: Record<string, unknown>,
  fireAt: Date,
  jobId: string
): Promise<void> {
  // Shift promotional sends out of quiet hours at SCHEDULE time. The guard
  // re-checks at send time too — this just avoids pointless deferral churn.
  const when = nextAllowedTime(fireAt)
  const delay = Math.max(0, when.getTime() - Date.now())

  await Promise.race([
    scheduledQueue.add(stage, { type: stage, ...data }, { delay, jobId }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('scheduledQueue.add timed out (Redis?)')), 5000)),
  ]).catch((err) =>
    log.warn({ err: err instanceof Error ? err.message : String(err), stage, jobId }, 'enqueue failed (non-fatal)')
  )
}

/** Best-effort removal of a pending stage. Absent/active jobs are not errors.
 *  Time-boxed like `enqueue` above: with `maxRetriesPerRequest: null` (the
 *  BullMQ requirement) ioredis retries a command FOREVER, so an un-raced
 *  `getJob` during a Redis outage would hang the booking cancel / confirm /
 *  reschedule REQUEST instead of failing soft. The send-time recheck is the
 *  real stop — losing one best-effort removal is never worse than that. */
async function cancel(jobId: string): Promise<void> {
  try {
    const job = await Promise.race([
      scheduledQueue.getJob(jobId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scheduledQueue.getJob timed out (Redis?)')), 5000)),
    ])
    if (job)
      await Promise.race([
        job.remove(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('job.remove timed out (Redis?)')), 5000)),
      ])
  } catch (err) {
    // A job that already started cannot be removed — the send-time recheck is
    // what actually stops it. This is exactly why cancellation is not the only
    // protection.
    log.info({ jobId, err: err instanceof Error ? err.message : String(err) }, 'cancel skipped (job active or gone)')
  }
}

// ════════════════════════════════════════════════════════════════════════
//  TRIGGERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Stripe checkout created, deposit not yet paid → start recovery.
 * Idempotent: stable jobIds mean a second call replaces rather than duplicates.
 */
export async function onCheckoutStarted(bookingId: string): Promise<void> {
  // Owner automations on this trigger enroll regardless of the journey flag —
  // they carry their own ACTIVE + EMAIL_PROMOTIONS_ENABLED gates. Fire-and-
  // forget: a trigger failure must never break checkout.
  void fireBookingTrigger('booking_started', bookingId)

  if (!enabled('abandoned')) {
    log.info({ bookingId }, 'abandoned-recovery journey disabled — not scheduling')
    return
  }

  // PROMOTIONAL CONSENT (owner spec 2026-08-06). abandoned-checkout 1/2/3 are
  // promotional templates. The send gate in bookingEligibility is the
  // guarantee; refusing here as well means three doomed jobs are never queued
  // and the reason is logged at checkout, not 72 hours later.
  const consentBlock = await bookingMarketingBlockReason(bookingId)
  if (consentBlock) {
    log.info({ bookingId, reason: consentBlock }, 'no promotional consent — abandoned-recovery not scheduled')
    return
  }

  const now = Date.now()
  await Promise.all(
    ABANDONED_STAGES.map((s) =>
      enqueue(s.type, { bookingId }, new Date(now + s.delay), jobIdFor('abandoned', s.type, bookingId))
    )
  )
  log.info({ bookingId, stages: ABANDONED_STAGES.length }, 'abandoned-recovery scheduled')
}

/**
 * Deposit paid → the customer converted.
 * STOP RULE: cancel every pending recovery stage immediately.
 */
export async function onBookingPaid(bookingId: string): Promise<void> {
  await Promise.all(ABANDONED_STAGES.map((s) => cancel(jobIdFor('abandoned', s.type, bookingId))))
  // Payment is BOTH a trigger (payment_captured automations) and a stop
  // condition — but ONLY for abandonment-type sequences. A paid deposit is
  // the normal path; it must not end a move-date or post-move automation.
  void fireBookingTrigger('payment_captured', bookingId)
  void stopEnrollmentsFor({ bookingId }, 'deposit_paid', { triggers: ['booking_started', 'booking_abandoned'] })
  log.info({ bookingId }, 'abandoned-recovery cancelled (booking paid)')
}

/**
 * A move date is confirmed → schedule the 72h + 24h reminders.
 * Reminders in the PAST are skipped rather than fired immediately: a booking
 * made 12 hours before the move should not instantly receive a "72 hours to go"
 * email. Idempotent, so a reschedule re-anchors cleanly.
 */
export async function onMoveDateSet(bookingId: string, moveDate: Date | null): Promise<void> {
  if (!enabled('reminders') || !moveDate) return

  const now = Date.now()
  for (const r of REMINDER_OFFSETS) {
    const fireAt = new Date(moveDate.getTime() - r.before)
    const jobId = jobIdFor('pre-move', r.type, bookingId)
    // Re-anchoring after a reschedule: drop the old job first.
    await cancel(jobId)
    if (fireAt.getTime() <= now) {
      log.info({ bookingId, stage: r.type }, 'reminder window already passed — skipping')
      continue
    }
    await enqueue(r.type, { bookingId }, fireAt, jobId)
  }
  log.info({ bookingId, moveDate }, 'pre-move reminders scheduled')
}

/**
 * A booking reached a CONFIRMED/SCHEDULED state (approval, admin status change,
 * or a reschedule that re-confirmed the date) → (re-)anchor the pre-move
 * reminders to the CURRENT effective move date.
 *
 * This is the trigger site the old registry called "scheduler pending": the
 * move-reminder journey was implemented and tested but nothing invoked it. It
 * reloads the booking so the caller never has to compute the move-date
 * precedence, and it delegates to the idempotent `onMoveDateSet` — a re-fire
 * (e.g. approve → schedule → reschedule) cancels and re-schedules cleanly
 * rather than duplicating a reminder.
 *
 * FAILS SOFT: a read error simply schedules nothing. Reminders are a
 * convenience layer over the authoritative move date; losing one is never
 * worse than the send-time recheck already guards against.
 */
export async function onBookingConfirmed(bookingId: string): Promise<void> {
  // Owner automations enroll regardless of the journey flag (they have their
  // own gates); the pre-move reminder scheduling below keeps its flag.
  void fireBookingTrigger('booking_confirmed', bookingId)

  if (!enabled('reminders')) return
  const b = await prisma.booking
    .findUnique({
      where: { id: bookingId },
      select: { scheduledStart: true, confirmedDate: true, requestedDate: true },
    })
    .catch((err) => {
      log.warn({ bookingId, err: err instanceof Error ? err.message : String(err) }, 'onBookingConfirmed read failed (non-fatal)')
      return null
    })
  if (!b) return
  await onMoveDateSet(bookingId, effectiveMoveDate(b))
}

/**
 * Booking cancelled → stop EVERY journey for it.
 * Covers recovery, pre-move reminders, and the post-job follow-up sequence.
 */
export async function onBookingCancelled(bookingId: string): Promise<void> {
  const ids = [
    ...ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, bookingId)),
    ...REMINDER_OFFSETS.map((r) => jobIdFor('pre-move', r.type, bookingId)),
    // Post-job follow-ups use followups.ts's own jobId scheme. The separator
    // MUST stay in step with addFollowup() there — a mismatch means cancel()
    // looks up an id that was never created and the follow-up still fires for a
    // cancelled booking. Covered by queue-jobid-safety.test.ts.
    ...['review-request', 'review-reminder', 'repeat-reminder', 'referral-ask'].map(
      (t) => `followup__${t}__${bookingId}`
    ),
  ]
  await Promise.all(ids.map(cancel))
  // A cancelled booking has no truthful promotional automation left —
  // unconditional stop for every enrollment on it.
  void stopEnrollmentsFor({ bookingId }, 'booking_cancelled')
  // The post-completion balance reminder dies with the booking too.
  await cancel(jobIdFor('balance', 'balance-reminder-post', bookingId))
  log.info({ bookingId, cancelled: ids.length }, 'all journeys cancelled (booking cancelled)')
}

// ── BALANCE REMINDER (post-completion, real amounts only) ───────────────
//  Anchor: the booking transitions to COMPLETED. One reminder at +24h IF a
//  real outstanding balance exists — the worker recomputes
//  job-money.customerBalance() at send time, so a payment recorded in the
//  meantime, a cancellation, or a zero balance all kill it. The email is the
//  existing final-invoice template with the DYNAMIC amounts; nothing is
//  hardcoded and no release/forfeiture claim is made (no business logic
//  enforces one).
export const BALANCE_REMINDER_DELAY_MS = 24 * HOUR

export async function onBookingCompletedBalance(bookingId: string): Promise<void> {
  // Completion is also the move_completed automation trigger.
  void fireBookingTrigger('move_completed', bookingId)

  if (!enabled('balance')) return
  await enqueue(
    'balance-reminder-post',
    { bookingId },
    new Date(Date.now() + BALANCE_REMINDER_DELAY_MS),
    jobIdFor('balance', 'balance-reminder-post', bookingId)
  )
  log.info({ bookingId }, 'post-completion balance reminder scheduled')
}

/**
 * A real quote was given to a lead → start the follow-up sequence.
 *
 * Requires a genuine `quotedAt`. There is no way to fake a quote into existence
 * here: a lead with no quote timestamp gets no quote emails, per the rule that
 * we never send a quote sequence when no real quote exists.
 */
export async function onQuoteCreated(leadId: string): Promise<void> {
  // Owner automations on quote_created enroll independently of the journey flag.
  void fireLeadTrigger('quote_created', leadId)

  if (!enabled('quote')) return

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, quotedAt: true, status: true, moveDate: true, emailMarketingConsent: true },
  })
  if (!lead) return
  if (!lead.email) {
    log.info({ leadId }, 'lead has no email — no quote follow-up')
    return
  }
  if (!lead.quotedAt) {
    log.info({ leadId }, 'no real quote recorded (quotedAt is null) — refusing to schedule a quote sequence')
    return
  }

  // Refused HERE as well as at send time. The send gate is the guarantee;
  // this only avoids queueing three jobs that are certain to be blocked, and
  // puts the reason in the log at the moment the owner clicks, not three days
  // later when a stage silently does nothing.
  if (!hasPromotionalConsent({ emailMarketingConsent: lead.emailMarketingConsent })) {
    log.info({ leadId }, 'lead never opted in to marketing — no quote follow-up scheduled')
    return
  }

  const anchor = lead.quotedAt.getTime()
  for (const s of QUOTE_STAGES) {
    const fireAt = new Date(anchor + s.delay)
    // A follow-up scheduled past the customer's own move date is pointless.
    if (lead.moveDate && fireAt.getTime() > lead.moveDate.getTime() + DAY) {
      log.info({ leadId, stage: s.type }, 'stage would land after the move date — skipping')
      continue
    }
    await enqueue(s.type, { leadId }, fireAt, jobIdFor('quote', s.type, leadId))
  }
  log.info({ leadId }, 'quote follow-up scheduled')
}

/**
 * A lead was captured with an email and explicit marketing consent, but NO
 * quote → start the non-quote nurture sequence (Sequence B).
 *
 * FOUR REFUSALS, all at schedule time, all repeated at send time:
 *   • no explicit opt-in            — the non-negotiable rule
 *   • a real quote exists           — the quote journey owns them
 *   • they have booked with us before — a returning customer must never get the
 *                                     first-time welcome sequence
 *   • already converted / lost      — nothing left to nurture
 *
 * Idempotent: stable job ids mean a lead captured five times (the quick-quote
 * page fires on every meaningful edit) still has exactly three pending jobs.
 */
export async function onLeadCaptured(leadId: string): Promise<void> {
  if (!enabled('lead-nurture')) return

  const lead = await prisma.lead
    .findUnique({
      where: { id: leadId },
      select: {
        id: true, email: true, status: true, quotedAt: true, bookedAt: true, lostAt: true,
        moveDate: true, convertedBookingId: true, emailMarketingConsent: true, createdAt: true,
      },
    })
    .catch((err) => {
      log.warn({ leadId, err: err instanceof Error ? err.message : String(err) }, 'onLeadCaptured read failed (non-fatal)')
      return null
    })
  if (!lead) return

  // Booking HISTORY, not lead status — see leads.hasEverBooked.
  const previousCustomer = await hasEverBooked(lead.email)
  const block = leadNurtureBlockReason({ ...lead, previousCustomer })
  if (block) {
    log.info({ leadId, reason: block }, 'lead nurture not scheduled')
    return
  }

  const anchor = Date.now()
  for (const s of LEAD_NURTURE_STAGES) {
    const fireAt = new Date(anchor + s.delay)
    // A nurture email landing after the customer's own move date helps nobody.
    if (lead.moveDate && fireAt.getTime() > lead.moveDate.getTime() + DAY) {
      log.info({ leadId, stage: s.type }, 'nurture stage would land after the move date — skipping')
      continue
    }
    await enqueue(s.type, { leadId }, fireAt, jobIdFor('lead-nurture', s.type, leadId))
  }
  log.info({ leadId }, 'lead nurture scheduled')
}

/**
 * A lead booked, was lost, or opted out → stop the quote sequence.
 */
export async function onLeadClosed(leadId: string): Promise<void> {
  await Promise.all([
    ...QUOTE_STAGES.map((s) => cancel(jobIdFor('quote', s.type, leadId))),
    // The nurture dies with the same event: someone who booked must never get
    // "do you still need an estimate?".
    ...LEAD_NURTURE_STAGES.map((s) => cancel(jobIdFor('lead-nurture', s.type, leadId))),
  ])
  // Converted or lost — the booking journey owns them now. Unconditional,
  // mirroring quoteFollowupBlockReason's own unconditional 'lead_converted'.
  void stopEnrollmentsFor({ leadId }, 'lead_closed')
  log.info({ leadId }, 'quote follow-up cancelled (lead closed)')
}

// ════════════════════════════════════════════════════════════════════════
//  SEND-TIME ELIGIBILITY — the LAST guard, mirroring the worker's booking gate.
//  Pure enough to unit-test: it takes the loaded row, not an id.
// ════════════════════════════════════════════════════════════════════════

export type LeadState = {
  email: string | null
  status: string
  quotedAt: Date | null
  bookedAt: Date | null
  lostAt: Date | null
  moveDate: Date | null
  convertedBookingId: string | null
  /** TRI-STATE. Required here: quote follow-ups are PROMOTIONAL (see below). */
  emailMarketingConsent: boolean | null
}

/**
 * May this lead still receive a quote follow-up? Returns a reason to ABORT,
 * or null to proceed. Mirrors the transition matrix in
 * docs/email-marketing/triggers-and-stop-rules.md.
 */
export function quoteFollowupBlockReason(lead: LeadState | null, now: Date = new Date()): string | null {
  if (!lead) return 'lead_deleted'
  if (!lead.email) return 'no_email'
  // ── PROMOTIONAL CONSENT ────────────────────────────────────────────────
  //  quote-followup-1/2/final are NOT in email-guard's TRANSACTIONAL_TEMPLATES,
  //  so classifyTemplate returns 'promotional' — they go out under marketing
  //  caps, quiet hours and an unsubscribe link. Everything downstream treated
  //  them that way EXCEPT the one gate that decides whether to send: this one
  //  checked email, quote, conversion, status and move date, and never asked
  //  whether the person had agreed to be marketed to.
  //
  //  So a lead who arrived through the contact form — where no consent
  //  checkbox is ever shown, and `emailMarketingConsent` is therefore NULL
  //  forever — received three promotional emails the moment the owner marked
  //  a quote given. That is the door that stayed open when the automation
  //  trigger's was closed, and it is the louder one: automations need an
  //  ACTIVE automation to exist, this needs only a button click.
  //
  //  TRI-STATE, and both false and null refuse: absence of a decision is not
  //  permission. The rule is hasPromotionalConsent(), the tested definition.
  if (!hasPromotionalConsent({ emailMarketingConsent: lead.emailMarketingConsent })) {
    return 'no_marketing_consent'
  }
  if (!lead.quotedAt) return 'no_quote'
  // Converted — the booking journey owns this customer now.
  if (lead.bookedAt || lead.convertedBookingId) return 'lead_converted'
  if (lead.lostAt) return 'lead_lost'
  if (['WON', 'LOST', 'BOOKED', 'CONVERTED'].includes(lead.status.toUpperCase())) {
    return `lead_status:${lead.status}`
  }
  // The move already happened — nothing left to sell.
  if (lead.moveDate && lead.moveDate.getTime() + DAY < now.getTime()) return 'move_date_passed'
  return null
}

/**
 * LIVE lead eligibility — the send-time twin of `bookingEligibility`
 * (finding EMAIL-P1-12).
 *
 * The scheduled worker already rechecked the lead before enqueueing, but the
 * queued job carried no `leadId`, so the EMAIL worker — which runs later, and
 * may run much later after a retry or a deferral — could not recheck anything.
 * A lead that booked in between still received "still planning your move?".
 *
 * FAILS CLOSED: a read error blocks the send.
 */
/**
 * Stop rules that apply to ANY lead-scoped email, regardless of journey.
 *
 * WHY THIS EXISTS. `leadId` on an email job used to have exactly one consumer —
 * the quote-followup journey — so leadEligibility hard-coded that journey's
 * matrix, which begins "a lead with no quotedAt gets nothing". The quick-quote
 * confirmation is the SECOND consumer and is an immediate REPLY: it asserts
 * nothing about a recorded quote, and a quick-quote lead never has quotedAt
 * (only the admin CRM action stamps it). Inheriting the journey matrix refused
 * 100% of confirmations — silently, because 'no_quote' classifies as retryable
 * and the worker returns without throwing.
 *
 * Stamping quotedAt on the lead would be the WRONG fix: it would make an
 * estimator visit look like a recorded quote and could arm the follow-up drip.
 */
export function transactionalLeadBlockReason(lead: LeadState | null): string | null {
  if (!lead) return 'lead_deleted'
  if (!lead.email) return 'no_email'
  return null
}

/** Lead-scoped templates that are an immediate REPLY, not a journey stage. */
const TRANSACTIONAL_LEAD_TEMPLATES: ReadonlySet<string> = new Set(['quote-request-received'])

/** Stages of the non-quote nurture. They use their OWN matrix, not the quote one. */
const NURTURE_TEMPLATES: ReadonlySet<string> = new Set(LEAD_NURTURE_STAGES.map((s) => s.type))

/** A lead being nurtured, plus the one fact that is not on the row. */
export type NurtureLeadState = LeadState & {
  /**
   * Derived from BOOKING history (leads.hasEverBooked), never from lead status.
   * REQUIRED, so a caller cannot forget to ask the question.
   */
  previousCustomer: boolean
}

/**
 * May this lead still receive a NON-QUOTE nurture email? Reason to abort, or
 * null. The mirror image of quoteFollowupBlockReason: same stop rules, plus
 * "they now have a real quote" and "they have booked with us before".
 */
export function leadNurtureBlockReason(lead: NurtureLeadState | null, now: Date = new Date()): string | null {
  if (!lead) return 'lead_deleted'
  if (!lead.email) return 'no_email'
  // PROMOTIONAL. Same rule, same tested predicate, same tri-state refusal.
  if (!hasPromotionalConsent({ emailMarketingConsent: lead.emailMarketingConsent })) {
    return 'no_marketing_consent'
  }
  // A REAL quote exists → the quote journey owns this person. Checked before
  // conversion so the reason names the more useful fact: the two sequences
  // are mutually exclusive by construction, not by scheduling luck.
  if (lead.quotedAt) return 'has_quote'
  // A returning customer must never receive the first-time welcome sequence.
  if (lead.previousCustomer) return 'previous_customer'
  if (lead.bookedAt || lead.convertedBookingId) return 'lead_converted'
  if (lead.lostAt) return 'lead_lost'
  if (['WON', 'LOST', 'BOOKED', 'CONVERTED'].includes(lead.status.toUpperCase())) {
    return `lead_status:${lead.status}`
  }
  if (lead.moveDate && lead.moveDate.getTime() + DAY < now.getTime()) return 'move_date_passed'
  return null
}

export async function leadEligibility(leadId: string, template?: string): Promise<string | null> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        email: true,
        status: true,
        quotedAt: true,
        bookedAt: true,
        lostAt: true,
        moveDate: true,
        convertedBookingId: true,
        emailMarketingConsent: true,
      },
    })
    // Journey stages keep the full matrix; an immediate transactional reply
    // gets only the rules true of every lead. `template` is optional so every
    // existing caller keeps today's behaviour.
    let reason: string | null
    if (template && TRANSACTIONAL_LEAD_TEMPLATES.has(template)) {
      reason = transactionalLeadBlockReason(lead)
    } else if (template && NURTURE_TEMPLATES.has(template)) {
      // The booking-history question is asked HERE, at send time, because it
      // can become true between scheduling and sending — someone who booked
      // yesterday must not get tomorrow's "still need an estimate?".
      const previousCustomer = lead ? await hasEverBooked(lead.email) : false
      reason = leadNurtureBlockReason(lead ? { ...lead, previousCustomer } : null)
    } else {
      reason = quoteFollowupBlockReason(lead)
    }
    if (reason) log.info({ leadId, template, reason }, 'lead eligibility BLOCKED the send')
    return reason
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), leadId },
      'lead eligibility read failed — failing closed'
    )
    return 'eligibility_read_failed'
  }
}
