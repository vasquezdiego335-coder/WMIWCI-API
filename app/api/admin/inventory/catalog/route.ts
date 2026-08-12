import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { ensureCatalogSeeded } from '@/lib/inventory-catalog'

// Moving OS Phase 1 — inventory catalog search (owner spec 2026-08-11).
// Feeds the Book Move inventory picker: ?q= → active items, name contains
// (case-insensitive), take 10. Seeding is LAZY: the first request on an
// applied-migration database inserts the ~40 default items (createMany
// skipDuplicates — idempotent, never touches owner-edited rows). An unapplied
// database fails SOFT: { items: [], migrationMissing: true } so the picker
// degrades to custom-item entry instead of crashing the workspace.

/** Unapplied-migration signature (house detection from /api/admin/trucks). */
function isTableMissing(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  return code === 'P2021' || /does not exist/i.test(msg)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'booking.create_admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()

  try {
    await ensureCatalogSeeded(prisma)
    const items = await prisma.inventoryCatalogItem.findMany({
      where: {
        active: true,
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true,
        name: true,
        category: true,
        isHeavy: true,
        needsDisassembly: true,
        recommendedMovers: true,
      },
      orderBy: { name: 'asc' },
      take: 10,
    })
    return NextResponse.json({ items })
  } catch (err) {
    if (isTableMissing(err)) {
      return NextResponse.json({
        items: [],
        migrationMissing: true,
        error: 'Inventory catalog table missing — migration 20260811000000_moving_os_phase1 not applied',
      })
    }
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Inventory catalog search failed')
    return NextResponse.json({ error: 'Catalog search failed' }, { status: 500 })
  }
}
