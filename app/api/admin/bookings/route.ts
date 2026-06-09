import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

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
    where.customer = {
      OR: [
        { name: { contains: q.customer, mode: 'insensitive' } },
        { email: { contains: q.customer, mode: 'insensitive' } },
        { phone: { contains: q.customer } },
      ],
    }
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
