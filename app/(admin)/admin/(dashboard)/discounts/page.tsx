import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'
import DiscountActions from './DiscountActions'

export const revalidate = 0

export default async function AdminDiscounts() {
  const session = await getSession()

  const pending = await prisma.booking.findMany({
    where: { discountType: 'DOOR_HANGER_PENDING' },
    include: { customer: { select: { name: true, email: true, phone: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const recent = await prisma.booking.findMany({
    where: { discountType: { in: ['DOOR_HANGER_APPROVED', 'DOOR_HANGER_DENIED', 'FIRST_TIME_AUTO', 'MANUAL'] }, discountPercent: { not: null } },
    include: { customer: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })

  return (
    <div>
      <h1 style={h1}>Discounts</h1>
      <p style={subtitle}>Manage door hanger promos and first-time customer discounts</p>

      {/* Pending approvals */}
      <h2 style={h2}>Pending Approval</h2>
      {pending.length === 0 ? (
        <div style={emptyCard}>
          <p style={{ fontSize: '14px', color: '#10B981', fontWeight: '600', margin: '0 0 4px' }}>✓ All clear</p>
          <p style={{ fontSize: '13px', color: '#6B7280', margin: '0' }}>No discount requests pending review.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '32px' }}>
          {pending.map((b) => (
            <div key={b.id} style={discountCard}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '8px' }}>
                  <span style={{ ...typeBadge, backgroundColor: '#FEF3C7', color: '#92400E' }}>DOOR HANGER</span>
                  <span style={{ ...typeBadge, backgroundColor: '#FEE2E2', color: '#991B1B' }}>PENDING</span>
                </div>
                <p style={{ fontWeight: '600', color: '#0A1628', fontSize: '15px', margin: '0 0 4px' }}>{b.customer.name}</p>
                <p style={{ fontSize: '12px', color: '#6B7280', margin: '0 0 2px' }}>{b.customer.email} · {b.customer.phone}</p>
                <p style={{ fontSize: '12px', color: '#9CA3AF', margin: '0 0 4px' }}>
                  {b.originAddress.split(',')[0]} → {b.destAddress.split(',')[0]}
                </p>
                {b.customerNotes && (
                  <p style={{ fontSize: '12px', color: '#374151', backgroundColor: '#F9FAFB', padding: '8px', borderRadius: '6px', margin: '0', fontStyle: 'italic' }}>
                    "{b.customerNotes}"
                  </p>
                )}
                <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '8px 0 0' }}>
                  Requested {new Date(b.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              {session?.role === 'OWNER' && (
                <DiscountActions bookingId={b.id} />
              )}
              {session?.role !== 'OWNER' && (
                <p style={{ fontSize: '12px', color: '#9CA3AF', fontStyle: 'italic' }}>Owner approval required</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Recent discounts */}
      <h2 style={h2}>Recent Decisions</h2>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {['Customer', 'Discount Type', 'Discount %', 'Date', 'Booking'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, textAlign: 'center', color: '#9CA3AF', fontStyle: 'italic', padding: '32px' }}>
                  No discount history yet.
                </td>
              </tr>
            ) : recent.map((b) => (
              <tr key={b.id} style={tr}>
                <td style={{ ...td, fontWeight: '500' }}>{b.customer.name}</td>
                <td style={td}>
                  <span style={{
                    ...typeBadge,
                    backgroundColor: b.discountType === 'DOOR_HANGER_APPROVED' ? '#D1FAE5' : b.discountType === 'DOOR_HANGER_DENIED' ? '#FEE2E2' : '#EDE9FE',
                    color: b.discountType === 'DOOR_HANGER_APPROVED' ? '#065F46' : b.discountType === 'DOOR_HANGER_DENIED' ? '#991B1B' : '#5B21B6',
                  }}>
                    {b.discountType?.replace(/_/g, ' ')}
                  </span>
                </td>
                <td style={{ ...td, fontWeight: '600', color: '#10B981' }}>
                  {b.discountPercent ? `${b.discountPercent}%` : '—'}
                </td>
                <td style={td}>{new Date(b.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td style={td}>
                  <Link href={`/admin/jobs/${b.id}`} style={{ color: '#FF5A1F', fontSize: '12px' }}>View →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0 0 28px' }
const h2: React.CSSProperties = { fontSize: '16px', fontWeight: '600', color: '#0A1628', margin: '0 0 16px' }
const emptyCard: React.CSSProperties = { backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '10px', padding: '20px', marginBottom: '32px' }
const discountCard: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', display: 'flex', gap: '20px', alignItems: 'flex-start', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const typeBadge: React.CSSProperties = { fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
