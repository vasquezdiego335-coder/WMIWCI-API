// ════════════════════════════════════════════════════════════════════════
//  EMAIL PROVIDER EVENTS (Resend → Svix webhooks). Owner spec 2026-07-20.
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES: nothing in this system processed provider feedback. A
//  hard bounce or a spam complaint was invisible, so the pipeline would keep
//  mailing a dead or hostile address indefinitely — the fastest way to lose a
//  sending domain's reputation, and a release blocker for promotional mail.
//
//  Framework-agnostic core (mirrors src/lib/stripe-events.ts) so the Next.js
//  route and any worker run byte-for-byte the same path and cannot drift.
//
//  SIGNATURE VERIFICATION — Resend signs with Svix:
//    signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
//    signature      = base64(HMAC_SHA256(base64decode(secret without 'whsec_'),
//                                        signed content))
//    header `svix-signature` is a space-separated list of `v1,<sig>` pairs
//    (multiple entries during secret rotation — ANY may match).
//  Timestamp tolerance guards replay. Comparison is constant-time.
//
//  IDEMPOTENCY: EmailEvent.providerEventId is UNIQUE, so a duplicate webhook
//  delivery (providers retry aggressively) does not double-record. It does NOT
//  short-circuit: a replay whose SIDE EFFECT never completed is re-driven.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { prisma } from './db'
import { queueLogger } from './logger'
import { normalizeEmail } from './email-tokens'
import { suppress, isSuppressionSettled } from './email-suppression'
import type { SuppressionReason } from '@prisma/client'

const log = queueLogger.child({ mod: 'email-events' })

/** Replay window for a signed webhook, in seconds. */
const TIMESTAMP_TOLERANCE_S = 5 * 60

export type WebhookResult = { status: number; body: Record<string, unknown> }

export type SvixHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

/**
 * Verify a Svix-signed payload. Returns true only on a real match.
 * Fails CLOSED on any malformed input — an unverified event never reaches the
 * suppression list, because a forged "complaint" could silence a real customer.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature || !secret) return false

  // Replay guard.
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(nowSeconds - ts) > TIMESTAMP_TOLERANCE_S) return false

  // The secret is base64 after the 'whsec_' prefix.
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret
  let key: Buffer
  try {
    key = Buffer.from(rawSecret, 'base64')
  } catch {
    return false
  }
  if (key.length === 0) return false

  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')
  const expectedBuf = Buffer.from(expected)

  // Header holds one or more `v1,<sig>` entries (secret rotation). Any match wins.
  for (const entry of signature.split(' ')) {
    const comma = entry.indexOf(',')
    if (comma < 0) continue
    const version = entry.slice(0, comma)
    const sig = entry.slice(comma + 1)
    if (version !== 'v1' || !sig) continue
    const given = Buffer.from(sig)
    if (given.length === expectedBuf.length && crypto.timingSafeEqual(given, expectedBuf)) return true
  }
  return false
}

// ── Event → action mapping ──────────────────────────────────────────────
/**
 * Which Resend event types suppress an address, and why.
 *
 * `email.bounced` covers BOTH hard and soft bounces. Only a HARD bounce means
 * the address does not exist — a soft bounce (full mailbox, temporary outage)
 * must NOT suppress a real customer, so the bounce sub-type is inspected below.
 */
const SUPPRESSING: Record<string, SuppressionReason> = {
  'email.bounced': 'HARD_BOUNCE',
  'email.complained': 'SPAM_COMPLAINT',
}

/** Resend event type → our EmailEvent.type. */
const EVENT_TYPES: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
}

type ResendEvent = {
  type?: string
  created_at?: string
  data?: {
    email_id?: string
    to?: string[] | string
    bounce?: { type?: string; subType?: string }
    [k: string]: unknown
  }
  [k: string]: unknown
}

/** Is this bounce permanent? Only permanent bounces suppress. */
export function isHardBounce(bounce: { type?: string; subType?: string } | undefined): boolean {
  const type = (bounce?.type ?? '').toLowerCase()
  const sub = (bounce?.subType ?? '').toLowerCase()
  if (type === 'transient' || type === 'soft') return false
  if (sub === 'mailboxfull' || sub === 'messagetoolarge' || sub === 'contentrejected') return false
  // Resend reports 'Permanent' for real dead addresses. An UNKNOWN type is
  // treated as NOT hard — we would rather keep mailing a questionable address
  // than silently drop a paying customer on ambiguous provider data.
  return type === 'permanent' || sub === 'general' || sub === 'nosuchuser' || sub === 'suppressed'
}

const firstRecipient = (to: string[] | string | undefined): string | null => {
  if (!to) return null
  const value = Array.isArray(to) ? to[0] : to
  return value ? normalizeEmail(value) : null
}

// ════════════════════════════════════════════════════════════════════════
//  EVENT HANDLING — record, then APPLY, then report (finding EMAIL-P0-01)
//  ---------------------------------------------------------------------
//  THE DEFECT THIS REPLACES: the handler inserted the EmailEvent row, called
//  `suppress()` and DISCARDED its result, then returned a success string. The
//  webhook answered HTTP 200. Because `suppress()` swallowed database errors and
//  because providerEventId is UNIQUE, a failed suppression meant:
//    • the provider considered the event delivered and stopped retrying;
//    • a replay of the same event hit the unique key and short-circuited as
//      'duplicate' WITHOUT re-attempting the suppression;
//    • the bounced/complaining address stayed sendable, permanently, silently.
//
//  NOW: an event that REQUIRES a suppression is written as
//  'side_effect_pending' FIRST, the suppression is attempted, and only a
//  CONFIRMED write flips it to 'processed'. Anything else stays
//  'side_effect_failed' and the caller is told, so the webhook returns a
//  retriable status and `retryPendingSideEffects()` can sweep it later.
//  A replayed event whose side effect is unfinished is RE-DRIVEN, not skipped.
// ════════════════════════════════════════════════════════════════════════

/** Outcome of handling one provider event. `settled: false` ⇒ retry me. */
export type EventOutcome = {
  result: string
  /** true when nothing further is required for this event. */
  settled: boolean
}

const settled = (result: string): EventOutcome => ({ result, settled: true })
const unsettled = (result: string): EventOutcome => ({ result, settled: false })

/** Max side-effect attempts before an event is parked for a human. */
export const MAX_SIDE_EFFECT_ATTEMPTS = 5

/**
 * Apply the suppression a bounce/complaint implies, and record the outcome on
 * the event row. Returns whether the event is fully settled.
 */
async function applySuppressionSideEffect(
  eventId: string,
  input: { email: string; reason: SuppressionReason; detail?: string },
  attemptsSoFar: number
): Promise<EventOutcome> {
  const outcome = await suppress({
    email: input.email,
    reason: input.reason,
    source: 'resend-webhook',
    detail: input.detail,
  })

  if (isSuppressionSettled(outcome)) {
    await prisma.emailEvent
      .update({
        where: { id: eventId },
        data: { processingStatus: 'processed', sideEffectAttempts: attemptsSoFar + 1, sideEffectError: null },
      })
      .catch((err) =>
        // The suppression IS written — the safety-critical part succeeded.
        // Losing the bookkeeping only means the sweep may retry a no-op, which
        // is harmless because suppress() is idempotent.
        log.error({ err: String(err), eventId }, 'suppression applied but event bookkeeping failed')
      )
    return settled(`suppressed:${input.reason}`)
  }

  const attempts = attemptsSoFar + 1
  const exhausted = attempts >= MAX_SIDE_EFFECT_ATTEMPTS
  const message =
    outcome.status === 'write_failed'
      ? outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error)
      : `unexpected suppression outcome: ${outcome.status}`

  await prisma.emailEvent
    .update({
      where: { id: eventId },
      data: {
        processingStatus: exhausted ? 'dead_letter' : 'side_effect_failed',
        sideEffectAttempts: attempts,
        sideEffectError: message.slice(0, 500),
      },
    })
    .catch((err) => log.error({ err: String(err), eventId }, 'could not record failed side effect'))

  log.error(
    { eventId, attempts, exhausted, reason: input.reason },
    'SUPPRESSION SIDE EFFECT FAILED — recipient may still be sendable'
  )
  // Exhausted → stop asking the provider to retry; a human must act. The row is
  // recorded as dead_letter and surfaced by pendingSideEffects().
  return exhausted ? settled('dead_letter') : unsettled('side_effect_failed')
}

/**
 * Handle ONE verified provider event.
 * Idempotent on providerEventId, and — critically — a REPLAY of an event whose
 * side effect never completed re-drives that side effect instead of skipping it.
 * Never throws.
 */
export async function handleEmailEvent(event: ResendEvent, svixId: string): Promise<EventOutcome> {
  const resendType = event.type ?? 'unknown'
  const mappedType = EVENT_TYPES[resendType]
  if (!mappedType) {
    log.info({ resendType }, 'ignoring unmapped provider event')
    return settled('ignored')
  }

  const email = firstRecipient(event.data?.to)
  if (!email) {
    log.warn({ resendType }, 'provider event carried no recipient — ignoring')
    return settled('no_recipient')
  }

  // Does this event REQUIRE a suppression? A soft bounce does not.
  const reason = SUPPRESSING[resendType]
  const needsSuppression =
    Boolean(reason) && !(resendType === 'email.bounced' && !isHardBounce(event.data?.bounce))

  // Correlate to the send we recorded, when we can.
  const providerId = event.data?.email_id
  const emailSend = providerId
    ? await prisma.emailSend.findFirst({ where: { providerId }, select: { id: true } }).catch(() => null)
    : null

  const occurredAtRaw = event.created_at ? new Date(event.created_at) : new Date()
  const occurredAt = Number.isNaN(occurredAtRaw.getTime()) ? new Date() : occurredAtRaw
  const detail = JSON.stringify(event.data ?? {}).slice(0, 1000)
  const bounceDetail = JSON.stringify(event.data?.bounce ?? {}).slice(0, 500)

  let eventRow: { id: string; sideEffectAttempts: number }
  try {
    eventRow = await prisma.emailEvent.create({
      data: {
        providerEventId: svixId,
        emailSendId: emailSend?.id ?? null,
        email,
        type: mappedType,
        detail,
        occurredAt,
        // Written BEFORE the attempt, so a crash mid-suppression stays visible.
        processingStatus: needsSuppression ? 'side_effect_pending' : 'processed',
      },
      select: { id: true, sideEffectAttempts: true },
    })
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      // DUPLICATE DELIVERY. This is exactly where the old code gave up. Check
      // whether the original event's side effect actually completed.
      const existing = await prisma.emailEvent
        .findUnique({
          where: { providerEventId: svixId },
          select: { id: true, processingStatus: true, sideEffectAttempts: true },
        })
        .catch(() => null)

      if (!existing) return unsettled('duplicate_lookup_failed')
      if (existing.processingStatus === 'processed') {
        log.info({ svixId }, 'duplicate webhook delivery — already fully processed')
        return settled('duplicate')
      }
      if (existing.processingStatus === 'dead_letter') {
        log.warn({ svixId }, 'duplicate delivery for a dead-lettered event — needs a human')
        return settled('dead_letter')
      }
      if (!needsSuppression) {
        await prisma.emailEvent
          .update({ where: { id: existing.id }, data: { processingStatus: 'processed' } })
          .catch(() => undefined)
        return settled('duplicate')
      }
      log.warn({ svixId, state: existing.processingStatus }, 'duplicate delivery — RETRYING unfinished side effect')
      return applySuppressionSideEffect(
        existing.id,
        { email, reason: reason as SuppressionReason, detail: bounceDetail },
        existing.sideEffectAttempts
      )
    }

    log.error({ err: String(err), resendType }, 'failed to record email event')
    // We could not even record it — ask the provider to send it again.
    return unsettled('record_failed')
  }

  if (!needsSuppression) {
    if (reason) {
      // A soft bounce: recorded for signal, deliberately NOT suppressed.
      log.info({ type: mappedType }, 'soft bounce — recorded, NOT suppressed')
      return settled('soft_bounce')
    }
    return settled('recorded')
  }

  return applySuppressionSideEffect(
    eventRow.id,
    { email, reason: reason as SuppressionReason, detail: bounceDetail },
    eventRow.sideEffectAttempts
  )
}

/**
 * Retry sweep for events whose suppression never completed. Safe to run on a
 * schedule: `suppress()` is idempotent, so a retry that turns out to be
 * unnecessary simply settles the row.
 *
 * This is the second half of the P0-01 guarantee: even if the provider stops
 * retrying the webhook, an unfinished suppression is still driven to completion.
 */
export async function retryPendingSideEffects(limit = 50): Promise<{ attempted: number; settled: number }> {
  const rows = await prisma.emailEvent
    .findMany({
      where: { processingStatus: { in: ['side_effect_pending', 'side_effect_failed'] } },
      orderBy: { occurredAt: 'asc' },
      take: limit,
      select: { id: true, email: true, type: true, detail: true, sideEffectAttempts: true },
    })
    .catch(() => [] as Array<{ id: string; email: string; type: string; detail: string | null; sideEffectAttempts: number }>)

  let done = 0
  for (const row of rows) {
    // Re-derive the reason from the RECORDED event type, never from the raw
    // payload — an old row may not have kept it.
    const reason: SuppressionReason | null =
      row.type === 'bounced' ? 'HARD_BOUNCE' : row.type === 'complained' ? 'SPAM_COMPLAINT' : null
    if (!reason) {
      await prisma.emailEvent
        .update({ where: { id: row.id }, data: { processingStatus: 'processed' } })
        .catch(() => undefined)
      done++
      continue
    }
    const outcome = await applySuppressionSideEffect(
      row.id,
      { email: row.email, reason, detail: row.detail ?? undefined },
      row.sideEffectAttempts
    )
    if (outcome.settled) done++
  }
  return { attempted: rows.length, settled: done }
}

/** Events needing a human. Surfaced to operations. */
export async function pendingSideEffects(limit = 100) {
  return prisma.emailEvent.findMany({
    where: { processingStatus: { in: ['side_effect_failed', 'dead_letter'] } },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  })
}

/**
 * Full webhook entry point: verify → parse → handle. Returns an HTTP shape.
 *
 * STATUS SEMANTICS (finding EMAIL-P0-01):
 *   200 — consumed AND every required side effect is settled
 *   500 — recorded, but a required suppression did NOT complete. The provider
 *         MUST retry. Returning 200 here is precisely the bug being fixed.
 *   400 — unverifiable or unparseable; retrying will never help
 *   503 — not configured
 */
export async function processEmailWebhook(rawBody: string, headers: SvixHeaders): Promise<WebhookResult> {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim()

  if (!secret) {
    // Unsigned acceptance is never safe: a forged complaint would suppress a
    // real customer. Refuse loudly rather than trusting the internet.
    log.error('RESEND_WEBHOOK_SECRET is not set — refusing to process email webhooks')
    return { status: 503, body: { ok: false, error: 'webhook_not_configured' } }
  }

  if (!verifySvixSignature(rawBody, headers, secret)) {
    log.warn({ svixId: headers.id }, 'email webhook signature verification FAILED')
    return { status: 400, body: { ok: false, error: 'invalid_signature' } }
  }

  let event: ResendEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json' } }
  }

  const outcome = await handleEmailEvent(event, headers.id as string)

  if (!outcome.settled) {
    // Do NOT report success. The provider retry is a load-bearing part of the
    // guarantee that a bounced address actually gets suppressed.
    return { status: 500, body: { ok: false, result: outcome.result, retry: true } }
  }
  return { status: 200, body: { ok: true, result: outcome.result } }
}
