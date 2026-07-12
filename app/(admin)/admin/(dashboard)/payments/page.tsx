import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { PaymentStatus } from '@prisma/client'
import Link from 'next/link'

export const revalidate = 30

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: '#10B981',
  FAILED: '#EF4444',
  REFUNDED: '#6B7280',
  PENDING: '#F59E0B',
}

export default async function AdminPayments({
  searchParams,
}: {
  searchParams: { status?: string; page?: string }
}) {
  await getSession()

  const status = searchParams.status ?? 'ALL'
  const page = parseInt(searchParams.page ?? '1', 10)

  const where = status !== 'ALL' ? { status: status as PaymentStatus } : {}

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        booking: {
          include: { customer: { select: { name: true, email: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 25,
      take: 25,
    }),
    prisma.payment.count({ where }),
  ])

  // isInternalTest=false: owner checkout tests stay visible in the list (with a
  // TEST badge) but NEVER count toward collected/refunded/net revenue.
  const [completedAgg, refundedAgg] = await Promise.all([
    prisma.payment.aggregate({ where: { status: 'COMPLETED', isInternalTest: false }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { status: 'REFUNDED', isInternalTest: false }, _sum: { amount: true } }),
  ])

  const totalRevenue = (completedAgg._sum.amount ?? 0) / 100
  const totalRefunded = (refundedAgg._sum.amount ?? 0) / 100
  const pages = Math.ceil(total / 25)

  return (
    <div>
      <h1 style={h1}>Payments</h1>
      <p style={subtitle}>{total} transactions</p>

      {/* Summary cards */}
      <div style={statsGrid}>
        <StatCard label="Total Collected" value={`$${totalRevenue.toFixed(2)}`} color="#10B981" />
        <StatCard label="Total Refunded" value={`$${totalRefunded.toFixed(2)}`} color="#EF4444" />
        <StatCard label="Net Revenue" value={`$${(totalRevenue - totalRefunded).toFixed(2)}`} color="#6366F1" />
      </div>

      {/* Status filter */}
      <div style={filterBar}>
        <form method="GET" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {['ALL', 'COMPLETED', 'FAILED', 'REFUNDED', 'PENDING'].map((s) => (
            <Link
              key={s}
              href={`/admin/payments?status=${s}`}
              style={{
                padding: '6px 14px',
                borderRadius: '100px',
                fontSize: '12px',
                fontWeight: '600',
                textDecoration: 'none',
                backgroundColor: status === s ? '#0A1628' : '#F3F4F6',
                color: status === s ? '#FFFFFF' : '#6B7280',
              }}
            >
              {s === 'ALL' ? 'All' : s}
            </Link>
          ))}
        </form>
      </div>

      {/* Table */}
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {['Date', 'Customer', 'Amount', 'Status', 'Booking', 'Stripe PI'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...td, textAlign: 'center', color: '#9CA3AF', fontStyle: 'italic', padding: '40px' }}>
                  No payments found.
                </td>
              </tr>
            ) : payments.map((p) => (
              <tr key={p.id} style={tr}>
                <td style={td}>{new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td style={td}>
                  <div style={{ fontWeight: '500', color: '#0A1628' }}>{p.booking.customer.name}</div>
                  <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{p.booking.customer.email}</div>
                </td>
                <td style={{ ...td, fontWeight: '600', color: p.status === 'REFUNDED' ? '#EF4444' : '#0A1628' }}>
                  {p.status === 'REFUNDED' ? '-' : ''}${(p.amount / 100).toFixed(2)}
                </td>
                <td style={td}>
                  <span style={{ ...badge, backgroundColor: STATUS_COLORS[p.status] ?? '#9CA3AF' }}>
                    {p.status}
                  </span>
                  {p.isInternalTest && (
                    <span style={{ ...badge, backgroundColor: '#6B7280', marginLeft: '6px' }} title="Internal checkout test — excluded from revenue">TEST</span>
                  )}
                </td>
                <td style={td}>
                  <Link href={`/admin/jobs/${p.bookingId}`} style={{ color: '#FF5A1F', fontSize: '12px' }}>
                    View →
                  </Link>
                </td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px', color: '#9CA3AF' }}>
                  {p.stripePaymentIntentId?.slice(0, 20)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '24px' }}>
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/admin/payments?status=${status}&page=${p}`}
              style={{
                padding: '6px 12px', borderRadius: '6px', fontSize: '13px',
                fontWeight: p === page ? '700' : '400',
                backgroundColor: p === page ? '#FF5A1F' : '#FFFFFF',
                color: p === page ? '#FFFFFF' : '#374151',
                textDecoration: 'none',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
              }}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <p style={{ fontSize: '12px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
      <p style={{ fontSize: '28px', fontWeight: '700', color, margin: '0' }}>{value}</p>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0 0 24px' }
const statsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }
const filterBar: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '16px', marginBottom: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const badge: React.CSSProperties = { color: '#FFFFFF', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em' }
