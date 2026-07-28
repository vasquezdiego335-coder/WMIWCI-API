// ════════════════════════════════════════════════════════════════════════
//  PROVIDER CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Everything about the relationship with Resend and with the mailbox
//  providers beyond it. The numbers in this file are not preferences: a
//  complaint rate above ~0.3% gets a sending domain throttled or blocked at
//  Gmail and Microsoft, and undoing that takes weeks. So the alert fires far
//  below the danger line, and the thresholds are shared with the existing
//  monitoring module rather than re-picked here — a dashboard that disagrees
//  with the alerts is worse than either alone.
//
//  RATES NEED A DENOMINATOR. One complaint out of two sends is 50% and means
//  nothing. Below RATE_MIN_SAMPLE the rate is reported as information and
//  never as an alert, because a monitor that panics at low volume gets muted
//  before it ever sees high volume.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { liveDnsChecks, senderDomain } from '../../email-dns'
import { safeErrorMessage } from '../redact'
import type { AgentFinding } from '../types'
import {
  BOUNCE_RATE_CRITICAL,
  BOUNCE_RATE_WARN,
  COMPLAINT_RATE_CRITICAL,
  COMPLAINT_RATE_WARN,
  DELIVERY_SILENCE_MS,
  EVIDENCE_ROW_CAP,
  RATE_MIN_SAMPLE,
  countInspected,
  makeFinding,
  minutes,
  pct,
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

// ── 1. Credentials and sender identity ──────────────────────────────────

const providerConfig: CheckDefinition = {
  id: 'provider.configuration',
  category: 'provider',
  intent: 'The API key or verified sender address is missing, so nothing can be sent at all.',
  run: async (ctx) => {
    const missing: string[] = []
    if (!configured(process.env.RESEND_API_KEY)) missing.push('RESEND_API_KEY')
    if (!configured(process.env.EMAIL_FROM)) missing.push('EMAIL_FROM')
    if (missing.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'provider.configuration',
        severity: 'critical',
        category: 'provider',
        fingerprintParts: ['provider_config', ...missing],
        title: 'The email provider is not fully configured',
        description:
          `${missing.join(' and ')} ${plural(missing.length, 'is', 'are')} not set. Without ${plural(missing.length, 'it', 'them')} every send fails at the provider call — ` +
          `including transactional email, which customers are waiting for.`,
        // Names only. A finding never carries the value of a credential.
        evidence: { missingVariables: missing, note: 'Presence only — values are never recorded.' },
        suggestedActions: ['sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 2. Complaint rate ───────────────────────────────────────────────────

const complaintRate: CheckDefinition = {
  id: 'provider.complaint_rate',
  category: 'provider',
  intent: 'The share of delivered mail that recipients marked as spam — the number that gets a domain blocked.',
  run: async (ctx) => {
    const from = windowStart(ctx)
    const [complaints, accepted] = await Promise.all([
      prisma.emailEvent.count({ where: { type: 'complained', occurredAt: { gte: from } } }),
      prisma.emailSend.count({ where: { status: 'delivered', isTest: false, sentAt: { gte: from } } }),
    ])
    countInspected(ctx, 'sends_rate_window', accepted)
    if (accepted === 0) return []
    const rate = complaints / accepted

    if (accepted < RATE_MIN_SAMPLE) {
      if (complaints === 0) return []
      return [
        makeFinding(ctx, {
          checkId: 'provider.complaint_rate',
          severity: 'info',
          category: 'provider',
          fingerprintParts: ['complaint_rate_low_volume'],
          title: 'A spam complaint was received at low volume',
          description:
            `${complaints} spam ${plural(complaints, 'complaint', 'complaints')} against ${accepted} delivered ${plural(accepted, 'message', 'messages')} in ${ctx.windowHours} hours. ` +
            `That is too small a sample to compute a meaningful rate, but a complaint at this volume is still worth reading — one person deliberately marked the mail as spam.`,
          evidence: { complaints, accepted, windowHours: ctx.windowHours, minimumSampleForRate: RATE_MIN_SAMPLE },
          suggestedActions: ['inspectCampaign'],
        }),
      ]
    }
    if (rate < COMPLAINT_RATE_WARN) return []
    const critical = rate >= COMPLAINT_RATE_CRITICAL
    return [
      makeFinding(ctx, {
        checkId: 'provider.complaint_rate',
        severity: critical ? 'critical' : 'warning',
        category: 'provider',
        fingerprintParts: ['complaint_rate'],
        title: `Spam complaint rate is ${pct(rate)}`,
        description:
          `${complaints} of ${accepted} delivered messages in the last ${ctx.windowHours} hours were marked as spam (${pct(rate)}). ` +
          (critical
            ? 'This is at or above the level where Gmail and Microsoft throttle or block a sending domain, and recovering takes weeks. Sending should stop now.'
            : `Three times this level gets the domain blocked. The threshold exists to give warning while there is still time to act.`),
        evidence: { complaints, accepted, rate, warnAt: COMPLAINT_RATE_WARN, criticalAt: COMPLAINT_RATE_CRITICAL, windowHours: ctx.windowHours },
        suggestedActions: critical ? ['pauseMarketingDispatch', 'sendDiscordIncidentAlert'] : ['inspectCampaign', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 3. Hard bounce rate ─────────────────────────────────────────────────

const bounceRate: CheckDefinition = {
  id: 'provider.bounce_rate',
  category: 'provider',
  intent: 'The share of mail sent to addresses that do not exist — a measure of list quality.',
  run: async (ctx) => {
    const from = windowStart(ctx)
    const [bounces, accepted] = await Promise.all([
      prisma.emailSend.count({ where: { bouncedAt: { gte: from }, isTest: false } }),
      prisma.emailSend.count({ where: { status: 'delivered', isTest: false, sentAt: { gte: from } } }),
    ])
    if (accepted < RATE_MIN_SAMPLE || bounces === 0) return []
    const rate = bounces / accepted
    if (rate < BOUNCE_RATE_WARN) return []
    const critical = rate >= BOUNCE_RATE_CRITICAL
    return [
      makeFinding(ctx, {
        checkId: 'provider.bounce_rate',
        severity: critical ? 'critical' : 'warning',
        category: 'provider',
        fingerprintParts: ['bounce_rate'],
        title: `Hard-bounce rate is ${pct(rate)}`,
        description:
          `${bounces} of ${accepted} messages in the last ${ctx.windowHours} hours hard-bounced (${pct(rate)}). ` +
          (critical
            ? 'At this level mailbox providers treat the sender as somebody mailing a purchased list. The audience contains addresses that were never validated.'
            : 'The audience source is worth checking before the next campaign.'),
        evidence: { bounces, accepted, rate, warnAt: BOUNCE_RATE_WARN, criticalAt: BOUNCE_RATE_CRITICAL, windowHours: ctx.windowHours },
        suggestedActions: critical ? ['pauseMarketingDispatch', 'createApprovalRequest'] : ['inspectCampaign'],
      }),
    ]
  },
}

// ── 4. Rejection and failure rates ──────────────────────────────────────

const failureRate: CheckDefinition = {
  id: 'provider.failure_rate',
  category: 'provider',
  intent: 'The provider is refusing or failing a meaningful share of attempts.',
  run: async (ctx) => {
    const from = windowStart(ctx)
    const grouped = await prisma.emailSend.groupBy({
      by: ['status'],
      where: { createdAt: { gte: from }, isTest: false },
      _count: { _all: true },
    })
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]))
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    countInspected(ctx, 'sends_window', total)
    if (total < RATE_MIN_SAMPLE) return []

    const rejected = (counts.provider_rejected ?? 0) + (counts.failed_terminal ?? 0)
    if (rejected === 0) return []
    const rate = rejected / total
    if (rate < 0.1) return []

    const examples = await prisma.emailSend.findMany({
      where: { createdAt: { gte: from }, isTest: false, status: { in: ['provider_rejected', 'failed_terminal'] } },
      select: { id: true, status: true, error: true, template: true },
      take: EVIDENCE_ROW_CAP,
    })
    return [
      makeFinding(ctx, {
        checkId: 'provider.failure_rate',
        severity: rate >= 0.25 ? 'critical' : 'warning',
        category: 'provider',
        fingerprintParts: ['failure_rate'],
        title: `The provider rejected or failed ${pct(rate)} of attempts`,
        description:
          `${rejected} of ${total} send attempts in the last ${ctx.windowHours} hours were rejected by the provider or ended as terminal failures (${pct(rate)}). ` +
          `At this share the cause is systematic — a credential, a sender-domain problem, or a rate limit — not individual bad addresses.`,
        evidence: {
          rejected,
          total,
          rate,
          statusBreakdown: counts,
          // Provider error text is redacted on the way in; it can contain ids.
          sampleErrors: examples.map((e) => ({ sendId: e.id, status: e.status, template: e.template, error: e.error ? safeErrorMessage(e.error, 160) : null })),
        },
        suggestedActions: ['pauseMarketingDispatch', 'inspectEmailSend', 'sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 5. Accepted but never delivered ─────────────────────────────────────

const deliverySilence: CheckDefinition = {
  id: 'provider.delivery_silence',
  category: 'provider',
  intent: 'Messages the provider accepted an hour ago with no delivery, bounce or complaint since.',
  run: async (ctx) => {
    // Windowed to the last 24 hours ON PURPOSE. Delivery-state columns are
    // newer than the send table, so historical rows legitimately have no
    // deliveredAt and would otherwise produce a permanent false alarm.
    const from = windowStart(ctx)
    const cutoff = since(ctx, DELIVERY_SILENCE_MS)
    const rows = await prisma.emailSend.findMany({
      where: {
        isTest: false,
        status: 'delivered',
        sentAt: { gte: from, lt: cutoff },
        deliveredAt: null,
        bouncedAt: null,
        complainedAt: null,
      },
      select: { id: true, template: true, sentAt: true, providerId: true, campaignId: true },
      orderBy: { sentAt: 'asc' },
      take: 50,
    })
    if (rows.length === 0) return []
    // If NOTHING in the window has a delivery signal, the webhook family
    // already owns that story; this check is about a partial gap.
    const withSignal = await prisma.emailSend.count({
      where: { isTest: false, sentAt: { gte: from }, OR: [{ deliveredAt: { not: null } }, { bouncedAt: { not: null } }] },
    })
    if (withSignal === 0) return []

    return [
      makeFinding(ctx, {
        checkId: 'provider.delivery_silence',
        severity: 'warning',
        category: 'provider',
        sendId: rows[0].id,
        fingerprintParts: ['delivery_silence'],
        title: `${rows.length} accepted ${plural(rows.length, 'message has', 'messages have')} no delivery outcome`,
        description:
          `${rows.length} ${plural(rows.length, 'message', 'messages')} accepted by the provider over ${minutes(DELIVERY_SILENCE_MS)} minutes ago ${plural(rows.length, 'has', 'have')} no delivered, bounced or complained event. ` +
          `Other messages in the same window did report back, so the webhook is working — these specific ones are either delayed at the mailbox provider or were dropped silently.`,
        evidence: {
          silent: rows.length,
          othersWithSignal: withSignal,
          oldestMinutes: minutes(ctx.now.getTime() - rows[0].sentAt!.getTime()),
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ sendId: r.id, template: r.template, sentAt: r.sentAt?.toISOString() ?? null, hasProviderId: r.providerId !== null })),
        },
        suggestedActions: ['inspectEmailSend', 'inspectWebhookEvent'],
      }),
    ]
  },
}

// ── 6. Sender-domain authentication ─────────────────────────────────────

const dnsAuthentication: CheckDefinition = {
  id: 'provider.dns_authentication',
  category: 'provider',
  intent: 'SPF, DKIM or DMARC is missing or invalid for the sending domain.',
  emits: ['provider.dns_authentication', 'provider.dns_unreachable'],
  run: async (ctx) => {
    const domain = senderDomain()
    if (!domain) return []
    let result: Awaited<ReturnType<typeof liveDnsChecks>>
    try {
      result = await liveDnsChecks()
    } catch (err) {
      // A DNS lookup failure is a fact about the network, not about the domain.
      // Reporting it as a broken SPF record would be a lie.
      return [
        makeFinding(ctx, {
          checkId: 'provider.dns_unreachable',
          severity: 'info',
          category: 'provider',
          fingerprintParts: ['dns_unreachable'],
          title: 'The sender-domain DNS check could not run',
          description: `DNS records for ${domain} could not be looked up: ${safeErrorMessage(err, 160)}. This says nothing about whether the records are correct.`,
          evidence: { domain, error: safeErrorMessage(err, 200) },
          suggestedActions: [],
        }),
      ]
    }
    const bad = result.checks.filter((c) => c.status === 'MISSING' || c.status === 'INVALID')
    if (bad.length === 0) return []
    // SPF and DKIM decide whether mail is authenticated at all; DMARC missing is
    // a weakness rather than an immediate deliverability failure.
    const severity = bad.some((c) => /dkim|spf/i.test(c.name)) ? 'critical' : 'warning'
    return [
      makeFinding(ctx, {
        checkId: 'provider.dns_authentication',
        severity,
        category: 'provider',
        fingerprintParts: ['dns_authentication', ...bad.map((b) => b.name).sort()],
        title: `Sender authentication is incomplete for ${result.domain}`,
        description:
          `${bad.map((b) => `${b.name}: ${b.status}`).join(', ')} on ${result.domain}. ` +
          `Mailbox providers use these records to decide whether mail from this domain is genuine; missing ones send a growing share of it straight to spam.`,
        evidence: { domain: result.domain, checks: result.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail.slice(0, 200) })) },
        suggestedActions: ['createApprovalRequest'],
      }),
    ]
  },
}

export const providerChecks: CheckDefinition[] = [
  providerConfig,
  complaintRate,
  bounceRate,
  failureRate,
  deliverySilence,
  dnsAuthentication,
]
