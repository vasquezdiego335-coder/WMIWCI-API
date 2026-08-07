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

import { LeadStatus } from '@prisma/client'
import { prisma } from './db'
import { scheduledQueue } from './queues'
import { queueLogger } from './logger'
import { inRolloutAllowlist, nextAllowedTime, rolloutAllowlist } from './email-guard'
import { bookingMarketingBlockReason, effectiveMoveDate } from './email-eligibility'
import { fireBookingTrigger, fireLeadTrigger, stopEnrollmentsFor } from './email-automation-runtime'
import { hasEverBooked, hasPromotionalConsent, markLeadConverted } from './leads'

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

// ════════════════════════════════════════════════════════════════════════
//  RE-ENROLMENT: WHY SCHEDULING IS RETRYABLE (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  THE DEFECT THIS CLOSES. `markLeadQuoted` reports `newlyQuoted: true` exactly
//  once — the call that first stamps `quotedAt`. Every caller used that flag as
//  the trigger for `onQuoteCreated`, so the quote journey got exactly ONE
//  attempt, ever, at the instant the quote was recorded.
//
//  `onQuoteCreated` can decline for reasons that are TEMPORARY and have nothing
//  to do with the person: the rollout allowlist during a canary, the journey
//  flag being off, a Redis stall, consent that arrives on a later form save.
//  When that happened the lead kept `quotedAt` forever, and no code path would
//  ever look at it again. It had happened to a real production lead.
//
//  THE RULE NOW: `quotedAt` means "this lead has a quote". It does not mean
//  "we permanently attempted the lifecycle once". Enrolment is therefore
//  IDEMPOTENT and RETRYABLE, and safe to call from anywhere, any number of
//  times. Three independent layers make repetition harmless:
//    1. this module refuses a lead that is not currently eligible;
//    2. the queue job id is stable, so BullMQ ignores a duplicate add;
//    3. guardedSend's EmailSend idempotency key is TERMINAL once delivered.
//  A stage can therefore be re-enqueued and still not produce a second email.
// ════════════════════════════════════════════════════════════════════════

/**
 * Spacing applied to stages that are ALREADY OVERDUE when a journey is
 * (re-)enrolled — i.e. the recovery path only.
 *
 * Without it, recovering a lead quoted four days ago would compute three fire
 * times in the past, hand BullMQ a delay of 0 for each, and dump the whole
 * sequence into the customer's inbox at once. 24h matches the daily
 * promotional cap, so the spacing the customer experiences is the spacing the
 * send gate would enforce anyway — just without three deferral round-trips.
 *
 * A journey enrolled at its natural moment never touches this: every fire time
 * is in the future, so the cursor below is never consulted.
 */
export const RECOVERY_STAGE_SPACING_MS = 24 * HOUR

/**
 * How stale a quote may be and still start (or resume) a follow-up sequence.
 *
 * The last stage lands at +7 days, so a quote older than this has nothing
 * truthful left to say — "did our quote reach you?" three weeks late reads as a
 * system that lost track of the customer, which is exactly what it would be.
 * The guard lives HERE rather than only in the repair sweep so that an admin
 * re-marking an ancient lead cannot start a stale drip either.
 */
export const QUOTE_JOURNEY_MAX_AGE_MS =
  Math.max(1, Number(process.env.EMAIL_QUOTE_JOURNEY_MAX_AGE_DAYS) || 14) * DAY

/**
 * Schedule a list of stages against an anchor, staggering anything overdue.
 *
 * PURE decision, impure enqueue: the fire times are computed by
 * `planStageTimes` below so the ordering rules are unit-tested without Redis.
 */
async function scheduleStages(
  deps: JourneyDeps,
  journey: string,
  stages: JourneyStage[],
  subjectId: string,
  data: Record<string, unknown>,
  anchor: number,
  opts: { moveDate?: Date | null } = {}
): Promise<number> {
  const plan = planStageTimes(stages, anchor, {
    now: deps.now().getTime(),
    moveDate: opts.moveDate ?? null,
  })
  let scheduled = 0
  for (const p of plan) {
    if (p.skip) {
      log.info({ subjectId, stage: p.stage.type, reason: p.skip }, 'stage skipped')
      continue
    }
    await deps.enqueue(p.stage.type, data, new Date(p.fireAt), jobIdFor(journey, p.stage.type, subjectId))
    scheduled++
  }
  return scheduled
}

export type StagePlan = { stage: JourneyStage; fireAt: number; overdue: boolean; skip?: string }

/**
 * PURE: when should each stage fire?
 *
 *   • On time  — anchor + delay, exactly as before.
 *   • Overdue  — the recovery path. The first overdue stage goes out now, each
 *                subsequent one is pushed a further RECOVERY_STAGE_SPACING_MS
 *                so a recovered sequence is still a sequence.
 *   • After the customer's own move date (+1 day) — skipped. A follow-up that
 *     lands after the move helps nobody, and this rule predates the recovery
 *     path; it is applied to the ACTUAL fire time, so a staggered stage that
 *     would now land past the move is dropped rather than sent late.
 */
export function planStageTimes(
  stages: JourneyStage[],
  anchor: number,
  opts: { now: number; moveDate?: Date | null }
): StagePlan[] {
  const { now } = opts
  const moveCutoff = opts.moveDate ? opts.moveDate.getTime() + DAY : null
  let cursor = now
  let recovering = false
  let prevFireAt = Number.NEGATIVE_INFINITY
  return stages.map((stage) => {
    const natural = anchor + stage.delay
    const overdue = natural < now
    let fireAt = natural
    if (overdue) {
      fireAt = cursor
      cursor += RECOVERY_STAGE_SPACING_MS
      recovering = true
    } else if (recovering && fireAt < prevFireAt + RECOVERY_STAGE_SPACING_MS) {
      // A staggered stage can catch up with the next NATURAL one — e.g. a
      // sweep on day 6 puts stage 2 at now+24h while stage 3's own time is
      // only hours later. Once a plan is in recovery, every later stage keeps
      // the full spacing, so a recovered sequence can never compress into a
      // burst. An on-time plan never sets `recovering`, so designed cadences
      // (Sequence B's 4h→24h gap included) are untouched.
      fireAt = prevFireAt + RECOVERY_STAGE_SPACING_MS
    }
    prevFireAt = fireAt
    const skip = moveCutoff !== null && fireAt > moveCutoff ? 'after_move_date' : undefined
    return { stage, fireAt, overdue, skip }
  })
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
//  THE INJECTABLE EDGE (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  Every effect this module has on the world outside the process — the queue
//  inserts and removals, the lead/booking reads, the automation triggers, the
//  clock — goes through JourneyDeps. `defaultJourneyDeps` below is a literal
//  transcription of the prisma/BullMQ calls this file already made; no order,
//  predicate or failure mode changed when the seam was added.
//
//  IT EXISTS BECAUSE THE SCHEDULING BEHAVIOUR HAD NO TESTS. Everything here
//  needed a live Postgres and a live Redis to exercise, so the only things
//  covered were the pure block-reason predicates — and the bugs that reached
//  production were never in those. "Does a booking cancel the nurture?", "does
//  a second call duplicate the stages?", "does a recovered sequence arrive all
//  at once?" are questions about the ORCHESTRATION, and they are now askable
//  offline. Same pattern, same reasons, as LeadDeps and QuoteCaptureDeps.
// ════════════════════════════════════════════════════════════════════════

/** The lead columns every journey decision in this module reasons about. */
export type JourneyLead = LeadState & { id: string }

// Trigger vocabularies are OWNED by the automation runtime. Derived here rather
// than restated, so adding a trigger there cannot leave this seam accepting a
// name the runtime will silently ignore.
type LeadTrigger = Parameters<typeof fireLeadTrigger>[0]
type BookingTrigger = Parameters<typeof fireBookingTrigger>[0]
type StopScope = Parameters<typeof stopEnrollmentsFor>[0]
type StopOpts = Parameters<typeof stopEnrollmentsFor>[2]

export interface JourneyDeps {
  now(): Date
  enqueue(stage: string, data: Record<string, unknown>, fireAt: Date, jobId: string): Promise<void>
  cancel(jobId: string): Promise<void>
  loadLead(leadId: string): Promise<JourneyLead | null>
  /** Booking HISTORY, not lead status — see leads.hasEverBooked. */
  hasEverBooked(email: string | null): Promise<boolean>
  /** email-eligibility.bookingMarketingBlockReason. */
  bookingMarketingBlock(bookingId: string): Promise<string | null>
  /** An EARLIER unpaid booking for the same customer, if any. */
  siblingUnpaidBooking(bookingId: string): Promise<string | null>
  /** leads.markLeadConverted — the canonical consent propagation. */
  convertLead(
    email: string | null | undefined,
    bookingId: string,
    opts: {
      bookingSessionId?: string | null
      marketingConsent?: boolean | null
      consentSource?: string | null
      consentVersion?: string | null
    }
  ): Promise<string | null>
  /** Move-date precedence fields for the reminder re-anchor. */
  loadBookingDates(
    bookingId: string
  ): Promise<{ scheduledStart: Date | null; confirmedDate: Date | null; requestedDate: Date | null } | null>
  /** Leads that MIGHT be stranded: quoted recently, opted in, still open. */
  repairCandidates(input: { quotedSince: Date; limit: number }): Promise<{ id: string }[]>
  /** Of these leads, which already have a quote-stage row in the send ledger?
   *  Rejects (throws) rather than guessing — the caller fails closed. */
  leadsAlreadyAttempted(leadIds: string[]): Promise<Set<string>>
  fireLeadTrigger(trigger: LeadTrigger, leadId: string): void
  fireBookingTrigger(trigger: BookingTrigger, bookingId: string): void
  stopEnrollments(scope: StopScope, reason: string, opts?: StopOpts): void
}

let _deps: JourneyDeps | undefined
export function defaultJourneyDeps(): JourneyDeps {
  if (_deps) return _deps
  _deps = {
    now: () => new Date(),
    enqueue,
    cancel,
    async loadLead(leadId) {
      return prisma.lead
        .findUnique({
          where: { id: leadId },
          select: {
            id: true, email: true, status: true, quotedAt: true, bookedAt: true, lostAt: true,
            moveDate: true, convertedBookingId: true, emailMarketingConsent: true,
          },
        })
        .catch((err) => {
          log.warn({ leadId, err: err instanceof Error ? err.message : String(err) }, 'lead read failed (non-fatal)')
          return null
        })
    },
    hasEverBooked,
    bookingMarketingBlock: bookingMarketingBlockReason,
    siblingUnpaidBooking,
    convertLead: markLeadConverted,
    async loadBookingDates(bookingId) {
      return prisma.booking
        .findUnique({
          where: { id: bookingId },
          select: { scheduledStart: true, confirmedDate: true, requestedDate: true },
        })
        .catch((err) => {
          log.warn(
            { bookingId, err: err instanceof Error ? err.message : String(err) },
            'booking date read failed (non-fatal)'
          )
          return null
        })
    },
    async repairCandidates({ quotedSince, limit }) {
      return prisma.lead.findMany({
        where: {
          quotedAt: { not: null, gte: quotedSince },
          // Explicit opt-in only. The send gate would refuse anything else, and
          // a sweep that queues certain refusals hides the real ones.
          emailMarketingConsent: true,
          email: { not: null },
          bookedAt: null,
          lostAt: null,
          convertedBookingId: null,
          status: { notIn: [LeadStatus.BOOKED, LeadStatus.LOST] },
        },
        orderBy: { quotedAt: 'desc' },
        take: limit,
        select: { id: true },
      })
    },
    async leadsAlreadyAttempted(leadIds) {
      const rows = await prisma.emailSend.findMany({
        where: { leadId: { in: leadIds }, template: { in: QUOTE_STAGE_TEMPLATES } },
        select: { leadId: true },
      })
      return new Set(rows.map((r) => r.leadId).filter((v): v is string => !!v))
    },
    // Fire-and-forget, exactly as before: a trigger failure must never break
    // the customer-facing request that caused it.
    fireLeadTrigger: (trigger, leadId) => void fireLeadTrigger(trigger, leadId),
    fireBookingTrigger: (trigger, bookingId) => void fireBookingTrigger(trigger, bookingId),
    stopEnrollments: (scope, reason, opts) => void stopEnrollmentsFor(scope, reason, opts),
  }
  return _deps
}

// ════════════════════════════════════════════════════════════════════════
//  TRIGGERS
// ════════════════════════════════════════════════════════════════════════

/**
 * How close together two PENDING_PAYMENT bookings for the same customer have to
 * be before the second is treated as an accidental re-submission for EMAIL
 * purposes. See `siblingUnpaidBooking`.
 */
export const DUPLICATE_BOOKING_WINDOW_MS =
  Math.max(0, Number(process.env.EMAIL_DUPLICATE_BOOKING_WINDOW_MINUTES) || 30) * 60_000

/**
 * Is there an EARLIER unpaid booking for the same customer that already owns a
 * recovery sequence?
 *
 * WHY THIS EXISTS, and what it deliberately does NOT do. `Booking` carries no
 * client submission id — `bookingSessionId` is accepted by the API but is only
 * used to find the partial LEAD, and is never stored on the booking. So a
 * double-submitted form genuinely creates two bookings, two Stripe sessions and
 * two independent abandoned-checkout sequences aimed at one inbox.
 *
 * MERGING THE BOOKINGS IS A PRODUCT DECISION, not a bug fix, and it needs a
 * schema change — so it is not made here. What IS fixed is the email
 * consequence: the second sequence is not scheduled. Both bookings still exist,
 * both remain payable, and the customer still receives ONE recovery sequence
 * (pointing at the earlier booking) instead of two near-identical ones.
 *
 * Only ever looks BACKWARD from this booking's creation, so the decision is
 * deterministic: the first booking keeps the sequence, the later duplicate
 * yields. Two genuinely separate moves booked more than the window apart are
 * unaffected.
 *
 * FAILS OPEN: a read error schedules as before. Losing a recovery email is a
 * worse outcome than a rare duplicate, and the duplicate is still throttled by
 * the daily promotional cap.
 */
async function siblingUnpaidBooking(bookingId: string): Promise<string | null> {
  if (DUPLICATE_BOOKING_WINDOW_MS <= 0) return null
  try {
    const self = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { customerId: true, createdAt: true },
    })
    if (!self) return null
    const sibling = await prisma.booking.findFirst({
      where: {
        id: { not: bookingId },
        customerId: self.customerId,
        status: 'PENDING_PAYMENT',
        depositPaid: false,
        isInternalTest: false,
        createdAt: { gte: new Date(self.createdAt.getTime() - DUPLICATE_BOOKING_WINDOW_MS), lt: self.createdAt },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    return sibling?.id ?? null
  } catch (err) {
    log.warn(
      { bookingId, err: err instanceof Error ? err.message : String(err) },
      'duplicate-booking check failed — scheduling anyway (fails open)'
    )
    return null
  }
}

/**
 * Stripe checkout created, deposit not yet paid → start recovery.
 * Idempotent: stable jobIds mean a second call replaces rather than duplicates.
 *
 * ORDERING CONTRACT: this reads `Customer.emailMarketingConsent`, so it MUST
 * run after the booking's consent has been propagated onto the Customer row.
 * `onBookingCreated` below is the composite that guarantees that order — call
 * it rather than sequencing the two by hand.
 */
export async function onCheckoutStarted(
  bookingId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  // Owner automations on this trigger enroll regardless of the journey flag —
  // they carry their own ACTIVE + EMAIL_PROMOTIONS_ENABLED gates. Fire-and-
  // forget: a trigger failure must never break checkout.
  deps.fireBookingTrigger('booking_started', bookingId)

  if (!enabled('abandoned')) {
    log.info({ bookingId }, 'abandoned-recovery journey disabled — not scheduling')
    return
  }

  // PROMOTIONAL CONSENT (owner spec 2026-08-06). abandoned-checkout 1/2/3 are
  // promotional templates. The send gate in bookingEligibility is the
  // guarantee; refusing here as well means three doomed jobs are never queued
  // and the reason is logged at checkout, not 72 hours later.
  const consentBlock = await deps.bookingMarketingBlock(bookingId)
  if (consentBlock) {
    log.info({ bookingId, reason: consentBlock }, 'no promotional consent — abandoned-recovery not scheduled')
    return
  }

  const duplicateOf = await deps.siblingUnpaidBooking(bookingId)
  if (duplicateOf) {
    log.info({ bookingId, duplicateOf }, 'an earlier unpaid booking already owns a recovery sequence — not scheduling a second')
    return
  }

  const now = deps.now().getTime()
  await Promise.all(
    ABANDONED_STAGES.map((s) =>
      deps.enqueue(s.type, { bookingId }, new Date(now + s.delay), jobIdFor('abandoned', s.type, bookingId))
    )
  )
  log.info({ bookingId, stages: ABANDONED_STAGES.length }, 'abandoned-recovery scheduled')
}

/**
 * A booking was created and parked in PENDING_PAYMENT → run the WHOLE booking
 * hand-over, in the one order that is correct.
 *
 * THE BUG THIS EXISTS TO MAKE IMPOSSIBLE. `/api/bookings` used to call
 * `onCheckoutStarted` first and `markLeadConverted` second. `onCheckoutStarted`
 * asks `Customer.emailMarketingConsent`; `markLeadConverted` is the canonical
 * step that WRITES it. So for every brand-new customer the consent gate read
 * `null` — "never asked" — and refused the abandoned-checkout sequence, moments
 * before the same request recorded the explicit opt-in they had just given.
 * The sequence was unreachable for exactly the population it was built for.
 *
 * Positional ordering in a 700-line route is not a guarantee, so the order is
 * expressed as a function instead. THE CANONICAL RULE, stated once:
 * `markLeadConverted` is the ONLY writer of booking-time consent propagation
 * (Lead → Customer, via `decideConsent`); everything that READS consent runs
 * after it.
 *
 *   1. convert the lead + propagate consent  (the canonical write)
 *   2. close the lead's own journeys          (A and B both die on conversion)
 *   3. start the booking journey              (now sees the consent from 1)
 *
 * Each step is independent and non-fatal: step 3 still runs if step 1 failed,
 * because an EXISTING consented customer needs no propagation — it simply reads
 * the stored value and, if that read is stale, fails closed exactly as before.
 */
export async function onBookingCreated(input: {
  bookingId: string
  email: string | null | undefined
  bookingSessionId?: string | null
  /** From the booking payload's Step-1 checkbox; undefined = not re-sent. */
  marketingConsent?: boolean | null
  consentSource?: string | null
  consentVersion?: string | null
}, deps: JourneyDeps = defaultJourneyDeps()): Promise<{ convertedLeadId: string | null }> {
  const { bookingId } = input
  let convertedLeadId: string | null = null

  // 1 + 2. Lead conversion is best-effort by contract (markLeadConverted never
  // throws for a business reason), but a thrown infrastructure error must not
  // cost the booking journey, so it is contained.
  try {
    convertedLeadId = await deps.convertLead(input.email, bookingId, {
      bookingSessionId: input.bookingSessionId,
      marketingConsent: input.marketingConsent,
      consentSource: input.consentSource,
      consentVersion: input.consentVersion,
    })
    if (convertedLeadId) await onLeadClosed(convertedLeadId, deps)
  } catch (err) {
    log.error(
      { bookingId, err: err instanceof Error ? err.message : String(err) },
      'lead conversion failed (non-fatal) — the booking journey still runs'
    )
  }

  // 3. Reads the consent written in step 1.
  try {
    await onCheckoutStarted(bookingId, deps)
  } catch (err) {
    log.error(
      { bookingId, err: err instanceof Error ? err.message : String(err) },
      'onCheckoutStarted failed (non-fatal)'
    )
  }

  return { convertedLeadId }
}

/**
 * Deposit paid → the customer converted.
 * STOP RULE: cancel every pending recovery stage immediately.
 */
export async function onBookingPaid(bookingId: string, deps: JourneyDeps = defaultJourneyDeps()): Promise<void> {
  await Promise.all(ABANDONED_STAGES.map((s) => deps.cancel(jobIdFor('abandoned', s.type, bookingId))))
  // Payment is BOTH a trigger (payment_captured automations) and a stop
  // condition — but ONLY for abandonment-type sequences. A paid deposit is
  // the normal path; it must not end a move-date or post-move automation.
  deps.fireBookingTrigger('payment_captured', bookingId)
  deps.stopEnrollments({ bookingId }, 'deposit_paid', { triggers: ['booking_started', 'booking_abandoned'] })
  log.info({ bookingId }, 'abandoned-recovery cancelled (booking paid)')
}

/**
 * A move date is confirmed → schedule the 72h + 24h reminders.
 * Reminders in the PAST are skipped rather than fired immediately: a booking
 * made 12 hours before the move should not instantly receive a "72 hours to go"
 * email. Idempotent, so a reschedule re-anchors cleanly.
 */
export async function onMoveDateSet(
  bookingId: string,
  moveDate: Date | null,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  if (!enabled('reminders') || !moveDate) return

  const now = deps.now().getTime()
  for (const r of REMINDER_OFFSETS) {
    const fireAt = new Date(moveDate.getTime() - r.before)
    const jobId = jobIdFor('pre-move', r.type, bookingId)
    // Re-anchoring after a reschedule: drop the old job first.
    await deps.cancel(jobId)
    if (fireAt.getTime() <= now) {
      log.info({ bookingId, stage: r.type }, 'reminder window already passed — skipping')
      continue
    }
    await deps.enqueue(r.type, { bookingId }, fireAt, jobId)
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
export async function onBookingConfirmed(
  bookingId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  // Owner automations enroll regardless of the journey flag (they have their
  // own gates); the pre-move reminder scheduling below keeps its flag.
  deps.fireBookingTrigger('booking_confirmed', bookingId)

  if (!enabled('reminders')) return
  const b = await deps.loadBookingDates(bookingId)
  if (!b) return
  await onMoveDateSet(bookingId, effectiveMoveDate(b), deps)
}

/**
 * Booking cancelled → stop EVERY journey for it.
 * Covers recovery, pre-move reminders, and the post-job follow-up sequence.
 */
export async function onBookingCancelled(
  bookingId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
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
  await Promise.all(ids.map((id) => deps.cancel(id)))
  // A cancelled booking has no truthful promotional automation left —
  // unconditional stop for every enrollment on it.
  deps.stopEnrollments({ bookingId }, 'booking_cancelled')
  // The post-completion balance reminder dies with the booking too.
  await deps.cancel(jobIdFor('balance', 'balance-reminder-post', bookingId))
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

export async function onBookingCompletedBalance(
  bookingId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  // Completion is also the move_completed automation trigger.
  deps.fireBookingTrigger('move_completed', bookingId)

  if (!enabled('balance')) return
  await deps.enqueue(
    'balance-reminder-post',
    { bookingId },
    new Date(deps.now().getTime() + BALANCE_REMINDER_DELAY_MS),
    jobIdFor('balance', 'balance-reminder-post', bookingId)
  )
  log.info({ bookingId }, 'post-completion balance reminder scheduled')
}

/**
 * A real quote was given to a lead → fire the automation trigger AND make sure
 * the follow-up sequence exists.
 *
 * Call this on the genuine transition (the moment `quotedAt` is first stamped).
 * For a repeat pass — a later form save, the repair sweep, an admin re-mark —
 * call `ensureQuoteJourney` instead: it does the same scheduling without
 * re-firing the `quote_created` automation trigger, which is a statement about
 * an EVENT and must not be repeated for the same event.
 */
export async function onQuoteCreated(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<EnrolmentOutcome> {
  // Owner automations on quote_created enroll independently of the journey flag.
  deps.fireLeadTrigger('quote_created', leadId)
  return ensureQuoteJourney(leadId, deps)
}

/** Why a quote sequence was not (re-)scheduled. `null` = it was. */
export type EnrolmentOutcome =
  | { scheduled: true; stages: number }
  | { scheduled: false; reason: string }

/**
 * IDEMPOTENT + RETRYABLE quote-journey enrolment. Safe to call any number of
 * times, from anywhere, at any point in the lead's life.
 *
 * Requires a genuine `quotedAt`. There is no way to fake a quote into existence
 * here: a lead with no quote timestamp gets no quote emails, per the rule that
 * we never send a quote sequence when no real quote exists.
 *
 * SUPERSEDES SEQUENCE B. The moment a real quote exists, the non-quote nurture
 * is obsolete — its copy asks whether the person needs an estimate they have
 * already been given. The send-time gate (`leadNurtureBlockReason` →
 * `has_quote`) already refused those stages, so this changes no email that
 * would have gone out; it removes the dead jobs so the queue says what is
 * actually going to happen. That cancellation runs BEFORE the eligibility
 * gates below, because "a quote exists" is what makes B obsolete — whether A
 * may run is a separate question.
 */
export async function ensureQuoteJourney(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<EnrolmentOutcome> {
  if (!JOURNEYS_ENABLED) return { scheduled: false, reason: 'journeys_disabled' }

  const lead = await deps.loadLead(leadId)
  if (!lead) return { scheduled: false, reason: 'lead_deleted' }
  if (!lead.quotedAt) {
    log.info({ leadId }, 'no real quote recorded (quotedAt is null) — refusing to schedule a quote sequence')
    return { scheduled: false, reason: 'no_quote' }
  }

  // Sequence A has taken over — drop Sequence B's obsolete jobs. See above.
  await cancelLeadNurture(leadId, deps)

  if (!enabled('quote')) return { scheduled: false, reason: 'journey_disabled' }

  // THE SHARED STOP MATRIX, not a second hand-written one: converted, lost,
  // closed status, no email, no consent, move date passed. Re-running the same
  // predicate the worker runs at send time is what keeps a retryable enrolment
  // from resurrecting a journey the customer has moved past.
  const block = quoteFollowupBlockReason(lead, deps.now())
  if (block) {
    log.info({ leadId, reason: block }, 'quote follow-up not scheduled')
    return { scheduled: false, reason: block }
  }

  // A quote nobody followed up on for a fortnight is not a live opportunity.
  const age = deps.now().getTime() - lead.quotedAt.getTime()
  if (age > QUOTE_JOURNEY_MAX_AGE_MS) {
    log.info({ leadId, ageDays: Math.round(age / DAY) }, 'quote is too old for a follow-up sequence')
    return { scheduled: false, reason: 'quote_too_old' }
  }

  // CONTROLLED ROLLOUT. Unset allowlist ⇒ no restriction; see email-guard.
  // RETRYABLE BY CONSTRUCTION: this is a property of today's rollout, not of
  // this person, so the repair sweep re-attempts it once the canary is lifted.
  if (!inRolloutAllowlist(lead.email ?? '', rolloutAllowlist())) {
    log.info({ leadId }, 'outside the rollout allowlist — no quote follow-up scheduled')
    return { scheduled: false, reason: 'not_in_rollout_allowlist' }
  }

  const stages = await scheduleStages(deps, 'quote', QUOTE_STAGES, leadId, { leadId }, lead.quotedAt.getTime(), {
    moveDate: lead.moveDate,
  })
  log.info({ leadId, stages }, 'quote follow-up scheduled')
  return { scheduled: true, stages }
}

/** Drop every pending Sequence-B stage for a lead. Best-effort, like `cancel`. */
export async function cancelLeadNurture(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  await Promise.all(LEAD_NURTURE_STAGES.map((s) => deps.cancel(jobIdFor('lead-nurture', s.type, leadId))))
}

// ════════════════════════════════════════════════════════════════════════
//  AUTOMATIC RECOVERY OF STRANDED QUOTE JOURNEYS
//  ---------------------------------------------------------------------
//  Making enrolment retryable only helps if something actually retries. A lead
//  quoted while the rollout allowlist was narrow has no further capture events
//  coming — nobody is going to re-submit the form on their behalf — so without
//  this sweep the fix would be forward-only and every currently-stranded lead
//  would stay stranded.
//
//  DELIBERATELY NARROW. It is not a mass rescheduler:
//    • only leads with a REAL quote inside the journey's own 14-day window
//    • only explicit opt-ins, not converted, not lost, not closed
//    • only leads with NO EmailSend row for any quote stage — i.e. leads the
//      send layer has never seen. A lead that was blocked AT SEND TIME already
//      has a resumable ledger row, and re-driving that is the admin's
//      deliberate "reopen" action, not an automatic one. Skipping them also
//      stops this sweep re-touching a completed journey on every run.
//    • bounded batch, and every candidate still passes the full eligibility
//      matrix inside ensureQuoteJourney.
//
//  SEQUENCE B IS NOT BACKFILLED, on purpose. A quote is a dated, durable
//  anchor with a defined seven-day window; "we captured this address once" is
//  not, so retroactively starting a nurture drip weeks later would be a
//  marketing decision rather than a repair. Sequence B works going forward from
//  the moment consent is recorded.
// ════════════════════════════════════════════════════════════════════════

/** Max leads examined per sweep. */
export const QUOTE_REPAIR_BATCH = Math.max(1, Number(process.env.EMAIL_QUOTE_REPAIR_BATCH) || 50)

/** The stage templates whose presence in the ledger means "already attempted". */
const QUOTE_STAGE_TEMPLATES = QUOTE_STAGES.map((s) => s.type)

export type RepairReport = {
  candidates: number
  alreadyAttempted: number
  scheduled: number
  refused: Record<string, number>
}

/**
 * Re-enrol quoted leads that never got a follow-up sequence. Idempotent,
 * bounded, and safe to run on a cron. Returns what it did, for the log.
 */
export async function repairStrandedQuoteJourneys(
  opts: { limit?: number } = {},
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<RepairReport> {
  const report: RepairReport = { candidates: 0, alreadyAttempted: 0, scheduled: 0, refused: {} }
  if (!enabled('quote')) return report

  const now = deps.now()
  const limit = opts.limit ?? QUOTE_REPAIR_BATCH

  let leads: { id: string }[]
  try {
    leads = await deps.repairCandidates({
      quotedSince: new Date(now.getTime() - QUOTE_JOURNEY_MAX_AGE_MS),
      limit,
    })
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'stranded-journey repair could not read candidates (non-fatal)'
    )
    return report
  }
  report.candidates = leads.length
  if (leads.length === 0) return report

  // ONE batched question: which of these has the send layer already seen?
  let attempted: Set<string>
  try {
    attempted = await deps.leadsAlreadyAttempted(leads.map((l) => l.id))
  } catch (err) {
    // FAILS CLOSED: without the ledger we cannot tell a stranded lead from a
    // finished one, and re-enrolling a finished one is the worse mistake.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'stranded-journey repair could not read the send ledger — skipping this pass'
    )
    return report
  }

  for (const lead of leads) {
    if (attempted.has(lead.id)) {
      report.alreadyAttempted++
      continue
    }
    const outcome = await ensureQuoteJourney(lead.id, deps)
    if (outcome.scheduled) {
      report.scheduled++
      log.info({ leadId: lead.id, stages: outcome.stages }, 'stranded quote journey repaired')
    } else {
      report.refused[outcome.reason] = (report.refused[outcome.reason] ?? 0) + 1
    }
  }
  return report
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
export async function onLeadCaptured(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  if (!enabled('lead-nurture')) return

  const lead = await deps.loadLead(leadId)
  if (!lead) return

  // Booking HISTORY, not lead status — see leads.hasEverBooked.
  const previousCustomer = await deps.hasEverBooked(lead.email)
  const block = leadNurtureBlockReason({ ...lead, previousCustomer }, deps.now())
  if (block) {
    log.info({ leadId, reason: block }, 'lead nurture not scheduled')
    return
  }

  // CONTROLLED ROLLOUT. Unset allowlist ⇒ no restriction; see email-guard.
  if (!inRolloutAllowlist(lead.email ?? '', rolloutAllowlist())) {
    log.info({ leadId }, 'outside the rollout allowlist — lead nurture not scheduled')
    return
  }

  // Anchored on NOW, so no stage is ever overdue and the recovery stagger in
  // planStageTimes is never consulted. A nurture email landing after the
  // customer's own move date helps nobody and is dropped there.
  const stages = await scheduleStages(
    deps,
    'lead-nurture',
    LEAD_NURTURE_STAGES,
    leadId,
    { leadId },
    deps.now().getTime(),
    { moveDate: lead.moveDate }
  )
  log.info({ leadId, stages }, 'lead nurture scheduled')
}

/**
 * A lead booked, was lost, or opted out → stop the quote sequence.
 */
export async function onLeadClosed(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<void> {
  await Promise.all([
    ...QUOTE_STAGES.map((s) => deps.cancel(jobIdFor('quote', s.type, leadId))),
    // The nurture dies with the same event: someone who booked must never get
    // "do you still need an estimate?".
    ...LEAD_NURTURE_STAGES.map((s) => deps.cancel(jobIdFor('lead-nurture', s.type, leadId))),
  ])
  // Converted or lost — the booking journey owns them now. Unconditional,
  // mirroring quoteFollowupBlockReason's own unconditional 'lead_converted'.
  deps.stopEnrollments({ leadId }, 'lead_closed')
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
  // ── REPEAT CUSTOMERS ARE DELIBERATELY NOT BLOCKED HERE (owner rule
  //    2026-08-07). `leadNurtureBlockReason` refuses a `previousCustomer`,
  //    because Sequence B is a first-time welcome and sending it to someone who
  //    has already moved with us is embarrassing. Sequence A is the opposite
  //    case: it exists because THIS person asked us for THIS quote, days ago,
  //    on purpose. Somebody who moved last spring and requests a new estimate
  //    for a new move is the single most valuable lead the business has, and
  //    silently dropping them out of the follow-up would be the expensive
  //    mistake. The distinction is intentional; do not "fix" it by adding a
  //    hasEverBooked() check here. (Regression-tested in email-lifecycle.)
  //
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
