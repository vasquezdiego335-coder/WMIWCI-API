// ════════════════════════════════════════════════════════════════════════
//  WEBHOOK CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The provider webhook is how this system learns anything at all about what
//  happened after a message left. Without it, `status = 'delivered'` is the
//  last thing we ever know, bounces are invisible, and complaints accumulate
//  until a mailbox provider blocks the sending domain.
//
//  A DELIBERATE ASYMMETRY: silence is treated as a stronger signal than
//  errors. A webhook that fails loudly leaves failed rows to find. A webhook
//  that was never configured, or whose endpoint 503s because the signing
//  secret is missing, leaves NOTHING — and looks exactly like a quiet week.
//  `webhook.silent` exists to make that indistinguishable-from-healthy case
//  distinguishable, and it only fires when there is recent sending to compare
//  against, so a genuinely quiet week stays quiet.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { maskEmail } from '../redact'
import type { AgentFinding } from '../types'
import {
  EVIDENCE_ROW_CAP,
  WEBHOOK_DELAY_MS,
  WEBHOOK_MAX_SIDE_EFFECT_ATTEMPTS,
  countInspected,
  makeFinding,
  minutes,
  plural,
  since,
  windowStart,
  type CheckContext,
  type CheckDefinition,
} from './shared'

/**
 * Is this value REALLY configured?
 *
 * Placeholder-aware. A literal `PASTE_ALERTS_CHANNEL_ID` was previously treated
 * as a real channel id, so the alert path reported itself configured and
 * Discord answered `400 Invalid Form Body`. Unconfigured must LOOK
 * unconfigured, not broken.
 */
const configured = (v?: string): boolean => {
  const t = v?.trim()
  if (!t) return false
  return !/^(REPLACE|PASTE|PUT|ADD|SET|INSERT|YOUR|CHANGE|EXAMPLE|SAMPLE|TODO|XXX)([_-]|$)/i.test(t) && !t.includes('REPLACE')
}

// ── 1. The endpoint cannot verify anything ──────────────────────────────

const secretMissing: CheckDefinition = {
  id: 'webhook.secret_missing',
  category: 'webhook',
  intent: 'RESEND_WEBHOOK_SECRET is not configured, so the webhook endpoint rejects every event.',
  run: async (ctx) => {
    if (configured(process.env.RESEND_WEBHOOK_SECRET)) return []
    return [
      makeFinding(ctx, {
        checkId: 'webhook.secret_missing',
        severity: 'critical',
        category: 'webhook',
        fingerprintParts: ['RESEND_WEBHOOK_SECRET'],
        title: 'The webhook signing secret is not configured',
        description:
          'RESEND_WEBHOOK_SECRET is not set, so /api/email/webhook cannot verify a signature and answers 503 to every provider event. ' +
          'Resend retries for a while and then gives up. While that is true, no bounce and no complaint is ever suppressed, and the sending domain degrades silently.',
        // Presence only — the value is never read into a finding.
        evidence: { variable: 'RESEND_WEBHOOK_SECRET', present: false },
        suggestedActions: ['pauseMarketingDispatch', 'sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 2. Sending with no feedback coming back ─────────────────────────────

const webhookSilent: CheckDefinition = {
  id: 'webhook.silent',
  category: 'webhook',
  intent: 'Email was accepted recently but no provider event arrived — the feedback loop is broken.',
  run: async (ctx) => {
    const from = windowStart(ctx)
    const [accepted, events] = await Promise.all([
      prisma.emailSend.count({ where: { sentAt: { gte: from }, isTest: false } }),
      prisma.emailEvent.count({ where: { occurredAt: { gte: from } } }),
    ])
    countInspected(ctx, 'webhook_events_window', events)
    // Needs something to compare against. Below a handful of sends, "no events"
    // is ordinary; a single send can legitimately produce none for minutes.
    if (accepted < 3) return []
    if (events > 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'webhook.silent',
        severity: 'critical',
        category: 'webhook',
        fingerprintParts: ['webhook_silent'],
        title: 'Email is going out and no provider events are coming back',
        description:
          `${accepted} ${plural(accepted, 'message was', 'messages were')} accepted by the provider in the last ${ctx.windowHours} hours and NOT ONE webhook event arrived. ` +
          `Deliveries, bounces and complaints are all invisible right now. The endpoint is unreachable, unconfigured at the provider, or rejecting every event.`,
        evidence: { windowHours: ctx.windowHours, acceptedSends: accepted, eventsReceived: 0, webhookSecretConfigured: configured(process.env.RESEND_WEBHOOK_SECRET) },
        suggestedActions: ['pauseMarketingDispatch', 'sendDiscordIncidentAlert', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 3. Events that arrive far too late to act on ────────────────────────

const processingDelay: CheckDefinition = {
  id: 'webhook.processing_delay',
  category: 'webhook',
  intent: 'Provider events are being recorded long after the provider says they happened.',
  run: async (ctx) => {
    const rows = await prisma.$queryRaw<Array<{ id: string; type: string; occurred_at: Date; created_at: Date }>>`
      SELECT id, type, occurred_at, created_at
      FROM email_events
      WHERE created_at > occurred_at + INTERVAL '15 minutes'
        AND occurred_at >= ${windowStart(ctx)}
      ORDER BY (created_at - occurred_at) DESC
      LIMIT 20
    `
    countInspected(ctx, 'webhook_delayed_events', rows.length)
    if (rows.length === 0) return []
    const worst = rows[0]
    const worstMs = worst.created_at.getTime() - worst.occurred_at.getTime()
    return [
      makeFinding(ctx, {
        checkId: 'webhook.processing_delay',
        severity: 'warning',
        category: 'webhook',
        webhookEventId: worst.id,
        fingerprintParts: ['processing_delay'],
        title: `${rows.length} provider ${plural(rows.length, 'event', 'events')} arrived late`,
        description:
          `${rows.length} ${plural(rows.length, 'event was', 'events were')} recorded more than ${minutes(WEBHOOK_DELAY_MS)} minutes after the provider says ${plural(rows.length, 'it', 'they')} happened ` +
          `(worst: ${minutes(worstMs)} minutes). A complaint that takes an hour to suppress is an hour in which the next campaign can still mail that person.`,
        evidence: {
          delayed: rows.length,
          worstDelayMinutes: minutes(worstMs),
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            eventId: r.id, type: r.type,
            occurredAt: r.occurred_at.toISOString(), recordedAt: r.created_at.toISOString(),
            delayMinutes: minutes(r.created_at.getTime() - r.occurred_at.getTime()),
          })),
        },
        suggestedActions: ['inspectWebhookEvent'],
      }),
    ]
  },
}

// ── 4. Events that could not be attached to a send ──────────────────────

const unlinkedEvents: CheckDefinition = {
  id: 'webhook.unlinked_event',
  category: 'webhook',
  intent: 'A provider event that references a message this system has no record of.',
  run: async (ctx) => {
    const rows = await prisma.emailEvent.findMany({
      where: { emailSendId: null, occurredAt: { gte: since(ctx, 7 * 24 * 3600_000) } },
      select: { id: true, email: true, type: true, occurredAt: true, processingStatus: true },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    })
    countInspected(ctx, 'webhook_unlinked', rows.length)
    if (rows.length === 0) return []

    // An unlinked DELIVERED event is bookkeeping. An unlinked BOUNCE or
    // COMPLAINT is a real signal about a real address, and it must still reach
    // the suppression list even though we cannot say which send caused it.
    const destructive = rows.filter((r) => ['bounced', 'complained', 'unsubscribed'].includes(r.type))
    return [
      makeFinding(ctx, {
        checkId: 'webhook.unlinked_event',
        severity: destructive.length > 0 ? 'warning' : 'info',
        category: 'webhook',
        webhookEventId: rows[0].id,
        fingerprintParts: ['unlinked_event'],
        title: `${rows.length} provider ${plural(rows.length, 'event', 'events')} could not be matched to a send`,
        description:
          `${rows.length} ${plural(rows.length, 'event', 'events')} in the last 7 days reference a message with no matching send record ` +
          `(${destructive.length} of them ${plural(destructive.length, 'is', 'are')} a bounce, complaint or unsubscribe). ` +
          `Usually this means the send predates provider-id recording, or the message was sent from another system against the same domain.`,
        evidence: {
          total: rows.length,
          destructive: destructive.length,
          byType: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.type]: (acc[r.type] ?? 0) + 1 }), {}),
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ eventId: r.id, email: maskEmail(r.email), type: r.type, at: r.occurredAt.toISOString() })),
        },
        suggestedActions: ['inspectWebhookEvent'],
      }),
    ]
  },
}

// ── 5. An event that keeps failing to process ───────────────────────────

const repeatedFailure: CheckDefinition = {
  id: 'webhook.repeated_processing_failure',
  category: 'webhook',
  intent: 'The same event has failed processing several times — the failure is systematic, not transient.',
  run: async (ctx) => {
    const rows = await prisma.emailEvent.findMany({
      where: {
        sideEffectAttempts: { gte: WEBHOOK_MAX_SIDE_EFFECT_ATTEMPTS },
        processingStatus: { in: ['side_effect_pending', 'side_effect_failed'] },
      },
      select: { id: true, email: true, type: true, sideEffectAttempts: true, sideEffectError: true, occurredAt: true },
      orderBy: { sideEffectAttempts: 'desc' },
      take: 25,
    })
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'webhook.repeated_processing_failure',
        severity: 'critical',
        category: 'webhook',
        webhookEventId: rows[0].id,
        fingerprintParts: ['repeated_processing_failure'],
        title: `${rows.length} provider ${plural(rows.length, 'event keeps', 'events keep')} failing to process`,
        description:
          `${rows.length} ${plural(rows.length, 'event has', 'events have')} been retried at least ${WEBHOOK_MAX_SIDE_EFFECT_ATTEMPTS} times and still ${plural(rows.length, 'has', 'have')} not applied its suppression. ` +
          `Repeated identical failure means the retry will not fix it — the error is in the write path, not in the network. Meanwhile those addresses stay sendable.`,
        evidence: {
          count: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            eventId: r.id, email: maskEmail(r.email), type: r.type,
            attempts: r.sideEffectAttempts, lastError: r.sideEffectError?.slice(0, 200) ?? null,
          })),
        },
        suggestedActions: ['reprocessValidWebhookEvent', 'inspectWebhookEvent', 'sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 6. Delivery events that arrived before their own send event ─────────

const outOfOrderEvents: CheckDefinition = {
  id: 'webhook.out_of_order',
  category: 'webhook',
  intent: 'A delivered event recorded before the sent event for the same message.',
  run: async (ctx) => {
    const rows = await prisma.$queryRaw<Array<{ email_send_id: string; delivered_at: Date; sent_at: Date }>>`
      SELECT d.email_send_id, d.occurred_at AS delivered_at, s.occurred_at AS sent_at
      FROM email_events d
      JOIN email_events s
        ON s.email_send_id = d.email_send_id AND s.type = 'sent'
      WHERE d.type = 'delivered'
        AND d.email_send_id IS NOT NULL
        AND d.occurred_at < s.occurred_at
      ORDER BY d.occurred_at DESC
      LIMIT 20
    `
    countInspected(ctx, 'webhook_ordering_checked', rows.length)
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'webhook.out_of_order',
        severity: 'info',
        category: 'webhook',
        fingerprintParts: ['out_of_order'],
        title: `${rows.length} ${plural(rows.length, 'message', 'messages')} received its delivery event first`,
        description:
          `${rows.length} ${plural(rows.length, 'message has', 'messages have')} a 'delivered' event timestamped before its 'sent' event. ` +
          `Providers do not guarantee order and the delivery-state precedence rules handle it correctly, so nothing is broken — this is recorded so that ` +
          `an odd-looking timeline in the admin has an explanation instead of looking like corruption.`,
        evidence: {
          count: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            sendId: r.email_send_id,
            deliveredEventAt: r.delivered_at.toISOString(),
            sentEventAt: r.sent_at.toISOString(),
          })),
        },
        suggestedActions: ['inspectWebhookEvent'],
      }),
    ]
  },
}

export const webhookChecks: CheckDefinition[] = [
  secretMissing,
  webhookSilent,
  processingDelay,
  unlinkedEvents,
  repeatedFailure,
  outOfOrderEvents,
]
