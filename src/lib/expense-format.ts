// ============================================================================
// Expense presentation + taxonomy (owner spec 2026-07-14 — "make expenses easy
// for both owners to read"). ONE source of truth for expense labels, the
// organized category taxonomy (11 owner headings over the 18 detailed enum
// values), subcategory suggestions, and the "Paid by" owners.
//
// Pure + client-safe (only a TYPE import from @prisma/client, erased at build).
// The detailed ExpenseCategory enum is deliberately KEPT — it drives the
// WORKER_PAY double-labor guard and every existing record. This module groups
// those detailed values under the owner's coarse headings for display/filtering
// and adds the Item Title + Subcategory dimensions; it never renames an enum.
// Money math (src/lib/profit.ts) is category-agnostic, so grouping is safe.
// ============================================================================

import type { ExpenseCategory } from '@prisma/client'

// ── Category labels (the detailed, stored value) ────────────────────────────
export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  WORKER_PAY: 'Worker pay',
  GAS: 'Gas',
  TOLLS: 'Tolls',
  PARKING: 'Parking',
  TRUCK_RENTAL: 'Truck rental',
  MOVING_EQUIPMENT: 'Moving equipment',
  MOVING_BLANKETS: 'Moving blankets',
  STRAPS_DOLLIES: 'Straps & dollies',
  ADVERTISING: 'Advertising',
  WEBSITE_SOFTWARE: 'Website & software',
  INSURANCE: 'Insurance',
  PHONE: 'Phone',
  CREW_FOOD: 'Food & drinks for crew',
  REFUNDS: 'Refunds',
  OFFICE: 'Office',
  LEGAL_REGISTRATION: 'Legal & registration',
  SUPPLIES: 'Supplies',
  MISC: 'Miscellaneous',
}
export const EXPENSE_CATEGORY_ORDER = Object.keys(EXPENSE_CATEGORY_LABELS)

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASHAPP: 'Cash App',
  BANK_TRANSFER: 'Bank transfer',
  CHECK: 'Check',
  OTHER: 'Other',
}
export const PAYMENT_METHOD_ORDER = Object.keys(PAYMENT_METHOD_LABELS)

export const EXPENSE_STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted',
  NEEDS_REVIEW: 'Needs review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REIMBURSED: 'Reimbursed',
}
export const EXPENSE_STATUS_COLORS: Record<string, string> = {
  SUBMITTED: '#6B7280',
  NEEDS_REVIEW: '#F59E0B',
  APPROVED: '#10B981',
  REJECTED: '#EF4444',
  REIMBURSED: '#3B82F6',
}

// ── Owner's organized category headings (11 groups over the 18 stored values) ─
// Each detailed category belongs to exactly one group. The dropdown renders
// these as <optgroup>s; the table shows the group as the "Category" column so
// both owners read the same clean taxonomy.
export interface CategoryGroup {
  key: string
  label: string
  categories: string[] // detailed ExpenseCategory values in this group
}

export const EXPENSE_CATEGORY_GROUPS: CategoryGroup[] = [
  { key: 'MOVING_EQUIPMENT', label: 'Moving Equipment', categories: ['MOVING_EQUIPMENT', 'STRAPS_DOLLIES'] },
  { key: 'MOVING_SUPPLIES', label: 'Moving Supplies', categories: ['MOVING_BLANKETS', 'SUPPLIES'] },
  { key: 'CREW_FOOD', label: 'Crew Food & Drinks', categories: ['CREW_FOOD'] },
  { key: 'TRUCK_TRANSPORT', label: 'Truck & Transportation', categories: ['TRUCK_RENTAL', 'TOLLS', 'PARKING'] },
  { key: 'FUEL', label: 'Fuel', categories: ['GAS'] },
  { key: 'MARKETING', label: 'Marketing', categories: ['ADVERTISING'] },
  { key: 'SOFTWARE', label: 'Software & Subscriptions', categories: ['WEBSITE_SOFTWARE'] },
  { key: 'PAYROLL', label: 'Payroll', categories: ['WORKER_PAY'] },
  { key: 'REFUNDS', label: 'Refunds', categories: ['REFUNDS'] },
  { key: 'OFFICE_ADMIN', label: 'Office & Administrative', categories: ['OFFICE', 'LEGAL_REGISTRATION', 'INSURANCE', 'PHONE'] },
  { key: 'OTHER', label: 'Other', categories: ['MISC'] },
]

// category value -> its group (built once from the source of truth above).
const CATEGORY_TO_GROUP: Record<string, CategoryGroup> = (() => {
  const m: Record<string, CategoryGroup> = {}
  for (const g of EXPENSE_CATEGORY_GROUPS) for (const c of g.categories) m[c] = g
  return m
})()

/** The owner-facing group heading for a stored category (e.g. GAS -> "Fuel"). */
export function categoryGroupLabel(category: string | null | undefined): string {
  if (!category) return '—'
  return CATEGORY_TO_GROUP[category]?.label ?? EXPENSE_CATEGORY_LABELS[category] ?? category
}
/** The group key for a stored category, used by the group filter. */
export function categoryGroupKey(category: string | null | undefined): string | null {
  if (!category) return null
  return CATEGORY_TO_GROUP[category]?.key ?? null
}

// ── Subcategory suggestions (datalist hints; the field stays free-form) ──────
export const SUBCATEGORY_SUGGESTIONS: Record<string, string[]> = {
  MOVING_EQUIPMENT: ['Dollies', 'Hand Trucks', 'Furniture Dolly', 'Moving Straps', 'Ramps'],
  STRAPS_DOLLIES: ['Straps', 'Ratchet Straps', 'Dollies', 'Hand Trucks'],
  MOVING_BLANKETS: ['Blankets', 'Furniture Pads'],
  SUPPLIES: ['Packing Supplies', 'Boxes', 'Tape', 'Shrink Wrap', 'Bubble Wrap'],
  CREW_FOOD: ['Meals', 'Water & Electrolytes', 'Snacks', 'Coffee'],
  TRUCK_RENTAL: ['U-Haul', 'Truck Rental', 'Trailer'],
  TOLLS: ['Toll'],
  PARKING: ['Parking'],
  GAS: ['Fuel', 'Diesel'],
  ADVERTISING: ['Facebook Ads', 'Google Ads', 'Flyers', 'Yard Signs', 'Door Hangers'],
  WEBSITE_SOFTWARE: ['Hosting', 'Domain', 'SaaS Subscription'],
  INSURANCE: ['Liability Insurance', 'Auto Insurance'],
  PHONE: ['Phone Plan'],
  WORKER_PAY: ['Non-crew Helper'],
  REFUNDS: ['Customer Refund'],
  OFFICE: ['Office Supplies', 'Printing'],
  LEGAL_REGISTRATION: ['LLC Registration', 'Permits', 'Licensing'],
  MISC: [],
}

/** Every subcategory suggestion, de-duped — used as a global datalist fallback. */
export const ALL_SUBCATEGORY_SUGGESTIONS: string[] = Array.from(
  new Set(Object.values(SUBCATEGORY_SUGGESTIONS).flat()),
).sort()

// ── Who paid (constrained: the two owners or the business) ───────────────────
export const PAID_BY_OPTIONS = ['Diego', 'Sebastian', 'Business'] as const
export type PaidBy = (typeof PAID_BY_OPTIONS)[number]

// ── Display helpers ──────────────────────────────────────────────────────────

/** The prominent Item Title. Falls back to the category label for legacy rows
 *  that pre-date the title field, so the table never renders a blank name. */
export function expenseDisplayTitle(e: { itemTitle?: string | null; category: string }): string {
  const t = e.itemTitle?.trim()
  if (t) return t
  return EXPENSE_CATEGORY_LABELS[e.category] ?? e.category
}

/** True when there's a substantive note to reveal in the details drawer. */
export function hasNotes(e: { notes?: string | null }): boolean {
  return !!e.notes && e.notes.trim().length > 0
}

// ── Sorting (pure comparator so the client table + tests share one order) ────
export type ExpenseSortKey =
  | 'date' | 'title' | 'category' | 'vendor' | 'amount' | 'method' | 'paidBy' | 'job' | 'status'
export type SortDir = 'asc' | 'desc'

export interface SortableExpense {
  itemTitle?: string | null
  category: string
  vendor?: string | null
  amount: number
  paymentMethod?: string | null
  paidBy?: string | null
  incurredOn: string // ISO
  status: string
  jobLabel?: string | null // resolved related-job display name, null = general
}

const STATUS_RANK: Record<string, number> = { NEEDS_REVIEW: 0, SUBMITTED: 1, APPROVED: 2, REIMBURSED: 3, REJECTED: 4 }

/** Field value for a sort key, normalized for comparison. Strings lowercased;
 *  empty/null pushed to the end regardless of direction. */
function sortValue(e: SortableExpense, key: ExpenseSortKey): number | string | null {
  switch (key) {
    case 'date': return e.incurredOn
    case 'amount': return e.amount
    case 'title': return expenseDisplayTitle(e).toLowerCase()
    case 'category': return categoryGroupLabel(e.category).toLowerCase()
    case 'vendor': return e.vendor?.trim().toLowerCase() || null
    case 'method': return e.paymentMethod ? (PAYMENT_METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod).toLowerCase() : null
    case 'paidBy': return e.paidBy?.trim().toLowerCase() || null
    case 'job': return e.jobLabel?.trim().toLowerCase() || null
    case 'status': return STATUS_RANK[e.status] ?? 99
  }
}

export function compareExpenses(a: SortableExpense, b: SortableExpense, key: ExpenseSortKey, dir: SortDir): number {
  const va = sortValue(a, key)
  const vb = sortValue(b, key)
  // Nulls always sort last, no matter the direction.
  if (va === null && vb === null) return 0
  if (va === null) return 1
  if (vb === null) return -1
  let cmp: number
  if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
  else cmp = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0
  return dir === 'asc' ? cmp : -cmp
}

/** Returns a new sorted array (does not mutate input). */
export function sortExpenses<T extends SortableExpense>(rows: T[], key: ExpenseSortKey, dir: SortDir): T[] {
  return [...rows].sort((a, b) => compareExpenses(a, b, key, dir))
}
