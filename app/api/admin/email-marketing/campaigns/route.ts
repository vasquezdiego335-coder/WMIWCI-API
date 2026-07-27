// EMAIL CAMPAIGN API (owner spec 2026-07-21).
//
// GET   — email campaigns with their config, validation and results.
// POST  — create a DRAFT.
// PATCH — edit a draft, validate, approve, or change state.
//
// An email campaign is a MarketingCampaign (channel=EMAIL) plus a 1:1
// EmailCampaignConfig. There is no second campaign record.
//
// THE INVARIANT THIS ROUTE PROTECTS: creation and dispatch are different
// events. POST always creates a DRAFT — there is no `status` parameter and no
// code path that creates an ACTIVE campaign. Reaching a sending state requires
// separate PATCH calls to validate, approve and schedule, each of which the
// state machine checks.

import { NextRequest, NextResponse } from 'next/server'
import { sendConfigHash } from '@/lib/email-campaign-approval'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import {
  validateCampaign,
  canTransition,
  canApprove,
  allowedTransitions,
  isCampaignState,
  type CampaignState,
  type CampaignValidation,
} from '@/lib/email-campaign'
import { validateAudienceDefinition, previewAudience } from '@/lib/email-audience'
import { dispatchCampaign, pauseRun, resumeRun, cancelRun, retryFailedRecipients } from '@/lib/email-campaign-dispatch'
import { promotionsEnabled, type RecipientState } from '@/lib/email-campaign-run'
import { templateAllowsSegment } from '@/lib/email-recipient-context'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/campaigns' })

const withConfig = { include: { emailConfig: { include: { audience: true } }, spend: true } }

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  try {
    const campaigns = await prisma.marketingCampaign.findMany({
      where: { channel: 'EMAIL' },
      orderBy: { createdAt: 'desc' },
      include: {
        ...withConfig.include,
        // Execution truth for the admin: the most recent runs with their
        // recipient-state counts, so "ACTIVE" is never shown without evidence.
        emailRuns: { orderBy: { startedAt: 'desc' }, take: 3 },
      },
    })
    const runIds = campaigns.flatMap((c) => c.emailRuns.map((r) => r.id))
    const recipientCounts = runIds.length
      ? await prisma.emailCampaignRecipient.groupBy({ by: ['runId', 'status'], where: { runId: { in: runIds } }, _count: { _all: true } })
      : []
    const countsByRun = new Map<string, Record<string, number>>()
    for (const g of recipientCounts) {
      const entry = countsByRun.get(g.runId) ?? {}
      entry[g.status] = g._count._all
      countsByRun.set(g.runId, entry)
    }
    return NextResponse.json({
      promotionsEnabled: promotionsEnabled(),
      campaigns: campaigns.map((c) => ({
        ...c,
        allowedTransitions: allowedTransitions(c.status as CampaignState),
        emailRuns: c.emailRuns.map((r) => ({ ...r, recipientCounts: countsByRun.get(r.id) ?? {} })),
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 })
  }
}

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  sourceKey: z.string().trim().min(2).max(80),
  template: z.string().trim().min(1).max(80),
  subject: z.string().trim().max(200).optional(),
  audienceId: z.string().trim().optional(),
  scheduledAt: z.string().trim().optional(),
  utmSource: z.string().trim().max(80).optional(),
  utmMedium: z.string().trim().max(80).optional(),
  utmCampaign: z.string().trim().max(80).optional(),
  utmContent: z.string().trim().max(80).optional(),
  discountCode: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(1000).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_campaign')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid campaign.', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 400 })
  }
  const d = parsed.data

  try {
    const created = await prisma.$transaction(async (tx) => {
      const campaign = await tx.marketingCampaign.create({
        data: {
          name: d.name,
          channel: 'EMAIL',
          sourceKey: d.sourceKey,
          // ALWAYS DRAFT. There is deliberately no way to ask this endpoint for
          // any other state — a campaign must never launch because it was made.
          status: 'DRAFT',
          notes: d.notes ?? null,
          createdById: session?.userId ?? null,
          createdByName: session?.name ?? null,
        },
      })
      const config = await tx.emailCampaignConfig.create({
        data: {
          campaignId: campaign.id,
          template: d.template,
          subject: d.subject ?? null,
          audienceId: d.audienceId ?? null,
          scheduledAt: d.scheduledAt ? new Date(d.scheduledAt) : null,
          utmSource: d.utmSource ?? null,
          utmMedium: d.utmMedium ?? 'email',
          utmCampaign: d.utmCampaign ?? d.sourceKey,
          utmContent: d.utmContent ?? null,
          discountCode: d.discountCode ?? null,
          createdById: session?.userId ?? null,
        },
      })
      await tx.auditLog.create({
        data: {
          action: 'EMAIL_CAMPAIGN_CREATED',
          userId: session?.userId ?? null,
          details: { campaignId: campaign.id, name: d.name, template: d.template, sourceKey: d.sourceKey },
        },
      })
      return { campaign, config }
    })

    log.info({ campaignId: created.campaign.id, by: session?.userId }, 'email campaign draft created')
    return NextResponse.json({ campaign: created.campaign, config: created.config }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const conflict = /Unique constraint/i.test(msg)
    return NextResponse.json({ error: conflict ? 'A campaign with that source key or name already exists.' : msg }, { status: conflict ? 409 : 500 })
  }
}

const PatchSchema = z.object({
  id: z.string().trim().min(1),
  action: z.enum(['update', 'validate', 'approve', 'transition', 'dispatch', 'pause_run', 'resume_run', 'cancel_run', 'retry_failed']),
  /** For the run-control actions. */
  runId: z.string().trim().optional(),
  /** For action:'transition'. */
  status: z.string().trim().optional(),
  /** For action:'transition' to SCHEDULED — the send time. Optional here because
   *  it may already have been set via action:'update'; one of the two must
   *  supply it (see the SCHEDULED guard below). */
  scheduledAt: z.string().trim().optional(),
  /** For action:'dispatch' — deliberate acceptance that an audience over the
   *  cap will be cut off (audit E-05). Never defaulted true. */
  acknowledgeTruncation: z.boolean().optional(),
  /** For action:'update'. */
  patch: z
    .object({
      name: z.string().trim().min(2).max(160).optional(),
      template: z.string().trim().max(80).optional(),
      subject: z.string().trim().max(200).nullable().optional(),
      audienceId: z.string().trim().nullable().optional(),
      scheduledAt: z.string().trim().nullable().optional(),
      utmSource: z.string().trim().max(80).nullable().optional(),
      utmMedium: z.string().trim().max(80).nullable().optional(),
      utmCampaign: z.string().trim().max(80).nullable().optional(),
      utmContent: z.string().trim().max(80).nullable().optional(),
      discountCode: z.string().trim().max(60).nullable().optional(),
    })
    .optional(),
  /** Required when cancelling or failing — recorded on the campaign. */
  note: z.string().trim().max(500).optional(),
})

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_campaign')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const { id, action, patch, note, runId } = parsed.data

  const campaign = await prisma.marketingCampaign.findUnique({ where: { id }, ...withConfig })
  if (!campaign || campaign.channel !== 'EMAIL') {
    return NextResponse.json({ error: 'That email campaign does not exist.' }, { status: 404 })
  }
  const config = campaign.emailConfig
  if (!config) return NextResponse.json({ error: 'This campaign has no email configuration.' }, { status: 409 })

  const state = campaign.status as CampaignState
  const actor = { userId: session?.userId ?? null, name: session?.name ?? null }

  // ── dispatch — start sending NOW ──
  // Every gate re-runs inside dispatchCampaign (state, approval freshness,
  // fresh validation, the EMAIL_PROMOTIONS_ENABLED master switch, template↔
  // audience compatibility). Idempotent: a second call while a run is
  // unfinished returns that run.
  if (action === 'dispatch') {
    const result = await dispatchCampaign(id, actor, { acknowledgeTruncation: parsed.data.acknowledgeTruncation === true })
    if (!result.ok) {
      // An over-cap audience is refused with a flag the UI turns into an
      // explicit second confirmation, rather than a dead error (audit E-05).
      const needsTruncationAck = /larger than \d+ and would be silently cut off/.test(result.error)
      return NextResponse.json({ error: result.error, ...(needsTruncationAck ? { needsTruncationAck: true } : {}) }, { status: 409 })
    }
    return NextResponse.json({ ok: true, runId: result.runId, totalRecipients: result.totalRecipients, alreadyRunning: result.alreadyRunning })
  }

  // ── run controls — pause / resume / cancel / retry ──
  if (action === 'pause_run' || action === 'resume_run' || action === 'cancel_run' || action === 'retry_failed') {
    if (!runId) return NextResponse.json({ error: 'A runId is required.' }, { status: 400 })
    const run = await prisma.emailCampaignRun.findUnique({ where: { id: runId }, select: { campaignId: true } })
    if (!run || run.campaignId !== id) return NextResponse.json({ error: 'That run does not belong to this campaign.' }, { status: 404 })
    if (action === 'retry_failed') {
      const result = await retryFailedRecipients(runId, actor)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
      // needsReconciliation names the recipients the SERVER refused to retry
      // because their provider outcome is unknown (audit E-07) — the operator
      // must see that they were deliberately held, not quietly skipped.
      return NextResponse.json({
        ok: true,
        reopened: result.reopened,
        needsReconciliation: result.needsReconciliation,
        ...(result.needsReconciliation > 0
          ? {
              notice: `${result.reopened} recipient(s) re-opened. ${result.needsReconciliation} were NOT retried because their provider outcome is unknown — resending could deliver a duplicate. Reconcile those against the Resend dashboard.`,
            }
          : {}),
      })
    }
    const fn = action === 'pause_run' ? pauseRun : action === 'resume_run' ? resumeRun : cancelRun
    const result = await fn(runId, actor)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true, runStatus: result.status })
  }

  // ── update ──
  if (action === 'update') {
    // A campaign that has been approved or is sending is not a draft any more.
    // Editing one silently would change what was approved after the approval.
    if (!['DRAFT', 'VALIDATING', 'FAILED'].includes(state)) {
      return NextResponse.json(
        { error: `A campaign in ${state} cannot be edited. Move it back to DRAFT first, which clears its approval.` },
        { status: 409 }
      )
    }
    const p = patch ?? {}
    await prisma.$transaction([
      prisma.marketingCampaign.update({ where: { id }, data: { ...(p.name ? { name: p.name } : {}), updatedById: session?.userId ?? null } }),
      prisma.emailCampaignConfig.update({
        where: { campaignId: id },
        data: {
          ...(p.template ? { template: p.template } : {}),
          ...(p.subject !== undefined ? { subject: p.subject } : {}),
          ...(p.audienceId !== undefined ? { audienceId: p.audienceId } : {}),
          ...(p.scheduledAt !== undefined ? { scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : null } : {}),
          ...(p.utmSource !== undefined ? { utmSource: p.utmSource } : {}),
          ...(p.utmMedium !== undefined ? { utmMedium: p.utmMedium } : {}),
          ...(p.utmCampaign !== undefined ? { utmCampaign: p.utmCampaign } : {}),
          ...(p.utmContent !== undefined ? { utmContent: p.utmContent } : {}),
          ...(p.discountCode !== undefined ? { discountCode: p.discountCode } : {}),
          // Any edit invalidates a previous pass. Approving on a stale check
          // would approve a campaign that no longer exists.
          validation: undefined,
          approvedAt: null,
          approvedById: null,
          approvedByName: null,
        },
      }),
      prisma.auditLog.create({
        data: { action: 'EMAIL_CAMPAIGN_UPDATED', userId: session?.userId ?? null, details: { campaignId: id, patch: p } },
      }),
    ])
    return NextResponse.json({ ok: true })
  }

  // ── validate ──
  if (action === 'validate') {
    const audience = config.audience?.definition ?? null
    const result = validateCampaign({
      name: campaign.name,
      sourceKey: campaign.sourceKey,
      template: config.template,
      subject: config.subject,
      audienceDefinition: audience,
      scheduledAt: config.scheduledAt,
      utmSource: config.utmSource,
      utmMedium: config.utmMedium,
      utmCampaign: config.utmCampaign,
      utmContent: config.utmContent,
      discountCode: config.discountCode,
    })

    // Show what the audience would actually reach, so an owner validating a
    // campaign sees the real exclusion counts and not just "valid".
    let preview = null
    if (audience) {
      const a = validateAudienceDefinition(audience)
      if (a.ok) {
        preview = await previewAudience(a.definition)
        // Template ↔ segment compatibility (dispatch would refuse it anyway;
        // surfacing it at validation stops a doomed campaign being approved).
        const compat = templateAllowsSegment(config.template, a.definition.segment)
        if (!compat.ok) {
          result.ok = false
          result.errors.push(compat.error)
        }
      }
    }
    if (!promotionsEnabled()) {
      result.warnings.push('EMAIL_PROMOTIONS_ENABLED is off — this campaign can be approved and scheduled, but dispatch will refuse until the switch is deliberately enabled.')
    }

    await prisma.$transaction([
      prisma.emailCampaignConfig.update({ where: { campaignId: id }, data: { validation: result as never } }),
      ...(state === 'DRAFT' ? [prisma.marketingCampaign.update({ where: { id }, data: { status: 'VALIDATING' } })] : []),
    ])
    return NextResponse.json({ validation: result, audiencePreview: preview })
  }

  // ── approve ──
  if (action === 'approve') {
    const validation = (config.validation ?? null) as CampaignValidation | null
    const verdict = canApprove(state, validation)
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 409 })

    // RE-APPROVAL IN PLACE (bug #8). A SCHEDULED campaign whose configuration
    // changed is told by the dispatch guard to be approved again. It must keep
    // its state: SCHEDULED -> READY is not a legal transition, and writing READY
    // here would bypass the state machine and silently unschedule the campaign.
    // Anything already past approval is re-approved IN PLACE. Only the
    // pre-approval states move to READY.
    const keepState = state !== 'VALIDATING' && state !== 'READY'

    // A SCHEDULED campaign with no send time never dispatches (the sweep selects
    // on `scheduledAt <= now`). Since it also cannot legally return to READY to
    // be scheduled again, the send time is repairable right here — the same
    // validation the transition path applies.
    let repairScheduledAt: Date | null = null
    if (state === 'SCHEDULED' && parsed.data.scheduledAt) {
      const d = new Date(parsed.data.scheduledAt)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'scheduledAt is not a valid date.' }, { status: 400 })
      }
      repairScheduledAt = d
    }
    if (state === 'SCHEDULED' && !repairScheduledAt && !config.scheduledAt) {
      return NextResponse.json(
        {
          error:
            'This campaign is SCHEDULED with no send time, so it would never dispatch. Supply scheduledAt with this approval (use the current time to send on the next sweep).',
          needsScheduledAt: true,
        },
        { status: 409 }
      )
    }

    await prisma.$transaction([
      prisma.emailCampaignConfig.update({
        where: { campaignId: id },
        data: {
          approvedAt: new Date(),
          approvedById: session?.userId ?? null,
          approvedByName: session?.name ?? null,
          // RECORD WHAT WAS APPROVED. The dispatch guard compares this hash
          // instead of `updatedAt > approvedAt`, so persisting a validation
          // result — or any other non-send-affecting write to this row — no
          // longer destroys the approval. Only a real change to who receives
          // what does. Same function the guard and the UI use.
          // The hash must describe what is being approved, so a send time
          // repaired in this same call is part of it. scheduledAt is a hashed
          // field: hashing the pre-repair config would leave the campaign
          // instantly "edited after approval" again.
          approvedConfigHash: sendConfigHash(repairScheduledAt ? { ...config, scheduledAt: repairScheduledAt } : config),
          ...(repairScheduledAt ? { scheduledAt: repairScheduledAt } : {}),
        },
      }),
      // Re-approval keeps a SCHEDULED campaign scheduled; a first approval moves
      // VALIDATING/READY to READY.
      ...(keepState ? [] : [prisma.marketingCampaign.update({ where: { id }, data: { status: 'READY' as const } })]),
      prisma.auditLog.create({
        data: {
          // One action, not a new enum value: adding to AuditAction needs a
          // migration, and `reapproved` in the details carries the same fact.
          action: 'EMAIL_CAMPAIGN_APPROVED',
          userId: session?.userId ?? null,
          details: {
            campaignId: id,
            name: campaign.name,
            state,
            reapproved: keepState,
            ...(repairScheduledAt ? { scheduledAtSet: repairScheduledAt.toISOString() } : {}),
          },
        },
      }),
    ])
    log.info({ campaignId: id, by: session?.userId, state, reapproved: keepState }, 'email campaign APPROVED')
    return NextResponse.json({ ok: true, status: keepState ? state : 'READY' })
  }

  // ── transition ──
  const target = parsed.data.status
  if (!isCampaignState(target)) {
    return NextResponse.json({ error: `Unknown target state "${target}".`, allowed: allowedTransitions(state) }, { status: 400 })
  }
  const verdict = canTransition(state, target)
  if (!verdict.ok) return NextResponse.json({ error: verdict.error, allowed: allowedTransitions(state) }, { status: 409 })

  if ((target === 'CANCELLED' || target === 'FAILED') && !note) {
    return NextResponse.json({ error: 'A reason is required to cancel or fail a campaign.' }, { status: 400 })
  }
  // SCHEDULED/ACTIVE mean "this may put mail in front of customers". Approval is
  // the gate, checked here rather than trusted from the UI.
  if ((target === 'SCHEDULED' || target === 'ACTIVE') && !config.approvedAt) {
    return NextResponse.json({ error: 'The campaign has not been approved by an owner.' }, { status: 409 })
  }

  // ── SCHEDULED REQUIRES A SEND TIME (staging rehearsal 2026-07-25) ─────────
  // This transition previously set status=SCHEDULED without ever checking
  // `scheduledAt`. The dispatch sweep selects on
  //   status: 'SCHEDULED' AND emailConfig.scheduledAt <= now
  // so a null send time can NEVER match — the campaign sat in SCHEDULED,
  // reported success to the operator, and silently never sent. A real campaign
  // could miss its window with no error anywhere.
  //
  // Now the transition is refused unless a send time exists (supplied here or
  // previously via action:'update'), and any time supplied is written in the
  // SAME transaction as the status change, so the two can never disagree.
  let scheduledAtToSet: Date | null = null
  if (target === 'SCHEDULED') {
    const supplied = parsed.data.scheduledAt
    if (supplied) {
      const d = new Date(supplied)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'scheduledAt is not a valid date.' }, { status: 400 })
      }
      scheduledAtToSet = d
    }
    const effective = scheduledAtToSet ?? config.scheduledAt
    if (!effective) {
      return NextResponse.json(
        {
          error:
            'A send time is required before a campaign can be scheduled. Set scheduledAt (use the current time to send on the next sweep), then schedule again.',
        },
        { status: 400 }
      )
    }
  }

  await prisma.$transaction([
    prisma.marketingCampaign.update({ where: { id }, data: { status: target, updatedById: session?.userId ?? null } }),
    ...(scheduledAtToSet ? [prisma.emailCampaignConfig.update({ where: { campaignId: id }, data: { scheduledAt: scheduledAtToSet } })] : []),
    ...(note ? [prisma.emailCampaignConfig.update({ where: { campaignId: id }, data: { statusNote: note } })] : []),
    prisma.auditLog.create({
      data: {
        action: 'EMAIL_CAMPAIGN_STATE_CHANGED',
        userId: session?.userId ?? null,
        details: { campaignId: id, from: state, to: target, note: note ?? null },
      },
    }),
  ])

  log.info({ campaignId: id, from: state, to: target, by: session?.userId }, 'email campaign state changed')
  return NextResponse.json({ ok: true, status: target })
}
