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
import { render } from '@react-email/render'
import { prisma } from './db'
import { smsQueue, scheduledQueue } from './queues'
import { queueLogger } from './logger'
import { guardedSend } from './email-guard'
import { unsubscribeUrl } from './email-tokens'
import { checkReferralEligibility } from './referral-eligibility'
import { normalizeLocale, t, BIZ_NAME, BIZ_PHONE, type Locale } from './i18n'
import ReviewRequestEmail from '../emails/review-request'
import ReferralEmail from '../emails/referral'

const log = queueLogger.child({ mod: 'followups' })

export const FOLLOWUPS_ENABLED = process.env.MARKETING_FOLLOWUPS_ENABLED === 'true'

// Links used in the copy.
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL?.trim() || ''
const BOOK_URL = (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
const REFERRAL_URL = process.env.REFERRAL_URL?.trim() || BOOK_URL
const REFERRAL_CODE = process.env.REFERRAL_CODE?.trim() || 'REFER15'
const reviewUrl = () => GOOGLE_REVIEW_URL || BOOK_URL

// Quiet hours (America/New_York): send only when 08:00 <= hour < 21:00.
const QUIET_END = 8 // first allowed hour
const QUIET_START = 21 // 9pm — first disallowed hour

// Frequency caps (safety nets; the schedule already spaces sends > 24h apart).
const CAP_BURST_HOURS = 24
const CAP_BURST_MAX = 1 // <=1 follow-up per 24h per customer
const CAP_WINDOW_DAYS = 30
const CAP_WINDOW_MAX = 4 // <=4 follow-ups per 30d per customer

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
  template: string
  bookingId: string
}): Promise<boolean> {
  const outcome = await guardedSend({
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
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

function emailHtml(opts: { heading: string; paras: string[]; ctaLabel?: string; ctaUrl?: string }): string {
  const paras = opts.paras.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('')
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<p style="margin:18px 0"><a href="${esc(opts.ctaUrl)}" style="background:#1f6feb;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;display:inline-block">${esc(opts.ctaLabel)}</a></p>`
      : ''
  return (
    `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    `<h2 style="margin:0 0 14px">${esc(opts.heading)}</h2>${paras}${cta}` +
    `<p style="margin:16px 0 0;color:#555">— ${esc(BIZ_NAME)} · ${BIZ_PHONE}</p></div>`
  )
}

function withOptOut(sms: string, locale: Locale): string {
  return `${sms} ${t(locale, 'smsOptOut')}`
}

function buildMessage(type: FollowupType, name: string, locale: Locale): { sms: string; subject: string; html: string } {
  const es = locale === 'es'
  switch (type) {
    case 'review-request':
    case 'review-reminder': {
      const key = type === 'review-request' ? 'reviewRequest' : 'reviewReminder'
      return {
        sms: withOptOut(t(locale, key, { name, url: reviewUrl() }), locale),
        subject: es ? '¿Cómo lo hicimos? Deja tu reseña' : 'How did we do? Leave us a review',
        // Premium branded review email (shared _ui kit), matching the rest of the
        // transactional set. Replaces the old inline emailHtml() card.
        html: render(
          ReviewRequestEmail({ customerName: name, googleReviewUrl: reviewUrl(), locale })
        ),
      }
    }
    case 'repeat-reminder':
      return {
        sms: withOptOut(t(locale, 'repeatReminder', { name, url: BOOK_URL }), locale),
        subject: es ? '¿Otra mudanza o limpieza?' : 'Moving again or need a cleanout?',
        html: emailHtml({
          heading: es ? `Estamos aquí cuando nos necesites, ${esc(name)}` : `We're here whenever you need us, ${esc(name)}`,
          paras: [
            es
              ? 'Si te mudas otra vez o necesitas retirar muebles o basura, nos encantaría ayudarte — con 10% de descuento para clientes que regresan.'
              : "If you're moving again or need furniture or junk cleared out, we'd love to help — with 10% off for return customers.",
          ],
          ctaLabel: es ? 'Reservar de nuevo' : 'Book again',
          ctaUrl: BOOK_URL,
        }),
      }
    case 'referral-ask':
      return {
        sms: withOptOut(t(locale, 'referralAsk', { name, url: REFERRAL_URL }), locale),
        subject: es ? 'Da 15%. Recibe 15%.' : 'Give 15%. Get 15%.',
        // Premium branded referral email (shared _ui kit).
        html: render(
          ReferralEmail({ customerName: name, referralCode: REFERRAL_CODE, referralUrl: REFERRAL_URL, locale })
        ),
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

  // Claim the ledger row BEFORE sending → exactly-once. P2002 = already handled.
  try {
    await prisma.followUpLedger.create({ data: { bookingId, type, channel: 'both', status: 'sent' } })
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') return 'duplicate'
    throw err
  }

  const msg = buildMessage(type, customer.name, locale)
  let anySent = false
  if (customer.phone) {
    try {
      await smsQueue.add(`followup:${type}`, { to: customer.phone, message: msg.sms, bookingId })
      anySent = true
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), bookingId, type }, 'follow-up SMS enqueue failed')
    }
  }
  if (customer.email) {
    try {
      // The guard owns suppression/caps/idempotency; a `false` here is a policy
      // refusal (already recorded), not an error.
      if (await sendEmail({
        to: customer.email,
        subject: msg.subject,
        html: msg.html,
        template: EMAIL_TEMPLATE[type],
        bookingId,
      })) {
        anySent = true
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), bookingId, type }, 'follow-up email failed')
    }
  }

  if (!anySent) {
    await prisma.followUpLedger
      .update({ where: { bookingId_type: { bookingId, type } }, data: { status: 'failed', error: 'no channel sent' } })
      .catch(() => {})
    return 'failed'
  }
  log.info({ bookingId, type }, 'follow-up sent')
  return 'sent'
}
