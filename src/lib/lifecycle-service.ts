// ════════════════════════════════════════════════════════════════════════════
//  lifecycle-service.ts — ONE transactional owner of "this move is finished"
//  and "this move is off". (blocker B7/B8, owner spec 2026-08-15)
//
//  WHAT WAS BROKEN — verified, not assumed (docs/moving-os-blocker-findings.md
//  § B7 + B8):
//
//   1. COMPLETION HAD TWO IMPLEMENTATIONS. The Discord move-day card's
//      "✅ Complete Job" — the way jobs are ACTUALLY completed, one tap in the
//      field, posted for EVERY paid booking — wrote Booking + Job + audit
//      atomically and then STOPPED. No job-completion email, no +24h balance
//      reminder for the money still owed, no `move_completed` trigger, no review
//      request, no referral ask, no repeat-customer reminder. The admin route
//      (four clicks) fired all of those, and wrote its three rows as three
//      separate awaits with no transaction.
//
//   2. AND IT WAS UNRECOVERABLE. `VALID_TRANSITIONS['COMPLETED'] = ['ARCHIVED']`,
//      so once Discord set COMPLETED the admin route could never run its
//      completion block for that booking, and the admin UI offered only
//      "Archive". Every message the customer never got was lost permanently.
//
//   3. `Booking.completedAt` — which gates all six post-move templates in
//      email-eligibility.ts — was stamped by `followups.onBookingCompleted`,
//      the LAST write of the admin route, outside any transaction, with its
//      failure swallowed. Anything that killed the request in between left
//      status = COMPLETED with completedAt = NULL: silent, permanent, and
//      invisible to every post-move automation forever.
//
//   4. CANCELLATION NEVER TOUCHED THE JOB. `JobStatus.CANCELLED` existed and was
//      written by NOTHING in the repository, so `conflict-engine`'s
//      ASSIGNMENT_ON_CANCELLED_JOB HARD_BLOCK was unreachable dead code: more
//      crew could be assigned to a cancelled move with no warning, and the crew
//      portal kept the cancelled job in the worker's "upcoming" list.
//
//  WHAT THIS MODULE GUARANTEES
//   • ONE transaction per lifecycle fact. Booking + Job + AuditLog commit
//     together or not at all, so a booking can never read COMPLETED without its
//     `completedAt`, and a cancelled booking can never keep a live Job.
//   • THE CLAIM IS THE IDEMPOTENCY. A conditional `updateMany` is the only thing
//     that decides who "did" the completion: a second press matches 0 rows and
//     reports `already_completed` without re-firing anything. The AuditLog row
//     carries a DETERMINISTIC PRIMARY KEY as well (the same discipline
//     booking-approval.ts uses for PAYMENT_RECEIVED), so two callers racing into
//     the same transaction can only produce one ledger entry — the loser's whole
//     transaction rolls back on the unique violation.
//   • SIDE EFFECTS RUN ONLY AFTER THE COMMIT, and are reported HONESTLY. The
//     B4 lesson: nothing here logs "all queued" unconditionally. `EffectReport`
//     names what each handoff actually did, and the caller can print it.
//   • NOTHING CLAIMS WHAT THE DATABASE DOES NOT SHOW. The completion email is
//     enqueued only after `status = COMPLETED` AND `completedAt` are committed,
//     so `bookingEligibility('job-completion', …)` — which reloads the row at
//     send time — cannot see one without the other. That ordering race
//     (finding B7-e) disappears by construction rather than by a delay.
//
//  DESIGN NOTES
//   • Prisma is used directly (labor-service.ts is the house precedent for a
//     module whose whole job is one durable write); the SIDE EFFECTS are
//     injectable so the fan-out is observable offline, and their real
//     implementations are imported DYNAMICALLY so a Next route that only needs
//     the transaction does not drag @react-email + BullMQ into its module graph
//     at import time (the same reason labor-service.ts imports booking-approval
//     dynamically).
//   • Every read uses an EXPLICIT select. An unqualified read asks for every
//     column the GENERATED client knows about and raises P2022 during the
//     code-before-SQL window — the failure mode item R3-2 removed from the
//     approval path.
// ════════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { apiLogger } from './logger'
import { LIVE_STATUSES, canTransition, type AssignmentStatus } from './assignment-lifecycle'
// TYPE-ONLY (erased at compile time): the report needs the handoffs' real
// outcome vocabulary, and importing the type costs nothing at runtime — the
// implementations stay dynamically imported so a Next route that only needs the
// transaction never loads @react-email / BullMQ.
import type { FollowupScheduleOutcome } from './followups'
import type { BalanceReminderOutcome } from './journeys'

// ── Public types ────────────────────────────────────────────────────────────

export type LifecycleSource = 'admin' | 'discord'

export type LifecycleActor = {
  /** Human-readable name for the audit trail (the owner, or the crew member who
   *  tapped the Discord button). */
  name: string
  /** Real User.id — set on the admin path; null/undefined for Discord. */
  userId?: string | null
  /** Discord user id — audit details only. */
  discordUserId?: string | null
}

export type LifecycleErrorCode = 'not_found' | 'invalid_status' | 'write_failed'

/** The booking columns this module reads. Explicit, so a column added tomorrow
 *  cannot break the read on a database that does not have it yet. */
export type LifecycleBooking = {
  id: string
  status: string
  completedAt: Date | null
  displayId: string
  customerToken: string
  itemsDescription: string | null
  customer: { name: string; email: string | null; locale: string | null } | null
  job: { id: string; status: string; startedAt: Date | null; completedAt: Date | null; durationMins: number | null } | null
}

/**
 * What ONE post-commit handoff actually did.
 *
 * BLOCKER D3 — WHY THIS IS A STATE AND NOT A BOOLEAN-ISH STRING. `followups`
 * and `balance` used to be `'ok' | 'failed:<message>'`, and `'ok'` meant only
 * "the call returned without throwing". Under the SHIPPED DEFAULT
 * (`MARKETING_FOLLOWUPS_ENABLED` and `EMAIL_JOURNEYS_ENABLED` unset) both
 * functions return BEFORE their enqueue, so every completion reported
 * `{"followups":"ok","balance":"ok"}` and the owner read "review/referral
 * sequence scheduled · balance reminder scheduled" for work that was never
 * scheduled. Same when the customer had never opted in to promotional mail.
 *
 * "Did not throw" is not "did the work". The handoffs now RETURN what they did
 * and this type carries the four answers the owner actually needs to tell
 * apart: scheduled, skipped-because-disabled, skipped-because-no-consent, and
 * failed.
 */
export type EffectState =
  /** Accepted by the queue (the customer's move-complete email). */
  | 'queued'
  /** The sequence / reminder really is on the queue. */
  | 'scheduled'
  /** Deliberately not done. `reason` says why — this is not a failure. */
  | 'skipped'
  /** Attempted and refused or thrown. `reason` carries the message. */
  | 'failed'
  /** The handoff ran but could not prove what it did. Never reported as done. */
  | 'unknown'
  /** Never attempted — the caller's deadline expired first. */
  | 'not-run'

export type EffectOutcome = {
  state: EffectState
  /** Machine-readable why. Always present for skipped / failed / unknown. */
  reason?: string
  /** How many messages this handoff really handed to the queue. Present only
   *  when a count is known; never a guess. */
  count?: number
}

/** What each post-commit handoff ACTUALLY did. Never a blanket "all queued" —
 *  that unconditional claim is blocker B4; a blanket "scheduled" is D3. */
export type EffectReport = {
  email: EffectOutcome
  followups: EffectOutcome
  balance: EffectOutcome
  /** True when the caller's deadline expired before every handoff answered.
   *  The lifecycle FACT is already durable at that point — only the messages
   *  are in doubt, and each is idempotent, so a replay finishes them. */
  timedOut?: boolean
}

/** Nothing has been attempted yet. The starting point of every report, so a
 *  handoff that never ran can never read as one that did. */
const notRun = (): EffectReport => ({
  email: { state: 'not-run' },
  followups: { state: 'not-run' },
  balance: { state: 'not-run' },
})

export type CompleteOutcome =
  /** This call moved a live job to COMPLETED. */
  | 'completed'
  /** The row already read COMPLETED but carried NO `completedAt` (the silent
   *  permanent-loss state finding B7-a describes). This call stamped it and ran
   *  the post-move sequence the booking never got. */
  | 'repaired'
  /** Already complete, stamp and all — a second press. Nothing re-fired. */
  | 'already_completed'

export type CompleteResult =
  | {
      ok: true
      outcome: CompleteOutcome
      booking: LifecycleBooking
      /** NULL only when this call LOST the claim and the re-read could not show a
       *  stamp. Never a default: a completion time the database cannot show is
       *  not a completion time this result is allowed to state. */
      completedAt: Date | null
      durationMins: number | null
      /** True when THIS call won the conditional claim. */
      claimed: boolean
      /** Absent when the caller asked for no side effects. */
      effects?: EffectReport
    }
  | { ok: false; code: LifecycleErrorCode; message: string; booking?: LifecycleBooking | null }

export type CancelOutcome = 'cancelled' | 'already_cancelled'

export type CancelResult =
  | {
      ok: true
      outcome: CancelOutcome
      booking: LifecycleBooking
      claimed: boolean
      /** The Job row was moved to CANCELLED by this call. */
      jobCancelled: boolean
      /** How many live crew assignments this call cancelled. */
      crewCancelled: number
      /** Set when the crew half was ATTEMPTED and failed. Without it, a failed
       *  remediation is indistinguishable from "there was nothing live", which
       *  is the reporting defect D3 names on the smaller path. */
      jobCancelFailed?: string
      /** 'ok' | 'failed:<message>' — the journey/queue stop. */
      journeys?: string
    }
  | { ok: false; code: LifecycleErrorCode; message: string; booking?: LifecycleBooking | null }

export type CompleteInput = {
  bookingId: string
  actor: LifecycleActor
  source: LifecycleSource
  /** Completion instant. Defaults to now; injected by tests. */
  at?: Date
  /** Run the post-commit fan-out (default true). */
  effects?: boolean
  /** Bound the fan-out. Discord interactions must answer inside ~3s. */
  effectsTimeoutMs?: number
}

export type CancelInput = {
  bookingId: string
  actor: LifecycleActor
  source: LifecycleSource
  reason?: string | null
  at?: Date
  /** Stop the booking's journeys after the commit (default true). */
  effects?: boolean
  effectsTimeoutMs?: number
}

// ── The statuses each claim accepts ─────────────────────────────────────────

/** A move that can still be finished. */
export const COMPLETABLE_STATUSES = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'] as const

/** …plus COMPLETED, because a COMPLETED row with a NULL `completedAt` is the
 *  broken state this service exists to repair, and the claim (which also
 *  requires `completedAt: null`) is what tells the two apart. */
export const COMPLETION_CLAIM_STATUSES = [...COMPLETABLE_STATUSES, 'COMPLETED'] as const

/** Statuses a booking may be cancelled FROM. The route's own VALID_TRANSITIONS
 *  is still the authority on what the owner may click; this is the floor that
 *  stops a terminal row being re-opened. */
export const CANCELLABLE_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'SCHEDULED',
  'IN_PROGRESS',
] as const

/** Assignment states a cancellation may move to CANCELLED — DERIVED from the
 *  shipped transition table (assignment-lifecycle.ts), never restated here. A
 *  COMPLETED assignment is terminal: work that was really done is not unmade by
 *  cancelling the booking. */
export const CANCELLABLE_ASSIGNMENT_STATUSES: AssignmentStatus[] = LIVE_STATUSES.filter((s) =>
  canTransition(s, 'CANCELLED'),
)

// ── Deterministic audit ids (the exactly-once claim, second line) ────────────
//
// Same discipline as booking-approval.approvalAuditId: the primary key IS the
// claim. Two callers racing into the same transaction both try to insert this
// row; Postgres lets exactly one commit and the loser's ENTIRE transaction
// (Booking claim and Job write included) rolls back. No lease, nothing to
// release. NO MIGRATION: `audit_logs.id` is the existing primary key.
//
// One completion per booking and one cancellation per booking is the correct
// scope: there is no transition out of COMPLETED except ARCHIVED, and none out
// of CANCELLED at all, so neither event can legitimately happen twice.
export const completionAuditId = (bookingId: string): string => `jobdone__${bookingId}`
export const cancellationAuditId = (bookingId: string): string => `bkcncl__${bookingId}`
/** The Job/crew half, written when the booking was already claimed CANCELLED by
 *  another service (declineBooking releases the $49 hold and cancels the row —
 *  this module must not duplicate that claim, only finish the crew side). */
export const jobCancellationAuditId = (bookingId: string): string => `jbcncl__${bookingId}`

// ── Deterministic queue-job ids ─────────────────────────────────────────────
//
// NO COLONS: BullMQ uses ':' as its Redis key separator and REJECTS a custom job
// id containing one (queue-jobid-safety.test.ts pins this after a production
// incident that silently killed every journey enqueue).
export const completionEmailJobId = (bookingId: string, completedAt: Date): string =>
  `completion__job-completion__${bookingId}__${completedAt.getTime()}`.replace(/:/g, '-')

/** ── THE RECOVERY ACTION'S LABEL, in ONE place ──────────────────────────────
 *  `VALID_TRANSITIONS['COMPLETED'] = ['ARCHIVED']` is correct and stays: a
 *  COMPLETED → COMPLETED edge would reopen the transition guard for a retry it
 *  was never designed for. The recovery is therefore a NAMED ACTION, exactly
 *  like the R2 approval repair — and this is the string the admin button must
 *  carry. The client component cannot import from here (Prisma must never reach
 *  the browser bundle), so the two copies are pinned by
 *  src/lib/__tests__/lifecycle-service.test.ts. */
export const REPLAY_COMPLETION_ACTION_LABEL = 'Send post-move messages'

/** Why a skipped handoff was skipped, in the owner's words. The KEY is the
 *  machine reason the handoff reported; anything not listed is printed as-is
 *  rather than being softened into a success. */
const SKIP_PHRASE: Record<string, string> = {
  'no-email-address': 'no address on file',
  'followups-disabled': 'follow-ups are switched off',
  'journeys-disabled': 'lifecycle journeys are switched off',
  'journey-disabled': 'the balance journey is switched off',
  'no-consent': 'customer has not opted in',
  'opted-out': 'customer opted out of marketing mail',
  'not-in-rollout': 'this customer is outside the email rollout',
  'internal-test': 'internal test booking',
}

const phrase = (o: EffectOutcome): string => (o.reason ? (SKIP_PHRASE[o.reason] ?? o.reason) : 'no reason recorded')

/**
 * What the owner is told, built ONLY from what the handoffs actually reported.
 *
 * Never "sent" — this queues messages, and the send guard decides
 * (suppression, consent, quiet hours) whether any of them go out. And never
 * "scheduled" for a handoff that returned before its enqueue: that sentence is
 * blocker D3, and every branch below is keyed on a state the handoff reported
 * rather than on the absence of an exception.
 */
export function replayCompletionMessage(report: EffectReport): string {
  const parts: string[] = []

  switch (report.email.state) {
    case 'queued':
      parts.push('Move-complete email queued')
      break
    case 'skipped':
      parts.push(`No move-complete email — ${phrase(report.email)}`)
      break
    case 'not-run':
      parts.push('Move-complete email not attempted')
      break
    default:
      parts.push('Move-complete email could NOT be queued')
  }

  switch (report.followups.state) {
    case 'scheduled':
      parts.push('review/referral sequence scheduled')
      break
    case 'skipped':
      parts.push(`review request skipped — ${phrase(report.followups)}`)
      break
    case 'not-run':
      parts.push('review/referral sequence not attempted')
      break
    case 'unknown':
      parts.push('review/referral sequence — could not confirm it was scheduled')
      break
    default:
      parts.push('follow-up sequence FAILED to schedule')
  }

  switch (report.balance.state) {
    case 'scheduled':
      parts.push('balance reminder scheduled')
      break
    case 'skipped':
      parts.push(`balance reminder skipped — ${phrase(report.balance)}`)
      break
    case 'not-run':
      parts.push('balance reminder not attempted')
      break
    case 'unknown':
      parts.push('balance reminder — could not confirm it was scheduled')
      break
    default:
      parts.push('balance reminder FAILED to schedule')
  }

  const tail = report.timedOut ? ' (some handoffs were still running when this answered)' : ''
  return `${parts.join(' · ')}.${tail} Anything already sent is not sent twice.`
}

// ── Pure guards (unit-tested directly, no I/O) ──────────────────────────────

export type CompletionPlan =
  | { kind: 'complete' }
  | { kind: 'repair' }
  | { kind: 'already' }
  | { kind: 'refuse'; message: string }

/** What completing this booking would mean, from its status + stamp alone. */
export function planCompletion(status: string, completedAt: Date | null | undefined): CompletionPlan {
  if (status === 'COMPLETED' || status === 'ARCHIVED') {
    return completedAt ? { kind: 'already' } : { kind: 'repair' }
  }
  if ((COMPLETABLE_STATUSES as readonly string[]).includes(status)) return { kind: 'complete' }
  if (status === 'CANCELLED') {
    return { kind: 'refuse', message: 'This booking was cancelled — there is nothing to complete.' }
  }
  return {
    kind: 'refuse',
    message: `A ${status.replace(/_/g, ' ').toLowerCase()} booking has not been approved yet — approve it before completing the job.`,
  }
}

export type CancellationPlan = { kind: 'cancel' } | { kind: 'already' } | { kind: 'refuse'; message: string }

export function planCancellation(status: string): CancellationPlan {
  if (status === 'CANCELLED') return { kind: 'already' }
  if ((CANCELLABLE_STATUSES as readonly string[]).includes(status)) return { kind: 'cancel' }
  return {
    kind: 'refuse',
    message: `A ${status.replace(/_/g, ' ').toLowerCase()} booking cannot be cancelled.`,
  }
}

/** Elapsed labor, in whole minutes, or null when the crew never pressed Start.
 *  Never negative — a clock skew must not produce a claim about a job that took
 *  minus twenty minutes. */
export function durationMinutesBetween(startedAt: Date | null | undefined, endedAt: Date): number | null {
  if (!startedAt) return null
  return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000))
}

// ── Injectable side effects ─────────────────────────────────────────────────

export type LifecycleEffects = {
  /** Enqueue the customer's move-complete email. Returns false when there is no
   *  address to send to (a skip, not a failure). */
  sendCompletionEmail(booking: LifecycleBooking, completedAt: Date): Promise<boolean>
  /** followups.onBookingCompleted — the review/referral/repeat sequence.
   *  Returns WHAT IT DID; a void return would leave this service inferring
   *  "scheduled" from "did not throw", which is blocker D3. */
  scheduleFollowups(bookingId: string): Promise<FollowupScheduleOutcome>
  /** journeys.onBookingCompletedBalance — the +24h balance reminder and the
   *  `move_completed` automation trigger. Returns what it did, same reason. */
  scheduleBalanceReminder(bookingId: string): Promise<BalanceReminderOutcome>
  /** journeys.onBookingCancelled — stop every journey for a dead booking. */
  stopJourneys(bookingId: string): Promise<void>
  /**
   * OPTIONAL — put a FAILED Job/crew remediation where a human will see it.
   *
   * ── C3-2 ──────────────────────────────────────────────────────────────
   * `JobCancelResult.failed` exists so a caller can tell "there was nothing
   * live" from "the live crew of a CANCELLED move is still live", and no
   * shipped caller read it: the admin decline path and the Discord deny path
   * both `await cancelJobForBooking(...)` and throw the result away. The
   * failure was written to a log line nobody watches and surfaced nowhere,
   * while the consequence — more crew assignable to a dead move, the job still
   * on a worker's phone — needs the owner's hands.
   *
   * Optional because every existing caller builds this object literally; an
   * implementation that omits it simply does not alert (`?.`), and the default
   * fan-out supplies the real one.
   */
  alertCrewCancelFailed?(input: {
    bookingId: string
    displayId?: string | null
    reason: string
    source: LifecycleSource
  }): Promise<void>
}

// ── Handoff outcome → report state ──────────────────────────────────────────
//
// The handoffs speak in THEIR vocabulary (a consent block reason, a feature
// flag name); the report speaks in the owner's. This is the ONE translation
// table, so a new refusal reason surfaces as itself rather than being rounded
// off to a success.

/** followups: `bookingMarketingBlockReason` / flag reasons → report reasons. */
const FOLLOWUP_SKIPS: Record<string, string> = {
  followups_disabled: 'followups-disabled',
  no_marketing_consent: 'no-consent',
  marketing_opted_out: 'opted-out',
  not_in_rollout_allowlist: 'not-in-rollout',
  internal_test_booking: 'internal-test',
}

export function followupOutcome(o: FollowupScheduleOutcome): EffectOutcome {
  if (o.reason === null) return { state: 'scheduled', count: o.scheduled }
  const skip = FOLLOWUP_SKIPS[o.reason]
  if (skip) return { state: 'skipped', reason: skip, count: 0 }
  // Everything else is a failure to schedule, INCLUDING a partial one: three
  // of four stages on the queue is not "the sequence is scheduled".
  if (o.reason === 'consent_read_failed') return { state: 'failed', reason: 'consent-unknown', count: 0 }
  return { state: 'failed', reason: o.reason, count: o.scheduled }
}

export function balanceOutcome(o: BalanceReminderOutcome): EffectOutcome {
  if (o.scheduled) return { state: 'scheduled', count: 1 }
  if (o.reason === 'journeys_disabled') return { state: 'skipped', reason: 'journeys-disabled', count: 0 }
  if (o.reason === 'journey_disabled') return { state: 'skipped', reason: 'journey-disabled', count: 0 }
  if (o.reason === 'enqueue_unverified') return { state: 'unknown', reason: 'not-confirmed', count: 0 }
  return { state: 'failed', reason: o.reason ?? 'unknown', count: 0 }
}

export type LifecycleLogger = {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const asMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const BOOKING_SELECT = {
  id: true,
  status: true,
  completedAt: true,
  displayId: true,
  customerToken: true,
  itemsDescription: true,
  customer: { select: { name: true, email: true, locale: true } },
  job: { select: { id: true, status: true, startedAt: true, completedAt: true, durationMins: true } },
} as const

export async function loadLifecycleBooking(bookingId: string): Promise<LifecycleBooking | null> {
  const row = await prisma.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT })
  return (row as LifecycleBooking | null) ?? null
}

/** The move-complete email as a queue job — PURE, so the payload can be checked
 *  offline without importing BullMQ. Null when there is no address to send to.
 *
 *  The payload is byte-identical to what the admin status route enqueued before
 *  this service existed, so nothing about the customer's email changes; what
 *  changes is that the Discord path now produces it too, and that it is built
 *  only AFTER `completedAt` is committed. */
export function buildCompletionEmailJob(
  booking: LifecycleBooking,
  completedAt: Date,
  appUrl?: string,
): { name: 'job-completion'; data: Record<string, unknown>; opts: { jobId: string } } | null {
  const to = booking.customer?.email
  if (!to) return null
  const appBase = (appUrl ?? process.env.APP_URL ?? 'https://moveitclearit.com').replace(/\/+$/, '')
  return {
    name: 'job-completion',
    data: {
      template: 'job-completion',
      to,
      bookingId: booking.id,
      payload: {
        customerName: booking.customer?.name ?? '',
        displayId: booking.displayId,
        completedAt: completedAt.toISOString(),
        portalUrl: `${appBase}/my-booking/${booking.customerToken}`,
        items: booking.itemsDescription ?? undefined,
        locale: booking.customer?.locale ?? 'en',
      },
    },
    // Deterministic id: a replay of the post-move messages collapses onto the
    // same queue job instead of racing a second one. The send guard's own
    // idempotency key (email|job-completion|none|bookingId|v1) is the durable
    // guarantee; this is the cheap one in front of it.
    opts: { jobId: completionEmailJobId(booking.id, completedAt) },
  }
}

/** The real fan-out. Imported dynamically so a caller that only needs the
 *  transaction never loads @react-email / BullMQ at module scope. */
export function defaultLifecycleEffects(): LifecycleEffects {
  return {
    async sendCompletionEmail(booking, completedAt) {
      const job = buildCompletionEmailJob(booking, completedAt)
      if (!job) return false
      const { emailQueue } = await import('./queues')
      await emailQueue.add(job.name, job.data, job.opts)
      return true
    },
    async scheduleFollowups(bookingId) {
      const { onBookingCompleted } = await import('./followups')
      return onBookingCompleted(bookingId)
    },
    async scheduleBalanceReminder(bookingId) {
      const { onBookingCompletedBalance } = await import('./journeys')
      return onBookingCompletedBalance(bookingId)
    },
    async stopJourneys(bookingId) {
      const { onBookingCancelled } = await import('./journeys')
      await onBookingCancelled(bookingId)
    },
    async alertCrewCancelFailed({ bookingId, displayId, reason, source }) {
      // The bare-HTTPS ops primitive, not the bot: a Next route must not pull
      // discord.js into its bundle (ops-alert.ts:8-16). It never throws and it
      // reports whether anyone was reached, so "we alerted" and "we could not
      // reach anyone" stay distinguishable.
      const { postOpsAlert } = await import('./ops-alert')
      const ref = displayId?.trim() || bookingId
      await postOpsAlert('A cancelled move may still have live crew', [
        {
          // Only what the database showed: the booking is cancelled, and the
          // job/crew write did not go through. Nothing about money.
          message: `Booking ${ref} is CANCELLED, but its job and crew assignments could not be cancelled (${source}): ${reason}`,
          action:
            'Open the job and cancel the crew assignments by hand. Until that is done more crew can be assigned to this ' +
            'move and it stays in the crew\'s upcoming list.',
        },
      ])
    },
  }
}

export type LifecycleDeps = {
  effects?: LifecycleEffects
  logger?: LifecycleLogger
}

/** Bound a promise. Used ONLY for the post-commit fan-out — never for a write.
 *  On expiry the underlying work keeps running; the lifecycle fact is already
 *  durable and every handoff is idempotent. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

// ════════════════════════════════════════════════════════════════════════════
//  COMPLETE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Finish a move. ONE transaction; then the post-move messages.
 *
 * Called by BOTH surfaces — the admin status route and the Discord move-day
 * card — so they can no longer disagree about what completing a job means.
 */
export async function completeBooking(input: CompleteInput, deps: LifecycleDeps = {}): Promise<CompleteResult> {
  const logger = deps.logger ?? apiLogger
  const at = input.at ?? new Date()
  const bookingId = input.bookingId

  let booking: LifecycleBooking | null
  try {
    booking = await loadLifecycleBooking(bookingId)
  } catch (e) {
    logger.error({ bookingId, err: asMessage(e) }, 'lifecycle: could not read the booking to complete')
    return { ok: false, code: 'write_failed', message: 'Could not read this booking — try again.' }
  }
  if (!booking) return { ok: false, code: 'not_found', message: 'Booking not found.' }

  const plan = planCompletion(booking.status, booking.completedAt)
  if (plan.kind === 'refuse') {
    return { ok: false, code: 'invalid_status', message: plan.message, booking }
  }
  if (plan.kind === 'already') {
    // Nothing re-fires. The messages for this completion were emitted when the
    // claim was won; re-running them is the explicit replay action, not an
    // accidental consequence of a second button press.
    return {
      ok: true,
      outcome: 'already_completed',
      booking,
      completedAt: booking.completedAt as Date,
      durationMins: booking.job?.durationMins ?? null,
      claimed: false,
    }
  }

  // ── WHEN did the work finish? ────────────────────────────────────────────
  // For an ordinary completion that is NOW. For a REPAIR it is not: the Job row
  // already knows when the crew finished, and re-stamping the booking with the
  // moment somebody happened to press the recovery button would restate a fact
  // the database can already show. Prefer the recorded job time; fall back to
  // now only when nothing recorded it.
  const stampAt = plan.kind === 'repair' ? (booking.job?.completedAt ?? at) : at
  const durationMins = durationMinutesBetween(booking.job?.startedAt ?? null, stampAt)

  // ── THE ONE TRANSACTION ───────────────────────────────────────────────────
  // Booking claim + Job + AuditLog. A throw anywhere inside leaves the booking
  // exactly as it was — which is the difference between "the completion did not
  // happen" and the old three-separate-awaits shape, where it half happened and
  // could never be retried.
  let claimed = false
  try {
    claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.booking.updateMany({
        // `completedAt: null` is the whole idempotency: a second press (or a
        // second surface) matches zero rows. Including COMPLETED in the status
        // set is what makes the stamp REPAIRABLE — a row stranded by the old
        // code (status COMPLETED, completedAt NULL) is claimable here and
        // nowhere else.
        // An ARCHIVED booking that never got its stamp is repairable too — but
        // stamping it must NOT un-archive it, so that case claims on its own
        // status and writes only the missing fact.
        where:
          booking!.status === 'ARCHIVED'
            ? { id: bookingId, completedAt: null, status: 'ARCHIVED' }
            : { id: bookingId, completedAt: null, status: { in: [...COMPLETION_CLAIM_STATUSES] } },
        data: booking!.status === 'ARCHIVED' ? { completedAt: stampAt } : { status: 'COMPLETED', completedAt: stampAt },
      })
      if (claim.count === 0) return false

      // UPSERT, not updateMany: the admin route used updateMany, so a booking
      // with no Job row (approval's Job write lost, or crew never assigned)
      // silently got no Job at all and `durationMins` was never set.
      await tx.job.upsert({
        where: { bookingId },
        update: {
          status: 'COMPLETED',
          completedAt: stampAt,
          ...(durationMins != null ? { durationMins } : {}),
        },
        create: { bookingId, status: 'COMPLETED', startedAt: stampAt, completedAt: stampAt },
      })

      await tx.auditLog.create({
        data: {
          id: completionAuditId(bookingId),
          action: 'JOB_COMPLETED',
          bookingId,
          userId: input.actor.userId ?? null,
          details: {
            event: 'complete_booking',
            // `by` is what the Discord job card's audit trail reads;
            // `changedBy` is what the admin Activity Log renders. Both, so
            // neither surface loses the name of the person who did this.
            by: input.actor.name,
            changedBy: input.actor.name,
            source: input.source,
            discordUserId: input.actor.discordUserId ?? null,
            from: booking!.status,
            to: 'COMPLETED',
            completedAt: stampAt.toISOString(),
            durationMins,
            // The repair case is recorded as what it is, so a later reader can
            // tell a normal completion from a rescued one.
            repairedStamp: plan.kind === 'repair' || undefined,
            startNotPressed: booking!.status === 'CONFIRMED' || booking!.status === 'SCHEDULED' || undefined,
          },
        },
      })
      return true
    })
  } catch (e) {
    logger.error({ bookingId, source: input.source, err: asMessage(e) }, 'lifecycle: completion transaction failed — nothing was written')
    return {
      ok: false,
      code: 'write_failed',
      message: 'The job could not be marked complete — nothing was changed. Try again.',
      booking,
    }
  }

  const after = (await loadLifecycleBooking(bookingId).catch(() => null)) ?? booking
  if (!claimed) {
    // Somebody else won the claim between the read and the write. Their
    // completion is the real one; report it as already complete rather than
    // announcing a second time.
    logger.info({ bookingId, source: input.source }, 'lifecycle: completion claim lost — another caller completed this move')
    return {
      ok: true,
      outcome: 'already_completed',
      booking: after,
      completedAt: after.completedAt,
      durationMins: after.job?.durationMins ?? durationMins,
      claimed: false,
    }
  }

  logger.info(
    { bookingId, source: input.source, by: input.actor.name, durationMins, outcome: plan.kind },
    'lifecycle: booking COMPLETED (booking + job + audit committed together)',
  )

  const result: CompleteResult = {
    ok: true,
    outcome: plan.kind === 'repair' ? 'repaired' : 'completed',
    booking: after,
    completedAt: after.completedAt ?? stampAt,
    durationMins,
    claimed: true,
  }
  if (input.effects === false) return result
  return { ...result, effects: await afterCompletion(after, after.completedAt ?? stampAt, input.effectsTimeoutMs, deps) }
}

/**
 * The post-move fan-out. Runs ONLY after the completion is committed, so every
 * send-time recheck (`bookingEligibility`) sees a row that really is COMPLETED
 * with a real `completedAt`.
 *
 * Every handoff is INDIVIDUALLY guarded and non-fatal — the lifecycle fact is
 * already durable — and every handoff is IDEMPOTENT, so running this again (the
 * admin replay action) can neither double-send nor double-schedule:
 *   • the email carries a deterministic queue-job id AND lands on the send
 *     guard's per-booking idempotency key;
 *   • followups.onBookingCompleted uses stable BullMQ job ids and a
 *     FollowUpLedger unique key;
 *   • journeys.onBookingCompletedBalance uses a stable job id.
 */
export async function afterCompletion(
  booking: LifecycleBooking,
  completedAt: Date,
  timeoutMs?: number,
  deps: LifecycleDeps = {},
): Promise<EffectReport> {
  const logger = deps.logger ?? apiLogger
  const effects = deps.effects ?? defaultLifecycleEffects()
  const report: EffectReport = notRun()

  const run = async (): Promise<void> => {
    // The customer's move-complete email.
    try {
      const queued = await effects.sendCompletionEmail(booking, completedAt)
      report.email = queued ? { state: 'queued', count: 1 } : { state: 'skipped', reason: 'no-email-address', count: 0 }
    } catch (e) {
      report.email = { state: 'failed', reason: asMessage(e), count: 0 }
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'job-completion email enqueue failed (non-fatal)')
    }
    // Review / review-reminder / referral / repeat-customer sequence.
    // The handoff's OWN answer decides the state. It returns early — reporting
    // nothing scheduled — whenever MARKETING_FOLLOWUPS_ENABLED is off (the
    // shipped default) or the customer never opted in to promotional mail.
    try {
      report.followups = followupOutcome(await effects.scheduleFollowups(booking.id))
      if (report.followups.state !== 'scheduled') {
        logger.info(
          { bookingId: booking.id, state: report.followups.state, reason: report.followups.reason },
          'post-move follow-ups were NOT scheduled',
        )
      }
    } catch (e) {
      report.followups = { state: 'failed', reason: asMessage(e), count: 0 }
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'post-move follow-ups not scheduled (non-fatal)')
    }
    // +24h balance reminder for the money still owed, and the `move_completed`
    // automation trigger.
    try {
      report.balance = balanceOutcome(await effects.scheduleBalanceReminder(booking.id))
      if (report.balance.state !== 'scheduled') {
        logger.info(
          { bookingId: booking.id, state: report.balance.state, reason: report.balance.reason },
          'post-completion balance reminder was NOT scheduled',
        )
      }
    } catch (e) {
      report.balance = { state: 'failed', reason: asMessage(e), count: 0 }
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'post-completion balance reminder not scheduled (non-fatal)')
    }
  }

  if (timeoutMs && timeoutMs > 0) {
    try {
      await withDeadline(run(), timeoutMs, 'post-completion handoffs')
    } catch (e) {
      report.timedOut = true
      logger.warn(
        { bookingId: booking.id, err: asMessage(e) },
        'post-completion handoffs did not finish inside the interaction budget — the completion itself is committed',
      )
    }
  } else {
    await run()
  }
  return report
}

/** Re-drive the post-move messages for a booking that is ALREADY completed.
 *  This is the recovery the product did not have: a job completed in Discord
 *  before this fix (or one stranded by a partial failure) is rescued by an
 *  operator action instead of being lost forever. Costs nothing when everything
 *  already fired — every handoff dedupes. */
export async function replayCompletion(
  bookingId: string,
  opts: { timeoutMs?: number } = {},
  deps: LifecycleDeps = {},
): Promise<
  | { ok: true; booking: LifecycleBooking; completedAt: Date | null; effects: EffectReport }
  | { ok: false; code: LifecycleErrorCode; message: string }
> {
  const booking = await loadLifecycleBooking(bookingId).catch(() => null)
  if (!booking) return { ok: false, code: 'not_found', message: 'Booking not found.' }
  if (booking.status !== 'COMPLETED' && booking.status !== 'ARCHIVED') {
    return {
      ok: false,
      code: 'invalid_status',
      message: `This booking is ${booking.status.replace(/_/g, ' ').toLowerCase()} — there is no completed job to send messages about.`,
    }
  }
  if (!booking.completedAt) {
    // The stamp is the gate every post-move template checks. Without it these
    // messages would be refused at send time, so repair the fact FIRST — that is
    // exactly what completeBooking's repair claim does, and it also runs the
    // fan-out, so this call is complete once it returns.
    const repaired = await completeBooking(
      { bookingId, actor: { name: 'replay' }, source: 'admin', effectsTimeoutMs: opts.timeoutMs },
      deps,
    )
    if (!repaired.ok) return { ok: false, code: repaired.code, message: repaired.message }
    return {
      ok: true,
      booking: repaired.booking,
      completedAt: repaired.completedAt,
      effects: repaired.effects ?? notRun(),
    }
  }
  const effects = await afterCompletion(booking, booking.completedAt, opts.timeoutMs, deps)
  return { ok: true, booking, completedAt: booking.completedAt, effects }
}

// ════════════════════════════════════════════════════════════════════════════
//  CANCEL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cancel a move. ONE transaction: Booking + Job + live crew assignments +
 * AuditLog.
 *
 * Marking the JOB cancelled is the load-bearing half. `JobStatus.CANCELLED` was
 * written by nothing in the repository, which made conflict-engine's
 * ASSIGNMENT_ON_CANCELLED_JOB HARD_BLOCK unreachable — the server would let the
 * owner add MORE crew to a cancelled move. Cancelling the assignments is the
 * other half: the crew portal's "upcoming" list filters on assignment liveness,
 * not on the booking, so a cancelled move stayed on a worker's phone until the
 * rows themselves said otherwise.
 */
export async function cancelBooking(input: CancelInput, deps: LifecycleDeps = {}): Promise<CancelResult> {
  const logger = deps.logger ?? apiLogger
  const at = input.at ?? new Date()
  const bookingId = input.bookingId

  let booking: LifecycleBooking | null
  try {
    booking = await loadLifecycleBooking(bookingId)
  } catch (e) {
    logger.error({ bookingId, err: asMessage(e) }, 'lifecycle: could not read the booking to cancel')
    return { ok: false, code: 'write_failed', message: 'Could not read this booking — try again.' }
  }
  if (!booking) return { ok: false, code: 'not_found', message: 'Booking not found.' }

  const plan = planCancellation(booking.status)
  if (plan.kind === 'refuse') return { ok: false, code: 'invalid_status', message: plan.message, booking }

  if (plan.kind === 'already') {
    // Already cancelled — but the JOB may still be live (every cancellation
    // before this service left it that way). Finish that half; it is idempotent.
    const crew = await cancelJobForBooking(input, deps)
    const after = (await loadLifecycleBooking(bookingId).catch(() => null)) ?? booking
    return {
      ok: true,
      outcome: 'already_cancelled',
      booking: after,
      claimed: false,
      jobCancelled: crew.jobCancelled,
      crewCancelled: crew.crewCancelled,
      ...(crew.failed ? { jobCancelFailed: crew.failed } : {}),
    }
  }

  let committed: { claimed: boolean; jobCancelled: boolean; crewCancelled: number }
  try {
    committed = await prisma.$transaction(async (tx) => {
      const claim = await tx.booking.updateMany({
        where: { id: bookingId, status: { in: [...CANCELLABLE_STATUSES] } },
        data: { status: 'CANCELLED' },
      })
      if (claim.count === 0) return { claimed: false, jobCancelled: false, crewCancelled: 0 }

      const job = await tx.job.updateMany({
        // A COMPLETED job is a record of work that really happened; cancelling
        // the booking does not unmake it.
        where: { bookingId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
        data: { status: 'CANCELLED' },
      })

      let crewCancelled = 0
      if (booking!.job?.id) {
        const crew = await tx.jobCrew.updateMany({
          where: { jobId: booking!.job.id, assignmentStatus: { in: CANCELLABLE_ASSIGNMENT_STATUSES } },
          data: {
            assignmentStatus: 'CANCELLED',
            cancelledAt: at,
            cancelReason: input.reason?.trim() || 'Booking cancelled',
          },
        })
        crewCancelled = crew.count
      }

      await tx.auditLog.create({
        data: {
          id: cancellationAuditId(bookingId),
          action: 'BOOKING_STATE_CHANGED',
          bookingId,
          userId: input.actor.userId ?? null,
          details: {
            event: 'cancel_booking',
            by: input.actor.name,
            changedBy: input.actor.name,
            source: input.source,
            discordUserId: input.actor.discordUserId ?? null,
            from: booking!.status,
            to: 'CANCELLED',
            reason: input.reason ?? null,
            jobCancelled: job.count > 0,
            crewCancelled,
          },
        },
      })
      return { claimed: true, jobCancelled: job.count > 0, crewCancelled }
    })
  } catch (e) {
    logger.error({ bookingId, source: input.source, err: asMessage(e) }, 'lifecycle: cancellation transaction failed — nothing was written')
    return {
      ok: false,
      code: 'write_failed',
      message: 'The booking could not be cancelled — nothing was changed. Try again.',
      booking,
    }
  }

  const reread = await loadLifecycleBooking(bookingId).catch(() => null)
  const after = reread ?? booking

  // ── C3-3: A LOST CLAIM IS NOT A CANCELLATION ─────────────────────────────
  // The claim matches `status IN CANCELLABLE_STATUSES`, so it also matches ZERO
  // when the booking became COMPLETED between the read and the write — the
  // Discord move-day card is one tap, and this route is four clicks. Reporting
  // that as `already_cancelled` told the caller the booking was cancelled when
  // it had just been FINISHED, and the admin route answers `ok` by sending the
  // customer a cancellation email for a move that already happened. That email
  // reaches a real person, so this may only say `already_cancelled` when the
  // database SHOWS the booking cancelled.
  if (!committed.claimed) {
    if (!reread) {
      // The claim refused and the row cannot be re-read: nothing about this
      // booking's state is provable, so nothing is claimed about it.
      return {
        ok: false,
        code: 'write_failed',
        message:
          'This booking was NOT cancelled — it changed while you were looking at it and could not be re-read. Reload it and check before trying again.',
        booking: after,
      }
    }
    if (reread.status !== 'CANCELLED') {
      return {
        ok: false,
        code: 'invalid_status',
        message: `This booking is now ${reread.status.replace(/_/g, ' ').toLowerCase()} — it was NOT cancelled and nothing was changed.`,
        booking: reread,
      }
    }
    // Genuinely cancelled by somebody else. Their claim is the real one; finish
    // the crew half, which their path may not have done (declineBooking owns the
    // hold release and the CANCELLED claim, never the Job).
    const crew = await cancelJobForBooking(input, deps)
    return {
      ok: true,
      outcome: 'already_cancelled',
      booking: reread,
      claimed: false,
      jobCancelled: crew.jobCancelled,
      crewCancelled: crew.crewCancelled,
      ...(crew.failed ? { jobCancelFailed: crew.failed } : {}),
    }
  }

  logger.info(
    { bookingId, source: input.source, by: input.actor.name, jobCancelled: committed.jobCancelled, crewCancelled: committed.crewCancelled },
    'lifecycle: booking CANCELLED (booking + job + crew + audit committed together)',
  )

  const out: CancelResult = {
    ok: true,
    outcome: 'cancelled',
    booking: after,
    claimed: true,
    jobCancelled: committed.jobCancelled,
    crewCancelled: committed.crewCancelled,
  }
  if (input.effects === false) return out
  return { ...out, journeys: await afterCancellation(bookingId, input.effectsTimeoutMs, deps) }
}

export type JobCancelResult = {
  jobCancelled: boolean
  crewCancelled: number
  /** This call DELIBERATELY did nothing (`not_found`, `status:<X>`, `no_job`,
   *  `nothing_live`). Never set for a failure — see `failed`. */
  skipped?: string
  /** The remediation was attempted and FAILED. A failure reported as a skip is
   *  how the D3 defect hid: the caller cannot tell "nothing needed doing" from
   *  "the live crew of a cancelled move is still live". */
  failed?: string
  /** The deterministic ledger row already existed (an earlier pass recorded the
   *  crew half), so THIS pass's later work was recorded as its own follow-up
   *  entry instead of being rolled back by the unique violation. */
  followUpAudit?: boolean
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'P2002'

/**
 * Raise a FAILED Job/crew remediation, independently of who called.
 *
 * ── C3-2 ────────────────────────────────────────────────────────────────────
 * The `failed` field was added so a caller could tell a no-op from owed work,
 * and then every shipped caller discarded it: the admin decline path
 * (app/api/admin/bookings/[id]/status/route.ts) and the Discord deny path both
 * `await cancelJobForBooking(...)` for its side effects alone. So a failure was
 * RECORDED and never SURFACED. The callers now read it — and this raises it
 * anyway, because the reader of an HTTP response is not necessarily a person,
 * and the consequence (crew still assignable to a cancelled move, the job still
 * in a worker's upcoming list) can only be undone by hand.
 *
 * Never throws and never changes an outcome: the booking is cancelled either
 * way, and an alerting failure must not break the thing that produced it.
 */
async function surfaceCrewFailure(
  bookingId: string,
  displayId: string | null,
  reason: string,
  source: LifecycleSource,
  deps: LifecycleDeps,
  logger: LifecycleLogger,
): Promise<void> {
  const effects = deps.effects ?? defaultLifecycleEffects()
  try {
    await effects.alertCrewCancelFailed?.({ bookingId, displayId, reason, source })
  } catch (e) {
    logger.error(
      { bookingId, err: asMessage(e) },
      'lifecycle: the crew-cancellation failure could not be raised to the owner (the failure itself still stands)',
    )
  }
}

/**
 * The JOB half of a cancellation, for callers whose booking row was already
 * claimed CANCELLED by another service — `declineBooking` (src/lib/booking-approval.ts)
 * owns the $49 hold release and the CANCELLED claim on a not-yet-captured
 * booking, and this module must not duplicate either.
 *
 * REFUSES to act unless the booking really is CANCELLED, so it can never cancel
 * the crew of a live move. Idempotent: a second run matches zero rows and writes
 * no audit.
 *
 * ── D3, THE SMALLER HALF ──────────────────────────────────────────────────
 * The audit row carried `id: jobCancellationAuditId(bookingId)` unconditionally
 * INSIDE the transaction. That id is a once-per-booking claim, but the WORK is
 * not once-per-booking: crew can be assigned after a booking is cancelled, and
 * the next run is real remediation. It hit P2002 on the ledger row, Postgres
 * aborted the whole transaction, the job/crew cancellation rolled back with it —
 * and the caller was told `skipped`. Reproduced: a worker assigned after the
 * first pass stayed ASSIGNED on a cancelled move, and the result said the run
 * had been skipped.
 *
 * The ledger row keeps its deterministic id for the FIRST pass (exactly-once
 * for that event). A later pass records its own work as a separate entry — the
 * house `count`-before-`create` guard (labor-service.ts:227) decides which —
 * and the genuine race, where two callers both see no row, is resolved by
 * re-running the (conditional, idempotent) updates without the ledger claim.
 */
export async function cancelJobForBooking(
  input: CancelInput,
  deps: LifecycleDeps = {},
): Promise<JobCancelResult> {
  const logger = deps.logger ?? apiLogger
  const at = input.at ?? new Date()
  const bookingId = input.bookingId

  // ── C3-1: A THROWN READ IS NOT A DELIBERATE SKIP ─────────────────────────
  // `.catch(() => null)` collapsed "the database could not be read" into the
  // same answer as "there is no such booking", and `not_found` is a SKIP — the
  // caller reads it as "nothing needed doing". That is the identical defect the
  // write seam carried one line down, where a failure wore the word `skipped`;
  // this is the read seam, and it hides the same thing: a booking whose job and
  // crew may still be live on a cancelled move. Unreadable is OWED WORK.
  let booking: LifecycleBooking | null
  try {
    booking = await loadLifecycleBooking(bookingId)
  } catch (e) {
    const failed = `booking read failed: ${asMessage(e)}`
    logger.error({ bookingId, err: asMessage(e) }, 'lifecycle: could not read the booking to cancel its job')
    await surfaceCrewFailure(bookingId, null, failed, input.source, deps, logger)
    return { jobCancelled: false, crewCancelled: 0, failed }
  }
  if (!booking) return { jobCancelled: false, crewCancelled: 0, skipped: 'not_found' }
  if (booking.status !== 'CANCELLED') return { jobCancelled: false, crewCancelled: 0, skipped: `status:${booking.status}` }
  if (!booking.job) return { jobCancelled: false, crewCancelled: 0, skipped: 'no_job' }

  const auditId = jobCancellationAuditId(bookingId)

  const remediate = async (ledgerTaken: boolean): Promise<JobCancelResult> =>
    prisma.$transaction(async (tx) => {
      const job = await tx.job.updateMany({
        where: { bookingId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
        data: { status: 'CANCELLED' },
      })
      const crew = await tx.jobCrew.updateMany({
        where: { jobId: booking.job!.id, assignmentStatus: { in: CANCELLABLE_ASSIGNMENT_STATUSES } },
        data: {
          assignmentStatus: 'CANCELLED',
          cancelledAt: at,
          cancelReason: input.reason?.trim() || 'Booking cancelled',
        },
      })
      if (job.count === 0 && crew.count === 0) return { jobCancelled: false, crewCancelled: 0, skipped: 'nothing_live' }
      await tx.auditLog.create({
        data: {
          // Only the first pass claims the deterministic id. A later pass is a
          // DIFFERENT event (rows that did not exist the first time), so it
          // takes a generated id rather than colliding with the ledger.
          ...(ledgerTaken ? {} : { id: auditId }),
          action: 'BOOKING_STATE_CHANGED',
          bookingId,
          userId: input.actor.userId ?? null,
          details: {
            event: ledgerTaken ? 'cancel_job_for_cancelled_booking_followup' : 'cancel_job_for_cancelled_booking',
            by: input.actor.name,
            changedBy: input.actor.name,
            source: input.source,
            discordUserId: input.actor.discordUserId ?? null,
            // What THIS pass did. Never a running total it cannot prove.
            jobCancelled: job.count > 0,
            crewCancelled: crew.count,
          },
        },
      })
      return { jobCancelled: job.count > 0, crewCancelled: crew.count, ...(ledgerTaken ? { followUpAudit: true } : {}) }
    })

  // Same discipline as labor-service.ts:227 — ask whether the ledger row exists
  // before trying to write it, so the ordinary repeat pass never provokes the
  // constraint at all. An unreadable count is treated as "absent": the race
  // below is exactly what covers that.
  const ledgerTaken = await prisma.auditLog
    .count({ where: { id: auditId } })
    .then((n) => n > 0)
    .catch(() => false)

  try {
    return await remediate(ledgerTaken)
  } catch (e) {
    if (!isUniqueViolation(e)) {
      // Never fatal: the booking IS cancelled either way, and the caller's own
      // work (releasing the hold, emailing the customer) must stand. But it is
      // reported as a FAILURE, not as a skip — and now RAISED, because the
      // callers that discarded this value are exactly why nobody ever saw it.
      logger.error({ bookingId, err: asMessage(e) }, 'lifecycle: could not cancel the job/crew of a cancelled booking (non-fatal)')
      await surfaceCrewFailure(bookingId, booking.displayId, asMessage(e), input.source, deps, logger)
      return { jobCancelled: false, crewCancelled: 0, failed: asMessage(e) }
    }
    // Somebody else claimed the ledger row between the count and the insert.
    // Postgres aborts the whole transaction on the violation, so the job/crew
    // writes rolled back WITH it — the remediation is still owed. Re-run it
    // without the ledger claim; every update is conditional, so anything the
    // winner already closed simply matches zero rows.
    logger.info({ bookingId }, 'lifecycle: job-cancellation ledger row already claimed — re-running the remediation')
    try {
      return await remediate(true)
    } catch (again) {
      logger.error({ bookingId, err: asMessage(again) }, 'lifecycle: job/crew cancellation failed after the ledger retry')
      await surfaceCrewFailure(bookingId, booking.displayId, asMessage(again), input.source, deps, logger)
      return { jobCancelled: false, crewCancelled: 0, failed: asMessage(again) }
    }
  }
}

/** Stop every journey for a dead booking. Guarded + optionally time-boxed. */
export async function afterCancellation(
  bookingId: string,
  timeoutMs?: number,
  deps: LifecycleDeps = {},
): Promise<string> {
  const logger = deps.logger ?? apiLogger
  const effects = deps.effects ?? defaultLifecycleEffects()
  try {
    const p = effects.stopJourneys(bookingId)
    await (timeoutMs && timeoutMs > 0 ? withDeadline(p, timeoutMs, 'journey stop') : p)
    return 'ok'
  } catch (e) {
    logger.error({ bookingId, err: asMessage(e) }, 'lifecycle: journey stop failed (non-fatal)')
    return `failed:${asMessage(e)}`
  }
}
