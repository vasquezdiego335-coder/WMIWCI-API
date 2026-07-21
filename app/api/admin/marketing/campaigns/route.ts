import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { CampaignChannel, CampaignStatus } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { normalizeSourceKey, checkSourceKeyJoin } from '@/lib/marketing-guards'
import { z } from 'zod'

// P1-1 — the marketing WRITE path (audit finding: Stage 3 created
// marketing_campaigns/marketing_spend, the permissions and the audit actions,
// but never a route that writes them, so both tables stayed permanently empty
// and Profit ROAS was always null).
//
// sourceKey is the JOIN to attribution: it must match the value that lands in
// Booking.firstTouchSource / bookingSource, or a campaign's spend can never be
// matched to the revenue it produced. It is normalized on write for that reason.

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.nativeEnum(CampaignChannel),
  sourceKey: z.string().trim().min(1).max(100),
  status: z.nativeEnum(CampaignStatus).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  budgetCents: z.number().int().nonnegative().max(1_000_000_00).optional(),
  printQuantity: z.number().int().nonnegative().max(10_000_000).optional(),
  distributionArea: z.string().trim().max(300).optional(),
  creativeVersion: z.string().trim().max(120).optional(),
  offer: z.string().trim().max(300).optional(),
  landingPageUrl: z.string().url().max(1000).optional(),
  qrIdentifier: z.string().trim().max(120).optional(),
  phoneIdentifier: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
})

/** 'YYYY-MM-DD' or ISO -> Date, or null. Invalid input is reported, never guessed. */
function parseDate(v: string | undefined): Date | null | 'invalid' {
  if (!v) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v)
  return Number.isNaN(d.getTime()) ? 'invalid' : d
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'report.view_marketing')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const status = req.nextUrl.searchParams.get('status')
  const campaigns = await prisma.marketingCampaign.findMany({
    where: status && status in CampaignStatus ? { status: status as CampaignStatus } : undefined,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true, name: true, channel: true, sourceKey: true, status: true,
      startDate: true, endDate: true, budgetCents: true, offer: true,
      distributionArea: true, printQuantity: true, landingPageUrl: true,
      qrIdentifier: true, phoneIdentifier: true, notes: true, createdAt: true,
      spend: { select: { id: true, kind: true, amountCents: true, incurredOn: true, vendor: true } },
    },
  })

  // Spend totals are derived here rather than stored, so they can never drift
  // from the rows they summarize.
  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      ...c,
      spentCents: c.spend.reduce((sum, s) => sum + s.amountCents, 0),
      spendCount: c.spend.length,
    })),
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'marketing.manage_campaign')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const startDate = parseDate(d.startDate)
  const endDate = parseDate(d.endDate)
  if (startDate === 'invalid' || endDate === 'invalid') {
    return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
  }
  if (startDate && endDate && endDate < startDate) {
    return NextResponse.json({ error: 'End date is before start date' }, { status: 422 })
  }

  const sourceKey = normalizeSourceKey(d.sourceKey)

  // Will this key actually join to recorded attribution? A key that matches
  // existing bookings only after canonicalization would put the spend and the
  // revenue it bought into two unrelated report rows. Surfaced, never silently
  // "fixed" by rewriting historical booking sources.
  const observed = await prisma.booking.findMany({
    where: { OR: [{ bookingSource: { not: null } }, { firstTouchSource: { not: null } }] },
    select: { bookingSource: true, firstTouchSource: true, lastTouchSource: true, ownerAssignedSource: true },
    take: 2000,
  })
  const distinct = Array.from(new Set(
    observed.flatMap((b) => [b.ownerAssignedSource, b.bookingSource, b.lastTouchSource, b.firstTouchSource])
      .filter((s): s is string => !!s && !!s.trim())
      .map((s) => s.trim()),
  ))
  const join = checkSourceKeyJoin(sourceKey, distinct)

  const campaign = await prisma.$transaction(async (tx) => {
    const c = await tx.marketingCampaign.create({
      data: {
        name: d.name,
        channel: d.channel,
        sourceKey,
        status: d.status ?? CampaignStatus.DRAFT,
        startDate,
        endDate,
        budgetCents: d.budgetCents ?? null,
        printQuantity: d.printQuantity ?? null,
        distributionArea: d.distributionArea || null,
        creativeVersion: d.creativeVersion || null,
        offer: d.offer || null,
        landingPageUrl: d.landingPageUrl || null,
        qrIdentifier: d.qrIdentifier || null,
        phoneIdentifier: d.phoneIdentifier || null,
        notes: d.notes || null,
        createdById: session.userId,
        createdByName: session.name,
      },
    })
    await tx.auditLog.create({
      data: {
        action: 'CAMPAIGN_CREATED',
        userId: session.userId,
        details: { campaignId: c.id, name: c.name, channel: c.channel, sourceKey: c.sourceKey, budgetCents: c.budgetCents, createdBy: session.name },
      },
    })
    return c
  })

  apiLogger.info({ campaignId: campaign.id, sourceKey, channel: campaign.channel, joinExact: join.exact, joinMismatch: join.canonicalOnly.length }, 'Marketing campaign created')
  return NextResponse.json(
    {
      campaign,
      attribution: {
        matchingBookings: join.exact,
        warning: join.warning,
        // No bookings yet is normal for a new campaign — say so rather than
        // letting an empty number read as a failure.
        note: join.exact === 0 && !join.warning ? 'No bookings currently record this source. That is expected for a new campaign; Profit ROAS stays null until attributed bookings exist.' : null,
      },
    },
    { status: 201 },
  )
}
