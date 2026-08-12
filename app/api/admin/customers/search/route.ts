import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'

// Moving OS Phase 1 — customer search for the Book Move workspace (owner spec
// 2026-08-11). Search-as-you-type: ?q= matches name/email/phone (contains,
// case-insensitive), take 8. Picking a result fills the customer fields so a
// returning customer is never re-typed (and never duplicated by a typo'd
// email). Read-only; gated by the same permission as the create it feeds.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'booking.create_admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ customers: [] })

  try {
    const customers = await prisma.customer.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        locale: true,
        _count: { select: { bookings: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    })
    return NextResponse.json({
      customers: customers.map((c) => ({
        id: c.id,
        name: c.name,
        // A synthesized placeholder (phone-only customer) is an internal
        // artifact — never offer it back as a real address to book with.
        email: c.email.endsWith('@placeholder.invalid') ? null : c.email,
        phone: c.phone,
        locale: c.locale,
        bookings: c._count.bookings,
      })),
    })
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Customer search failed')
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
