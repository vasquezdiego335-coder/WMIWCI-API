import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'

export const revalidate = 60 // revalidate every 60 seconds

async function getDashboardData() {
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)

  const [
    todayBookings,
    pendingApproval,
    pendingDiscounts,
    thisMonthRevenue,
    failedPayments,
    totalBookings,
  ] = await Promise.all([
    prisma.booking.findMany({
      where: { scheduledStart: { gte: todayStart, lte: todayEnd }, status: { in: ['SCHEDULED', 'IN_PROGRESS', 'CONFIRMED'] }, isInternalTest: false },
      include: { customer: { select: { name: true, phone: true } } },
      orderBy: { scheduledStart: 'asc' },
    }),
    prisma.booking.count({ where: { status: 'PENDING_APPROVAL', isInternalTest: false } }),
    prisma.booking.count({ where: { discountType: 'DOOR_HANGER_PENDING', isInternalTest: false } }),
    prisma.payment.aggregate({
      // isInternalTest=false: owner checkout tests never count as revenue.
      where: { status: 'COMPLETED', isInternalTest: false, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
      _sum: { amount: true },
    }),
    prisma.payment.count({ where: { status: 'FAILED' } }),
    // REAL operational bookings only. Two exclusions fix the inflated "53":
    //  • PENDING_PAYMENT = abandoned checkout (submitted, Stripe never paid) — not a booking.
    //  • isInternalTest = the owner's own checkout tests (flagged by signal).
    prisma.booking.count({ where: { status: { in: ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] }, isInternalTest: false } }),
  ])

  return { todayBookings, pendingApproval, pendingDiscounts, thisMonthRevenue, failedPayments, totalBookings }
}

export default async function AdminDashboard() {
  const session = await getSession()
  const { todayBookings, pendingApproval, pendingDiscounts, thisMonthRevenue, failedPayments, totalBookings } = await getDashboardData()

  const monthRevenue = ((thisMonthRevenue._sum.amount ?? 0) / 100).toFixed(2)

  return (
    <div>
      <h1 style={h1}>Dashboard</h1>
      <p style={subtitle}>Good morning, {session?.name}. Here's what's happening today.</p>

      {/* Stat cards */}
      <div style={statsGrid}>
        <StatCard label="Today's Jobs" value={todayBookings.length.toString()} color="#FF5A1F" />
        <StatCard label="Pending Approval" value={pendingApproval.toString()} color={pendingApproval > 0 ? '#F59E0B' : '#10B981'} />
        <StatCard label="Discount Requests" value={pendingDiscounts.toString()} color={pendingDiscounts > 0 ? '#EF4444' : '#10B981'} />
        <StatCard label="Revenue This Month" value={`$${monthRevenue}`} color="#10B981" />
        <StatCard label="Failed Payments" value={failedPayments.toString()} color={failedPayments > 0 ? '#EF4444' : '#10B981'} />
        <StatCard label="Total Bookings" value={totalBookings.toString()} color="#6366F1" />
      </div>

      {/* Alerts */}
      {pendingApproval > 0 && (
        <div style={alert}>
          ⚠️ {pendingApproval} booking{pendingApproval > 1 ? 's' : ''} waiting for approval —{' '}
          <Link href="/admin/bookings?status=PENDING_APPROVAL" style={{ color: '#FF5A1F' }}>Review now →</Link>
        </div>
      )}
      {pendingDiscounts > 0 && (
        <div style={{ ...alert, backgroundColor: '#FEF3C7', borderColor: '#F59E0B' }}>
          🏷 {pendingDiscounts} door hanger discount{pendingDiscounts > 1 ? 's' : ''} need approval —{' '}
          <Link href="/admin/discounts" style={{ color: '#FF5A1F' }}>Review →</Link>
        </div>
      )}

      {/* Today's schedule */}
      <h2 style={h2}>Today's Jobs</h2>
      {todayBookings.length === 0 ? (
        <p style={empty}>No jobs scheduled for today.</p>
      ) : (
        <div style={tableWrap}>
          <table style={table}>
            <thead>
              <tr>
                {['Time', 'Customer', 'Phone', 'From → To', 'Status', ''].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {todayBookings.map((b) => (
                <tr key={b.id} style={tr}>
                  <td style={td}>{b.scheduledStart ? new Date(b.scheduledStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'}</td>
                  <td style={td}>{b.customer.name}</td>
                  <td style={td}>{b.customer.phone}</td>
                  <td style={td}>{b.originAddress.split(',')[0]} → {b.destAddress.split(',')[0]}</td>
                  <td style={td}><span style={{ ...badge, backgroundColor: statusColor(b.status) }}>{b.status}</span></td>
                  <td style={td}><Link href={`/admin/jobs/${b.id}`} style={{ color: '#FF5A1F', fontSize: '13px' }}>View →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
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

function statusColor(status: string): string {
  const map: Record<string, string> = {
    CONFIRMED: '#3B82F6', SCHEDULED: '#6366F1', IN_PROGRESS: '#F59E0B',
    COMPLETED: '#10B981', PENDING_APPROVAL: '#EF4444', ARCHIVED: '#6B7280',
  }
  return map[status] ?? '#9CA3AF'
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '14px', color: '#6B7280', margin: '0 0 28px' }
const statsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }
const alert: React.CSSProperties = { backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', color: '#374151', marginBottom: '16px' }
const h2: React.CSSProperties = { fontSize: '18px', fontWeight: '600', color: '#0A1628', margin: '28px 0 16px' }
const empty: React.CSSProperties = { color: '#9CA3AF', fontSize: '14px', fontStyle: 'italic' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const badge: React.CSSProperties = { color: '#FFFFFF', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em' }
