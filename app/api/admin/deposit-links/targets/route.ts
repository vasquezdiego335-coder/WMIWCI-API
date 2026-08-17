import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from '@/lib/job-money'

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/admin/deposit-links/targets?q=
//  ------------------------------------------------------------------------
//  The booking / lead picker on the mobile form. Returns the few live bookings
//  and leads matching what the owner typed, each carrying its CURRENT unpaid
//  balance so the form can pre-fill honestly and warn before a link is minted.
//
//  Balances come from `customerBalance()` — the one formula — not from a fee
//  column sum in this file.
// ════════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  const like = { contains: q, mode: 'insensitive' as const }

  const bookings = await prisma.booking.findMany({
    where: {
      // An internal test booking is never a real customer to bill.
      isInternalTest: false,
      status: { notIn: ['CANCELLED', 'ARCHIVED'] },
      ...(q
        ? {
            OR: [
              { bookingReference: like },
              { displayId: like },
              { customer: { name: like } },
              { customer: { email: like } },
              { customer: { phone: { contains: q } } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: q ? 15 : 8,
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      payments: { select: JOB_MONEY_PAYMENT_SELECT },
    },
  })

  const leads = q
    ? await prisma.lead.findMany({
        where: {
          status: { notIn: ['LOST', 'BOOKED'] },
          OR: [{ name: like }, { email: like }, { phone: { contains: q } }],
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, name: true, email: true, phone: true, moveDate: true, estimatedValue: true, jobType: true },
      })
    : []

  return NextResponse.json({
    bookings: bookings.map((b) => {
      const bal = customerBalance(b as never)
      return {
        id: b.id,
        reference: b.bookingReference ?? b.displayId,
        customerName: b.customer?.name ?? '',
        customerEmail: b.customer?.email ?? null,
        customerPhone: b.customer?.phone ?? null,
        status: b.status,
        moveDate: b.requestedDate?.toISOString() ?? null,
        quoteTotalCents: bal.quoteMissing ? null : bal.finalBilledCents,
        unpaidBalanceCents: bal.quoteMissing ? null : bal.outstandingCents,
        quoteMissing: bal.quoteMissing,
        // Surfaced so the owner can SEE an existing $49 hold before adding a
        // deposit on top of it — the double-collection they would otherwise
        // only discover from the customer.
        authorizedNotCapturedCents: bal.authorizedNotCapturedCents,
      }
    }),
    leads: leads.map((l) => ({
      id: l.id,
      customerName: l.name,
      customerEmail: l.email,
      customerPhone: l.phone,
      moveDate: l.moveDate?.toISOString() ?? null,
      quoteTotalCents: l.estimatedValue ?? null,
      jobType: l.jobType,
    })),
  })
}
