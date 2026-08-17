import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { z } from 'zod'
import {
  parseAmountToCents,
  parseExpiry,
  depositUrl,
  effectiveStatus,
  remainingAfterCents,
  MAX_DEPOSIT_CENTS,
} from '@/lib/deposit-links'
import { createDepositRequest } from '@/lib/deposit-service'
import { depositNotifyConfig } from '@/lib/discord-payments'

// ════════════════════════════════════════════════════════════════════════════
//  GET  /api/admin/deposit-links   — searchable history
//  POST /api/admin/deposit-links   — mint a link for an EXACT amount
//  ------------------------------------------------------------------------
//  Auth: the middleware already requires an OWNER/MANAGER session and a valid
//  CSRF token for every /api/admin/* mutation. Each handler ALSO checks the
//  specific permission, so the route is safe on its own merits and a matcher
//  edit cannot silently open it.
//
//  MONEY VALIDATION IS SERVER-SIDE, ALWAYS. The client sends a dollar STRING
//  exactly as typed on a phone; `parseAmountToCents` is the only thing that
//  turns it into an amount, and `createDepositRequest` re-derives the balance
//  from the booking rather than trusting any number in this request.
// ════════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = apiLogger.child({ mod: 'admin-deposit-links' })

const CreateSchema = z.object({
  // A STRING, deliberately: "49.50" typed on a numeric keyboard must not go
  // through a float before the validator sees it.
  amount: z.union([z.string(), z.number()]),
  bookingId: z.string().trim().min(1).optional().nullable(),
  leadId: z.string().trim().min(1).optional().nullable(),
  customerName: z.string().trim().max(120).optional().nullable(),
  customerEmail: z.string().trim().email().max(200).optional().or(z.literal('')).nullable(),
  customerPhone: z.string().trim().max(40).optional().nullable(),
  quoteTotal: z.union([z.string(), z.number()]).optional().nullable(),
  serviceSummary: z.string().trim().max(200).optional().nullable(),
  moveDate: z.string().trim().max(40).optional().nullable(),
  expiresAt: z.string().trim().max(40).optional().nullable(),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  const statusFilter = req.nextUrl.searchParams.get('status')
  const take = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200)

  const rows = await prisma.depositRequest.findMany({
    where: {
      ...(statusFilter && statusFilter !== 'ALL' ? { status: statusFilter as never } : {}),
      ...(q
        ? {
            OR: [
              { customerName: { contains: q, mode: 'insensitive' as const } },
              { customerEmail: { contains: q, mode: 'insensitive' as const } },
              { customerPhone: { contains: q } },
              { publicToken: { contains: q.toUpperCase() } },
              { serviceSummary: { contains: q, mode: 'insensitive' as const } },
              { booking: { bookingReference: { contains: q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true, publicToken: true, status: true, amountCents: true, quoteTotalCents: true,
      balanceBeforeCents: true, amountPaidCents: true, customerName: true, serviceSummary: true,
      moveDate: true, expiresAt: true, paidAt: true, createdAt: true, createdByName: true,
      bookingId: true, discordStatus: true, discordNotifiedAt: true, discordRetryCount: true,
      discordError: true,
      booking: { select: { bookingReference: true, displayId: true } },
    },
  })

  return NextResponse.json({
    notifications: depositNotifyConfig(),
    links: rows.map((r) => ({
      id: r.id,
      publicToken: r.publicToken,
      url: depositUrl(r.publicToken),
      status: effectiveStatus(r),
      amountCents: r.amountCents,
      quoteTotalCents: r.quoteTotalCents,
      amountPaidCents: r.amountPaidCents,
      remainingCents: remainingAfterCents({
        quoteTotalCents: r.quoteTotalCents,
        balanceBeforeCents: r.balanceBeforeCents,
        amountCents: r.amountPaidCents ?? r.amountCents,
      }),
      customerName: r.customerName,
      serviceSummary: r.serviceSummary,
      moveDate: r.moveDate?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdByName,
      bookingId: r.bookingId,
      bookingReference: r.booking?.bookingReference ?? r.booking?.displayId ?? null,
      // NOT_APPLICABLE while unpaid — there is nothing to announce yet, and
      // showing "Pending" for a link nobody paid reads as a stuck notification.
      discordStatus: r.paidAt ? r.discordStatus : 'NOT_APPLICABLE',
      discordNotifiedAt: r.discordNotifiedAt?.toISOString() ?? null,
      discordRetryCount: r.discordRetryCount,
      discordError: r.discordError,
    })),
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.create')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  // THE amount gate. Everything downstream works in the integer cents this
  // returns; no other conversion exists.
  const amount = parseAmountToCents(d.amount)
  if (!amount.ok) return NextResponse.json({ error: amount.error }, { status: 422 })

  let quoteTotalCents: number | null = null
  if (d.quoteTotal != null && d.quoteTotal !== '') {
    const q = parseAmountToCents(d.quoteTotal)
    if (!q.ok) return NextResponse.json({ error: `Quote total: ${q.error}` }, { status: 422 })
    if (q.cents > MAX_DEPOSIT_CENTS * 10) return NextResponse.json({ error: 'Quote total is out of range' }, { status: 422 })
    quoteTotalCents = q.cents
  }

  const expiry = parseExpiry(d.expiresAt ?? null)
  if (!expiry.ok) return NextResponse.json({ error: expiry.error }, { status: 422 })

  let moveDate: Date | null = null
  if (d.moveDate) {
    const parsedDate = new Date(d.moveDate)
    if (Number.isNaN(parsedDate.getTime())) return NextResponse.json({ error: 'Invalid move date' }, { status: 422 })
    moveDate = parsedDate
  }

  const result = await createDepositRequest({
    amountCents: amount.cents,
    bookingId: d.bookingId ?? null,
    leadId: d.leadId ?? null,
    customerName: d.customerName || null,
    customerEmail: d.customerEmail || null,
    customerPhone: d.customerPhone || null,
    quoteTotalCents,
    serviceSummary: d.serviceSummary || null,
    moveDate,
    expiresAt: expiry.at,
    createdById: session.userId,
    createdByName: session.name,
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  log.info({ depositRequestId: result.id, amountCents: amount.cents, by: session.name }, 'deposit link created')

  return NextResponse.json(
    {
      id: result.id,
      publicToken: result.publicToken,
      url: depositUrl(result.publicToken),
      amountCents: amount.cents,
      warning: result.warning ?? null,
      notifications: depositNotifyConfig(),
    },
    { status: 201 }
  )
}
