// ════════════════════════════════════════════════════════════════════════
//  EMAIL SEND GUARD — the ONE place an email may leave this system.
//  (owner spec 2026-07-20)
//  ---------------------------------------------------------------------
//  BEFORE: three independent send paths each called `resend.emails.send()`
//  directly —
//      1. src/workers/email.worker.ts   (BullMQ, had the validation gate)
//      2. src/outbox/services/emailService.ts (outbox, NO validation gate)
//      3. src/lib/followups.ts          (direct Resend, NO validation gate)
//  — so a guard added to one was silently absent from the other two, there was
//  no suppression check anywhere, and a worker retry AFTER a successful provider
//  call would send the message a second time.
//
//  AFTER: all three call `guardedSend()`. It runs, in order:
//      1. recipient format
//      2. suppression (fails CLOSED)                      → src/lib/email-suppression
//      3. LIVE STATE RELOAD via the caller's `recheck()`   → stale queue jobs die here
//      4. frequency caps + quiet hours (PROMOTIONAL only)
//      5. payload validation (required fields, safe URLs)  → src/emails/validation
//      6. IDEMPOTENCY CLAIM — an EmailSend row is written BEFORE the provider
//         call. A duplicate key means someone already sent this; we stop.
//      7. provider send
//      8. mark sent + record the provider id
//
//  Every refusal is RECORDED (status 'blocked' + reason) so the admin can answer
//  "why didn't this customer get their email?" without reading logs.
//
//  KNOWN LIMITATION (documented, not hidden): the installed Resend SDK (3.x)
//  exposes no idempotency-key parameter. If the provider ACCEPTS a send and the
//  process dies before step 8, the row stays 'claimed' and the message is not
//  retried — we bias toward NOT double-sending. The residual window is
//  provider-accepted-but-unrecorded, which shows up as a 'claimed' row with no
//  providerId; `staleClaims()` surfaces those for the admin.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from './resend'
import { normalizeEmail, unsubscribeUrl } from './email-tokens'
import { isSuppressed, type EmailClass } from './email-suppression'
import { assertEmailPayload, EmailValidationError } from '../emails/validation'

const log = queueLogger.child({ mod: 'email-guard' })

// ── Template classification ─────────────────────────────────────────────
// PROMOTIONAL = anything whose purpose is to generate another booking.
// TRANSACTIONAL = a message about a booking the customer already made.
//
// This mapping is the legal + deliverability boundary, so it is EXPLICIT and
// closed: an unknown template is treated as PROMOTIONAL (the safer default —
// it gets suppression checks, caps, quiet hours, and an unsubscribe link).
const PROMOTIONAL_TEMPLATES: ReadonlySet<string> = new Set([
  'abandoned-checkout',
  'abandoned-checkout-2',
  'abandoned-checkout-3',
  'review-request',
  'review-reminder',
  'referral',
  'referral-ask',
  'referral-reward',
  'repeat-reminder',
  'quote-followup-1',
  'quote-followup-2',
  'quote-followup-final',
  'reactivation',
])

const TRANSACTIONAL_TEMPLATES: ReadonlySet<string> = new Set([
  'pre-approval',
  'final-confirmation',
  'booking-declined',
  'payment-receipt',
  'payment-failed',
  'booking-updated',
  'booking-cancellation',
  'reschedule-request',
  'job-reminder',
  'job-completion',
  'information-required',
  'operational-alert',
  'final-invoice',
])

export function classifyTemplate(template: string): EmailClass {
  if (TRANSACTIONAL_TEMPLATES.has(template)) return 'transactional'
  return 'promotional'
}

// ── Frequency caps + quiet hours (PROMOTIONAL only) ─────────────────────
// Transactional mail is exempt by design: a receipt or a move-day reminder must
// arrive when the event happens, not when a marketing window opens.
const num = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export const CAPS = {
  /** Max PROMOTIONAL emails per address per rolling 24h. */
  get perDay() {
    return num('EMAIL_CAP_PER_DAY', 1)
  },
  /** Max PROMOTIONAL emails per address per rolling 7 days. */
  get perWeek() {
    return num('EMAIL_CAP_PER_WEEK', 3)
  },
  /** Max PROMOTIONAL emails per address per rolling 30 days. */
  get perMonth() {
    return num('EMAIL_CAP_PER_MONTH', 6)
  },
  /** First allowed hour, America/New_York. */
  get quietEndHour() {
    return num('EMAIL_QUIET_END_HOUR', 8)
  },
  /** First DISALLOWED hour, America/New_York (21 = nothing from 9pm). */
  get quietStartHour() {
    return num('EMAIL_QUIET_START_HOUR', 21)
  },
  /**
   * A promotional email must not land right beside a transactional one — a
   * customer who just got a receipt should not immediately get an upsell.
   */
  get transactionalGapMinutes() {
    return num('EMAIL_TRANSACTIONAL_GAP_MINUTES', 60)
  },
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Hour of day in America/New_York — DST-safe, host-timezone independent. */
export function etHour(d: Date): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(d)
  return parseInt(s, 10) || 0
}

export function inQuietHours(d: Date = new Date()): boolean {
  const h = etHour(d)
  return h < CAPS.quietEndHour || h >= CAPS.quietStartHour
}

/** Next moment outside quiet hours, walking forward in 1h steps. */
export function nextAllowedTime(from: Date = new Date()): Date {
  const t = new Date(from.getTime())
  for (let i = 0; i < 48 && inQuietHours(t); i++) t.setTime(t.getTime() + HOUR_MS)
  return t
}

// Deliberately permissive but real: rejects the blank/placeholder/space cases
// that actually reach send paths. Full RFC 5322 validation in a regex is a trap.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export function isValidEmailAddress(email: string): boolean {
  const e = normalizeEmail(email)
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e)
}

// ── Idempotency ─────────────────────────────────────────────────────────
/**
 * Build the stable key that makes a send exactly-once.
 *
 * Every component matters:
 *   email          — the same journey to a different address is a different send
 *   template       — two different messages for one event are both legitimate
 *   journey/stage  — stage 2 of recovery is not stage 1
 *   eventId        — the QUALIFYING event (bookingId, leadId, completion id).
 *                    This is what stops a re-fired trigger from re-sending.
 *   version        — bump to deliberately re-send after a content correction
 */
export function buildIdempotencyKey(parts: {
  email: string
  template: string
  journey?: string
  eventId?: string
  version?: string
}): string {
  return [
    normalizeEmail(parts.email),
    parts.template,
    parts.journey ?? 'none',
    parts.eventId ?? 'none',
    parts.version ?? 'v1',
  ].join('|')
}

// ── Result type ─────────────────────────────────────────────────────────
export type SendOutcome =
  | { sent: true; providerId: string; emailSendId: string }
  | { sent: false; reason: string; emailSendId?: string; retryAt?: Date }

export type GuardedSendInput = {
  to: string
  subject: string
  html: string
  /** Plain-text alternative. Strongly recommended (spam score + accessibility). */
  text?: string
  template: string
  /** Overrides the classification table. Use only with a documented reason. */
  emailClass?: EmailClass
  journey?: string
  /** The qualifying event id — the anchor of the idempotency key. */
  eventId?: string
  version?: string
  bookingId?: string
  leadId?: string
  campaign?: string
  /** Payload for the required-field + URL-safety gate. Omit only for ad-hoc HTML. */
  payload?: Record<string, unknown>
  /**
   * LIVE STATE RELOAD. Called immediately before the idempotency claim, after
   * every cheap check has passed. Return a reason string to ABORT — this is
   * where a queued job discovers the booking was completed/cancelled, the move
   * date passed, or the lead converted. Deleting the queue record is NOT the
   * only protection; this is the final guard.
   */
  recheck?: () => Promise<string | null>
  /** Set false to skip the unsubscribe header (transactional). Default: by class. */
  includeUnsubscribeHeader?: boolean
}

/** Record a refusal so the admin can see WHY nothing was sent. Never throws. */
async function recordBlock(
  key: string,
  input: GuardedSendInput,
  emailClass: EmailClass,
  reason: string
): Promise<string | undefined> {
  try {
    const row = await prisma.emailSend.upsert({
      where: { idempotencyKey: key },
      // An already-recorded send keeps its own outcome — a later block must not
      // rewrite the history of a message that really was delivered.
      update: {},
      create: {
        idempotencyKey: key,
        email: normalizeEmail(input.to),
        template: input.template,
        emailClass,
        journey: input.journey ?? null,
        bookingId: input.bookingId ?? null,
        leadId: input.leadId ?? null,
        campaign: input.campaign ?? null,
        status: 'blocked',
        blockedReason: reason.slice(0, 500),
      },
    })
    return row.id
  } catch (err) {
    log.warn({ err: String(err), reason }, 'failed to record blocked send (non-fatal)')
    return undefined
  }
}

/** Count PROMOTIONAL sends to this address inside a rolling window. */
async function countSentSince(email: string, since: Date): Promise<number> {
  return prisma.emailSend.count({
    where: { email, emailClass: 'promotional', status: 'sent', sentAt: { gte: since } },
  })
}

/**
 * THE send path. Every email in this system goes through here.
 * Never throws for a policy refusal — it returns `{ sent: false, reason }`.
 * It DOES throw on an unexpected provider error, so BullMQ can retry.
 */
export async function guardedSend(input: GuardedSendInput): Promise<SendOutcome> {
  const email = normalizeEmail(input.to)
  const emailClass = input.emailClass ?? classifyTemplate(input.template)
  const key = buildIdempotencyKey({
    email,
    template: input.template,
    journey: input.journey,
    eventId: input.eventId,
    version: input.version,
  })
  const l = log.child({ template: input.template, journey: input.journey, emailClass })

  // ── 1. recipient format ───────────────────────────────────────────────
  if (!isValidEmailAddress(email)) {
    l.warn('blocked: invalid recipient address')
    return { sent: false, reason: 'invalid_email', emailSendId: await recordBlock(key, input, emailClass, 'invalid_email') }
  }

  // ── 2. suppression (fails CLOSED) ─────────────────────────────────────
  const suppression = await isSuppressed(email, emailClass)
  if (suppression.suppressed) {
    l.info({ reason: suppression.reason }, 'blocked: suppressed address')
    return {
      sent: false,
      reason: suppression.reason,
      emailSendId: await recordBlock(key, input, emailClass, suppression.reason),
    }
  }

  // ── 3. LIVE STATE RELOAD ──────────────────────────────────────────────
  // The queue job may have been sitting for days. Reload the truth.
  if (input.recheck) {
    let abort: string | null
    try {
      abort = await input.recheck()
    } catch (err) {
      // A failed state read must not become a send.
      l.error({ err: err instanceof Error ? err.message : String(err) }, 'recheck() threw — failing closed')
      abort = 'state_read_failed'
    }
    if (abort) {
      l.info({ reason: abort }, 'blocked: state recheck refused the send')
      return { sent: false, reason: abort, emailSendId: await recordBlock(key, input, emailClass, abort) }
    }
  }

  // ── 4. quiet hours + frequency caps (PROMOTIONAL only) ────────────────
  if (emailClass === 'promotional') {
    if (inQuietHours()) {
      const retryAt = nextAllowedTime()
      l.info({ retryAt }, 'deferred: quiet hours')
      // NOT recorded as a block — the send is still wanted, just later. The
      // caller re-queues; the idempotency key is unchanged so it cannot double.
      return { sent: false, reason: 'quiet_hours', retryAt }
    }

    const now = Date.now()
    const [day, week, month] = await Promise.all([
      countSentSince(email, new Date(now - DAY_MS)),
      countSentSince(email, new Date(now - 7 * DAY_MS)),
      countSentSince(email, new Date(now - 30 * DAY_MS)),
    ])

    const capped =
      (day >= CAPS.perDay && 'cap_daily') ||
      (week >= CAPS.perWeek && 'cap_weekly') ||
      (month >= CAPS.perMonth && 'cap_monthly')

    if (capped) {
      l.info({ day, week, month, capped }, 'blocked: frequency cap')
      return { sent: false, reason: capped, emailSendId: await recordBlock(key, input, emailClass, capped) }
    }

    // Do not land a promotional email right beside a transactional one.
    const gapMin = CAPS.transactionalGapMinutes
    if (gapMin > 0) {
      const recentTransactional = await prisma.emailSend.count({
        where: {
          email,
          emailClass: 'transactional',
          status: 'sent',
          sentAt: { gte: new Date(now - gapMin * 60_000) },
        },
      })
      if (recentTransactional > 0) {
        const retryAt = new Date(now + gapMin * 60_000)
        l.info({ gapMin, retryAt }, 'deferred: too close to a transactional email')
        return { sent: false, reason: 'transactional_gap', retryAt }
      }
    }
  }

  // ── 5. payload validation (required fields + URL safety) ──────────────
  if (input.payload) {
    try {
      assertEmailPayload(input.template, input.payload)
    } catch (err) {
      if (err instanceof EmailValidationError) {
        l.error({ err: err.message }, 'blocked: payload validation')
        return {
          sent: false,
          reason: `validation: ${err.message}`,
          emailSendId: await recordBlock(key, input, emailClass, `validation: ${err.message}`),
        }
      }
      throw err
    }
  }

  // ── 6. IDEMPOTENCY CLAIM — before the provider call, always ───────────
  let emailSendId: string
  try {
    const row = await prisma.emailSend.create({
      data: {
        idempotencyKey: key,
        email,
        template: input.template,
        emailClass,
        journey: input.journey ?? null,
        bookingId: input.bookingId ?? null,
        leadId: input.leadId ?? null,
        campaign: input.campaign ?? null,
        status: 'claimed',
      },
    })
    emailSendId = row.id
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      l.info({ key }, 'skipped: already claimed (idempotent)')
      return { sent: false, reason: 'duplicate' }
    }
    throw err
  }

  // ── 7. provider send ──────────────────────────────────────────────────
  const wantsUnsubHeader = input.includeUnsubscribeHeader ?? emailClass === 'promotional'
  const unsub = wantsUnsubHeader ? unsubscribeUrl(email) : null
  const headers = unsub
    ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      reply_to: EMAIL_REPLY_TO,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(headers ? { headers } : {}),
    })

    if (error) {
      await prisma.emailSend
        .update({
          where: { id: emailSendId },
          data: { status: 'failed', error: (error.message ?? JSON.stringify(error)).slice(0, 500) },
        })
        .catch(() => undefined)
      // Throw so BullMQ retries. The claimed row is now 'failed', and a retry
      // re-enters at step 6 — where the unique key makes it a no-op unless the
      // row is explicitly released. See releaseForRetry().
      throw new Error(`Resend error: ${error.message ?? JSON.stringify(error)}`)
    }

    // ── 8. mark sent ────────────────────────────────────────────────────
    const providerId = data?.id ?? 'unknown'
    await prisma.emailSend
      .update({ where: { id: emailSendId }, data: { status: 'sent', providerId, sentAt: new Date() } })
      .catch((err) =>
        // The message IS delivered. Losing the mark is a reporting problem, not
        // a duplicate risk — the 'claimed' row still blocks a re-send.
        l.error({ err: String(err), emailSendId, providerId }, 'send succeeded but marking failed')
      )

    l.info({ providerId }, 'email sent')
    return { sent: true, providerId, emailSendId }
  } catch (err) {
    await prisma.emailSend
      .update({
        where: { id: emailSendId },
        data: { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
      })
      .catch(() => undefined)
    throw err
  }
}

/**
 * Release a FAILED claim so a deliberate retry can send. Only ever touches rows
 * that failed WITHOUT a provider id — a row with a providerId was delivered and
 * must never be re-opened.
 */
export async function releaseForRetry(idempotencyKey: string): Promise<boolean> {
  const { count } = await prisma.emailSend.deleteMany({
    where: { idempotencyKey, status: 'failed', providerId: null },
  })
  return count > 0
}

/**
 * Rows stuck in 'claimed' with no provider id for longer than `olderThanMinutes`.
 * These are the documented residual double-send window: the process died between
 * the claim and the provider response, so we cannot know whether it sent.
 * Surfaced for a human, never auto-retried.
 */
export async function staleClaims(olderThanMinutes = 30) {
  return prisma.emailSend.findMany({
    where: {
      status: 'claimed',
      providerId: null,
      createdAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
}
