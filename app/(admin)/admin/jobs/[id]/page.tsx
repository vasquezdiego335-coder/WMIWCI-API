import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Link from 'next/link'
// BookingActions is a client component in the same directory
// eslint-disable-next-line @typescript-eslint/no-var-requires
import BookingActions from './BookingActions'

export const revalidate = 0

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9CA3AF', PENDING_PAYMENT: '#F59E0B', PENDING_APPROVAL: '#EF4444',
  CONFIRMED: '#3B82F6', SCHEDULED: '#6366F1', IN_PROGRESS: '#F59E0B',
  COMPLETED: '#10B981', ARCHIVED: '#6B7280', CANCELLED: '#374151',
}

export default async function JobDetail({ params }: { params: { id: string } }) {
  await getSession()

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: {
      customer: true,
      payments: { orderBy: { createdAt: 'desc' } },
      job: { include: { crew: { include: { user: { select: { name: true, role: true } } } } } },
      files: { orderBy: { createdAt: 'desc' } },
      receipt: true,
      notifications: { orderBy: { createdAt: 'desc' }, take: 10 },
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 30, include: { user: { select: { name: true } } } },
    },
  })

  if (!booking) notFound()

  const totalPaid = booking.payments
    .filter((p) => p.status === 'COMPLETED')
    .reduce((sum, p) => sum + p.amount, 0)

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '28px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
            <Link href="/admin/bookings" style={{ color: '#6B7280', fontSize: '13px', textDecoration: 'none' }}>← Bookings</Link>
          </div>
          <h1 style={h1}>{booking.customer.name}</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ ...statusBadge, backgroundColor: STATUS_COLORS[booking.status] ?? '#9CA3AF' }}>
              {booking.status.replace(/_/g, ' ')}
            </span>
            <span style={{ fontSize: '12px', color: '#9CA3AF' }}>ID: {booking.id.slice(0, 8)}…</span>
          </div>
        </div>
        <BookingActions bookingId={booking.id} status={booking.status} />
      </div>

      <div style={grid}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Customer */}
          <Section title="Customer">
            <Row label="Name" value={booking.customer.name} />
            <Row label="Email" value={booking.customer.email} />
            <Row label="Phone" value={booking.customer.phone ?? '—'} />
            <Row label="First-time" value={booking.customer.isFirstTime ? 'Yes' : 'No'} />
          </Section>

          {/* Job Details */}
          <Section title="Job Details">
            <Row label="From" value={booking.originAddress} />
            <Row label="To" value={booking.destAddress} />
            <Row label="Origin floor" value={booking.originFloor != null ? String(booking.originFloor) : '—'} />
            <Row label="Dest floor" value={booking.destFloor != null ? String(booking.destFloor) : '—'} />
            <Row label="Items" value={booking.itemsDescription ?? '—'} />
            <Row label="Est. hours" value={booking.estimatedHours ? `${booking.estimatedHours}h` : '—'} />
            <Row label="Base rate" value={booking.baseRate ? `$${(booking.baseRate / 100).toFixed(2)}/hr` : '—'} />
          </Section>

          {/* Schedule */}
          <Section title="Schedule">
            <Row label="Requested date" value={booking.requestedDate ? new Date(booking.requestedDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '—'} />
            <Row label="Confirmed date" value={booking.confirmedDate ? new Date(booking.confirmedDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '—'} />
            <Row label="Scheduled start" value={booking.scheduledStart ? new Date(booking.scheduledStart).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'} />
            <Row label="Scheduled end" value={booking.scheduledEnd ? new Date(booking.scheduledEnd).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'} />
          </Section>

          {/* Internal Notes */}
          <Section title="Internal Notes">
            <InternalNotesForm bookingId={booking.id} defaultValue={booking.internalNotes ?? ''} />
          </Section>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Payment */}
          <Section title="Payment">
            <Row label="Booking fee" value={`$${((booking.depositAmount ?? 4900) / 100).toFixed(2)}`} />
            {booking.discountType && (
              <Row label="Discount" value={`${booking.discountType.replace(/_/g, ' ')} — ${booking.discountPercent ?? 0}% off`} />
            )}
            <Row label="Total collected" value={`$${(totalPaid / 100).toFixed(2)}`} />
            <div style={{ marginTop: '12px', borderTop: '1px solid #F3F4F6', paddingTop: '12px' }}>
              {booking.payments.map((p) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6B7280', marginBottom: '6px' }}>
                  <span>{new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  <span style={{ color: p.status === 'COMPLETED' ? '#10B981' : '#EF4444', fontWeight: '600' }}>
                    {p.status === 'COMPLETED' ? '+' : ''}{p.status === 'REFUNDED' ? '−' : ''} ${(p.amount / 100).toFixed(2)} · {p.status}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {/* Crew */}
          {booking.job && (
            <Section title="Crew">
              <Row label="Job status" value={booking.job.status} />
              {booking.job.startedAt && <Row label="Started" value={new Date(booking.job.startedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} />}
              {booking.job.completedAt && <Row label="Completed" value={new Date(booking.job.completedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} />}
              {booking.job.crew.length > 0 ? (
                <div style={{ marginTop: '8px' }}>
                  {booking.job.crew.map((c) => (
                    <div key={c.id} style={{ fontSize: '13px', color: '#374151', padding: '4px 0' }}>
                      {c.user.name} <span style={{ color: '#9CA3AF' }}>· {c.user.role}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: '13px', color: '#9CA3AF', margin: '8px 0 0', fontStyle: 'italic' }}>No crew assigned yet</p>
              )}
            </Section>
          )}

          {/* Files */}
          <Section title={`Files (${booking.files.length})`}>
            {booking.files.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#9CA3AF', fontStyle: 'italic', margin: '0' }}>No files uploaded</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {booking.files.map((f) => (
                  <a key={f.id} href={f.cloudinaryUrl} target="_blank" rel="noreferrer" style={{ fontSize: '13px', color: '#FF5A1F', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>📎 {f.filename ?? f.type}</span>
                    <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{new Date(f.createdAt).toLocaleDateString()}</span>
                  </a>
                ))}
              </div>
            )}
          </Section>

          {/* Receipt */}
          {booking.receipt && (
            <Section title="Receipt">
              <Row label="Sent" value={booking.receipt.sentAt ? new Date(booking.receipt.sentAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'Pending'} />
              {booking.receipt.cloudinaryUrl && (
                <a href={booking.receipt.cloudinaryUrl} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: '8px', fontSize: '13px', color: '#FF5A1F' }}>
                  View receipt PDF →
                </a>
              )}
              <ResendReceiptButton bookingId={booking.id} />
            </Section>
          )}

          {/* Discord */}
          {booking.discordJobChannelId && (
            <Section title="Discord">
              <Row label="Job channel" value={`#${booking.discordJobChannelId}`} />
              {booking.discordPaperworkChannelId && <Row label="Paperwork channel" value={`#${booking.discordPaperworkChannelId}`} />}
              {booking.discordPhotosChannelId && <Row label="Photos channel" value={`#${booking.discordPhotosChannelId}`} />}
            </Section>
          )}
        </div>
      </div>

      {/* Audit Log */}
      <Section title="Audit Log" style={{ marginTop: '20px' }}>
        {booking.auditLogs.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#9CA3AF', fontStyle: 'italic', margin: '0' }}>No activity yet</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
            {booking.auditLogs.map((log, i) => (
              <div key={log.id} style={{ display: 'flex', gap: '16px', padding: '10px 0', borderBottom: i < booking.auditLogs.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                <span style={{ fontSize: '11px', color: '#9CA3AF', whiteSpace: 'nowrap', paddingTop: '1px' }}>
                  {new Date(log.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}
                </span>
                <div>
                  <span style={{ fontSize: '12px', fontWeight: '600', color: '#374151' }}>{log.action.replace(/_/g, ' ')}</span>
                  {log.user && <span style={{ fontSize: '11px', color: '#9CA3AF' }}> · {log.user.name}</span>}
                  {log.details && typeof log.details === 'object' && (
                    <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '2px', fontFamily: 'monospace', backgroundColor: '#F9FAFB', padding: '4px 8px', borderRadius: '4px' }}>
                      {JSON.stringify(log.details)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', ...style }}>
      <h3 style={{ fontSize: '13px', fontWeight: '700', color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '16px' }}>
      <span style={{ fontSize: '12px', color: '#9CA3AF', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: '#374151', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

// These are Client Components embedded in this server component file
// They're declared here for colocation but must be in separate files in production
// For now they render as plain forms that POST to API routes
function InternalNotesForm({ bookingId, defaultValue }: { bookingId: string; defaultValue: string }) {
  return (
    <form action={`/api/admin/bookings/${bookingId}`} method="PATCH" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea
        name="internalNotes"
        defaultValue={defaultValue}
        rows={4}
        style={{ width: '100%', padding: '8px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
        placeholder="Add internal notes visible only to staff…"
      />
      <button type="submit" style={{ alignSelf: 'flex-end', padding: '6px 16px', backgroundColor: '#0A1628', color: '#FFFFFF', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
        Save notes
      </button>
    </form>
  )
}

function ResendReceiptButton({ bookingId }: { bookingId: string }) {
  return (
    <form action={`/api/admin/receipts/${bookingId}/resend`} method="POST" style={{ marginTop: '12px' }}>
      <button type="submit" style={{ padding: '6px 14px', backgroundColor: '#F3F4F6', color: '#374151', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
        Resend receipt email
      </button>
    </form>
  )
}

const h1: React.CSSProperties = { fontSize: '22px', fontWeight: '700', color: '#0A1628', margin: '0 0 8px' }
const statusBadge: React.CSSProperties = { color: '#FFFFFF', fontSize: '11px', fontWeight: '700', padding: '4px 10px', borderRadius: '100px', letterSpacing: '0.04em' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }

