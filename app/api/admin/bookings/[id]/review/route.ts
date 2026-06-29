import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { recordReviewAndMaybeReferral } from '@/lib/followups'
import { z } from 'zod'

// Record a customer review for a completed move (Phase 3). There is no Google
// review webhook, so reviews are captured first-party by staff. A positive
// review (rating >= 4) schedules exactly one referral ask (deduped by the
// follow-up ledger against the day-5 fallback).
const ReviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  source: z.enum(['admin', 'discord', 'customer-portal']).optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({ where: { id: params.id } })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = ReviewSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 422 })
  }

  try {
    const review = await recordReviewAndMaybeReferral({
      bookingId: params.id,
      rating: parsed.data.rating,
      comment: parsed.data.comment,
      source: parsed.data.source ?? 'admin',
    })
    return NextResponse.json({ ok: true, ...review })
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'record review failed')
    return NextResponse.json({ error: 'Failed to record review' }, { status: 500 })
  }
}
