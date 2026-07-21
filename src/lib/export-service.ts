// ============================================================================
// export-service.ts — safe CSV / XLSX / PDF export (Stage 3, owner spec
// 2026-07-20).
//
// TWO THINGS THIS FILE EXISTS TO PREVENT:
//
//  1. SPREADSHEET FORMULA INJECTION. A customer note of
//     `=HYPERLINK("http://evil","click")` is just text in our database, but Excel
//     and Sheets EXECUTE it on open. Every untrusted cell is neutralized here,
//     once, so no individual report can forget.
//
//  2. OVER-SHARING. An export is a file that leaves the building. Columns are
//     explicitly allow-listed per report and filtered by role — never "select *".
//
// Pure functions (no I/O) so both rules are unit-testable offline.
// ============================================================================

export type ExportFormat = 'CSV' | 'XLSX' | 'PDF'

/** Characters Excel/Sheets treat as the start of a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@']
/** Whitespace and control characters a payload can hide behind. Excel ignores
 *  them and still evaluates what follows, so detection must look PAST them.
 *  Deliberately EXCLUDES '-': a leading hyphen is itself a formula prefix,
 *  and stripping it would hide the very thing being checked for. */
const LEADING_NOISE = /^[\s\u0000-\u001f\u200b\ufeff]+/

/**
 * Neutralize one cell.
 *
 * Prefixes a single quote — the standard, lossless mitigation: spreadsheets
 * render the original text and refuse to evaluate it. The value is NOT stripped
 * or altered, because an export must still be a faithful record.
 */
export function sanitizeCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()

  const s = String(value)
  // Look PAST any leading whitespace/control run so " \t=cmd" cannot slip
  // through — but quote the ORIGINAL string. Stripping would silently alter
  // the customer's text, and an export must stay a faithful record.
  const probe = s.replace(LEADING_NOISE, '')
  if (probe.length > 0 && FORMULA_PREFIXES.includes(probe[0])) return `'${s}`
  return s
}

/** True when a raw value WOULD have been executed had it not been sanitized. */
export function isFormulaRisk(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const probe = value.replace(LEADING_NOISE, '')
  return probe.length > 0 && FORMULA_PREFIXES.includes(probe[0])
}

/** RFC-4180 quoting, applied AFTER sanitization. */
export function csvEscape(value: unknown): string {
  const s = sanitizeCell(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

// ── Column allow-listing ────────────────────────────────────────────────────

export interface ExportColumn {
  key: string
  header: string
  /** Roles that may see this column. Absent = every role that can run the report. */
  roles?: string[]
  /** True for money columns, so exports can note the currency once. */
  money?: boolean
  /** Never exported under any role — declared so the intent is explicit. */
  never?: boolean
}

/**
 * Columns a role may actually receive. This is the ONLY place that decides,
 * so a new report cannot accidentally widen access.
 */
export function visibleColumns(columns: ExportColumn[], role: string, requestedKeys?: string[]): ExportColumn[] {
  return columns
    .filter((c) => !c.never)
    .filter((c) => !c.roles || c.roles.includes(role))
    .filter((c) => !requestedKeys || requestedKeys.includes(c.key))
}

/** Fields that must never reach a file, whatever a caller asks for. */
export const FORBIDDEN_EXPORT_KEYS = [
  'passwordHash', 'password', 'token', 'customerToken', 'csrf',
  'stripeSecret', 'apiKey', 'authorization', 'sessionId',
  'receiptUrl', 'proofUrl', 'cloudinaryUrl', // private document links
  'originAccessCode', 'destAccessCode', // gate / lockbox codes
  'cardNumber', 'cvv', 'last4',
] as const

export function assertNoForbiddenKeys(columns: ExportColumn[]): { ok: true } | { ok: false; offending: string[] } {
  const offending = columns
    .map((c) => c.key)
    .filter((k) => (FORBIDDEN_EXPORT_KEYS as readonly string[]).some((f) => k.toLowerCase() === f.toLowerCase()))
  return offending.length ? { ok: false, offending } : { ok: true }
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface ExportMeta {
  businessName: string
  reportTitle: string
  generatedAt: Date
  /** e.g. "Cash basis — money actually collected and paid · finalized moves only" */
  basisLabel: string
  periodLabel: string
  currency: string
  recordCount: number
  /** Shown when the data blends finalized and provisional figures. */
  warning?: string | null
  filters?: Record<string, unknown>
}

/**
 * The header block every export carries. A file that leaves the building must
 * state what it is — a spreadsheet with no basis line is a spreadsheet somebody
 * will misread six months from now.
 */
export function metaRows(meta: ExportMeta): string[][] {
  const rows: string[][] = [
    [meta.businessName],
    [meta.reportTitle],
    ['Period', meta.periodLabel],
    ['Basis', meta.basisLabel],
    ['Currency', meta.currency],
    ['Records', String(meta.recordCount)],
    ['Generated', meta.generatedAt.toISOString()],
  ]
  if (meta.warning) rows.push(['Warning', meta.warning])
  if (meta.filters && Object.keys(meta.filters).length) {
    rows.push(['Filters', Object.entries(meta.filters).map(([k, v]) => `${k}=${String(v)}`).join('; ')])
  }
  rows.push([])
  return rows
}

export function toCsv(columns: ExportColumn[], rows: Record<string, unknown>[], meta: ExportMeta): string {
  const out: string[] = []
  for (const m of metaRows(meta)) out.push(m.map(csvEscape).join(','))
  out.push(columns.map((c) => csvEscape(c.header)).join(','))
  for (const r of rows) out.push(columns.map((c) => csvEscape(r[c.key])).join(','))
  return out.join('\r\n')
}

/**
 * A minimal SpreadsheetML workbook — valid XLSX-family XML that Excel, Sheets
 * and Numbers all open, with no new dependency. Every cell goes through the
 * same sanitizer as CSV, and is written as inline text so nothing is evaluated.
 */
export function toXlsxXml(columns: ExportColumn[], rows: Record<string, unknown>[], meta: ExportMeta): string {
  const esc = (v: unknown) =>
    sanitizeCell(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const cell = (v: unknown) => `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`
  const row = (cells: unknown[]) => `<Row>${cells.map(cell).join('')}</Row>`

  const body = [
    ...metaRows(meta).map((m) => row(m)),
    row(columns.map((c) => c.header)),
    ...rows.map((r) => row(columns.map((c) => r[c.key]))),
  ].join('')

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${esc(meta.reportTitle).slice(0, 30) || 'Report'}"><Table>${body}</Table></Worksheet>
</Workbook>`
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/**
 * A minimal, dependency-free PDF (1.4) using the built-in Courier font.
 *
 * WHY HAND-ROLLED: adding a PDF library to ship one report is a large surface
 * for a small need, and every alternative renders HTML in a headless browser we
 * do not run. This writes the handful of objects a text document needs, and the
 * cell values go through the SAME sanitizer as CSV and XLSX — a PDF is not a
 * spreadsheet, but a single sanitizer means no format can be forgotten.
 *
 * Layout is RECORD-PER-BLOCK ("Header: value" lines), not a grid: a financial
 * export is 20+ columns wide and a squeezed grid is unreadable, whereas a block
 * per record stays legible when printed.
 */
export function toPdf(columns: ExportColumn[], rows: Record<string, unknown>[], meta: ExportMeta): Buffer {
  const PAGE_W = 612, PAGE_H = 792, MARGIN = 48, LEADING = 12, SIZE = 9
  const MAX_LINES = Math.floor((PAGE_H - MARGIN * 2) / LEADING)

  // Courier is a WinAnsi font: characters outside it would render as garbage,
  // so they are transliterated rather than silently dropped.
  const ascii = (s: string) =>
    s.replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/·/g, '-').replace(/[^\x20-\x7e]/g, '?')
  const esc = (s: string) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

  const lines: string[] = []
  for (const m of metaRows(meta)) lines.push(m.join('  '))
  lines.push('')
  rows.forEach((r, i) => {
    lines.push(`--- Record ${i + 1} of ${rows.length} ---`)
    for (const c of columns) lines.push(`${c.header}: ${sanitizeCell(r[c.key])}`)
    lines.push('')
  })
  if (rows.length === 0) lines.push('(no records)')

  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += MAX_LINES) pages.push(lines.slice(i, i + MAX_LINES))
  if (pages.length === 0) pages.push([''])

  // Objects: 1 catalog, 2 pages, 3 font, then (page, content) per page.
  const objects: string[] = []
  const pageIds: number[] = []
  const FIRST_PAGE_OBJ = 4
  pages.forEach((_, i) => pageIds.push(FIRST_PAGE_OBJ + i * 2))

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'

  pages.forEach((pageLines, i) => {
    const pageObj = pageIds[i]
    const contentObj = pageObj + 1
    const body =
      `BT /F1 ${SIZE} Tf ${LEADING} TL 1 0 0 1 ${MARGIN} ${PAGE_H - MARGIN} Tm\n` +
      pageLines.map((l) => `(${esc(l)}) Tj T*`).join('\n') +
      '\nET'
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`
    objects[contentObj] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`
  })

  // Assemble with a real cross-reference table — byte offsets are what make a
  // PDF openable, so they are computed rather than approximated.
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefAt = Buffer.byteLength(pdf, 'latin1')
  const count = objects.length // entries 0..N-1
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

export const exportFilename = (title: string, format: ExportFormat, at: Date): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  const stamp = at.toISOString().slice(0, 10)
  const ext = format === 'XLSX' ? 'xls' : format.toLowerCase()
  return `${slug}-${stamp}.${ext}`
}

export const contentTypeFor = (format: ExportFormat): string =>
  format === 'CSV' ? 'text/csv; charset=utf-8'
    : format === 'XLSX' ? 'application/vnd.ms-excel'
      : 'application/pdf'

// ── Guards ──────────────────────────────────────────────────────────────────

/** Unbounded exports are a denial-of-service on our own database. */
export const MAX_EXPORT_ROWS = 10_000

export type ExportDecision = { allow: true; columns: ExportColumn[] } | { allow: false; status: 403 | 413 | 422; error: string }

export function canExport(args: {
  role: string
  allowed: boolean
  columns: ExportColumn[]
  requestedKeys?: string[]
  rowCount: number
  format: ExportFormat
}): ExportDecision {
  if (!args.allowed) {
    return { allow: false, status: 403, error: 'You do not have permission to export this report.' }
  }
  if (args.rowCount > MAX_EXPORT_ROWS) {
    return {
      allow: false, status: 413,
      error: `That export would contain ${args.rowCount.toLocaleString()} rows. Narrow the date range or filters (limit ${MAX_EXPORT_ROWS.toLocaleString()}).`,
    }
  }
  const columns = visibleColumns(args.columns, args.role, args.requestedKeys)
  if (columns.length === 0) {
    return { allow: false, status: 422, error: 'No columns are available to you for this export.' }
  }
  const check = assertNoForbiddenKeys(columns)
  if (!check.ok) {
    return { allow: false, status: 422, error: `These fields can never be exported: ${check.offending.join(', ')}.` }
  }
  return { allow: true, columns }
}

/** What the audit log records. Deliberately excludes the exported CONTENT —
 *  logging the file would recreate the disclosure the export controls exist for. */
export interface ExportAuditEntry {
  userId: string
  userName: string
  reportType: string
  format: ExportFormat
  periodLabel: string
  basisLabel: string
  filters: Record<string, unknown>
  columnKeys: string[]
  recordCount: number
  success: boolean
  error?: string | null
}

export function buildExportAudit(e: ExportAuditEntry): Record<string, unknown> {
  return {
    reportType: e.reportType,
    format: e.format,
    period: e.periodLabel,
    basis: e.basisLabel,
    filters: e.filters,
    columns: e.columnKeys,
    recordCount: e.recordCount,
    success: e.success,
    error: e.error ?? null,
    by: e.userName,
  }
}
