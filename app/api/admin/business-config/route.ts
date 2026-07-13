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

  const config = await prisma.businessConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...d },
    update: d,
  })

  await prisma.auditLog.create({
    data: { action: 'BUSINESS_CONFIG_UPDATED', userId: session.userId, details: { changed: Object.keys(d), by: session.name } },
  })
  apiLogger.info({ changed: Object.keys(d) }, 'Business config updated')
  return NextResponse.json(config)
}
