import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import { parseReportRequest, buildReportMetadata } from '@/lib/reporting-filters'
import { canExportReport, REPORT_COLUMNS, type ReportType } from '@/lib/report-permissions'
import { buildReport, REPORT_TYPES } from '@/lib/report-builders'
import {
  canExport, toCsv, toXlsxXml, toPdf, exportFilename, contentTypeFor,
  buildExportAudit, type ExportFormat, type ExportMeta,
} from '@/lib/export-service'

// ════════════════════════════════════════════════════════════════════════════
//  Report export (Stage 3B).
//    GET /api/admin/reports/export?report=moves&format=CSV&period=this_month
//
//  Uses the SAME builder as the on-screen report, so an exported total can never
//  disagree with what the owner just looked at.
//
//  Three protections, all server-side:
//   1. Permission — sensitive exports (anything containing profit or pay) are
//      owner-only even when the on-screen report is not.
//   2. Columns — allow-listed per report and filtered by role before any cell
//      is written.
//   3. Formula injection — every cell is neutralized losslessly by
//      export-service.sanitizeCell.
//
//  Every attempt is audited (shape only, never contents).
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

const BUSINESS_NAME = 'Move It Clear It'

const TITLES: Record<ReportType, string> = {
  overview: 'Reporting overview',
  'profit-loss': 'Profit and loss',
  moves: 'Move profitability',
  'revenue-profit': 'Revenue versus profit',
  variance: 'Estimate versus actual',
  marketing: 'Marketing profitability',
  customers: 'Customer profitability',
  pricing: 'Pricing intelligence',
  'action-center': 'Action Center',
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const report = (req.nextUrl.searchParams.get('report') ?? '') as ReportType
  const format = (req.nextUrl.searchParams.get('format') ?? 'CSV').toUpperCase() as ExportFormat
  if (!REPORT_TYPES.includes(report)) return NextResponse.json({ error: 'Unknown report.' }, { status: 404 })
  if (!['CSV', 'XLSX', 'PDF'].includes(format)) {
    return NextResponse.json({ error: 'Exports are available as CSV, XLSX or PDF.' }, { status: 422 })
  }

  const access = canExportReport(role, report)
  if (!access.allow) {
    await audit(session, report, format, 'n/a', 'n/a', {}, [], 0, false, access.error)
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const parsed = parseReportRequest(req.nextUrl.searchParams)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: parsed.status })

  try {
    const built = await buildReport(report, parsed.request, role)
    const meta = buildReportMetadata(parsed.request, built.counts, built.warnings)
    const rows = built.exportRows

    const decision = canExport({
      role,
      allowed: true,
      columns: REPORT_COLUMNS[report],
      requestedKeys: req.nextUrl.searchParams.get('columns')?.split(',').filter(Boolean),
      rowCount: rows.length,
      format,
    })
    if (!decision.allow) {
      await audit(session, report, format, meta.periodLabel, meta.basisLabel, meta.filters, [], rows.length, false, decision.error)
      return NextResponse.json({ error: decision.error }, { status: decision.status })
    }

    const exportMeta: ExportMeta = {
      businessName: BUSINESS_NAME,
      reportTitle: TITLES[report],
      generatedAt: new Date(),
      basisLabel: meta.basisLabel,
      periodLabel: meta.periodLabel,
      currency: 'USD',
      recordCount: rows.length,
      warning: meta.warnings[0] ?? null,
      filters: { ...meta.filters, timezone: meta.timezone, mode: meta.reportingMode },
    }

    const body = format === 'CSV'
      ? toCsv(decision.columns, rows, exportMeta)
      : format === 'PDF'
        ? toPdf(decision.columns, rows, exportMeta)
        : toXlsxXml(decision.columns, rows, exportMeta)

    await audit(session, report, format, meta.periodLabel, meta.basisLabel, meta.filters, decision.columns.map((c) => c.key), rows.length, true, null)

    // Buffer (PDF) and string (CSV/XLSX) both become bytes here; Next wants a
    // Uint8Array rather than a Node Buffer.
    const payload = typeof body === 'string' ? body : new Uint8Array(body)

    return new NextResponse(payload, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(format),
        'Content-Disposition': `attachment; filename="${exportFilename(TITLES[report], format, exportMeta.generatedAt)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    apiLogger.error({ report, format, err: message }, 'Export failed')
    await audit(session, report, format, 'n/a', 'n/a', {}, [], 0, false, message.slice(0, 300))
    return NextResponse.json({ error: 'The export could not be produced.' }, { status: 503 })
  }
}

/** Records the SHAPE of an export. Never its contents. */
async function audit(
  session: { userId: string; name: string },
  report: string, format: ExportFormat, periodLabel: string, basisLabel: string,
  filters: Record<string, unknown>, columnKeys: string[], recordCount: number,
  success: boolean, error: string | null,
) {
  const details = buildExportAudit({
    userId: session.userId, userName: session.name, reportType: report, format,
    periodLabel, basisLabel, filters, columnKeys, recordCount, success, error,
  })
  await prisma.$transaction([
    prisma.reportExport.create({
      data: {
        reportType: report, format, periodLabel, basisLabel,
        filters: filters as never, columnKeys, recordCount,
        status: success ? 'SUCCESS' : 'FAILED', error,
        requestedById: session.userId, requestedByName: session.name,
      },
    }),
    prisma.auditLog.create({
      data: { action: 'REPORT_EXPORTED', userId: session.userId, details: details as never },
    }),
  ]).catch((e) => apiLogger.error({ err: String(e) }, 'Export audit write failed'))
}
