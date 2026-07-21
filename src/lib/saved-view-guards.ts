import { ReportQuerySchema, type ReportQuery } from './reporting-filters'
import { canRunReport, REPORT_ACCESS, REPORT_COLUMNS, OWNER_ONLY_FIELDS, type ReportType } from './report-permissions'
import { can, type Role } from './permissions'

// P1-3 — rules for saved report views. Pure; routes and tests both call these,
// so the rule that ships is the rule that was tested.
//
// THE RULE THIS MODULE EXISTS FOR: a saved view is a stored report REQUEST, and
// a SHARED one can be opened by someone other than its author. Authorization is
// therefore evaluated against the person OPENING it, never the person who saved
// it. Otherwise an owner saves "Q3 P&L", shares it, and a manager — explicitly
// denied report.view_financial — reads company profit through the link. A
// stored row must never become a capability.
//
// A saved view stores filters, never results: no SQL, no query objects, no
// numbers, no customer data, no credentials. Everything is re-validated through
// the SAME schema the live report route uses, so a view can never smuggle a
// query shape the report itself would reject.

export type ViewDecision = { allow: true } | { allow: false; status: 403 | 404 | 409 | 422; error: string }

const ok = { allow: true } as const

export const REPORT_TYPES = Object.keys(REPORT_ACCESS) as ReportType[]

/** Is this string one of the report types we actually serve? */
export function isReportType(v: unknown): v is ReportType {
  return typeof v === 'string' && (REPORT_TYPES as string[]).includes(v)
}

/** Column keys this report can legitimately show. */
export function allowedColumnsFor(report: ReportType): string[] {
  return (REPORT_COLUMNS[report] ?? []).map((c) => c.key)
}

/** True when a column is owner-only money. */
export function isOwnerOnlyColumn(key: string): boolean {
  return (OWNER_ONLY_FIELDS as readonly string[]).includes(key)
}

// ── Access ──────────────────────────────────────────────────────────────────

/**
 * May this role use saved views at all?
 *
 * CREW is denied outright. Their narrow self-service labor rights (Phase 1) do
 * not include any report action, so canRunReport already refuses them — this is
 * the explicit statement of that, so a future widening of CREW_ALLOWED cannot
 * quietly open admin reporting.
 */
export function canUseSavedViews(role: Role | null | undefined): boolean {
  return role === 'OWNER' || role === 'MANAGER'
}

/**
 * May this role save a view of this report? You cannot save what you cannot
 * run, or a saved view becomes a way to build a query you were never allowed
 * to build.
 */
export function canSaveView(role: Role | null | undefined, report: ReportType): ViewDecision {
  if (!canUseSavedViews(role)) {
    return { allow: false, status: 403, error: 'You do not have access to admin reports.' }
  }
  if (!canRunReport(role, report).allow) {
    return { allow: false, status: 403, error: 'You do not have access to that report, so you cannot save a view of it.' }
  }
  return ok
}

/**
 * May this role OPEN this view? Re-derived from the report type every time.
 *
 * A view the viewer may not run reports 404, not 403: the existence of an
 * owner's saved financial view is itself information a manager should not get.
 */
export function canLoadView(
  role: Role | null | undefined,
  view: { reportType: string; shared: boolean; createdById: string },
  viewerId: string,
): ViewDecision {
  if (!canUseSavedViews(role)) {
    return { allow: false, status: 403, error: 'You do not have access to admin reports.' }
  }
  if (!view.shared && view.createdById !== viewerId) {
    return { allow: false, status: 404, error: 'View not found.' }
  }
  if (!isReportType(view.reportType) || !canRunReport(role, view.reportType).allow) {
    return { allow: false, status: 404, error: 'View not found.' }
  }
  return ok
}

/** Publishing to other users is its own permission, separate from saving. */
export function canShareView(role: Role | null | undefined): boolean {
  return canUseSavedViews(role) && can(role as Role, 'report.save_shared_view')
}

/**
 * May this role MUTATE this view (rename, re-filter, share, delete)?
 *
 * Authors manage their own. An owner may manage any, including shared views
 * whose author has left. Seeing a shared view never confers the right to change
 * it — otherwise any manager could silently re-filter a view others rely on.
 */
export function canMutateView(
  role: Role | null | undefined,
  view: { createdById: string; shared: boolean },
  viewerId: string,
): ViewDecision {
  if (!canUseSavedViews(role)) {
    return { allow: false, status: 403, error: 'You do not have access to admin reports.' }
  }
  if (role === 'OWNER') return ok
  if (view.createdById !== viewerId) {
    return { allow: false, status: 403, error: 'Only the person who saved this view, or an owner, can change it.' }
  }
  // An author may keep managing their own view even after it was shared, but
  // may not RE-share it without the permission — enforced separately.
  return ok
}

// ── Configuration validation ────────────────────────────────────────────────

export type FilterParse =
  | { ok: true; filters: ReportQuery }
  | { ok: false; error: string }

/**
 * Validate a saved configuration through the LIVE report schema.
 *
 * This is the single filter contract — there is deliberately no second parser.
 * Zod strips unknown keys, so an object carrying `$where`, a function, a Prisma
 * fragment or raw SQL under an unrecognized key cannot survive; anything under
 * a RECOGNIZED key is a length-bounded scalar that Prisma parameterizes.
 *
 * Stored JSON is untrusted on the way OUT as well as in: a view saved months
 * ago may reference a filter that has since been removed, and a row edited
 * directly in the database could carry anything.
 */
export function parseStoredFilters(raw: unknown): FilterParse {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'This saved view has no usable filters. Re-save it from the report.' }
  }
  const parsed = ReportQuerySchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: 'This saved view uses filters that are no longer valid. Re-save it from the report.' }
  }
  return { ok: true, filters: parsed.data }
}

export type ConfigDecision =
  | { ok: true; columns: string[]; droppedColumns: string[]; filters: ReportQuery }
  | { ok: false; status: 403 | 422; error: string }

/**
 * Full validation of a save/update payload: report type, filters, sort field,
 * sort direction and columns, plus the owner-only column rule.
 *
 * Sort field is checked against the report's own column keys. An unvalidated
 * sort string is the one field here that reaches an ORDER BY, so an unknown
 * value is REJECTED rather than dropped.
 *
 * Columns are different: unknown ones are DROPPED, so a renamed column degrades
 * a view instead of breaking it. But an owner-only money column requested by a
 * non-owner is REJECTED — silently dropping it would let a manager build a view
 * they believe shows profit, and quietly hand a misleading artifact to whoever
 * they share it with.
 */
export function validateViewConfig(
  role: Role | null | undefined,
  input: { reportType: unknown; filters: unknown; sortKey?: string | null; sortDir?: string | null; columns?: string[] },
): ConfigDecision {
  if (!isReportType(input.reportType)) {
    return { ok: false, status: 422, error: 'Unknown report type.' }
  }
  const report = input.reportType

  const gate = canSaveView(role, report)
  if (!gate.allow) return { ok: false, status: gate.status as 403, error: gate.error }

  const filters = parseStoredFilters(input.filters ?? {})
  if (!filters.ok) {
    return { ok: false, status: 422, error: 'Those filters are not valid for this report.' }
  }

  const allowed = allowedColumnsFor(report)

  if (input.sortKey) {
    if (!allowed.includes(input.sortKey)) {
      return { ok: false, status: 422, error: `"${input.sortKey}" is not a sortable field on this report.` }
    }
    if (role !== 'OWNER' && isOwnerOnlyColumn(input.sortKey)) {
      return { ok: false, status: 403, error: 'You cannot sort this report by an owner-only financial field.' }
    }
  }
  if (input.sortDir && input.sortDir !== 'asc' && input.sortDir !== 'desc') {
    return { ok: false, status: 422, error: 'Sort direction must be asc or desc.' }
  }

  const requested = input.columns ?? []
  if (role !== 'OWNER') {
    const forbidden = requested.filter(isOwnerOnlyColumn)
    if (forbidden.length) {
      return {
        ok: false,
        status: 403,
        error: `This view includes owner-only financial fields (${forbidden.join(', ')}). Remove them, or ask an owner to save it.`,
      }
    }
  }
  const columns = requested.filter((c) => allowed.includes(c)).slice(0, 60)
  const droppedColumns = requested.filter((c) => !allowed.includes(c))

  return { ok: true, columns, droppedColumns, filters: filters.filters }
}

/**
 * DUPLICATE NAME POLICY: names are unique per (report type, owner-of-the-name),
 * case-insensitively — your own views cannot collide with each other, and
 * shared views cannot collide with other shared views. Your private view MAY
 * share a name with someone else's private view, because neither can see the
 * other. Enforced in the route against a scoped query; there is no database
 * unique index, so this returns 409 rather than relying on a constraint.
 */
export function nameConflict(
  candidate: string,
  existing: { id: string; name: string }[],
  selfId?: string,
): ViewDecision {
  const key = candidate.trim().toLowerCase()
  const clash = existing.find((e) => e.id !== selfId && e.name.trim().toLowerCase() === key)
  if (clash) {
    return { allow: false, status: 409, error: `You already have a view named "${clash.name}" for this report. Pick a different name.` }
  }
  return ok
}
