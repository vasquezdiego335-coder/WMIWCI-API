import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'

export const revalidate = 60

export default async function AdminCustomers({
  searchParams,
}: {
  searchParams: { q?: string; page?: string }
}) {
  await getSession()

  const q = searchParams.q ?? ''
  const page = parseInt(searchParams.page ?? '1', 10)

  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
          { phone: { contains: q } },
        ],
      }
    : {}

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      include: {
        _count: { select: { bookings: true } },
        bookings: {
          where: { status: { notIn: ['DRAFT', 'CANCELLED'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, createdAt: true, scheduledStart: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 25,
      take: 25,
    }),
    prisma.customer.count({ where }),
  ])

  const pages = Math.ceil(total / 25)

  return (
    <div>
      <h1 style={h1}>Customers</h1>
      <p style={subtitle}>{total} customers</p>

      {/* Search */}
      <div style={filterBar}>
        <form method="GET" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name, email, or phone…"
            style={searchInput}
          />
          <button type="submit" style={filterBtn}>Search</button>
          {q && <Link href="/admin/customers" style={{ fontSize: '13px', color: '#6B7280' }}>Clear</Link>}
        </form>
      </div>

      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {['Customer', 'Phone', 'Bookings', 'Last Booking', 'First-time', 'Actions'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...td, textAlign: 'center', color: '#9CA3AF', fontStyle: 'italic', padding: '40px' }}>
                  No customers found.
                </td>
              </tr>
            ) : customers.map((c) => {
              const last = c.bookings[0]
              return (
                <tr key={c.id} style={tr}>
                  <td style={td}>
                    <div style={{ fontWeight: '500', color: '#0A1628' }}>{c.name}</div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{c.email}</div>
                  </td>
                  <td style={td}>{c.phone ?? '—'}</td>
                  <td style={{ ...td, fontWeight: '600', textAlign: 'center' }}>{c._count.bookings}</td>
                  <td style={td}>
                    {last ? (
                      <div>
                        <div style={{ fontSize: '12px' }}>
                          {last.scheduledStart
                            ? new Date(last.scheduledStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
                            : new Date(last.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                        <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{last.status.replace(/_/g, ' ')}</div>
                      </div>
                    ) : '—'}
                  </td>
                  <td style={td}>
                    {c.isFirstTime
                      ? <span style={{ fontSize: '11px', backgroundColor: '#EDE9FE', color: '#5B21B6', padding: '3px 8px', borderRadius: '100px', fontWeight: '600' }}>First-time</span>
                      : <span style={{ fontSize: '12px', color: '#9CA3AF' }}>Repeat</span>
                    }
                  </td>
                  <td style={td}>
                    {last && (
                      <Link href={`/admin/jobs/${last.id}`} style={{ color: '#FF5A1F', fontSize: '12px' }}>
                        Last booking →
                      </Link>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '24px' }}>
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/admin/customers?q=${q}&page=${p}`}
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

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0 0 24px' }
const filterBar: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '16px', marginBottom: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const searchInput: React.CSSProperties = { padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', minWidth: '280px', outline: 'none' }
const filterBtn: React.CSSProperties = { padding: '8px 20px', backgroundColor: '#FF5A1F', color: '#FFFFFF', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
