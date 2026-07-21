import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import { canLoadView, canDeleteView, canShareView, parseStoredFilters } from '@/lib/saved-view-guards'
import { z } from 'zod'

// P1-3 — open, rename/share, or delete one saved view.
//
// GET returns the stored REQUEST (filters), never stored numbers: the caller
// re-runs the report with them, so a view can never show stale money or reveal
// figures the current viewer is not allowed to see.

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  shared: z.boolean().optional(),
})

export async function GET(_req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const view = await prisma.savedReportView.findUnique({ where: { id: ctx.params.id } })
  if (!view) return NextResponse.json({ error: 'View not found.' }, { status: 404 })

  // Re-authorized against THIS viewer. A denied view reports 404, not 403 —
  // the existence of an owner's saved financial view is itself information.
  const gate = canLoadView(session.role as Role, view, session.userId)
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Stored JSON is not trusted: a view saved months ago may reference a filter
  // that no longer exists. Degrade with an explanation instead of 500-ing.
  const filters = parseStoredFilters(view.filters)
  if (!filters.ok) {
    return NextResponse.json({ error: filters.error, viewId: view.id, stale: true }, { status: 422 })
  }

  return NextResponse.json({
    view: {
      id: view.id, reportType: view.reportType, name: view.name,
      sortKey: view.sortKey, sortDir: view.sortDir, columns: view.columns,
      shared: view.shared, createdByName: view.createdByName,
      mine: view.createdById === session.userId,
    },
    filters: filters.filters,
  })
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const view = await prisma.savedReportView.findUnique({ where: { id: ctx.params.id } })
  if (!view) return NextResponse.json({ error: 'View not found.' }, { status: 404 })

  const load = canLoadView(role, view, session.userId)
  if (!load.allow) return NextResponse.json({ error: load.error }, { status: load.status })

  // Editing is authorship, not visibility: seeing a shared view does not let
  // you rename or unshare someone else's.
  const own = canDeleteView(role, view, session.userId)
  if (!own.allow) return NextResponse.json({ error: 'Only the person who saved this view, or an owner, can change it.' }, { status: 403 })

  if (d.shared === true && !view.shared && !canShareView(role)) {
    return NextResponse.json({ error: 'You do not have permission to publish a view to other users.' }, { status: 403 })
  }

  const updated = await prisma.savedReportView.update({
    where: { id: view.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.shared !== undefined ? { shared: d.shared } : {}),
    },
    select: { id: true, name: true, shared: true, reportType: true },
  })

  apiLogger.info({ viewId: updated.id, shared: updated.shared }, 'Saved report view updated')
  return NextResponse.json({ view: updated })
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const view = await prisma.savedReportView.findUnique({
    where: { id: ctx.params.id },
    select: { id: true, name: true, reportType: true, shared: true, createdById: true },
  })
  if (!view) return NextResponse.json({ error: 'View not found.' }, { status: 404 })

  const load = canLoadView(session.role as Role, view, session.userId)
  if (!load.allow) return NextResponse.json({ error: load.error }, { status: load.status })

  const gate = canDeleteView(session.role as Role, view, session.userId)
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // A saved view holds no financial record — it is a stored query. Deleting it
  // destroys nothing that cannot be rebuilt, so no audit row is written.
  await prisma.savedReportView.delete({ where: { id: view.id } })

  apiLogger.info({ viewId: view.id, reportType: view.reportType }, 'Saved report view deleted')
  return NextResponse.json({ deleted: true, id: view.id })
}
