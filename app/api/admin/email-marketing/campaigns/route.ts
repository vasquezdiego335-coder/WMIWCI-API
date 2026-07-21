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
      ...withConfig,
    })
    return NextResponse.json({
      campaigns: campaigns.map((c) => ({
        ...c,
        allowedTransitions: allowedTransitions(c.status as CampaignState),
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
  action: z.enum(['update', 'validate', 'approve', 'transition']),
  /** For action:'transition'. */
  status: z.string().trim().optional(),
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
  const { id, action, patch, note } = parsed.data

  const campaign = await prisma.marketingCampaign.findUnique({ where: { id }, ...withConfig })
  if (!campaign || campaign.channel !== 'EMAIL') {
    return NextResponse.json({ error: 'That email campaign does not exist.' }, { status: 404 })
  }
  const config = campaign.emailConfig
  if (!config) return NextResponse.json({ error: 'This campaign has no email configuration.' }, { status: 409 })

  const state = campaign.status as CampaignState

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
      if (a.ok) preview = await previewAudience(a.definition)
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

    await prisma.$transaction([
      prisma.emailCampaignConfig.update({
        where: { campaignId: id },
        data: { approvedAt: new Date(), approvedById: session?.userId ?? null, approvedByName: session?.name ?? null },
      }),
      prisma.marketingCampaign.update({ where: { id }, data: { status: 'READY' } }),
      prisma.auditLog.create({
        data: { action: 'EMAIL_CAMPAIGN_APPROVED', userId: session?.userId ?? null, details: { campaignId: id, name: campaign.name } },
      }),
    ])
    log.info({ campaignId: id, by: session?.userId }, 'email campaign APPROVED')
    return NextResponse.json({ ok: true, status: 'READY' })
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

  await prisma.$transaction([
    prisma.marketingCampaign.update({ where: { id }, data: { status: target, updatedById: session?.userId ?? null } }),
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
