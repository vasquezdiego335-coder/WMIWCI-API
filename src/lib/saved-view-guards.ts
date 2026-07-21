import { ReportQuerySchema, type ReportQuery } from './reporting-filters'
import { canRunReport, type ReportType } from './report-permissions'
import { can, type Role } from './permissions'

// P1-3 — rules for saved report views. Pure; routes and tests both call these.
//
// THE RULE THIS MODULE EXISTS FOR: a saved view is a stored report request, and
// a SHARED one can be opened by someone other than its author. Authorization
// must therefore be evaluated against the person OPENING it, never against the
// person who saved it. Otherwise an owner saves "Q3 P&L", shares it, and a
// manager — who is explicitly denied report.view_financial — opens the link and
// reads company profit. The stored row must never become a capability.

export type ViewDecision = { allow: true } | { allow: false; status: 403 | 404 | 422; error: string }

const ok = { allow: true } as const

/**
 * May this role save a view of this report? You cannot save what you cannot
 * run — otherwise a saved view becomes a way to hand someone else a query they
 * were never allowed to build.
 */
export function canSaveView(role: Role | null | undefined, report: ReportType): ViewDecision {
  const access = canRunReport(role, report)
  if (!access.allow) {
    return { allow: false, status: 403, error: 'You do not have access to that report, so you cannot save a view of it.' }
  }
  return ok
}

/**
 * May this role OPEN this view? Re-derived from the report type every time.
 * A view the viewer cannot run is reported as 404, not 403: the existence of an
 * owner's saved financial view is itself information a manager should not get.
 */
export function canLoadView(
  role: Role | null | undefined,
  view: { reportType: string; shared: boolean; createdById: string },
  viewerId: string,
): ViewDecision {
  const isAuthor = view.createdById === viewerId
  if (!view.shared && !isAuthor) {
    return { allow: false, status: 404, error: 'View not found.' }
  }
  const access = canRunReport(role, view.reportType as ReportType)
  if (!access.allow) {
    return { allow: false, status: 404, error: 'View not found.' }
  }
  return ok
}

/** Publishing to other users is its own permission, separate from saving. */
export function canShareView(role: Role | null | undefined): boolean {
  return can(role as Role, 'report.save_shared_view')
}

/**
 * Authors manage their own views; an owner can remove any of them (a shared
 * view outliving the person who made it is an operational problem, not a
 * property right).
 */
export function canDeleteView(
  role: Role | null | undefined,
  view: { createdById: string },
  viewerId: string,
): ViewDecision {
  if (view.createdById === viewerId) return ok
  if (role === 'OWNER') return ok
  return { allow: false, status: 403, error: 'Only the person who saved this view, or an owner, can delete it.' }
}

export type FilterParse =
  | { ok: true; filters: ReportQuery }
  | { ok: false; error: string }

/**
 * Re-validate stored filters through the SAME schema the live report uses.
 *
 * Stored JSON is not trusted input: a view saved months ago may reference a
 * filter that has since been removed, and a row edited in the database directly
 * could carry anything. Re-parsing means a saved view can never smuggle a
 * query shape the report route would itself reject.
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

/**
 * Which of a user's requested columns may actually be persisted.
 *
 * Column lists are cosmetic, but persisting an owner-only column into a SHARED
 * view would leak the field NAME to a manager even when shapeForRole blanks the
 * value. Unknown columns are dropped rather than rejected so a renamed column
 * degrades a view instead of breaking it.
 */
export function sanitizeColumns(requested: string[], allowed: string[]): string[] {
  const set = new Set(allowed)
  return requested.filter((c) => set.has(c)).slice(0, 60)
}
