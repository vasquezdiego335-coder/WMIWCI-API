import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import { parseReportRequest, buildReportMetadata, dataStateFor, DATA_STATE_MESSAGE } from '@/lib/reporting-filters'
import { canRunReport, shapeForRole, type ReportType } from '@/lib/report-permissions'
import { buildReport, REPORT_TYPES } from '@/lib/report-builders'

// ════════════════════════════════════════════════════════════════════════════
//  Reporting API (Stage 3B, owner spec 2026-07-20).
//    GET /api/admin/reports/[report]
//
//  Every response carries a `meta` block declaring accounting basis, reporting
//  mode, timezone, period bounds and the finalized/provisional counts — so the
//  frontend NEVER has to guess whether a number is final.
//
//  Nothing here trusts the client: the role comes from the session, filters are
//  validated by Zod, and owner-only money is stripped from the response body
//  before it is serialized.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { report: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const report = params.report as ReportType
  if (!REPORT_TYPES.includes(report)) {
    return NextResponse.json({ error: 'Unknown report.' }, { status: 404 })
  }

  // Role comes from the SESSION, never from the request.
  const role = session.role as Role
  const access = canRunReport(role, report)
  if (!access.allow) return NextResponse.json({ error: access.error }, { status: access.status })

  const parsed = parseReportRequest(req.nextUrl.searchParams)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: parsed.status })

  try {
    const built = await buildReport(report, parsed.request, role)
    const meta = buildReportMetadata(parsed.request, built.counts, built.warnings)
    const state = dataStateFor(built.counts, parsed.request.scope)

    return NextResponse.json({
      meta,
      dataState: state,
      // "$0.00" and "no verified data" must never look the same.
      dataStateMessage: DATA_STATE_MESSAGE[state] || null,
      data: shapeForRole(built.data, role),
      page: built.page ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    apiLogger.error({ report, err: message }, 'Report failed')
    // A failed report must not render as zeros.
    return NextResponse.json(
      { error: 'This report could not be calculated right now.', dataState: 'UNAVAILABLE', detail: message.slice(0, 300) },
      { status: 503 },
    )
  }
}
