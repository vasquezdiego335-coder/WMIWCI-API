import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { normalizeBookingReference } from '@/lib/booking-reference'

const QuerySchema = z.object({
  status: z.string().optional(),
  crew: z.string().optional(),
  customer: z.string().optional(),
  date: z.string().optional(),
  page: z.string().default('1'),
  limit: z.string().default('20'),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = req.nextUrl
  const q = QuerySchema.parse(Object.fromEntries(searchParams.entries()))

  const page = parseInt(q.page, 10)
  const limit = Math.min(parseInt(q.limit, 10), 100)
  const skip = (page - 1) * limit

  // Build where clause
  const where: any = {}
  if (q.status) where.status = q.status
  if (q.customer) {
    // One search box → matches customer name/email/phone, the public reference
    // (WMIC-####, with or without dash/case/prefix), the legacy display id, and
    // the internal cuid. Reference match is exact; a bare number like "1042" is
    // normalised to WMIC-1042 before lookup.
    const term = q.customer.trim()
    const ref = normalizeBookingReference(term)
    const or: any[] = [
      { customer: { name: { contains: term, mode: 'insensitive' } } },
      { customer: { email: { contains: term, mode: 'insensitive' } } },
      { customer: { phone: { contains: term } } },
      { displayId: { equals: term } },
      { id: { equals: term } },
    ]
    if (ref) {
      or.push({ bookingReference: { equals: ref } }, { displayId: { equals: ref } })
    } else if (/wmic/i.test(term)) {
      or.push({ bookingReference: { contains: term.toUpperCase() } })
    }
    where.OR = or
  }
  if (q.date) {
    const d = new Date(q.date)
    const start = new Date(d); start.setHours(0, 0, 0, 0)
    const end = new Date(d); end.setHours(23, 59, 59, 999)
    where.scheduledStart = { gte: start, lte: end }
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        payments: { select: { status: true, amount: true } },
        job: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.booking.count({ where }),
  ])

  return NextResponse.json({
    bookings,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
}
