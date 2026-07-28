// ════════════════════════════════════════════════════════════════════════
//  CONSENT + SUPPRESSION CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  This family is different from the others in one important way: everything
//  here is DETERMINISTIC AND NON-NEGOTIABLE. No model is ever asked whether
//  somebody consented. Consent is a row, or it is absent, and absence is not
//  consent. The agent can only ever REPORT on this family — the tools that
//  would create consent or remove a suppression do not exist as executors, and
//  the policy engine classifies both as `forbidden`.
//
//  THE FAILURE THAT MATTERS MOST: a bounce or complaint arrives, the event row
//  is written, and the SUPPRESSION WRITE FAILS. The unique providerEventId then
//  deduplicates away every provider retry, so the signal never comes again and
//  that address stays sendable forever. It is completely silent. Two checks
//  here look at it from both ends — the unfinished side-effect state, and the
//  event-versus-suppression reality — because the first depends on the
//  processing flag being correct and the second does not depend on anything.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { maskEmail } from '../redact'
import type { AgentFinding } from '../types'
import {
  EVIDENCE_ROW_CAP,
  STRUCTURAL_WINDOW_DAYS,
  countInspected,
  makeFinding,
  plural,
  since,
  type CheckContext,
  type CheckDefinition,
} from './shared'

const structuralSince = (ctx: CheckContext) => since(ctx, STRUCTURAL_WINDOW_DAYS * 24 * 3600_000)

/** Event types that MUST produce a suppression entry. */
const SUPPRESSING_EVENT_TYPES = ['bounced', 'complained', 'unsubscribed']

// ── 1. A destructive event that never reached the suppression list ──────

const eventWithoutSuppression: CheckDefinition = {
  id: 'suppression.event_not_applied',
  category: 'suppression',
  intent: 'A bounce, complaint or unsubscribe arrived and that address is still not suppressed.',
  run: async (ctx) => {
    // Checked against REALITY, not against the processing flag. A row marked
    // 'processed' whose suppression is nevertheless missing is exactly the bug
    // that must not be able to hide, so the flag is not consulted here.
    const rows = await prisma.$queryRaw<
      Array<{ id: string; email: string; type: string; occurred_at: Date; processing_status: string; email_send_id: string | null }>
    >`
      SELECT e.id, e.email, e.type, e.occurred_at, e.processing_status, e.email_send_id
      FROM email_events e
      LEFT JOIN email_suppressions s ON LOWER(s.email) = LOWER(e.email)
      WHERE e.type IN ('bounced', 'complained', 'unsubscribed')
        AND s.id IS NULL
      ORDER BY e.occurred_at DESC
      LIMIT 50
    `
    countInspected(ctx, 'suppressing_events_unapplied', rows.length)
    if (rows.length === 0) return []

    // A hard bounce is only suppressible when it IS hard; the provider also
    // sends soft-bounce events under the same type. The compliance policy lives
    // in isHardBounce() and this check does not second-guess it — it reports
    // the gap and names the event so a human can look at the detail.
    const complaints = rows.filter((r) => r.type === 'complained').length
    const unsubscribes = rows.filter((r) => r.type === 'unsubscribed').length

    return [
      makeFinding(ctx, {
        checkId: 'suppression.event_not_applied',
        severity: complaints > 0 || unsubscribes > 0 ? 'critical' : 'warning',
        category: 'suppression',
        webhookEventId: rows[0].id,
        fingerprintParts: ['event_not_applied'],
        title: `${rows.length} opt-out ${plural(rows.length, 'signal has', 'signals have')} not reached the suppression list`,
        description:
          `${rows.length} bounce/complaint/unsubscribe ${plural(rows.length, 'event', 'events')} exist for addresses that are NOT on the suppression list ` +
          `(${complaints} ${plural(complaints, 'complaint', 'complaints')}, ${unsubscribes} ${plural(unsubscribes, 'unsubscribe', 'unsubscribes')}). ` +
          `Every one of those addresses is still sendable. The provider will not send the signal again — the event id is already recorded — so this does not heal on its own.`,
        evidence: {
          total: rows.length,
          byType: { bounced: rows.filter((r) => r.type === 'bounced').length, complained: complaints, unsubscribed: unsubscribes },
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({
            eventId: r.id,
            email: maskEmail(r.email),
            type: r.type,
            processingStatus: r.processing_status,
            occurredAt: r.occurred_at.toISOString(),
          })),
        },
        suggestedActions: ['inspectWebhookEvent', 'reprocessValidWebhookEvent', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 2. Side effects the system knows it has not finished ────────────────

const unsettledSideEffects: CheckDefinition = {
  id: 'suppression.side_effect_unsettled',
  category: 'suppression',
  intent: 'Suppression writes that are pending, failing, or have exhausted every retry.',
  emits: ['suppression.side_effect_unsettled', 'suppression.side_effect_dead_letter'],
  run: async (ctx) => {
    const grouped = await prisma.emailEvent.groupBy({
      by: ['processingStatus'],
      where: { processingStatus: { in: ['side_effect_pending', 'side_effect_failed', 'dead_letter'] } },
      _count: { _all: true },
    })
    if (grouped.length === 0) return []
    const counts = Object.fromEntries(grouped.map((g) => [g.processingStatus, g._count._all]))
    const deadLetter = counts.dead_letter ?? 0
    const unsettled = (counts.side_effect_pending ?? 0) + (counts.side_effect_failed ?? 0)
    countInspected(ctx, 'events_unsettled', deadLetter + unsettled)

    const findings: AgentFinding[] = []
    if (deadLetter > 0) {
      const examples = await prisma.emailEvent.findMany({
        where: { processingStatus: 'dead_letter' },
        select: { id: true, email: true, type: true, sideEffectAttempts: true, sideEffectError: true, occurredAt: true },
        take: EVIDENCE_ROW_CAP,
      })
      findings.push(
        makeFinding(ctx, {
          checkId: 'suppression.side_effect_dead_letter',
          severity: 'critical',
          category: 'suppression',
          fingerprintParts: ['side_effect_dead_letter'],
          title: `${deadLetter} opt-out ${plural(deadLetter, 'signal has', 'signals have')} exhausted every retry`,
          description:
            `${deadLetter} bounce or complaint ${plural(deadLetter, 'event', 'events')} tried and failed to write a suppression until the retries ran out. ` +
            `${plural(deadLetter, 'That address is', 'Those addresses are')} still sendable and only a person can fix it now — the automatic path has given up.`,
          evidence: {
            deadLettered: deadLetter,
            examples: examples.map((e) => ({
              eventId: e.id, email: maskEmail(e.email), type: e.type,
              attempts: e.sideEffectAttempts, lastError: e.sideEffectError?.slice(0, 200) ?? null,
              occurredAt: e.occurredAt.toISOString(),
            })),
          },
          suggestedActions: ['inspectWebhookEvent', 'reprocessValidWebhookEvent', 'sendDiscordIncidentAlert'],
        })
      )
    }
    if (unsettled > 0) {
      findings.push(
        makeFinding(ctx, {
          checkId: 'suppression.side_effect_unsettled',
          severity: 'warning',
          category: 'suppression',
          fingerprintParts: ['side_effect_unsettled'],
          title: `${unsettled} suppression ${plural(unsettled, 'write is', 'writes are')} unfinished`,
          description:
            `${unsettled} bounce/complaint ${plural(unsettled, 'event has', 'events have')} a suppression that has not completed. Until it does, ` +
            `${plural(unsettled, 'that address', 'those addresses')} can still receive email. The retry sweep runs every ten minutes; if this number is not falling, the write itself is failing.`,
          evidence: { pending: counts.side_effect_pending ?? 0, failed: counts.side_effect_failed ?? 0 },
          suggestedActions: ['reprocessValidWebhookEvent', 'inspectWebhookEvent'],
        })
      )
    }
    return findings
  },
}

// ── 3. Hard-bounce suppressions that do not match the compliance policy ──

const suppressionScopePolicy: CheckDefinition = {
  id: 'suppression.scope_policy_mismatch',
  category: 'suppression',
  intent: 'A bounce or complaint suppression recorded as promotional-only, which would still allow marketing.',
  run: async (ctx) => {
    // The policy: an unsubscribe is promotional-scope; a hard bounce, complaint,
    // invalid address or admin block is 'all'. A complaint stored as
    // promotional-only would still block marketing, but a HARD BOUNCE stored
    // that way means we keep mailing an address that does not exist.
    const rows = await prisma.emailSuppression.findMany({
      where: { reason: { in: ['HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK'] }, scope: { not: 'all' } },
      select: { id: true, email: true, reason: true, scope: true, source: true, createdAt: true },
      take: 50,
    })
    countInspected(ctx, 'suppressions_scope_checked', rows.length)
    if (rows.length === 0) return []
    return [
      makeFinding(ctx, {
        checkId: 'suppression.scope_policy_mismatch',
        severity: 'warning',
        category: 'suppression',
        fingerprintParts: ['scope_policy_mismatch'],
        title: `${rows.length} hard ${plural(rows.length, 'suppression is', 'suppressions are')} scoped too narrowly`,
        description:
          `${rows.length} suppression ${plural(rows.length, 'entry', 'entries')} created by a bounce, complaint or admin block ${plural(rows.length, 'is', 'are')} scoped ` +
          `'${Array.from(new Set(rows.map((r) => r.scope))).join("', '")}' rather than 'all'. The policy for these reasons is a total block; a narrower scope means some categories of email still go out.`,
        evidence: {
          count: rows.length,
          examples: rows.slice(0, EVIDENCE_ROW_CAP).map((r) => ({ email: maskEmail(r.email), reason: r.reason, scope: r.scope, source: r.source, at: r.createdAt.toISOString() })),
        },
        suggestedActions: ['createApprovalRequest'],
      }),
    ]
  },
}

// ── 4. Marketing that reached somebody with no recorded opt-in ──────────

const sentWithoutConsent: CheckDefinition = {
  id: 'consent.sent_without_consent',
  category: 'consent',
  intent: 'A promotional email was accepted for somebody who has no explicit marketing opt-in on any record.',
  run: async (ctx) => {
    const sends = await prisma.emailSend.findMany({
      where: {
        emailClass: 'promotional',
        isTest: false,
        sentAt: { not: null, gte: structuralSince(ctx) },
      },
      select: { id: true, email: true, template: true, sentAt: true, campaignId: true },
      orderBy: { sentAt: 'desc' },
      take: 500,
    })
    countInspected(ctx, 'promotional_sends_consent_checked', sends.length)
    if (sends.length === 0) return []

    const emails = Array.from(new Set(sends.map((s) => s.email.toLowerCase())))
    // Consent may live on EITHER record — a person can be a Lead, a Customer,
    // or both. Absence on both is the only thing that counts as no consent.
    const [customers, leads] = await Promise.all([
      prisma.customer.findMany({ where: { email: { in: emails }, emailMarketingConsent: true }, select: { email: true } }),
      prisma.lead.findMany({ where: { email: { in: emails }, emailMarketingConsent: true }, select: { email: true } }),
    ])
    // Customer.email is required; Lead.email is optional. Normalised separately
    // so a null lead address can never become an empty-string key.
    const consenting = new Set(
      customers
        .map((c) => c.email.toLowerCase())
        .concat(leads.filter((l): l is { email: string } => !!l.email).map((l) => l.email.toLowerCase()))
    )
    const offending = sends.filter((s) => !consenting.has(s.email.toLowerCase()))
    if (offending.length === 0) return []

    return [
      makeFinding(ctx, {
        checkId: 'consent.sent_without_consent',
        severity: 'critical',
        category: 'consent',
        sendId: offending[0].id,
        fingerprintParts: ['sent_without_consent', ...offending.map((o) => o.id).sort().slice(0, 5)],
        title: `${offending.length} promotional ${plural(offending.length, 'email', 'emails')} went to somebody with no recorded consent`,
        description:
          `${offending.length} promotional ${plural(offending.length, 'send', 'sends')} in the last ${STRUCTURAL_WINDOW_DAYS} days went to ${plural(offending.length, 'an address', 'addresses')} with no explicit email-marketing opt-in ` +
          `on either the customer or the lead record. Consent may have been withdrawn after the send, which is not a fault — but if it was never there, this is a compliance breach and the audience definition that produced it will produce more.`,
        evidence: {
          affected: offending.length,
          checkedSends: sends.length,
          note: 'Consent is evaluated as it stands NOW. A withdrawal after the send also lands here; check marketingConsentAt on the record before concluding.',
          examples: offending.slice(0, EVIDENCE_ROW_CAP).map((s) => ({
            sendId: s.id, email: maskEmail(s.email), template: s.template,
            sentAt: s.sentAt?.toISOString() ?? null, campaignId: s.campaignId,
          })),
        },
        suggestedActions: ['pauseMarketingDispatch', 'inspectEmailSend', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 5. Consent that changed between audience build and dispatch ─────────

const consentChangedDuringRun: CheckDefinition = {
  id: 'consent.withdrawn_before_dispatch',
  category: 'consent',
  intent: 'Somebody withdrew consent or was suppressed after a run claimed them but before it sent.',
  run: async (ctx) => {
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: { in: ['QUEUED', 'SENDING', 'PAUSED'] } },
      select: { id: true, campaignId: true, startedAt: true },
      take: 20,
    })
    if (runs.length === 0) return []

    const findings: AgentFinding[] = []
    for (const run of runs) {
      const pending = await prisma.emailCampaignRecipient.findMany({
        where: { runId: run.id, status: { in: ['PENDING', 'DEFERRED'] } },
        select: { email: true },
        take: 500,
      })
      if (pending.length === 0) continue
      const emails = pending.map((p) => p.email)
      // Suppressions created AFTER this run started are the ones that appeared
      // between the audience being built and the send happening.
      const late = await prisma.emailSuppression.findMany({
        where: { email: { in: emails }, createdAt: { gte: run.startedAt } },
        select: { email: true, reason: true, createdAt: true, source: true },
        take: 50,
      })
      if (late.length === 0) continue

      findings.push(
        makeFinding(ctx, {
          checkId: 'consent.withdrawn_before_dispatch',
          severity: 'warning',
          category: 'consent',
          campaignId: run.campaignId,
          runRefId: run.id,
          title: 'Somebody opted out after this run claimed them',
          description:
            `${late.length} ${plural(late.length, 'person', 'people')} still queued in run ${run.id} opted out or were suppressed AFTER the run started. ` +
            `The suppression recheck immediately before each send will refuse them, so nothing wrong is about to happen — this is the safety net working, and it is recorded so the outcome is explainable rather than mysterious.`,
          evidence: {
            runStartedAt: run.startedAt.toISOString(),
            optedOutSinceStart: late.length,
            examples: late.slice(0, EVIDENCE_ROW_CAP).map((l) => ({ email: maskEmail(l.email), reason: l.reason, source: l.source, at: l.createdAt.toISOString() })),
          },
          suggestedActions: ['inspectCampaignRun'],
        })
      )
    }
    return findings
  },
}

export const consentChecks: CheckDefinition[] = [
  eventWithoutSuppression,
  unsettledSideEffects,
  suppressionScopePolicy,
  sentWithoutConsent,
  consentChangedDuringRun,
]
