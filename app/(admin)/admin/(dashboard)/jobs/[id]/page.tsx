import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import BookingActions from './BookingActions'

export const revalidate = 0

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9CA3AF', PENDING_PAYMENT: '#F59E0B', PENDING_APPROVAL: '#EF4444',
  CONFIRMED: '#3B82F6', SCHEDULED: '#6366F1', IN_PROGRESS: '#F59E0B',
  COMPLETED: '#10B981', ARCHIVED: '#6B7280', CANCELLED: '#374151',
}

const TEMPLATE_LABELS: Record<string, string> = {
  'pre-approval': 'Pre-confirmation', 'final-confirmation': 'Booking approved',
  'booking-confirmation': 'Booking received', 'booking-confirmed': 'Confirmed',
  'payment-receipt': 'Payment receipt', 'booking-denied': 'Booking update',
  'reschedule-offer': 'Reschedule offer', 'booking-rescheduled': 'Rescheduled',
  'job-reminder': 'Move reminder', 'job-completion': 'Job complete',
  'review-request': 'Review request', 'abandoned-checkout': 'Abandoned checkout',
  'contact-ack': 'Contact reply',
}

// Human-readable labels for raw audit-log action codes. Unknown codes fall back
// to a Title-Cased version of the code so nothing ever shows as raw SNAKE_CASE.
const AUDIT_LABELS: Record<string, string> = {
  BOOKING_CREATED: 'Booking created',
  BOOKING_APPROVED: 'Owner approved the booking',
  APPROVED: 'Owner approved the booking',
  BOOKING_CANCELLED: 'Booking cancelled',
  BOOKING_DENIED: 'Booking denied',
  BOOKING_RESCHEDULED: 'Booking rescheduled',
  STATUS_CHANGE: 'Status changed',
  PAYMENT_RECEIVED: 'Payment received',
  PAYMENT_AUTHORIZED: 'Stripe authorization received',
  PAYMENT_CAPTURED: 'Payment captured',
  PAYMENT_REFUNDED: 'Payment refunded',
  AGREEMENT_ACCEPTED: 'Customer signed the moving agreement',
  CREW_ASSIGNED: 'Crew assigned',
  JOB_STARTED: 'Move started',
  JOB_COMPLETED: 'Move completed',
  COMPLETED: 'Move completed',
  REMINDER_SENT: 'Reminder sent',
  USER_LOGIN: 'Staff signed in',
  NOTES_UPDATED: 'Internal notes updated',
  RECEIPT_RESENT: 'Receipt re-sent',
}

function humanizeAudit(action: string): string {
  return AUDIT_LABELS[action] ?? action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

// (862) 228-5704 from 8622285704 / +18622285704. Leaves anything non-standard as-is.
function fmtPhone(raw?: string | null): string {
  if (!raw) return '—'
  const d = raw.replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  if (ten.length !== 10) return raw
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
}

const money = (n?: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`)          // dollar floats
const centsToMoney = (n?: number | null) => (n == null ? '—' : `$${(n / 100).toFixed(2)}`) // cent ints

const dateOnly = (d?: Date | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '—'
const dateTime = (d?: Date | null) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'

// The itemsDescription blob is built as "Label: value" lines joined by \n. Parse
// it back into rows so the owner sees each fact on its own line, not a paragraph.
// Lines without a "Label: " prefix are returned as full-width notes.
function parseItemsBlob(text?: string | null): { label: string | null; value: string }[] {
  if (!text) return []
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(': ')
      // Only treat as label/value when the label is short (a real field, not prose).
      if (i > 0 && i <= 30) return { label: line.slice(0, i), value: line.slice(i + 2) }
      return { label: null, value: line }
    })
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
      notifications: { orderBy: { createdAt: 'desc' }, take: 20 },
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 40, include: { user: { select: { name: true } } } },
    },
  })

  if (!booking) notFound()

  const collectedCents = booking.payments.filter((p) => p.status === 'COMPLETED').reduce((s, p) => s + p.amount, 0)
  const refundedCents = booking.payments.filter((p) => p.status === 'REFUNDED').reduce((s, p) => s + p.amount, 0)
  const moveDayDueCents = (booking.truckAddonAmount ?? 0) + (booking.travelFee ?? 0)
  const items = parseItemsBlob(booking.itemsDescription)
  const referral = [booking.foundUs, booking.source].filter(Boolean).join(' · ') || '—'

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '28px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <Link href="/admin/bookings" style={{ color: '#6B7280', fontSize: '13px', textDecoration: 'none' }}>← Bookings</Link>
          <h1 style={h1}>{booking.customer.name}</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ ...statusBadge, backgroundColor: STATUS_COLORS[booking.status] ?? '#9CA3AF' }}>{booking.status.replace(/_/g, ' ')}</span>
            <span style={{ fontSize: '12px', color: '#9CA3AF' }}>#{booking.displayId}</span>
          </div>
        </div>
        <BookingActions bookingId={booking.id} status={booking.status} />
      </div>

      <div style={grid}>
        {/* ─── Left column ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          <Section title="Customer Information">
            <Row label="Name" value={booking.customer.name} />
            <Row label="Phone" value={fmtPhone(booking.customer.phone)} />
            <Row label="Email" value={booking.customer.email} />
            <Row label="First-time customer" value={booking.customer.isFirstTime ? 'Yes' : 'No'} />
            <Row label="Language" value={booking.customer.locale === 'es' ? 'Spanish' : 'English'} />
            <Row label="Date booked" value={dateTime(booking.createdAt)} />
            <Row label="Referral source" value={referral} />
            <Row label="IP address" value={booking.ipAddress ?? '—'} />
            <Row label="Booking ID" value={booking.id} mono />
            <Row label="Customer ID" value={booking.customerId} mono />
          </Section>

          <Section title="Move Information">
            <SubHead>Pickup</SubHead>
            <Row label="Address" value={booking.originAddress} />
            <Row label="Floor" value={booking.originFloor != null ? String(booking.originFloor) : '—'} />
            <div style={{ height: '12px' }} />
            <SubHead>Drop-off</SubHead>
            <Row label="Address" value={booking.destAddress} />
            <Row label="Floor" value={booking.destFloor != null ? String(booking.destFloor) : '—'} />
            {(booking.serviceAreaZone || booking.travelFee > 0 || booking.distanceFromWestOrangeMiles != null) && (
              <>
                <div style={{ height: '12px' }} />
                <SubHead>Service area</SubHead>
                {booking.serviceAreaZone && <Row label="Zone" value={String(booking.serviceAreaZone).replace(/_/g, ' ')} />}
                {booking.distanceFromWestOrangeMiles != null && <Row label="Distance" value={`${booking.distanceFromWestOrangeMiles.toFixed(1)} mi from West Orange`} />}
                {booking.estimatedDriveTimeMinutes != null && <Row label="Drive time" value={`${booking.estimatedDriveTimeMinutes} min`} />}
                {booking.manualReviewRequired && <Row label="Review" value="⚠ Owner review required — travel price pending" />}
              </>
            )}
          </Section>

          {/* Service details, parsed out of the itemsDescription blob into rows */}
          <Section title="Service Details">
            {booking.estimatedHours != null && <Row label="Est. hours" value={`${booking.estimatedHours}h`} />}
            {booking.baseRate != null && <Row label="Base labor" value={money(booking.baseRate)} />}
            {items.length === 0 ? (
              <p style={emptyText}>No service details recorded</p>
            ) : (
              items.map((it, i) =>
                it.label ? <Row key={i} label={it.label} value={it.value} /> : <FullLine key={i}>{it.value}</FullLine>
              )
            )}
          </Section>

          <Section title="Schedule">
            <Row label="Requested date" value={dateOnly(booking.requestedDate)} />
            <Row label="Confirmed date" value={dateOnly(booking.confirmedDate)} />
            <Row label="Scheduled start" value={dateTime(booking.scheduledStart)} />
            <Row label="Scheduled end" value={dateTime(booking.scheduledEnd)} />
            <Row label="Status" value={booking.status.replace(/_/g, ' ')} />
            {booking.rescheduleCount > 0 && <Row label="Reschedules" value={String(booking.rescheduleCount)} />}
          </Section>

          <Section title="Customer Notes">
            {booking.customerNotes?.trim() ? <FullLine>{booking.customerNotes}</FullLine> : <p style={emptyText}>None provided</p>}
          </Section>

          <Section title="Internal Notes">
            <InternalNotesForm bookingId={booking.id} defaultValue={booking.internalNotes ?? ''} />
          </Section>
        </div>

        {/* ─── Right column ────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          <Section title="Pricing">
            {booking.baseRate != null && <Row label="Base labor" value={money(booking.baseRate)} />}
            {booking.travelFee > 0 && <Row label="Travel fee (move day)" value={centsToMoney(booking.travelFee)} />}
            {booking.truckAddonAmount > 0 && <Row label="Truck add-on (move day)" value={centsToMoney(booking.truckAddonAmount)} />}
            {booking.discountType && <Row label="Discount" value={`${String(booking.discountType).replace(/_/g, ' ')} — ${booking.discountPercent ?? 0}%`} />}
            {booking.totalEstimate != null && <Row label="Estimated total" value={money(booking.totalEstimate)} strong />}
            <div style={divider} />
            <Row label="Booking deposit (Stripe)" value={centsToMoney(booking.depositAmount)} />
            <Row label="Deposit paid" value={booking.depositPaid ? 'Yes' : 'No'} />
            <Row label="Collected" value={centsToMoney(collectedCents)} strong />
            {refundedCents > 0 && <Row label="Refunded" value={`− ${centsToMoney(refundedCents)}`} />}
            <Row label="Due on move day" value={moveDayDueCents > 0 ? `${centsToMoney(moveDayDueCents)} (truck + travel)` : '—'} />
            <p style={{ ...emptyText, marginTop: '10px' }}>Only the $49 deposit is charged in Stripe. Labor + move-day add-ons are settled on move day.</p>
          </Section>

          <Section title="Payment History">
            {booking.payments.length === 0 ? (
              <p style={emptyText}>No payments yet</p>
            ) : (
              booking.payments.map((p, i) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < booking.payments.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>{centsToMoney(p.amount)}</div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{dateTime(p.createdAt)}{p.stripePaymentIntentId ? ` · ${p.stripePaymentIntentId.slice(0, 18)}…` : ''}</div>
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: p.status === 'COMPLETED' ? '#10B981' : p.status === 'REFUNDED' ? '#EF4444' : '#F59E0B' }}>{p.status}</span>
                </div>
              ))
            )}
          </Section>

          <Section title={`Communication History (${booking.notifications.length})`}>
            {booking.notifications.length === 0 ? (
              <p style={emptyText}>No messages sent yet</p>
            ) : (
              booking.notifications.map((n, i) => (
                <div key={n.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '9px 0', borderBottom: i < booking.notifications.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>{TEMPLATE_LABELS[n.template] ?? n.template}</div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{n.channel} · {n.sentAt ? `sent ${dateTime(n.sentAt)}` : n.status.toLowerCase()}</div>
                  </div>
                  {n.channel === 'EMAIL' && <OpenIndicator isOpened={n.isOpened} openedAt={n.openedAt} openCount={n.openCount} />}
                </div>
              ))
            )}
          </Section>

          {booking.job && (
            <Section title="Crew & Dispatch">
              <Row label="Job status" value={booking.job.status} />
              {booking.job.startedAt && <Row label="Started" value={dateTime(booking.job.startedAt)} />}
              {booking.job.completedAt && <Row label="Completed" value={dateTime(booking.job.completedAt)} />}
              {booking.job.crew.length > 0 ? (
                <div style={{ marginTop: '8px' }}>
                  {booking.job.crew.map((c) => (
                    <div key={c.id} style={{ fontSize: '13px', color: '#374151', padding: '4px 0' }}>{c.user.name} <span style={{ color: '#9CA3AF' }}>· {c.user.role}</span></div>
                  ))}
                </div>
              ) : (
                <p style={emptyText}>No crew assigned yet</p>
              )}
            </Section>
          )}

          <Section title={`Photos (${booking.files.length})`}>
            {booking.files.length === 0 ? (
              <p style={emptyText}>No photos uploaded</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px' }}>
                {booking.files.map((f) => (
                  <a key={f.id} href={f.cloudinaryUrl} target="_blank" rel="noreferrer" title={`${f.type} · ${new Date(f.createdAt).toLocaleDateString()}`} style={{ display: 'block' }}>
                    <img src={f.cloudinaryUrl} alt={f.filename ?? f.type} style={{ width: '100%', height: '96px', objectFit: 'cover', borderRadius: '8px', border: '1px solid #E5E7EB', display: 'block' }} />
                  </a>
                ))}
              </div>
            )}
          </Section>

          <Section title="Documents">
            <Row label="Agreement accepted" value={booking.agreementAccepted ? 'Yes' : 'No'} />
            {booking.agreementVersion && <Row label="Agreement version" value={booking.agreementVersion} />}
            {booking.agreementName && <Row label="Signed by" value={booking.agreementName} />}
            {booking.agreementAcceptedAt && <Row label="Signed at" value={dateTime(booking.agreementAcceptedAt)} />}
            {booking.receipt ? (
              <div style={{ marginTop: '10px', borderTop: '1px solid #F3F4F6', paddingTop: '10px' }}>
                <Row label="Receipt" value={booking.receipt.sentAt ? `Sent ${dateTime(booking.receipt.sentAt)}` : 'Pending'} />
                {booking.receipt.cloudinaryUrl && (
                  <a href={booking.receipt.cloudinaryUrl} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: '6px', fontSize: '13px', color: '#FF5A1F' }}>View receipt PDF →</a>
                )}
                <ResendReceiptButton bookingId={booking.id} />
              </div>
            ) : (
              <p style={{ ...emptyText, marginTop: '8px' }}>No receipt generated yet</p>
            )}
          </Section>

          {booking.discordJobChannelId && (
            <Section title="Discord">
              <Row label="Job channel" value={`#${booking.discordJobChannelId}`} />
              {booking.discordPaperworkChannelId && <Row label="Paperwork" value={`#${booking.discordPaperworkChannelId}`} />}
              {booking.discordPhotosChannelId && <Row label="Photos" value={`#${booking.discordPhotosChannelId}`} />}
            </Section>
          )}
        </div>
      </div>

      {/* Audit — humanized, with raw JSON tucked behind a toggle */}
      <Section title="Audit History" style={{ marginTop: '20px' }}>
        {booking.auditLogs.length === 0 ? (
          <p style={emptyText}>No activity yet</p>
        ) : (
          booking.auditLogs.map((log, i) => (
            <div key={log.id} style={{ display: 'flex', gap: '16px', padding: '10px 0', borderBottom: i < booking.auditLogs.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
              <span style={{ fontSize: '11px', color: '#9CA3AF', whiteSpace: 'nowrap', paddingTop: '2px', minWidth: '96px' }}>{dateTime(log.createdAt)}</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>{humanizeAudit(log.action)}</span>
                {log.user && <span style={{ fontSize: '11px', color: '#9CA3AF' }}> · {log.user.name}</span>}
                {log.details && typeof log.details === 'object' && (
                  <details style={{ marginTop: '4px' }}>
                    <summary style={{ fontSize: '11px', color: '#9CA3AF', cursor: 'pointer' }}>Details</summary>
                    <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '4px', fontFamily: 'monospace', backgroundColor: '#F9FAFB', padding: '6px 8px', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))
        )}
      </Section>
    </div>
  )
}

// ── Presentational helpers ──────────────────────────────────────
function Section({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', ...style }}>
      <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>{title}</h3>
      {children}
    </div>
  )
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '11px', fontWeight: 700, color: '#0A1628', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>{children}</div>
}

function Row({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '16px' }}>
      <span style={{ fontSize: '12px', color: '#9CA3AF', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: '#374151', textAlign: 'right', fontFamily: mono ? 'monospace' : 'inherit', fontWeight: strong ? 700 : 400, wordBreak: mono ? 'break-all' : 'normal' }}>{value}</span>
    </div>
  )
}

// Full-width, whitespace-preserving block for prose (customer notes, blob lines).
function FullLine({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '13px', color: '#374151', margin: '0 0 8px', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{children}</p>
}

function OpenIndicator({ isOpened, openedAt, openCount }: { isOpened: boolean; openedAt: Date | null; openCount: number }) {
  if (isOpened) {
    const when = openedAt ? new Date(openedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : ''
    return (
      <span title={`Opened${when ? ` ${when}` : ''}${openCount > 1 ? ` · ${openCount} opens` : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '7px', backgroundColor: '#FFF0E6' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 12.5l4.3 4.3L19 7" stroke="#FF6A00" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span style={{ fontSize: '11px', fontWeight: 700, color: '#FF6A00' }}>Opened</span>
      </span>
    )
  }
  return (
    <span title="Sent — not opened yet" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '7px', backgroundColor: '#F3F4F6' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="#9CA3AF" strokeWidth="2" /></svg>
      </span>
      <span style={{ fontSize: '11px', color: '#9CA3AF' }}>Not opened</span>
    </span>
  )
}

function InternalNotesForm({ bookingId, defaultValue }: { bookingId: string; defaultValue: string }) {
  return (
    <form action={`/api/admin/bookings/${bookingId}`} method="PATCH" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea name="internalNotes" defaultValue={defaultValue} rows={4} style={{ width: '100%', padding: '8px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} placeholder="Add internal notes visible only to staff…" />
      <button type="submit" style={{ alignSelf: 'flex-end', padding: '6px 16px', backgroundColor: '#0A1628', color: '#FFFFFF', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Save notes</button>
    </form>
  )
}

function ResendReceiptButton({ bookingId }: { bookingId: string }) {
  return (
    <form action={`/api/admin/receipts/${bookingId}/resend`} method="POST" style={{ marginTop: '12px' }}>
      <button type="submit" style={{ padding: '6px 14px', backgroundColor: '#F3F4F6', color: '#374151', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Resend receipt email</button>
    </form>
  )
}

const h1: React.CSSProperties = { fontSize: '22px', fontWeight: 700, color: '#0A1628', margin: '8px 0' }
const statusBadge: React.CSSProperties = { color: '#FFFFFF', fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '100px', letterSpacing: '0.04em' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }
const divider: React.CSSProperties = { borderTop: '1px solid #F3F4F6', margin: '10px 0' }
const emptyText: React.CSSProperties = { fontSize: '13px', color: '#9CA3AF', fontStyle: 'italic', margin: 0 }
