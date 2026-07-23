// ════════════════════════════════════════════════════════════════════════
//  CAMPAIGN DISPATCH EXECUTOR (owner spec 2026-07-22)
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES: a campaign could be created, validated, approved,
//  scheduled and moved to ACTIVE — and then nothing happened. No producer
//  existed for the SCHEDULED/ACTIVE states (verified in
//  docs/email/email-staging-plan.md: "campaign dispatch … has no producer").
//  This module is that producer.
//
//  HOW A DISPATCH RUNS
//   1. dispatchCampaign() re-loads the campaign, re-runs every gate
//      (state machine, approval freshness, validation, promo flag, template↔
//      audience compatibility), FREEZES the config into an EmailCampaignRun
//      snapshot, resolves the audience from CURRENT database state, writes one
//      EmailCampaignRecipient row per unique candidate (excluded people are
//      recorded with their reason, not silently dropped), and enqueues bounded
//      batch jobs on the scheduled queue.
//   2. processCampaignBatch() claims PENDING recipients one at a time
//      (atomic updateMany), builds each recipient's REAL context via the
//      registry, renders through the shared renderer, and delivers through
//      `guardedSend` — the same single choke point every other send uses.
//      Suppression, caps, quiet hours, payload validation, compliance context
//      and the idempotency claim all still happen INSIDE the guard.
//   3. Deferred sends (quiet hours / caps) are re-queued to their retryAt.
//      finalizeRunIfDone() recomputes counters from recipient rows and closes
//      the run; sweepCampaignRuns() dispatches due SCHEDULED campaigns,
//      recovers stale runs after a crash, and finalizes settled ones.
//
//  EXACTLY-ONCE: three independent layers —
//   • one unfinished run per campaign (dispatchCampaign refuses a second);
//   • UNIQUE(runId, email) on recipients (re-dispatch cannot duplicate rows);
//   • the EmailSend idempotency key anchored on campaignRunEventId(runId)
//     (a batch retry or worker restart resumes the SAME logical send).
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { scheduledQueue } from './queues'
import { guardedSend } from './email-guard'
import { renderTemplate } from './email-render'
import { templateByKey } from './email-registry'
import { bookingEligibility } from './email-eligibility'
import { leadEligibility } from './journeys'
import { buildMarketingContext, applyMarketingContext } from './marketing-context'
import { validateCampaign, canDispatch, canTransition, type CampaignState, type CampaignValidation } from './email-campaign'
import { validateAudienceDefinition, resolveAudienceDetailed, MAX_AUDIENCE, type AudienceDefinition, type Candidate } from './email-audience'
import { buildRecipientContext, templateAllowsSegment } from './email-recipient-context'
import {
  CAMPAIGN_BATCH_SIZE,
  RUN_SENDABLE_STATES,
  RECIPIENT_RETRYABLE_STATES,
  batchCount,
  campaignBatchJobId,
  campaignRecipientJobId,
  campaignRunEventId,
  canTransitionRun,
  editedAfterApproval,
  promotionsEnabled,
  recipientStateForOutcome,
  runIsSettled,
  settledRunState,
  type RunState,
  type RecipientState,
} from './email-campaign-run'

const log = queueLogger.child({ mod: 'email-campaign-dispatch' })

/** Run states that block a NEW dispatch of the same campaign. */
const UNFINISHED_RUN_STATES: RunState[] = ['PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING']

export type ActorContext = { userId: string | null; name: string | null }
export const SYSTEM_ACTOR: ActorContext = { userId: null, name: 'scheduler' }

export type DispatchResult =
  | { ok: true; runId: string; totalRecipients: number; alreadyRunning: boolean }
  | { ok: false; error: string }

type CampaignWithConfig = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>

async function loadCampaign(campaignId: string) {
  return prisma.marketingCampaign.findUnique({
    where: { id: campaignId },
    include: { emailConfig: { include: { audience: true } } },
  })
}

async function audit(action: string, actor: ActorContext, details: Record<string, unknown>): Promise<void> {
  await prisma.auditLog
    .create({ data: { action: action as never, userId: actor.userId, details: details as never } })
    .catch((err) => log.warn({ err: String(err), action }, 'audit write failed (non-fatal)'))
}

// ── Preflight ───────────────────────────────────────────────────────────

export type Preflight =
  | { ok: true; audience: AudienceDefinition; validation: CampaignValidation }
  | { ok: false; error: string }

/**
 * Everything that must be true IMMEDIATELY BEFORE recipients are claimed.
 * Approval, validation and configuration all move between "scheduled" and
 * "now" — none of them are trusted from the earlier check.
 */
export function preflightCampaign(campaign: CampaignWithConfig, now: Date = new Date()): Preflight {
  const config = campaign.emailConfig
  if (!config) return { ok: false, error: 'This campaign has no email configuration.' }

  const state = campaign.status as CampaignState
  const gate = canDispatch({ state, approvedAt: config.approvedAt, scheduledAt: config.scheduledAt, now })
  if (!gate.ok) return { ok: false, error: gate.error }

  // Approval must still describe THIS config. Any material edit after the
  // approval invalidates it — a dispatch on a stale approval sends a campaign
  // nobody approved.
  if (editedAfterApproval({ approvedAt: config.approvedAt, updatedAt: config.updatedAt })) {
    return { ok: false, error: 'The campaign was edited after it was approved. Re-validate and re-approve it.' }
  }

  // MASTER SWITCH: promotional dispatch is disabled until deliberately enabled.
  if (!promotionsEnabled()) {
    return { ok: false, error: 'Promotional sending is disabled (EMAIL_PROMOTIONS_ENABLED is not "true"). Complete the staging rehearsal, then enable it deliberately.' }
  }

  const audienceRaw = config.audience?.definition ?? null
  if (!audienceRaw) return { ok: false, error: 'The campaign has no attached audience.' }
  const audience = validateAudienceDefinition(audienceRaw)
  if (!audience.ok) return { ok: false, error: `Audience definition rejected: ${audience.errors.join(' ')}` }

  // Template ↔ audience compatibility: can every candidate of this segment
  // honestly receive this template's claims?
  const compat = templateAllowsSegment(config.template, audience.definition.segment)
  if (!compat.ok) return { ok: false, error: compat.error }

  // Fresh validation run — the stored result may predate config/env changes.
  const validation = validateCampaign({
    name: campaign.name,
    sourceKey: campaign.sourceKey,
    template: config.template,
    subject: config.subject,
    audienceDefinition: audienceRaw,
    // Deliberately NOT re-checking scheduledAt-in-past here: at dispatch time
    // the scheduled moment has legitimately arrived.
    scheduledAt: null,
    utmSource: config.utmSource,
    utmMedium: config.utmMedium,
    utmCampaign: config.utmCampaign,
    utmContent: config.utmContent,
    discountCode: config.discountCode,
  })
  if (!validation.ok) return { ok: false, error: `Validation is failing: ${validation.errors.join(' ')}` }

  return { ok: true, audience: audience.definition, validation }
}

// ── Dispatch ────────────────────────────────────────────────────────────

/**
 * THE campaign executor entry point. Idempotent: a repeat call while a run is
 * unfinished returns that run instead of creating a duplicate.
 */
export async function dispatchCampaign(campaignId: string, actor: ActorContext): Promise<DispatchResult> {
  const campaign = await loadCampaign(campaignId)
  if (!campaign || campaign.channel !== 'EMAIL') return { ok: false, error: 'That email campaign does not exist.' }
  const config = campaign.emailConfig
  if (!config) return { ok: false, error: 'This campaign has no email configuration.' }

  // IDEMPOTENCY LAYER 1: one unfinished run per campaign.
  const existing = await prisma.emailCampaignRun.findFirst({
    where: { campaignId, status: { in: UNFINISHED_RUN_STATES } },
    select: { id: true, totalRecipients: true, status: true },
  })
  if (existing) {
    log.info({ campaignId, runId: existing.id, status: existing.status }, 'dispatch requested while a run is unfinished — returning it')
    return { ok: true, runId: existing.id, totalRecipients: existing.totalRecipients, alreadyRunning: true }
  }

  const preflight = preflightCampaign(campaign)
  if (!preflight.ok) return preflight

  // FREEZE the dispatch configuration. Recipients receive THIS, whatever is
  // edited on the campaign afterwards.
  const snapshot = {
    template: config.template,
    subject: config.subject,
    sourceKey: campaign.sourceKey,
    audience: preflight.audience,
    utmSource: config.utmSource,
    utmMedium: config.utmMedium,
    utmCampaign: config.utmCampaign,
    utmContent: config.utmContent,
    discountCode: config.discountCode,
  }

  const run = await prisma.emailCampaignRun.create({
    data: {
      campaignId,
      status: 'PREPARING',
      snapshot: snapshot as never,
      preflight: { validation: preflight.validation, promotionsEnabled: true, checkedAt: new Date().toISOString() } as never,
      startedById: actor.userId,
      startedByName: actor.name,
    },
    select: { id: true },
  })

  try {
    // Resolve the audience from CURRENT state — never a cached preview.
    const detailed = await resolveAudienceDetailed(preflight.audience)
    const eligible = detailed.eligible.slice(0, MAX_AUDIENCE)

    // IDEMPOTENCY LAYER 2: UNIQUE(runId, email) + skipDuplicates.
    const toRow = (c: Candidate, status: RecipientState, reason: string | null, index: number | null) => ({
      runId: run.id,
      email: c.email,
      name: c.name,
      customerId: c.customerId,
      leadId: c.leadId,
      bookingId: c.bookingId,
      status,
      reason,
      batchIndex: index,
    })

    const rows = [
      ...eligible.map((c, i) => toRow(c, 'PENDING', null, Math.floor(i / CAMPAIGN_BATCH_SIZE))),
      // Excluded people are RECORDED, not dropped — each with the named reason.
      ...detailed.excluded.map(({ candidate, reason }) =>
        toRow(
          candidate,
          reason === 'unsubscribed' ? 'UNSUBSCRIBED' : reason.startsWith('suppressed') ? 'SUPPRESSED' : 'SKIPPED',
          reason,
          null
        )
      ),
    ]
    // Bounded chunks so a 5000-recipient audience never becomes one statement.
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.emailCampaignRecipient.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true })
    }

    const batches = batchCount(eligible.length)
    await prisma.emailCampaignRun.update({
      where: { id: run.id },
      data: { status: 'QUEUED', totalRecipients: eligible.length, skippedCount: detailed.excluded.length },
    })

    // Enqueue bounded batches with deterministic job ids — a crash between two
    // adds re-enqueues safely, BullMQ dedupes on the id.
    for (let b = 0; b < batches; b++) {
      await scheduledQueue.add(
        'campaign-batch',
        { type: 'campaign-batch', payload: { runId: run.id, batchIndex: b } },
        { jobId: campaignBatchJobId(run.id, b) }
      )
    }

    // Campaign state: SCHEDULED → ACTIVE through the existing machine.
    const state = campaign.status as CampaignState
    if (state === 'SCHEDULED' && canTransition(state, 'ACTIVE').ok) {
      await prisma.marketingCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE' } })
    }
    await prisma.emailCampaignConfig.update({
      where: { campaignId },
      data: { dispatchedAt: new Date(), dispatchedCount: eligible.length },
    })

    await audit('EMAIL_CAMPAIGN_DISPATCHED', actor, {
      campaignId,
      runId: run.id,
      totalRecipients: eligible.length,
      excluded: detailed.excluded.length,
      truncated: detailed.truncated,
      template: config.template,
    })

    log.info({ campaignId, runId: run.id, recipients: eligible.length, batches }, 'campaign dispatched')

    if (eligible.length === 0) await finalizeRunIfDone(run.id)
    return { ok: true, runId: run.id, totalRecipients: eligible.length, alreadyRunning: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Preparation died — the run records WHY, and a later dispatch may retry
    // cleanly because FAILED is not an unfinished state.
    await prisma.emailCampaignRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', error: message.slice(0, 500) } })
      .catch(() => undefined)
    log.error({ campaignId, runId: run.id, err: message }, 'campaign dispatch preparation FAILED')
    return { ok: false, error: `Dispatch preparation failed: ${message}` }
  }
}

// ── Per-recipient send ──────────────────────────────────────────────────

type RunRow = { id: string; campaignId: string; status: string; snapshot: unknown }

/**
 * Send to ONE claimed recipient. The caller has already moved the row to
 * SENDING; this function ends it in a terminal or deferred state.
 */
async function sendToRecipient(
  run: RunRow,
  recipient: { id: string; email: string; name: string | null; customerId: string | null; leadId: string | null; bookingId: string | null; attempts: number }
): Promise<RecipientState> {
  const snapshot = run.snapshot as { template: string; subject: string | null; sourceKey: string }
  const template = snapshot.template

  const settle = async (status: RecipientState, reason: string | null, emailSendId?: string): Promise<RecipientState> => {
    await prisma.emailCampaignRecipient.update({
      where: { id: recipient.id },
      data: { status, reason, ...(emailSendId ? { emailSendId } : {}) },
    })
    return status
  }

  // 1. LIVE context from the recipient's real rows. Fails closed.
  const candidate: Candidate = {
    email: recipient.email,
    name: recipient.name,
    customerId: recipient.customerId,
    leadId: recipient.leadId,
    bookingId: recipient.bookingId,
  }
  const context = await buildRecipientContext(template, candidate)
  if (!context.ok) {
    const status: RecipientState = context.reason.startsWith('context_ineligible') ? 'INELIGIBLE' : 'CONTEXT_INVALID'
    return settle(status, context.reason)
  }

  // 2. Compliance context (unsubscribe + postal address), per recipient.
  let payload = context.payload
  const marketing = buildMarketingContext(recipient.email, template, (payload.locale as string) ?? 'en')
  if (marketing.ok) payload = applyMarketingContext(payload, marketing.context)

  // 3. Render through the shared renderer — the same components every other
  //    path uses. A render failure is a retryable configuration problem.
  const rendered = await renderTemplate(template, payload)
  if ('error' in rendered) return settle('FAILED', `render_failed:${rendered.error}`.slice(0, 300))

  const subject = snapshot.subject?.trim() || templateByKey(template)?.subject || template

  // 4. THE GUARD. Suppression, caps, quiet hours, payload validation, the
  //    compliance gate and the idempotency claim all run inside guardedSend.
  const outcome = await guardedSend({
    to: recipient.email,
    subject,
    html: rendered.html,
    text: rendered.text,
    template,
    emailClass: 'promotional',
    journey: 'campaign',
    // IDEMPOTENCY LAYER 3: exactly-once per run + recipient + template.
    eventId: campaignRunEventId(run.id),
    bookingId: recipient.bookingId ?? undefined,
    leadId: recipient.leadId ?? undefined,
    campaign: snapshot.sourceKey,
    campaignId: run.campaignId,
    payload,
    // LIVE STATE RELOAD immediately before the claim: the run must still be
    // sendable AND the subject's own eligibility must still hold.
    recheck: async () => {
      const current = await prisma.emailCampaignRun.findUnique({ where: { id: run.id }, select: { status: true } })
      if (!current || !RUN_SENDABLE_STATES.has(current.status as RunState)) return 'run_not_sendable'
      if (recipient.bookingId) return bookingEligibility(template, recipient.bookingId)
      if (recipient.leadId) return leadEligibility(recipient.leadId)
      return null
    },
  })

  // 5. Map the guard's verdict onto the orchestration row.
  if (!outcome.sent && outcome.reason === 'run_not_sendable') {
    // Pause/cancel raced the claim — put the recipient back for resume.
    return settle('PENDING', 'run_not_sendable')
  }
  const mapped = recipientStateForOutcome(outcome)
  const status = await settle(mapped.status, mapped.reason, outcome.emailSendId)

  // 6. A deferral has a due time — schedule the single-recipient retry.
  if (status === 'DEFERRED' && !outcome.sent && outcome.retryAt) {
    const delay = Math.max(0, outcome.retryAt.getTime() - Date.now())
    await scheduledQueue
      .add(
        'campaign-recipient-retry',
        { type: 'campaign-recipient-retry', payload: { recipientId: recipient.id } },
        { delay, jobId: campaignRecipientJobId(recipient.id, recipient.attempts + 1) }
      )
      .catch((err) => log.warn({ err: String(err), recipientId: recipient.id }, 'deferral requeue failed — sweep will recover'))
  }
  return status
}

/**
 * Process one bounded batch. Recipients are claimed ATOMICALLY one at a time
 * (updateMany with a status filter), so two workers processing the same batch
 * cannot double-send, and a mid-batch crash leaves at most one row in SENDING
 * — which the stale sweep re-opens.
 */
export async function processCampaignBatch(runId: string, batchIndex: number): Promise<{ processed: number; halted: boolean }> {
  const run = await prisma.emailCampaignRun.findUnique({
    where: { id: runId },
    select: { id: true, campaignId: true, status: true, snapshot: true },
  })
  if (!run) return { processed: 0, halted: true }
  if (!RUN_SENDABLE_STATES.has(run.status as RunState)) {
    // PAUSED / CANCELLING / terminal: recipients stay PENDING. Resume
    // re-enqueues the batches; cancel marks them CANCELLED.
    log.info({ runId, batchIndex, status: run.status }, 'batch skipped — run not sendable')
    return { processed: 0, halted: true }
  }
  if (run.status === 'QUEUED') {
    await prisma.emailCampaignRun.updateMany({ where: { id: runId, status: 'QUEUED' }, data: { status: 'SENDING' } })
  }

  const rows = await prisma.emailCampaignRecipient.findMany({
    where: { runId, batchIndex, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, customerId: true, leadId: true, bookingId: true, attempts: true },
  })

  let processed = 0
  for (const recipient of rows) {
    // Re-check the run between sends so a pause takes effect mid-batch.
    const current = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true } })
    if (!current || !RUN_SENDABLE_STATES.has(current.status as RunState)) {
      log.info({ runId, batchIndex, processed }, 'batch halted mid-way — run left a sendable state')
      return { processed, halted: true }
    }

    // ATOMIC CLAIM: only one worker can move PENDING → SENDING.
    const { count } = await prisma.emailCampaignRecipient.updateMany({
      where: { id: recipient.id, status: 'PENDING' },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    })
    if (count === 0) continue

    try {
      await sendToRecipient(run, recipient)
    } catch (err) {
      // guardedSend throws for provider rejections so BullMQ retries — but a
      // batch must not die mid-list. Record and continue; the EmailSend row is
      // resumable and the retry sweep re-drives it.
      const message = err instanceof Error ? err.message : String(err)
      await prisma.emailCampaignRecipient
        .update({ where: { id: recipient.id }, data: { status: 'DEFERRED', reason: `provider_error:${message}`.slice(0, 300) } })
        .catch(() => undefined)
      await scheduledQueue
        .add(
          'campaign-recipient-retry',
          { type: 'campaign-recipient-retry', payload: { recipientId: recipient.id } },
          { delay: 5 * 60_000, jobId: campaignRecipientJobId(recipient.id, recipient.attempts + 1) }
        )
        .catch(() => undefined)
      log.warn({ runId, recipientId: recipient.id, err: message }, 'recipient send threw — deferred for retry')
    }
    processed++
  }

  await finalizeRunIfDone(runId)
  return { processed, halted: false }
}

/** Retry ONE deferred recipient (quiet hours / caps / provider hiccup). */
export async function processRecipientRetry(recipientId: string): Promise<void> {
  const recipient = await prisma.emailCampaignRecipient.findUnique({
    where: { id: recipientId },
    select: { id: true, runId: true, email: true, name: true, customerId: true, leadId: true, bookingId: true, attempts: true, status: true },
  })
  if (!recipient || recipient.status !== 'DEFERRED') return
  const run = await prisma.emailCampaignRun.findUnique({
    where: { id: recipient.runId },
    select: { id: true, campaignId: true, status: true, snapshot: true },
  })
  if (!run || !RUN_SENDABLE_STATES.has(run.status as RunState)) return

  const { count } = await prisma.emailCampaignRecipient.updateMany({
    where: { id: recipientId, status: 'DEFERRED' },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  })
  if (count === 0) return
  await sendToRecipient(run, recipient).catch(async (err) => {
    await prisma.emailCampaignRecipient
      .update({ where: { id: recipientId }, data: { status: 'DEFERRED', reason: `provider_error:${err instanceof Error ? err.message : String(err)}`.slice(0, 300) } })
      .catch(() => undefined)
  })
  await finalizeRunIfDone(recipient.runId)
}

// ── Run controls ────────────────────────────────────────────────────────

export type ControlResult = { ok: true; status: RunState } | { ok: false; error: string }

async function transitionRun(runId: string, to: RunState): Promise<ControlResult> {
  const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true } })
  if (!run) return { ok: false, error: 'That run does not exist.' }
  const verdict = canTransitionRun(run.status as RunState, to)
  if (!verdict.ok) return { ok: false, error: verdict.error }
  // Guarded write: only move if the state is still what we checked.
  const { count } = await prisma.emailCampaignRun.updateMany({ where: { id: runId, status: run.status }, data: { status: to } })
  if (count === 0) return { ok: false, error: 'The run changed state concurrently — reload and retry.' }
  return { ok: true, status: to }
}

/** Pause: unprocessed recipients hold. Batch loops observe within one send. */
export async function pauseRun(runId: string, actor: ActorContext): Promise<ControlResult> {
  const result = await transitionRun(runId, 'PAUSED')
  if (result.ok) await audit('EMAIL_CAMPAIGN_RUN_PAUSED', actor, { runId })
  return result
}

/** Resume: back to QUEUED and re-enqueue every batch that still has PENDING rows. */
export async function resumeRun(runId: string, actor: ActorContext): Promise<ControlResult> {
  const result = await transitionRun(runId, 'QUEUED')
  if (!result.ok) return result
  const pending = await prisma.emailCampaignRecipient.groupBy({
    by: ['batchIndex'],
    where: { runId, status: 'PENDING', batchIndex: { not: null } },
  })
  for (const g of pending) {
    if (g.batchIndex === null) continue
    await scheduledQueue.add(
      'campaign-batch',
      { type: 'campaign-batch', payload: { runId, batchIndex: g.batchIndex } },
      // Deterministic per resume-generation? No — the ORIGINAL id may still
      // exist as a completed job; suffix with a nonce derived from time bucket
      // so a resume can re-enqueue while a same-second double-click cannot.
      { jobId: `${campaignBatchJobId(runId, g.batchIndex)}:resume:${Math.floor(Date.now() / 10_000)}` }
    )
  }
  await audit('EMAIL_CAMPAIGN_RUN_RESUMED', actor, { runId, batches: pending.length })
  return result
}

/** Cancel: every recipient not yet in a terminal state is marked CANCELLED. */
export async function cancelRun(runId: string, actor: ActorContext): Promise<ControlResult> {
  const result = await transitionRun(runId, 'CANCELLING')
  if (!result.ok) return result
  await prisma.emailCampaignRecipient.updateMany({
    where: { runId, status: { in: ['PENDING', 'DEFERRED'] } },
    data: { status: 'CANCELLED', reason: 'run_cancelled' },
  })
  await audit('EMAIL_CAMPAIGN_RUN_CANCELLED', actor, { runId })
  await finalizeRunIfDone(runId)
  return { ok: true, status: 'CANCELLING' }
}

/** Deliberately re-open FAILED (and stuck-DEFERRED) recipients for another pass. */
export async function retryFailedRecipients(runId: string, actor: ActorContext): Promise<{ ok: boolean; reopened: number; error?: string }> {
  const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true } })
  if (!run) return { ok: false, reopened: 0, error: 'That run does not exist.' }
  if (!RUN_SENDABLE_STATES.has(run.status as RunState) && run.status !== 'COMPLETED_WITH_ERRORS') {
    return { ok: false, reopened: 0, error: `Recipients of a ${run.status} run cannot be retried.` }
  }
  const { count } = await prisma.emailCampaignRecipient.updateMany({
    where: { runId, status: { in: Array.from(RECIPIENT_RETRYABLE_STATES) as RecipientState[] } },
    data: { status: 'PENDING', reason: 'manual_retry' },
  })
  if (count > 0) {
    // A finished-with-errors run re-opens for the retry pass.
    if (run.status === 'COMPLETED_WITH_ERRORS') {
      await prisma.emailCampaignRun.updateMany({ where: { id: runId, status: 'COMPLETED_WITH_ERRORS' }, data: { status: 'SENDING', completedAt: null } })
    }
    const groups = await prisma.emailCampaignRecipient.groupBy({
      by: ['batchIndex'],
      where: { runId, status: 'PENDING', batchIndex: { not: null } },
    })
    for (const g of groups) {
      if (g.batchIndex === null) continue
      await scheduledQueue.add(
        'campaign-batch',
        { type: 'campaign-batch', payload: { runId, batchIndex: g.batchIndex } },
        { jobId: `${campaignBatchJobId(runId, g.batchIndex)}:retry:${Math.floor(Date.now() / 10_000)}` }
      )
    }
  }
  await audit('EMAIL_CAMPAIGN_RETRY_INITIATED', actor, { runId, reopened: count })
  return { ok: true, reopened: count }
}

// ── Finalization + recovery ─────────────────────────────────────────────

/** Recompute counters from recipient rows; close the run when settled. */
export async function finalizeRunIfDone(runId: string): Promise<void> {
  const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true, campaignId: true } })
  if (!run) return
  const state = run.status as RunState
  if (['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(state)) return

  const grouped = await prisma.emailCampaignRecipient.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } })
  const counts: Partial<Record<RecipientState, number>> = {}
  for (const g of grouped) counts[g.status as RecipientState] = g._count._all

  const sent = counts.SENT ?? 0
  const failed = counts.FAILED ?? 0
  const cancelled = counts.CANCELLED ?? 0
  const skipped =
    (counts.SKIPPED ?? 0) + (counts.SUPPRESSED ?? 0) + (counts.UNSUBSCRIBED ?? 0) + (counts.INELIGIBLE ?? 0) + (counts.CONTEXT_INVALID ?? 0)

  const data: Record<string, unknown> = { sentCount: sent, failedCount: failed, cancelledCount: cancelled, skippedCount: skipped }

  if (runIsSettled(counts)) {
    const finalState = settledRunState(counts, state === 'CANCELLING')
    data.status = finalState
    data.completedAt = new Date()
    // Campaign state follows the run: ACTIVE → COMPLETED via the machine.
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id: run.campaignId }, select: { status: true } })
    if (campaign && finalState !== 'CANCELLED' && canTransition(campaign.status as CampaignState, 'COMPLETED').ok) {
      await prisma.marketingCampaign.update({ where: { id: run.campaignId }, data: { status: 'COMPLETED' } })
    }
    log.info({ runId, finalState, sent, failed, skipped, cancelled }, 'campaign run finalized')
  }

  await prisma.emailCampaignRun.updateMany({ where: { id: runId, status: run.status }, data: data as never })
}

/** How long a recipient may sit in SENDING before the sweep re-opens it. */
const RECIPIENT_STALE_MS = Number(process.env.EMAIL_CAMPAIGN_STALE_MS) || 15 * 60_000

/**
 * The periodic sweep (cron in the scheduled worker):
 *  1. dispatch campaigns whose scheduledAt has arrived;
 *  2. re-open recipients stuck in SENDING (worker died mid-attempt — the
 *     EmailSend claim below still guarantees no duplicate);
 *  3. re-enqueue batches that still have PENDING rows on sendable runs
 *     (lost queue jobs after a crash/restart);
 *  4. finalize settled runs.
 */
export async function sweepCampaignRuns(): Promise<{ dispatched: number; reopened: number; requeued: number }> {
  let dispatched = 0
  let reopened = 0
  let requeued = 0

  // 1. Due SCHEDULED campaigns.
  const due = await prisma.marketingCampaign.findMany({
    where: {
      channel: 'EMAIL',
      status: 'SCHEDULED',
      emailConfig: { is: { scheduledAt: { lte: new Date() }, approvedAt: { not: null } } },
    },
    select: { id: true },
    take: 10,
  })
  for (const c of due) {
    const result = await dispatchCampaign(c.id, SYSTEM_ACTOR)
    if (result.ok && !result.alreadyRunning) dispatched++
    else if (!result.ok) log.warn({ campaignId: c.id, error: result.error }, 'scheduled dispatch refused')
  }

  // 2 + 3 + 4 for unfinished runs.
  const active = await prisma.emailCampaignRun.findMany({
    where: { status: { in: ['QUEUED', 'SENDING', 'CANCELLING'] } },
    select: { id: true, status: true },
    take: 50,
  })
  for (const run of active) {
    const stale = await prisma.emailCampaignRecipient.updateMany({
      where: { runId: run.id, status: 'SENDING', updatedAt: { lt: new Date(Date.now() - RECIPIENT_STALE_MS) } },
      data: { status: 'PENDING', reason: 'stale_claim_reopened' },
    })
    reopened += stale.count

    if (RUN_SENDABLE_STATES.has(run.status as RunState)) {
      const groups = await prisma.emailCampaignRecipient.groupBy({
        by: ['batchIndex'],
        where: { runId: run.id, status: 'PENDING', batchIndex: { not: null }, updatedAt: { lt: new Date(Date.now() - RECIPIENT_STALE_MS) } },
      })
      for (const g of groups) {
        if (g.batchIndex === null) continue
        await scheduledQueue.add(
          'campaign-batch',
          { type: 'campaign-batch', payload: { runId: run.id, batchIndex: g.batchIndex } },
          { jobId: `${campaignBatchJobId(run.id, g.batchIndex)}:sweep:${Math.floor(Date.now() / 60_000)}` }
        )
        requeued++
      }
    }
    await finalizeRunIfDone(run.id)
  }

  if (dispatched || reopened || requeued) log.info({ dispatched, reopened, requeued }, 'campaign sweep did work')
  return { dispatched, reopened, requeued }
}
