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
//      6. CLAIM OR RESUME — an EmailSend row is written BEFORE the provider
//         call. A conflicting key does NOT automatically mean "already sent":
//         only a TERMINAL row stops us. See the attempt state machine below.
//      7. provider send
//      8. mark delivered + record the provider id
//
//  Every refusal is RECORDED with a machine-readable reason and a classification
//  (terminal / retryable / deferred), so the admin can answer "why didn't this
//  customer get their email?" — and so a TEMPORARY refusal does not silently
//  become permanent.
//
//  KNOWN LIMITATION (documented, not hidden): the installed Resend SDK (3.x)
//  exposes no idempotency-key parameter, so we cannot ask the provider to
//  deduplicate. If the request leaves us and the outcome is unknown (timeout,
//  crash mid-flight), the send becomes 'ambiguous' and is NEVER auto-resent —
//  a duplicate to a real customer is worse than a delayed one. Those rows are
//  surfaced by `ambiguousSends()` for a human to reconcile against the provider
//  dashboard, and can be re-driven deliberately with `reopenForRetry()`.
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

// ════════════════════════════════════════════════════════════════════════
//  ATTEMPT STATE MACHINE (findings EMAIL-P1-03 and EMAIL-P1-04)
//  ---------------------------------------------------------------------
//  THE DEFECT BOTH FINDINGS SHARE: the unique idempotency key WAS the outcome
//  record. `guardedSend` created an EmailSend row, and whatever happened first
//  permanently occupied that key:
//
//    • provider returns 500        → row marked 'failed', function throws,
//      BullMQ retries → the retry hits the unique key → 'duplicate' → the email
//      is NEVER sent. `releaseForRetry()` existed but nothing called it.
//    • quiet hours / frequency cap → `recordBlock()` wrote a row on the same
//      key, so once the cap expired or the quiet window ended, the send could
//      never happen. Same for a suppression-table timeout, a temporarily
//      missing URL, or a customer who later resubscribed.
//
//  THE FIX: separate DELIVERY IDENTITY from ATTEMPT OUTCOME.
//  The key still identifies one logical business event — that is what stops
//  double-sends. But a row in a NON-TERMINAL state is RESUMED in place rather
//  than treated as "already handled". Attempts accumulate against one row.
//
//  TERMINAL (never re-attempted):
//    delivered         the provider accepted it — the customer has the email
//    blocked_terminal  hard suppression, ineligible booking state
//    failed_terminal   attempts exhausted
//    ambiguous         the request left us and we do not know the outcome.
//                      Deliberately terminal for AUTOMATION: auto-resending
//                      risks a duplicate to a real customer. Surfaced for a
//                      human to reconcile (see `ambiguousSends`).
//
//  RESUMABLE:
//    sending           an attempt is in flight (or a worker died mid-attempt)
//    provider_rejected known rejection, no provider id — safe to retry
//    retry_pending     awaiting another attempt
//    deferred          policy says later; `nextAttemptAt` says when
//    blocked_retryable temporary condition (DB outage, missing config)
// ════════════════════════════════════════════════════════════════════════

/** Statuses that permanently close a logical send. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'delivered',
  'blocked_terminal',
  'failed_terminal',
  'ambiguous',
])

/** Max attempts against ONE logical send before it becomes failed_terminal. */
export const MAX_SEND_ATTEMPTS = Number(process.env.EMAIL_MAX_SEND_ATTEMPTS) || 5

/**
 * How long a row may sit in 'sending' before we assume the worker died and
 * allow a resume. Shorter than this and we risk two workers sending at once.
 */
export const SENDING_STALE_MS = Number(process.env.EMAIL_SENDING_STALE_MS) || 10 * 60_000

/**
 * Block reasons that are PERMANENT for this business event. Everything else is
 * treated as temporary and stays resumable — the safer default, because wrongly
 * calling something terminal silently loses a legitimate email.
 */
const TERMINAL_BLOCK_REASONS: ReadonlySet<string> = new Set([
  'hard_bounce',
  'spam_complaint',
  'invalid_address',
  'admin_block',
  'provider_rejected',
  'invalid_email',
  'blank_email',
  'internal_test_booking',
  'booking_deleted',
  'duplicate',
])

/** Reasons that mean "not now" rather than "not ever". */
const DEFERRAL_REASONS: ReadonlySet<string> = new Set([
  'quiet_hours',
  'transactional_gap',
  'cap_daily',
  'cap_weekly',
  'cap_monthly',
])

export type BlockClass = 'terminal' | 'retryable' | 'deferred'

/**
 * Classify a refusal. A reason that is unknown to us is treated as RETRYABLE,
 * because a temporary condition wrongly marked terminal loses a real email,
 * while a terminal condition wrongly marked retryable merely costs a few
 * harmless re-checks that will refuse again.
 */
export function classifyBlock(reason: string): BlockClass {
  if (DEFERRAL_REASONS.has(reason)) return 'deferred'
  if (TERMINAL_BLOCK_REASONS.has(reason)) return 'terminal'
  // Booking/lead state that genuinely cannot come back is terminal.
  if (/^status_not_allowed:/.test(reason)) return 'terminal'
  if (/^booking_not_completed:|^booking_advanced:|^lead_converted$|^lead_lost$/.test(reason)) return 'terminal'
  if (reason === 'move_date_passed' || reason === 'deposit_already_paid') return 'terminal'
  // Config/plumbing problems are fixable, so the send must survive them.
  if (reason.startsWith('validation:')) return 'retryable'
  if (reason.endsWith('_read_failed') || reason === 'suppression_read_failed') return 'retryable'
  if (reason.startsWith('missing-configuration')) return 'retryable'
  if (reason === 'unsubscribed') return 'terminal'
  return 'retryable'
}

const statusForBlock = (c: BlockClass): string =>
  c === 'terminal' ? 'blocked_terminal' : c === 'deferred' ? 'deferred' : 'blocked_retryable'

// ── Result type ─────────────────────────────────────────────────────────
export type SendOutcome =
  | { sent: true; providerId: string; emailSendId: string }
  | { sent: false; reason: string; emailSendId?: string; retryAt?: Date; outcomeClass?: BlockClass | 'ambiguous' }

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
  /** Payload for the required-field + URL-safety gate. */
  payload?: Record<string, unknown>
  /**
   * LIVE STATE RELOAD. Called immediately before the claim, after every cheap
   * check has passed. Return a reason string to ABORT.
   */
  recheck?: () => Promise<string | null>
  /** Set false to skip the unsubscribe header (transactional). Default: by class. */
  includeUnsubscribeHeader?: boolean
}

/**
 * Record a refusal against the logical send, classified so that a TEMPORARY
 * condition leaves the row resumable (finding EMAIL-P1-04).
 */
async function recordBlock(
  key: string,
  input: GuardedSendInput,
  emailClass: EmailClass,
  reason: string,
  retryAt?: Date
): Promise<{ id?: string; blockClass: BlockClass }> {
  const blockClass = classifyBlock(reason)
  const status = statusForBlock(blockClass)
  try {
    const row = await prisma.emailSend.upsert({
      where: { idempotencyKey: key },
      // No-op on conflict: we cannot express "only if not terminal" inside an
      // upsert, so the row is read back and updated conditionally below. A
      // delivered send must never be rewritten by a later policy check.
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
        status,
        outcomeClass: blockClass,
        blockedReason: reason.slice(0, 500),
        nextAttemptAt: retryAt ?? null,
      },
    })
    // Never downgrade a terminal row. `updateMany` with a status filter makes
    // this atomic: a row that reached 'delivered' concurrently is not matched.
    await prisma.emailSend
      .updateMany({
        where: { id: row.id, status: { notIn: Array.from(TERMINAL_STATUSES) } },
        data: {
          status,
          outcomeClass: blockClass,
          blockedReason: reason.slice(0, 500),
          nextAttemptAt: retryAt ?? null,
        },
      })
      .catch(() => undefined)
    return { id: row.id, blockClass }
  } catch (err) {
    log.warn({ err: String(err), reason }, 'failed to record blocked send (non-fatal)')
    return { blockClass }
  }
}

/** Count PROMOTIONAL sends to this address inside a rolling window. */
async function countSentSince(email: string, since: Date): Promise<number> {
  return prisma.emailSend.count({
    where: { email, emailClass: 'promotional', status: 'delivered', sentAt: { gte: since } },
  })
}

type ClaimResult =
  | { ok: true; id: string; attempts: number }
  | { ok: false; reason: string; id?: string }

/**
 * Atomically claim a NEW logical send, or RESUME an existing non-terminal one.
 *
 * This is the heart of the P1-03/P1-04 fix. The old code did a bare `create`
 * and treated a unique violation as "already done" — which is true only when
 * the previous attempt actually delivered.
 */
async function claimOrResumeSend(
  key: string,
  input: GuardedSendInput,
  emailClass: EmailClass
): Promise<ClaimResult> {
  const email = normalizeEmail(input.to)
  const now = new Date()

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
        status: 'sending',
        outcomeClass: null,
        attempts: 1,
      },
      select: { id: true, attempts: true },
    })
    return { ok: true, id: row.id, attempts: row.attempts }
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2002') throw err
  }

  // A row exists. Whether we may proceed depends entirely on its state.
  const existing = await prisma.emailSend.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, status: true, attempts: true, updatedAt: true, nextAttemptAt: true },
  })
  if (!existing) return { ok: false, reason: 'claim_lookup_failed' }

  if (TERMINAL_STATUSES.has(existing.status)) {
    // 'delivered' is the honest "already sent". The others are equally final,
    // but for different reasons — report which, so logs are not misleading.
    return {
      ok: false,
      reason: existing.status === 'delivered' ? 'duplicate' : `terminal:${existing.status}`,
      id: existing.id,
    }
  }

  if (existing.attempts >= MAX_SEND_ATTEMPTS) {
    await prisma.emailSend
      .update({ where: { id: existing.id }, data: { status: 'failed_terminal', outcomeClass: 'terminal' } })
      .catch(() => undefined)
    log.error({ key, attempts: existing.attempts }, 'send attempts exhausted — failed_terminal')
    return { ok: false, reason: 'attempts_exhausted', id: existing.id }
  }

  // Another worker may be mid-flight. Only take over a genuinely stale claim.
  if (existing.status === 'sending' && now.getTime() - existing.updatedAt.getTime() < SENDING_STALE_MS) {
    return { ok: false, reason: 'in_flight', id: existing.id }
  }

  // A deferral is not due yet.
  if (existing.nextAttemptAt && existing.nextAttemptAt.getTime() > now.getTime()) {
    return { ok: false, reason: 'not_due', id: existing.id }
  }

  // RESUME the same logical send. The conditional `where` makes the takeover
  // atomic: if another worker resumed it first, count is 0 and we back off.
  const { count } = await prisma.emailSend.updateMany({
    where: { id: existing.id, status: existing.status, attempts: existing.attempts },
    data: {
      status: 'sending',
      attempts: existing.attempts + 1,
      blockedReason: null,
      outcomeClass: null,
      nextAttemptAt: null,
    },
  })
  if (count === 0) return { ok: false, reason: 'in_flight', id: existing.id }

  log.info({ key, attempt: existing.attempts + 1, from: existing.status }, 'resuming logical send')
  return { ok: true, id: existing.id, attempts: existing.attempts + 1 }
}

/**
 * THE send path. Every email in this system goes through here.
 * Never throws for a policy refusal — it returns `{ sent: false, reason }`.
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

  const refuse = async (reason: string, retryAt?: Date): Promise<SendOutcome> => {
    const { id, blockClass } = await recordBlock(key, input, emailClass, reason, retryAt)
    return { sent: false, reason, emailSendId: id, retryAt, outcomeClass: blockClass }
  }

  // ── 1. recipient format ───────────────────────────────────────────────
  if (!isValidEmailAddress(email)) {
    l.warn('blocked: invalid recipient address')
    return refuse('invalid_email')
  }

  // ── 2. suppression (fails CLOSED) ─────────────────────────────────────
  const suppression = await isSuppressed(email, emailClass)
  if (suppression.suppressed) {
    l.info({ reason: suppression.reason }, 'blocked: suppressed address')
    return refuse(suppression.reason)
  }

  // ── 3. LIVE STATE RELOAD ──────────────────────────────────────────────
  if (input.recheck) {
    let abort: string | null
    try {
      abort = await input.recheck()
    } catch (err) {
      l.error({ err: err instanceof Error ? err.message : String(err) }, 'recheck() threw — failing closed')
      abort = 'state_read_failed'
    }
    if (abort) {
      l.info({ reason: abort }, 'blocked: state recheck refused the send')
      return refuse(abort)
    }
  }

  // ── 4. quiet hours + frequency caps (PROMOTIONAL only) ────────────────
  if (emailClass === 'promotional') {
    if (inQuietHours()) {
      const retryAt = nextAllowedTime()
      l.info({ retryAt }, 'deferred: quiet hours')
      return refuse('quiet_hours', retryAt)
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
      // A cap is a DEFERRAL, not a permanent block — it expires. Give it a due
      // time so the sweep can pick it up rather than losing the email forever.
      const dueIn = capped === 'cap_daily' ? DAY_MS : capped === 'cap_weekly' ? 7 * DAY_MS : 30 * DAY_MS
      l.info({ day, week, month, capped }, 'deferred: frequency cap')
      return refuse(capped, new Date(now + Math.min(dueIn, DAY_MS)))
    }

    const gapMin = CAPS.transactionalGapMinutes
    if (gapMin > 0) {
      const recentTransactional = await prisma.emailSend.count({
        where: {
          email,
          emailClass: 'transactional',
          status: 'delivered',
          sentAt: { gte: new Date(now - gapMin * 60_000) },
        },
      })
      if (recentTransactional > 0) {
        const retryAt = new Date(now + gapMin * 60_000)
        l.info({ gapMin, retryAt }, 'deferred: too close to a transactional email')
        return refuse('transactional_gap', retryAt)
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
        // RETRYABLE by classification: a missing URL or field is a fixable
        // configuration problem, not a permanent property of this customer.
        return refuse(`validation: ${err.message}`)
      }
      throw err
    }
  }

  // ── 6. CLAIM OR RESUME ────────────────────────────────────────────────
  const claim = await claimOrResumeSend(key, input, emailClass)
  if (!claim.ok) {
    l.info({ key, reason: claim.reason }, 'not claiming')
    return { sent: false, reason: claim.reason, emailSendId: claim.id }
  }
  const emailSendId = claim.id

  // ── 7. provider send ──────────────────────────────────────────────────
  const wantsUnsubHeader = input.includeUnsubscribeHeader ?? emailClass === 'promotional'
  const unsub = wantsUnsubHeader ? unsubscribeUrl(email) : null
  const headers = unsub
    ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined

  let data: { id?: string } | null = null
  let providerError: unknown = null
  try {
    const res = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      reply_to: EMAIL_REPLY_TO,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(headers ? { headers } : {}),
    })
    data = res.data
    providerError = res.error
  } catch (err) {
    // The request may or may not have reached the provider. This is the
    // AMBIGUOUS case: never auto-resend, because a duplicate to a real customer
    // is worse than a delayed one. A human reconciles via `ambiguousSends()`.
    await prisma.emailSend
      .update({
        where: { id: emailSendId },
        data: {
          status: 'ambiguous',
          outcomeClass: 'ambiguous',
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        },
      })
      .catch(() => undefined)
    l.error({ err: err instanceof Error ? err.message : String(err) }, 'AMBIGUOUS provider outcome — not auto-resending')
    return { sent: false, reason: 'ambiguous', emailSendId, outcomeClass: 'ambiguous' }
  }

  if (providerError) {
    // A STRUCTURED rejection with no message id: the provider definitively did
    // not accept it, so retrying cannot duplicate anything.
    const message =
      (providerError as { message?: string }).message ?? JSON.stringify(providerError)
    const exhausted = claim.attempts >= MAX_SEND_ATTEMPTS
    await prisma.emailSend
      .update({
        where: { id: emailSendId },
        data: {
          status: exhausted ? 'failed_terminal' : 'provider_rejected',
          outcomeClass: exhausted ? 'terminal' : 'retryable',
          error: String(message).slice(0, 500),
          nextAttemptAt: exhausted ? null : new Date(Date.now() + 60_000 * claim.attempts),
        },
      })
      .catch(() => undefined)
    l.error({ error: message, attempt: claim.attempts, exhausted }, 'provider rejected the send')
    // Throw so BullMQ retries. The row is now resumable, so the retry RESUMES
    // this same logical send instead of short-circuiting as a duplicate.
    throw new Error(`Resend error: ${message}`)
  }

  // ── 8. mark delivered ─────────────────────────────────────────────────
  const providerId = data?.id ?? 'unknown'
  await prisma.emailSend
    .update({
      where: { id: emailSendId },
      data: { status: 'delivered', outcomeClass: 'terminal', providerId, sentAt: new Date(), error: null },
    })
    .catch((err) =>
      // The message IS delivered. Losing the mark is a reporting problem, not a
      // duplicate risk — the row is still non-'delivered' but carries no
      // provider id, so it surfaces in ambiguousSends() for reconciliation.
      l.error({ err: String(err), emailSendId, providerId }, 'send succeeded but marking failed')
    )

  l.info({ providerId }, 'email sent')
  return { sent: true, providerId, emailSendId }
}

/**
 * Sends whose outcome we genuinely do not know. NEVER auto-resent — a human
 * checks the provider dashboard and either marks them delivered or re-drives
 * them deliberately with `reopenForRetry`.
 */
export async function ambiguousSends(limit = 100) {
  return prisma.emailSend.findMany({
    where: { OR: [{ status: 'ambiguous' }, { status: 'delivered', providerId: null }] },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

/** Rows a sweep may legitimately re-attempt, with their due time reached. */
export async function dueForRetry(limit = 100) {
  return prisma.emailSend.findMany({
    where: {
      status: { in: ['provider_rejected', 'retry_pending', 'deferred', 'blocked_retryable'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
}

/**
 * DELIBERATE operator action: re-open a terminal row so it may be attempted
 * again. Refuses 'delivered' — that email reached the customer, and re-sending
 * it is a decision no automated path should be able to make.
 */
export async function reopenForRetry(idempotencyKey: string): Promise<'reopened' | 'refused_delivered' | 'not_found'> {
  const row = await prisma.emailSend.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true },
  })
  if (!row) return 'not_found'
  if (row.status === 'delivered') return 'refused_delivered'
  await prisma.emailSend.update({
    where: { id: row.id },
    data: { status: 'retry_pending', outcomeClass: 'retryable', attempts: 0, nextAttemptAt: null },
  })
  return 'reopened'
}

/**
 * Rows stuck mid-attempt for longer than `olderThanMinutes` — a worker died
 * between the claim and the provider response. Surfaced for a human; the
 * claim logic will also take these over automatically once they go stale.
 */
export async function staleClaims(olderThanMinutes = 30) {
  return prisma.emailSend.findMany({
    where: {
      status: 'sending',
      updatedAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
}
