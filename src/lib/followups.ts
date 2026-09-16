// ════════════════════════════════════════════════════════════════════════
//  followups.ts — Phase 3 post-move customer follow-up automation (moving jobs).
//  ----------------------------------------------------------------------
//  DeepSeek-designed, reconciled for frequency-cap consistency. ALL follow-ups
//  are gated on job COMPLETION (never on the $49 payment) under the existing-
//  business-relationship TCPA basis. Sequence (quiet-hours-shifted at schedule):
//
//    review-request   completion + 2h
//    review-reminder  completion + 48h   (skipped if a review already exists)
//    referral-ask     completion + 5d    (fallback) OR positive-review + 24h —
//                     SAME ledger type, so the customer gets at most ONE
//    repeat-reminder  completion + 30d   (re-engagement, not minutes after a move)
//
//  Anti-spam guarantees:
//    • exactly-once  — FollowUpLedger @@unique([bookingId,type]); a row is
//                      claimed BEFORE sending, so retries/double-triggers no-op.
//    • opt-out       — Customer.marketingOptOut (set by the STOP webhook).
//    • quiet hours   — only 08:00–20:59 America/New_York; jobs are shifted into
//                      the window at schedule time and re-deferred at send time.
//    • frequency cap — ≤1 follow-up / 24h and ≤4 / 30d per customer (safety net).
//
//  Everything is gated by MARKETING_FOLLOWUPS_ENABLED (default OFF). Follow-ups
//  are EMAIL ONLY: Move It Clear It no longer sends SMS (owner, 2026-09-15), so
//  the SMS channel is recorded 'not_applicable' and nothing is ever texted.
//  Every email goes through the shared send guard — a Redis/Resend hiccup is
//  logged, never fatal.
// ════════════════════════════════════════════════════════════════════════
import * as React from 'react'
import { render } from '@react-email/render'
import { prisma } from './db'
import { scheduledQueue } from './queues'
import { queueLogger } from './logger'
import { guardedSend, type SendOutcome } from './email-guard'
import { isSafeUrl } from '../emails/validation'
import { unsubscribeUrl } from './email-tokens'
import { checkReferralEligibility } from './referral-eligibility'
import { bookingEligibility, bookingMarketingBlockReason, promotionalConsentBlockReason } from './email-eligibility'
import { buildMarketingContext, applyMarketingContext } from './marketing-context'
import { normalizeLocale, BIZ_NAME, BIZ_PHONE, type Locale } from './i18n'
import ReviewRequestEmail from '../emails/review-request'
import ReferralEmail from '../emails/referral'
import QuoteFollowupEmail from '../emails/quote-followup'
import { C } from '../emails/_ui'
import {
  defaultRetryStore,
  emptySummary,
  enqueueDurable,
  logScheduleSummary,
  retryWindowFor,
  tally,
  type EnqueueResult,
  type QueueLike,
  type RetryStore,
  type ScheduleSummary,
} from './lifecycle-enqueue'

const log = queueLogger.child({ mod: 'followups' })

export const FOLLOWUPS_ENABLED = process.env.MARKETING_FOLLOWUPS_ENABLED === 'true'

// Links used in the copy.
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL?.trim() || ''
const BOOK_URL = (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
const REFERRAL_URL = process.env.REFERRAL_URL?.trim() || BOOK_URL
const REFERRAL_CODE = process.env.REFERRAL_CODE?.trim() || 'REFER15'
// NO FALLBACK (finding EMAIL-P1-15). This used to return BOOK_URL when
// GOOGLE_REVIEW_URL was unset, so a "leave us a review" email sent the customer
// to the booking form — a confusing, useless message that still counted as a
// successful send. An unconfigured review destination now yields null, and the
// caller SKIPS the send and records a configuration error.
const reviewUrl = (): string | null => (isSafeUrl(GOOGLE_REVIEW_URL) ? GOOGLE_REVIEW_URL : null)

// Quiet hours (America/New_York): send only when 08:00 <= hour < 21:00.
const QUIET_END = 8 // first allowed hour
const QUIET_START = 21 // 9pm — first disallowed hour

// Frequency caps (safety nets; the schedule already spaces sends > 24h apart).
const CAP_BURST_HOURS = 24
const CAP_BURST_MAX = 1 // <=1 follow-up per 24h per customer
const CAP_WINDOW_DAYS = 30
const CAP_WINDOW_MAX = 4 // <=4 follow-ups per 30d per customer

/**
 * Render html + text from ONE props object and hand the props back, so the send
 * guard validates exactly what shipped rather than an approximation
 * (finding EMAIL-P1-11). Text is required for deliverability + accessibility;
 * the follow-up path used to send HTML only.
 */
function renderWithPayload(
  Component: (p: never) => React.ReactElement,
  payload: Record<string, unknown>
): { html: string; text: string; payload: Record<string, unknown> } {
  const el = Component(payload as never)
  return { html: render(el), text: render(el, { plainText: true }), payload }
}

export type FollowupType = 'review-request' | 'review-reminder' | 'repeat-reminder' | 'referral-ask'

/** Follow-up type → the template name the send guard classifies + records. */
const EMAIL_TEMPLATE: Record<FollowupType, string> = {
  'review-request': 'review-request',
  'review-reminder': 'review-reminder',
  'repeat-reminder': 'repeat-reminder',
  'referral-ask': 'referral',
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

// Delays from completion. referral-ask here is the FALLBACK; a positive review
// schedules its own referral-ask +24h, deduped by the ledger's unique key.
export const COMPLETION_DELAYS: Array<{ type: FollowupType; delay: number }> = [
  { type: 'review-request', delay: 2 * HOUR },
  { type: 'review-reminder', delay: 48 * HOUR },
  { type: 'referral-ask', delay: 5 * DAY },
  { type: 'repeat-reminder', delay: 30 * DAY },
]

// ── quiet-hours helpers (DST-safe via Intl, host-timezone-independent) ──
function etHour(d: Date): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(d)
  return parseInt(s, 10) || 0
}

function inQuietHours(d: Date): boolean {
  const h = etHour(d)
  return h < QUIET_END || h >= QUIET_START
}

/** Walk a fire time forward in 1h steps until it lands in the allowed window.
 *  Exported so the lifecycle retry sweep re-applies EXACTLY this shift. */
export function shiftIntoAllowedHours(target: Date): Date {
  const t = new Date(target.getTime())
  for (let i = 0; i < 48 && inQuietHours(t); i++) {
    t.setTime(t.getTime() + HOUR)
  }
  return t
}

function msUntilAllowed(now = new Date()): number {
  return inQuietHours(now) ? shiftIntoAllowedHours(now).getTime() - now.getTime() : 0
}

// ── DURABLE queue add (production reliability release 2026-09-15) ───────
//  The add is still time-boxed so a Redis stall cannot hang the caller, but a
//  failure is no longer swallowed into a "non-fatal" warn: the exact job is
//  recorded in lifecycle_enqueue_retries and the hourly lifecycle-repair sweep
//  re-adds it under the same id (see lifecycle-enqueue.ts). runFollowup re-runs
//  every gate when it fires, and the ledger claim stops a double send.

/** The queue + retry-store edge, injectable so the failure path is testable. */
export type FollowupQueueEdge = { queue?: QueueLike; store?: RetryStore; now?: () => Date }

async function addScheduled(
  type: FollowupType,
  bookingId: string,
  fireAt: Date,
  jobId: string,
  edge: FollowupQueueEdge = {}
): Promise<EnqueueResult> {
  // Every FollowupType has a policy entry (lifecycle-enqueue STAGE_POLICY).
  const window = retryWindowFor(type, fireAt)
  return enqueueDurable(
    {
      queue: edge.queue ?? scheduledQueue,
      name: type,
      data: { type, bookingId },
      jobId,
      fireAt,
      notAfter: window ? window.notAfter : fireAt,
      path: 'post-job-followup',
      subjectType: 'booking',
      subjectId: bookingId,
    },
    { store: edge.store ?? defaultRetryStore(), now: edge.now, shift: shiftIntoAllowedHours }
  )
}

/** Schedule one follow-up stage. Quiet-hours-shifted; never throws. */
export async function enqueueFollowupJob(
  bookingId: string,
  type: FollowupType,
  fireAt: Date,
  edge: FollowupQueueEdge = {}
): Promise<EnqueueResult> {
  // Stable jobId => a second completion trigger can't create a duplicate job.
  return addScheduled(type, bookingId, fireAt, `followup__${type}__${bookingId}`, edge)
}

// ── public: schedule the post-completion sequence ───────────────────────
/** The effects onBookingCompleted has on the world, injectable for tests. */
export type FollowupScheduleDeps = {
  now(): Date
  stampCompleted(bookingId: string): Promise<void>
  marketingBlock(bookingId: string): Promise<string | null>
  edge: FollowupQueueEdge
}

export function defaultFollowupScheduleDeps(): FollowupScheduleDeps {
  return {
    now: () => new Date(),
    async stampCompleted(bookingId) {
      // First completion wins — never reset the anchor time on a re-trigger.
      await prisma.booking
        .updateMany({ where: { id: bookingId, completedAt: null }, data: { completedAt: new Date() } })
        .catch((err) => log.warn({ err: String(err), bookingId }, 'stamp completedAt failed (non-fatal)'))
    },
    marketingBlock: bookingMarketingBlockReason,
    edge: {},
  }
}

/** Stamp completedAt (once) and schedule the follow-up sequence. Idempotent:
 *  stable jobIds dedupe at the queue and the ledger dedupes the actual sends.
 *  Returns what actually happened to the stages (null = nothing attempted). */
export async function onBookingCompleted(
  bookingId: string,
  deps: FollowupScheduleDeps = defaultFollowupScheduleDeps()
): Promise<ScheduleSummary | null> {
  await deps.stampCompleted(bookingId)

  if (!FOLLOWUPS_ENABLED) {
    log.info({ bookingId }, 'MARKETING_FOLLOWUPS_ENABLED!=true — not scheduling follow-ups')
    return null
  }

  // PROMOTIONAL CONSENT (owner spec 2026-08-06). Every stage of this sequence —
  // review request, review reminder, referral ask, repeat reminder — is
  // classified PROMOTIONAL by email-guard, so none of them may go to somebody
  // who never opted in. bookingEligibility refuses them at send time; refusing
  // here means four doomed jobs never occupy the queue, and the owner sees the
  // reason when the job is marked complete rather than 30 days later.
  //
  // The stamp of `completedAt` above deliberately happens FIRST and
  // unconditionally: completion is a fact about the job, not about marketing.
  const consentBlock = await deps.marketingBlock(bookingId)
  if (consentBlock) {
    log.info({ bookingId, reason: consentBlock }, 'no promotional consent — post-move follow-ups not scheduled')
    return null
  }

  const now = deps.now().getTime()
  // Enqueue in parallel (each self-guarded) so a Redis stall bounds the caller
  // to ~5s, not 4×5s — the admin "mark complete" request awaits this.
  const results = await Promise.all(
    COMPLETION_DELAYS.map(({ type, delay }) =>
      enqueueFollowupJob(bookingId, type, new Date(now + delay), { now: deps.now, ...deps.edge })
    )
  )
  // "scheduled" only when all four were (2026-09-15).
  const summary = results.reduce<ScheduleSummary>((acc, r) => tally(acc, r.status), emptySummary())
  logScheduleSummary(log, { bookingId }, 'completion follow-ups', summary)
  return summary
}

// ── public: record a review; a positive one triggers ONE referral ask ───
export async function recordReviewAndMaybeReferral(input: {
  bookingId: string
  rating: number
  source?: string
  comment?: string
}): Promise<{ id: string; rating: number; isPositive: boolean }> {
  const rating = Math.max(1, Math.min(5, Math.round(input.rating)))
  const isPositive = rating >= 4
  const review = await prisma.review.upsert({
    where: { bookingId: input.bookingId },
    update: { rating, isPositive, comment: input.comment ?? null, source: input.source ?? 'admin' },
    create: { bookingId: input.bookingId, rating, isPositive, comment: input.comment ?? null, source: input.source ?? 'admin' },
  })
  if (isPositive && FOLLOWUPS_ENABLED) {
    // Referral eligibility is enforced TWICE — here at schedule time (so an
    // ineligible booking never even occupies a queue slot) and again inside
    // runFollowup immediately before the send, because the booking can be
    // refunded or cancelled in the 24h between.
    const eligibility = await checkReferralEligibility(input.bookingId)
    if (eligibility.eligible) {
      // Space the ask 24h after the review; shares the 'referral-ask' ledger type,
      // so the day-5 fallback won't also fire (at most one referral per booking).
      const r = await enqueueFollowupJob(input.bookingId, 'referral-ask', new Date(Date.now() + DAY))
      logScheduleSummary(log, { bookingId: input.bookingId }, 'positive-review referral ask', tally(emptySummary(), r.status))
    } else {
      log.info({ bookingId: input.bookingId, reason: eligibility.reason }, 'positive review, but referral not eligible')
    }
  }
  return { id: review.id, rating, isPositive }
}

// ── frequency caps ──────────────────────────────────────────────────────
/**
 * PURE: the ledger rows that count against a customer's follow-up budget.
 *
 * DEFECT FIXED (2026-09-15): this counted `status: 'sent'` — a value the
 * ledger stopped writing in migration 20260720040000 (it became 'delivered',
 * and the CHECK constraint now rejects 'sent'). Both counts were always 0 and
 * the cap never fired. It also anchored on `sentAt`, which is set at CLAIM
 * time. A follow-up counts once it actually shipped (`deliveredAt`), and the
 * follow-up being evaluated never caps itself on a resume.
 */
export function followupCapWhere(customerId: string, since: Date, self: { bookingId: string; type: FollowupType }) {
  return {
    deliveredAt: { gte: since },
    booking: { customerId },
    NOT: { bookingId: self.bookingId, type: self.type },
  }
}

async function withinFrequencyCaps(customerId: string, self: { bookingId: string; type: FollowupType }): Promise<boolean> {
  const now = Date.now()
  const [burst, windowCount] = await Promise.all([
    prisma.followUpLedger.count({ where: followupCapWhere(customerId, new Date(now - CAP_BURST_HOURS * HOUR), self) }),
    prisma.followUpLedger.count({ where: followupCapWhere(customerId, new Date(now - CAP_WINDOW_DAYS * DAY), self) }),
  ])
  return burst < CAP_BURST_MAX && windowCount < CAP_WINDOW_MAX
}

async function recordSkip(bookingId: string, type: FollowupType, reason: string): Promise<string> {
  await prisma.followUpLedger
    .upsert({
      where: { bookingId_type: { bookingId, type } },
      update: {}, // already recorded (delivered/skipped) — leave as-is
      create: { bookingId, type, channel: 'email', status: 'skipped', error: reason },
    })
    .catch((err) => log.warn({ err: String(err), bookingId, type }, 'record skip failed'))
  // A row left RETRYABLE by an earlier attempt must be closed when a resume is
  // refused for good, or the retry sweep would re-read it forever.
  await prisma.followUpLedger
    .updateMany({
      where: { bookingId, type, status: { in: ['claimed', 'failed_retryable', 'partially_delivered'] } },
      data: { status: 'skipped', terminalReason: reason.slice(0, 500), nextAttemptAt: null },
    })
    .catch((err) => log.warn({ err: String(err), bookingId, type }, 'closing retryable follow-up failed'))
  log.info({ bookingId, type, reason }, 'follow-up skipped')
  return `skipped:${reason}`
}

/** PURE: the email channel status a guard outcome implies. */
export function followupEmailStatus(outcome: SendOutcome): { status: 'delivered' | 'failed' | 'not_applicable'; error?: string } {
  // 'duplicate' means this exact logical send was already delivered earlier.
  if (outcome.sent || outcome.reason === 'duplicate') return { status: 'delivered' }
  // Terminal refusals and AMBIGUOUS outcomes must never be retried: the first
  // can never succeed, the second may already have reached the customer.
  if (
    outcome.outcomeClass === 'terminal' ||
    outcome.outcomeClass === 'ambiguous' ||
    outcome.reason === 'ambiguous' ||
    outcome.reason === 'attempts_exhausted' ||
    outcome.reason.startsWith('terminal:')
  ) {
    return { status: 'not_applicable', error: `refused:${outcome.reason}`.slice(0, 500) }
  }
  return { status: 'failed', error: `refused by send guard: ${outcome.reason}`.slice(0, 500) }
}

/** Email attempts a follow-up may use before it is closed as failed_terminal. */
export const FOLLOWUP_MAX_EMAIL_ATTEMPTS = 5
/**
 * A retryable follow-up older than this is closed, never re-driven: a "how did
 * we do?" email weeks after the move is worse than none. Rows written before
 * 2026-09-15 had next_attempt_at set but nothing read it, so without this bound
 * the first sweep after deploy would have re-sent every old refusal at once.
 */
export const FOLLOWUP_RETRY_MAX_AGE_MS = 7 * 24 * HOUR

/**
 * PURE: when the guard said "LATER" rather than "failed" — a policy deferral
 * (caps, quiet hours, kill switch), a send not yet due, or a live claim — the
 * time to look again. Such an outcome must not consume a follow-up attempt:
 * a 24h cap retried hourly used to burn all five attempts in five hours and
 * strand the row. null = an ordinary failure (or not a refusal at all).
 */
export function followupDeferUntil(outcome: SendOutcome, now = Date.now()): Date | null {
  if (outcome.sent) return null
  if (outcome.reason === 'in_flight') return new Date(now + 15 * 60_000)
  if (outcome.outcomeClass === 'deferred' || outcome.reason === 'not_due') {
    const at = outcome.retryAt ?? outcome.notDueUntil
    return at && at.getTime() > now ? at : new Date(now + HOUR)
  }
  return null
}

/**
 * Re-drive follow-ups left RETRYABLE. `next_attempt_at` was written by
 * runFollowup but nothing ever read it, so a follow-up whose email failed
 * temporarily was stranded forever. Every gate runs again on the resume and the
 * email key dedupes at the guard. Bounded; called from the hourly
 * lifecycle-repair sweep.
 */
export async function retryDueFollowups(limit = 25): Promise<number> {
  if (!FOLLOWUPS_ENABLED) return 0
  const cutoff = new Date(Date.now() - FOLLOWUP_RETRY_MAX_AGE_MS)
  // Close stale retryable rows FIRST, so they are never re-driven.
  await prisma.followUpLedger
    .updateMany({
      where: { status: { in: ['failed_retryable', 'partially_delivered'] }, createdAt: { lt: cutoff } },
      data: { status: 'failed_terminal', terminalReason: 'stale:retry-window-expired', nextAttemptAt: null },
    })
    .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, 'closing stale follow-ups failed'))
  const due = await prisma.followUpLedger.findMany({
    where: {
      status: { in: ['failed_retryable', 'partially_delivered'] },
      nextAttemptAt: { lte: new Date() },
      emailAttempts: { lt: FOLLOWUP_MAX_EMAIL_ATTEMPTS },
      createdAt: { gte: cutoff },
    },
    select: { bookingId: true, type: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  })
  for (const r of due) {
    await runFollowup(r.bookingId, r.type as FollowupType).catch((err) =>
      log.warn({ err: err instanceof Error ? err.message : String(err), bookingId: r.bookingId, type: r.type }, 'follow-up retry failed')
    )
  }
  return due.length
}

// ── email (via the SHARED SEND GUARD — src/lib/email-guard) ─────────────
// BEFORE (gap audit 2026-07-17, G4): this called `resend.emails.send()`
// directly, so the follow-up path had NO suppression check, NO payload
// validation, and NO idempotency record. The ledger stopped a duplicate
// FOLLOW-UP, but nothing stopped a send to an address that had bounced or
// complained. Now every follow-up inherits the full gate.
//
// Returns true when the message actually went out.
async function sendEmail(opts: {
  to: string
  subject: string
  html: string
  text: string
  payload: Record<string, unknown>
  template: string
  bookingId: string
}): Promise<SendOutcome> {
  const outcome = await guardedSend({
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    // Plain-text multipart — the follow-up path used to send HTML only.
    text: opts.text,
    // The EXACT props that produced this HTML, so required-field and URL-safety
    // validation run on what actually shipped (finding EMAIL-P1-11).
    payload: opts.payload,
    // LIVE booking reload immediately before the claim — the same canonical
    // predicate the queue worker and the outbox use.
    recheck: () => bookingEligibility(opts.template, opts.bookingId),
    template: opts.template,
    emailClass: 'promotional',
    journey: 'post-job',
    // The booking IS the qualifying event — exactly one of each follow-up
    // per booking, forever, even if the ledger row is ever cleared.
    eventId: opts.bookingId,
    bookingId: opts.bookingId,
  })
  if (!outcome.sent) {
    log.info({ bookingId: opts.bookingId, template: opts.template, reason: outcome.reason }, 'follow-up email not sent')
  }
  return outcome
}

const esc = (s: string): string => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))

// The inline-HTML follow-up is GONE (findings EMAIL-P1-06 / EMAIL-P1-11).
// `emailHtml()`, its local BRAND palette and the `esc()` helper lived here to
// build `repeat-reminder` by hand. That put the one promotional email outside
// the shared marketing footer (so it carried no unsubscribe link and no postal
// address) and outside the render-based palette test (which is how a blue
// #1f6feb CTA survived in a four-colour brand). Every follow-up now renders
// through the shared _ui kit like every other email.

/** Returns null when the message CANNOT be built truthfully (missing config). */
function buildMessage(
  type: FollowupType,
  name: string,
  locale: Locale,
  /** Compliance block merged into the props BEFORE rendering (EMAIL-P1-06). */
  marketing: Record<string, unknown> = {}
): { subject: string; html: string; text: string; payload: Record<string, unknown> } | null {
  const es = locale === 'es'
  switch (type) {
    case 'review-request':
    case 'review-reminder': {
      // NO FALLBACK (finding EMAIL-P1-15). Without a verified review
      // destination there is no honest review email to send.
      const url = reviewUrl()
      if (!url) return null
      return {
        subject: es ? '¿Cómo lo hicimos? Deja tu reseña' : 'How did we do? Leave us a review',
        // Premium branded review email (shared _ui kit), matching the rest of the
        // transactional set. Replaces the old inline emailHtml() card.
        ...renderWithPayload(ReviewRequestEmail, {
          customerName: name,
          googleReviewUrl: url,
          locale,
          ...marketing,
        }),
      }
    }
    case 'repeat-reminder':
      return {
        // NO CLEANOUT / JUNK-REMOVAL COPY (finding EMAIL-P1-14). That service is
        // not enabled, so advertising it is an offer we cannot fulfil.
        subject: es ? '¿Otra mudanza?' : 'Moving again?',
        // SHARED KIT, not inline HTML (findings EMAIL-P1-06 / EMAIL-P1-11).
        // This was the ONE promotional email built as a hand-written HTML
        // string, so it sat outside the marketing footer entirely — no
        // unsubscribe link, no postal address — and outside the palette test,
        // which is how a blue CTA survived in a four-colour brand.
        // QuoteFollowup carries exactly the right shape: a short message and one
        // CTA back to booking, with the compliant MarketingFooter.
        ...renderWithPayload(QuoteFollowupEmail, {
          customerName: name,
          bookingUrl: BOOK_URL,
          stage: 3,
          locale,
          ...marketing,
        }),
      }
    case 'referral-ask':
      return {
        subject: es ? 'Da 15%. Recibe 15%.' : 'Give 15%. Get 15%.',
        // Premium branded referral email (shared _ui kit).
        ...renderWithPayload(ReferralEmail, {
          customerName: name,
          referralCode: REFERRAL_CODE,
          referralUrl: REFERRAL_URL,
          locale,
          ...marketing,
        }),
      }
  }
}

/**
 * The quiet-hours deferral re-add. It used to be `.catch(() => {})`: with no
 * ledger row claimed yet, a failed re-add completed the job "successfully" and
 * the follow-up was gone for good, with nothing recording it (2026-09-15).
 *
 *   scheduled           -> 'deferred-quiet-hours'
 *   recorded_for_retry  -> 'deferred-quiet-hours:recorded-for-retry' (the sweep re-adds it)
 *   lost                -> THROWS, so BullMQ's own retry runs this job again
 *                          (still no ledger row, so nothing is claimed twice)
 */
export async function deferFollowupForQuietHours(
  bookingId: string,
  type: FollowupType,
  waitMs: number,
  edge: FollowupQueueEdge = {}
): Promise<string> {
  const now = edge.now ? edge.now() : new Date()
  const r = await addScheduled(type, bookingId, new Date(now.getTime() + waitMs), `followup__${type}__${bookingId}__retry`, edge)
  if (r.status === 'scheduled') return 'deferred-quiet-hours'
  if (r.status === 'recorded_for_retry') {
    log.warn({ bookingId, type }, 'quiet-hours deferral NOT scheduled — recorded for retry by lifecycle-repair')
    return 'deferred-quiet-hours:recorded-for-retry'
  }
  throw new Error(`quiet-hours deferral for ${type} could not be enqueued or recorded (LIFECYCLE_ENQUEUE_LOST)`)
}

// ── public: process one follow-up (called by the scheduled worker) ──────
export async function runFollowup(bookingId: string, type: FollowupType): Promise<string> {
  if (!FOLLOWUPS_ENABLED) return 'disabled'

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true, review: true },
  })
  if (!booking || !booking.customer) return 'no-booking'
  const customer = booking.customer
  const locale = normalizeLocale(customer.locale)

  // Conditional skip: the 48h reminder is pointless once a review exists.
  if (type === 'review-reminder' && booking.review) return recordSkip(bookingId, type, 'review-exists')

  // ── STOP RULE: post-job mail requires the job to have actually happened ──
  // The whole sequence is scheduled at completion, but a booking can be
  // reopened, cancelled, or corrected in the days between. Recheck the CURRENT
  // status rather than trusting the scheduling-time decision.
  if (booking.status !== 'COMPLETED') return recordSkip(bookingId, type, `not-completed:${booking.status}`)

  // ── REFERRAL ELIGIBILITY (gap audit G1, severity HIGH) ──────────────────
  // Previously the referral ask fired on a day-5 timer or any 4★ review with NO
  // check on payment, refunds, receipt, or the program being switched on. A
  // cancelled or refunded job could ask the customer to refer their friends.
  // Full rule set + rationale: src/lib/referral-eligibility.ts.
  if (type === 'referral-ask') {
    const eligibility = await checkReferralEligibility(bookingId, {
      referralUrl: REFERRAL_URL,
      referralCode: REFERRAL_CODE,
    })
    if (!eligibility.eligible) return recordSkip(bookingId, type, `referral-ineligible:${eligibility.reason}`)
  }

  // ── PROMOTIONAL CONSENT (owner spec 2026-08-06) ─────────────────────────
  // Every follow-up in this file is sent with `emailClass: 'promotional'`, so
  // an explicit opt-in is required. This used to check `marketingOptOut`
  // ALONE — a flag written only by the inbound-SMS STOP webhook, and therefore
  // false for essentially every customer — which meant "not opted OUT" was
  // being treated as "opted IN". Tri-state consent is the real question and
  // both `false` and `null` refuse.
  //
  // The rule itself is not restated: promotionalConsentBlockReason is the same
  // predicate bookingEligibility applies at send time, and the ledger records
  // WHICH reason so the owner can tell "they said no" from "we never asked".
  const consentBlock = promotionalConsentBlockReason({
    status: booking.status,
    isInternalTest: booking.isInternalTest,
    depositPaid: booking.depositPaid,
    completedAt: booking.completedAt,
    requestedDate: booking.requestedDate,
    confirmedDate: booking.confirmedDate,
    scheduledStart: booking.scheduledStart,
    customerMarketingConsent: customer.emailMarketingConsent,
    customerMarketingOptOut: customer.marketingOptOut,
  })
  if (consentBlock) return recordSkip(bookingId, type, consentBlock)

  // Quiet hours — defer into the allowed window rather than sending now.
  const wait = msUntilAllowed()
  if (wait > 0) return deferFollowupForQuietHours(bookingId, type, wait)

  // Frequency caps (per customer).
  if (!(await withinFrequencyCaps(customer.id, { bookingId, type }))) return recordSkip(bookingId, type, 'rate-capped')

  // ── CLAIM (finding EMAIL-P1-10) ───────────────────────────────────
  // Claimed BEFORE sending, so a retry or double-trigger cannot duplicate —
  // but claimed as 'claimed', NOT 'sent'. The old code wrote status='sent'
  // here, before either channel had done anything, so the ledger asserted a
  // delivery that might never occur and every report inherited that.
  //
  // A pre-existing row is only a duplicate if it reached a TERMINAL state; a
  // row left mid-flight by a crashed worker is RESUMED.
  try {
    await prisma.followUpLedger.create({
      // EMAIL ONLY: Move It Clear It no longer sends SMS (owner, 2026-09-15).
      data: { bookingId, type, channel: 'email', status: 'claimed', emailStatus: 'pending', smsStatus: 'not_applicable' },
    })
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== 'P2002') throw err
    const existing = await prisma.followUpLedger
      .findUnique({ where: { bookingId_type: { bookingId, type } }, select: { status: true } })
      .catch(() => null)
    if (!existing) return 'duplicate'
    if (['delivered', 'failed_terminal', 'cancelled', 'skipped'].includes(existing.status)) return 'duplicate'
    log.info({ bookingId, type, state: existing.status }, 'resuming follow-up')
  }

  // Re-read so a resume knows which channel still needs work.
  const ledger = await prisma.followUpLedger
    .findUnique({
      where: { bookingId_type: { bookingId, type } },
      select: { emailStatus: true, emailAttempts: true, deliveredAt: true },
    })
    .catch(() => null)
  const emailAlreadyDelivered = ledger?.emailStatus === 'delivered'

  // COMPLIANCE CONTEXT (finding EMAIL-P1-06). An incomplete context is a
  // configuration problem, so the send is skipped with a named reason rather
  // than shipping a promotional email with no postal address.
  const ctx = buildMarketingContext(customer.email, EMAIL_TEMPLATE[type], locale)
  if (!ctx.ok) {
    return recordSkip(bookingId, type, `missing-configuration:${ctx.missing.join(',')}`)
  }

  const msg = buildMessage(type, customer.name, locale, applyMarketingContext({}, ctx.context))
  if (!msg) {
    // A configuration gap, not a customer-state problem. Recorded so the reason
    // is visible instead of the send silently "succeeding" with a bad link.
    return recordSkip(bookingId, type, 'missing-configuration:review-url')
  }
  // ── DELIVERY (email only) ────────────────────────────────────
  // An email that already delivered is NEVER re-sent on a resume. SMS is not a
  // channel any more (owner, 2026-09-15): nothing is ever texted.
  const patch: Record<string, unknown> = { smsStatus: 'not_applicable' }
  let deferUntil: Date | null = null

  if (customer.email && !emailAlreadyDelivered) {
    try {
      // The guard owns suppression/caps/idempotency; a refusal is already
      // recorded on the EmailSend row, and its CLASS decides whether this
      // follow-up stays retryable.
      const outcome = await sendEmail({
        to: customer.email,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        payload: msg.payload,
        template: EMAIL_TEMPLATE[type],
        bookingId,
      })
      const mapped = followupEmailStatus(outcome)
      patch.emailStatus = mapped.status
      if (mapped.error) patch.emailLastError = mapped.error
      deferUntil = mapped.status === 'failed' ? followupDeferUntil(outcome) : null
      // A deferral is "later", not a failed attempt.
      patch.emailAttempts = (ledger?.emailAttempts ?? 0) + (deferUntil ? 0 : 1)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      patch.emailStatus = 'failed'
      patch.emailLastError = m.slice(0, 500)
      patch.emailAttempts = (ledger?.emailAttempts ?? 0) + 1
      log.warn({ err: m, bookingId, type }, 'follow-up email failed')
    }
  } else if (!customer.email) {
    patch.emailStatus = 'not_applicable'
  }

  // ── ROLL UP ──────────────────────────────────────────────
  const emailState = (patch.emailStatus as string) ?? ledger?.emailStatus ?? 'not_applicable'
  const smsState = 'not_applicable'
  const live = [emailState].filter((v) => v !== 'not_applicable' && v !== 'pending')
  const good = live.filter((v) => v === 'delivered' || v === 'queued')
  const bad = live.filter((v) => v === 'failed')

  let status: string
  if (live.length === 0) status = 'failed_terminal'
  else if (bad.length === 0) status = 'delivered'
  else if (good.length > 0) status = 'partially_delivered'
  else status = 'failed_retryable'

  // Out of attempts: say so, instead of a 'retryable' row nothing will retry.
  const attemptsUsed = Number(patch.emailAttempts ?? ledger?.emailAttempts ?? 0)
  let terminalReason: string | undefined
  if (status === 'failed_retryable' && attemptsUsed >= FOLLOWUP_MAX_EMAIL_ATTEMPTS) {
    status = 'failed_terminal'
    terminalReason = `attempts_exhausted:${String(patch.emailLastError ?? 'unknown').slice(0, 200)}`
  }

  const retryable = status === 'failed_retryable' || status === 'partially_delivered'

  // CONDITIONAL: a concurrent run of the same follow-up (the quiet-hours retry
  // job and the hourly sweep can coincide) loses the guard claim and gets
  // 'in_flight'. Its late roll-up must never overwrite a row the winner already
  // closed — e.g. flip 'delivered' back to failed_retryable.
  await prisma.followUpLedger
    .updateMany({
      where: { bookingId, type, status: { notIn: ['delivered', 'failed_terminal', 'cancelled', 'skipped'] } },
      data: {
        ...patch,
        status,
        ...(terminalReason ? { terminalReason } : {}),
        // Keep the FIRST delivery time: a resume must not move it (the cap reads it).
        deliveredAt: good.length > 0 ? (ledger?.deliveredAt ?? new Date()) : (ledger?.deliveredAt ?? null),
        error: bad.length ? 'one or more channels failed' : null,
        // Stays retryable — and only the FAILED channel is retried, because a
        // delivered channel is skipped on resume.
        // A guard deferral carries its own due time; anything else waits an hour.
        nextAttemptAt: retryable ? (deferUntil ?? new Date(Date.now() + 60 * 60_000)) : null,
      },
    })
    .catch((err) => log.warn({ err: String(err), bookingId, type }, 'ledger roll-up failed'))

  if (status === 'failed_terminal' || status === 'failed_retryable') {
    log.warn({ bookingId, type, emailState, smsState }, 'follow-up did not deliver on any channel')
    return status
  }
  log.info({ bookingId, type, emailState, smsState }, 'follow-up processed')
  return status
}
