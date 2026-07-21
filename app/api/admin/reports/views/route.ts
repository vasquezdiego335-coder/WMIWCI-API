import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { canRunReport, REPORT_ACCESS, REPORT_COLUMNS, type ReportType } from '@/lib/report-permissions'
import { canSaveView, canShareView, sanitizeColumns } from '@/lib/saved-view-guards'
import { ReportQuerySchema } from '@/lib/reporting-filters'
import { z } from 'zod'

// P1-3 — saved report views. Stage 3 created saved_report_views and the
// report.save_shared_view permission and then never read or wrote the table.
//
// A saved view is a stored report REQUEST, never a stored report RESULT: it
// holds filters, not numbers. Opening it re-runs the report under the current
// viewer's permissions, so a view can never become a way to see figures your
// role is denied — and can never show stale money.

const REPORT_TYPES = Object.keys(REPORT_ACCESS) as ReportType[]

const CreateSchema = z.object({
  reportType: z.enum(REPORT_TYPES as [ReportType, ...ReportType[]]),
  name: z.string().trim().min(1).max(120),
  filters: z.unknown(),
  sortKey: z.string().trim().max(40).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  columns: z.array(z.string().trim().max(60)).max(60).optional(),
  periodKey: z.string().trim().max(40).optional(),
  scope: z.string().trim().max(40).optional(),
  basis: z.string().trim().max(20).optional(),
  shared: z.boolean().optional(),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const wanted = req.nextUrl.searchParams.get('reportType')

  const rows = await prisma.savedReportView.findMany({
    where: {
      ...(wanted ? { reportType: wanted } : {}),
      // Your own views, plus anything published to everyone.
      OR: [{ createdById: session.userId }, { shared: true }],
    },
    orderBy: [{ shared: 'asc' }, { updatedAt: 'desc' }],
    select: {
      id: true, reportType: true, name: true, periodKey: true, scope: true,
      basis: true, shared: true, sortKey: true, sortDir: true, columns: true,
      createdById: true, createdByName: true, createdAt: true, updatedAt: true,
    },
  })

  // Authorization is re-derived per row against THIS viewer, not the author.
  // A shared financial view is invisible to a manager — including its name.
  const visible = rows.filter((v) => canRunReport(role, v.reportType as ReportType).allow)

  return NextResponse.json({
    views: visible.map((v) => ({ ...v, mine: v.createdById === session.userId })),
  })
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

  const gate = canSaveView(role, d.reportType)
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Filters go through the SAME schema the live report uses, so a saved view
  // can never carry a query shape the report route would itself reject.
  const filters = ReportQuerySchema.safeParse(d.filters ?? {})
  if (!filters.success) {
    return NextResponse.json({ error: 'Those filters are not valid for this report.', issues: filters.error.flatten() }, { status: 422 })
  }

  const shared = d.shared ?? false
  if (shared && !canShareView(role)) {
    return NextResponse.json({ error: 'You can save this view for yourself, but not publish it to other users.' }, { status: 403 })
  }

  const allowedColumns = (REPORT_COLUMNS[d.reportType] ?? []).map((c) => c.key)
  const columns = sanitizeColumns(d.columns ?? [], allowedColumns)

  const view = await prisma.savedReportView.create({
    data: {
      reportType: d.reportType,
      name: d.name,
      filters: filters.data as object,
      sortKey: d.sortKey || null,
      sortDir: d.sortDir || null,
      columns,
      periodKey: filters.data.period ?? d.periodKey ?? null,
      scope: filters.data.scope ?? d.scope ?? null,
      basis: filters.data.basis ?? d.basis ?? null,
      shared,
      createdById: session.userId,
      createdByName: session.name,
    },
    select: { id: true, reportType: true, name: true, shared: true, createdAt: true },
  })

  apiLogger.info({ viewId: view.id, reportType: view.reportType, shared }, 'Saved report view created')
  return NextResponse.json({ view, droppedColumns: (d.columns ?? []).filter((c) => !columns.includes(c)) }, { status: 201 })
}
