// P1-3 — saved report view rules. These are the exact predicates the
// /api/admin/reports/saved-views routes call, so a passing test here is a
// statement about the routes' behavior, not a parallel re-implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canUseSavedViews,
  canSaveView,
  canLoadView,
  canShareView,
  canMutateView,
  parseStoredFilters,
  validateViewConfig,
  nameConflict,
  isReportType,
  allowedColumnsFor,
  isOwnerOnlyColumn,
} from '../saved-view-guards'

const OWNER = 'OWNER' as const
const MANAGER = 'MANAGER' as const
const CREW = 'CREW' as const

const FILTERS = { period: 'this_month', basis: 'CASH', scope: 'COMBINED' }

// ── Access by role ──────────────────────────────────────────────────────────

test('CREW is denied saved views outright', () => {
  // Phase 1 gave CREW narrow self-service labor rights. This is the explicit
  // statement that they never extend to admin reporting.
  assert.equal(canUseSavedViews(CREW), false)
  assert.equal(canSaveView(CREW, 'moves').allow, false)
  assert.equal(canLoadView(CREW, { reportType: 'moves', shared: true, createdById: 'x' }, 'crew-1').allow, false)
  assert.equal(canMutateView(CREW, { createdById: 'crew-1', shared: false }, 'crew-1').allow, false)
})

test('an unauthenticated / unknown role is denied', () => {
  assert.equal(canUseSavedViews(null), false)
  assert.equal(canUseSavedViews(undefined), false)
})

// ── Create ──────────────────────────────────────────────────────────────────

test('an owner can save a private financial view', () => {
  const r = validateViewConfig(OWNER, { reportType: 'profit-loss', filters: FILTERS })
  assert.equal(r.ok, true)
})

test('an owner can save a SHARED view', () => {
  assert.equal(canShareView(OWNER), true)
})

test('a manager can save an operational view', () => {
  assert.equal(validateViewConfig(MANAGER, { reportType: 'moves', filters: FILTERS }).ok, true)
})

test('a manager cannot save a view of a report they cannot run', () => {
  const r = validateViewConfig(MANAGER, { reportType: 'profit-loss', filters: FILTERS })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.status, 403)
})

// ── Apply / load ────────────────────────────────────────────────────────────

test("a manager cannot open an owner's SHARED financial view", () => {
  // The rule the module exists for: sharing must not become a capability.
  const v = { reportType: 'profit-loss', shared: true, createdById: 'owner-1' }
  assert.equal(canLoadView(MANAGER, v, 'manager-1').allow, false)
})

test('that denial is 404, not 403 — existence is itself information', () => {
  const v = { reportType: 'profit-loss', shared: true, createdById: 'owner-1' }
  const d = canLoadView(MANAGER, v, 'manager-1')
  assert.equal(!d.allow && d.status, 404)
})

test('a manager CAN open a shared operational view', () => {
  assert.equal(canLoadView(MANAGER, { reportType: 'moves', shared: true, createdById: 'owner-1' }, 'manager-1').allow, true)
})

test('a private view is invisible to everyone but its author', () => {
  const v = { reportType: 'moves', shared: false, createdById: 'user-1' }
  assert.equal(canLoadView(MANAGER, v, 'user-2').allow, false)
  assert.equal(canLoadView(MANAGER, v, 'user-1').allow, true)
})

test('an author who has LOST access can no longer open their own view', () => {
  // Demotion takes effect immediately; authorship is not a grandfather clause.
  assert.equal(canLoadView(MANAGER, { reportType: 'profit-loss', shared: false, createdById: 'u1' }, 'u1').allow, false)
})

test('applying a view goes through the SAME schema as the live report', () => {
  const r = parseStoredFilters({ period: 'previous_month', basis: 'ACCRUAL', scope: 'FINALIZED_ONLY' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.filters.basis, 'ACCRUAL')
  // Defaults re-applied, so an old sparse view still opens.
  const sparse = parseStoredFilters({})
  assert.equal(sparse.ok && sparse.filters.page, 1)
})

// ── Update / rename / delete ────────────────────────────────────────────────

test('a user cannot edit another user’s private view', () => {
  const d = canMutateView(MANAGER, { createdById: 'user-1', shared: false }, 'user-2')
  assert.equal(d.allow, false)
  assert.equal(!d.allow && d.status, 403)
})

test('seeing a SHARED view does not confer the right to change it', () => {
  assert.equal(canMutateView(MANAGER, { createdById: 'owner-1', shared: true }, 'manager-1').allow, false)
})

test('an owner may manage any shared view', () => {
  assert.equal(canMutateView(OWNER, { createdById: 'someone-else', shared: true }, 'owner-1').allow, true)
})

test('an author may manage their own view', () => {
  assert.equal(canMutateView(MANAGER, { createdById: 'm1', shared: false }, 'm1').allow, true)
})

// ── Validation: report type, filters, columns, sort ─────────────────────────

test('an unknown report type is rejected', () => {
  assert.equal(isReportType('not-a-report'), false)
  const r = validateViewConfig(OWNER, { reportType: 'not-a-report', filters: FILTERS })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.status, 422)
})

test('an invalid filter value is rejected', () => {
  const r = validateViewConfig(OWNER, { reportType: 'moves', filters: { period: 'since_the_dawn_of_time' } })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.status, 422)
})

test('an unknown SORT field is REJECTED — it is the value that reaches ORDER BY', () => {
  const r = validateViewConfig(OWNER, { reportType: 'moves', filters: FILTERS, sortKey: 'id; DROP TABLE bookings' })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.status, 422)
})

test('an invalid sort DIRECTION is rejected', () => {
  const r = validateViewConfig(OWNER, { reportType: 'moves', filters: FILTERS, sortDir: 'sideways' })
  assert.equal(r.ok, false)
})

test('an unknown COLUMN is dropped, not rejected — a rename degrades a view instead of breaking it', () => {
  const real = allowedColumnsFor('moves')
  const r = validateViewConfig(OWNER, { reportType: 'moves', filters: FILTERS, columns: [real[0], 'ghost_column'] })
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.columns.includes(real[0]))
  assert.ok(r.ok && r.droppedColumns.includes('ghost_column'))
})

test('a manager requesting an owner-only money column is REJECTED, not silently trimmed', () => {
  // Dropping it quietly would let a manager build a view they believe shows
  // profit and hand that misleading artifact to whoever they share it with.
  assert.equal(isOwnerOnlyColumn('companyNetProfitCents'), true)
  const r = validateViewConfig(MANAGER, { reportType: 'moves', filters: FILTERS, columns: ['companyNetProfitCents'] })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.status, 403)
})

test('a manager cannot SORT by an owner-only financial field', () => {
  const r = validateViewConfig(MANAGER, { reportType: 'moves', filters: FILTERS, sortKey: 'companyNetProfitCents' })
  assert.equal(r.ok, false)
})

// ── Executable / SQL content cannot be stored ───────────────────────────────

test('raw SQL under an unknown key cannot be stored — zod strips it', () => {
  const r = parseStoredFilters({ period: 'this_month', $where: 'DROP TABLE bookings', rawSql: 'SELECT 1' })
  assert.equal(r.ok, true)
  assert.equal(Object.prototype.hasOwnProperty.call(r.ok && r.filters, '$where'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r.ok && r.filters, 'rawSql'), false)
})

test('a Prisma-shaped query object cannot be stored', () => {
  const r = parseStoredFilters({ where: { booking: { deleteMany: {} } }, select: { id: true } })
  assert.equal(r.ok, true)
  assert.equal(Object.prototype.hasOwnProperty.call(r.ok && r.filters, 'where'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r.ok && r.filters, 'select'), false)
})

test('SQL text inside a RECOGNIZED filter stays an inert bounded string', () => {
  // city is a length-capped string that Prisma parameterizes — it is data, not
  // code — but it must never be able to grow unbounded either.
  const r = parseStoredFilters({ city: "'; DROP TABLE bookings; --" })
  assert.equal(r.ok, true)
  assert.equal(r.ok && typeof r.filters.city, 'string')
  const tooLong = parseStoredFilters({ city: 'x'.repeat(500) })
  assert.equal(tooLong.ok, false)
})

test('junk in the filters column is refused, not thrown on', () => {
  assert.equal(parseStoredFilters(null).ok, false)
  assert.equal(parseStoredFilters('nope').ok, false)
  assert.equal(parseStoredFilters([1, 2, 3]).ok, false)
})

// ── Duplicate names ─────────────────────────────────────────────────────────

test('a duplicate name in the same scope is a 409', () => {
  const d = nameConflict('Monthly Owner Review', [{ id: 'a', name: 'Monthly Owner Review' }])
  assert.equal(d.allow, false)
  assert.equal(!d.allow && d.status, 409)
})

test('duplicate detection is case- and whitespace-insensitive', () => {
  assert.equal(nameConflict('  monthly OWNER review ', [{ id: 'a', name: 'Monthly Owner Review' }]).allow, false)
})

test('renaming a view does not collide with itself', () => {
  assert.equal(nameConflict('Same Name', [{ id: 'self', name: 'Same Name' }], 'self').allow, true)
})

test('an empty sibling list never conflicts', () => {
  assert.equal(nameConflict('Anything', []).allow, true)
})
