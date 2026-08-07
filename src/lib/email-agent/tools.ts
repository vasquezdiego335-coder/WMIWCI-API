// ════════════════════════════════════════════════════════════════════════
//  SAFE TOOLS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  THE ONLY DOOR. Nothing the agent does to the email system happens anywhere
//  except through `executeTool()`. There is no second path, no direct Prisma
//  call from the investigator, and no way for a model to reach the database.
//
//  EVERY EXECUTION PASSES SEVEN GATES, IN THIS ORDER, AND THE ORDER MATTERS:
//
//    1. SCHEMA      — arguments parsed by Zod. An unknown tool name never
//                     survives this step, because there is no schema for it.
//    2. POLICY      — classify(tool, mode). Forbidden stops here, always.
//    3. APPROVAL    — an approval-required tool must present a live, matching,
//                     unexpired approval whose checksum still describes the
//                     resource. Otherwise it becomes an approval REQUEST.
//    4. KILL SWITCH — the agent's own switches, then the global dispatch pause.
//    5. BUDGET      — the per-cycle action cap.
//    6. IDEMPOTENCY — a unique key per (tool, subject, window). A repeat is
//                     recorded as skipped, not executed twice.
//    7. STATE       — the executor re-reads the row and refuses if the world
//                     has moved since the finding was produced.
//
//  AND ONE RULE ABOUT HONESTY: the action row is written BEFORE the work and
//  closed AFTER it, inside the same logical operation. A crash leaves a row
//  that says "started" and never says "succeeded". Nothing is reported
//  successful until its transaction has committed. `beforeState` and
//  `afterState` are captured from the database, not from the arguments, so the
//  audit record is evidence rather than intent.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../db'
import { queueLogger } from '../logger'
import { finalizeRunIfDone } from '../email-campaign-dispatch'
import { retryPendingSideEffects } from '../email-events'
import { addIncidentEvent } from './incidents'
import { actionFingerprint, evaluateBlastRadius, isMutatingTool, readBlastRadiusCounts } from './blast-radius'
import { detectEnvironment, detectService } from './environment'
import { classify } from './policy'
import { redact, safeErrorMessage } from './redact'
import { isMarketingDispatchPaused, type AgentSettings } from './settings'
import { RECIPIENT_CLAIM_STALE_MS } from './checks/shared'
import { isAgentToolName, type AgentToolName, type PolicyClassification } from './types'

const log = queueLogger.child({ mod: 'email-agent-tools' })

/** How long an approval stays usable before it must be asked again. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
/** Window in which the same tool against the same subject is a no-op. */
export const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000

// ── Argument schemas ────────────────────────────────────────────────────
// One per tool. A tool with no schema cannot be called, which is why the
// forbidden tools deliberately have none.

const id = z.string().min(1).max(64)

const TOOL_SCHEMAS: Partial<Record<AgentToolName, z.ZodTypeAny>> = {
  inspectCampaign: z.object({ campaignId: id }).strict(),
  inspectCampaignRun: z.object({ runId: id }).strict(),
  inspectEmailSend: z.object({ sendId: id }).strict(),
  inspectWebhookEvent: z.object({ eventId: id }).strict(),

  reconcileRunCounters: z.object({ runId: id }).strict(),
  finalizeSettledRun: z.object({ runId: id }).strict(),
  releaseExpiredLock: z.object({ runId: id }).strict(),
  reprocessValidWebhookEvent: z.object({ eventId: id.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  retryTransientSendOnce: z.object({ sendId: id }).strict(),

  pauseCampaign: z.object({ campaignId: id, reason: z.string().min(1).max(500) }).strict(),
  pauseMarketingDispatch: z.object({ reason: z.string().min(1).max(500) }).strict(),

  createIncident: z.object({ title: z.string().min(1).max(200), summary: z.string().min(1).max(2000), severity: z.enum(['info', 'warning', 'critical']), category: z.string().min(1).max(40) }).strict(),
  updateIncident: z.object({ incidentId: id, probableCause: z.string().max(2000).optional(), technicalSummary: z.string().max(4000).optional(), confidence: z.number().min(0).max(1).optional() }).strict(),
  resolveIncident: z.object({ incidentId: id, resolution: z.string().min(1).max(2000) }).strict(),
  sendDiscordIncidentAlert: z.object({ incidentId: id }).strict(),
  recordLesson: z.object({ patternKey: z.string().min(1).max(120), title: z.string().min(1).max(200), probableCause: z.string().min(1).max(1000), symptoms: z.array(z.string().max(200)).max(12).optional(), successfulResolution: z.string().max(1000).optional() }).strict(),
  createApprovalRequest: z
    .object({
      toolName: z.string().min(1).max(60),
      arguments: z.record(z.unknown()).default({}),
      question: z.string().min(1).max(600),
      reason: z.string().min(1).max(1000),
      expectedEffect: z.string().min(1).max(1000),
      risk: z.string().min(1).max(1000),
      incidentId: id.optional(),
    })
    .strict(),

  // Approval-gated tools: schemas exist because a HUMAN can authorise them.
  resumeMarketingDispatch: z.object({ reason: z.string().min(1).max(500) }).strict(),
  resumeCampaign: z.object({ campaignId: id }).strict(),
  rescheduleCampaign: z.object({ campaignId: id, scheduledAt: z.string().datetime() }).strict(),
  dispatchCampaignNow: z.object({ campaignId: id }).strict(),
  retryFailedRecipients: z.object({ runId: id }).strict(),

  // removeSuppression / raiseStageRecipientLimit / enableSafeAutoMode have NO
  // schema and NO executor. They exist in the enum only so the agent can name
  // them when explaining what it is not allowed to do.
}

// ── Result types ────────────────────────────────────────────────────────

export type ToolContext = {
  settings: AgentSettings
  correlationId: string
  runId?: string
  incidentId?: string
  actor: string
  actorName?: string
  aiProvider?: string
  aiModel?: string
  /** How many automatic actions this cycle has already spent. */
  actionsUsed: number
  now: Date
  /** A specific approval the caller is presenting for this execution. */
  approvalId?: string
  /** The incident evidence that justified this action, for duplicate detection. */
  evidenceHash?: string | null
}

export type ToolResult = {
  ok: boolean
  status: 'succeeded' | 'failed' | 'refused' | 'skipped_idempotent'
  classification: PolicyClassification
  message: string
  actionId?: string
  approvalId?: string
  data?: Record<string, unknown>
}

/** Identity of a tool call against a subject, for the idempotency guard. */
function idempotencyKey(tool: string, args: Record<string, unknown>, now: Date): string {
  const subject = [args.campaignId, args.runId, args.sendId, args.eventId, args.incidentId, args.patternKey]
    .filter((v) => typeof v === 'string')
    .join('|')
  const bucket = Math.floor(now.getTime() / IDEMPOTENCY_WINDOW_MS)
  return crypto.createHash('sha1').update(`${tool}::${subject}::${bucket}`).digest('hex')
}

/** Hash of the state a human reviewed. Recomputed at execution to detect drift. */
export async function resourceChecksum(args: Record<string, unknown>): Promise<string> {
  const parts: string[] = []
  if (typeof args.campaignId === 'string') {
    const c = await prisma.marketingCampaign.findUnique({
      where: { id: args.campaignId },
      select: { status: true, name: true, emailConfig: { select: { template: true, subject: true, audienceId: true, scheduledAt: true, approvedAt: true, approvedConfigHash: true } } },
    })
    parts.push(JSON.stringify(c ?? 'missing'))
  }
  if (typeof args.runId === 'string') {
    const r = await prisma.emailCampaignRun.findUnique({ where: { id: args.runId }, select: { status: true, totalRecipients: true, sentCount: true, completedAt: true } })
    parts.push(JSON.stringify(r ?? 'missing'))
  }
  if (typeof args.sendId === 'string') {
    const s = await prisma.emailSend.findUnique({ where: { id: args.sendId }, select: { status: true, attempts: true, providerId: true, deliveredAt: true } })
    parts.push(JSON.stringify(s ?? 'missing'))
  }
  if (parts.length === 0) parts.push(JSON.stringify(args))
  return crypto.createHash('sha256').update(parts.join('||')).digest('hex').slice(0, 32)
}

// ── Executors ───────────────────────────────────────────────────────────
// Each returns { before, after, message, data }. They are pure orchestration
// over the existing services — none of them reimplements business logic.

type Executor = (args: Record<string, never>, ctx: ToolContext) => Promise<{
  before: unknown
  after: unknown
  message: string
  data?: Record<string, unknown>
  /** Set when the executor declined for a state reason (not an error). */
  refused?: string
}>

const EXECUTORS: Partial<Record<AgentToolName, Executor>> = {
  // ── Inspection ────────────────────────────────────────────────────────
  inspectCampaign: async (args) => {
    const campaign = await prisma.marketingCampaign.findUnique({
      where: { id: args.campaignId as string },
      include: { emailConfig: { include: { audience: true } }, emailRuns: { orderBy: { startedAt: 'desc' }, take: 3 } },
    })
    if (!campaign) return { before: null, after: null, message: 'That campaign does not exist.', refused: 'not_found' }
    return {
      before: null,
      after: null,
      message: `Campaign "${campaign.name}" is ${campaign.status}.`,
      data: redact({
        id: campaign.id, name: campaign.name, status: campaign.status,
        template: campaign.emailConfig?.template, scheduledAt: campaign.emailConfig?.scheduledAt,
        approvedAt: campaign.emailConfig?.approvedAt, statusNote: campaign.emailConfig?.statusNote,
        audience: campaign.emailConfig?.audience?.name ?? null,
        runs: campaign.emailRuns.map((r) => ({ id: r.id, status: r.status, totalRecipients: r.totalRecipients, sentCount: r.sentCount, startedAt: r.startedAt })),
      }) as Record<string, unknown>,
    }
  },

  inspectCampaignRun: async (args) => {
    const run = await prisma.emailCampaignRun.findUnique({ where: { id: args.runId as string } })
    if (!run) return { before: null, after: null, message: 'That run does not exist.', refused: 'not_found' }
    const grouped = await prisma.emailCampaignRecipient.groupBy({ by: ['status'], where: { runId: run.id }, _count: { _all: true } })
    return {
      before: null,
      after: null,
      message: `Run ${run.id} is ${run.status}.`,
      data: redact({
        id: run.id, campaignId: run.campaignId, status: run.status,
        totalRecipients: run.totalRecipients, sentCount: run.sentCount, skippedCount: run.skippedCount,
        failedCount: run.failedCount, cancelledCount: run.cancelledCount,
        startedAt: run.startedAt, completedAt: run.completedAt, error: run.error,
        recipientStates: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      }) as Record<string, unknown>,
    }
  },

  inspectEmailSend: async (args) => {
    const send = await prisma.emailSend.findUnique({
      where: { id: args.sendId as string },
      include: { events: { orderBy: { occurredAt: 'desc' }, take: 10 } },
    })
    if (!send) return { before: null, after: null, message: 'That send does not exist.', refused: 'not_found' }
    return {
      before: null,
      after: null,
      message: `Send ${send.id} is ${send.status}.`,
      data: redact({
        id: send.id, email: send.email, template: send.template, status: send.status,
        attempts: send.attempts, providerId: send.providerId ? 'present' : null,
        sentAt: send.sentAt, deliveredAt: send.deliveredAt, bouncedAt: send.bouncedAt, complainedAt: send.complainedAt,
        blockedReason: send.blockedReason, error: send.error,
        events: send.events.map((e) => ({ type: e.type, occurredAt: e.occurredAt, processingStatus: e.processingStatus })),
      }) as Record<string, unknown>,
    }
  },

  inspectWebhookEvent: async (args) => {
    const event = await prisma.emailEvent.findUnique({ where: { id: args.eventId as string } })
    if (!event) return { before: null, after: null, message: 'That event does not exist.', refused: 'not_found' }
    return {
      before: null,
      after: null,
      message: `Event ${event.id} (${event.type}) is ${event.processingStatus}.`,
      data: redact({
        id: event.id, type: event.type, email: event.email, processingStatus: event.processingStatus,
        sideEffectAttempts: event.sideEffectAttempts, sideEffectError: event.sideEffectError,
        occurredAt: event.occurredAt, emailSendId: event.emailSendId,
      }) as Record<string, unknown>,
    }
  },

  // ── Repairs ───────────────────────────────────────────────────────────

  /**
   * Recompute counters from recipient rows.
   *
   * Uses exactly the semantics the dispatcher uses: `totalRecipients` is
   * FROZEN at dispatch and is never rewritten here — only the derived counters
   * are corrected, because those are the ones the finaliser owns.
   */
  reconcileRunCounters: async (args) => {
    const runId = args.runId as string
    const run = await prisma.emailCampaignRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, sentCount: true, skippedCount: true, failedCount: true, cancelledCount: true, totalRecipients: true },
    })
    if (!run) return { before: null, after: null, message: 'That run does not exist.', refused: 'not_found' }

    const grouped = await prisma.emailCampaignRecipient.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } })
    const counts: Record<string, number> = {}
    for (const g of grouped) counts[g.status] = g._count._all

    const sentCount = counts.SENT ?? 0
    const failedCount = counts.FAILED ?? 0
    const cancelledCount = counts.CANCELLED ?? 0
    const skippedCount =
      (counts.SKIPPED ?? 0) + (counts.SUPPRESSED ?? 0) + (counts.UNSUBSCRIBED ?? 0) + (counts.INELIGIBLE ?? 0) + (counts.CONTEXT_INVALID ?? 0)

    const before = { sentCount: run.sentCount, skippedCount: run.skippedCount, failedCount: run.failedCount, cancelledCount: run.cancelledCount }
    const after = { sentCount, skippedCount, failedCount, cancelledCount }

    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { before, after, message: 'The counters already match the recipient rows. Nothing changed.', refused: 'already_correct' }
    }

    await prisma.emailCampaignRun.update({ where: { id: runId }, data: after })
    return {
      before,
      after,
      message: `Recomputed counters for run ${runId} from ${Object.values(counts).reduce((a, b) => a + b, 0)} recipient rows. totalRecipients was not touched — it records what was claimed at dispatch.`,
      data: { recipientStates: counts, totalRecipientsUnchanged: run.totalRecipients },
    }
  },

  /**
   * Close a run whose recipients have all settled.
   *
   * Delegates to the production finaliser rather than writing the transition
   * itself, so the run and campaign state machines stay the only authority on
   * what "finished" means.
   */
  finalizeSettledRun: async (args) => {
    const runId = args.runId as string
    const before = await prisma.emailCampaignRun.findUnique({
      where: { id: runId },
      select: { status: true, completedAt: true, sentCount: true, failedCount: true },
    })
    if (!before) return { before: null, after: null, message: 'That run does not exist.', refused: 'not_found' }

    const open = await prisma.emailCampaignRecipient.count({ where: { runId, status: { in: ['PENDING', 'SENDING', 'DEFERRED'] } } })
    if (open > 0) {
      return {
        before,
        after: before,
        message: `${open} recipient${open === 1 ? ' is' : 's are'} still open on this run, so it is not settled. Refusing to close a run that still has work in it.`,
        refused: 'not_settled',
      }
    }

    await finalizeRunIfDone(runId)
    const after = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true, completedAt: true, sentCount: true, failedCount: true } })
    if (before.status === after?.status && before.completedAt?.getTime() === after?.completedAt?.getTime()) {
      return { before, after, message: 'The run was already settled. Nothing changed.', refused: 'already_settled' }
    }
    return { before, after, message: `Run ${runId} finalised: ${before.status} → ${after?.status}.` }
  },

  /**
   * Return demonstrably-abandoned claims to PENDING.
   *
   * Safe because the EmailSend idempotency key is the real duplicate guard: a
   * re-opened recipient whose message DID go out finds the existing send row
   * and refuses to send again.
   */
  releaseExpiredLock: async (args, ctx) => {
    const runId = args.runId as string
    const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { status: true } })
    if (!run) return { before: null, after: null, message: 'That run does not exist.', refused: 'not_found' }

    const cutoff = new Date(ctx.now.getTime() - RECIPIENT_CLAIM_STALE_MS)
    const stale = await prisma.emailCampaignRecipient.findMany({
      where: { runId, status: 'SENDING', updatedAt: { lt: cutoff } },
      select: { id: true, emailSendId: true },
      take: 500,
    })
    if (stale.length === 0) {
      return { before: { staleClaims: 0 }, after: { staleClaims: 0 }, message: 'No claim on this run is past its expiry. Nothing to release.', refused: 'nothing_stale' }
    }

    // A row whose provider outcome is UNKNOWN is never re-opened: re-sending a
    // message that did arrive is worse than leaving one that did not.
    const sendIds = stale.map((s) => s.emailSendId).filter((v): v is string => !!v)
    const unresolved = sendIds.length
      ? await prisma.emailSend.findMany({ where: { id: { in: sendIds }, status: { in: ['ambiguous', 'sending'] } }, select: { id: true } })
      : []
    const unresolvedSet = new Set(unresolved.map((u) => u.id))
    const safe = stale.filter((s) => !s.emailSendId || !unresolvedSet.has(s.emailSendId))

    if (safe.length === 0) {
      return {
        before: { staleClaims: stale.length, safeToRelease: 0 },
        after: { staleClaims: stale.length, safeToRelease: 0 },
        message: `All ${stale.length} expired claims have an unresolved provider outcome, so none can be safely re-opened. A person must reconcile them.`,
        refused: 'all_unresolved',
      }
    }

    const result = await prisma.emailCampaignRecipient.updateMany({
      where: { id: { in: safe.map((s) => s.id) }, status: 'SENDING' },
      data: { status: 'PENDING', reason: 'agent_released_expired_claim' },
    })
    return {
      before: { runStatus: run.status, staleClaims: stale.length, heldBack: stale.length - safe.length },
      after: { released: result.count },
      message: `Released ${result.count} expired claim${result.count === 1 ? '' : 's'} on run ${runId}${stale.length - safe.length > 0 ? `; ${stale.length - safe.length} held back because the provider outcome is unknown` : ''}.`,
    }
  },

  /**
   * Re-drive suppression side effects for events that failed internally.
   *
   * This can only ever ADD a suppression. There is no code path from here to
   * removing one, which is why it is safe to run automatically.
   */
  reprocessValidWebhookEvent: async (args) => {
    const limit = (args.limit as number | undefined) ?? 25
    const before = await prisma.emailEvent.groupBy({
      by: ['processingStatus'],
      where: { processingStatus: { in: ['side_effect_pending', 'side_effect_failed'] } },
      _count: { _all: true },
    })
    const beforeCount = before.reduce((sum, g) => sum + g._count._all, 0)
    if (beforeCount === 0) {
      return { before: { unsettled: 0 }, after: { unsettled: 0 }, message: 'No webhook event is waiting on a suppression. Nothing to reprocess.', refused: 'nothing_pending' }
    }
    const result = await retryPendingSideEffects(limit)
    const afterRows = await prisma.emailEvent.groupBy({
      by: ['processingStatus'],
      where: { processingStatus: { in: ['side_effect_pending', 'side_effect_failed'] } },
      _count: { _all: true },
    })
    const afterCount = afterRows.reduce((sum, g) => sum + g._count._all, 0)
    return {
      before: { unsettled: beforeCount },
      after: { unsettled: afterCount },
      message: `Reprocessed webhook side effects: ${beforeCount} unsettled → ${afterCount}.`,
      data: redact(result as unknown) as Record<string, unknown>,
    }
  },

  /**
   * Exactly ONE more attempt, and only for a transient failure.
   *
   * The three refusals below are the whole safety of this tool: an ambiguous
   * outcome is never retried, a delivered send is never retried, and a send
   * that has already used its attempts is never given more.
   */
  retryTransientSendOnce: async (args) => {
    const sendId = args.sendId as string
    const send = await prisma.emailSend.findUnique({
      where: { id: sendId },
      select: { id: true, status: true, attempts: true, blockedReason: true, nextAttemptAt: true, providerId: true, deliveredAt: true, idempotencyKey: true },
    })
    if (!send) return { before: null, after: null, message: 'That send does not exist.', refused: 'not_found' }

    const before = { status: send.status, attempts: send.attempts, nextAttemptAt: send.nextAttemptAt }

    if (send.status === 'delivered' || send.deliveredAt) {
      return { before, after: before, message: 'That message was already accepted by the provider. It is never re-sent.', refused: 'already_delivered' }
    }
    if (send.status === 'ambiguous') {
      return { before, after: before, message: 'That send has an unknown outcome. Retrying could deliver a second copy to a real customer, so it is refused.', refused: 'ambiguous' }
    }
    if (!['retry_pending', 'blocked_retryable', 'provider_rejected'].includes(send.status)) {
      return { before, after: before, message: `A send in status "${send.status}" is not a transient failure. Refusing.`, refused: 'not_transient' }
    }
    // The agent gets ONE attempt, not the full retry budget. Anything already
    // past its first retry is a human's decision.
    if (send.attempts > 1) {
      return { before, after: before, message: `That send has already been attempted ${send.attempts} times. The agent retries once and no more.`, refused: 'attempts_exhausted' }
    }

    await prisma.emailSend.update({
      where: { id: sendId },
      data: { status: 'retry_pending', outcomeClass: 'retryable', nextAttemptAt: new Date(), error: null },
    })
    const after = await prisma.emailSend.findUnique({ where: { id: sendId }, select: { status: true, attempts: true, nextAttemptAt: true } })
    return { before, after, message: `Send ${sendId} re-opened for exactly one more attempt (was ${before.status}).` }
  },

  // ── Protective stops ──────────────────────────────────────────────────

  pauseCampaign: async (args, ctx) => {
    const campaignId = args.campaignId as string
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true, status: true } })
    if (!campaign) return { before: null, after: null, message: 'That campaign does not exist.', refused: 'not_found' }
    if (['PAUSED', 'COMPLETED', 'CANCELLED', 'ARCHIVED'].includes(campaign.status)) {
      return { before: { status: campaign.status }, after: { status: campaign.status }, message: `"${campaign.name}" is already ${campaign.status}. Nothing to pause.`, refused: 'already_stopped' }
    }
    const before = { status: campaign.status }
    await prisma.$transaction([
      prisma.marketingCampaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } }),
      prisma.emailCampaignConfig.updateMany({
        where: { campaignId },
        data: { statusNote: `Paused by the operations agent at ${ctx.now.toISOString()}: ${String(args.reason).slice(0, 300)}`.slice(0, 500) },
      }),
    ])
    return { before, after: { status: 'PAUSED' }, message: `Paused "${campaign.name}" (was ${before.status}). Reason: ${String(args.reason).slice(0, 200)}` }
  },

  pauseMarketingDispatch: async (args, ctx) => {
    const current = await isMarketingDispatchPaused()
    if (current.paused) {
      return { before: { paused: true }, after: { paused: true }, message: 'Marketing dispatch is already paused. Nothing changed.', refused: 'already_paused' }
    }
    await prisma.emailAgentSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        marketingDispatchPaused: true,
        pausedReason: String(args.reason).slice(0, 500),
        pausedAt: ctx.now,
        pausedBy: ctx.actorName ?? 'operations agent',
      },
      update: {
        marketingDispatchPaused: true,
        pausedReason: String(args.reason).slice(0, 500),
        pausedAt: ctx.now,
        pausedBy: ctx.actorName ?? 'operations agent',
      },
    })
    return {
      before: { paused: false },
      after: { paused: true, reason: String(args.reason).slice(0, 200) },
      message: `PAUSED ALL MARKETING DISPATCH. Reason: ${String(args.reason).slice(0, 300)} No campaign will send until a person resumes it.`,
    }
  },

  // ── Agent-internal bookkeeping ────────────────────────────────────────

  updateIncident: async (args) => {
    const incidentId = args.incidentId as string
    const before = await prisma.emailAgentIncident.findUnique({
      where: { id: incidentId },
      select: { probableCause: true, technicalSummary: true, confidence: true, status: true },
    })
    if (!before) return { before: null, after: null, message: 'That incident does not exist.', refused: 'not_found' }
    const data: Record<string, unknown> = {}
    if (args.probableCause !== undefined) data.probableCause = String(args.probableCause).slice(0, 2000)
    if (args.technicalSummary !== undefined) data.technicalSummary = String(args.technicalSummary).slice(0, 4000)
    if (args.confidence !== undefined) data.confidence = Number(args.confidence)
    if (Object.keys(data).length === 0) return { before, after: before, message: 'Nothing to update.', refused: 'no_changes' }
    if (before.status === 'open') data.status = 'investigating'
    await prisma.emailAgentIncident.update({ where: { id: incidentId }, data: data as never })
    const after = await prisma.emailAgentIncident.findUnique({ where: { id: incidentId }, select: { probableCause: true, technicalSummary: true, confidence: true, status: true } })
    return { before, after, message: `Updated incident ${incidentId}.` }
  },

  resolveIncident: async (args) => {
    const incidentId = args.incidentId as string
    const before = await prisma.emailAgentIncident.findUnique({ where: { id: incidentId }, select: { status: true, reference: true } })
    if (!before) return { before: null, after: null, message: 'That incident does not exist.', refused: 'not_found' }
    if (before.status === 'resolved') return { before, after: before, message: 'That incident is already resolved.', refused: 'already_resolved' }
    await prisma.emailAgentIncident.update({
      where: { id: incidentId },
      data: { status: 'resolved', resolvedAt: new Date(), resolution: String(args.resolution).slice(0, 2000), resolutionKind: 'agent_resolved' },
    })
    return { before, after: { status: 'resolved' }, message: `Resolved ${before.reference}.` }
  },

  recordLesson: async (args) => {
    const { recordLesson: store } = await import('./memory')
    const result = await store({
      patternKey: String(args.patternKey),
      title: String(args.title),
      probableCause: String(args.probableCause),
      symptoms: Array.isArray(args.symptoms) ? (args.symptoms as string[]) : undefined,
      successfulResolution: args.successfulResolution ? String(args.successfulResolution) : null,
    })
    return {
      before: null,
      after: { patternKey: result.patternKey, confidence: result.confidence },
      message: `${result.created ? 'Recorded a new' : 'Reinforced the'} lesson "${result.patternKey}" (confidence ${result.confidence.toFixed(2)}).`,
    }
  },
}

// ── The gate ────────────────────────────────────────────────────────────

/**
 * Execute one tool, or refuse and say exactly why.
 *
 * NEVER THROWS. Every failure returns a ToolResult, because a thrown error
 * inside a corrective action is the one situation where the audit row would be
 * left open and the operator would learn nothing.
 */
export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  // ── GATE 1: the name and the arguments ────────────────────────────────
  if (!isAgentToolName(toolName)) {
    return {
      ok: false,
      status: 'refused',
      classification: 'forbidden',
      message: `"${String(toolName).slice(0, 60)}" is not a tool. Refused without interpretation.`,
    }
  }

  // ── GATE 2: policy has final authority ────────────────────────────────
  const decision = classify(toolName, ctx.settings.mode)
  if (decision.classification === 'forbidden') {
    await recordRefusal(toolName, rawArgs, ctx, decision.classification, decision.reason)
    return { ok: false, status: 'refused', classification: 'forbidden', message: decision.reason }
  }

  const schema = TOOL_SCHEMAS[toolName]
  if (!schema) {
    const reason = `"${toolName}" has no argument schema, so it cannot be called. This is deliberate for tools the agent must never execute.`
    await recordRefusal(toolName, rawArgs, ctx, 'forbidden', reason)
    return { ok: false, status: 'refused', classification: 'forbidden', message: reason }
  }

  const parsed = schema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const reason = `The arguments for ${toolName} are not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`
    await recordRefusal(toolName, rawArgs, ctx, decision.classification, reason)
    return { ok: false, status: 'refused', classification: decision.classification, message: reason }
  }
  const args = parsed.data as Record<string, never>

  // ── GATE 3: approval ──────────────────────────────────────────────────
  if (decision.classification === 'approval_required') {
    const approval = ctx.approvalId
      ? await prisma.emailAgentApproval.findUnique({ where: { id: ctx.approvalId } })
      : null

    if (!approval) {
      // No approval presented → this becomes a REQUEST, not an execution.
      const created = await createApprovalRequest(toolName, args as Record<string, unknown>, ctx, decision.reason)
      return {
        ok: false,
        status: 'refused',
        classification: 'approval_required',
        message: `${decision.reason} An approval request (${created.reference}) has been created for the owner.`,
        approvalId: created.id,
      }
    }
    const verdict = await validateApproval(approval, toolName, args as Record<string, unknown>, ctx.now)
    if (!verdict.ok) {
      await recordRefusal(toolName, args, ctx, 'approval_required', verdict.reason)
      return { ok: false, status: 'refused', classification: 'approval_required', message: verdict.reason, approvalId: approval.id }
    }
  }

  // ── GATE 4: kill switches ─────────────────────────────────────────────
  const mutating = !['inspectCampaign', 'inspectCampaignRun', 'inspectEmailSend', 'inspectWebhookEvent'].includes(toolName)
  if (mutating && !ctx.settings.autoActionsEnabled && ctx.actor === 'agent') {
    const reason = 'Automatic corrective actions are switched off. The agent is reporting only.'
    await recordRefusal(toolName, args, ctx, decision.classification, reason)
    return { ok: false, status: 'refused', classification: decision.classification, message: reason }
  }

  // ── GATE 5: the per-cycle budget ──────────────────────────────────────
  const consumesBudget = mutating && !['createIncident', 'updateIncident', 'resolveIncident', 'recordLesson', 'sendDiscordIncidentAlert', 'createApprovalRequest'].includes(toolName)
  if (consumesBudget && ctx.actor === 'agent' && ctx.actionsUsed >= ctx.settings.maxAutoActionsPerRun) {
    const reason = `This cycle has already used its ${ctx.settings.maxAutoActionsPerRun} automatic actions. Further repairs wait for the next cycle so a bug cannot cascade.`
    await recordRefusal(toolName, args, ctx, decision.classification, reason)
    return { ok: false, status: 'refused', classification: decision.classification, message: reason }
  }

  // ── GATE 6: idempotency ───────────────────────────────────────────────
  const key = consumesBudget ? idempotencyKey(toolName, args as Record<string, unknown>, ctx.now) : null
  if (key) {
    const prior = await prisma.emailAgentAction.findUnique({ where: { idempotencyKey: key }, select: { id: true, status: true } })
    if (prior) {
      return {
        ok: true,
        status: 'skipped_idempotent',
        classification: decision.classification,
        message: `${toolName} was already run against this subject within the last hour (${prior.status}). Skipped rather than repeated.`,
        actionId: prior.id,
      }
    }
  }

  // ── GATE 6b: BLAST RADIUS ─────────────────────────────────────────────
  // Caps how much the agent can change in a day, per tool, per incident and
  // per resource, and refuses an action identical to one already taken for the
  // same evidence. These apply to the AGENT only: a human who approved
  // something is not rate-limited by the machine's caution.
  const argsRecord = args as Record<string, unknown>
  const resourceId =
    (argsRecord.campaignId as string | undefined) ??
    (argsRecord.runId as string | undefined) ??
    (argsRecord.sendId as string | undefined) ??
    null
  const argumentsHash = actionFingerprint(toolName, argsRecord, ctx.evidenceHash ?? null)

  if (ctx.actor === 'agent' && isMutatingTool(toolName)) {
    const counts = await readBlastRadiusCounts({
      tool: toolName,
      incidentId: ctx.incidentId,
      argumentsHash,
      resourceId,
      now: ctx.now,
      settings: ctx.settings,
    })
    const radius = evaluateBlastRadius(counts, ctx.settings, { tool: toolName, now: ctx.now })
    if (!radius.allowed) {
      await recordRefusal(toolName, args, ctx, decision.classification, radius.reason)
      return { ok: false, status: 'refused', classification: decision.classification, message: radius.reason }
    }
  }

  const executor = EXECUTORS[toolName]
  if (!executor) {
    const reason = `"${toolName}" has no executor. It can be requested and approved, but this system does not perform it automatically.`
    await recordRefusal(toolName, args, ctx, decision.classification, reason)
    return { ok: false, status: 'refused', classification: decision.classification, message: reason }
  }

  // ── The action record opens BEFORE the work ───────────────────────────
  const action = await prisma.emailAgentAction.create({
    data: {
      toolName,
      arguments: redact(args) as never,
      policyClassification: decision.classification,
      policyReason: decision.reason,
      status: 'started',
      actor: ctx.actor,
      actorName: ctx.actorName ?? null,
      aiProvider: ctx.aiProvider ?? null,
      aiModel: ctx.aiModel ?? null,
      idempotencyKey: key,
      correlationId: ctx.correlationId,
      runId: ctx.runId ?? null,
      incidentId: ctx.incidentId ?? null,
      approvalId: ctx.approvalId ?? null,
      campaignId: (argsRecord.campaignId as string | undefined) ?? null,
      runRefId: (argsRecord.runId as string | undefined) ?? null,
      sendId: (argsRecord.sendId as string | undefined) ?? null,
      environment: detectEnvironment(),
      service: detectService(),
      argumentsHash,
    },
    select: { id: true },
  })

  try {
    const outcome = await executor(args, ctx)

    // GATE 7 lives inside each executor: it re-reads state and sets `refused`
    // when the world moved. A refusal is a closed action, not a failure.
    const status = outcome.refused ? 'refused' : 'succeeded'
    await prisma.emailAgentAction.update({
      where: { id: action.id },
      data: {
        status,
        beforeState: redact(outcome.before) as never,
        afterState: redact(outcome.after) as never,
        result: redact({ message: outcome.message, ...(outcome.data ?? {}) }) as never,
        completedAt: new Date(),
        ...(outcome.refused ? { error: `refused: ${outcome.refused}` } : {}),
      },
    })

    if (ctx.incidentId) {
      await addIncidentEvent(
        ctx.incidentId,
        status === 'succeeded' ? 'action_succeeded' : 'action_attempted',
        `${toolName}: ${outcome.message}`,
        { toolName, status, correlationId: ctx.correlationId },
        ctx.actor
      )
    }

    log.info({ tool: toolName, status, correlationId: ctx.correlationId, actionId: action.id }, 'agent tool executed')
    return {
      ok: status === 'succeeded',
      status: status === 'succeeded' ? 'succeeded' : 'refused',
      classification: decision.classification,
      message: outcome.message,
      actionId: action.id,
      data: outcome.data,
    }
  } catch (err) {
    const message = safeErrorMessage(err)
    // The row is CLOSED as failed. It is never left open, and it is never
    // reported successful — a failed repair that reads as success is the worst
    // possible outcome for an operator who is not watching.
    await prisma.emailAgentAction
      .update({ where: { id: action.id }, data: { status: 'failed', error: message, completedAt: new Date() } })
      .catch(() => undefined)
    if (ctx.incidentId) {
      await addIncidentEvent(ctx.incidentId, 'action_failed', `${toolName} failed: ${message}`, { toolName }, ctx.actor)
    }
    log.error({ tool: toolName, err: message, correlationId: ctx.correlationId }, 'agent tool FAILED')
    return { ok: false, status: 'failed', classification: decision.classification, message: `${toolName} failed: ${message}`, actionId: action.id }
  }
}

/** Record an attempt that never ran, so refusals are auditable too. */
async function recordRefusal(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
  classification: PolicyClassification,
  reason: string
): Promise<void> {
  try {
    await prisma.emailAgentAction.create({
      data: {
        toolName: String(toolName).slice(0, 60),
        arguments: redact(args) as never,
        policyClassification: classification,
        policyReason: reason.slice(0, 1000),
        status: 'refused',
        error: reason.slice(0, 500),
        actor: ctx.actor,
        actorName: ctx.actorName ?? null,
        correlationId: ctx.correlationId,
        runId: ctx.runId ?? null,
        incidentId: ctx.incidentId ?? null,
        environment: detectEnvironment(),
        service: detectService(),
        completedAt: new Date(),
      },
    })
  } catch (err) {
    log.error({ err: safeErrorMessage(err), tool: toolName }, 'could not record a refused action')
  }
}

// ── Approvals ───────────────────────────────────────────────────────────

/**
 * What an owner is told, per tool.
 *
 * This covers the always-approval tools AND the automatic repairs, because in
 * read_only mode every repair is downgraded to a question — and a question that
 * says "the requested action will be performed exactly as described" tells the
 * owner nothing they can decide on. An approval request is only as good as the
 * sentence explaining what happens if they say yes.
 */
const APPROVAL_COPY: Record<string, { effect: string; risk: string }> = {
  // ── Repairs, shown when read_only downgrades them to a question ──
  pauseMarketingDispatch: {
    effect: 'The global marketing kill switch goes ON. No campaign dispatches, and any batch already in flight halts with its recipients left PENDING.',
    risk: 'Sending stops until a person resumes it. Nothing is lost — held recipients resume where they were — but scheduled campaigns will sit past their send time.',
  },
  pauseCampaign: {
    effect: 'This one campaign moves to PAUSED and cannot dispatch. Other campaigns are unaffected.',
    risk: 'If the campaign was fine, its send is delayed until somebody resumes it.',
  },
  reconcileRunCounters: {
    effect: 'The run\'s sent/skipped/failed/cancelled counters are recomputed from its recipient rows. No recipient changes and no email is sent.',
    risk: 'Very low. The recipient rows are the canonical record; this only corrects the summary that disagreed with them.',
  },
  finalizeSettledRun: {
    effect: 'A run whose recipients have all reached a final state is closed, and its campaign follows to COMPLETED.',
    risk: 'Very low. It is refused outright if any recipient is still open.',
  },
  releaseExpiredLock: {
    effect: 'Recipients stuck mid-send past the stale window return to PENDING so the next batch can pick them up.',
    risk: 'Low. Anything whose provider outcome is unknown is deliberately held back, and the send-level idempotency key still prevents a duplicate.',
  },
  reprocessValidWebhookEvent: {
    effect: 'Suppressions from already-verified bounce and complaint webhooks that failed to write are applied again.',
    risk: 'Very low. This can only ADD a suppression, never remove one.',
  },
  retryTransientSendOnce: {
    // HONEST ABOUT ITS OWN REACH (audited 2026-08-07): this clears the block on
    // the ledger row. It does not enqueue anything, and nothing polls for
    // re-opened rows — so it only results in a delivery when a producer comes
    // back for that send (a lifecycle journey re-enrolling, a campaign re-run).
    // Saying "one more attempt" implied a retry engine that does not exist.
    effect:
      'The block on one send whose failure was classified transient is cleared, so a later attempt is allowed. It does not itself re-send: a lifecycle stage will be picked up again by its journey, a one-off send will not.',
    risk: 'A message could reach the customer later than expected, or not at all if nothing produces it again. Delivered and ambiguous sends are refused, so a duplicate is not possible.',
  },
  // ── Always-approval tools ──
  resumeMarketingDispatch: {
    effect: 'Campaign dispatch starts again immediately. Any campaign whose scheduled time has passed dispatches on the next sweep.',
    risk: 'If the condition that caused the pause is not fixed, the same problem resumes at full speed.',
  },
  resumeCampaign: {
    effect: 'The campaign returns to a sending state and can dispatch.',
    risk: 'If it was paused for a consent or suppression reason, resuming asserts that the compliance problem is resolved.',
  },
  rescheduleCampaign: { effect: 'The campaign will send at the new time instead of the old one.', risk: 'A time in the past dispatches on the very next sweep.' },
  dispatchCampaignNow: { effect: 'The campaign sends to its audience immediately.', risk: 'Real people receive email. This cannot be undone.' },
  retryFailedRecipients: {
    effect: 'Failed recipients are re-attempted.',
    risk: 'Anyone whose original outcome was ambiguous could receive a second copy.',
  },
}

export async function createApprovalRequest(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  reason: string,
  overrides: { question?: string; expectedEffect?: string; risk?: string; incidentId?: string } = {}
): Promise<{ id: string; reference: string }> {
  const checksum = await resourceChecksum(args)
  const year = ctx.now.getUTCFullYear()
  const count = await prisma.emailAgentApproval.count({ where: { createdAt: { gte: new Date(Date.UTC(year, 0, 1)) } } })
  const reference = `APR-${year}-${String(count + 1).padStart(5, '0')}`
  const copy = APPROVAL_COPY[toolName] ?? {
    effect: 'The requested action will be performed exactly as described.',
    risk: 'Review the arguments before approving.',
  }

  // An open request for the same tool + subject is reused rather than
  // duplicated: an owner should see one question, not one per cycle.
  const existing = await prisma.emailAgentApproval.findFirst({
    where: { toolName, status: 'pending', resourceChecksum: checksum, expiresAt: { gt: ctx.now } },
    select: { id: true, reference: true },
  })
  if (existing) return existing

  const created = await prisma.emailAgentApproval.create({
    data: {
      reference,
      incidentId: overrides.incidentId ?? ctx.incidentId ?? null,
      toolName,
      arguments: redact(args) as never,
      question: (overrides.question ?? `Approve ${toolName}?`).slice(0, 600),
      reason: reason.slice(0, 1000),
      expectedEffect: (overrides.expectedEffect ?? copy.effect).slice(0, 1000),
      risk: (overrides.risk ?? copy.risk).slice(0, 1000),
      campaignId: (args.campaignId as string | undefined) ?? null,
      runRefId: (args.runId as string | undefined) ?? null,
      sendId: (args.sendId as string | undefined) ?? null,
      resourceChecksum: checksum,
      status: 'pending',
      environment: detectEnvironment(),
      expiresAt: new Date(ctx.now.getTime() + APPROVAL_TTL_MS),
    },
    select: { id: true, reference: true },
  })

  if (overrides.incidentId ?? ctx.incidentId) {
    await addIncidentEvent(
      (overrides.incidentId ?? ctx.incidentId)!,
      'approval_requested',
      `Asked the owner to approve ${toolName} (${created.reference}).`,
      { toolName, approvalReference: created.reference }
    )
    await prisma.emailAgentIncident
      .update({ where: { id: (overrides.incidentId ?? ctx.incidentId)! }, data: { status: 'awaiting_approval' } })
      .catch(() => undefined)
  }
  return created
}

export type ApprovalVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Is this approval still good for this exact call?
 *
 * FOUR WAYS AN APPROVAL DIES, and the fourth is the one that matters most:
 * the resource changed after the human looked at it. An owner who approved
 * "send campaign X to these 40 people" did not approve it after somebody
 * swapped the audience.
 */
export async function validateApproval(
  approval: { id: string; toolName: string; arguments: unknown; status: string; expiresAt: Date; resourceChecksum: string },
  toolName: string,
  args: Record<string, unknown>,
  now: Date
): Promise<ApprovalVerdict> {
  if (approval.status !== 'approved') {
    return { ok: false, reason: `That approval is ${approval.status}, not approved. The action is refused.` }
  }
  if (approval.toolName !== toolName) {
    return { ok: false, reason: `That approval is for ${approval.toolName}, not ${toolName}. An approval authorises one action, not a category.` }
  }
  if (approval.expiresAt <= now) {
    await prisma.emailAgentApproval.update({ where: { id: approval.id }, data: { status: 'expired', invalidationReason: 'Expired before it was used.' } }).catch(() => undefined)
    return { ok: false, reason: 'That approval has expired. Approvals are deliberately short-lived so a stale decision cannot authorise a fresh action.' }
  }
  const current = await resourceChecksum(args)
  if (current !== approval.resourceChecksum) {
    await prisma.emailAgentApproval
      .update({ where: { id: approval.id }, data: { status: 'invalidated', invalidationReason: 'The resource changed after it was approved.' } })
      .catch(() => undefined)
    return {
      ok: false,
      reason: 'The campaign, run or send changed after this was approved, so the approval no longer describes what would happen. It has been invalidated and must be asked again.',
    }
  }
  return { ok: true }
}

/** Expire approvals nobody answered. Called each cycle. */
export async function expireStaleApprovals(now: Date): Promise<number> {
  const result = await prisma.emailAgentApproval.updateMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    data: { status: 'expired', invalidationReason: 'Nobody answered before it expired.' },
  })
  return result.count
}

export { TOOL_SCHEMAS }
