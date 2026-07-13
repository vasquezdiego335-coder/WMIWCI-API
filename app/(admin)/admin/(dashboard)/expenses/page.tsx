import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { fmtCents } from '@/lib/profit'
import { PageHeader, StatCard, StatGrid, COLORS, Empty, tableStyles as T, Badge } from '../_ui'
import { EXPENSE_CATEGORY_LABELS, EXPENSE_CATEGORY_ORDER, EXPENSE_STATUS_LABELS, EXPENSE_STATUS_COLORS, PAYMENT_METHOD_LABELS } from '../_labels'
import ExpenseForm from '../ExpenseForm'
import ExpenseActions from './ExpenseActions'

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
const dateOnly = (d: Date) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })

export default async function ExpensesPage({ searchParams }: { searchParams: { month?: string; category?: string; status?: string; scope?: string } }) {
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

  const filtered = monthExpenses.filter((e) => {
    if (searchParams.category && e.category !== searchParams.category) return false
    if (searchParams.status && e.status !== searchParams.status) return false
    if (searchParams.scope === 'job' && !e.bookingId) return false
    if (searchParams.scope === 'general' && e.bookingId) return false
    return true
  })

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
        <select name="category" defaultValue={searchParams.category ?? ''} style={filterInput}>
          <option value="">All categories</option>
          {EXPENSE_CATEGORY_ORDER.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
        </select>
        <select name="status" defaultValue={searchParams.status ?? ''} style={filterInput}>
          <option value="">Any status</option>
          {Object.entries(EXPENSE_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button type="submit" style={filterBtn}>Apply</button>
        <Link href="/admin/expenses" style={{ fontSize: '12px', color: COLORS.muted, alignSelf: 'center' }}>Reset</Link>
      </form>

      {filtered.length === 0 ? (
        <div style={{ ...T.wrap, padding: '28px' }}><Empty>No expenses match these filters for {label}.</Empty></div>
      ) : (
        <div style={T.wrap}>
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  {['Date', 'Category', 'Vendor', 'Amount', 'Method', 'Paid by', 'Job', 'Receipt', 'Status', ''].map((h) => (
                    <th key={h} style={T.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td style={T.td}>{dateOnly(e.incurredOn)}</td>
                    <td style={T.td}>{EXPENSE_CATEGORY_LABELS[e.category] ?? e.category}</td>
                    <td style={T.td}>{e.vendor ?? '—'}</td>
                    <td style={{ ...T.td, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCents(e.amount)}</td>
                    <td style={T.td}>{e.paymentMethod ? PAYMENT_METHOD_LABELS[e.paymentMethod] : '—'}</td>
                    <td style={T.td}>{e.paidBy ?? '—'}</td>
                    <td style={T.td}>
                      {e.booking ? (
                        <Link href={`/admin/jobs/${e.booking.id}`} style={{ color: COLORS.orange, textDecoration: 'none' }}>
                          {e.booking.customer?.name ?? e.booking.displayId}
                        </Link>
                      ) : (
                        <span style={{ color: COLORS.faint }}>General</span>
                      )}
                    </td>
                    <td style={T.td}>{e.receiptUrl ? <a href={e.receiptUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.orange }}>🧾</a> : '—'}</td>
                    <td style={T.td}><Badge color={EXPENSE_STATUS_COLORS[e.status] ?? COLORS.muted}>{EXPENSE_STATUS_LABELS[e.status] ?? e.status}</Badge></td>
                    <td style={T.td}><ExpenseActions id={e.id} status={e.status} reimbursable={e.reimbursable} canDelete={!!isOwner} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

const filterBar: React.CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px', alignItems: 'center' }
const filterInput: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', backgroundColor: '#fff', fontFamily: 'inherit' }
const filterBtn: React.CSSProperties = { padding: '8px 16px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
