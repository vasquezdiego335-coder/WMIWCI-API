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
import { effectiveMoveDate } from './email-eligibility'
import { fireBookingTrigger, fireLeadTrigger, stopEnrollmentsFor } from './email-automation-runtime'

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

/** Stable job id — the anti-duplication guarantee at the queue level. */
export function jobIdFor(journey: string, stage: string, subjectId: string): string {
  return `journey:${journey}:${stage}:${subjectId}`
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
    // Post-job follow-ups use followups.ts's own jobId scheme.
    ...['review-request', 'review-reminder', 'repeat-reminder', 'referral-ask'].map(
      (t) => `followup:${t}:${bookingId}`
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
    select: { id: true, email: true, quotedAt: true, status: true, moveDate: true },
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
 * A lead booked, was lost, or opted out → stop the quote sequence.
 */
export async function onLeadClosed(leadId: string): Promise<void> {
  await Promise.all(QUOTE_STAGES.map((s) => cancel(jobIdFor('quote', s.type, leadId))))
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
}

/**
 * May this lead still receive a quote follow-up? Returns a reason to ABORT,
 * or null to proceed. Mirrors the transition matrix in
 * docs/email-marketing/triggers-and-stop-rules.md.
 */
export function quoteFollowupBlockReason(lead: LeadState | null, now: Date = new Date()): string | null {
  if (!lead) return 'lead_deleted'
  if (!lead.email) return 'no_email'
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
export async function leadEligibility(leadId: string): Promise<string | null> {
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
      },
    })
    const reason = quoteFollowupBlockReason(lead)
    if (reason) log.info({ leadId, reason }, 'lead eligibility BLOCKED the send')
    return reason
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), leadId },
      'lead eligibility read failed — failing closed'
    )
    return 'eligibility_read_failed'
  }
}
