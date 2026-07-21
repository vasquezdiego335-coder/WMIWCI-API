import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { SpendKind } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { evaluateSpend, budgetStatus } from '@/lib/marketing-guards'
import { z } from 'zod'

// P1-1 — record what a campaign actually cost. Without rows here, spendCents is
// always 0 and Profit ROAS is always null.
//
// Spend is period-bounded by incurredOn in loadMarketingReport, so the DATE is
// load-bearing: it decides which month's ROAS this money lands in. It is never
// defaulted silently to "today" when the caller supplied something unparseable.

const CreateSchema = z.object({
  campaignId: z.string().trim().min(1),
  kind: z.nativeEnum(SpendKind),
  amountCents: z.number().int().positive().max(1_000_000_00),
  incurredOn: z.string().optional(), // 'YYYY-MM-DD' or ISO; defaults to now
  vendor: z.string().trim().max(200).optional(),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  recurring: z.boolean().optional(),
  receiptUrl: z.string().url().max(1000).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'marketing.record_spend')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const campaign = await prisma.marketingCampaign.findUnique({
    where: { id: d.campaignId },
    select: {
      id: true, name: true, sourceKey: true, status: true, startDate: true,
      endDate: true, budgetCents: true,
      spend: { select: { amountCents: true } },
    },
  })
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  let incurredOn = new Date()
  if (d.incurredOn) {
    incurredOn = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d.incurredOn) ? `${d.incurredOn}T12:00:00Z` : d.incurredOn)
    if (Number.isNaN(incurredOn.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
    }
  }

  const decision = evaluateSpend({
    campaignStatus: campaign.status,
    amountCents: d.amountCents,
    incurredOn,
    campaignStart: campaign.startDate,
    campaignEnd: campaign.endDate,
  })
  if (!decision.allow) return NextResponse.json({ error: decision.error }, { status: decision.status })

  const spend = await prisma.$transaction(async (tx) => {
    const s = await tx.marketingSpend.create({
      data: {
        campaignId: campaign.id,
        kind: d.kind,
        amountCents: d.amountCents,
        incurredOn,
        vendor: d.vendor || null,
        reference: d.reference || null,
        notes: d.notes || null,
        recurring: d.recurring ?? false,
        receiptUrl: d.receiptUrl || null,
        createdById: session.userId,
        createdByName: session.name,
      },
    })
    await tx.auditLog.create({
      data: {
        action: 'CAMPAIGN_SPEND_RECORDED',
        userId: session.userId,
        details: {
          spendId: s.id, campaignId: campaign.id, campaignName: campaign.name,
          sourceKey: campaign.sourceKey, kind: s.kind, amountCents: s.amountCents,
          incurredOn: s.incurredOn.toISOString(), vendor: s.vendor, recordedBy: session.name,
        },
      },
    })
    return s
  })

  const spentCents = campaign.spend.reduce((sum, s) => sum + s.amountCents, 0) + d.amountCents
  const budget = budgetStatus(spentCents, campaign.budgetCents)
  const warnings = [...decision.warnings]
  if (budget.overBudget) {
    warnings.push(`Campaign is over budget: ${(spentCents / 100).toFixed(2)} spent against a ${((campaign.budgetCents ?? 0) / 100).toFixed(2)} budget.`)
  }

  apiLogger.info({ spendId: spend.id, campaignId: campaign.id, amountCents: spend.amountCents, kind: spend.kind }, 'Marketing spend recorded')
  return NextResponse.json({ spend, spentCents, budget, warnings }, { status: 201 })
}
