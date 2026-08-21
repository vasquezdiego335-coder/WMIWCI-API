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
  formatMoveWhenEn,
  cleanCustomerText,
  parseMoveDetails,
  MAX_DEPOSIT_CENTS,
  MAX_SERVICE_SUMMARY_LEN,
  MAX_CUSTOMER_NOTE_LEN,
} from '@/lib/deposit-links'
import { parseCalendarDate, parseMoveTime } from '@/lib/move-date'
import { createDepositRequest, isMissingColumnError } from '@/lib/deposit-service'
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
  // ── The job text, split by AUDIENCE ──
  // `serviceSummary`, `moveDetails` and `customerNote` are shown to the
  // CUSTOMER. `internalNote` is not, and there is no code path below that lets
  // one become the other.
  serviceSummary: z.string().trim().max(200).optional().nullable(),
  moveDetails: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  customerNote: z.string().trim().max(300).optional().nullable(),
  internalNote: z.string().trim().max(2000).optional().nullable(),
  // A CALENDAR DATE ("2026-08-22") and, separately, a wall-clock time
  // ("07:00"). They are never combined into one timestamp — see move-date.ts.
  moveDate: z.string().trim().max(40).optional().nullable(),
  moveTime: z.string().trim().max(20).optional().nullable(),
  // The DEPOSIT LINK's expiry. Unrelated to the move date, and the two are
  // deliberately far apart in this schema for the same reason they are now far
  // apart in the form: they were being confused.
  expiresAt: z.string().trim().max(40).optional().nullable(),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  const statusFilter = req.nextUrl.searchParams.get('status')
  const take = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200)

  const where = {
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
  }

  // The new-schema columns are split out so the whole list still loads if the
  // production database has not had migration 20260820120000 applied yet — this
  // repo does not run migrations at build time, so new code can briefly run
  // against the old schema. Without the fallback the entire Deposit Links admin
  // page would 500 in that window; with it, it degrades to "no move time /
  // details / notes" and every existing link and payment is still visible.
  const NEW_COLS = { moveDetails: true, customerNote: true, internalNote: true, moveTimeMinutes: true } as const
  const BASE_COLS = {
    id: true, publicToken: true, status: true, amountCents: true, quoteTotalCents: true,
    balanceBeforeCents: true, amountPaidCents: true, customerName: true, serviceSummary: true,
    moveDate: true, expiresAt: true, paidAt: true, createdAt: true, createdByName: true,
    bookingId: true, discordStatus: true, discordNotifiedAt: true, discordRetryCount: true,
    discordError: true,
    booking: { select: { bookingReference: true, displayId: true } },
  } as const

  let rows
  try {
    rows = await prisma.depositRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take,
      select: { ...BASE_COLS, ...NEW_COLS },
    })
  } catch (err) {
    if (!isMissingColumnError(err)) throw err
    log.warn('deposit_requests is missing the new columns — listing without them (run prisma migrate deploy)')
    const legacy = await prisma.depositRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take, select: BASE_COLS,
    })
    rows = legacy.map((r) => ({ ...r, moveDetails: [] as string[], customerNote: null, internalNote: null, moveTimeMinutes: null }))
  }

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
      moveDetails: r.moveDetails ?? [],
      customerNote: r.customerNote,
      // ADMIN-ONLY. This route is behind an OWNER/MANAGER session and the
      // `deposit.view` permission; the PUBLIC page's projection
      // (app/deposit/[token]/page.tsx PUBLIC_SELECT) does not list this column
      // at all, so it cannot reach a customer.
      internalNote: r.internalNote,
      moveDate: r.moveDate?.toISOString() ?? null,
      moveTimeMinutes: r.moveTimeMinutes,
      // Pre-rendered by the ONE safe formatter, so the owner's list can never
      // disagree with the customer's page about which day the move is.
      moveWhenLabel: formatMoveWhenEn(r.moveDate, r.moveTimeMinutes),
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

  // A CALENDAR DATE, anchored at noon UTC. `new Date(d.moveDate)` used to be
  // here: it parses "2026-08-22" as midnight UTC, which reads back as the 21st
  // in Eastern and is the reason a customer was shown the day before their move.
  // parseCalendarDate also rejects impossible dates (Feb 31, Feb 29 in a
  // non-leap year) that Date silently rolls over into the next month.
  let moveDate: Date | null = null
  if (d.moveDate) {
    moveDate = parseCalendarDate(d.moveDate)
    if (!moveDate) return NextResponse.json({ error: 'Invalid move date' }, { status: 422 })
  }

  // The move TIME is stored on its own, as minutes after midnight Eastern —
  // never folded into the timestamp above, where a timezone could move it.
  let moveTimeMinutes: number | null = null
  if (d.moveTime) {
    moveTimeMinutes = parseMoveTime(d.moveTime)
    if (moveTimeMinutes == null) return NextResponse.json({ error: 'Invalid move time' }, { status: 422 })
  }
  // A time with no date is a time for nothing. Refuse it rather than store an
  // orphan the page can never render.
  if (moveTimeMinutes != null && !moveDate) {
    return NextResponse.json({ error: 'Add a move date before a move time' }, { status: 422 })
  }

  const result = await createDepositRequest({
    amountCents: amount.cents,
    bookingId: d.bookingId ?? null,
    leadId: d.leadId ?? null,
    customerName: d.customerName || null,
    customerEmail: d.customerEmail || null,
    customerPhone: d.customerPhone || null,
    quoteTotalCents,
    // CUSTOMER-FACING, and normalised here so a paste out of Messenger cannot
    // put newlines or control bytes into the layout.
    serviceSummary: cleanCustomerText(d.serviceSummary, MAX_SERVICE_SUMMARY_LEN),
    moveDetails: parseMoveDetails(d.moveDetails),
    customerNote: cleanCustomerText(d.customerNote, MAX_CUSTOMER_NOTE_LEN),
    // PRIVATE. Kept verbatim (newlines and all) because the crew reads it in the
    // admin, and it is never selected by the public page's projection.
    internalNote: d.internalNote?.trim() || null,
    moveDate,
    moveTimeMinutes,
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
