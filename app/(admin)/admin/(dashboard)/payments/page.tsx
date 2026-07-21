import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { PaymentStatus } from '@prisma/client'
import Link from 'next/link'
import { summarizeRevenue, netCollectedCentsOf, refundedCentsOf } from '@/lib/money-rules'
import { fmtCents } from '@/lib/profit'

export const revalidate = 30

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: '#10B981',
  FAILED: '#EF4444',
  REFUNDED: '#6B7280',
  PARTIALLY_REFUNDED: '#F97316',
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

  // PHASE 0 FIX: the old summary was
  //   net = SUM(COMPLETED) − SUM(REFUNDED)
  // which subtracted refunded payments that were never in the COMPLETED total
  // (their status is REFUNDED), and dropped PARTIALLY_REFUNDED rows from BOTH
  // sums — so a $2,000 payment with a $200 refund contributed $0 revenue.
  // Revenue now comes from the same money-rules derivation as the job pages:
  //   captured − actually refunded − lost chargebacks = net collected.
  // isInternalTest rows stay visible in the list (TEST badge) but never count.
  const revenueRows = await prisma.payment.findMany({
    where: { isInternalTest: false },
    select: { amount: true, status: true, isInternalTest: true, refundedAmountCents: true, stripeDisputeId: true, disputeStatus: true },
  })
  const revenue = summarizeRevenue(revenueRows)
  const pages = Math.ceil(total / 25)

  return (
    <div>
      <h1 style={h1}>Payments</h1>
      <p style={subtitle}>{total} transactions</p>

      {/* Summary cards — all-time, cash basis, excludes owner test payments. */}
      <div style={statsGrid}>
        <StatCard label="Captured" value={fmtCents(revenue.grossCapturedCents)} color="#10B981" sub="money that reached the business" />
        <StatCard label="Refunded" value={fmtCents(revenue.refundedCents)} color="#EF4444" sub="actual refunded amounts" />
        <StatCard label="Net Collected Revenue" value={fmtCents(revenue.netCollectedCents)} color="#6366F1" sub="captured − refunds − chargebacks" />
      </div>
      {(revenue.authorizedNotCapturedCents > 0 || revenue.pendingDisputeCents > 0 || revenue.chargebackCents > 0 || revenue.hasUnknownRefund) && (
        <div style={noteBar}>
          {revenue.authorizedNotCapturedCents > 0 && (
            <span>{fmtCents(revenue.authorizedNotCapturedCents)} authorized but not captured — <strong>not revenue</strong>.</span>
          )}
          {revenue.chargebackCents > 0 && <span>{fmtCents(revenue.chargebackCents)} lost to chargebacks.</span>}
          {revenue.pendingDisputeCents > 0 && <span>{fmtCents(revenue.pendingDisputeCents)} disputed and at risk.</span>}
          {revenue.hasUnknownRefund && (
            <span style={{ color: '#B45309', fontWeight: 600 }}>
              ⚠️ At least one partial refund has no recorded amount — net revenue may be overstated.
            </span>
          )}
        </div>
      )}

      {/* Status filter */}
      <div style={filterBar}>
        <form method="GET" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {['ALL', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'PENDING'].map((s) => (
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
              {s === 'ALL' ? 'All' : s.replace(/_/g, ' ')}
            </Link>
          ))}
        </form>
      </div>

      {/* Table */}
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {['Date', 'Customer', 'Captured', 'Refunded', 'Net collected', 'Status', 'Booking', 'Stripe PI'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ ...td, textAlign: 'center', color: '#9CA3AF', fontStyle: 'italic', padding: '40px' }}>
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
                <td style={{ ...td, fontWeight: '600', color: '#0A1628', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtCents(p.amount)}
                </td>
                <td style={{ ...td, color: refundedCentsOf(p) > 0 ? '#EF4444' : '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>
                  {refundedCentsOf(p) > 0 ? `−${fmtCents(refundedCentsOf(p))}` : '—'}
                  {p.status === 'PARTIALLY_REFUNDED' && p.refundedAmountCents == null && (
                    <div style={{ fontSize: '10px', color: '#B45309' }} title="Refund amount was never recorded">amount unknown</div>
                  )}
                </td>
                <td style={{ ...td, fontWeight: '700', color: '#0A1628', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtCents(netCollectedCentsOf(p))}
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

function StatCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <p style={{ fontSize: '12px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
      <p style={{ fontSize: '28px', fontWeight: '700', color, margin: '0' }}>{value}</p>
      {sub && <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '6px 0 0' }}>{sub}</p>}
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0 0 24px' }
const statsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }
const filterBar: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '16px', marginBottom: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const noteBar: React.CSSProperties = { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: '#6B7280', backgroundColor: '#FFFFFF', border: '1px solid #EFEFEF', borderRadius: '10px', padding: '10px 14px', marginBottom: '20px' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const badge: React.CSSProperties = { color: '#FFFFFF', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em' }
