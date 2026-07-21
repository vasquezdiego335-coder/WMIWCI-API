import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { z } from 'zod'

// Business configuration — ownership split + cash reserves (owner spec
// 2026-07-13). Single 'singleton' row. Owner-only: it governs owner
// distributions. dollarsToCents on the client keeps emergencyReserve in cents.

const Schema = z.object({
  diegoSplitPercent: z.number().int().min(0).max(100).optional(),
  sebastianSplitPercent: z.number().int().min(0).max(100).optional(),
  taxReservePercent: z.number().int().min(0).max(100).optional(),
  emergencyReserveCents: z.number().int().min(0).max(100_000_000_00).optional(),
  // ── Stage 4 (D6 + D4). Both were unreachable from the admin, so the owner
  //    could not configure the two values the closeout depends on. ──
  /** What an OWNER hour is worth if it had to be hired. Drives ECONOMIC profit
   *  only — never cash, never a payable, and separate from the 30% profit
   *  allocations. 0 is a valid state meaning "not configured"; it is NOT a
   *  claim that owner labor is free. */
  ownerEconomicRateCents: z.number().int().min(0).max(1_000_00).optional(),
  /** The company-retained share of final net profit, in basis points.
   *  Owner policy 2026-07-21 = 4000 (40%). */
  generalReserveBp: z.number().int().min(0).max(10_000).optional(),
})

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || session.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only an owner can change business settings' }, { status: 403 })
  }

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  if (d.diegoSplitPercent != null && d.sebastianSplitPercent != null && d.diegoSplitPercent + d.sebastianSplitPercent !== 100) {
    return NextResponse.json({ error: 'Diego + Sebastian split must total 100%' }, { status: 422 })
  }

  // The owner split divides what REMAINS after the retained share, so the two
  // together must still leave the owners something. Retaining 100% is a
  // configuration mistake, not a policy.
  if (d.generalReserveBp != null && d.generalReserveBp >= 10_000) {
    return NextResponse.json(
      { error: 'The business cannot retain 100% of profit — that would leave nothing to allocate to either owner.' },
      { status: 422 },
    )
  }

  const config = await prisma.businessConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...d },
    update: d,
  })

  await prisma.auditLog.create({
    // Record the VALUES, not just which keys moved: a labor-rate or
    // profit-policy change must be reconstructable from the audit log alone.
    data: { action: 'BUSINESS_CONFIG_UPDATED', userId: session.userId, details: { changed: Object.keys(d), values: d, by: session.name } },
  })
  apiLogger.info({ changed: Object.keys(d) }, 'Business config updated')
  return NextResponse.json(config)
}
