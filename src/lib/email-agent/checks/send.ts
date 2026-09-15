// ════════════════════════════════════════════════════════════════════════
//  INDIVIDUAL-SEND CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  EmailSend is the canonical delivery ledger: one row per logical send, with
//  an idempotency key that is the exactly-once guarantee. The checks here look
//  for rows whose state cannot be true, or which are stuck in a state nothing
//  will move them out of.
//
//  ONE DISTINCTION RUNS THROUGH ALL OF THEM. `status = 'delivered'` means THE
//  PROVIDER ACCEPTED THE API CALL. `deliveredAt` means a webhook later said it
//  reached an inbox. Those are different facts, they arrive at different times,
//  and they arrive OUT OF ORDER. A check that conflates them reports a healthy
//  send as broken every time a webhook is slow — so every timing check here is
//  windowed, and the ordering check names webhook ordering explicitly rather
//  than blaming the send.
//
//  `isTest` rows are excluded from anything that resembles a rate or a
//  customer-impact claim: rehearsing a template must never move a marketing
//  number or raise an incident about a customer who does not exist.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { MAX_SEND_ATTEMPTS as GUARD_MAX_ATTEMPTS, classifyBlock } from '../../email-guard'
import { maskEmail } from '../redact'
import type { AgentFinding } from '../types'
import {
  EVIDENCE_ROW_CAP,
  RETRY_OVERDUE_MS,
  SEND_INFLIGHT_STALE_MS,
  STRUCTURAL_WINDOW_DAYS,
  ageMs,
  countInspected,
  hours,
  makeFinding,
  minutes,
  plural,
  since,
  type CheckContext,
  type CheckDefinition,
} from './shared'

const structuralSince = (ctx: CheckContext) => since(ctx, STRUCTURAL_WINDOW_DAYS * 24 * 3600_000)

/** Statuses in which a send is neither finished nor waiting for a scheduled retry. */
const IN_FLIGHT = ['sending']
/** Statuses that are explicitly waiting for another attempt. */
const AWAITING_RETRY = ['retry_pending', 'blocked_retryable', 'deferred', 'provider_rejected']

// ── 1. A send stuck mid-attempt ─────────────────────────────────────────

const inFlightStale: CheckDefinition = {
  id: 'send.inflight_stale',
  category: 'send',
  intent: 'A send left mid-attempt long enough that its worker is gone and the outcome is unknown.',
  run: async (ctx) => {
    const cutoff = since(ctx, SEND_INFLIGHT_STALE_MS)
    const rows = await prisma.emailSend.findMany({
      where: { status: { in: IN_FLIGHT }, updatedAt: { lt: cutoff } },
      select: { id: true, email: true, template: true, campaignId: true, attempts: true, updatedAt: true, createdAt: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    })
    countInspected(ctx, 'sends_inflight', rows.length)
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'send.inflight_stale',
        severity: 'warning',
        category: 'send',
        sendId: rows[0].id,
        fingerprintParts: ['inflight_stale'],
        title: `${rows.length} ${plural(rows.length, 'send is', 'sends are')} stuck mid-attempt`,
        description:
          `${rows.length} ${plural(rows.length, 'send has', 'sends have')} been in 'sending' for over ${minutes(SEND_INFLIGHT_STALE_MS)} minutes. ` +
          `The request left this system and no outcome came back, so we cannot say whether the customer received it. These are never resent automatically.`,
        evidence: {
          stuck: rows.length,
          oldestMinutes: minutes(ageMs(ctx, rows[0].updatedAt)),
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ sendId: r.id, email: maskEmail(r.email), template: r.template, attempts: r.attempts })),
        },
        suggestedActions: ['inspectEmailSend', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 2. A retry that is due and is not happening ─────────────────────────

const retryOverdue: CheckDefinition = {
  id: 'send.retry_overdue',
  category: 'send',
  intent: 'A send awaiting a retry whose due time passed long ago — the retry sweep is not reaching it.',
  emits: ['send.retry_overdue', 'send.permanent_marked_retryable'],
  run: async (ctx) => {
    const cutoff = since(ctx, RETRY_OVERDUE_MS)
    const rows = await prisma.emailSend.findMany({
      where: {
        status: { in: AWAITING_RETRY },
        isTest: false,
        createdAt: { gte: structuralSince(ctx) },
        OR: [{ nextAttemptAt: { lt: cutoff } }, { nextAttemptAt: null, updatedAt: { lt: cutoff } }],
      },
      select: {
        id: true, email: true, template: true, emailClass: true, status: true, attempts: true,
        blockedReason: true, nextAttemptAt: true, updatedAt: true, campaignId: true, error: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    })
    countInspected(ctx, 'sends_awaiting_retry', rows.length)
    if (rows.length === 0) return []

    // Split by whether the block reason is genuinely transient. A permanently
    // blocked row sitting in a retryable status is a different problem from a
    // transient one nothing is picking up, and merging them would hide both.
    const transient = rows.filter((r) => !r.blockedReason || classifyBlock(r.blockedReason) === 'retryable')
    const misclassified = rows.filter((r) => r.blockedReason && classifyBlock(r.blockedReason) === 'terminal')

    const findings: AgentFinding[] = []
    if (transient.length > 0) {
      findings.push(
        makeFinding(ctx, {
          checkId: 'send.retry_overdue',
          severity: 'warning',
          category: 'send',
          sendId: transient[0].id,
          fingerprintParts: ['retry_overdue'],
          title: `${transient.length} ${plural(transient.length, 'send is', 'sends are')} overdue for a retry`,
          description:
            `${transient.length} ${plural(transient.length, 'send was', 'sends were')} held for a temporary reason and their retry time passed over ${minutes(RETRY_OVERDUE_MS)} minutes ago without another attempt. ` +
            `A legitimate email is sitting undelivered — usually because the retry sweep is not running, or the condition that blocked it was never fixed.`,
          evidence: {
            overdue: transient.length,
            examples: transient.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
              sendId: r.id, email: maskEmail(r.email), template: r.template, status: r.status,
              blockedReason: r.blockedReason, attempts: r.attempts,
              dueAt: r.nextAttemptAt?.toISOString() ?? null,
              minutesOverdue: minutes(ageMs(ctx, r.nextAttemptAt ?? r.updatedAt)),
            })),
          },
          suggestedActions: ['inspectEmailSend', 'retryTransientSendOnce'],
        })
      )
    }
    if (misclassified.length > 0) {
      findings.push(
        makeFinding(ctx, {
          checkId: 'send.permanent_marked_retryable',
          severity: 'warning',
          category: 'send',
          sendId: misclassified[0].id,
          fingerprintParts: ['permanent_marked_retryable'],
          title: `${misclassified.length} permanently blocked ${plural(misclassified.length, 'send is', 'sends are')} queued for retry`,
          description:
            `${misclassified.length} ${plural(misclassified.length, 'send', 'sends')} carry a block reason that is permanent for this customer ` +
            `(${Array.from(new Set(misclassified.map((r) => r.blockedReason))).slice(0, 5).join(', ')}) but sit in a retryable status. ` +
            `They will be re-attempted and refused forever, which wastes attempts and hides the real backlog.`,
          evidence: {
            count: misclassified.length,
            reasons: Array.from(new Set(misclassified.map((r) => r.blockedReason))).slice(0, 10),
            examples: misclassified.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ sendId: r.id, email: maskEmail(r.email), status: r.status, blockedReason: r.blockedReason })),
          },
          suggestedActions: ['inspectEmailSend'],
        })
      )
    }
    return findings
  },
}

// ── 3. Provider acceptance with no provider id ──────────────────────────

const missingProviderId: CheckDefinition = {
  id: 'send.missing_provider_id',
  category: 'send',
  intent: 'A send recorded as accepted or dispatched with no provider message id to reconcile against.',
  run: async (ctx) => {
    const rows = await prisma.emailSend.findMany({
      where: {
        providerId: null,
        createdAt: { gte: structuralSince(ctx) },
        OR: [{ status: 'delivered' }, { sentAt: { not: null } }],
      },
      select: { id: true, email: true, template: true, status: true, sentAt: true, campaignId: true, isTest: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    countInspected(ctx, 'sends_missing_provider_id', rows.length)
    if (rows.length === 0) return []
    const real = rows.filter((r) => !r.isTest)
    return [
      makeFinding(ctx, {
        checkId: 'send.missing_provider_id',
        severity: real.length > 0 ? 'warning' : 'info',
        category: 'send',
        sendId: rows[0].id,
        fingerprintParts: ['missing_provider_id'],
        title: `${rows.length} accepted ${plural(rows.length, 'send has', 'sends have')} no provider id`,
        description:
          `${rows.length} ${plural(rows.length, 'send is', 'sends are')} recorded as accepted by the provider but carry no provider message id ` +
          `(${real.length} of them to real recipients). Without it there is no way to match a bounce or complaint webhook back to this send, ` +
          `and no way to reconcile against the Resend dashboard.`,
        evidence: {
          total: rows.length,
          realRecipients: real.length,
          testSends: rows.length - real.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ sendId: r.id, email: maskEmail(r.email), status: r.status, template: r.template, sentAt: r.sentAt?.toISOString() ?? null, isTest: r.isTest })),
        },
        suggestedActions: ['inspectEmailSend'],
      }),
    ]
  },
}

// ── 4. Delivery recorded before the send ────────────────────────────────

const deliveredBeforeSent: CheckDefinition = {
  id: 'send.delivered_before_sent',
  category: 'send',
  intent: 'A delivery timestamp earlier than the send timestamp — webhook events applied out of order.',
  run: async (ctx) => {
    // Prisma cannot compare two columns, so this is a narrow raw query. It is
    // parameterless and read-only.
    const rows = await prisma.$queryRaw<Array<{ id: string; email: string; sent_at: Date; delivered_at: Date }>>`
      SELECT id, email, sent_at, delivered_at
      FROM email_sends
      WHERE delivered_at IS NOT NULL
        AND sent_at IS NOT NULL
        AND delivered_at < sent_at
      ORDER BY delivered_at DESC
      LIMIT 20
    `
    countInspected(ctx, 'sends_delivery_ordering', rows.length)
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'send.delivered_before_sent',
        severity: 'warning',
        category: 'send',
        sendId: rows[0].id,
        fingerprintParts: ['delivered_before_sent'],
        title: `${rows.length} ${plural(rows.length, 'send shows', 'sends show')} delivery before dispatch`,
        description:
          `${rows.length} ${plural(rows.length, 'send has', 'sends have')} a delivery time earlier than the time it was sent. That is not possible in reality; ` +
          `it means a 'delivered' webhook was applied before the 'sent' one. Delivery state is order-tolerant by design, so no customer was affected — ` +
          `but any report that measures time-to-delivery from these rows will produce nonsense.`,
        evidence: {
          affected: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            sendId: r.id,
            email: maskEmail(r.email),
            sentAt: r.sent_at.toISOString(),
            deliveredAt: r.delivered_at.toISOString(),
            secondsEarly: Math.round((r.sent_at.getTime() - r.delivered_at.getTime()) / 1000),
          })),
        },
        suggestedActions: ['inspectEmailSend', 'inspectWebhookEvent'],
      }),
    ]
  },
}

// ── 5. Two sends of the same campaign to the same person ────────────────

const duplicateSends: CheckDefinition = {
  id: 'send.duplicate_in_campaign',
  category: 'send',
  intent: 'The same person has more than one send row for the same campaign — a duplicate-delivery risk.',
  run: async (ctx) => {
    const rows = await prisma.$queryRaw<Array<{ campaign_id: string; email: string; n: bigint }>>`
      SELECT campaign_id, email, COUNT(*) AS n
      FROM email_sends
      WHERE campaign_id IS NOT NULL
        AND is_test = false
        AND status = 'delivered'
      GROUP BY campaign_id, email
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `
    countInspected(ctx, 'sends_duplicate_groups', rows.length)
    if (rows.length === 0) return []
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0)
    return [
      makeFinding(ctx, {
        checkId: 'send.duplicate_in_campaign',
        severity: 'critical',
        category: 'send',
        campaignId: rows[0].campaign_id,
        fingerprintParts: ['duplicate_in_campaign', ...rows.map((r) => `${r.campaign_id}:${r.email}`).sort().slice(0, 5)],
        title: `${rows.length} ${plural(rows.length, 'person', 'people')} received the same campaign more than once`,
        description:
          `${rows.length} ${plural(rows.length, 'recipient has', 'recipients have')} more than one accepted send for the same campaign (${total} accepted sends in total). ` +
          `A real customer received the same marketing email twice, which is the single fastest way to earn a spam complaint.`,
        evidence: {
          affectedRecipients: rows.length,
          totalAcceptedSends: total,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ campaignId: r.campaign_id, email: maskEmail(r.email), sends: Number(r.n) })),
        },
        suggestedActions: ['pauseMarketingDispatch', 'inspectCampaign', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 6. A send that went out after the person opted out ──────────────────

const sentAfterSuppression: CheckDefinition = {
  id: 'send.after_suppression',
  category: 'suppression',
  intent: 'A promotional email accepted by the provider AFTER that address was suppressed.',
  run: async (ctx) => {
    // The join is on lowercased address because suppression is stored
    // normalised and EmailSend is not guaranteed to be.
    const rows = await prisma.$queryRaw<
      Array<{ id: string; email: string; template: string; sent_at: Date; reason: string; suppressed_at: Date; campaign_id: string | null }>
    >`
      SELECT s.id, s.email, s.template, s.sent_at, sup.reason, sup.created_at AS suppressed_at, s.campaign_id
      FROM email_sends s
      JOIN email_suppressions sup ON LOWER(sup.email) = LOWER(s.email)
      WHERE s.is_test = false
        AND s.sent_at IS NOT NULL
        AND s.sent_at > sup.created_at
        AND s.email_class = 'promotional'
      ORDER BY s.sent_at DESC
      LIMIT 25
    `
    countInspected(ctx, 'sends_vs_suppressions', rows.length)
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'send.after_suppression',
        severity: 'critical',
        category: 'suppression',
        sendId: rows[0].id,
        fingerprintParts: ['after_suppression', ...rows.map((r) => r.id).sort().slice(0, 5)],
        title: `${rows.length} promotional ${plural(rows.length, 'email was', 'emails were')} sent after the person opted out`,
        description:
          `${rows.length} promotional ${plural(rows.length, 'send', 'sends')} reached the provider AFTER that address was already on the suppression list ` +
          `(reasons: ${Array.from(new Set(rows.map((r) => r.reason))).join(', ')}). This is a compliance failure, not a delivery problem: ` +
          `somebody who asked not to be contacted was contacted.`,
        evidence: {
          affected: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            sendId: r.id, email: maskEmail(r.email), template: r.template,
            suppressionReason: r.reason, suppressedAt: r.suppressed_at.toISOString(), sentAt: r.sent_at.toISOString(),
            campaignId: r.campaign_id,
          })),
        },
        suggestedActions: ['pauseMarketingDispatch', 'inspectEmailSend', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 7. Retry budget exhausted while still open ──────────────────────────

const retryLimitExceeded: CheckDefinition = {
  id: 'send.retry_limit_exceeded',
  category: 'send',
  intent: 'A send that has used its whole attempt budget without reaching a terminal state.',
  run: async (ctx) => {
    const rows = await prisma.emailSend.findMany({
      where: {
        attempts: { gte: GUARD_MAX_ATTEMPTS },
        status: { in: [...AWAITING_RETRY, ...IN_FLIGHT] },
        createdAt: { gte: structuralSince(ctx) },
      },
      select: { id: true, email: true, template: true, status: true, attempts: true, error: true, blockedReason: true },
      take: 50,
    })
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'send.retry_limit_exceeded',
        severity: 'warning',
        category: 'send',
        sendId: rows[0].id,
        fingerprintParts: ['retry_limit_exceeded'],
        title: `${rows.length} ${plural(rows.length, 'send has', 'sends have')} exhausted their retries without closing`,
        description:
          `${rows.length} ${plural(rows.length, 'send has', 'sends have')} reached ${GUARD_MAX_ATTEMPTS} attempts but ${plural(rows.length, 'is', 'are')} still in a retryable state. ` +
          `They should have been closed as failed. Left open they consume attempts forever and never surface as a failure anyone can act on.`,
        evidence: {
          count: rows.length,
          maxAttempts: GUARD_MAX_ATTEMPTS,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ sendId: r.id, email: maskEmail(r.email), status: r.status, attempts: r.attempts, blockedReason: r.blockedReason })),
        },
        suggestedActions: ['inspectEmailSend'],
      }),
    ]
  },
}

// ── 8. Outcomes only a human can resolve ────────────────────────────────

const ambiguousSends: CheckDefinition = {
  id: 'send.ambiguous_outcome',
  category: 'send',
  intent: 'A send whose request left us with no answer — we cannot say whether the customer got it.',
  run: async (ctx) => {
    const rows = await prisma.emailSend.findMany({
      where: { status: 'ambiguous', createdAt: { gte: structuralSince(ctx) } },
      select: { id: true, email: true, template: true, campaignId: true, createdAt: true, error: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'send.ambiguous_outcome',
        severity: 'warning',
        category: 'send',
        sendId: rows[0].id,
        fingerprintParts: ['ambiguous_outcome'],
        title: `${rows.length} ${plural(rows.length, 'send has', 'sends have')} an unknown outcome`,
        description:
          `${rows.length} ${plural(rows.length, 'send', 'sends')} left this system with no answer from the provider, so we cannot tell whether the customer received ${plural(rows.length, 'it', 'them')}. ` +
          `They are deliberately held out of future runs of the same campaign and are never resent automatically — resending a message that did arrive is worse than not resending one that did not.`,
        evidence: {
          count: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ sendId: r.id, email: maskEmail(r.email), template: r.template, campaignId: r.campaignId, at: r.createdAt.toISOString() })),
        },
        suggestedActions: ['inspectEmailSend', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 9. States that contradict each other ────────────────────────────────

const contradictoryState: CheckDefinition = {
  id: 'send.contradictory_state',
  category: 'send',
  intent: 'A send whose recorded facts cannot all be true at once.',
  run: async (ctx) => {
    const rows = await prisma.emailSend.findMany({
      where: {
        createdAt: { gte: structuralSince(ctx) },
        OR: [
          // Closed as never-sent, yet carrying evidence that it was sent.
          { status: { in: ['blocked_terminal', 'failed_terminal'] }, providerId: { not: null } },
          // Recorded delivered to an inbox while also recorded as blocked.
          { status: { in: ['blocked_terminal', 'blocked_retryable'] }, deliveredAt: { not: null } },
        ],
      },
      select: { id: true, email: true, status: true, providerId: true, sentAt: true, deliveredAt: true, blockedReason: true, template: true },
      take: 50,
    })
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'send.contradictory_state',
        severity: 'warning',
        category: 'send',
        sendId: rows[0].id,
        fingerprintParts: ['contradictory_state'],
        title: `${rows.length} ${plural(rows.length, 'send holds', 'sends hold')} contradictory facts`,
        description:
          `${rows.length} ${plural(rows.length, 'send is', 'sends are')} recorded as blocked or failed while also carrying provider evidence that the message went out. ` +
          `Both cannot be true. Until it is resolved, the record cannot answer the only question that matters: was this customer emailed?`,
        evidence: {
          count: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            sendId: r.id, email: maskEmail(r.email), status: r.status, blockedReason: r.blockedReason,
            hasProviderId: r.providerId !== null, sentAt: r.sentAt?.toISOString() ?? null, deliveredAt: r.deliveredAt?.toISOString() ?? null,
          })),
        },
        suggestedActions: ['inspectEmailSend', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 10. Demand without delivery (incident 2026-09-14) ──────────────────
//
//  THE BLIND SPOT THIS CLOSES. Every rate-based check here stays quiet below a
//  sample floor, and email-monitoring reports zero sends as "no email sent in
//  the window" — so a pipeline that silently stops would look exactly like a
//  quiet week. Zero sends is only a problem when there was DEMAND: a customer
//  asked for a quote and no email reached them. These checks are anchored on
//  that demand, never on raw volume, so a genuinely quiet business stays
//  healthy.
//
//  Read-only. Evidence carries lead ids and ages only — never an address.

/** A confirmation queued longer than this has not been processed. */
export const CONFIRMATION_STALL_MS = 30 * 60_000
/** …and this long means the pipeline is down, not slow. */
export const CONFIRMATION_STALL_CRITICAL_MS = 2 * 60 * 60_000
/**
 * Critical pages repeat hourly while an incident stays critical. A stall that
 * nobody has touched for a day is known, not news: once even the NEWEST stuck
 * confirmation is older than this, it drops to a warning (the daily digest)
 * instead of paging every hour for the rest of the lookback.
 */
export const CONFIRMATION_STALL_CRITICAL_WINDOW_MS = 24 * 3600_000
/** Only recent stalls are actionable; older rows are history. */
export const STALL_LOOKBACK_MS = 7 * 24 * 3600_000
/** How far back demand and delivery are compared. */
export const SILENCE_WINDOW_MS = 72 * 3600_000
/** A lead younger than this has not had a fair chance to be confirmed yet. */
export const DEMAND_GRACE_MS = 30 * 60_000

export type SilenceVerdict = 'ok' | 'warning' | 'critical'

/**
 * PURE: demand = qualifying leads in the window; delivered = real (non-test)
 * provider-accepted sends in the same window.
 *   zero demand            → ok, whatever the send volume
 *   demand + any delivery  → ok
 *   1 lead, no delivery    → warning
 *   2+ leads, no delivery  → critical
 */
export function silenceVerdict(demand: number, delivered: number): SilenceVerdict {
  if (demand <= 0 || delivered > 0) return 'ok'
  return demand >= 2 ? 'critical' : 'warning'
}

/**
 * PURE: severity from the OLDEST stalled confirmation, or null when none.
 * `newestAgeMs` (the most recent stall) caps it: a set where every stall is
 * past CONFIRMATION_STALL_CRITICAL_WINDOW_MS is a warning, not a page.
 */
export function confirmationStallSeverity(oldestAgeMs: number | null, newestAgeMs: number | null = oldestAgeMs): 'warning' | 'critical' | null {
  if (oldestAgeMs === null || oldestAgeMs <= CONFIRMATION_STALL_MS) return null
  if (oldestAgeMs <= CONFIRMATION_STALL_CRITICAL_MS) return 'warning'
  if (newestAgeMs !== null && newestAgeMs > CONFIRMATION_STALL_CRITICAL_WINDOW_MS) return 'warning'
  return 'critical'
}

/** Provider-accepted statuses — a bounced message was still accepted and sent. */
const ACCEPTED_STATUSES = ['delivered', 'bounced', 'complained']

const confirmationStalled: CheckDefinition = {
  id: 'send.confirmation_stalled',
  category: 'send',
  intent: 'A customer asked for a quote and their confirmation email is stuck in the queue, or there was demand and nothing was delivered.',
  emits: ['send.confirmation_stalled', 'send.silence_with_demand'],
  run: async (ctx) => {
    const findings: AgentFinding[] = []

    // (a) Confirmations queued but never resolved.
    const stalled = await prisma.lead.findMany({
      where: {
        quoteConfirmationStatus: 'queued',
        quoteConfirmationQueuedAt: { gte: since(ctx, STALL_LOOKBACK_MS), lt: since(ctx, CONFIRMATION_STALL_MS) },
      },
      select: { id: true, quoteConfirmationQueuedAt: true },
      orderBy: { quoteConfirmationQueuedAt: 'asc' },
      take: 50,
    })
    countInspected(ctx, 'confirmations_stalled', stalled.length)
    const oldest = stalled[0]?.quoteConfirmationQueuedAt ?? null
    const newest = stalled[stalled.length - 1]?.quoteConfirmationQueuedAt ?? null
    const stallSeverity = confirmationStallSeverity(oldest ? ageMs(ctx, oldest) : null, newest ? ageMs(ctx, newest) : null)
    if (stallSeverity) {
      findings.push(
        makeFinding(ctx, {
          checkId: 'send.confirmation_stalled',
          severity: stallSeverity,
          category: 'send',
          // ONE incident while anything is stuck (members and count live in the
          // evidence). An id-based fingerprint closed the incident as "cleared"
          // every time a new lead got stuck. Hourly re-paging is bounded by the
          // 24h severity window and the alert layer's per-cycle severity.
          fingerprintParts: ['confirmation_stalled'],
          title: `${stalled.length} quote ${plural(stalled.length, 'confirmation is', 'confirmations are')} stuck in the queue`,
          description:
            `${stalled.length} ${plural(stalled.length, 'customer', 'customers')} requested a quote and ${plural(stalled.length, 'its', 'their')} confirmation has been queued ` +
            `for over ${minutes(CONFIRMATION_STALL_MS)} minutes (oldest: ${minutes(ageMs(ctx, oldest))} minutes). The email worker is not processing the queue, ` +
            `the send is being held (kill switch), or Redis lost the job. Nothing will be resent automatically — check the worker first.`,
          evidence: {
            stalled: stalled.length,
            oldestMinutes: minutes(ageMs(ctx, oldest)),
            leads: stalled.slice(0, EVIDENCE_ROW_CAP).map((l) => ({
              leadId: l.id,
              queuedMinutesAgo: minutes(ageMs(ctx, l.quoteConfirmationQueuedAt)),
            })),
          },
          suggestedActions: ['inspectEmailSend'],
        })
      )
    }

    // (b) Demand with no delivery at all.
    const windowFrom = since(ctx, SILENCE_WINDOW_MS)
    const [demandLeads, delivered] = await Promise.all([
      prisma.lead.findMany({
        where: {
          createdAt: { gte: windowFrom, lt: since(ctx, DEMAND_GRACE_MS) },
          email: { not: null },
          OR: [{ source: 'QUICK_QUOTE_FORM' }, { quoteConfirmationQueuedAt: { not: null } }],
        },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.emailSend.count({
        where: { isTest: false, status: { in: ACCEPTED_STATUSES }, sentAt: { gte: windowFrom } },
      }),
    ])
    countInspected(ctx, 'demand_leads', demandLeads.length)
    const verdict = silenceVerdict(demandLeads.length, delivered)
    if (verdict !== 'ok') {
      findings.push(
        makeFinding(ctx, {
          checkId: 'send.silence_with_demand',
          severity: verdict,
          category: 'send',
          fingerprintParts: ['silence_with_demand'],
          title: `${demandLeads.length} quote ${plural(demandLeads.length, 'request', 'requests')} in ${Math.round(SILENCE_WINDOW_MS / 3600_000)}h and no email delivered`,
          description:
            `${demandLeads.length} ${plural(demandLeads.length, 'customer', 'customers')} submitted a quote request in the last ${Math.round(SILENCE_WINDOW_MS / 3600_000)} hours, ` +
            `but no real email was accepted by the provider in that time. Customers are asking and nobody is answering by email — ` +
            `check the email worker, the queue and the provider before anything else.`,
          evidence: {
            demand: demandLeads.length,
            deliveredInWindow: delivered,
            windowHours: Math.round(SILENCE_WINDOW_MS / 3600_000),
            leads: demandLeads.slice(0, EVIDENCE_ROW_CAP).map((l) => ({ leadId: l.id, hoursAgo: hours(ageMs(ctx, l.createdAt)) })),
          },
          suggestedActions: ['inspectEmailSend'],
        })
      )
    }
    return findings
  },
}

export const sendChecks: CheckDefinition[] = [
  confirmationStalled,
  inFlightStale,
  retryOverdue,
  missingProviderId,
  deliveredBeforeSent,
  duplicateSends,
  sentAfterSuppression,
  retryLimitExceeded,
  ambiguousSends,
  contradictoryState,
]
