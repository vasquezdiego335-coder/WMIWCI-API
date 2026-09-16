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
import { inRolloutAllowlist, nextAllowedTime, rolloutAllowlist, sendTimeEligibilityDeps } from './email-guard'
import { bookingMarketingBlockReason, effectiveMoveDate } from './email-eligibility'
import { fireBookingTrigger, fireLeadTrigger, stopEnrollmentsFor } from './email-automation-runtime'
import { hasBookingOnRecord, hasPromotionalConsent, markLeadConverted } from './leads'
import { normalizeEmail } from './email-tokens'
import {
  promotionalEligibility,
  type EligibilityContext,
  type EligibilityDecision,
  type EligibilityRequest,
} from './consent/marketing-eligibility'
import {
  activeEnrollment,
  enrollSequence,
  personBookedSince,
  type EnrollSequenceInput,
  type EnrollSequenceResult,
  type EnrollmentRecord,
  type EnrollmentRef,
  type EnrollmentSubjectType,
} from './consent/sequence-enrollment'
import {
  SEQUENCE_KINDS,
  SURFACE_SEQUENCE_KINDS,
  isNoticeSurface,
  isSequenceKind,
  type NoticeSurface,
  type SequenceKind,
} from './consent/notice-registry'
import {
  CANCELLED_REASON,
  defaultRetryStore,
  emptySummary,
  enqueueDurable,
  enqueueStatusOf,
  logScheduleSummary,
  retryWindowFor,
  tally,
  timeboxed,
  type EnqueueResult,
  type EnqueueStatus,
  type QueueLike,
  type RetryStore,
  type ScheduleSummary,
} from './lifecycle-enqueue'

const log = queueLogger.child({ mod: 'journeys' })

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Master switch for the behaviour-based journeys added in this pass. */
export const JOURNEYS_ENABLED = process.env.EMAIL_JOURNEYS_ENABLED === 'true'

/** Individual journeys can be disabled without turning everything off. */
const enabled = (name: string): boolean => {
  if (!JOURNEYS_ENABLED) return false
  // THE PROMOTIONAL KILL SWITCH (email consent release 2026-09-16). Campaigns
  // and owner automations already refused to send without
  // EMAIL_PROMOTIONS_ENABLED; the lifecycle journeys that send marketing email
  // did not, so "turn promotions off" left three sequences running. The
  // transactional journeys (reminders, balance) are deliberately untouched.
  if (PROMOTIONAL_JOURNEYS.has(name) && !promotionsEnabled()) return false
  return process.env[`EMAIL_JOURNEY_${name.toUpperCase().replace(/-/g, '_')}_DISABLED`] !== 'true'
}

/** The journeys whose emails are promotional (email-guard classifyTemplate). */
const PROMOTIONAL_JOURNEYS: ReadonlySet<string> = new Set(['abandoned', 'quote', 'lead-nurture'])

/**
 * The language a lead-scoped stage (quote follow-up, lead nurture) is rendered
 * in. The EXISTING templates already have Spanish versions (i18n subjects); the
 * stages used to hard-code English. A lead running on a form notice carries the
 * language of that submission on its consent event; anything else keeps
 * today's English.
 */
export function stageLocaleFromBasis(basisLocale: string | null | undefined): 'en' | 'es' {
  return typeof basisLocale === 'string' && basisLocale.toLowerCase().startsWith('es') ? 'es' : 'en'
}

/**
 * The name a stage greets the person by, or undefined for the template's own
 * default ("there"). A lead captured without a name carries a placeholder
 * ("Website lead", "Booking lead") that must never reach a greeting — the
 * popup and the tracker landing page do not ask for a name.
 */
export function greetingName(name: string | null | undefined): string | undefined {
  const t = typeof name === 'string' ? name.trim() : ''
  if (!t || /^(website|booking) lead$/i.test(t)) return undefined
  return t
}

/** EMAIL_PROMOTIONS_ENABLED, read at CALL time so a flip needs no restart. */
export function promotionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EMAIL_PROMOTIONS_ENABLED === 'true'
}

// ════════════════════════════════════════════════════════════════════════
//  SCENARIO SEQUENCES (email consent release 2026-09-16, DESIGN-v2 §1 and §7)
//  ---------------------------------------------------------------------
//  Every genuine form submission with an email enters the most relevant
//  EXISTING sequence, with its existing templates and cadence (owner direction
//  2026-09-16; the one copy change is the corrected lead-nurture footer):
//    quote.html, real server quote        → quote_followup (Sequence A)
//    quote.html, no price                 → lead_nurture (Sequence B)
//    booking form, contact step Continue  → lead_nurture
//    booking submitted, not paid          → abandoned_checkout
//    contact form (every topic), popup,
//    tracker landing                      → lead_nurture
//  The routes decide which one; SURFACE_SEQUENCE_KINDS bounds it.
//
//  Every kind keeps its EXISTING flag (EMAIL_JOURNEY_<X>_DISABLED) plus the
//  master switch, EMAIL_PROMOTIONS_ENABLED and, for a notice,
//  EMAIL_NOTICE_BASIS_ENABLED.
// ════════════════════════════════════════════════════════════════════════

/**
 * May a sequence of this kind be scheduled or sent right now? Read at call
 * time: the existing flags plus the promotions switch.
 */
export function sequenceKindEnabled(kind: SequenceKind, env: Record<string, string | undefined> = process.env): boolean {
  if (!JOURNEYS_ENABLED || !promotionsEnabled(env)) return false
  switch (kind) {
    case 'quote_followup':
      return env.EMAIL_JOURNEY_QUOTE_DISABLED !== 'true'
    case 'abandoned_checkout':
      return env.EMAIL_JOURNEY_ABANDONED_DISABLED !== 'true'
    case 'lead_nurture':
      return env.EMAIL_JOURNEY_LEAD_NURTURE_DISABLED !== 'true'
    default:
      return false
  }
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

/**
 * The job-id journey segment for a sequence kind. The existing kinds keep
 * their existing segments, so a cancel built from an enrollment row finds the
 * jobs the existing schedulers created. Hyphens only: no ':' ever reaches a
 * BullMQ custom id (queue-jobid-safety.test.ts).
 */
export function journeyKeyFor(kind: SequenceKind): string {
  switch (kind) {
    case 'quote_followup':
      return 'quote'
    case 'abandoned_checkout':
      return 'abandoned'
    case 'lead_nurture':
      return 'lead-nurture'
    default:
      return 'unknown'
  }
}

/** The stage list a sequence kind schedules. */
export function stagesForKind(kind: SequenceKind): JourneyStage[] {
  if (kind === 'quote_followup') return QUOTE_STAGES
  if (kind === 'lead_nurture') return LEAD_NURTURE_STAGES
  return ABANDONED_STAGES
}

/** Every queue job id a sequence of this kind can own for one subject. */
export function stageJobIdsForKind(kind: SequenceKind, subjectId: string): string[] {
  return stagesForKind(kind).map((s) => jobIdFor(journeyKeyFor(kind), s.type, subjectId))
}

/**
 * The sequence kind a lead-scoped template belongs to when the job carries
 * none (jobs queued before this release, campaign rechecks).
 */
export function sequenceKindForTemplate(template: string | undefined): SequenceKind | null {
  if (!template) return null
  if (/^quote-followup-(?:\d+|final)$/.test(template)) return 'quote_followup'
  if (/^lead-nurture-(?:\d+|final)$/.test(template)) return 'lead_nurture'
  return null
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
): Promise<ScheduleSummary> {
  const plan = planStageTimes(stages, anchor, {
    now: deps.now().getTime(),
    moveDate: opts.moveDate ?? null,
  })
  const summary = emptySummary()
  for (const p of plan) {
    if (p.skip) {
      log.info({ subjectId, stage: p.stage.type, reason: p.skip }, 'stage skipped')
      summary.skipped++
      continue
    }
    // An enqueue that FAILED must not be counted as scheduled (2026-09-15): the
    // admin audit and the repair sweep both trust this number. A failure is
    // either durably recorded for retry or LOST — never "scheduled".
    const r = await deps.enqueue(p.stage.type, data, new Date(p.fireAt), jobIdFor(journey, p.stage.type, subjectId))
    tally(summary, enqueueStatusOf(r))
  }
  return summary
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

/** The queue surface `cancel` needs, on top of adding. */
export type JourneyQueue = QueueLike & {
  getJob(jobId: string): Promise<{ remove(): Promise<unknown> } | undefined | null>
}

/**
 * The queue edge of every journey: DURABLE enqueue + best-effort cancel.
 *
 * Enqueue goes through lifecycle-enqueue.enqueueDurable (2026-09-15): an add
 * that fails or times out records the exact job for the hourly sweep instead
 * of vanishing behind a "non-fatal" log. The path and its lateness bound come
 * from the stage type (lifecycle-enqueue.retryWindowFor), and the quiet-hours
 * shift is the same one this module always applied at schedule time.
 *
 * Injectable (queue, store, clock) so the failure paths are testable offline
 * with the production code, not a copy of it.
 */
export function journeyQueueEdge(
  edge: { queue?: JourneyQueue; store?: RetryStore; now?: () => Date } = {}
): Pick<JourneyDeps, 'enqueue' | 'cancel'> {
  // Resolved lazily: touching the queue proxy at construction would open Redis
  // during `next build`.
  const queue = (): JourneyQueue => edge.queue ?? (scheduledQueue as unknown as JourneyQueue)
  const store = (): RetryStore => edge.store ?? defaultRetryStore()
  const now = edge.now ?? (() => new Date())

  return {
    /** Enqueue one stage. Guarded so a Redis stall can never hang the caller. */
    async enqueue(stage, data, fireAt, jobId): Promise<EnqueueResult> {
      const window = retryWindowFor(stage, fireAt)
      const subjectType = typeof data.leadId === 'string' ? 'lead' : 'booking'
      const subjectId = String((subjectType === 'lead' ? data.leadId : data.bookingId) ?? '')
      if (!window) {
        // A stage with no retry policy is a programming error; it is still
        // attempted, but a failure cannot be recorded without a bound.
        log.error({ stage, jobId }, 'no lifecycle retry policy for this stage — a failed enqueue would be LOST')
      }
      return enqueueDurable(
        {
          queue: queue(),
          // Named here, not read off the proxy: see DurableEnqueueInput.
          queueName: 'scheduled',
          name: stage,
          data: { type: stage, ...data },
          jobId,
          fireAt,
          // Without a policy the bound is the fire time itself: the sweep then
          // abandons rather than guessing.
          notAfter: window?.notAfter ?? fireAt,
          path: window?.path ?? 'quote-journey',
          subjectType,
          subjectId,
        },
        {
          store: store(),
          now,
          // Shift promotional sends out of quiet hours at SCHEDULE time. The
          // guard re-checks at send time too — this just avoids deferral churn.
          shift: (d) => nextAllowedTime(d),
        }
      )
    },

    /** Best-effort removal of a pending stage. Absent/active jobs are not errors.
     *  Time-boxed like `enqueue` above: with `maxRetriesPerRequest: null` (the
     *  BullMQ requirement) ioredis retries a command FOREVER, so an un-raced
     *  `getJob` during a Redis outage would hang the booking cancel / confirm /
     *  reschedule REQUEST instead of failing soft. The send-time recheck is the
     *  real stop — losing one best-effort removal is never worse than that.
     *
     *  It ALSO closes any retry row for this job id (2026-09-15), FIRST and
     *  independently of Redis: a cancel during an outage is exactly when a row
     *  exists, and a sweep must never re-add a cancelled stage. */
    async cancel(jobId) {
      try {
        await timeboxed(store().abandonForJobIds([jobId], CANCELLED_REASON, now()), 5000, 'retry row close')
      } catch (err) {
        log.warn({ jobId, err: err instanceof Error ? err.message : String(err) }, 'could not close retry row on cancel (the stage handler still rechecks)')
      }
      try {
        const job = await timeboxed(queue().getJob(jobId), 5000, 'scheduledQueue.getJob (Redis?)')
        if (job) await timeboxed(job.remove(), 5000, 'job.remove (Redis?)')
      } catch (err) {
        // A job that already started cannot be removed — the send-time recheck is
        // what actually stops it. This is exactly why cancellation is not the only
        // protection.
        log.info({ jobId, err: err instanceof Error ? err.message : String(err) }, 'cancel skipped (job active or gone)')
      }
    },
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
  /** The durable outcome (lifecycle-enqueue). Older injected test worlds may
   *  resolve a boolean: `false` = not queued and nothing recorded (LOST),
   *  `true`/void = scheduled. */
  enqueue(stage: string, data: Record<string, unknown>, fireAt: Date, jobId: string): Promise<EnqueueResult | boolean | void>
  cancel(jobId: string): Promise<void>
  loadLead(leadId: string): Promise<JourneyLead | null>
  /** Booking HISTORY, not lead status — leads.hasBookingOnRecord in production. */
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

  // ── CONSENT + PERSON-LEVEL ENROLLMENT (email consent release 2026-09-16) ──
  //  OPTIONAL ONLY so the older injected test worlds keep compiling, exactly
  //  like the boolean `enqueue` result above. A world without them gets the
  //  legacy column rule and per-lead scheduling, unchanged. The production
  //  deps provide every one, and the NEW sequences refuse to run without them.
  /** consent/marketing-eligibility.promotionalEligibility. Never throws. */
  eligibility?(req: EligibilityRequest): Promise<EligibilityDecision>
  /** consent/sequence-enrollment.enrollSequence (default client). Never throws. */
  enrollSequence?(input: EnrollSequenceInput): Promise<EnrollSequenceResult>
  /** Stop the person's ACTIVE enrollments of these kinds. THROWS on a DB error. */
  stopPersonEnrollments?(email: string, reason: string, kinds: readonly SequenceKind[]): Promise<EnrollmentRef[]>
  /** Open (not booked, not lost) lead ids for an address. THROWS on a DB error. */
  openLeadIdsForEmail?(email: string): Promise<string[]>
  /** The booking's recipient address and its STORED basis event. */
  loadBookingBasis?(bookingId: string): Promise<{ email: string | null; basisEventId: string | null } | null>
  /** Stop the ACTIVE enrollments whose subject is this lead or booking. Never throws. */
  stopSubjectEnrollments?(subjectType: EnrollmentSubjectType, subjectId: string, reason: string): Promise<void>
  /** Has this lead already been SENT the first email of this sequence? THROWS on a DB error. */
  sequenceAlreadySent?(leadId: string, kind: SequenceKind): Promise<boolean>
}

let _deps: JourneyDeps | undefined
export function defaultJourneyDeps(): JourneyDeps {
  if (_deps) return _deps
  _deps = {
    now: () => new Date(),
    ...journeyQueueEdge(),
    async loadLead(leadId) {
      return prisma.lead
        .findUnique({
          where: { id: leadId },
          select: {
            id: true, email: true, status: true, quotedAt: true, bookedAt: true, lostAt: true,
            moveDate: true, convertedBookingId: true, emailMarketingConsent: true, basisEventId: true,
          },
        })
        .catch((err) => {
          log.warn({ leadId, err: err instanceof Error ? err.message : String(err) }, 'lead read failed (non-fatal)')
          return null
        })
    },
    //  The nurture's booking check (leads.hasBookingOnRecord): a move taken
    //  before, or a booking still waiting for payment or approval.
    hasEverBooked: hasBookingOnRecord,
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
    eligibility: (req) => promotionalEligibility(req, sendTimeEligibilityDeps()),
    // The DEFAULT client, never a transaction client: a unique violation
    // aborts a Postgres transaction (see sequence-enrollment.enrollSequence).
    enrollSequence: (input) => enrollSequence(input),
    async stopPersonEnrollments(email, reason, kinds) {
      const normalized = normalizeEmail(email)
      const active = await prisma.sequenceEnrollment.findMany({
        where: { emailNormalized: normalized, status: 'active', sequenceKind: { in: [...kinds] } },
        select: { id: true, sequenceKind: true, subjectType: true, subjectId: true },
      })
      if (active.length === 0) return []
      // status: 'active' again in the WHERE, so a row a concurrent writer
      // already stopped or completed keeps its own reason.
      await prisma.sequenceEnrollment.updateMany({
        where: { id: { in: active.map((a) => a.id) }, status: 'active' },
        data: { status: 'stopped', stopReason: String(reason).slice(0, 80) },
      })
      return active
    },
    async stopSubjectEnrollments(subjectType, subjectId, reason) {
      await prisma.sequenceEnrollment
        .updateMany({
          where: { subjectType, subjectId, status: 'active' },
          data: { status: 'stopped', stopReason: String(reason).slice(0, 80) },
        })
        .catch((err) => {
          log.warn({ subjectType, subjectId, err: err instanceof Error ? err.message : String(err) }, 'could not stop the subject enrollments (the send-time gate still refuses)')
        })
    },
    async sequenceAlreadySent(leadId, kind) {
      const first = stagesForKind(kind)[0]?.type
      if (!first) return false
      const row = await prisma.emailSend.findFirst({
        where: { leadId, template: first, status: 'delivered' },
        select: { id: true },
      })
      return Boolean(row)
    },
    async openLeadIdsForEmail(email) {
      const rows = await prisma.lead.findMany({
        where: {
          email: { equals: normalizeEmail(email), mode: 'insensitive' },
          bookedAt: null,
          lostAt: null,
          convertedBookingId: null,
          status: { notIn: [LeadStatus.BOOKED, LeadStatus.LOST] },
        },
        select: { id: true },
        take: 50,
      })
      return rows.map((r) => r.id)
    },
    async loadBookingBasis(bookingId) {
      const row = await prisma.booking
        .findUnique({ where: { id: bookingId }, select: { basisEventId: true, customer: { select: { email: true } } } })
        .catch((err) => {
          log.warn({ bookingId, err: err instanceof Error ? err.message : String(err) }, 'booking basis read failed (non-fatal)')
          return null
        })
      return row ? { email: row.customer?.email ?? null, basisEventId: row.basisEventId ?? null } : null
    },
  }
  return _deps
}

/**
 * The permission half of a promotional gate, given the eligibility decision.
 *
 *   • no decision (an older injected world, or no address to ask about) —
 *     the legacy rule: the lead's own explicit opt-in, nothing else;
 *   • a decision — it is authoritative. It already contains the subject's own
 *     consent column as express consent, every per-person prohibition
 *     (suppression, opt-out, decline, test identity) and the notice rules.
 *
 * 'no_marketing_basis' is reported as the historical 'no_marketing_consent',
 * which email-guard classifies retryable: a later opt-in can still rescue the
 * send, exactly as before. Every other refusal keeps its own name.
 */
export function marketingConsentBlock(legacyConsent: boolean, decision?: EligibilityDecision | null): string | null {
  if (decision === undefined || decision === null) return legacyConsent ? null : 'no_marketing_consent'
  if (decision.eligible) return null
  return decision.reason === 'no_marketing_basis' ? 'no_marketing_consent' : decision.reason
}

/** Ask the eligibility gate about a lead, when this world can. */
async function leadDecision(
  deps: JourneyDeps,
  lead: JourneyLead,
  sequenceKind: SequenceKind | null
): Promise<EligibilityDecision | undefined> {
  if (!deps.eligibility || !lead.email) return undefined
  return deps.eligibility({
    context: 'scenario_flow',
    email: lead.email,
    subject: { type: 'lead', id: lead.id, sequenceKind },
    now: deps.now(),
  })
}

type EnrollmentClaim = { ok: true; enrollment: EnrollmentRecord | null } | { ok: false; reason: string }

/**
 * PER-PERSON IDEMPOTENT ENROLLMENT, without losing retryable scheduling.
 *
 * `enrollSequence` answers 'already_enrolled' for ANY enrollment of the kind
 * in the last 30 days. Two cases hide behind that answer:
 *   • the SAME subject asking again (a form re-save, the repair sweep, an
 *     enqueue that failed last time) — the sequence is ours; re-scheduling it
 *     is harmless (stable job ids + the guard's idempotency key) and is what
 *     keeps enrolment retryable;
 *   • a DIFFERENT subject for the same person (a second lead, a double
 *     submit) while that sequence is still ACTIVE, or a stopped sequence for
 *     this subject — always refused: nobody gets two copies of one sequence.
 *   • a different subject whose sequence already ENDED (stopped or completed)
 *     inside the 30-day window — refused for a sequence running on a FORM
 *     NOTICE (one per person per window). For an express / legacy opt-in
 *     (`personLimit: false`) the existing per-flow behaviour is preserved
 *     (owner direction 2026-09-16): a later quote or booking gets its sequence,
 *     scheduled without a row of its own, exactly as before this release.
 * A database error schedules nothing: a sequence without its row is a
 * sequence no stop rule can find.
 */
async function claimEnrollment(
  deps: JourneyDeps,
  input: { email: string; kind: SequenceKind; subjectType: EnrollmentSubjectType; subjectId: string; basisEventId: string | null },
  opts: { required: boolean; personLimit?: boolean }
): Promise<EnrollmentClaim> {
  if (!deps.enrollSequence) {
    return opts.required ? { ok: false, reason: 'enrollment_unavailable' } : { ok: true, enrollment: null }
  }
  const r = await deps.enrollSequence({
    email: input.email,
    sequenceKind: input.kind,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    basisEventId: input.basisEventId,
    now: deps.now(),
  })
  if (r.outcome === 'created') return { ok: true, enrollment: r.enrollment }
  if (r.outcome === 'already_enrolled') {
    const e = r.enrollment
    if (e && e.status === 'active' && e.subjectType === input.subjectType && e.subjectId === input.subjectId) {
      return { ok: true, enrollment: e }
    }
    //  Only an ENDED sequence for a DIFFERENT subject is exempt, and only for an
    //  express / legacy opt-in. An unknown row (null) is never exempt. A row
    //  still marked active whose last stage is long past has ended too: nothing
    //  marks a finished sequence completed, and its subject may have closed
    //  before the stop hooks existed.
    const sameSubject = !!e && e.subjectType === input.subjectType && e.subjectId === input.subjectId
    const endedElsewhere = !!e && !sameSubject && (e.status !== 'active' || enrollmentOutlivedItsStages(e, deps.now()))
    if (opts.personLimit === false && endedElsewhere) return { ok: true, enrollment: null }
    return { ok: false, reason: 'already_enrolled' }
  }
  if (r.outcome === 'refused') return { ok: false, reason: `enrollment_refused:${r.reason}` }
  return { ok: false, reason: 'enrollment_failed' }
}

/**
 * A sequence's stages all fire within its last stage's delay (plus the quote
 * confirmation wait and a day's slack for quiet hours and retries). An ACTIVE
 * row older than that has, in practice, finished.
 */
export function enrollmentOutlivedItsStages(e: { sequenceKind: string; createdAt: Date }, now: Date): boolean {
  if (!isSequenceKind(e.sequenceKind)) return false
  const stages = stagesForKind(e.sequenceKind)
  const last = stages.length ? Math.max(...stages.map((s) => s.delay)) : 0
  return now.getTime() - e.createdAt.getTime() > last + CONFIRMATION_WAIT_MAX_MS + DAY
}

/** Shape a stage-scheduling summary into an enrolment outcome. */
function outcomeFromSummary(summary: ScheduleSummary): EnrolmentOutcome {
  const { scheduled: stages, recordedForRetry, lost } = summary
  const failures = recordedForRetry + lost > 0 ? { recordedForRetry, lost } : {}
  if (recordedForRetry + lost > 0 && stages === 0) {
    return { scheduled: false, reason: lost > 0 ? 'enqueue_failed' : 'recorded_for_retry', ...failures }
  }
  return { scheduled: true, stages, ...failures }
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
): Promise<ScheduleSummary | null> {
  // Owner automations on this trigger enroll regardless of the journey flag —
  // they carry their own ACTIVE + EMAIL_PROMOTIONS_ENABLED gates. Fire-and-
  // forget: a trigger failure must never break checkout.
  deps.fireBookingTrigger('booking_started', bookingId)
  return scheduleAbandonedRecovery(bookingId, deps)
}

/**
 * The abandoned-checkout SCHEDULING, without the automation trigger — so the
 * notice path (onNoticeSubmission) can ask for the same sequence without
 * announcing a second 'booking_started' event for one booking.
 */
async function scheduleAbandonedRecovery(bookingId: string, deps: JourneyDeps): Promise<ScheduleSummary | null> {
  if (!enabled('abandoned')) {
    log.info({ bookingId }, 'abandoned-recovery journey disabled — not scheduling')
    return null
  }

  // PROMOTIONAL CONSENT (owner spec 2026-08-06). abandoned-checkout 1/2/3 are
  // promotional templates. The send gate in bookingEligibility is the
  // guarantee; refusing here as well means three doomed jobs are never queued
  // and the reason is logged at checkout, not 72 hours later.
  const consentBlock = await deps.bookingMarketingBlock(bookingId)

  // PER-PERSON PROHIBITIONS AND THE NOTICE BASIS (2026-09-16). When this world
  // can ask the eligibility gate, it is asked for the booking's own address:
  // an opt-out, decline, suppression or test identity refuses even where the
  // Customer column says yes, and a booking whose STORED basis is a valid
  // booking-surface notice may stand in for a missing consent column. Nothing
  // else the legacy check refuses (the canary, a deleted or test booking, a
  // customer opt-out) is ever overridden.
  let basisEventId: string | null = null
  let recipient: string | null = null
  let noticeBasis = false
  if (deps.eligibility && deps.loadBookingBasis) {
    const booking = await deps.loadBookingBasis(bookingId)
    recipient = booking?.email ?? null
    if (!recipient) {
      log.info({ bookingId, reason: consentBlock ?? 'no_email' }, 'no booking address — abandoned-recovery not scheduled')
      return null
    }
    const decision = await deps.eligibility({
      context: 'scenario_flow',
      email: recipient,
      subject: { type: 'booking', id: bookingId, sequenceKind: 'abandoned_checkout' },
      now: deps.now(),
    })
    if (!decision.eligible) {
      log.info({ bookingId, reason: decision.reason }, 'promotional eligibility refused — abandoned-recovery not scheduled')
      return null
    }
    if (consentBlock && consentBlock !== 'no_marketing_consent') {
      log.info({ bookingId, reason: consentBlock }, 'no promotional consent — abandoned-recovery not scheduled')
      return null
    }
    basisEventId = decision.basisEventId
    noticeBasis = decision.basis === 'notice'
  } else if (consentBlock) {
    log.info({ bookingId, reason: consentBlock }, 'no promotional consent — abandoned-recovery not scheduled')
    return null
  }

  const duplicateOf = await deps.siblingUnpaidBooking(bookingId)
  if (duplicateOf) {
    log.info({ bookingId, duplicateOf }, 'an earlier unpaid booking already owns a recovery sequence — not scheduling a second')
    return null
  }

  // ONE recovery sequence per PERSON per 30 days, as a database constraint.
  if (recipient) {
    const claim = await claimEnrollment(
      deps,
      { email: recipient, kind: 'abandoned_checkout', subjectType: 'booking', subjectId: bookingId, basisEventId },
      { required: false, personLimit: noticeBasis }
    )
    if (!claim.ok) {
      log.info({ bookingId, reason: claim.reason }, 'abandoned-recovery not scheduled (person-level enrollment)')
      return null
    }
  }

  // Parallel (each self-guarded), so a Redis stall bounds checkout to ~5s. The
  // outcomes are COUNTED, not discarded: "scheduled" is logged only when all
  // three stages were (2026-09-15).
  const now = deps.now().getTime()
  const results = await Promise.all(
    ABANDONED_STAGES.map((s) =>
      deps.enqueue(s.type, { bookingId }, new Date(now + s.delay), jobIdFor('abandoned', s.type, bookingId))
    )
  )
  const summary = results.reduce<ScheduleSummary>((acc, r) => tally(acc, enqueueStatusOf(r)), emptySummary())
  logScheduleSummary(log, { bookingId, stages: ABANDONED_STAGES.length }, 'abandoned-recovery', summary)
  return summary
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
}, deps: JourneyDeps = defaultJourneyDeps()): Promise<{ convertedLeadId: string | null; abandoned: ScheduleSummary | null }> {
  const { bookingId } = input
  let convertedLeadId: string | null = null
  let abandoned: ScheduleSummary | null = null

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

  // 2b. PERSON-LEVEL STOP (2026-09-16). The lead this booking converted is not
  //     the only one: the same person may have another open lead with a
  //     quote follow-up or nurture still running. Contained like step 1 — the send-time
  //     person_booked_since gate is the real stop, this only tidies the queue.
  if (input.email) {
    try {
      await onPersonBooked(input.email, deps)
    } catch (err) {
      log.warn(
        { bookingId, err: err instanceof Error ? err.message : String(err) },
        'person-level stop on booking failed (non-fatal) — the send-time gate still stops every sequence'
      )
    }
  }

  // 3. Reads the consent written in step 1.
  try {
    abandoned = await onCheckoutStarted(bookingId, deps)
  } catch (err) {
    log.error(
      { bookingId, err: err instanceof Error ? err.message : String(err) },
      'onCheckoutStarted failed (non-fatal)'
    )
  }

  return { convertedLeadId, abandoned }
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
  //  The booking's own recovery enrollment ends here too, so it never counts
  //  as a running sequence for the person's next booking.
  await deps.stopSubjectEnrollments?.('booking', bookingId, 'deposit_paid')
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
): Promise<ScheduleSummary | null> {
  if (!enabled('reminders') || !moveDate) return null

  const now = deps.now().getTime()
  const summary = emptySummary()
  for (const r of REMINDER_OFFSETS) {
    const fireAt = new Date(moveDate.getTime() - r.before)
    const jobId = jobIdFor('pre-move', r.type, bookingId)
    // Re-anchoring after a reschedule: drop the old job first. The cancel also
    // closes any retry row for the old anchor, so the sweep cannot resurrect it;
    // if the add below fails, a NEW row records the new anchor.
    await deps.cancel(jobId)
    if (fireAt.getTime() <= now) {
      log.info({ bookingId, stage: r.type }, 'reminder window already passed — skipping')
      summary.skipped++
      continue
    }
    tally(summary, enqueueStatusOf(await deps.enqueue(r.type, { bookingId }, fireAt, jobId)))
  }
  logScheduleSummary(log, { bookingId, moveDate }, 'pre-move reminders', summary)
  return summary
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
): Promise<ScheduleSummary | null> {
  // Owner automations enroll regardless of the journey flag (they have their
  // own gates); the pre-move reminder scheduling below keeps its flag.
  deps.fireBookingTrigger('booking_confirmed', bookingId)

  if (!enabled('reminders')) return null
  const b = await deps.loadBookingDates(bookingId)
  if (!b) {
    // Said out loud: nothing was scheduled and nothing recorded a retry.
    log.warn({ bookingId }, 'booking dates unavailable — pre-move reminders NOT scheduled')
    return null
  }
  return onMoveDateSet(bookingId, effectiveMoveDate(b), deps)
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
    // ...and runFollowup's quiet-hours re-add, which uses its own `__retry` id.
    // Cancelling it here also closes its retry row (2026-09-15), so a sweep can
    // never re-add a deferred follow-up for a cancelled booking.
    ...['review-request', 'review-reminder', 'repeat-reminder', 'referral-ask'].map(
      (t) => `followup__${t}__${bookingId}__retry`
    ),
  ]
  await Promise.all(ids.map((id) => deps.cancel(id)))
  // A cancelled booking has no truthful promotional automation left —
  // unconditional stop for every enrollment on it.
  deps.stopEnrollments({ bookingId }, 'booking_cancelled')
  await deps.stopSubjectEnrollments?.('booking', bookingId, 'booking_cancelled')
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
): Promise<EnqueueStatus | null> {
  // Completion is also the move_completed automation trigger.
  deps.fireBookingTrigger('move_completed', bookingId)

  if (!enabled('balance')) return null
  const status = enqueueStatusOf(
    await deps.enqueue(
      'balance-reminder-post',
      { bookingId },
      new Date(deps.now().getTime() + BALANCE_REMINDER_DELAY_MS),
      jobIdFor('balance', 'balance-reminder-post', bookingId)
    )
  )
  logScheduleSummary(log, { bookingId }, 'post-completion balance reminder', tally(emptySummary(), status))
  return status
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
  // `recordedForRetry` / `lost` appear only when some stage did not enqueue, so
  // a clean enrolment keeps its exact historical shape.
  | { scheduled: true; stages: number; recordedForRetry?: number; lost?: number }
  | { scheduled: false; reason: string; recordedForRetry?: number; lost?: number }

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
export type QuoteJourneyOptions = {
  /**
   * TRUE only on the customer's own submission path (onNoticeSubmission): the
   * lead's stored notice basis may then permit the quote follow-up. Every other
   * caller — the admin "mark quoted" route, the repair sweep, a repeat form
   * save — is EXPRESS-ONLY: a staff action or a background job is not the
   * submission the notice was shown for, and staff edits never enroll anyone.
   */
  allowNoticeBasis?: boolean
}

export async function ensureQuoteJourney(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps(),
  opts: QuoteJourneyOptions = {}
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

  if (!promotionsEnabled()) return { scheduled: false, reason: 'promotions_disabled' }
  if (!enabled('quote')) return { scheduled: false, reason: 'journey_disabled' }

  // THE SHARED STOP MATRIX, not a second hand-written one: converted, lost,
  // closed status, no email, no consent, move date passed. Re-running the same
  // predicate the worker runs at send time is what keeps a retryable enrolment
  // from resurrecting a journey the customer has moved past. The eligibility
  // decision (2026-09-16) adds the per-person prohibitions and — only on the
  // submission path (opts.allowNoticeBasis) — the lead's own stored notice
  // basis; see marketingConsentBlock. Without a sequence kind the decision
  // can only be an express permission.
  const decision = await leadDecision(deps, lead, opts.allowNoticeBasis === true ? 'quote_followup' : null)
  const block = quoteFollowupBlockReason(lead, deps.now(), decision)
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

  // A lead that was already SENT its quote follow-up is not enrolled again
  // (see ensureLeadNurture): the running or finished sequence keeps its jobs.
  if (deps.sequenceAlreadySent && (await deps.sequenceAlreadySent(leadId, 'quote_followup'))) {
    log.info({ leadId }, 'quote follow-up not re-enrolled — this lead already received it')
    return { scheduled: false, reason: 'already_sent' }
  }

  // ONE quote sequence per PERSON (2026-09-16), claimed after every refusal
  // above so a refused lead never occupies the person's slot.
  const claim = await claimEnrollment(
    deps,
    {
      email: lead.email as string,
      kind: 'quote_followup',
      subjectType: 'lead',
      subjectId: leadId,
      basisEventId: decision?.eligible ? decision.basisEventId : null,
    },
    { required: false, personLimit: !!decision && decision.eligible && decision.basis === 'notice' }
  )
  if (!claim.ok) {
    log.info({ leadId, reason: claim.reason }, 'quote follow-up not scheduled (person-level enrollment)')
    return { scheduled: false, reason: claim.reason }
  }

  const summary = await scheduleStages(deps, 'quote', QUOTE_STAGES, leadId, { leadId }, lead.quotedAt.getTime(), {
    moveDate: lead.moveDate,
  })
  logScheduleSummary(log, { leadId }, 'quote follow-up', summary)
  // Nothing queued is reported as such, so the admin audit is truthful. A
  // durable retry row re-adds the stages hourly; a LOST stage is re-attempted
  // by the stranded-journey repair (no ledger row exists for it).
  return outcomeFromSummary(summary)
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
    // Read a WIDER pool than the batch: already-attempted leads are filtered
    // out below, and taking only `limit` first let recent attempted leads
    // starve older stranded ones out of every pass.
    leads = await deps.repairCandidates({
      quotedSince: new Date(now.getTime() - QUOTE_JOURNEY_MAX_AGE_MS),
      limit: limit * 10,
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

  let stranded = 0
  for (const lead of leads) {
    if (attempted.has(lead.id)) {
      report.alreadyAttempted++
      continue
    }
    // The BATCH bound applies to stranded leads actually re-enrolled per pass.
    if (stranded >= limit) break
    stranded++
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
export type LeadNurtureOptions = {
  /**
   * TRUE only on the customer's own submission path (onNoticeSubmission): the
   * lead's stored form notice may then permit the nurture. Every other caller —
   * the legacy capture hooks, a staff edit, a repair job — is EXPRESS-ONLY.
   */
  allowNoticeBasis?: boolean
}

export async function onLeadCaptured(
  leadId: string,
  deps: JourneyDeps = defaultJourneyDeps(),
  opts: LeadNurtureOptions = {}
): Promise<ScheduleSummary | null> {
  return (await ensureLeadNurture(leadId, deps, opts)).summary
}

/** onLeadCaptured, with the refusal reason for the submission path. */
async function ensureLeadNurture(
  leadId: string,
  deps: JourneyDeps,
  opts: LeadNurtureOptions
): Promise<{ summary: ScheduleSummary | null; reason: string | null }> {
  const refuse = (reason: string) => ({ summary: null, reason })
  if (!enabled('lead-nurture')) return refuse('journey_disabled')

  const lead = await deps.loadLead(leadId)
  if (!lead) return refuse('lead_deleted')

  // Booking HISTORY, not lead status — see leads.hasEverBooked.
  const previousCustomer = await deps.hasEverBooked(lead.email)
  // Without a sequence kind the decision can only be an express permission (or
  // a per-person prohibition). The submission path names the kind, so the
  // lead's own stored notice may permit it.
  const decision = await leadDecision(deps, lead, opts.allowNoticeBasis === true ? 'lead_nurture' : null)
  const block = leadNurtureBlockReason({ ...lead, previousCustomer }, deps.now(), decision)
  if (block) {
    log.info({ leadId, reason: block }, 'lead nurture not scheduled')
    return refuse(block)
  }

  // CONTROLLED ROLLOUT. Unset allowlist ⇒ no restriction; see email-guard.
  if (!inRolloutAllowlist(lead.email ?? '', rolloutAllowlist())) {
    log.info({ leadId }, 'outside the rollout allowlist — lead nurture not scheduled')
    return refuse('not_in_rollout_allowlist')
  }

  // A lead that was already SENT this nurture (a returning person whose new
  // form merged into their old open lead) is not enrolled again: the stable
  // job ids and send keys would deliver nothing, and the empty row would block
  // the person's other leads for 30 days.
  if (deps.sequenceAlreadySent && (await deps.sequenceAlreadySent(leadId, 'lead_nurture'))) {
    log.info({ leadId }, 'lead nurture not scheduled — this lead already received it')
    return refuse('already_sent')
  }

  // ONE nurture per PERSON at a time; one per 30 days on a form notice.
  // Claimed after every refusal above so a refused lead never takes the slot.
  const claim = await claimEnrollment(
    deps,
    {
      email: lead.email as string,
      kind: 'lead_nurture',
      subjectType: 'lead',
      subjectId: leadId,
      basisEventId: decision?.eligible ? decision.basisEventId : null,
    },
    { required: false, personLimit: !!decision && decision.eligible && decision.basis === 'notice' }
  )
  if (!claim.ok) {
    log.info({ leadId, reason: claim.reason }, 'lead nurture not scheduled (person-level enrollment)')
    return refuse(claim.reason)
  }

  // Anchored on NOW, so no stage is ever overdue and the recovery stagger in
  // planStageTimes is never consulted. A nurture email landing after the
  // customer's own move date helps nobody and is dropped there.
  const summary = await scheduleStages(
    deps,
    'lead-nurture',
    LEAD_NURTURE_STAGES,
    leadId,
    { leadId },
    deps.now().getTime(),
    { moveDate: lead.moveDate }
  )
  // "scheduled" only when every stage was; see lifecycle-enqueue.logScheduleSummary.
  logScheduleSummary(log, { leadId }, 'lead nurture', summary)
  return { summary, reason: null }
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
  await deps.stopSubjectEnrollments?.('lead', leadId, 'lead_closed')
  log.info({ leadId }, 'quote follow-up cancelled (lead closed)')
}

// ════════════════════════════════════════════════════════════════════════
//  SCENARIO ENTRY POINTS (email consent release 2026-09-16)
//  ---------------------------------------------------------------------
//  What the capture routes call. Every one of them:
//    • is a no-op unless its sequence's flags are on (sequenceKindEnabled);
//    • asks promotionalEligibility, with the subject's STORED basisEventId —
//      the route stores the notice event on the Lead/Booking first;
//    • enrolls through the person-level unique row, and schedules ONLY on a
//      new enrollment (or its own subject re-asking; see claimEnrollment);
//    • never throws for a business reason and never breaks the request.
//  Stopping is PERSON-level (onPersonBooked, onPersonOptedOut). Cancelling
//  queue jobs is the optimisation; the send-time gate (scenarioSendDecision)
//  is the enforcement.
// ════════════════════════════════════════════════════════════════════════

export type NoticeSubmissionInput = {
  /** DERIVED BY THE ROUTE, never read from the request body. */
  surface: NoticeSurface
  /** The scenario the route decided on (quote_followup, abandoned_checkout). */
  scenario: SequenceKind
  leadId?: string | null
  bookingId?: string | null
  /** The notice_accepted event the route recorded and STORED on the subject. */
  basisEventId: string | null
  /** The address the submission recorded the notice for. */
  email: string
}

const refused = (reason: string): EnrolmentOutcome => ({ scheduled: false, reason })

/**
 * A capture route recorded a submission → start its scenario sequence.
 *
 * Refuses (never throws) when the scenario does not belong to the surface, when
 * the address or basis does not match the stored subject, and for every reason
 * the sequence's own scheduler refuses.
 */
export async function onNoticeSubmission(
  input: NoticeSubmissionInput,
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<EnrolmentOutcome> {
  try {
    if (!isNoticeSurface(input.surface)) return refused('unknown_surface')
    if (!isSequenceKind(input.scenario) || !SURFACE_SEQUENCE_KINDS[input.surface].includes(input.scenario)) {
      return refused('scenario_not_on_surface')
    }
    const email = normalizeEmail(input.email)
    if (!email) return refused('no_email')

    if (input.scenario === 'abandoned_checkout') {
      const bookingId = String(input.bookingId ?? '').trim()
      if (!bookingId) return refused('no_booking')
      if (deps.loadBookingBasis) {
        const booking = await deps.loadBookingBasis(bookingId)
        if (!booking) return refused('booking_deleted')
        if (normalizeEmail(booking.email ?? '') !== email) return refused('basis_email_mismatch')
        if (input.basisEventId && booking.basisEventId !== input.basisEventId) return refused('basis_not_stored')
      }
      const summary = await scheduleAbandonedRecovery(bookingId, deps)
      if (!summary) return refused('not_scheduled')
      logScheduleSummary(log, { bookingId, scenario: input.scenario }, 'abandoned-recovery (notice submission)', summary)
      return outcomeFromSummary(summary)
    }

    const leadId = String(input.leadId ?? '').trim()
    if (!leadId) return refused('no_lead')
    const lead = await deps.loadLead(leadId)
    if (!lead) return refused('lead_deleted')
    if (!lead.email || normalizeEmail(lead.email) !== email) return refused('basis_email_mismatch')
    if (input.basisEventId && (lead.basisEventId ?? null) !== input.basisEventId) return refused('basis_not_stored')

    if (input.scenario === 'quote_followup') return await ensureQuoteJourney(leadId, deps, { allowNoticeBasis: true })
    if (input.scenario === 'lead_nurture') {
      const r = await ensureLeadNurture(leadId, deps, { allowNoticeBasis: true })
      if (!r.summary) return refused(r.reason ?? 'not_scheduled')
      return outcomeFromSummary(r.summary)
    }
    return refused('scenario_not_supported')
  } catch (err) {
    log.error(
      { scenario: input.scenario, leadId: input.leadId, bookingId: input.bookingId, err: err instanceof Error ? err.message : String(err) },
      'notice submission scheduling failed (non-fatal)'
    )
    return refused('scheduling_failed')
  }
}

/** Kinds a new booking ends. Abandoned checkout is the booking's OWN sequence. */
export const BOOKING_STOPS_KINDS: readonly SequenceKind[] = SEQUENCE_KINDS.filter((k) => k !== 'abandoned_checkout')

export type PersonStopReport = { stopped: number; cancelledJobs: number; errors: number }

/**
 * Stop a person's sequences and remove their queued jobs, best effort.
 *   1. the enrollment rows of `kinds` (plus any refs the caller already stopped
 *      in its own transaction, e.g. recordConsentEvent's stoppedEnrollments);
 *   2. the lead-scoped jobs of EVERY open lead for the address — a sequence
 *      scheduled before enrollment rows existed has no row to find it by.
 */
async function stopPerson(
  email: string,
  reason: string,
  kinds: readonly SequenceKind[],
  deps: JourneyDeps,
  alreadyStopped: readonly EnrollmentRef[] = []
): Promise<PersonStopReport> {
  const report: PersonStopReport = { stopped: 0, cancelledJobs: 0, errors: 0 }
  if (!normalizeEmail(email)) return report
  const refs: EnrollmentRef[] = [...alreadyStopped]
  if (deps.stopPersonEnrollments) {
    try {
      refs.push(...(await deps.stopPersonEnrollments(email, reason, kinds)))
    } catch (err) {
      report.errors++
      log.warn({ reason, err: err instanceof Error ? err.message : String(err) }, 'could not stop enrollments (the send-time gate still refuses)')
    }
  }
  report.stopped = refs.length

  const ids = new Set<string>()
  for (const ref of refs) {
    if (!isSequenceKind(ref.sequenceKind) || !kinds.includes(ref.sequenceKind)) continue
    for (const id of stageJobIdsForKind(ref.sequenceKind, ref.subjectId)) ids.add(id)
  }
  if (deps.openLeadIdsForEmail) {
    try {
      for (const leadId of await deps.openLeadIdsForEmail(email)) {
        for (const kind of kinds) {
          if (kind === 'abandoned_checkout') continue
          for (const id of stageJobIdsForKind(kind, leadId)) ids.add(id)
        }
        for (const s of LEAD_NURTURE_STAGES) ids.add(jobIdFor('lead-nurture', s.type, leadId))
      }
    } catch (err) {
      report.errors++
      log.warn({ reason, err: err instanceof Error ? err.message : String(err) }, 'could not list open leads to cancel (the send-time gate still refuses)')
    }
  }
  await Promise.all(Array.from(ids).map((id) => deps.cancel(id)))
  report.cancelledJobs = ids.size
  log.info({ reason, ...report }, 'person-level sequences stopped')
  return report
}

/**
 * The person created a booking → end every lead-scoped sequence for the
 * ADDRESS, not only the converted lead's: another open lead's quote
 * follow-up or nurture. Their own abandoned-checkout sequence is not
 * touched. Enforced again at send time by person_booked_since.
 */
export async function onPersonBooked(email: string, deps: JourneyDeps = defaultJourneyDeps()): Promise<PersonStopReport> {
  return stopPerson(email, 'person_booked', BOOKING_STOPS_KINDS, deps)
}

/**
 * The person opted out (capture box, decline, unsubscribe) → end EVERY
 * sequence, abandoned checkout included. Pass the refs recordConsentEvent
 * already stopped in its transaction so their jobs are cancelled too.
 * Enforced again at send time by the eligibility gate.
 */
export async function onPersonOptedOut(
  email: string,
  opts: { stopped?: readonly EnrollmentRef[]; reason?: string } = {},
  deps: JourneyDeps = defaultJourneyDeps()
): Promise<PersonStopReport> {
  return stopPerson(email, opts.reason ?? 'opted_out', SEQUENCE_KINDS, deps, opts.stopped ?? [])
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
  /**
   * The notice/express event this lead's submission recorded (2026-09-16).
   * Informational here — the eligibility loader reads the STORED value itself.
   */
  basisEventId?: string | null
}

/**
 * May this lead still receive a quote follow-up? Returns a reason to ABORT,
 * or null to proceed. Mirrors the transition matrix in
 * docs/email-marketing/triggers-and-stop-rules.md.
 *
 * `decision` (2026-09-16): the promotionalEligibility answer for this lead and
 * sequence. Omitted, the legacy column rule applies unchanged; supplied, it is
 * the consent answer (see marketingConsentBlock).
 */
export function quoteFollowupBlockReason(
  lead: LeadState | null,
  now: Date = new Date(),
  decision?: EligibilityDecision | null
): string | null {
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
  const consentBlock = marketingConsentBlock(hasPromotionalConsent({ emailMarketingConsent: lead.emailMarketingConsent }), decision)
  if (consentBlock) return consentBlock
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
const TRANSACTIONAL_LEAD_TEMPLATES: ReadonlySet<string> = new Set([
  'quote-request-received',
])

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
export function leadNurtureBlockReason(
  lead: NurtureLeadState | null,
  now: Date = new Date(),
  decision?: EligibilityDecision | null
): string | null {
  if (!lead) return 'lead_deleted'
  if (!lead.email) return 'no_email'
  // PROMOTIONAL. Same rule, same tested predicate, same tri-state refusal.
  const consentBlock = marketingConsentBlock(hasPromotionalConsent({ emailMarketingConsent: lead.emailMarketingConsent }), decision)
  if (consentBlock) return consentBlock
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

// ════════════════════════════════════════════════════════════════════════
//  SEND-TIME ENFORCEMENT (email consent release 2026-09-16, DESIGN-v2 §7)
//  ---------------------------------------------------------------------
//  Everything that stops a promotional lead email is checked HERE, at the
//  moment it would go out — the stage handler asks, and the email worker asks
//  again immediately before the provider call:
//    • the promotions kill switch;
//    • the per-person prohibitions and the lead's own basis
//      (promotionalEligibility: suppression, opt-out, decline, test identity,
//      notice window, basis email match);
//    • the journey's state matrix (converted, lost, quote, move date …);
//    • in a scenario flow: the enrollment is still active and belongs to THIS
//      lead, and the person has not booked since it started
//      (person_booked_since, any non-test booking).
//  Job cancellation is only ever an optimisation on top of this.
// ════════════════════════════════════════════════════════════════════════

/** The lead columns every send-time decision reads. */
export type StageLead = LeadState & {
  id: string
  name: string
  jobType: string | null
  createdAt: Date
  basisEventId: string | null
}

/** What the provider has told us about the quick-quote confirmation. */
export type ConfirmationState = 'delivered' | 'pending' | 'failed'

/** The injectable edge of every send-time decision. */
export interface StageDeps {
  now(): Date
  env: Record<string, string | undefined>
  /** THROWS on a database error: the caller fails closed. */
  loadStageLead(leadId: string): Promise<StageLead | null>
  /** promotionalEligibility. Never throws. */
  eligibility(req: EligibilityRequest): Promise<EligibilityDecision>
  /** leads.hasBookingOnRecord — true on a read error. */
  hasEverBooked(email: string | null): Promise<boolean>
  /** The newest ACTIVE enrollment of this kind. THROWS on a database error. */
  activeEnrollment(email: string, kind: SequenceKind): Promise<EnrollmentRecord | null>
  /** Any real booking created after `since`. True on a read error. */
  personBookedSince(email: string, since: Date): Promise<boolean>
  /** THROWS on a database error. */
  quoteConfirmationState(leadId: string): Promise<ConfirmationState>
  /** Mark one enrollment stopped. Never throws. */
  stopEnrollment(enrollmentId: string, reason: string): Promise<void>
}

export type SendDecision = {
  reason: string | null
  decision: EligibilityDecision | null
  enrollment: EnrollmentRecord | null
}

/**
 * THE promotional lead gate. Reason to refuse, or null to send.
 * `recipient` is the address the job would actually send to.
 */
export async function scenarioSendDecision(
  input: {
    leadId: string
    lead: StageLead | null
    template?: string
    kind: SequenceKind | null
    context: EligibilityContext
    recipient?: string | null
  },
  deps: StageDeps
): Promise<SendDecision> {
  const { lead, leadId, kind, context } = input
  const out = (reason: string | null, decision: EligibilityDecision | null = null, enrollment: EnrollmentRecord | null = null): SendDecision => ({
    reason,
    decision,
    enrollment,
  })
  if (!lead) return out('lead_deleted')
  if (!lead.email) return out('no_email')
  // A job carries the address it was scheduled for. If the lead's address has
  // changed since (an in-session correction), the basis was never given for
  // the address the job would reach.
  if (input.recipient && normalizeEmail(input.recipient) !== normalizeEmail(lead.email)) return out('basis_email_mismatch')
  if (!promotionsEnabled(deps.env)) return out('promotions_disabled')

  const decision = await deps.eligibility({
    context,
    email: lead.email,
    subject: { type: 'lead', id: leadId, sequenceKind: kind },
    now: deps.now(),
  })

  let block: string | null
  if (input.template !== undefined && NURTURE_TEMPLATES.has(input.template)) {
    // The booking-history question is asked HERE, at send time, because it
    // can become true between scheduling and sending — someone who booked
    // yesterday must not get tomorrow's "still need an estimate?".
    const previousCustomer = await deps.hasEverBooked(lead.email)
    block = leadNurtureBlockReason({ ...lead, previousCustomer }, deps.now(), decision)
  } else {
    block = quoteFollowupBlockReason(lead, deps.now(), decision)
  }
  if (block) return out(block, decision)

  if (context !== 'scenario_flow' || !kind) return out(null, decision)

  //  ENROLLMENT + person_booked_since. A sequence running on a notice exists
  //  only through its enrollment row. A legacy quote sequence queued before
  //  enrollment rows existed has none, and keeps running on its own lead's
  //  timeline.
  const enrollment = await deps.activeEnrollment(lead.email, kind)
  const requireEnrollment = decision.eligible && decision.basis === 'notice'
  //  Another subject's row blocks only while it could still be sending — the
  //  same "outlived its stages" rule the enrollment claim uses, so an express
  //  person the claim let through is not refused here.
  //  Only THIS lead's row counts as its enrollment: another lead's (even an
  //  outlived one) never stands in for it, never anchors person_booked_since
  //  and is never returned for the confirmation gate to stop.
  const own = enrollment && enrollment.subjectType === 'lead' && enrollment.subjectId === leadId ? enrollment : null
  if (enrollment && !own && !enrollmentOutlivedItsStages(enrollment, deps.now())) {
    return out('already_enrolled', decision)
  }
  if (requireEnrollment && !own) return out('enrollment_not_active', decision)
  const since = own ? own.createdAt : lead.createdAt
  if (await deps.personBookedSince(lead.email, since)) return out('person_booked_since', decision, own)
  return out(null, decision, own)
}

export type LeadEligibilityOptions = {
  /**
   * The eligibility context. Defaults to 'automation' — express consent on the
   * lead's OWN row only, never a notice — which is exactly today's rule for a
   * caller that does not say (campaign dispatch). The email worker passes
   * 'scenario_flow' for the journey stages it sends.
   */
  context?: EligibilityContext
  /** The job's sequence kind, when it carries one. */
  sequenceKind?: string | null
  /** The address the job would send to. */
  recipient?: string | null
}

/** The gate's answer plus the basis to record on the EmailSend row. */
export type LeadSendEligibility = {
  reason: string | null
  marketingBasis: 'express' | 'notice' | 'ebr' | 'transactional' | null
  basisEventId: string | null
}

/**
 * LIVE lead eligibility — the send-time twin of `bookingEligibility`.
 * FAILS CLOSED: a read error blocks the send.
 */
export async function leadEligibility(leadId: string, template?: string, opts: LeadEligibilityOptions = {}): Promise<string | null> {
  return (await leadSendEligibility(leadId, template, opts)).reason
}

/** leadEligibility, with the basis the send would go out under. */
export async function leadSendEligibility(
  leadId: string,
  template?: string,
  opts: LeadEligibilityOptions = {},
  deps: StageDeps = defaultStageDeps()
): Promise<LeadSendEligibility> {
  try {
    const lead = await deps.loadStageLead(leadId)
    // Journey stages keep the full matrix; an immediate transactional reply
    // gets only the rules true of every lead. `template` is optional so every
    // existing caller keeps today's behaviour.
    if (template && TRANSACTIONAL_LEAD_TEMPLATES.has(template)) {
      const reason = transactionalLeadBlockReason(lead)
      if (reason) log.info({ leadId, template, reason }, 'lead eligibility BLOCKED the send')
      return { reason, marketingBasis: reason ? null : 'transactional', basisEventId: null }
    }
    const kind = isSequenceKind(opts.sequenceKind) ? opts.sequenceKind : sequenceKindForTemplate(template)
    const r = await scenarioSendDecision(
      { leadId, lead, template, kind, context: opts.context ?? 'automation', recipient: opts.recipient ?? null },
      deps
    )
    if (r.reason) log.info({ leadId, template, reason: r.reason }, 'lead eligibility BLOCKED the send')
    const granted = !r.reason && r.decision && r.decision.eligible ? r.decision : null
    return {
      reason: r.reason,
      marketingBasis: granted ? granted.basis : null,
      basisEventId: granted ? granted.basisEventId : null,
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), leadId },
      'lead eligibility read failed — failing closed'
    )
    return { reason: 'eligibility_read_failed', marketingBasis: null, basisEventId: null }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  THE QUICK-QUOTE DELIVERY GATE (DESIGN-v2 §7)
//  ---------------------------------------------------------------------
//  A quote-page submission is anonymous. Before any promotional stage goes to
//  that address, the address has to have ACCEPTED the transactional reply the
//  person asked for: quote-request-received with a delivered webhook and no
//  bounce or complaint. Until then the stage waits in bounded steps; a bounce,
//  a complaint, a terminal refusal or a wait past the bound stops the sequence.
//  Applies to Sequence A running on a notice.
// ════════════════════════════════════════════════════════════════════════

export const CONFIRMATION_WAIT_STEP_MS = 2 * HOUR
export const CONFIRMATION_WAIT_MAX_MS = 48 * HOUR

export type ConfirmationGate =
  | { action: 'proceed' }
  | { action: 'defer'; fireAt: Date; jobId: string; data: Record<string, unknown> }
  | { action: 'stop'; reason: string }

/** Does this sequence wait for a delivered quick-quote confirmation? */
export function needsConfirmationGate(kind: SequenceKind | null, decision: EligibilityDecision | null): boolean {
  return kind === 'quote_followup' && !!decision && decision.eligible && decision.basis === 'notice'
}

/**
 * PURE. Proceed, wait another step, or stop. The re-queued job keeps the
 * stage's data plus the wait's start and attempt, and gets a DETERMINISTIC,
 * colon-free id per attempt, so a stalled re-run of the same hop adds nothing.
 */
export function confirmationGateDecision(input: {
  state: ConfirmationState
  now: Date
  stageType: string
  journeyKey: string
  leadId: string
  jobData: Record<string, unknown>
}): ConfirmationGate {
  if (input.state === 'delivered') return { action: 'proceed' }
  if (input.state === 'failed') return { action: 'stop', reason: 'quote_confirmation_failed' }
  const now = input.now.getTime()
  const startedRaw = input.jobData.confirmationWaitStartedAt
  const parsed = typeof startedRaw === 'string' ? Date.parse(startedRaw) : NaN
  const started = Number.isFinite(parsed) ? Math.min(parsed, now) : now
  const attemptRaw = input.jobData.confirmationWaitAttempt
  const attempt = typeof attemptRaw === 'number' && Number.isInteger(attemptRaw) && attemptRaw >= 0 ? attemptRaw : 0
  if (now - started >= CONFIRMATION_WAIT_MAX_MS) return { action: 'stop', reason: 'quote_confirmation_not_delivered' }
  const next = attempt + 1
  const data: Record<string, unknown> = { ...input.jobData, confirmationWaitStartedAt: new Date(started).toISOString(), confirmationWaitAttempt: next }
  delete data.type
  return {
    action: 'defer',
    fireAt: new Date(Math.min(now + CONFIRMATION_WAIT_STEP_MS, started + CONFIRMATION_WAIT_MAX_MS)),
    jobId: `${jobIdFor(input.journeyKey, input.stageType, input.leadId)}__wait${next}`,
    data,
  }
}

/**
 * The gate as the stage handlers use it: null to proceed, or what to do.
 * A stop also ends the enrollment, so the later stages refuse at send time.
 */
export async function applyConfirmationGate(
  input: { kind: SequenceKind | null; decision: EligibilityDecision | null; enrollment: EnrollmentRecord | null; stageType: string; leadId: string; jobData: Record<string, unknown> },
  deps: Pick<StageDeps, 'now' | 'quoteConfirmationState' | 'stopEnrollment'>
): Promise<Exclude<ConfirmationGate, { action: 'proceed' }> | null> {
  if (!input.kind || !needsConfirmationGate(input.kind, input.decision)) return null
  const gate = confirmationGateDecision({
    state: await deps.quoteConfirmationState(input.leadId),
    now: deps.now(),
    stageType: input.stageType,
    journeyKey: journeyKeyFor(input.kind),
    leadId: input.leadId,
    jobData: input.jobData,
  })
  if (gate.action === 'proceed') return null
  if (gate.action === 'stop' && input.enrollment) await deps.stopEnrollment(input.enrollment.id, gate.reason)
  return gate
}

// ── The production StageDeps ───────────────────────────────────────────

const STAGE_LEAD_SELECT = {
  id: true,
  name: true,
  email: true,
  status: true,
  quotedAt: true,
  bookedAt: true,
  lostAt: true,
  moveDate: true,
  convertedBookingId: true,
  jobType: true,
  createdAt: true,
  basisEventId: true,
  // PROMOTIONAL — a gate that cannot see the consent column cannot enforce it.
  emailMarketingConsent: true,
} as const

let _stageDeps: StageDeps | undefined
export function defaultStageDeps(): StageDeps {
  if (_stageDeps) return _stageDeps
  _stageDeps = {
    now: () => new Date(),
    env: process.env,
    loadStageLead: (leadId) => prisma.lead.findUnique({ where: { id: leadId }, select: STAGE_LEAD_SELECT }),
    eligibility: (req) => promotionalEligibility(req, sendTimeEligibilityDeps()),
    //  The nurture's booking check (leads.hasBookingOnRecord): a move taken
    //  before, or a booking still waiting for payment or approval.
    hasEverBooked: hasBookingOnRecord,
    activeEnrollment: (email, kind) => activeEnrollment(email, kind),
    personBookedSince: (email, since) => personBookedSince(email, since),
    async quoteConfirmationState(leadId) {
      //  Only a confirmation sent to the lead's CURRENT address counts: a partial
      //  lead's address can be corrected, and a delivery to the old one says
      //  nothing about the new one.
      const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { email: true } })
      const email = lead?.email ? normalizeEmail(lead.email) : ''
      if (!email) return 'pending'
      const rows = await prisma.emailSend.findMany({
        where: { leadId, template: 'quote-request-received', email },
        select: { id: true, status: true, deliveredAt: true, bouncedAt: true, complainedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
      if (rows.some((r) => r.bouncedAt || r.complainedAt)) return 'failed'
      if (rows.some((r) => r.deliveredAt)) return 'delivered'
      //  The webhook stores the delivered EVENT before it sets delivered_at, and a
      //  failed column write is logged, not retried (email-events.applyDeliveryState).
      //  A linked delivered event is the same proof. Nothing else is: no event,
      //  no delivery.
      if (rows.length > 0) {
        const delivered = await prisma.emailEvent.count({ where: { emailSendId: { in: rows.map((r) => r.id) }, type: 'delivered' } })
        if (delivered > 0) return 'delivered'
      }
      if (rows.length > 0 && rows.every((r) => r.status === 'blocked_terminal' || r.status === 'failed_terminal')) return 'failed'
      return 'pending'
    },
    async stopEnrollment(enrollmentId, reason) {
      await prisma.sequenceEnrollment
        .updateMany({ where: { id: enrollmentId, status: 'active' }, data: { status: 'stopped', stopReason: reason.slice(0, 80) } })
        .catch((err) => {
          log.warn({ enrollmentId, err: err instanceof Error ? err.message : String(err) }, 'could not stop the enrollment (later stages still refuse at send time)')
        })
    },
  }
  return _stageDeps
}
