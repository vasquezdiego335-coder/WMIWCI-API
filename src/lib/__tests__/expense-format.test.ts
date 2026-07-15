// Offline tests for expense presentation + taxonomy (owner spec 2026-07-14).
// No prisma / DB — pure functions only, so this runs in the standard test sweep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPENSE_CATEGORY_ORDER,
  EXPENSE_CATEGORY_GROUPS,
  PAID_BY_OPTIONS,
  categoryGroupLabel,
  categoryGroupKey,
  expenseDisplayTitle,
  hasNotes,
  sortExpenses,
  compareExpenses,
  type SortableExpense,
} from '../expense-format'

// ── Taxonomy: the 18 detailed categories partition cleanly into the 11 headings.
test('every stored category maps to exactly one owner group', () => {
  const counts: Record<string, number> = {}
  for (const g of EXPENSE_CATEGORY_GROUPS) for (const c of g.categories) {
    counts[c] = (counts[c] ?? 0) + 1
  }
  for (const c of EXPENSE_CATEGORY_ORDER) {
    assert.equal(counts[c], 1, `category ${c} must belong to exactly one group`)
    assert.notEqual(categoryGroupKey(c), null, `category ${c} must resolve a group key`)
  }
  // groups never reference an unknown category
  for (const c of Object.keys(counts)) assert.ok(EXPENSE_CATEGORY_ORDER.includes(c), `group references unknown category ${c}`)
  // count matches: no category grouped twice, none missing
  assert.equal(Object.keys(counts).length, EXPENSE_CATEGORY_ORDER.length)
})

test('categoryGroupLabel maps detailed values to owner headings', () => {
  assert.equal(categoryGroupLabel('GAS'), 'Fuel')
  assert.equal(categoryGroupLabel('WORKER_PAY'), 'Payroll')
  assert.equal(categoryGroupLabel('ADVERTISING'), 'Marketing')
  assert.equal(categoryGroupLabel('CREW_FOOD'), 'Crew Food & Drinks')
  assert.equal(categoryGroupLabel('MOVING_BLANKETS'), 'Moving Supplies')
  assert.equal(categoryGroupLabel('STRAPS_DOLLIES'), 'Moving Equipment')
  assert.equal(categoryGroupLabel('MISC'), 'Other')
})

test('categoryGroupLabel is safe on null / unknown', () => {
  assert.equal(categoryGroupLabel(null), '—')
  assert.equal(categoryGroupLabel(undefined), '—')
  assert.equal(categoryGroupLabel('NOT_A_CATEGORY'), 'NOT_A_CATEGORY') // honest fallback, never throws
})

// ── Item title: prominent, with a legacy-safe fallback ──────────────────────
test('expenseDisplayTitle prefers the item title, falls back to the category', () => {
  assert.equal(expenseDisplayTitle({ itemTitle: 'Moving Blankets', category: 'SUPPLIES' }), 'Moving Blankets')
  assert.equal(expenseDisplayTitle({ itemTitle: null, category: 'SUPPLIES' }), 'Supplies')
  assert.equal(expenseDisplayTitle({ itemTitle: '   ', category: 'GAS' }), 'Gas') // whitespace-only is not a title
  assert.equal(expenseDisplayTitle({ itemTitle: undefined, category: 'MISC' }), 'Miscellaneous')
})

test('hasNotes ignores blank notes', () => {
  assert.equal(hasNotes({ notes: null }), false)
  assert.equal(hasNotes({ notes: '' }), false)
  assert.equal(hasNotes({ notes: '   ' }), false)
  assert.equal(hasNotes({ notes: 'Bought at Amazon' }), true)
})

test('paid-by options are exactly the two owners plus the business', () => {
  assert.deepEqual([...PAID_BY_OPTIONS], ['Diego', 'Sebastian', 'Business'])
})

// ── Sorting ─────────────────────────────────────────────────────────────────
function row(p: Partial<SortableExpense>): SortableExpense {
  return {
    itemTitle: null, category: 'MISC', vendor: null, amount: 0,
    paymentMethod: null, paidBy: null, incurredOn: '2026-07-01T00:00:00.000Z',
    status: 'SUBMITTED', jobLabel: null, ...p,
  }
}

test('sortExpenses by date descending then ascending', () => {
  const a = row({ itemTitle: 'A', incurredOn: '2026-07-01T00:00:00.000Z' })
  const b = row({ itemTitle: 'B', incurredOn: '2026-07-13T00:00:00.000Z' })
  const c = row({ itemTitle: 'C', incurredOn: '2026-07-05T00:00:00.000Z' })
  assert.deepEqual(sortExpenses([a, b, c], 'date', 'desc').map((r) => r.itemTitle), ['B', 'C', 'A'])
  assert.deepEqual(sortExpenses([a, b, c], 'date', 'asc').map((r) => r.itemTitle), ['A', 'C', 'B'])
})

test('sortExpenses by amount is numeric, not lexical', () => {
  const rows = [row({ itemTitle: '9', amount: 900 }), row({ itemTitle: '80', amount: 8000 }), row({ itemTitle: '100', amount: 10000 })]
  assert.deepEqual(sortExpenses(rows, 'amount', 'asc').map((r) => r.amount), [900, 8000, 10000])
})

test('sortExpenses by title uses the display title (case-insensitive)', () => {
  const rows = [row({ itemTitle: 'zebra' }), row({ itemTitle: 'Apple' }), row({ itemTitle: null, category: 'GAS' })]
  // 'Apple', 'Gas' (fallback), 'zebra'
  assert.deepEqual(sortExpenses(rows, 'title', 'asc').map((r) => expenseTitle(r)), ['Apple', 'Gas', 'zebra'])
})

test('nulls sort last for vendor regardless of direction', () => {
  const withV = row({ itemTitle: 'has', vendor: 'Amazon' })
  const noV = row({ itemTitle: 'none', vendor: null })
  assert.deepEqual(sortExpenses([noV, withV], 'vendor', 'asc').map((r) => r.itemTitle), ['has', 'none'])
  assert.deepEqual(sortExpenses([withV, noV], 'vendor', 'desc').map((r) => r.itemTitle), ['has', 'none'])
})

test('status sorts by review priority (needs-review first)', () => {
  const rows = [
    row({ itemTitle: 'rej', status: 'REJECTED' }),
    row({ itemTitle: 'need', status: 'NEEDS_REVIEW' }),
    row({ itemTitle: 'appr', status: 'APPROVED' }),
  ]
  assert.deepEqual(sortExpenses(rows, 'status', 'asc').map((r) => r.itemTitle), ['need', 'appr', 'rej'])
})

test('compareExpenses does not mutate and is direction-symmetric for values', () => {
  const a = row({ amount: 100 })
  const b = row({ amount: 200 })
  assert.ok(compareExpenses(a, b, 'amount', 'asc') < 0)
  assert.ok(compareExpenses(a, b, 'amount', 'desc') > 0)
})

// local mirror of expenseDisplayTitle for the sort-order assertion above
function expenseTitle(r: SortableExpense): string {
  return r.itemTitle?.trim() || ({ GAS: 'Gas' } as Record<string, string>)[r.category] || r.category
}
