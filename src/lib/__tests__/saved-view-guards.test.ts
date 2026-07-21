// P1-3 — saved report view rules. These are the exact predicates the
// /api/admin/reports/views routes call, so a passing test here is a statement
// about the routes' behavior.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canSaveView,
  canLoadView,
  canShareView,
  canDeleteView,
  parseStoredFilters,
  sanitizeColumns,
} from '../saved-view-guards'

const OWNER = 'OWNER' as const
const MANAGER = 'MANAGER' as const

// ── Saving ──────────────────────────────────────────────────────────────────

test('an owner can save a financial view', () => {
  assert.equal(canSaveView(OWNER, 'profit-loss').allow, true)
})

test('a manager cannot save a view of a report they cannot run', () => {
  // MANAGER is denied report.view_financial, so saving a P&L view would be a
  // way to build a query they were never allowed to build.
  const d = canSaveView(MANAGER, 'profit-loss')
  assert.equal(d.allow, false)
  assert.equal(!d.allow && d.status, 403)
})

test('a manager CAN save an operational view', () => {
  assert.equal(canSaveView(MANAGER, 'moves').allow, true)
})

// ── Loading: the rule this module exists for ────────────────────────────────

test("a manager cannot open an owner's SHARED financial view", () => {
  // The whole point: sharing must not become a capability. Re-authorized
  // against the viewer, never the author.
  const view = { reportType: 'profit-loss', shared: true, createdById: 'owner-1' }
  const d = canLoadView(MANAGER, view, 'manager-1')
  assert.equal(d.allow, false)
})

test('that denial is a 404, not a 403 — existence is itself information', () => {
  const view = { reportType: 'profit-loss', shared: true, createdById: 'owner-1' }
  const d = canLoadView(MANAGER, view, 'manager-1')
  assert.equal(!d.allow && d.status, 404)
})

test('a manager CAN open a shared operational view', () => {
  const view = { reportType: 'moves', shared: true, createdById: 'owner-1' }
  assert.equal(canLoadView(MANAGER, view, 'manager-1').allow, true)
})

test('a private view is invisible to everyone but its author', () => {
  const view = { reportType: 'moves', shared: false, createdById: 'owner-1' }
  assert.equal(canLoadView(MANAGER, view, 'manager-1').allow, false)
  assert.equal(canLoadView(OWNER, view, 'owner-1').allow, true)
})

test('an author who has LOST access can no longer open their own saved view', () => {
  // Demotion must take effect immediately; authorship is not a grandfather clause.
  const view = { reportType: 'profit-loss', shared: false, createdById: 'user-1' }
  assert.equal(canLoadView(MANAGER, view, 'user-1').allow, false)
})

// ── Sharing / deleting ──────────────────────────────────────────────────────

test('publishing to other users is its own permission', () => {
  assert.equal(canShareView(OWNER), true)
})

test('an author can delete their own view; a stranger cannot', () => {
  const view = { createdById: 'user-1' }
  assert.equal(canDeleteView(MANAGER, view, 'user-1').allow, true)
  assert.equal(canDeleteView(MANAGER, view, 'user-2').allow, false)
})

test('an owner can delete anyone’s view', () => {
  assert.equal(canDeleteView(OWNER, { createdById: 'someone-else' }, 'owner-1').allow, true)
})

// ── Stored filters are untrusted input ──────────────────────────────────────

test('valid stored filters parse back through the live report schema', () => {
  const r = parseStoredFilters({ period: 'this_month', basis: 'CASH', scope: 'COMBINED' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.filters.period, 'this_month')
})

test('defaults are re-applied, so an old sparse view still opens', () => {
  const r = parseStoredFilters({})
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.filters.basis, 'CASH')
  assert.equal(r.ok && r.filters.page, 1)
})

test('a filter value that is no longer valid degrades with an explanation', () => {
  const r = parseStoredFilters({ period: 'since_the_dawn_of_time' })
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.error.includes('Re-save'))
})

test('junk stored in the column is refused, not thrown on', () => {
  assert.equal(parseStoredFilters(null).ok, false)
  assert.equal(parseStoredFilters('nope').ok, false)
  assert.equal(parseStoredFilters([1, 2, 3]).ok, false)
})

// ── Columns ─────────────────────────────────────────────────────────────────

test('unknown columns are dropped, not rejected — a rename degrades a view instead of breaking it', () => {
  assert.deepEqual(sanitizeColumns(['a', 'ghost', 'b'], ['a', 'b', 'c']), ['a', 'b'])
})

test('an empty request stays empty', () => {
  assert.deepEqual(sanitizeColumns([], ['a']), [])
})
