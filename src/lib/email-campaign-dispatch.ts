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
//   3. Deferred sends (quiet hours / caps / transient read failures) carry a
//      durable nextAttemptAt and are re-queued to it; the sweep re-drives any
//      whose job was lost. finalizeRunIfDone() recomputes counters from
//      recipient rows and closes the run; sweepCampaignRuns() dispatches due
//      SCHEDULED campaigns, recovers stale runs after a crash, and finalizes
//      settled ones.
//
//  EXACTLY-ONCE: three independent layers —
//   • one unfinished run per campaign, enforced by the DATABASE (the partial
//     unique index email_campaign_runs_one_unfinished_per_campaign) and
//     serialised by a per-campaign advisory lock (claimCampaignRunSlot);
//   • UNIQUE(runId, email) on recipients (re-dispatch cannot duplicate rows);
//   • the EmailSend idempotency key anchored on campaignRunEventId(runId)
//     (a batch retry or worker restart resumes the SAME logical send).
//  Recipient rows are claimed and settled compare-and-set on `attempts`, so a
//  stale worker can never overwrite a newer attempt's result.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { needsReapproval } from './email-campaign-approval'
import { queueLogger } from './logger'
import { scheduledQueue } from './queues'
import { guardedSend, SENDING_STALE_MS } from './email-guard'
import { renderTemplate } from './email-render'
import { templateByKey } from './email-registry'
import { bookingEligibility } from './email-eligibility'
import { leadEligibility } from './journeys'
import { buildMarketingContext, applyMarketingContext } from './marketing-context'
import { validateCampaign, canDispatch, canTransition, type CampaignState, type CampaignValidation } from './email-campaign'
import { validateAudienceDefinition, resolveAudienceDetailed, MAX_AUDIENCE, type AudienceDefinition, type Candidate } from './email-audience'
import { buildRecipientContext, templateAllowsSegment } from './email-recipient-context'
// The operations agent's kill switch. Imported from `settings` rather than the
// agent barrel so this hot path never pulls the checks, providers or runner
// into a Next.js route bundle.
import { isMarketingDispatchPaused, pauseRefusalMessage } from './email-agent/settings'
import {
  CAMPAIGN_BATCH_SIZE,
  RUN_SENDABLE_STATES,
  RECIPIENT_RETRYABLE_STATES,
  UNFINISHED_RUN_STATES,
  batchCount,
  campaignBatchJobId,
  campaignRecipientJobId,
  campaignRunEventId,
  canTransitionRun,
  editedAfterApproval,
  isRunSlotConflict,
  isTransientReadFailure,
  isTransientTxError,
  planRecipientRetry,
  promotionsEnabled,
  recipientClaimWhere,
  recipientSettlementWhere,
  recipientStateForOutcome,
  runIsSettled,
  runSlotLockKey,
  settledRunState,
  type RunState,
  type RecipientState,
} from './email-campaign-run'

const log = queueLogger.child({ mod: 'email-campaign-dispatch' })

export type ActorContext = { userId: string | null; name: string | null }
export const SYSTEM_ACTOR: ActorContext = { userId: null, name: 'scheduler' }

export type DispatchResult =
  | { ok: true; runId: string; totalRecipients: number; alreadyRunning: boolean }
  // `conflict`: not a refusal of the campaign — another dispatch holds the
  // slot or the database was busy. The sweep does not write it to statusNote.
  | { ok: false; error: string; conflict?: true }

/**
 * The I/O a recipient send reaches beyond Prisma. Injected so the send, retry,
 * deferral and sweep paths are testable offline without a provider, a
 * renderer or Redis. Production always uses defaultCampaignDispatchDeps().
 */
export type CampaignDispatchDeps = {
  guardedSend: typeof guardedSend
  buildRecipientContext: typeof buildRecipientContext
  renderTemplate: typeof renderTemplate
  enqueue: (name: 'campaign-batch' | 'campaign-recipient-retry', data: unknown, opts: { delay?: number; jobId: string }) => Promise<unknown>
  now: () => number
}

export function defaultCampaignDispatchDeps(): CampaignDispatchDeps {
  return {
    guardedSend,
    buildRecipientContext,
    renderTemplate,
    enqueue: (name, data, opts) => scheduledQueue.add(name, data as never, opts),
    now: () => Date.now(),
  }
}

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
  if (needsReapproval(config)) {
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

// ── Run slot (one unfinished run per campaign) ──────────────────────────

export type RunSlotClaim =
  | { claimed: true; runId: string }
  | { claimed: false; existing: { id: string; totalRecipients: number; status: string } }
  | { claimed: false; existing: null; conflict: true; busy: boolean }

type RunSlotDb = Pick<typeof prisma, '$transaction' | 'emailCampaignRun'>

/**
 * Claim the campaign's single unfinished-run slot by creating its PREPARING
 * run — or return the run that already holds it.
 *
 * THE RACE THIS CLOSES (2026-09-15): dispatchCampaign used to findFirst an
 * unfinished run, do unlocked work, then create. Two callers (an admin
 * double-click in the API process, the 15-minute sweep in the worker host)
 * could each create a run, and because the idempotency key is per RUN, every
 * recipient could be emailed twice.
 *
 * Two mechanisms, each doing what it is good at:
 *   1. pg_advisory_xact_lock on a per-campaign key — TRANSACTION-scoped, so
 *      the Neon pooler cannot strand it — makes check-and-create atomic for
 *      every caller running this code. Under READ COMMITTED the findFirst
 *      after the lock sees a winner that already committed.
 *   2. The partial unique index is the cross-version guard: a writer that
 *      bypassed the lock gets 23505 (P2002), and the winner is returned.
 * The transaction holds no audience resolution and no queue I/O; the PREPARING
 * row itself is the lease for the long preparation that follows.
 */
export async function claimCampaignRunSlot(
  campaignId: string,
  data: { snapshot: unknown; preflight: unknown; startedById: string | null; startedByName: string | null },
  db: RunSlotDb = prisma,
  txOptions: { maxWait?: number; timeout?: number } = {}
): Promise<RunSlotClaim> {
  const unfinished = { campaignId, status: { in: [...UNFINISHED_RUN_STATES] } }
  try {
    return await db.$transaction(
      async (tx) => {
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and
        // Prisma cannot deserialize a void column.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${runSlotLockKey(campaignId)}::text, 0))`
        const existing = await tx.emailCampaignRun.findFirst({
          where: unfinished,
          select: { id: true, totalRecipients: true, status: true },
        })
        if (existing) return { claimed: false as const, existing }
        const run = await tx.emailCampaignRun.create({
          data: {
            campaignId,
            status: 'PREPARING',
            snapshot: data.snapshot as never,
            preflight: data.preflight as never,
            startedById: data.startedById,
            startedByName: data.startedByName,
          },
          select: { id: true },
        })
        return { claimed: true as const, runId: run.id }
      },
      { maxWait: txOptions.maxWait ?? 5_000, timeout: txOptions.timeout ?? 10_000 }
    )
  } catch (err) {
    if (isRunSlotConflict(err)) {
      const existing = await db.emailCampaignRun
        .findFirst({ where: unfinished, select: { id: true, totalRecipients: true, status: true } })
        .catch(() => null)
      log.warn({ campaignId, runId: existing?.id ?? null }, 'run slot unique violation — returning the winner')
      if (existing) return { claimed: false, existing }
      return { claimed: false, existing: null, conflict: true, busy: false }
    }
    if (isTransientTxError(err)) {
      log.warn({ campaignId, code: (err as { code?: string }).code }, 'run slot claim hit a busy database — not a refusal')
      return { claimed: false, existing: null, conflict: true, busy: true }
    }
    throw err
  }
}

/** Recipient counters recomputed from rows — the same arithmetic the finalizer uses. */
async function recipientCounters(runId: string): Promise<{ sentCount: number; failedCount: number; cancelledCount: number; skippedCount: number }> {
  const grouped = await prisma.emailCampaignRecipient.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } })
  const counts: Partial<Record<RecipientState, number>> = {}
  for (const g of grouped) counts[g.status as RecipientState] = g._count._all
  return {
    sentCount: counts.SENT ?? 0,
    failedCount: counts.FAILED ?? 0,
    cancelledCount: counts.CANCELLED ?? 0,
    skippedCount:
      (counts.SKIPPED ?? 0) + (counts.SUPPRESSED ?? 0) + (counts.UNSUBSCRIBED ?? 0) + (counts.INELIGIBLE ?? 0) + (counts.CONTEXT_INVALID ?? 0),
  }
}

/**
 * Preparation finished, but the run had already LEFT PREPARING — an owner
 * cancel (PREPARING → CANCELLING → CANCELLED) or the sweep failing it as
 * abandoned. Before 2026-09-15 an unconditional write moved it to QUEUED and
 * the cancelled campaign sent anyway. The rows written by this preparation
 * were never submitted, so they are cancelled; counters are recomputed here
 * because finalizeRunIfDone returns early for a terminal run.
 */
async function abortSupersededPreparation(runId: string, campaignId: string, totalRecipients: number): Promise<DispatchResult> {
  const current = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true } })
  await prisma.emailCampaignRecipient.updateMany({
    where: { runId, status: 'PENDING', emailSendId: null },
    data: { status: 'CANCELLED', reason: 'run_preparation_superseded' },
  })
  const counters = await recipientCounters(runId)
  await prisma.emailCampaignRun.updateMany({ where: { id: runId }, data: { ...counters, totalRecipients } })
  // A run caught mid-cancel (CANCELLING) still needs its own close.
  await finalizeRunIfDone(runId)
  log.warn({ campaignId, runId, currentStatus: current?.status ?? null }, 'preparation finished after the run left PREPARING — no batches enqueued')
  return { ok: false, error: 'This dispatch was cancelled or expired while its recipient list was being prepared. Nothing was sent.' }
}

/**
 * Settle a recipient this attempt still owns. Returns false — and writes
 * nothing — when the sweep re-opened the row or a newer attempt claimed it.
 */
export async function settleRecipient(
  recipientId: string,
  claimAttempt: number,
  data: { status: RecipientState; reason: string | null; emailSendId?: string; nextAttemptAt?: Date | null; transientAttempts?: number }
): Promise<boolean> {
  const { count } = await prisma.emailCampaignRecipient.updateMany({
    where: recipientSettlementWhere(recipientId, claimAttempt),
    data: {
      status: data.status,
      reason: data.reason,
      nextAttemptAt: data.nextAttemptAt ?? null,
      ...(data.emailSendId ? { emailSendId: data.emailSendId } : {}),
      ...(data.transientAttempts !== undefined ? { transientAttempts: data.transientAttempts } : {}),
    },
  })
  return count === 1
}

// ── Dispatch ────────────────────────────────────────────────────────────

/**
 * THE campaign executor entry point. Idempotent: a repeat call while a run is
 * unfinished returns that run instead of creating a duplicate.
 */
export async function dispatchCampaign(
  campaignId: string,
  actor: ActorContext,
  opts: { acknowledgeTruncation?: boolean } = {},
  deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()
): Promise<DispatchResult> {
  const acknowledgedTruncation = opts.acknowledgeTruncation === true

  // ── THE GLOBAL KILL SWITCH (owner spec 2026-07-27) ─────────────────────
  // Checked HERE, at the top of the one function every dispatch goes through —
  // manual, scheduled sweep and retry alike — because a switch that only hides
  // an admin button is not a kill switch. The read fails open by design (see
  // isMarketingDispatchPaused): a monitoring table being unreachable must not
  // become an outage of the business's email, and the degraded read is itself
  // reported by the agent's `infrastructure.agent_settings_unreadable` check.
  const pause = await isMarketingDispatchPaused()
  if (pause.paused) {
    log.warn({ campaignId, pausedBy: pause.by }, 'dispatch refused — marketing dispatch is paused')
    return { ok: false, error: pauseRefusalMessage(pause) }
  }

  const campaign = await loadCampaign(campaignId)
  if (!campaign || campaign.channel !== 'EMAIL') return { ok: false, error: 'That email campaign does not exist.' }
  const config = campaign.emailConfig
  if (!config) return { ok: false, error: 'This campaign has no email configuration.' }

  // IDEMPOTENCY LAYER 1 (fast path): one unfinished run per campaign. The
  // authoritative check is repeated under the lock in claimCampaignRunSlot.
  const existing = await prisma.emailCampaignRun.findFirst({
    where: { campaignId, status: { in: [...UNFINISHED_RUN_STATES] } },
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

  const slot = await claimCampaignRunSlot(campaignId, {
    snapshot,
    preflight: { validation: preflight.validation, promotionsEnabled: true, checkedAt: new Date().toISOString() },
    startedById: actor.userId,
    startedByName: actor.name,
  })
  if (!slot.claimed) {
    if (slot.existing) {
      log.info({ campaignId, runId: slot.existing.id, status: slot.existing.status }, 'dispatch lost the run-slot race — returning the existing run')
      return { ok: true, runId: slot.existing.id, totalRecipients: slot.existing.totalRecipients, alreadyRunning: true }
    }
    return {
      ok: false,
      conflict: true,
      error: slot.busy
        ? 'The database was busy starting this dispatch — retry in a moment.'
        : 'Another dispatch of this campaign is starting right now. Reload to see its run.',
    }
  }
  const run = { id: slot.runId }

  let eligibleCount = 0
  let excludedCount = 0
  let truncated = false
  try {
    // Resolve the audience from CURRENT state — never a cached preview.
    // campaignId is passed so prior AMBIGUOUS sends for THIS campaign are held
    // out (audit E-03) — the one path by which a re-dispatch could duplicate.
    const detailed = await resolveAudienceDetailed(preflight.audience, { campaignId })

    // TRUNCATION IS NOT SILENT (audit E-05). resolveCandidates stops at
    // MAX_AUDIENCE, so recipients beyond it are never fetched and get NO row
    // and NO reason — breaking the rule that every recipient is accounted for.
    // The owner would see a completed campaign and believe everyone was mailed.
    if (detailed.truncated && !acknowledgedTruncation) {
      throw new Error(
        `This audience is larger than ${MAX_AUDIENCE} and would be silently cut off at ${MAX_AUDIENCE} recipients. ` +
          `Everyone beyond that would receive nothing and have no record explaining why. ` +
          `Narrow the audience, or re-send this dispatch with acknowledgeTruncation to accept the cut deliberately.`
      )
    }
    const eligible = detailed.eligible.slice(0, MAX_AUDIENCE)
    eligibleCount = eligible.length
    excludedCount = detailed.excluded.length
    truncated = detailed.truncated

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

    // PREPARING → QUEUED and the campaign's SCHEDULED → ACTIVE in ONE short
    // transaction, BEFORE any batch is enqueued. Both writes are conditional:
    //  • the run moves only if it is STILL PREPARING, so a cancel or an
    //    abandoned-run reclaim during preparation is never resurrected;
    //  • the campaign leaves SCHEDULED together with the run going live, so a
    //    later failure can never leave a SCHEDULED campaign with a sent run
    //    that the sweep would dispatch a second time.
    const queued = await prisma.$transaction(
      async (tx) => {
        const moved = await tx.emailCampaignRun.updateMany({
          where: { id: run.id, status: 'PREPARING' },
          data: {
            status: 'QUEUED',
            totalRecipients: eligible.length,
            skippedCount: detailed.excluded.length,
            // Recorded on the RUN so the operator sees it on the run card, not only
            // in the audit log nobody reads during a send.
            ...(detailed.truncated
              ? { error: `TRUNCATED: the audience exceeded ${MAX_AUDIENCE}; recipients beyond that were not included in this run.` }
              : {}),
          },
        })
        if (moved.count === 0) return false
        await tx.marketingCampaign.updateMany({ where: { id: campaignId, status: 'SCHEDULED' }, data: { status: 'ACTIVE' } })
        return true
      },
      { maxWait: 5_000, timeout: 10_000 }
    )
    if (!queued) return await abortSupersededPreparation(run.id, campaignId, eligible.length)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Preparation died — the run records WHY, and a later dispatch may retry
    // cleanly because FAILED is not an unfinished state. Conditional on
    // PREPARING, so it can never clobber a run someone else already moved.
    await prisma.emailCampaignRun
      .updateMany({ where: { id: run.id, status: 'PREPARING' }, data: { status: 'FAILED', completedAt: new Date(), error: message.slice(0, 500) } })
      .catch(() => undefined)
    log.error({ campaignId, runId: run.id, err: message }, 'campaign dispatch preparation FAILED')
    return { ok: false, error: `Dispatch preparation failed: ${message}` }
  }

  // ── THE RUN IS LIVE FROM HERE ─────────────────────────────────────────
  // Nothing below may report a failed dispatch: the run is QUEUED and will
  // send. A lost batch enqueue is re-driven by the sweep (PENDING rows on a
  // sendable run); bookkeeping failures are logged, never returned.
  const batches = batchCount(eligibleCount)
  try {
    // Enqueue bounded batches with deterministic job ids — a crash between two
    // adds re-enqueues safely, BullMQ dedupes on the id.
    for (let b = 0; b < batches; b++) {
      await deps.enqueue(
        'campaign-batch',
        { type: 'campaign-batch', payload: { runId: run.id, batchIndex: b } },
        { jobId: campaignBatchJobId(run.id, b) }
      )
    }
  } catch (err) {
    log.error({ campaignId, runId: run.id, err: String(err) }, 'post-queue step failed — sweep will re-drive lost batches')
  }

  await prisma.emailCampaignConfig
    .update({
      where: { campaignId },
      data: { dispatchedAt: new Date(), dispatchedCount: eligibleCount },
    })
    .catch((err) => log.error({ campaignId, runId: run.id, err: String(err) }, 'could not record dispatchedAt (non-fatal — the run is live)'))

  await audit('EMAIL_CAMPAIGN_DISPATCHED', actor, {
    campaignId,
    runId: run.id,
    totalRecipients: eligibleCount,
    excluded: excludedCount,
    truncated,
    truncationAcknowledged: truncated ? acknowledgedTruncation : undefined,
    template: config.template,
  })

  log.info({ campaignId, runId: run.id, recipients: eligibleCount, batches }, 'campaign dispatched')

  if (eligibleCount === 0) {
    await finalizeRunIfDone(run.id).catch((err) => log.error({ campaignId, runId: run.id, err: String(err) }, 'empty-run finalize failed — the sweep will finalize it'))
  }
  return { ok: true, runId: run.id, totalRecipients: eligibleCount, alreadyRunning: false }
}

// ── Per-recipient send ──────────────────────────────────────────────────

type RunRow = { id: string; campaignId: string; status: string; snapshot: unknown }

type RecipientRow = {
  id: string
  email: string
  name: string | null
  customerId: string | null
  leadId: string | null
  bookingId: string | null
  attempts: number
  transientAttempts: number
}

/** How long a guard `in_flight` refusal waits: past the guard's own stale window. */
const IN_FLIGHT_RETRY_MS = SENDING_STALE_MS + 60_000

/**
 * Send to ONE claimed recipient. The caller has already moved the row to
 * SENDING with token `claimAttempt`; this function ends it in a terminal or
 * deferred state — or returns 'SUPERSEDED' without writing when a newer claim
 * owns the row.
 */
export async function sendToRecipient(
  run: RunRow,
  recipient: RecipientRow,
  claimAttempt: number,
  deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()
): Promise<RecipientState | 'SUPERSEDED'> {
  const snapshot = run.snapshot as { template: string; subject: string | null; sourceKey: string }
  const template = snapshot.template

  const settle = async (data: {
    status: RecipientState
    reason: string | null
    emailSendId?: string
    nextAttemptAt?: Date | null
    transientAttempts?: number
    sent?: boolean
  }): Promise<RecipientState | 'SUPERSEDED'> => {
    const { sent, ...write } = data
    if (await settleRecipient(recipient.id, claimAttempt, write)) return data.status
    const current = await prisma.emailCampaignRecipient
      .findUnique({ where: { id: recipient.id }, select: { status: true, reason: true, attempts: true } })
      .catch(() => null)
    const fields = {
      runId: run.id,
      recipientId: recipient.id,
      claimAttempt,
      wanted: data.status,
      reason: data.reason,
      emailSendId: data.emailSendId ?? null,
      sent: sent === true,
      currentStatus: current?.status ?? null,
      currentReason: current?.reason ?? null,
    }
    if (sent) log.error(fields, 'campaign recipient settlement superseded — a newer claim owns this row')
    else if (data.status === 'DEFERRED' || data.status === 'PENDING') log.error(fields, 'superseded retryable outcome')
    else log.warn(fields, 'campaign recipient settlement superseded — a newer claim owns this row')
    return 'SUPERSEDED'
  }

  // A deferral's due time is written to the row FIRST; the job is only the
  // fast path. If the add fails, sweep step 3b re-drives the row.
  const scheduleRetry = async (at: Date): Promise<void> => {
    await deps
      .enqueue(
        'campaign-recipient-retry',
        { type: 'campaign-recipient-retry', payload: { recipientId: recipient.id } },
        { delay: Math.max(0, at.getTime() - deps.now()), jobId: campaignRecipientJobId(recipient.id, claimAttempt) }
      )
      .catch((err) => log.warn({ err: String(err), recipientId: recipient.id }, 'deferral requeue failed — sweep will recover'))
  }

  // Deferral / backoff / exhaustion for one outcome, in one place.
  const applyOutcome = async (
    outcome: { sent: boolean; reason?: string | null; retryAt?: Date | null },
    mapped: { status: RecipientState; reason: string | null },
    emailSendId?: string
  ): Promise<RecipientState | 'SUPERSEDED'> => {
    const plan = planRecipientRetry(outcome, mapped.status, recipient.transientAttempts, deps.now())
    if (plan.action === 'exhausted') {
      const settled = await settle({ status: 'FAILED', reason: plan.reason, emailSendId, transientAttempts: plan.transientAttempts })
      if (settled !== 'SUPERSEDED') {
        log.error(
          { event: 'CAMPAIGN_RECIPIENT_TRANSIENT_EXHAUSTED', runId: run.id, recipientId: recipient.id, reason: outcome.reason, transientAttempts: plan.transientAttempts },
          'transient read failures exhausted — recipient FAILED (re-openable), never suppressed'
        )
      }
      return settled
    }
    if (plan.action === 'transient' || plan.action === 'policy') {
      const settled = await settle({
        status: 'DEFERRED',
        reason: mapped.reason,
        emailSendId,
        nextAttemptAt: plan.at,
        transientAttempts: plan.transientAttempts,
      })
      if (settled === 'SUPERSEDED') return settled
      if (plan.action === 'transient') {
        log.warn(
          {
            event: 'CAMPAIGN_RECIPIENT_TRANSIENT_DEFERRED',
            runId: run.id,
            recipientId: recipient.id,
            reason: mapped.reason,
            transientAttempts: plan.transientAttempts,
            nextAttemptAt: plan.at.toISOString(),
          },
          'transient read failure — recipient deferred with backoff, nothing sent'
        )
      }
      await scheduleRetry(plan.at)
      return settled
    }
    return settle({
      status: mapped.status,
      reason: mapped.reason,
      emailSendId,
      // The transient budget resets on SENT or any terminal state; an undated
      // DEFERRED (unchanged legacy behaviour) keeps it.
      transientAttempts: mapped.status === 'DEFERRED' ? undefined : 0,
      sent: outcome.sent,
    })
  }

  // 1. LIVE context from the recipient's real rows. Fails closed.
  const candidate: Candidate = {
    email: recipient.email,
    name: recipient.name,
    customerId: recipient.customerId,
    leadId: recipient.leadId,
    bookingId: recipient.bookingId,
  }
  const context = await deps.buildRecipientContext(template, candidate)
  if (!context.ok) {
    // A thrown read inside the context builder (context_error:) is an outage,
    // not a fact about this person — in a real database blip it usually fires
    // BEFORE the suppression read. Backoff, never CONTEXT_INVALID.
    if (isTransientReadFailure(context.reason)) {
      return applyOutcome({ sent: false, reason: context.reason }, { status: 'DEFERRED', reason: context.reason })
    }
    const status: RecipientState = context.reason.startsWith('context_ineligible') ? 'INELIGIBLE' : 'CONTEXT_INVALID'
    return settle({ status, reason: context.reason, transientAttempts: 0 })
  }

  // 2. Compliance context (unsubscribe + postal address), per recipient.
  let payload = context.payload
  const marketing = buildMarketingContext(recipient.email, template, (payload.locale as string) ?? 'en')
  if (marketing.ok) payload = applyMarketingContext(payload, marketing.context)

  // 3. Render through the shared renderer — the same components every other
  //    path uses. A render failure is a retryable configuration problem.
  const rendered = await deps.renderTemplate(template, payload)
  if ('error' in rendered) return settle({ status: 'FAILED', reason: `render_failed:${rendered.error}`.slice(0, 300), transientAttempts: 0 })

  const subject = snapshot.subject?.trim() || templateByKey(template)?.subject || template

  // 3b. OWNERSHIP PRE-CHECK. Context and render take time; if the sweep
  //     re-opened this row meanwhile, a newer attempt may already own it. A
  //     superseded attempt must not reach the provider at all. Deliberately NOT
  //     inside the guard's recheck: a recheck refusal is recorded on the
  //     EmailSend row, which would rewrite the newer attempt's ledger state.
  const owner = await prisma.emailCampaignRecipient.findUnique({ where: { id: recipient.id }, select: { status: true, attempts: true } })
  if (!owner || owner.status !== 'SENDING' || owner.attempts !== claimAttempt) {
    log.warn(
      { runId: run.id, recipientId: recipient.id, claimAttempt, currentStatus: owner?.status ?? null, currentAttempts: owner?.attempts ?? null },
      'claim superseded before provider call'
    )
    return 'SUPERSEDED'
  }

  // 4. THE GUARD. Suppression, caps, quiet hours, payload validation, the
  //    compliance gate and the idempotency claim all run inside guardedSend.
  const outcome = await deps.guardedSend({
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
      // The TEMPLATE selects the eligibility matrix (2026-09-15). Without it every
      // lead recipient was judged by the quote-follow-up matrix, so a
      // contact-lead reactivation campaign (lead-nurture-final, audience
      // quotedAt: null by definition) refused 100% of recipients as `no_quote`.
      // Consent is still enforced by whichever matrix applies.
      if (recipient.leadId) return leadEligibility(recipient.leadId, template)
      // No subject to re-check means no live consent check: refuse, never pass.
      return 'no_recheck_subject'
    },
  })

  // 5. Map the guard's verdict onto the orchestration row.
  if (!outcome.sent && outcome.reason === 'run_not_sendable') {
    // Pause/cancel raced the claim — put the recipient back for resume.
    return settle({ status: 'PENDING', reason: 'run_not_sendable' })
  }
  if (!outcome.sent && outcome.reason === 'in_flight') {
    // Another attempt holds the live EmailSend claim (typically the stale
    // worker whose row the sweep re-opened). SKIPPED would close this row for
    // good and — with settlement CAS refusing the old worker's write — lose
    // the email if that attempt then fails. Retry after the guard's stale
    // window instead; the same idempotency key answers 'duplicate' if it sent.
    const at = new Date(deps.now() + IN_FLIGHT_RETRY_MS)
    const settled = await settle({ status: 'DEFERRED', reason: 'in_flight', emailSendId: outcome.emailSendId, nextAttemptAt: at })
    if (settled !== 'SUPERSEDED') await scheduleRetry(at)
    return settled
  }
  return applyOutcome(outcome, recipientStateForOutcome(outcome), outcome.emailSendId)
}

/**
 * A recipient send threw (guardedSend throws for provider rejections so
 * BullMQ would retry). Defer it with a durable due time — only if this
 * attempt still owns the row — and queue the retry.
 */
async function deferAfterThrow(recipientId: string, claimAttempt: number, err: unknown, deps: CampaignDispatchDeps): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err)
  const at = new Date(deps.now() + 5 * 60_000)
  const won = await settleRecipient(recipientId, claimAttempt, {
    status: 'DEFERRED',
    reason: `provider_error:${message}`.slice(0, 300),
    nextAttemptAt: at,
  }).catch(() => false)
  if (!won) {
    log.error({ recipientId, claimAttempt, err: message }, 'superseded retryable outcome')
    return false
  }
  await deps
    .enqueue(
      'campaign-recipient-retry',
      { type: 'campaign-recipient-retry', payload: { recipientId } },
      { delay: Math.max(0, at.getTime() - deps.now()), jobId: campaignRecipientJobId(recipientId, claimAttempt) }
    )
    .catch((e) => log.warn({ err: String(e), recipientId }, 'deferral requeue failed — sweep will recover'))
  return true
}

/**
 * Process one bounded batch. Recipients are claimed ATOMICALLY one at a time
 * (updateMany compare-and-set on status AND attempts), so two workers
 * processing the same batch cannot double-send, and a mid-batch crash leaves
 * at most one row in SENDING — which the stale sweep re-opens.
 */
export async function processCampaignBatch(
  runId: string,
  batchIndex: number,
  deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()
): Promise<{ processed: number; halted: boolean }> {
  const run = await prisma.emailCampaignRun.findUnique({
    where: { id: runId },
    select: { id: true, campaignId: true, status: true, snapshot: true },
  })
  if (!run) return { processed: 0, halted: true }

  // THE KILL SWITCH ALSO STOPS WORK ALREADY IN FLIGHT. Pausing dispatch has to
  // halt the batches of a run that is mid-send, not merely prevent the next
  // campaign from starting — otherwise switching it on during an incident
  // still lets the current send finish reaching customers. Recipients stay
  // PENDING and resume when the pause is lifted; nothing is lost.
  const pause = await isMarketingDispatchPaused()
  if (pause.paused) {
    log.warn({ runId, batchIndex, pausedBy: pause.by }, 'batch halted — marketing dispatch is paused')
    return { processed: 0, halted: true }
  }

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
    select: { id: true, email: true, name: true, customerId: true, leadId: true, bookingId: true, attempts: true, transientAttempts: true },
  })

  let processed = 0
  for (const recipient of rows) {
    // Re-check the run between sends so a pause takes effect mid-batch.
    const current = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true } })
    if (!current || !RUN_SENDABLE_STATES.has(current.status as RunState)) {
      log.info({ runId, batchIndex, processed }, 'batch halted mid-way — run left a sendable state')
      return { processed, halted: true }
    }

    // ATOMIC CLAIM: only one worker can move PENDING → SENDING, and only from
    // the attempts value it read. The claim token is attempts + 1.
    const { count } = await prisma.emailCampaignRecipient.updateMany({
      where: recipientClaimWhere(recipient.id, 'PENDING', recipient.attempts),
      data: { status: 'SENDING', attempts: { increment: 1 } },
    })
    if (count === 0) continue
    const claimAttempt = recipient.attempts + 1

    try {
      await sendToRecipient(run, recipient, claimAttempt, deps)
    } catch (err) {
      // A batch must not die mid-list. Record and continue; the EmailSend row
      // is resumable and the retry job (or sweep step 3b) re-drives it.
      await deferAfterThrow(recipient.id, claimAttempt, err, deps)
      log.warn({ runId, recipientId: recipient.id, err: err instanceof Error ? err.message : String(err) }, 'recipient send threw — deferred for retry')
    }
    processed++
  }

  await finalizeRunIfDone(runId)
  return { processed, halted: false }
}

/** Retry ONE deferred recipient (quiet hours / caps / provider hiccup / transient read failure). */
export async function processRecipientRetry(recipientId: string, deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()): Promise<void> {
  const recipient = await prisma.emailCampaignRecipient.findUnique({
    where: { id: recipientId },
    select: {
      id: true,
      runId: true,
      email: true,
      name: true,
      customerId: true,
      leadId: true,
      bookingId: true,
      attempts: true,
      transientAttempts: true,
      nextAttemptAt: true,
      status: true,
    },
  })
  if (!recipient || recipient.status !== 'DEFERRED') return
  // An early job (or a duplicate) does not claim: the row keeps its due time.
  if (recipient.nextAttemptAt && recipient.nextAttemptAt.getTime() > deps.now() + 60_000) return

  // The kill switch holds retries too. The row stays DEFERRED with its due
  // time, and the sweep re-drives it once the pause is lifted.
  const pause = await isMarketingDispatchPaused()
  if (pause.paused) {
    log.info({ recipientId, pausedBy: pause.by }, 'recipient retry held — marketing dispatch is paused')
    return
  }

  const run = await prisma.emailCampaignRun.findUnique({
    where: { id: recipient.runId },
    select: { id: true, campaignId: true, status: true, snapshot: true },
  })
  if (!run || !RUN_SENDABLE_STATES.has(run.status as RunState)) return

  const { count } = await prisma.emailCampaignRecipient.updateMany({
    where: recipientClaimWhere(recipientId, 'DEFERRED', recipient.attempts),
    data: { status: 'SENDING', attempts: { increment: 1 } },
  })
  if (count === 0) return
  const claimAttempt = recipient.attempts + 1
  try {
    await sendToRecipient(run, recipient, claimAttempt, deps)
  } catch (err) {
    await deferAfterThrow(recipientId, claimAttempt, err, deps)
  }
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

/**
 * Resume: back to QUEUED and re-enqueue every batch that still has PENDING rows.
 * DEFERRED rows whose retry job fired while paused are re-driven by sweep
 * step 3b once they are overdue (QUEUED is sendable).
 */
export async function resumeRun(runId: string, actor: ActorContext, deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()): Promise<ControlResult> {
  const result = await transitionRun(runId, 'QUEUED')
  if (!result.ok) return result
  const pending = await prisma.emailCampaignRecipient.groupBy({
    by: ['batchIndex'],
    where: { runId, status: 'PENDING', batchIndex: { not: null } },
  })
  for (const g of pending) {
    if (g.batchIndex === null) continue
    await deps.enqueue(
      'campaign-batch',
      { type: 'campaign-batch', payload: { runId, batchIndex: g.batchIndex } },
      // Deterministic per resume-generation? No — the ORIGINAL id may still
      // exist as a completed job; suffix with a nonce derived from time bucket
      // so a resume can re-enqueue while a same-second double-click cannot.
      { jobId: `${campaignBatchJobId(runId, g.batchIndex)}__resume__${Math.floor(Date.now() / 10_000)}` }
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
    data: { status: 'CANCELLED', reason: 'run_cancelled', nextAttemptAt: null },
  })
  await audit('EMAIL_CAMPAIGN_RUN_CANCELLED', actor, { runId })
  await finalizeRunIfDone(runId)
  return { ok: true, status: 'CANCELLING' }
}

/**
 * Deliberately re-open FAILED (and stuck-DEFERRED) recipients for another pass.
 *
 * UNKNOWN OUTCOMES ARE REFUSED HERE, SERVER-SIDE (audit E-07). `ambiguous`
 * outcomes map to FAILED, so a blanket re-open would sweep in recipients whose
 * message may ALREADY have been delivered. The guard's terminal-status check
 * would still block the actual duplicate — but that made the API's safety
 * depend on a UI that hides the button, and any script or future automation
 * calling this directly would bypass the operator's protection entirely.
 *
 * Such recipients are reported as `needsReconciliation` and left untouched, to
 * be resolved against the provider dashboard by a human.
 *
 * ONE UNFINISHED RUN (2026-09-15): re-opening a COMPLETED_WITH_ERRORS run puts
 * it back into the unfinished set, so it takes the same per-campaign lock as a
 * dispatch and refuses while another run of the campaign is unfinished. The
 * run is re-opened BEFORE any recipient, so a refusal re-opens nothing.
 */
export async function retryFailedRecipients(
  runId: string,
  actor: ActorContext,
  deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()
): Promise<{ ok: boolean; reopened: number; needsReconciliation: number; error?: string }> {
  const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true, campaignId: true } })
  if (!run) return { ok: false, reopened: 0, needsReconciliation: 0, error: 'That run does not exist.' }
  if (!RUN_SENDABLE_STATES.has(run.status as RunState) && run.status !== 'COMPLETED_WITH_ERRORS') {
    return { ok: false, reopened: 0, needsReconciliation: 0, error: `Recipients of a ${run.status} run cannot be retried.` }
  }

  // Candidates first, so the ambiguous ones can be excluded BY ID rather than
  // re-opened and relied upon to fail later.
  const candidates = await prisma.emailCampaignRecipient.findMany({
    where: { runId, status: { in: Array.from(RECIPIENT_RETRYABLE_STATES) as RecipientState[] } },
    select: { id: true, emailSendId: true },
  })
  const withSend = candidates.filter((r) => r.emailSendId !== null)
  let unknownIds = new Set<string>()
  if (withSend.length > 0) {
    // A send row that is terminal but NOT 'delivered' is an outcome we cannot
    // rule out. 'delivered' means the provider accepted it, so re-opening is
    // pointless but harmless; every other terminal state is ambiguous enough
    // that resending could duplicate.
    const rows = await prisma.emailSend.findMany({
      where: { id: { in: withSend.map((r) => r.emailSendId as string) }, status: { in: UNRESOLVED_SEND_STATUSES } },
      select: { id: true },
    })
    const unresolved = new Set(rows.map((r) => r.id))
    unknownIds = new Set(withSend.filter((r) => unresolved.has(r.emailSendId as string)).map((r) => r.id))
  }

  const retryableIds = candidates.filter((r) => !unknownIds.has(r.id)).map((r) => r.id)
  if (unknownIds.size > 0) {
    log.warn({ runId, held: unknownIds.size }, 'retry withheld for recipients with an unknown provider outcome')
    await prisma.emailCampaignRecipient.updateMany({
      where: { id: { in: Array.from(unknownIds) } },
      data: { reason: 'unknown_provider_outcome_not_retried' },
    })
  }

  // A finished-with-errors run re-opens for the retry pass — under the
  // campaign's run-slot lock, and before any recipient is touched.
  let runReopened = false
  if (run.status === 'COMPLETED_WITH_ERRORS' && retryableIds.length > 0) {
    const busy = { ok: false, reopened: 0, needsReconciliation: unknownIds.size }
    try {
      const reopen = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${runSlotLockKey(run.campaignId)}::text, 0))`
          const other = await tx.emailCampaignRun.findFirst({
            where: { campaignId: run.campaignId, id: { not: runId }, status: { in: [...UNFINISHED_RUN_STATES] } },
            select: { id: true },
          })
          if (other) return { ok: false as const, otherRunId: other.id }
          const r = await tx.emailCampaignRun.updateMany({
            where: { id: runId, status: 'COMPLETED_WITH_ERRORS' },
            data: { status: 'SENDING', completedAt: null },
          })
          return { ok: r.count === 1, otherRunId: null }
        },
        { maxWait: 5_000, timeout: 10_000 }
      )
      if (!reopen.ok) {
        return {
          ...busy,
          error: reopen.otherRunId
            ? `Another run of this campaign (${reopen.otherRunId}) is still in progress. Finish or cancel it before retrying this one.`
            : 'The run changed state concurrently — reload and retry.',
        }
      }
      runReopened = true
    } catch (err) {
      if (isRunSlotConflict(err)) return { ...busy, error: 'Another run of this campaign is still in progress. Finish or cancel it before retrying this one.' }
      if (isTransientTxError(err)) return { ...busy, error: 'The database was busy — retry in a moment.' }
      throw err
    }
  }

  const { count } = retryableIds.length
    ? await prisma.emailCampaignRecipient.updateMany({
        where: { id: { in: retryableIds }, status: { in: Array.from(RECIPIENT_RETRYABLE_STATES) as RecipientState[] } },
        // A deliberate re-open gets a fresh transient-retry budget. `attempts`
        // is NOT reset: it is the claim token and part of the retry job id.
        data: { status: 'PENDING', reason: 'manual_retry', nextAttemptAt: null, transientAttempts: 0 },
      })
    : { count: 0 }
  if (count > 0) {
    const groups = await prisma.emailCampaignRecipient.groupBy({
      by: ['batchIndex'],
      where: { runId, status: 'PENDING', batchIndex: { not: null } },
    })
    for (const g of groups) {
      if (g.batchIndex === null) continue
      await deps.enqueue(
        'campaign-batch',
        { type: 'campaign-batch', payload: { runId, batchIndex: g.batchIndex } },
        { jobId: `${campaignBatchJobId(runId, g.batchIndex)}__retry__${Math.floor(Date.now() / 10_000)}` }
      )
    }
  } else if (runReopened) {
    // Re-opened, but every candidate moved concurrently: let it settle again.
    await finalizeRunIfDone(runId)
  }
  await audit('EMAIL_CAMPAIGN_RETRY_INITIATED', actor, { runId, reopened: count, heldUnknownOutcome: unknownIds.size })
  return { ok: true, reopened: count, needsReconciliation: unknownIds.size }
}

/**
 * EmailSend statuses whose real-world outcome cannot be determined from our own
 * data. A recipient anchored to one of these must never be auto-resent.
 */
const UNRESOLVED_SEND_STATUSES: string[] = ['ambiguous', 'sending', 'failed_terminal']

// ── Finalization + recovery ─────────────────────────────────────────────

/** Recompute counters from recipient rows; close the run when settled. */
export async function finalizeRunIfDone(runId: string): Promise<void> {
  const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true, campaignId: true } })
  if (!run) return
  const state = run.status as RunState
  if (['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(state)) return

  // ── CANCELLING IS SELF-COMPLETING (audit A-1, 2026-07-27) ──────────────
  // A cancel marks the PENDING/DEFERRED rows at the time it runs, but leaves
  // SENDING rows alone — correctly, since one may be mid-provider-call. If that
  // worker then dies, the sweep re-opens the row to PENDING... and a CANCELLING
  // run is not in RUN_SENDABLE_STATES, so no batch will ever pick it up again.
  // The run could never settle and the recipient sat PENDING forever:
  //
  //   cancel -> CANCELLING -> worker dies -> sweep reopens SENDING to PENDING
  //          -> not sendable, never processed -> runIsSettled() false -> stuck
  //
  // A recipient still open on a CANCELLING run has no future, so it is closed
  // here with the same reason the cancel would have given it. Idempotent: once
  // closed there is nothing left to match.
  if (state === 'CANCELLING') {
    const reopened = await prisma.emailCampaignRecipient.updateMany({
      where: { runId, status: { in: ['PENDING', 'DEFERRED'] } },
      data: { status: 'CANCELLED', reason: 'run_cancelled', nextAttemptAt: null },
    })
    if (reopened.count > 0) {
      log.info({ runId, closed: reopened.count }, 'closed recipients re-opened on a cancelling run')
    }
  }

  const grouped = await prisma.emailCampaignRecipient.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } })
  const counts: Partial<Record<RecipientState, number>> = {}
  for (const g of grouped) counts[g.status as RecipientState] = g._count._all

  const sent = counts.SENT ?? 0
  const failed = counts.FAILED ?? 0
  const cancelled = counts.CANCELLED ?? 0
  const skipped =
    (counts.SKIPPED ?? 0) + (counts.SUPPRESSED ?? 0) + (counts.UNSUBSCRIBED ?? 0) + (counts.INELIGIBLE ?? 0) + (counts.CONTEXT_INVALID ?? 0)

  const data: Record<string, unknown> = { sentCount: sent, failedCount: failed, cancelledCount: cancelled, skippedCount: skipped }

  // A DEFERRED recipient (policy or transient backoff) keeps the run open:
  // runIsSettled requires DEFERRED === 0, and the retry job or sweep step 3b
  // will settle it as SENT, a real verdict, or FAILED when retries run out.
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

/** How overdue a DEFERRED row must be before the sweep re-drives it (its own job normally fires first). */
const DEFERRED_SWEEP_GRACE_MS = 5 * 60_000

/** Run statuses that mean a campaign's earlier run got past preparation and was dispatched. */
const DISPATCHED_TERMINAL_RUN_STATES: RunState[] = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']

/**
 * The periodic sweep (cron in the scheduled worker):
 *  1. dispatch campaigns whose scheduledAt has arrived;
 *  2. re-open recipients stuck in SENDING (worker died mid-attempt — the
 *     EmailSend claim below still guarantees no duplicate);
 *  3. re-enqueue batches that still have PENDING rows on sendable runs
 *     (lost queue jobs after a crash/restart);
 *  3b. re-drive overdue DEFERRED rows on sendable runs (lost retry jobs, or
 *     retries held by a pause) — skipped entirely while dispatch is paused;
 *  4. finalize settled runs.
 */
export async function sweepCampaignRuns(
  deps: CampaignDispatchDeps = defaultCampaignDispatchDeps()
): Promise<{ dispatched: number; reopened: number; requeued: number; redriven: number }> {
  let dispatched = 0
  let reopened = 0
  let requeued = 0
  let redriven = 0

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
  let refused = 0
  for (const c of due) {
    try {
      // DEFENCE IN DEPTH (2026-09-15): the scheduler never creates a second
      // run for a campaign whose earlier run was already dispatched. The
      // campaign normally leaves SCHEDULED in the same transaction its run goes
      // live, so this only fires on an anomaly — and an automatic re-send of a
      // whole audience is never the right answer to one. A cancelled run counts
      // too: the owner's cancel must not be undone by the next tick. FAILED
      // runs (preparation died, nothing sent) stay re-dispatchable, and a
      // deliberate manual dispatch is not affected.
      const prior = await prisma.emailCampaignRun.findFirst({
        where: { campaignId: c.id, status: { in: DISPATCHED_TERMINAL_RUN_STATES } },
        select: { id: true, status: true },
        orderBy: { startedAt: 'desc' },
      })
      if (prior) {
        log.warn({ campaignId: c.id, runId: prior.id, status: prior.status }, 'scheduled campaign already has a dispatched run — not re-dispatching')
        await prisma.emailCampaignConfig
          .update({
            where: { campaignId: c.id },
            data: { statusNote: `Scheduled dispatch skipped: run ${prior.id} (${prior.status}) already dispatched this campaign.`.slice(0, 500) },
          })
          .catch((err) => log.warn({ err: String(err), campaignId: c.id }, 'could not persist skip note'))
        continue
      }

      const result = await dispatchCampaign(c.id, SYSTEM_ACTOR, {}, deps)
      if (result.ok && !result.alreadyRunning) dispatched++
      else if (!result.ok && result.conflict) {
        // Another dispatch holds the slot, or the database was busy. Not a
        // refusal of the campaign — the next tick sees the settled state.
        log.info({ campaignId: c.id, error: result.error }, 'scheduled dispatch deferred — run slot busy')
      } else if (!result.ok) {
        refused++
        log.warn({ campaignId: c.id, error: result.error }, 'scheduled dispatch refused')
        // ── THE REFUSAL MUST BE VISIBLE (audit E-09) ──────────────────────
        // Previously this was a log line and nothing else. A campaign the owner
        // believed was scheduled would be refused every 15 minutes FOREVER — 96
        // times a day — while the UI showed a healthy "Scheduled" badge. That is
        // the exact silent-non-delivery trap behind bugs #2 and #8. The reason
        // now lands on the campaign row, where the card already renders it.
        await prisma.emailCampaignConfig
          .update({
            where: { campaignId: c.id },
            data: {
              statusNote: `Scheduled dispatch was refused at ${new Date().toISOString()}: ${result.error}`.slice(0, 500),
            },
          })
          .catch((err) => log.warn({ err: String(err), campaignId: c.id }, 'could not persist refusal note'))
      }
    } catch (err) {
      // One campaign's failure must not abort the whole tick — steps 1b-4
      // recover every other run.
      log.error({ campaignId: c.id, err: String(err) }, 'scheduled dispatch threw — continuing the sweep')
    }
  }
  if (refused > 0) log.warn({ refused }, 'scheduled campaigns refused dispatch — reasons written to statusNote')

  // 1b. ABANDONED PREPARATION (audit A-5, 2026-07-27).
  //
  // dispatchCampaign creates the run as PREPARING, then resolves the audience
  // and writes recipient rows. A thrown error moves it to FAILED — but a KILLED
  // process (deploy, OOM, SIGKILL) cannot run that catch, so the run stays
  // PREPARING forever. PREPARING is in UNFINISHED_RUN_STATES, so every later
  // dispatch returns `alreadyRunning` for a run that will never progress:
  // THE CAMPAIGN BECOMES PERMANENTLY UNDISPATCHABLE, with no operator remedy.
  //
  // Preparation is seconds of work. A PREPARING run older than the stale
  // threshold did not survive, so it is failed honestly — which unblocks
  // dispatch, because FAILED is not an unfinished state. A preparation that
  // was merely slow finds its run no longer PREPARING and aborts cleanly.
  const abandoned = await prisma.emailCampaignRun.updateMany({
    where: { status: 'PREPARING', startedAt: { lt: new Date(Date.now() - RECIPIENT_STALE_MS) } },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      error: 'Preparation never completed — the process was interrupted before the recipient list was finished. No email was sent; dispatch again.',
    },
  })
  if (abandoned.count > 0) {
    log.warn({ runs: abandoned.count }, 'failed abandoned PREPARING runs — campaigns unblocked for re-dispatch')
  }

  // Checked ONCE: while the global switch is on, a re-drive job would only
  // return early, so none are added.
  const pause = await isMarketingDispatchPaused()

  // 2 + 3 + 3b + 4 for unfinished runs. Oldest-touched first, so the bound
  // cannot starve the same runs every tick.
  const active = await prisma.emailCampaignRun.findMany({
    where: { status: { in: ['QUEUED', 'SENDING', 'CANCELLING'] } },
    select: { id: true, status: true },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  })
  for (const run of active) {
    const stale = await prisma.emailCampaignRecipient.updateMany({
      where: { runId: run.id, status: 'SENDING', updatedAt: { lt: new Date(Date.now() - RECIPIENT_STALE_MS) } },
      data: { status: 'PENDING', reason: 'stale_claim_reopened', nextAttemptAt: null },
    })
    reopened += stale.count

    if (RUN_SENDABLE_STATES.has(run.status as RunState)) {
      const groups = await prisma.emailCampaignRecipient.groupBy({
        by: ['batchIndex'],
        where: { runId: run.id, status: 'PENDING', batchIndex: { not: null }, updatedAt: { lt: new Date(Date.now() - RECIPIENT_STALE_MS) } },
      })
      for (const g of groups) {
        if (g.batchIndex === null) continue
        await deps.enqueue(
          'campaign-batch',
          { type: 'campaign-batch', payload: { runId: run.id, batchIndex: g.batchIndex } },
          { jobId: `${campaignBatchJobId(run.id, g.batchIndex)}__sweep__${Math.floor(Date.now() / 60_000)}` }
        )
        requeued++
      }

      // 3b. OVERDUE DEFERRALS. Only rows with a durable due time written by
      // this code; legacy DEFERRED rows with a NULL next_attempt_at are
      // deliberately left alone. The time-bucketed suffix keeps a retained
      // completed job from swallowing the add; the DEFERRED → SENDING CAS makes
      // a duplicate job harmless.
      if (!pause.paused) {
        const overdue = await prisma.emailCampaignRecipient.findMany({
          where: { runId: run.id, status: 'DEFERRED', nextAttemptAt: { not: null, lte: new Date(deps.now() - DEFERRED_SWEEP_GRACE_MS) } },
          select: { id: true, attempts: true },
          orderBy: { nextAttemptAt: 'asc' },
          take: 200,
        })
        for (const r of overdue) {
          await deps
            .enqueue(
              'campaign-recipient-retry',
              { type: 'campaign-recipient-retry', payload: { recipientId: r.id } },
              { jobId: `${campaignRecipientJobId(r.id, r.attempts)}__sweep__${Math.floor(deps.now() / 60_000)}` }
            )
            .then(() => redriven++)
            .catch((err) => log.warn({ err: String(err), recipientId: r.id }, 'deferred re-drive enqueue failed — next sweep retries'))
        }
      }
    }
    await finalizeRunIfDone(run.id)
  }

  if (dispatched || reopened || requeued || redriven) log.info({ dispatched, reopened, requeued, redriven }, 'campaign sweep did work')
  return { dispatched, reopened, requeued, redriven }
}
