import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { CampaignChannel, CampaignStatus } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { normalizeSourceKey } from '@/lib/marketing-guards'
import { z } from 'zod'

// P1-1 — edit a campaign. Every change is diffed into the audit log, because
// changing sourceKey or status silently re-buckets historical marketing
// reporting: yesterday's ROAS number can move without anyone touching a
// booking or a dollar.

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  channel: z.nativeEnum(CampaignChannel).optional(),
  sourceKey: z.string().trim().min(1).max(100).optional(),
  status: z.nativeEnum(CampaignStatus).optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  budgetCents: z.number().int().nonnegative().max(1_000_000_00).nullable().optional(),
  printQuantity: z.number().int().nonnegative().max(10_000_000).nullable().optional(),
  distributionArea: z.string().trim().max(300).nullable().optional(),
  creativeVersion: z.string().trim().max(120).nullable().optional(),
  offer: z.string().trim().max(300).nullable().optional(),
  landingPageUrl: z.string().url().max(1000).nullable().optional(),
  qrIdentifier: z.string().trim().max(120).nullable().optional(),
  phoneIdentifier: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

function parseDate(v: string | null | undefined): Date | null | 'invalid' | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v)
  return Number.isNaN(d.getTime()) ? 'invalid' : d
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'marketing.manage_campaign')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = UpdateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const existing = await prisma.marketingCampaign.findUnique({
    where: { id: ctx.params.id },
    select: {
      id: true, name: true, channel: true, sourceKey: true, status: true,
      startDate: true, endDate: true, budgetCents: true,
      spend: { select: { id: true } },
    },
  })
  if (!existing) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  const startDate = parseDate(d.startDate)
  const endDate = parseDate(d.endDate)
  if (startDate === 'invalid' || endDate === 'invalid') {
    return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
  }
  const effStart = startDate === undefined ? existing.startDate : startDate
  const effEnd = endDate === undefined ? existing.endDate : endDate
  if (effStart && effEnd && effEnd < effStart) {
    return NextResponse.json({ error: 'End date is before start date' }, { status: 422 })
  }

  const nextSourceKey = d.sourceKey ? normalizeSourceKey(d.sourceKey) : undefined

  // Re-keying a campaign that already has spend moves that money to a different
  // bucket in every historical marketing report. Allowed — it is sometimes the
  // correct fix for a typo — but never quiet.
  const rekeyed = nextSourceKey != null && nextSourceKey !== existing.sourceKey
  const rekeyWarning = rekeyed && existing.spend.length > 0
    ? `Source key changed from "${existing.sourceKey}" to "${nextSourceKey}" on a campaign with ${existing.spend.length} spend row(s). Historical marketing reports will now attribute that spend to the new key.`
    : null

  // JSON-safe scalars only: this object is written straight into AuditLog.details.
  type Scalar = string | number | null
  const changes: Record<string, { from: Scalar; to: Scalar }> = {}
  const scalar = (v: unknown): Scalar =>
    v == null ? null : v instanceof Date ? v.toISOString() : typeof v === 'number' ? v : String(v)
  const track = <T,>(field: string, from: T, to: T | undefined) => {
    if (to !== undefined && to !== from) changes[field] = { from: scalar(from), to: scalar(to) }
  }
  track('name', existing.name, d.name)
  track('channel', existing.channel, d.channel)
  track('sourceKey', existing.sourceKey, nextSourceKey)
  track('status', existing.status, d.status)
  track('budgetCents', existing.budgetCents, d.budgetCents === undefined ? undefined : d.budgetCents)
  if (startDate !== undefined && startDate?.getTime() !== existing.startDate?.getTime()) {
    changes.startDate = { from: scalar(existing.startDate), to: scalar(startDate) }
  }
  if (endDate !== undefined && endDate?.getTime() !== existing.endDate?.getTime()) {
    changes.endDate = { from: scalar(existing.endDate), to: scalar(endDate) }
  }

  if (Object.keys(changes).length === 0 && d.notes === undefined && d.offer === undefined) {
    return NextResponse.json({ campaign: existing, changes: {}, note: 'No changes applied.' })
  }

  const campaign = await prisma.$transaction(async (tx) => {
    const c = await tx.marketingCampaign.update({
      where: { id: existing.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.channel !== undefined ? { channel: d.channel } : {}),
        ...(nextSourceKey !== undefined ? { sourceKey: nextSourceKey } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(startDate !== undefined ? { startDate } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
        ...(d.budgetCents !== undefined ? { budgetCents: d.budgetCents } : {}),
        ...(d.printQuantity !== undefined ? { printQuantity: d.printQuantity } : {}),
        ...(d.distributionArea !== undefined ? { distributionArea: d.distributionArea } : {}),
        ...(d.creativeVersion !== undefined ? { creativeVersion: d.creativeVersion } : {}),
        ...(d.offer !== undefined ? { offer: d.offer } : {}),
        ...(d.landingPageUrl !== undefined ? { landingPageUrl: d.landingPageUrl } : {}),
        ...(d.qrIdentifier !== undefined ? { qrIdentifier: d.qrIdentifier } : {}),
        ...(d.phoneIdentifier !== undefined ? { phoneIdentifier: d.phoneIdentifier } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
        updatedById: session.userId,
      },
    })
    await tx.auditLog.create({
      data: {
        action: 'CAMPAIGN_UPDATED',
        userId: session.userId,
        details: { campaignId: c.id, name: c.name, changes, rekeyedWithSpend: !!rekeyWarning, updatedBy: session.name },
      },
    })
    return c
  })

  apiLogger.info({ campaignId: campaign.id, changed: Object.keys(changes), rekeyed }, 'Marketing campaign updated')
  return NextResponse.json({ campaign, changes, warning: rekeyWarning })
}
