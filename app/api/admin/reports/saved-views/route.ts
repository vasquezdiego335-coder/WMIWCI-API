import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import { canRunReport, type ReportType } from '@/lib/report-permissions'
import {
  canUseSavedViews, canShareView, validateViewConfig, nameConflict, REPORT_TYPES,
} from '@/lib/saved-view-guards'
import { z } from 'zod'

// P1-3 — saved report views. Stage 3 created saved_report_views and the
// report.save_shared_view permission, then never read or wrote the table.
//
// A saved view stores a report REQUEST — filters, sort, columns — never a
// report RESULT. No SQL, no query objects, no numbers, no customer data, no
// credentials. Opening one re-runs the report under the CURRENT viewer, so a
// view can never show stale money nor figures the viewer's role is denied.

const CreateSchema = z.object({
  reportType: z.enum(REPORT_TYPES as [ReportType, ...ReportType[]]),
  name: z.string().trim().min(1).max(120),
  filters: z.unknown(),
  sortKey: z.string().trim().max(40).nullable().optional(),
  sortDir: z.enum(['asc', 'desc']).nullable().optional(),
  columns: z.array(z.string().trim().max(60)).max(60).optional(),
  shared: z.boolean().optional(),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role
  if (!canUseSavedViews(role)) {
    return NextResponse.json({ error: 'You do not have access to admin reports.' }, { status: 403 })
  }

  const wanted = req.nextUrl.searchParams.get('reportType')

  const rows = await prisma.savedReportView.findMany({
    where: {
      ...(wanted ? { reportType: wanted } : {}),
      OR: [{ createdById: session.userId }, { shared: true }],
    },
    orderBy: [{ shared: 'asc' }, { updatedAt: 'desc' }],
    select: {
      id: true, reportType: true, name: true, periodKey: true, scope: true,
      basis: true, shared: true, sortKey: true, sortDir: true, columns: true,
      createdById: true, createdByName: true, createdAt: true, updatedAt: true,
    },
  })

  // Re-derived per row against THIS viewer, not the author. A shared financial
  // view is invisible to a manager — including its name.
  const visible = rows
    .filter((v) => canRunReport(role, v.reportType as ReportType).allow)
    .map((v) => ({ ...v, mine: v.createdById === session.userId }))

  // An empty list is a legitimate state, not an error.
  return NextResponse.json({ views: visible, count: visible.length })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  // ONE validation path — report type, filters, sort field, columns and the
  // owner-only column rule, all through the live report contract.
  const config = validateViewConfig(role, {
    reportType: d.reportType, filters: d.filters, sortKey: d.sortKey, sortDir: d.sortDir, columns: d.columns,
  })
  if (!config.ok) return NextResponse.json({ error: config.error }, { status: config.status })

  const shared = d.shared ?? false
  if (shared && !canShareView(role)) {
    return NextResponse.json({ error: 'You can save this view for yourself, but not publish it to other users.' }, { status: 403 })
  }

  // Name uniqueness is scoped: your own views for this report, or the shared
  // set if publishing. Your private name may collide with someone else's
  // private name — neither can see the other.
  const siblings = await prisma.savedReportView.findMany({
    where: { reportType: d.reportType, ...(shared ? { shared: true } : { createdById: session.userId, shared: false }) },
    select: { id: true, name: true },
  })
  const dup = nameConflict(d.name, siblings)
  if (!dup.allow) return NextResponse.json({ error: dup.error }, { status: dup.status })

  const view = await prisma.$transaction(async (tx) => {
    const v = await tx.savedReportView.create({
      data: {
        reportType: d.reportType,
        name: d.name,
        filters: config.filters as object,
        sortKey: d.sortKey || null,
        sortDir: d.sortDir || null,
        columns: config.columns,
        periodKey: config.filters.period,
        scope: config.filters.scope,
        basis: config.filters.basis,
        shared,
        createdById: session.userId,
        createdByName: session.name,
      },
      select: { id: true, reportType: true, name: true, shared: true, createdAt: true, updatedAt: true },
    })
    // Audit records the SHAPE of the view, never report content.
    await tx.auditLog.create({
      data: {
        action: 'SAVED_VIEW_CREATED',
        userId: session.userId,
        details: {
          savedViewId: v.id, reportType: v.reportType, name: v.name, shared,
          periodKey: config.filters.period, basis: config.filters.basis, scope: config.filters.scope,
          by: session.name,
        },
      },
    })
    if (shared) {
      await tx.auditLog.create({
        data: {
          action: 'SAVED_VIEW_SHARED',
          userId: session.userId,
          details: { savedViewId: v.id, reportType: v.reportType, name: v.name, from: false, to: true, by: session.name },
        },
      })
    }
    return v
  })

  apiLogger.info({ viewId: view.id, reportType: view.reportType, shared }, 'Saved report view created')
  return NextResponse.json({ view, droppedColumns: config.droppedColumns }, { status: 201 })
}
