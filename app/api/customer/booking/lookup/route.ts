import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET /api/customer/booking/lookup?email=...
//
// Returns the customer portal token for the most recent non-archived booking
// belonging to the given email. The customer uses this to access their
// self-service portal at /my-booking/{token}.
//
// Returns 404 with a generic message if no booking is found — we never confirm
// or deny whether an email exists in the system (privacy).

export async function GET(req: NextRequest): Promise<NextResponse> {
  const email = req.nextUrl.searchParams.get('email')?.trim().toLowerCase()

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  // Find the most recent active booking for this email
  const booking = await prisma.booking.findFirst({
    where: {
      customer: { email },
      customerTokenExpiry: { gte: new Date() },
      status: { notIn: ['ARCHIVED', 'CANCELLED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { customerToken: true },
  })

  if (!booking) {
    return NextResponse.json(
      { error: 'No active booking found for that email address.' },
      { status: 404 }
    )
  }

  return NextResponse.json({ token: booking.customerToken })
}
