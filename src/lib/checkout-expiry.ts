// ════════════════════════════════════════════════════════════════════════
//  EXPIRED CHECKOUTS AND THE TRUCK THEY HOLD
//  (release blocker B6 — and D1, the REVERT of B6's automatic cancellation)
//  ---------------------------------------------------------------------
//  THE ORIGINAL DEFECT. `createBookingCheckout` gives every Stripe Checkout
//  Session an `expires_at` THIRTY MINUTES out (src/lib/stripe.ts), and the
//  default admin Book Move writes `truckId` onto a PENDING_PAYMENT row.
//  PENDING_PAYMENT is a truck-hold status by design (truck-conflicts.ts R2-2 —
//  an assigned truck IS held). `checkout.session.expired` was handled by ONE
//  `logger.info` line, so the ordinary "let me ask my wife" customer left a
//  stale hold on a truck for the requested move day. The owner could see it and
//  could not clear it.
//
//  ── D1: THE AUTOMATIC CANCELLATION IS GONE. READ THIS BEFORE ADDING IT BACK ──
//  B6 answered that with a webhook + hourly sweep that CANCELLED the booking.
//  Verified reproductions of the shipped fix (docs/moving-os-money-final2.md):
//
//    1. MID-PAYMENT CANCELLATION VIA THE SWEEP. The "expired on its own clock"
//       guard was applied only in the webhook handler. `sweepStaleCheckouts`
//       went straight from `previousSessionVerdict === 'gone'` to the
//       cancellation, so a booking whose customer was at that moment being
//       redirected into a FRESH session was cancelled while they paid.
//    2. NO CONCURRENCY REQUIRED. The resume route retires the recorded session
//       BEFORE minting its replacement (checkout-session.retirePreviousCheckout
//       Session). When the replacement fails — Stripe error, no session url, a
//       failed recordCheckoutSession — the booking keeps the id of a session
//       Stripe now reports `expired`. Within one sweep interval that booking is
//       terminally cancelled. The customer clicked "finish your booking",
//       something hiccuped, and their booking is gone.
//    3. TERMINAL. `VALID_TRANSITIONS` (app/api/admin/bookings/[id]/status/
//       route.ts) has no key out of CANCELLED, so neither the owner nor the
//       customer can undo it.
//
//  Weigh the harms: the bug is a stale truck hold — friction, an override the
//  owner already has, and un-actionable alert noise. The "fix" cancels a paying
//  customer's booking, irreversibly. That trade is unacceptable, so the
//  automatic cancellation is REMOVED, not guarded a fourth time.
//
//  ── WHAT WOULD MAKE AUTOMATIC CANCELLATION SAFE (it is not a fourth guard) ──
//  Every guard B6 shipped answers the question "is THIS session dead?". The
//  question that actually decides whether a customer may be cancelled is "does
//  this booking have ANY live session right now?" — and this system cannot
//  answer it. `Booking.stripeCheckoutId` holds ONE id, the last one recorded,
//  and the resume route overwrites it; the moments between retiring a session
//  and recording its replacement (and every path where the replacement is never
//  recorded at all) leave the column naming a session that is dead while the
//  customer holds a live one, or naming nothing at all. No cross-check exists:
//  nothing enumerates a booking's sessions, and Stripe's list API is not
//  consulted anywhere in this repo.
//  So automatic cancellation would first need a DURABLE PER-BOOKING RECORD OF
//  EVERY SESSION EVER CREATED FOR IT — one row per session, written before the
//  customer is redirected into it, carrying its id, its created/expires
//  timestamps and its terminal verdict — so that "no live session exists for
//  this booking" becomes a fact the database can prove rather than an inference
//  from a single mutable column. That is a schema change and a migration, and
//  until it exists the honest answer to "may this be cancelled?" is: a human
//  decides. Anything else is guessing with someone's move.
//
//  ── WHAT THIS MODULE DOES INSTEAD, ALL OF IT PROVABLY SAFE ──────────────
//   1. RECORDS the expiry. `handleCheckoutSessionExpired` classifies the event
//      (using the same clock guard, so an expiry WE caused is never recorded as
//      an abandonment) and logs it against the booking. It writes nothing to
//      the booking. The durable trace of the event itself is the `webhook_logs`
//      row the webhook machinery already keys on `eventId` — a NEW AuditLog
//      action would need an enum value, i.e. a migration, and no existing
//      action honestly describes "a checkout session lapsed and nothing
//      changed".
//   2. REPORTS stale holds. `reportStaleCheckouts` asks Stripe what each
//      recorded session IS and returns findings. It cancels nothing. It still
//      raises the two MONEY shapes to the owner (a completed session on a
//      booking that reads unpaid; a cancelled booking still carrying a payable
//      session) because those can strand $49 and nothing else watches for them.
//   3. SURFACES stale holds where the owner already looks. The Action Center
//      rule `checkout-hold-stale` (src/lib/reminder-rules.ts) is derived from
//      the booking row alone — status, deposit, truck, age — so it is deduped,
//      auto-resolves when the hold ends, and needs no Stripe call and no new
//      table.
//   4. GIVES THE OWNER THE EXIT. `releaseTruckHoldByOwner` is the explicit,
//      permission-gated, audited action behind POST /api/admin/bookings/[id]/
//      release-hold, reached from the booking page. A human decides, with the
//      booking in front of them, and the action REFUSES outright when Stripe
//      says the session completed (money may exist) and requires an explicit
//      acknowledgement when the session is still payable or Stripe cannot be
//      asked at all.
//   5. AND FINISHES THE CANCELLATION IT PERFORMS (item C4). A release IS a
//      cancellation, and its two twins do more than flip the status: the
//      lifecycle service cancels the Job and the live crew assignments and
//      stops the booking's journeys and automation enrolments. This did none of
//      it, so a released booking kept a live Job (which made conflict-engine's
//      ASSIGNMENT_ON_CANCELLED_JOB hard block unreachable — more crew could
//      still be assigned to it), stayed in the crew's upcoming list, and kept
//      being emailed. It now calls THE SAME shared service rather than a fourth
//      copy of the logic, and — when the owner acknowledged a still-payable (or
//      unreadable) session — expires that session, because a payment completed
//      on a cancelled booking is $49 nothing in this system can capture,
//      release or refund (fulfilment's claim matches PENDING_PAYMENT/DRAFT
//      only). Every one of those outcomes is REPORTED, never assumed.
//
//  ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────
//   • It never writes `truckId: null`. Leaving TRUCK_HOLD_STATUSES is what
//     releases the truck (`holdsTruck('CANCELLED') === false`), and nulling the
//     column would destroy the owner's assignment intent. The audit row states
//     the release as a DERIVED fact (`!holdsTruck('CANCELLED')`) so it can
//     never claim a release that TRUCK_HOLD_STATUSES stopped granting.
//   • It never touches TRUCK_HOLD_STATUSES (documented R2-2: a truck assigned
//     to an unpaid booking IS held — the bug was the missing exit, not the hold).
//   • It never captures, releases or refunds money, and no message it produces
//     claims a card was charged, released or refunded. When Stripe says a
//     session is COMPLETE it says exactly that and asks a human to look.
//
//  Everything is dependency-injected, so the whole flow runs offline
//  (src/lib/__tests__/checkout-expiry.test.ts). Pure decisions are exported
//  separately from the I/O that acts on them.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { stripe } from './stripe'
import { webhookLogger } from './logger'
import { postOpsAlert } from './ops-alert'
import { holdsTruck } from './truck-conflicts'
import { ABANDONED_STAGES } from './journeys'
import { can, type Role } from './permissions'
import {
  CHECKOUT_SESSION_TTL_MINUTES,
  previousSessionVerdict,
  type AlertLine,
  type CheckoutLogger,
  type CheckoutSessionSnapshot,
} from './checkout-session'

const HOUR_MS = 3_600_000

// ── How old a hold must be before the REPORT calls it stale ─────────────────

/** The FLOOR under every staleness threshold, from the verified findings: a
 *  hold is never called stale on age alone, and never within two hours of being
 *  made. Below this the owner can still hand the customer a working resume
 *  link and the recovery sequence has barely started. */
export const STALE_CHECKOUT_MIN_AGE_MS = 2 * HOUR_MS

/** Breathing room after the LAST recovery email before a hold is reported, so a
 *  customer who clicks "finish your booking" the same evening is not on the
 *  owner's "release this" list while the funnel is still working. */
export const RECOVERY_MARGIN_MS = 2 * HOUR_MS

/** Is the abandoned-checkout recovery sequence going to chase this customer?
 *
 *  Mirrors `journeys.enabled('abandoned')`, which is module-private. The two
 *  env names are pinned against journeys.ts by a source-parity test rather than
 *  trusted — a silent divergence here would put holds on the owner's list while
 *  the funnel is still emailing them. (journeys.ts reads its master switch ONCE
 *  at module load; this reads it per call, which is what lets the threshold be
 *  exercised both ways offline.) */
export function abandonedRecoveryActive(env: Record<string, string | undefined> = process.env): boolean {
  if (env.EMAIL_JOURNEYS_ENABLED !== 'true') return false
  return env.EMAIL_JOURNEY_ABANDONED_DISABLED !== 'true'
}

/**
 * How long an unpaid hold is left out of the report.
 *
 * DERIVED, never typed: when the recovery sequence is live the threshold
 * outlives its LAST stage, so the owner is never asked to clear a booking the
 * funnel is still working on. Change `ABANDONED_STAGES` and this moves with it.
 *
 * NOTE THIS IS NO LONGER A SAFETY GUARD — nothing is cancelled anywhere in this
 * module without a human — it is a NOISE threshold for a report.
 */
export function staleHoldGraceMs(
  opts: { active?: boolean; stages?: readonly { delay: number }[] } = {},
): number {
  const active = opts.active ?? abandonedRecoveryActive()
  if (!active) return STALE_CHECKOUT_MIN_AGE_MS
  const stages = opts.stages ?? ABANDONED_STAGES
  const last = stages.reduce((max, s) => Math.max(max, s.delay), 0)
  return Math.max(STALE_CHECKOUT_MIN_AGE_MS, last + RECOVERY_MARGIN_MS)
}

// ── Did this session die on its own schedule? ───────────────────────────────

export type OwnClockVerdict =
  /** Stripe let it lapse — nobody is mid-payment on it. */
  | { natural: true; reason: 'expired-on-schedule' }
  /** It was expired EARLY, i.e. by this codebase, i.e. a replacement session
   *  was being created at that moment. This is NOT an abandonment. */
  | { natural: false; reason: 'expired-early' }
  /** The session carries no usable clock, so nothing can be concluded. */
  | { natural: false; reason: 'unknown-session-clock' }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Did this Checkout Session reach its own expiry deadline, or did something
 * expire it early?
 *
 * `stripe.checkout.sessions.expire` is called in exactly two places in this
 * repo (checkout-session.retirePreviousCheckoutSession and
 * abandonCheckoutSession), and BOTH only ever act on a session that is still
 * `open` — that is, strictly before its deadline. So "expired before its
 * deadline" is a reliable signature of OUR OWN call.
 *
 * The deadline is the LATER of the session's stated `expires_at` and
 * `created + CHECKOUT_SESSION_TTL_MINUTES`, which makes the verdict correct
 * whether or not Stripe rewrites `expires_at` when a session is expired by API:
 *   • not rewritten → both terms are the same instant;
 *   • rewritten to the moment of the call → that term is EARLIER, the derived
 *     one wins, and the early expiry is still recognised.
 * Both timestamps come from Stripe, so this never compares two clocks.
 *
 * NOTHING IS CANCELLED ON THIS VERDICT ANY MORE. It decides only whether the
 * event describes a genuine abandonment (worth recording as one) or our own
 * session retirement (worth recording as that instead) — a record that said
 * "the customer abandoned checkout" about a session this codebase expired
 * while handing them a new one would be a false record.
 */
export function expiredOnItsOwnSchedule(input: {
  sessionCreatedSec?: number | null
  sessionExpiresAtSec?: number | null
  eventCreatedSec?: number | null
  ttlMinutes?: number
}): OwnClockVerdict {
  const eventAtMs = finite(input.eventCreatedSec) ? input.eventCreatedSec * 1000 : null
  if (eventAtMs === null) return { natural: false, reason: 'unknown-session-clock' }

  const ttlMs = (input.ttlMinutes ?? CHECKOUT_SESSION_TTL_MINUTES) * 60_000
  const deadlines: number[] = []
  if (finite(input.sessionExpiresAtSec)) deadlines.push(input.sessionExpiresAtSec * 1000)
  if (finite(input.sessionCreatedSec)) deadlines.push(input.sessionCreatedSec * 1000 + ttlMs)
  if (deadlines.length === 0) return { natural: false, reason: 'unknown-session-clock' }

  const deadline = Math.max(...deadlines)
  return eventAtMs >= deadline
    ? { natural: true, reason: 'expired-on-schedule' }
    : { natural: false, reason: 'expired-early' }
}

// ── Rows, deps and results ──────────────────────────────────────────────────

/** The columns this module reasons about. All BASELINE columns (no migration
 *  under prisma/migrations creates any of them), so these reads can never be
 *  the statement that discovers a column the database does not have yet. */
export type StaleCheckoutRow = {
  id: string
  displayId: string | null
  status: string
  depositPaid: boolean
  stripeCheckoutId: string | null
  /** Set once a customer has authorized: the money path, never this one. */
  stripePaymentIntentId: string | null
  truckId: string | null
  createdAt: Date
}

/** A Stripe session plus the two clock fields the own-clock check needs. */
export type ExpirySessionSnapshot = CheckoutSessionSnapshot & {
  created?: number | null
  expires_at?: number | null
}

/** The owner's decision, as it reaches the writer. */
export type ReleaseHoldWrite = {
  bookingId: string
  /** Recorded on the audit row so the decision is explainable later. */
  actorUserId: string | null
  actorName: string
  sessionId: string | null
  sessionVerdict: OwnerSessionVerdict
  acknowledgedRisk: boolean
}

/**
 * What the SHARED lifecycle service did with the dead booking's job, crew and
 * journeys after the owner released the hold.
 *
 * ── C4 ─────────────────────────────────────────────────────────────────────
 * The release is a CANCELLATION, and the other two cancellation paths both do
 * this half: `lifecycle-service.cancelBooking` cancels Booking + Job + live
 * crew + audit in one transaction and then stops the journeys, and the decline
 * path calls `cancelJobForBooking` for the Job/crew half after
 * `declineBooking` claims the row. The owner's release did neither, so a
 * released booking kept a live Job (which made conflict-engine's
 * ASSIGNMENT_ON_CANCELLED_JOB hard block unreachable — MORE crew could be
 * assigned to it), kept its assignments on a worker's phone, and kept its
 * abandoned-checkout recovery emails and marketing enrolments running against a
 * customer whose booking no longer exists.
 */
export type ReleaseAftermath = {
  /** The Job row was moved to CANCELLED by this call. */
  jobCancelled: boolean
  /** How many live crew assignments this call cancelled. */
  crewCancelled: number
  /** The Job/crew half was ATTEMPTED and FAILED. Never set for "nothing was
   *  live" — that distinction is the whole point of the field. */
  jobCancelFailed?: string
  /** It deliberately did nothing (`no_job`, `nothing_live`, …). */
  jobSkipped?: string
  /** 'ok' | 'failed:<message>' | 'not-run' — the journey/enrolment stop. */
  journeys: string
}

export type FinishCancellationInput = {
  bookingId: string
  actorUserId: string | null
  actorName: string
  reason: string
  timeoutMs?: number
}

/** How long the journey stop may take before the route stops waiting for it.
 *  The booking is already CANCELLED at that point and every stage rechecks the
 *  booking at send time, so a slow queue delays a message, it does not send a
 *  wrong one. */
export const RELEASE_JOURNEY_TIMEOUT_MS = 8_000

/**
 * The Job/crew + journeys half of a cancellation, performed by THE SHARED
 * LIFECYCLE SERVICE — never a fourth copy of the logic.
 *
 * `cancelJobForBooking` REFUSES to act unless the booking really is CANCELLED
 * (so this can never touch a live move), is idempotent, and reports a failed
 * remediation as `failed` rather than as a skip. `afterCancellation` is the
 * same journey stop `cancelBooking` runs.
 *
 * Imported dynamically so this module — reached from a Next route — does not
 * drag the lifecycle service's fan-out (BullMQ, @react-email) into its module
 * graph at import time. `lifecycleDeps` exists so the whole thing runs offline.
 */
export async function finishCancellationViaLifecycle(
  input: FinishCancellationInput,
  lifecycleDeps?: import('./lifecycle-service').LifecycleDeps,
): Promise<ReleaseAftermath> {
  const { cancelJobForBooking, afterCancellation } = await import('./lifecycle-service')
  const crew = await cancelJobForBooking(
    {
      bookingId: input.bookingId,
      actor: { name: input.actorName, userId: input.actorUserId },
      source: 'admin',
      reason: input.reason,
    },
    lifecycleDeps ?? {},
  )
  const journeys = await afterCancellation(
    input.bookingId,
    input.timeoutMs ?? RELEASE_JOURNEY_TIMEOUT_MS,
    lifecycleDeps ?? {},
  )
  return {
    jobCancelled: crew.jobCancelled,
    crewCancelled: crew.crewCancelled,
    ...(crew.failed ? { jobCancelFailed: crew.failed } : {}),
    ...(crew.skipped ? { jobSkipped: crew.skipped } : {}),
    journeys,
  }
}

export type CheckoutExpiryDeps = {
  /** Best-effort read of the booking behind an expiry / a release request. */
  readHold(bookingId: string): Promise<StaleCheckoutRow | null>
  findStaleCheckouts(input: { staleBefore: Date; cancelledSince: Date; limit: number }): Promise<StaleCheckoutRow[]>
  /** Null when Stripe has no such session. THROWS on a transport failure — the
   *  difference matters: "no session" is safe, "cannot tell" is not. */
  retrieveSession(sessionId: string): Promise<ExpirySessionSnapshot | null>
  expireSession(sessionId: string): Promise<void>
  /** THE OWNER ACTION's writer: ONE conditional statement + its audit row, in
   *  ONE transaction. Returns the number of rows it changed: 1 or 0.
   *  There is no automatic caller — the only caller is
   *  `releaseTruckHoldByOwner`, which a human triggers. */
  releaseTruckHold(input: ReleaseHoldWrite): Promise<number>
  /** C4 — the Job/crew + journeys half, delegated to the shared lifecycle
   *  service. Runs ONLY after the booking really is CANCELLED. */
  finishCancellation(input: FinishCancellationInput): Promise<ReleaseAftermath>
  alert(title: string, lines: AlertLine[]): Promise<{ delivered: boolean }>
  log: CheckoutLogger
  now(): number
}

const HOLD_SELECT = {
  id: true,
  displayId: true,
  status: true,
  depositPaid: true,
  stripeCheckoutId: true,
  stripePaymentIntentId: true,
  truckId: true,
  createdAt: true,
} as const

export function defaultCheckoutExpiryDeps(): CheckoutExpiryDeps {
  return {
    async readHold(bookingId) {
      return prisma.booking.findUnique({ where: { id: bookingId }, select: HOLD_SELECT })
    },
    async findStaleCheckouts({ staleBefore, cancelledSince, limit }) {
      return prisma.booking.findMany({
        where: {
          isInternalTest: false,
          depositPaid: false,
          stripeCheckoutId: { not: null },
          OR: [
            // Duty 1 — a hold past the staleness threshold whose session may be dead.
            { status: 'PENDING_PAYMENT', createdAt: { lt: staleBefore } },
            // Duty 2 — a recently cancelled booking that may still carry a
            // PAYABLE session. Nothing can consume a payment there
            // (fulfillment's claim matches only PENDING_PAYMENT/DRAFT), so a
            // live session on it is $49 nobody could capture or release.
            { status: 'CANCELLED', updatedAt: { gte: cancelledSince } },
          ],
        },
        select: HOLD_SELECT,
        orderBy: { createdAt: 'asc' },
        take: limit,
      })
    },
    async retrieveSession(sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId)
      if (!s) return null
      return {
        id: s.id,
        status: s.status ?? null,
        payment_status: s.payment_status ?? null,
        created: s.created ?? null,
        expires_at: s.expires_at ?? null,
      }
    },
    async expireSession(sessionId) {
      await stripe.checkout.sessions.expire(sessionId)
    },
    async releaseTruckHold(input) {
      return prisma.$transaction(async (tx) => {
        // EVERY predicate is load-bearing, even behind a human:
        //   status/depositPaid       — only an unpaid hold ends this way;
        //   stripePaymentIntentId    — a booking that reached an authorization
        //                              belongs to the money path (decline /
        //                              refund), never to this one;
        // One statement, so two owners clicking at once cannot both "release"
        // the same hold: the loser matches zero rows and is told so.
        const claim = await tx.booking.updateMany({
          where: {
            id: input.bookingId,
            status: 'PENDING_PAYMENT',
            depositPaid: false,
            stripePaymentIntentId: null,
          },
          data: { status: 'CANCELLED' },
        })
        if (claim.count === 0) return 0
        // Inside the SAME transaction as the state change, so the explanation
        // and the fact cannot come apart: a rollback loses both, and the
        // conditional claim above means a replay writes neither.
        await tx.auditLog.create({
          data: {
            action: 'BOOKING_STATE_CHANGED',
            bookingId: input.bookingId,
            userId: input.actorUserId,
            details: {
              from: 'PENDING_PAYMENT',
              to: 'CANCELLED',
              reason: 'owner_released_truck_hold',
              source: 'admin',
              releasedBy: input.actorName,
              stripeCheckoutId: input.sessionId,
              // What Stripe said about that session AT THE MOMENT the owner
              // decided — the evidence in front of the human, recorded.
              sessionVerdict: input.sessionVerdict,
              acknowledgedRisk: input.acknowledgedRisk,
              // DERIVED, not claimed: if CANCELLED ever became a truck-hold
              // status this record would stop saying the truck was freed.
              truckHoldReleased: !holdsTruck('CANCELLED'),
              depositCaptured: false,
            },
          },
          select: { id: true },
        })
        return claim.count
      })
    },
    finishCancellation(input) {
      return finishCancellationViaLifecycle(input)
    },
    async alert(title, lines) {
      return postOpsAlert(title, lines)
    },
    log: webhookLogger,
    now: () => Date.now(),
  }
}

// ── The webhook handler (checkout.session.expired) — RECORD ONLY ────────────

export type ExpiryRecordVerdict =
  /** An unpaid hold whose CURRENT session lapsed on its own clock. */
  | 'abandoned-hold'
  /** The event names a session the booking no longer carries. */
  | 'session-superseded'
  | 'booking-not-found'
  | 'deposit-paid'
  | 'not-an-unpaid-hold'

/**
 * PURE: what does this expiry event say about the booking as it actually is?
 *
 * Used for the RECORD and for the report's copy. It decides nothing about
 * cancelling, because nothing here cancels.
 */
export function classifyExpiredSession(
  row: StaleCheckoutRow | null,
  input: { sessionId: string },
): ExpiryRecordVerdict {
  if (!row) return 'booking-not-found'
  if (row.depositPaid) return 'deposit-paid'
  if (row.status !== 'PENDING_PAYMENT') return 'not-an-unpaid-hold'
  if (row.stripeCheckoutId !== input.sessionId) return 'session-superseded'
  return 'abandoned-hold'
}

export type ExpiryHandlerOutcome = {
  action: 'recorded' | 'ignored'
  reason: ExpiryRecordVerdict | 'no-booking-id' | 'expired-early' | 'unknown-session-clock'
  /** Always false. Kept explicit so a reader of a log line can see that this
   *  handler did not, and cannot, end a booking. */
  cancelled: false
}

/**
 * `checkout.session.expired` — the shipped handler.
 *
 * IT WRITES NOTHING TO THE BOOKING. It reads the row, works out what the event
 * means, and logs it against the booking; the durable record of the event is
 * the `webhook_logs` row the webhook machinery keys on `eventId`. The stale
 * hold that results is surfaced by the Action Center rule and by
 * `reportStaleCheckouts`, and only a human ends it.
 *
 * It throws only when the booking cannot be READ — an infrastructure failure,
 * where returning normally would record the event processed and retire the only
 * retry that could still record it. (stripe-events.ts contract: returning
 * normally means FINISHED.)
 */
export async function handleCheckoutSessionExpired(
  input: {
    bookingId?: string | null
    sessionId: string
    sessionCreatedSec?: number | null
    sessionExpiresAtSec?: number | null
    eventCreatedSec?: number | null
  },
  deps: CheckoutExpiryDeps = defaultCheckoutExpiryDeps(),
): Promise<ExpiryHandlerOutcome> {
  const bookingId = input.bookingId?.trim()
  if (!bookingId) {
    deps.log.info({ sessionId: input.sessionId }, 'checkout.session.expired without metadata.bookingId — not one of ours')
    return { action: 'ignored', reason: 'no-booking-id', cancelled: false }
  }

  const clock = expiredOnItsOwnSchedule({
    sessionCreatedSec: input.sessionCreatedSec,
    sessionExpiresAtSec: input.sessionExpiresAtSec,
    eventCreatedSec: input.eventCreatedSec,
  })
  if (!clock.natural) {
    deps.log.info(
      { bookingId, sessionId: input.sessionId, reason: clock.reason },
      clock.reason === 'expired-early'
        ? 'checkout.session.expired: this session was expired BEFORE its deadline, which only this codebase does when it is ' +
            'replacing it — the customer may be paying through the replacement, so this is not an abandonment'
        : 'checkout.session.expired: the session carries no usable expiry clock — nothing concluded',
    )
    return { action: 'ignored', reason: clock.reason, cancelled: false }
  }

  // Throws on an infrastructure failure — see the doc comment.
  const row = await deps.readHold(bookingId)
  const verdict = classifyExpiredSession(row, { sessionId: input.sessionId })

  if (verdict !== 'abandoned-hold') {
    deps.log.info(
      { bookingId, sessionId: input.sessionId, verdict, status: row?.status ?? null },
      'checkout.session.expired: recorded, no action needed (this session is not the booking\'s current unpaid hold)',
    )
    return { action: 'ignored', reason: verdict, cancelled: false }
  }

  deps.log.warn(
    {
      bookingId,
      displayId: row?.displayId ?? null,
      sessionId: input.sessionId,
      truckId: row?.truckId ?? null,
      sessionExpiredAt: finite(input.sessionExpiresAtSec) ? new Date(input.sessionExpiresAtSec * 1000).toISOString() : null,
      truckHoldStillHeld: true,
      cancelled: false,
    },
    'checkout.session.expired: this booking is still awaiting its deposit and still holds its truck. NOTHING was cancelled — ' +
      'the Action Center lists it once it is stale, and only the owner can release it',
  )
  return { action: 'recorded', reason: 'abandoned-hold', cancelled: false }
}

// ── Owner alerts (pure, so the wording is testable) ─────────────────────────
//
// House rule: no message may state that money was captured, released, refunded
// or sent unless the database proves it. These two alerts are ABOUT money and
// must therefore be the most careful strings in the module — each one reports
// what Stripe said and asks a human to look, and neither claims an outcome.

export type OpsAlertDraft = { title: string; lines: AlertLine[] }

/** Stripe says the recorded session is COMPLETE while the booking still reads
 *  awaiting payment — i.e. a `checkout.session.completed` this system never
 *  processed. Money may be authorized. NOTHING is cancelled on this path. */
export function authorizedButUnpaidAlert(input: {
  bookingId: string
  displayId?: string | null
  sessionId: string
}): OpsAlertDraft {
  const ref = input.displayId?.trim() || input.bookingId
  return {
    title: 'Checkout completed at Stripe, booking still reads awaiting payment',
    lines: [
      {
        message: `Stripe reports checkout session ${input.sessionId} for booking ${ref} as COMPLETE, but the booking record still says the deposit is not paid.`,
        action: 'Open this session in Stripe and check whether a $49 authorization exists before anyone asks the customer to pay again.',
      },
      {
        message: 'This booking was NOT cancelled and its truck is still held — nothing here has captured, released or refunded anything.',
      },
    ],
  }
}

/** A CANCELLED booking that still carries a session Stripe considers payable
 *  or complete. Nothing in this system can consume a payment on a cancelled
 *  booking, so this is the shape that would strand $49. */
export function cancelledWithLiveSessionAlert(input: {
  bookingId: string
  displayId?: string | null
  sessionId: string
  /** 'authorized' — Stripe says COMPLETE; 'open' — still payable. */
  verdict: 'authorized' | 'open'
  /** Only ever set from a Stripe call that actually succeeded. */
  expired: 'yes' | 'unknown' | 'not-attempted'
}): OpsAlertDraft {
  const ref = input.displayId?.trim() || input.bookingId
  const lines: AlertLine[] = [
    input.verdict === 'authorized'
      ? {
          message: `Booking ${ref} is CANCELLED, but Stripe reports its checkout session ${input.sessionId} as COMPLETE — an authorization may exist on a booking nothing in this system can capture or release.`,
          action: 'Open the session in Stripe and decide whether to release or capture it by hand.',
        }
      : {
          message: `Booking ${ref} is CANCELLED, but its checkout session ${input.sessionId} was still payable.`,
          action: 'Confirm in Stripe that nobody paid it.',
        },
  ]
  if (input.expired === 'yes') {
    lines.push({ message: 'Stripe accepted a request to expire that session, so it can no longer be paid.' })
  } else if (input.expired === 'unknown') {
    lines.push({
      message: 'It is NOT known whether that session is still payable — Stripe did not confirm the expiry.',
      action: 'Expire it by hand in the Stripe dashboard if it is still open.',
    })
  }
  return { title: 'Cancelled booking still carries a Stripe checkout session', lines }
}

// ── The periodic REPORT ─────────────────────────────────────────────────────

/** How far back the report looks for recently-cancelled bookings that might
 *  still carry a payable session. Bounded so a growing CANCELLED archive never
 *  makes this scan grow with it. */
export const CANCELLED_LOOKBACK_MS = 7 * 24 * HOUR_MS

/** Bounded batch — a pass with nothing to do is one indexed query. */
export const STALE_SWEEP_BATCH = 50

/** One stale unpaid hold, as the owner needs to see it. */
export type StaleHoldFinding = {
  bookingId: string
  displayId: string | null
  sessionId: string
  truckId: string | null
  ageHours: number
}

export type StaleCheckoutReport = {
  scanned: number
  /** Unpaid holds whose recorded session Stripe reports dead. NOT cancelled —
   *  listed, so the owner can decide. */
  staleHolds: number
  /** Sessions Stripe still considers payable: the customer may be paying. */
  stillPayable: number
  /** Sessions Stripe reports COMPLETE: alerted, NEVER cancelled. */
  authorized: number
  /** Payable sessions on ALREADY-CANCELLED bookings, expired by this pass. */
  retired: number
  /** Stripe could not answer: nothing concluded, nothing changed. */
  unreadable: number
  /** No recorded session id, or the row needed nothing said about it. */
  skipped: number
  /** The stale holds themselves, for the log line and the owner. */
  findings: StaleHoldFinding[]
  /** THE D1 INVARIANT, in the report itself: this pass cancelled nothing. It is
   *  a constant because there is no code path that could make it anything else. */
  cancelled: 0
}

/**
 * The periodic reconciliation for MISSED `checkout.session.expired` webhooks.
 *
 * IT IS A REPORT. It reads bookings, asks Stripe what their recorded sessions
 * are, and returns findings. It NEVER changes a booking — not on age, not on a
 * Stripe verdict, not on both. (The B6 version cancelled here, and that is the
 * path D1 removed: it applied no mid-payment guard at all, so a booking whose
 * customer was being redirected into a fresh session was cancelled while they
 * paid.)
 *
 * The ONE Stripe mutation it still performs is `expireSession` on a booking a
 * HUMAN already cancelled, which cannot cancel anything and is the only thing
 * standing between a cancelled booking and a $49 authorization nothing in this
 * system could capture or release.
 *
 * Fails soft per row: one unreadable session never costs the rest of the batch.
 */
export async function reportStaleCheckouts(
  deps: CheckoutExpiryDeps = defaultCheckoutExpiryDeps(),
  opts: { graceMs?: number; limit?: number; cancelledLookbackMs?: number } = {},
): Promise<StaleCheckoutReport> {
  const now = deps.now()
  const graceMs = opts.graceMs ?? staleHoldGraceMs()
  const report: StaleCheckoutReport = {
    scanned: 0,
    staleHolds: 0,
    stillPayable: 0,
    authorized: 0,
    retired: 0,
    unreadable: 0,
    skipped: 0,
    findings: [],
    cancelled: 0,
  }

  const rows = await deps.findStaleCheckouts({
    staleBefore: new Date(now - graceMs),
    cancelledSince: new Date(now - (opts.cancelledLookbackMs ?? CANCELLED_LOOKBACK_MS)),
    limit: opts.limit ?? STALE_SWEEP_BATCH,
  })
  report.scanned = rows.length

  for (const row of rows) {
    const sessionId = row.stripeCheckoutId?.trim()
    if (!sessionId) {
      report.skipped += 1
      continue
    }

    let snapshot: ExpirySessionSnapshot | null
    try {
      snapshot = await deps.retrieveSession(sessionId)
    } catch (err) {
      report.unreadable += 1
      deps.log.warn(
        { bookingId: row.id, sessionId, err: err instanceof Error ? err.message : String(err) },
        'stale-checkout report: Stripe could not be asked about this session — nothing concluded, nothing changed',
      )
      continue
    }

    // ONE classification for the whole codebase (checkout-session.ts). A manual
    // -capture session stays `payment_status: unpaid` after the customer
    // authorizes, so `status: 'complete'` is what proves a card was charged-in-
    // waiting — keying on payment_status would miss exactly the money case.
    const verdict = previousSessionVerdict(snapshot)

    if (row.status === 'CANCELLED') {
      if (verdict === 'none' || verdict === 'gone') {
        report.skipped += 1
        continue
      }
      let expired: 'yes' | 'unknown' | 'not-attempted' = 'not-attempted'
      if (verdict === 'open') {
        try {
          await deps.expireSession(sessionId)
          expired = 'yes'
          report.retired += 1
        } catch {
          expired = 'unknown'
          report.unreadable += 1
        }
      } else {
        report.authorized += 1
      }
      const alert = cancelledWithLiveSessionAlert({
        bookingId: row.id,
        displayId: row.displayId,
        sessionId,
        verdict: verdict === 'authorized' ? 'authorized' : 'open',
        expired,
      })
      await deps.alert(alert.title, alert.lines).catch(() => undefined)
      continue
    }

    // PENDING_PAYMENT from here down.
    if (verdict === 'authorized') {
      // A LOST checkout.session.completed: the money side is the opposite of
      // abandoned. Tell a human; touch nothing.
      report.authorized += 1
      const alert = authorizedButUnpaidAlert({ bookingId: row.id, displayId: row.displayId, sessionId })
      await deps.alert(alert.title, alert.lines).catch(() => undefined)
      continue
    }
    if (verdict !== 'gone') {
      // 'open' — still payable — or 'none'. Either way a customer may be on
      // that checkout page right now, and it is not even worth listing.
      report.stillPayable += 1
      continue
    }

    // A stale hold: Stripe says the recorded session is dead and the booking
    // still reads unpaid. THE ONLY THING THAT HAPPENS IS THAT IT GOES ON A LIST.
    report.staleHolds += 1
    report.findings.push({
      bookingId: row.id,
      displayId: row.displayId,
      sessionId,
      truckId: row.truckId,
      ageHours: Math.round((now - row.createdAt.getTime()) / HOUR_MS),
    })
  }

  deps.log.info(
    { ...report, findings: report.findings.length, graceHours: graceMs / HOUR_MS },
    'stale-checkout report complete (nothing was cancelled — the owner releases holds from the booking page)',
  )
  return report
}

// ── THE OWNER ACTION: release one truck hold, deliberately ──────────────────

/** What Stripe said about the recorded session when the owner asked. */
export type OwnerSessionVerdict =
  /** Stripe says the session is expired — the ordinary case. */
  | 'expired'
  /** Still payable: the customer could be on the checkout page right now. */
  | 'payable'
  /** Stripe says COMPLETE: money may exist. Never releasable here. */
  | 'authorized'
  /** No session recorded on the booking at all. */
  | 'none'
  /** Stripe could not be asked. "Cannot tell" is not "expired". */
  | 'unreadable'

export type ReleaseHoldRefusalCode =
  | 'not_found'
  | 'forbidden'
  | 'not_an_unpaid_hold'
  | 'deposit_paid'
  | 'payment_authorized'
  | 'session_authorized'
  | 'needs_acknowledgement'
  | 'raced'

/** Did this call get the Stripe checkout session retired? Only ever set from a
 *  call that actually happened. */
export type SessionRetirement = 'yes' | 'unknown' | 'not-attempted'

export type ReleaseHoldResult =
  | {
      ok: true
      outcome: 'released' | 'already_released'
      bookingId: string
      truckId: string | null
      sessionVerdict: OwnerSessionVerdict
      message: string
      /** C4 — what the shared lifecycle service did with the job, the crew and
       *  the journeys. Absent only if the aftermath was never attempted. */
      aftermath?: ReleaseAftermath
      /** C4 — whether the still-payable session was expired at Stripe. */
      sessionRetired?: SessionRetirement
    }
  | {
      ok: false
      code: ReleaseHoldRefusalCode
      message: string
      /** True when the owner may proceed by confirming the named risk. */
      needsAcknowledgement?: boolean
      sessionVerdict?: OwnerSessionVerdict
    }

/** PURE: given what Stripe said, may this release proceed, and what must the
 *  owner have confirmed first? Split out so the policy is testable without a
 *  database. */
export function releaseGate(
  verdict: OwnerSessionVerdict,
  acknowledged: boolean,
): { allow: true } | { allow: false; code: 'session_authorized' | 'needs_acknowledgement'; message: string } {
  if (verdict === 'authorized') {
    return {
      allow: false,
      code: 'session_authorized',
      message:
        'Stripe reports this booking\'s checkout session as COMPLETE, so a $49 authorization may exist on the customer\'s ' +
        'card. Releasing the truck here would leave that authorization on a booking nothing in this system can capture or ' +
        'release. Open the session in Stripe first.',
    }
  }
  if (verdict === 'payable' && !acknowledged) {
    return {
      allow: false,
      code: 'needs_acknowledgement',
      message:
        'Stripe says this booking\'s checkout session is still payable — the customer may be on the payment page right now. ' +
        'Releasing the truck cancels the booking, and a cancelled booking cannot be un-cancelled. Confirm to proceed anyway.',
    }
  }
  if (verdict === 'unreadable' && !acknowledged) {
    return {
      allow: false,
      code: 'needs_acknowledgement',
      message:
        'Stripe could not be reached, so it is not known whether this booking\'s checkout session is still payable. ' +
        'Releasing the truck cancels the booking, and a cancelled booking cannot be un-cancelled. Confirm to proceed anyway.',
    }
  }
  return { allow: true }
}

/**
 * PURE: what the owner is told, built ONLY from what each half actually did.
 *
 * The base sentences are the shipped ones, unchanged — they state the state
 * change this code performed and explicitly claim nothing about the customer's
 * card, because this path never asks Stripe to capture, release or refund one.
 * Everything appended is a fact with a number or a flag behind it:
 *   • crew/job — only when the writer reported rows it changed;
 *   • a FAILED job/crew half — named as a failure with the hand-work it leaves;
 *   • the journey stop — mentioned ONLY when it failed (a silent success is not
 *     a claim, and "we stopped your emails" is not something to state loosely);
 *   • the session — only 'yes' says it can no longer be paid; 'unknown' says
 *     exactly that and sends the owner to Stripe.
 */
export function releaseHoldMessage(
  outcome: 'released' | 'already_released',
  after: ReleaseAftermath | null,
  sessionRetired: SessionRetirement = 'not-attempted',
): string {
  const parts: string[] = [
    outcome === 'released'
      ? 'Booking cancelled, so it no longer holds its truck. No card was charged, held or released by this — ' +
        'a cancelled booking cannot be un-cancelled.'
      : 'This booking is already cancelled, so it no longer holds a truck.',
  ]

  const crewParts: string[] = []
  if (after?.jobCancelled) crewParts.push('its job was cancelled')
  if (after && after.crewCancelled > 0) {
    crewParts.push(`${after.crewCancelled} crew assignment${after.crewCancelled === 1 ? ' was' : 's were'} cancelled`)
  }
  if (crewParts.length) parts.push(`${crewParts.join(' and ')}.`)
  else if (outcome === 'already_released' && !after?.jobCancelFailed) parts.push('Nothing was changed.')

  if (after?.jobCancelFailed) {
    parts.push(
      'Its job and crew assignments could NOT be cancelled — cancel them by hand, or more crew can still be assigned to this move.',
    )
  }
  if (after?.journeys && after.journeys !== 'ok') {
    parts.push('Its scheduled emails could not be confirmed stopped — check the booking before it gets another one.')
  }

  if (sessionRetired === 'yes') {
    parts.push('Its Stripe checkout session was expired, so it can no longer be paid.')
  } else if (sessionRetired === 'unknown') {
    parts.push('Stripe did NOT confirm that its checkout session was expired — expire it by hand if it is still payable.')
  }

  return parts.join(' ')
}

/**
 * THE ONLY PATH IN THIS SYSTEM THAT ENDS AN UNPAID HOLD, and it needs a person.
 *
 * Permission-gated (`booking.decline` — the same right that ends any
 * pre-capture booking), audited in the same transaction as the state change,
 * and refused outright when Stripe says money may exist. The caller is
 * app/api/admin/bookings/[id]/release-hold/route.ts, reached from a button on
 * the booking page, so the owner is looking at the booking when they decide.
 *
 * It is deliberately NOT idempotent-by-replay in the "do it again" sense: a
 * second call on an already-CANCELLED booking reports `already_released` and
 * writes nothing.
 */
export async function releaseTruckHoldByOwner(
  input: {
    bookingId: string
    actor: { userId?: string | null; name: string; role?: Role | string | null }
    /** The owner has been shown the risk named by `releaseGate` and confirmed. */
    acknowledgeRisk?: boolean
  },
  deps: CheckoutExpiryDeps = defaultCheckoutExpiryDeps(),
): Promise<ReleaseHoldResult> {
  const role = input.actor.role
  if (role && !can(role as Role, 'booking.decline')) {
    return { ok: false, code: 'forbidden', message: 'You do not have permission to release truck holds.' }
  }

  const row = await deps.readHold(input.bookingId)
  if (!row) return { ok: false, code: 'not_found', message: 'Booking not found.' }

  if (row.status === 'CANCELLED') {
    // C4 — a replay still FINISHES the half a previous pass may not have got
    // to. Both are conditional and idempotent: a job and crew that are already
    // cancelled match zero rows and write no audit, so this stays "nothing was
    // changed" in the ordinary case and says what it did in the rare one where
    // a release (or a decline) left live crew behind.
    const after = await finish(row, input.actor, deps)
    return {
      ok: true,
      outcome: 'already_released',
      bookingId: row.id,
      truckId: row.truckId,
      sessionVerdict: 'none',
      message: releaseHoldMessage('already_released', after),
      aftermath: after,
    }
  }
  if (row.depositPaid) {
    return {
      ok: false,
      code: 'deposit_paid',
      message: 'This booking\'s deposit is recorded as paid. Use decline or refund — not the truck-hold release.',
    }
  }
  if (row.status !== 'PENDING_PAYMENT') {
    return {
      ok: false,
      code: 'not_an_unpaid_hold',
      message: `This booking is ${row.status.replace(/_/g, ' ').toLowerCase()}, not an unpaid checkout hold.`,
    }
  }
  if (row.stripePaymentIntentId) {
    return {
      ok: false,
      code: 'payment_authorized',
      message:
        'This booking already has a Stripe payment intent, so a card may be authorized for it. That is the decline/refund ' +
        'path, not the truck-hold release.',
    }
  }

  // What does Stripe say about the session the booking carries? The owner sees
  // this before they decide, and it is recorded with their decision.
  let sessionVerdict: OwnerSessionVerdict = 'none'
  const sessionId = row.stripeCheckoutId?.trim() || null
  if (sessionId) {
    try {
      const snapshot = await deps.retrieveSession(sessionId)
      const v = previousSessionVerdict(snapshot)
      sessionVerdict = v === 'gone' ? 'expired' : v === 'authorized' ? 'authorized' : v === 'open' ? 'payable' : 'none'
    } catch (err) {
      sessionVerdict = 'unreadable'
      deps.log.warn(
        { bookingId: row.id, sessionId, err: err instanceof Error ? err.message : String(err) },
        'release truck hold: Stripe could not be asked about the recorded session',
      )
    }
  }

  const gate = releaseGate(sessionVerdict, input.acknowledgeRisk === true)
  if (!gate.allow) {
    return {
      ok: false,
      code: gate.code,
      message: gate.message,
      needsAcknowledgement: gate.code === 'needs_acknowledgement',
      sessionVerdict,
    }
  }

  const count = await deps.releaseTruckHold({
    bookingId: row.id,
    actorUserId: input.actor.userId ?? null,
    actorName: input.actor.name,
    sessionId,
    sessionVerdict,
    acknowledgedRisk: input.acknowledgeRisk === true,
  })

  if (count === 0) {
    // The conditional statement refused. Say so honestly rather than reporting
    // a release nobody performed.
    return {
      ok: false,
      code: 'raced',
      message: 'This booking changed while you were looking at it — reload it and check before trying again.',
      sessionVerdict,
    }
  }

  // ── C4-a: THE SESSION THE BOOKING CAN NO LONGER CONSUME ──────────────────
  // The two acknowledgeable verdicts are exactly the two that leave a session
  // Stripe may still take money on: 'payable' (Stripe said open) and
  // 'unreadable' (Stripe could not be asked). The booking is CANCELLED now, and
  // fulfilment's atomic claim matches only PENDING_PAYMENT/DRAFT — so a payment
  // completed on that session lands on a booking NOTHING in this system can
  // capture, release or refund. Retiring it is the same call `reportStale-
  // Checkouts` already makes for a cancelled booking with a live session; it is
  // made HERE, at the moment of cancellation, instead of up to a sweep later.
  //
  // AFTER the claim, never before: expiring the session of a booking whose
  // release then loses its race would kill a live checkout for a booking that
  // stayed PENDING_PAYMENT.
  let sessionRetired: SessionRetirement = 'not-attempted'
  if (sessionId && (sessionVerdict === 'payable' || sessionVerdict === 'unreadable')) {
    try {
      await deps.expireSession(sessionId)
      sessionRetired = 'yes'
    } catch (err) {
      sessionRetired = 'unknown'
      deps.log.warn(
        { bookingId: row.id, sessionId, err: err instanceof Error ? err.message : String(err) },
        'release truck hold: the checkout session could not be expired — it may still be payable on a cancelled booking',
      )
    }
  }

  // ── C4-b: THE HALF BOTH OTHER CANCELLATION PATHS PERFORM ─────────────────
  const after = await finish(row, input.actor, deps)

  deps.log.warn(
    {
      bookingId: row.id,
      displayId: row.displayId,
      truckId: row.truckId,
      sessionId,
      sessionVerdict,
      sessionRetired,
      releasedBy: input.actor.name,
      truckHoldReleased: !holdsTruck('CANCELLED'),
      jobCancelled: after.jobCancelled,
      crewCancelled: after.crewCancelled,
      jobCancelFailed: after.jobCancelFailed ?? null,
      journeys: after.journeys,
    },
    'truck hold released by the owner — booking CANCELLED (no money was captured, held or released by this)',
  )

  return {
    ok: true,
    outcome: 'released',
    bookingId: row.id,
    truckId: row.truckId,
    sessionVerdict,
    message: releaseHoldMessage('released', after, sessionRetired),
    aftermath: after,
    sessionRetired,
  }
}

/** Run the shared lifecycle half and never let it break the release that has
 *  already committed. A cancellation whose job/crew step throws is still a
 *  cancellation — but it is reported as a FAILURE, never as a quiet zero. */
async function finish(
  row: StaleCheckoutRow,
  actor: { userId?: string | null; name: string },
  deps: CheckoutExpiryDeps,
): Promise<ReleaseAftermath> {
  try {
    return await deps.finishCancellation({
      bookingId: row.id,
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
      reason: 'Truck hold released by owner',
    })
  } catch (err) {
    const failed = err instanceof Error ? err.message : String(err)
    deps.log.error(
      { bookingId: row.id, err: failed },
      'release truck hold: the job/crew + journey half threw — the booking IS cancelled, that half is still owed',
    )
    return { jobCancelled: false, crewCancelled: 0, jobCancelFailed: failed, journeys: 'not-run' }
  }
}
