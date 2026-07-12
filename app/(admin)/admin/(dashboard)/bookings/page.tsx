import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'

export const revalidate = 30

const STATUS_OPTIONS = [
  'ALL', 'DRAFT', 'PENDING_PAYMENT', 'PENDING_APPROVAL',
  'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED', 'CANCELLED',
]

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9CA3AF',
  PENDING_PAYMENT: '#F59E0B',
  PENDING_APPROVAL: '#EF4444',
  CONFIRMED: '#3B82F6',
  SCHEDULED: '#6366F1',
  IN_PROGRESS: '#F59E0B',
  COMPLETED: '#10B981',
  ARCHIVED: '#6B7280',
  CANCELLED: '#374151',
}

async function getBookings(status?: string, search?: string, page = 1) {
  const where: Record<string, unknown> = {}

  if (status && status !== 'ALL') where.status = status
  if (search) {
    where.OR = [
      { customer: { name: { contains: search, mode: 'insensitive' } } },
      { customer: { email: { contains: search, mode: 'insensitive' } } },
      { customer: { phone: { contains: search } } },
      { originAddress: { contains: search, mode: 'insensitive' } },
    ]
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: { customer: { select: { name: true, email: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 25,
      take: 25,
    }),
    prisma.booking.count({ where }),
  ])

  return { bookings, total, pages: Math.ceil(total / 25) }
}

export default async function AdminBookings({
  searchParams,
}: {
  searchParams: { status?: string; q?: string; page?: string }
}) {
  await getSession()
  const status = searchParams.status ?? 'ALL'
  const search = searchParams.q ?? ''
  const page = parseInt(searchParams.page ?? '1', 10)
  const { bookings, total, pages } = await getBookings(status, search, page)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={h1}>Bookings</h1>
          <p style={subtitle}>{total} total bookings</p>
        </div>
      </div>

      {/* Filters */}
      <div style={filterBar}>
        <form method="GET" style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            name="q"
            defaultValue={search}
            placeholder="Search name, email, phone, address…"
            style={searchInput}
          />
          <select name="status" defaultValue={status} style={selectStyle}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? 'All Statuses' : s.replace('_', ' ')}</option>
            ))}
          </select>
          <button type="submit" style={filterBtn}>Filter</button>
          {(search || status !== 'ALL') && (
            <Link href="/admin/bookings" style={{ fontSize: '13px', color: '#6B7280' }}>Clear</Link>
          )}
        </form>
      </div>

      {/* Table */}
      <div style={tableWrap}>
        {bookings.length === 0 ? (
          <p style={empty}>No bookings match your filters.</p>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                {['Date Created', 'Customer', 'Route', 'Scheduled', 'Status', 'Actions'].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} style={tr}>
                  <td style={td}>{new Date(b.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td style={td}>
                    <div style={{ fontWeight: '500', color: '#0A1628' }}>{b.customer.name}</div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{b.customer.email}</div>
                  </td>
                  <td style={td}>
                    <div style={{ fontSize: '12px' }}>{b.originAddress.split(',')[0]}</div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>→ {b.destAddress.split(',')[0]}</div>
                  </td>
                  <td style={td}>
                    {b.scheduledStart
                      ? new Date(b.scheduledStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
                      : <span style={{ color: '#9CA3AF' }}>—</span>}
                  </td>
                  <td style={td}>
                    <span style={{ ...badge, backgroundColor: STATUS_COLORS[b.status] ?? '#9CA3AF' }}>
                      {b.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={td}>
                    <Link href={`/admin/jobs/${b.id}`} style={{ color: '#FF5A1F', fontSize: '13px', fontWeight: '500' }}>
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '24px' }}>
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/admin/bookings?status=${status}&q=${search}&page=${p}`}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '13px',
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

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0' }
const filterBar: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '16px', marginBottom: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const searchInput: React.CSSProperties = { padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', minWidth: '260px', outline: 'none' }
const selectStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', outline: 'none', backgroundColor: '#FFFFFF' }
const filterBtn: React.CSSProperties = { padding: '8px 20px', backgroundColor: '#FF5A1F', color: '#FFFFFF', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const badge: React.CSSProperties = { color: '#FFFFFF', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
const empty: React.CSSProperties = { padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px', fontStyle: 'italic', margin: '0' }
