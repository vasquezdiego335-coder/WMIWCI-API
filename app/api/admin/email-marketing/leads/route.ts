// LEADS LIST for the quote-recovery workflow (owner spec 2026-07-22).
//
// The quote trigger (leads/[id]/quote) existed but required a hand-crafted API
// call — no admin surface listed the leads it applies to, so in normal use it
// could never fire. This GET is that surface's data source: the OPEN leads
// (source of truth: the Lead table, written by every public inquiry path via
// leads.createOrUpdateLead — website contact form, coupon popup, "not sure"
// bookings, marketing tracker; Discord only ever mirrors it), with their
// quote/recovery state, so an owner can mark a real quote given from where
// they actually work the pipeline.

import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { denyReason, type Role } from '@/lib/permissions'

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_journey')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  try {
    const leads = await prisma.lead.findMany({
      where: { status: { in: ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP'] } },
      orderBy: { lastActivityAt: 'desc' },
      take: 200,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        source: true,
        jobType: true,
        moveDate: true,
        quotedAt: true,
        estimatedValue: true,
        createdAt: true,
        lastActivityAt: true,
      },
    })
    return NextResponse.json({ leads })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 })
  }
}
