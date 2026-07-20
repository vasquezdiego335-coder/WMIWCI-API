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
//  delivery (providers retry aggressively) writes nothing and reports handled.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { prisma } from './db'
import { queueLogger } from './logger'
import { normalizeEmail } from './email-tokens'
import { suppress } from './email-suppression'
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

/**
 * Handle ONE verified provider event. Idempotent on providerEventId.
 * Never throws — a throw would make the provider retry a poisoned event forever.
 */
export async function handleEmailEvent(event: ResendEvent, svixId: string): Promise<string> {
  const resendType = event.type ?? 'unknown'
  const mappedType = EVENT_TYPES[resendType]
  if (!mappedType) {
    log.info({ resendType }, 'ignoring unmapped provider event')
    return 'ignored'
  }

  const email = firstRecipient(event.data?.to)
  if (!email) {
    log.warn({ resendType }, 'provider event carried no recipient — ignoring')
    return 'no_recipient'
  }

  // Correlate to the send we recorded, when we can (provider id set at step 8
  // of guardedSend). Absent correlation is fine — the event still counts.
  const providerId = event.data?.email_id
  const emailSend = providerId
    ? await prisma.emailSend.findFirst({ where: { providerId }, select: { id: true } }).catch(() => null)
    : null

  const occurredAt = event.created_at ? new Date(event.created_at) : new Date()

  try {
    await prisma.emailEvent.create({
      data: {
        // Svix guarantees a unique message id per delivery attempt group, so this
        // is the natural dedupe key for retried deliveries of the SAME event.
        providerEventId: svixId,
        emailSendId: emailSend?.id ?? null,
        email,
        type: mappedType,
        detail: JSON.stringify(event.data ?? {}).slice(0, 1000),
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      },
    })
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      log.info({ svixId }, 'duplicate webhook delivery — already recorded')
      return 'duplicate'
    }
    log.error({ err: String(err), resendType }, 'failed to record email event')
    return 'record_failed'
  }

  // ── Suppression side effects ──────────────────────────────────────────
  const reason = SUPPRESSING[resendType]
  if (reason) {
    if (resendType === 'email.bounced' && !isHardBounce(event.data?.bounce)) {
      log.info({ email: '[redacted]' }, 'soft bounce — recorded, NOT suppressed')
      return 'soft_bounce'
    }
    await suppress({
      email,
      reason,
      source: 'resend-webhook',
      detail: JSON.stringify(event.data?.bounce ?? {}).slice(0, 500),
    })
    return `suppressed:${reason}`
  }

  return 'recorded'
}

/**
 * Full webhook entry point: verify → parse → handle. Returns an HTTP shape.
 * A 200 for anything we successfully consumed (including duplicates), 400 for
 * an unverified or unparseable body — never a 500 that makes Resend retry a
 * permanently broken payload.
 */
export async function processEmailWebhook(rawBody: string, headers: SvixHeaders): Promise<WebhookResult> {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim()

  if (!secret) {
    // Unsigned acceptance is never safe: a forged complaint would suppress a
    // real customer. Refuse loudly rather than silently trusting the internet.
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

  const result = await handleEmailEvent(event, headers.id as string)
  return { status: 200, body: { ok: true, result } }
}
