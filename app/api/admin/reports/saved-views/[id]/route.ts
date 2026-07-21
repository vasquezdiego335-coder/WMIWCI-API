import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import {
  canLoadView, canMutateView, canShareView, parseStoredFilters, validateViewConfig, nameConflict,
} from '@/lib/saved-view-guards'
import { z } from 'zod'

// P1-3 — open, re-filter, rename, share/unshare, or delete one saved view.
//
// GET returns the stored REQUEST, never stored numbers: the caller re-runs the
// report with them through the normal reporting contract.

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  filters: z.unknown().optional(),
  sortKey: z.string().trim().max(40).nullable().optional(),
  sortDir: z.enum(['asc', 'desc']).nullable().optional(),
  columns: z.array(z.string().trim().max(60)).max(60).optional(),
  shared: z.boolean().optional(),
})

export async function GET(_req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const view = await prisma.savedReportView.findUnique({ where: { id: ctx.params.id } })
  if (!view) return NextResponse.json({ error: 'View not found.' }, { status: 404 })

  const gate = canLoadView(session.role as Role, view, session.userId)
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Stored JSON is untrusted on the way out too. Degrade with an explanation
  // rather than 500-ing on a view saved before a filter was removed.
  const filters = parseStoredFilters(view.filters)
  if (!filters.ok) {
    return NextResponse.json({ error: filters.error, viewId: view.id, stale: true }, { status: 422 })
  }

  return NextResponse.json({
    view: {
      id: view.id, reportType: view.reportType, name: view.name,
      sortKey: view.sortKey, sortDir: view.sortDir, columns: view.columns,
      shared: view.shared, createdByName: view.createdByName,
      createdAt: view.createdAt, updatedAt: view.updatedAt,
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

  // Seeing a shared view never confers the right to change it.
  const mutate = canMutateView(role, view, session.userId)
  if (!mutate.allow) return NextResponse.json({ error: mutate.error }, { status: mutate.status })

  // Re-validate the WHOLE resulting configuration, not just the changed part —
  // a new sort field must be legal against the report, and a manager must not
  // be able to add an owner-only column to an existing view.
  const nextFilters = d.filters !== undefined ? d.filters : view.filters
  const nextSortKey = d.sortKey !== undefined ? d.sortKey : view.sortKey
  const nextSortDir = d.sortDir !== undefined ? d.sortDir : view.sortDir
  const nextColumns = d.columns !== undefined ? d.columns : view.columns

  const config = validateViewConfig(role, {
    reportType: view.reportType, filters: nextFilters, sortKey: nextSortKey, sortDir: nextSortDir, columns: nextColumns,
  })
  if (!config.ok) return NextResponse.json({ error: config.error }, { status: config.status })

  const nextShared = d.shared !== undefined ? d.shared : view.shared
  if (nextShared && !view.shared && !canShareView(role)) {
    return NextResponse.json({ error: 'You do not have permission to publish a view to other users.' }, { status: 403 })
  }

  if (d.name !== undefined && d.name.trim().toLowerCase() !== view.name.trim().toLowerCase()) {
    const siblings = await prisma.savedReportView.findMany({
      where: { reportType: view.reportType, ...(nextShared ? { shared: true } : { createdById: view.createdById, shared: false }) },
      select: { id: true, name: true },
    })
    const dup = nameConflict(d.name, siblings, view.id)
    if (!dup.allow) return NextResponse.json({ error: dup.error }, { status: dup.status })
  }

  const renamed = d.name !== undefined && d.name !== view.name
  const shareChanged = d.shared !== undefined && d.shared !== view.shared
  const filtersChanged = d.filters !== undefined || d.sortKey !== undefined || d.sortDir !== undefined || d.columns !== undefined

  if (!renamed && !shareChanged && !filtersChanged) {
    return NextResponse.json({ view, changed: false, note: 'No changes applied.' })
  }

  const updated = await prisma.$transaction(async (tx) => {
    const v = await tx.savedReportView.update({
      where: { id: view.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.shared !== undefined ? { shared: d.shared } : {}),
        ...(filtersChanged
          ? {
              filters: config.filters as object,
              sortKey: nextSortKey || null,
              sortDir: nextSortDir || null,
              columns: config.columns,
              periodKey: config.filters.period,
              scope: config.filters.scope,
              basis: config.filters.basis,
            }
          : {}),
      },
      select: { id: true, reportType: true, name: true, shared: true, sortKey: true, sortDir: true, columns: true, updatedAt: true },
    })

    const base = { savedViewId: v.id, reportType: v.reportType, by: session.name }

    if (renamed) {
      await tx.auditLog.create({
        data: { action: 'SAVED_VIEW_RENAMED', userId: session.userId, details: { ...base, from: view.name, to: v.name } },
      })
    }
    if (shareChanged) {
      await tx.auditLog.create({
        data: {
          action: d.shared ? 'SAVED_VIEW_SHARED' : 'SAVED_VIEW_UNSHARED',
          userId: session.userId,
          details: { ...base, name: v.name, from: view.shared, to: v.shared },
        },
      })
    }
    if (filtersChanged) {
      // The SHAPE of the change, never report content.
      await tx.auditLog.create({
        data: {
          action: 'SAVED_VIEW_UPDATED',
          userId: session.userId,
          details: {
            ...base, name: v.name,
            from: { periodKey: view.periodKey, basis: view.basis, scope: view.scope, sortKey: view.sortKey, sortDir: view.sortDir, columnCount: view.columns.length },
            to: { periodKey: config.filters.period, basis: config.filters.basis, scope: config.filters.scope, sortKey: v.sortKey, sortDir: v.sortDir, columnCount: v.columns.length },
          },
        },
      })
    }
    return v
  })

  apiLogger.info({ viewId: updated.id, renamed, shareChanged, filtersChanged }, 'Saved report view updated')
  return NextResponse.json({ view: updated, changed: true, droppedColumns: config.droppedColumns })
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const view = await prisma.savedReportView.findUnique({
    where: { id: ctx.params.id },
    select: { id: true, name: true, reportType: true, shared: true, createdById: true },
  })
  if (!view) return NextResponse.json({ error: 'View not found.' }, { status: 404 })

  const load = canLoadView(role, view, session.userId)
  if (!load.allow) return NextResponse.json({ error: load.error }, { status: load.status })

  const gate = canMutateView(role, view, session.userId)
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // HARD DELETE, deliberately. The spec prefers archival "if the existing model
  // supports it" — SavedReportView has no archivedAt column, and adding one is
  // a schema change on top of a migration that is not yet applied anywhere.
  // A saved view holds no financial record: it is a stored query, fully
  // rebuildable from the report screen. The audit row below preserves that it
  // existed, who removed it, and what it pointed at.
  await prisma.$transaction(async (tx) => {
    await tx.savedReportView.delete({ where: { id: view.id } })
    await tx.auditLog.create({
      data: {
        action: 'SAVED_VIEW_DELETED',
        userId: session.userId,
        details: { savedViewId: view.id, reportType: view.reportType, name: view.name, wasShared: view.shared, by: session.name },
      },
    })
  })

  apiLogger.info({ viewId: view.id, reportType: view.reportType }, 'Saved report view deleted')
  return NextResponse.json({ deleted: true, id: view.id })
}
