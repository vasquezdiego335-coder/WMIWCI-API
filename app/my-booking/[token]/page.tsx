import { prisma } from '@/lib/db'
import { notFound } from 'next/navigation'
import Link from 'next/link'

export const revalidate = 0

const STATUS_LABELS: Record<string, { label: string; description: string; color: string }> = {
  DRAFT: { label: 'Draft', description: 'Your booking form is incomplete.', color: '#9CA3AF' },
  PENDING_PAYMENT: { label: 'Awaiting Payment', description: 'Complete payment to confirm your booking.', color: '#F59E0B' },
  PENDING_APPROVAL: { label: 'Under Review', description: 'We received your booking and are confirming availability.', color: '#6366F1' },
  CONFIRMED: { label: 'Confirmed', description: 'Your booking is confirmed! We will reach out with final details.', color: '#3B82F6' },
  SCHEDULED: { label: 'Scheduled', description: 'Your move is on the calendar. Our crew is assigned and ready.', color: '#3B82F6' },
  IN_PROGRESS: { label: 'In Progress', description: 'Our crew is on-site working on your move right now.', color: '#F59E0B' },
  COMPLETED: { label: 'Completed', description: 'Your job is done! Thank you for choosing us.', color: '#10B981' },
  CANCELLED: { label: 'Cancelled', description: 'This booking has been cancelled.', color: '#EF4444' },
  ARCHIVED: { label: 'Archived', description: 'This job has been archived.', color: '#6B7280' },
}

export default async function CustomerPortal({ params }: { params: { token: string } }) {
  const booking = await prisma.booking.findFirst({
    where: {
      customerToken: params.token,
      customerTokenExpiry: { gte: new Date() },
    },
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      payments: { select: { amount: true, status: true, createdAt: true } },
      job: { select: { status: true, startedAt: true, completedAt: true } },
      files: { select: { id: true, type: true, filename: true, cloudinaryUrl: true, createdAt: true } },
      receipt: { select: { cloudinaryUrl: true, sentAt: true } },
    },
  })

  if (!booking) notFound()

  const statusInfo = STATUS_LABELS[booking.status] ?? STATUS_LABELS.DRAFT
  const totalPaid = booking.payments.filter((p) => p.status === 'COMPLETED').reduce((s, p) => s + p.amount, 0)
  const canReschedule = ['CONFIRMED', 'SCHEDULED'].includes(booking.status)

  return (
    <div style={page}>
      {/* Header */}
      <header style={header}>
        <div style={headerInner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', background: '#F5F1EA', borderRadius: '8px', padding: '4px', flexShrink: 0, boxShadow: '0 2px 6px rgba(0,0,0,0.18)' }}>
              <img src="/icon.svg" alt="" width={28} height={28} style={{ display: 'block' }} />
            </span>
            <p style={{ color: '#FF5A1F', fontWeight: '700', fontSize: '13px', margin: '0', letterSpacing: '0.06em' }}>WE MOVE IT. WE CLEAR IT.</p>
          </div>
          <a href="tel:+18626400625" style={{ fontSize: '13px', color: '#CBD5E1', textDecoration: 'none' }}>
            862-640-0625
          </a>
        </div>
      </header>

      <main style={main}>
        {/* Greeting */}
        <div style={{ marginBottom: '28px' }}>
          <h1 style={h1}>Hi, {booking.customer.name.split(' ')[0]}!</h1>
          <p style={{ fontSize: '14px', color: '#6B7280', margin: '0' }}>Here's the status of your booking.</p>
        </div>

        {/* Status card */}
        <div style={{ ...statusCard, borderLeft: `4px solid ${statusInfo.color}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: statusInfo.color, flexShrink: 0 }} />
            <span style={{ fontSize: '16px', fontWeight: '700', color: '#0A1628' }}>{statusInfo.label}</span>
          </div>
          <p style={{ fontSize: '14px', color: '#374151', margin: '0' }}>{statusInfo.description}</p>
        </div>

        {/* Job details */}
        <Section title="Your Move">
          <Row label="From" value={booking.originAddress} />
          <Row label="To" value={booking.destAddress} />
          {booking.scheduledStart && (
            <Row
              label="Scheduled"
              value={new Date(booking.scheduledStart).toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
              })}
            />
          )}
          {booking.scheduledStart && (
            <Row
              label="Arrival window"
              value={`${new Date(booking.scheduledStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} – ${booking.scheduledEnd ? new Date(booking.scheduledEnd).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : 'TBD'}`}
            />
          )}
          {booking.itemsDescription && <Row label="Items" value={booking.itemsDescription} />}
        </Section>

        {/* Payment */}
        <Section title="Payment">
          <Row label="Booking fee" value={`$${((booking.depositAmount ?? 4900) / 100).toFixed(2)}`} />
          {booking.discountType && booking.discountPercent && (
            <Row
              label="Discount applied"
              value={`${booking.discountPercent}% off — ${booking.discountType === 'FIRST_TIME_AUTO' ? 'First-time customer' : 'Door hanger promo'}`}
            />
          )}
          <Row
            label="Status"
            value={totalPaid > 0 ? `$${(totalPaid / 100).toFixed(2)} paid` : 'No payment received yet'}
          />
        </Section>

        {/* Receipt */}
        {booking.receipt?.cloudinaryUrl && (
          <Section title="Receipt">
            <a
              href={booking.receipt.cloudinaryUrl}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: '#FF5A1F', fontWeight: '600' }}
            >
              📄 Download receipt PDF →
            </a>
            {booking.receipt.sentAt && (
              <p style={{ fontSize: '12px', color: '#9CA3AF', margin: '6px 0 0' }}>
                Sent {new Date(booking.receipt.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            )}
          </Section>
        )}

        {/* Files */}
        {booking.files.length > 0 && (
          <Section title="Documents & Photos">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {booking.files.map((f) => (
                <a
                  key={f.id}
                  href={f.cloudinaryUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: '13px', color: '#FF5A1F', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', backgroundColor: '#F9FAFB', borderRadius: '6px' }}
                >
                  <span>📎 {f.filename ?? f.type}</span>
                  <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{new Date(f.createdAt).toLocaleDateString()}</span>
                </a>
              ))}
            </div>
          </Section>
        )}

        {/* Reschedule */}
        {canReschedule && (
          <Section title="Need to Reschedule?">
            <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 16px' }}>
              We require at least <strong>72 hours notice</strong> for reschedule requests. Contact us or use the form below.
            </p>
            <RescheduleForm token={params.token} />
          </Section>
        )}

        {/* Contact */}
        <div style={{ marginTop: '32px', textAlign: 'center' }}>
          <p style={{ fontSize: '13px', color: '#9CA3AF', margin: '0 0 8px' }}>Questions? We're here to help.</p>
          <a href="mailto:hello@moveitclearit.com" style={{ color: '#FF5A1F', fontSize: '14px', fontWeight: '600' }}>
            hello@moveitclearit.com
          </a>
        </div>
      </main>

      <footer style={{ textAlign: 'center', padding: '24px', backgroundColor: '#0A1628' }}>
        <p style={{ fontSize: '12px', color: '#8B9BC1', margin: '0' }}>
          © {new Date().getFullYear()} We Move It. We Clear It. · Labor-only moving services ·{' '}
          <Link href="/terms" style={{ color: '#8B9BC1' }}>Terms</Link>{' '}
          · <Link href="/privacy" style={{ color: '#8B9BC1' }}>Privacy</Link>
        </p>
      </footer>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={sectionCard}>
      <h3 style={{ fontSize: '12px', fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' }}>{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '8px' }}>
      <span style={{ fontSize: '13px', color: '#9CA3AF', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: '#374151', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function RescheduleForm({ token }: { token: string }) {
  return (
    <form action={`/api/customer/booking/${token}`} method="PATCH" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
          Requested new date
        </label>
        <input
          type="datetime-local"
          name="requestedDate"
          required
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>
      <div>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
          Notes (optional)
        </label>
        <textarea
          name="notes"
          rows={3}
          maxLength={500}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
          placeholder="Tell us why you need to reschedule…"
        />
      </div>
      <button
        type="submit"
        style={{ padding: '10px', backgroundColor: '#0A1628', color: '#FFFFFF', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}
      >
        Submit Reschedule Request
      </button>
    </form>
  )
}

const page: React.CSSProperties = { minHeight: '100vh', backgroundColor: '#F5F1EA', fontFamily: 'Inter, -apple-system, sans-serif' }
const header: React.CSSProperties = { backgroundColor: '#0A1628', padding: '0' }
const headerInner: React.CSSProperties = { maxWidth: '600px', margin: '0 auto', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
const main: React.CSSProperties = { maxWidth: '600px', margin: '0 auto', padding: '32px 24px' }
const h1: React.CSSProperties = { fontSize: '26px', fontWeight: '800', color: '#0A1628', margin: '0 0 4px' }
const statusCard: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 6px rgba(0,0,0,0.08)', marginBottom: '20px' }
const sectionCard: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: '16px' }
