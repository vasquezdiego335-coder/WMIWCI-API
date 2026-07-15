import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { fmtCents } from '@/lib/profit'
import { categoryGroupKey, EXPENSE_CATEGORY_GROUPS, PAID_BY_OPTIONS, PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/expense-format'
import { PageHeader, StatCard, StatGrid, COLORS, Empty, tableStyles as T } from '../_ui'
import { EXPENSE_STATUS_LABELS } from '../_labels'
import ExpenseForm from '../ExpenseForm'
import ExpenseTable, { type ExpenseRow } from './ExpenseTable'

export const dynamic = 'force-dynamic'

// ── Month helpers (America/New_York so "this month" matches the owner's clock) ──
function monthRange(monthParam?: string) {
  const now = new Date()
  const [y, m] = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? monthParam.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1]
  const start = new Date(y, m - 1, 1)
  const end = new Date(y, m, 1)
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const key = `${y}-${String(m).padStart(2, '0')}`
  return { start, end, label, key }
}

interface Params {
  month?: string; group?: string; status?: string; scope?: string; paidBy?: string; vendor?: string; method?: string
}

export default async function ExpensesPage({ searchParams }: { searchParams: Params }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const { start, end, label, key } = monthRange(searchParams.month)

  const monthExpenses = await prisma.expense.findMany({
    where: { incurredOn: { gte: start, lt: end } },
    include: { booking: { select: { id: true, displayId: true, customer: { select: { name: true } } } } },
    orderBy: { incurredOn: 'desc' },
  })

  // Stats reflect the whole month; the table reflects the active filters.
  const monthTotal = monthExpenses.reduce((s, e) => s + e.amount, 0)
  const jobTotal = monthExpenses.filter((e) => e.bookingId).reduce((s, e) => s + e.amount, 0)
  const generalTotal = monthTotal - jobTotal
  const needsReview = monthExpenses.filter((e) => e.status === 'SUBMITTED' || e.status === 'NEEDS_REVIEW').length

  const vendorQuery = searchParams.vendor?.trim().toLowerCase()
  const filtered = monthExpenses.filter((e) => {
    if (searchParams.group && categoryGroupKey(e.category) !== searchParams.group) return false
    if (searchParams.status && e.status !== searchParams.status) return false
    if (searchParams.scope === 'job' && !e.bookingId) return false
    if (searchParams.scope === 'general' && e.bookingId) return false
    if (searchParams.paidBy && (e.paidBy ?? '') !== searchParams.paidBy) return false
    if (searchParams.method && (e.paymentMethod ?? '') !== searchParams.method) return false
    if (vendorQuery && !(e.vendor ?? '').toLowerCase().includes(vendorQuery)) return false
    return true
  })

  const rows: ExpenseRow[] = filtered.map((e) => ({
    id: e.id,
    itemTitle: e.itemTitle,
    amount: e.amount,
    incurredOn: e.incurredOn.toISOString(),
    category: e.category,
    subcategory: e.subcategory,
    vendor: e.vendor,
    paymentMethod: e.paymentMethod,
    paidBy: e.paidBy,
    bookingId: e.bookingId,
    purpose: e.purpose,
    receiptUrl: e.receiptUrl,
    receiptPublicId: e.receiptPublicId,
    reimbursable: e.reimbursable,
    status: e.status,
    notes: e.notes,
    createdByName: e.createdByName,
    updatedByName: e.updatedByName,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    job: e.booking ? { id: e.booking.id, label: e.booking.customer?.name ?? e.booking.displayId } : null,
    jobLabel: e.booking ? (e.booking.customer?.name ?? e.booking.displayId) : null,
  }))

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Every cost the business paid. Job-linked expenses reduce that job's profit; general expenses reduce monthly business profit."
      />

      <ExpenseForm />

      <StatGrid>
        <StatCard label={`Total · ${label}`} value={fmtCents(monthTotal)} accent={COLORS.navy} sub={`${monthExpenses.length} expense${monthExpenses.length === 1 ? '' : 's'}`} />
        <StatCard label="Job-linked" value={fmtCents(jobTotal)} accent={COLORS.orange} sub="reduces job profit" />
        <StatCard label="General business" value={fmtCents(generalTotal)} accent={COLORS.gold} sub="Railway, ads, insurance…" />
        <StatCard label="Needs review" value={String(needsReview)} accent={needsReview > 0 ? COLORS.amber : COLORS.green} sub={needsReview > 0 ? 'awaiting approval' : 'all reviewed'} />
      </StatGrid>

      {/* Filter bar — plain GET form, so filters survive a reload / bookmark */}
      <form method="get" style={filterBar}>
        <input type="month" name="month" defaultValue={key} style={filterInput} />
        <select name="scope" defaultValue={searchParams.scope ?? ''} style={filterInput}>
          <option value="">All expenses</option>
          <option value="job">Job-linked only</option>
          <option value="general">General only</option>
        </select>
        <select name="group" defaultValue={searchParams.group ?? ''} style={filterInput}>
          <option value="">All categories</option>
          {EXPENSE_CATEGORY_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
        <select name="paidBy" defaultValue={searchParams.paidBy ?? ''} style={filterInput}>
          <option value="">Anyone paid</option>
          {PAID_BY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select name="method" defaultValue={searchParams.method ?? ''} style={filterInput}>
          <option value="">Any method</option>
          {PAYMENT_METHOD_ORDER.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
        </select>
        <select name="status" defaultValue={searchParams.status ?? ''} style={filterInput}>
          <option value="">Any status</option>
          {Object.entries(EXPENSE_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input name="vendor" defaultValue={searchParams.vendor ?? ''} placeholder="Vendor…" style={{ ...filterInput, minWidth: 120 }} />
        <button type="submit" style={filterBtn}>Apply</button>
        <Link href="/admin/expenses" style={{ fontSize: '12px', color: COLORS.muted, alignSelf: 'center' }}>Reset</Link>
      </form>

      {rows.length === 0 ? (
        <div style={{ ...T.wrap, padding: '28px' }}><Empty>No expenses match these filters for {label}.</Empty></div>
      ) : (
        <ExpenseTable rows={rows} isOwner={!!isOwner} />
      )}
    </div>
  )
}

const filterBar: React.CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px', alignItems: 'center' }
const filterInput: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', backgroundColor: '#fff', fontFamily: 'inherit' }
const filterBtn: React.CSSProperties = { padding: '8px 16px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
