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
//  Everything is gated by MARKETING_FOLLOWUPS_ENABLED (default OFF). SMS go via
//  the existing smsQueue (free-form; the worker honors TWILIO_ENABLED); emails
//  via a DIRECT Resend call (the email-worker allowlist stays untouched). Every
//  send is guarded — a Redis/Twilio/Resend hiccup is logged, never fatal.
// ════════════════════════════════════════════════════════════════════════
import * as React from 'react'
import { render } from '@react-email/render'
import { prisma } from './db'
import { smsQueue, scheduledQueue } from './queues'
import { queueLogger } from './logger'
import { guardedSend } from './email-guard'
import { isSafeUrl } from '../emails/validation'
import { unsubscribeUrl } from './email-tokens'
import { checkReferralEligibility } from './referral-eligibility'
import { bookingEligibility } from './email-eligibility'
import { buildMarketingContext, applyMarketingContext } from './marketing-context'
import { normalizeLocale, t, BIZ_NAME, BIZ_PHONE, type Locale } from './i18n'
import ReviewRequestEmail from '../emails/review-request'
import ReferralEmail from '../emails/referral'
import QuoteFollowupEmail from '../emails/quote-followup'
import { C } from '../emails/_ui'

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
const COMPLETION_DELAYS: Array<{ type: FollowupType; delay: number }> = [
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

/** Walk a fire time forward in 1h steps until it lands in the allowed window. */
function shiftIntoAllowedHours(target: Date): Date {
  const t = new Date(target.getTime())
  for (let i = 0; i < 48 && inQuietHours(t); i++) {
    t.setTime(t.getTime() + HOUR)
  }
  return t
}

function msUntilAllowed(now = new Date()): number {
  return inQuietHours(now) ? shiftIntoAllowedHours(now).getTime() - now.getTime() : 0
}

// ── guarded queue add (a Redis stall must not hang the caller) ──────────
async function addScheduled(type: FollowupType, bookingId: string, delay: number, jobId: string): Promise<void> {
  await Promise.race([
    scheduledQueue.add(type, { type, bookingId }, { delay: Math.max(0, delay), jobId }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('scheduledQueue.add timed out (Redis?)')), 5000)),
  ])
}

async function enqueueFollowup(bookingId: string, type: FollowupType, fireAt: Date): Promise<void> {
  const allowed = shiftIntoAllowedHours(fireAt)
  const delay = allowed.getTime() - Date.now()
  // Stable jobId => a second completion trigger can't create a duplicate job.
  await addScheduled(type, bookingId, delay, `followup:${type}:${bookingId}`).catch((err) =>
    log.warn({ err: err instanceof Error ? err.message : String(err), bookingId, type }, 'enqueue follow-up failed (non-fatal)')
  )
}

// ── public: schedule the post-completion sequence ───────────────────────
/** Stamp completedAt (once) and schedule the follow-up sequence. Idempotent:
 *  stable jobIds dedupe at the queue and the ledger dedupes the actual sends. */
export async function onBookingCompleted(bookingId: string): Promise<void> {
  // First completion wins — never reset the anchor time on a re-trigger.
  await prisma.booking
    .updateMany({ where: { id: bookingId, completedAt: null }, data: { completedAt: new Date() } })
    .catch((err) => log.warn({ err: String(err), bookingId }, 'stamp completedAt failed (non-fatal)'))

  if (!FOLLOWUPS_ENABLED) {
    log.info({ bookingId }, 'MARKETING_FOLLOWUPS_ENABLED!=true — not scheduling follow-ups')
    return
  }
  const now = Date.now()
  // Enqueue in parallel (each self-guarded) so a Redis stall bounds the caller
  // to ~5s, not 4×5s — the admin "mark complete" request awaits this.
  await Promise.all(
    COMPLETION_DELAYS.map(({ type, delay }) => enqueueFollowup(bookingId, type, new Date(now + delay)))
  )
  log.info({ bookingId }, 'completion follow-ups scheduled')
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
      await enqueueFollowup(input.bookingId, 'referral-ask', new Date(Date.now() + DAY))
    } else {
      log.info({ bookingId: input.bookingId, reason: eligibility.reason }, 'positive review, but referral not eligible')
    }
  }
  return { id: review.id, rating, isPositive }
}

// ── frequency caps ──────────────────────────────────────────────────────
async function withinFrequencyCaps(customerId: string): Promise<boolean> {
  const now = Date.now()
  const [burst, windowCount] = await Promise.all([
    prisma.followUpLedger.count({
      where: { status: 'sent', sentAt: { gte: new Date(now - CAP_BURST_HOURS * HOUR) }, booking: { customerId } },
    }),
    prisma.followUpLedger.count({
      where: { status: 'sent', sentAt: { gte: new Date(now - CAP_WINDOW_DAYS * DAY) }, booking: { customerId } },
    }),
  ])
  return burst < CAP_BURST_MAX && windowCount < CAP_WINDOW_MAX
}

async function recordSkip(bookingId: string, type: FollowupType, reason: string): Promise<string> {
  await prisma.followUpLedger
    .upsert({
      where: { bookingId_type: { bookingId, type } },
      update: {}, // already recorded (sent/skipped) — leave as-is
      create: { bookingId, type, channel: 'both', status: 'skipped', error: reason },
    })
    .catch((err) => log.warn({ err: String(err), bookingId, type }, 'record skip failed'))
  log.info({ bookingId, type, reason }, 'follow-up skipped')
  return `skipped:${reason}`
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
}): Promise<boolean> {
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
    return false
  }
  return true
}

const esc = (s: string): string => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))

// The inline-HTML follow-up is GONE (findings EMAIL-P1-06 / EMAIL-P1-11).
// `emailHtml()`, its local BRAND palette and the `esc()` helper lived here to
// build `repeat-reminder` by hand. That put the one promotional email outside
// the shared marketing footer (so it carried no unsubscribe link and no postal
// address) and outside the render-based palette test (which is how a blue
// #1f6feb CTA survived in a four-colour brand). Every follow-up now renders
// through the shared _ui kit like every other email.

function withOptOut(sms: string, locale: Locale): string {
  return `${sms} ${t(locale, 'smsOptOut')}`
}

/** Returns null when the message CANNOT be built truthfully (missing config). */
function buildMessage(
  type: FollowupType,
  name: string,
  locale: Locale,
  /** Compliance block merged into the props BEFORE rendering (EMAIL-P1-06). */
  marketing: Record<string, unknown> = {}
): { sms: string; subject: string; html: string; text: string; payload: Record<string, unknown> } | null {
  const es = locale === 'es'
  switch (type) {
    case 'review-request':
    case 'review-reminder': {
      const key = type === 'review-request' ? 'reviewRequest' : 'reviewReminder'
      // NO FALLBACK (finding EMAIL-P1-15). Without a verified review
      // destination there is no honest review email to send.
      const url = reviewUrl()
      if (!url) return null
      return {
        sms: withOptOut(t(locale, key, { name, url }), locale),
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
        sms: withOptOut(t(locale, 'repeatReminder', { name, url: BOOK_URL }), locale),
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
        sms: withOptOut(t(locale, 'referralAsk', { name, url: REFERRAL_URL }), locale),
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

  // TCPA opt-out.
  if (customer.marketingOptOut) return recordSkip(bookingId, type, 'opted-out')

  // Quiet hours — defer into the allowed window rather than sending now.
  const wait = msUntilAllowed()
  if (wait > 0) {
    await addScheduled(type, bookingId, wait, `followup:${type}:${bookingId}:retry`).catch(() => {})
    return 'deferred-quiet-hours'
  }

  // Frequency caps (per customer).
  if (!(await withinFrequencyCaps(customer.id))) return recordSkip(bookingId, type, 'rate-capped')

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
      data: { bookingId, type, channel: 'both', status: 'claimed', emailStatus: 'pending', smsStatus: 'pending' },
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
      select: { emailStatus: true, smsStatus: true, emailAttempts: true, smsAttempts: true },
    })
    .catch(() => null)
  const emailAlreadyDelivered = ledger?.emailStatus === 'delivered'
  const smsAlreadyDelivered = ledger?.smsStatus === 'delivered'

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
  // ── PER-CHANNEL DELIVERY ─────────────────────────────────────
  // A channel that already delivered is NEVER re-sent on a resume.
  const patch: Record<string, unknown> = {}

  if (customer.phone && !smsAlreadyDelivered) {
    try {
      await smsQueue.add(`followup:${type}`, { to: customer.phone, message: msg.sms, bookingId })
      // QUEUED, not delivered. The SMS worker owns actual delivery — recording
      // 'delivered' at enqueue time is precisely the defect this finding names.
      patch.smsStatus = 'queued'
      patch.smsAttempts = (ledger?.smsAttempts ?? 0) + 1
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      patch.smsStatus = 'failed'
      patch.smsLastError = m.slice(0, 500)
      patch.smsAttempts = (ledger?.smsAttempts ?? 0) + 1
      log.warn({ err: m, bookingId, type }, 'follow-up SMS enqueue failed')
    }
  } else if (!customer.phone) {
    patch.smsStatus = 'not_applicable'
  }

  if (customer.email && !emailAlreadyDelivered) {
    try {
      // The guard owns suppression/caps/idempotency; `false` is a policy refusal
      // (already recorded on the EmailSend row), not an exception.
      const ok = await sendEmail({
        to: customer.email,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        payload: msg.payload,
        template: EMAIL_TEMPLATE[type],
        bookingId,
      })
      patch.emailStatus = ok ? 'delivered' : 'failed'
      if (!ok) patch.emailLastError = 'refused by send guard'
      patch.emailAttempts = (ledger?.emailAttempts ?? 0) + 1
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
  const smsState = (patch.smsStatus as string) ?? ledger?.smsStatus ?? 'not_applicable'
  const live = [emailState, smsState].filter((v) => v !== 'not_applicable' && v !== 'pending')
  const good = live.filter((v) => v === 'delivered' || v === 'queued')
  const bad = live.filter((v) => v === 'failed')

  let status: string
  if (live.length === 0) status = 'failed_terminal'
  else if (bad.length === 0) status = 'delivered'
  else if (good.length > 0) status = 'partially_delivered'
  else status = 'failed_retryable'

  const retryable = status === 'failed_retryable' || status === 'partially_delivered'

  await prisma.followUpLedger
    .update({
      where: { bookingId_type: { bookingId, type } },
      data: {
        ...patch,
        status,
        deliveredAt: good.length > 0 ? new Date() : null,
        error: bad.length ? 'one or more channels failed' : null,
        // Stays retryable — and only the FAILED channel is retried, because a
        // delivered channel is skipped on resume.
        nextAttemptAt: retryable ? new Date(Date.now() + 60 * 60_000) : null,
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
