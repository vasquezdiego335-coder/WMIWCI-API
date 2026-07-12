import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import BookingActions from './BookingActions'
import OperationsPanel, { PrintButton } from './OperationsPanel'
import WaitingTimePanel from './WaitingTimePanel'
import { parseUserAgent } from '@/lib/ua'
import {
  resolveWaiting,
  effectiveWaitingFeeCents,
  feeDollars,
  WAITING_RESCHEDULE_THRESHOLD_MINUTES,
} from '@/lib/waiting-time'

export const revalidate = 0

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9CA3AF', PENDING_PAYMENT: '#F59E0B', PENDING_APPROVAL: '#EF4444',
  CONFIRMED: '#3B82F6', SCHEDULED: '#6366F1', IN_PROGRESS: '#F59E0B',
  COMPLETED: '#10B981', ARCHIVED: '#6B7280', CANCELLED: '#374151',
}
const TEMPLATE_LABELS: Record<string, string> = {
  'pre-approval': 'Pre-confirmation', 'final-confirmation': 'Booking approved',
  'booking-confirmation': 'Booking received', 'payment-receipt': 'Payment receipt',
  'booking-denied': 'Booking update', 'reschedule-offer': 'Reschedule offer',
  'booking-rescheduled': 'Rescheduled', 'job-reminder': 'Move reminder',
  'job-completion': 'Job complete', 'review-request': 'Review request', 'contact-ack': 'Contact reply',
}
const AUDIT_LABELS: Record<string, string> = {
  BOOKING_CREATED: 'Booking created', BOOKING_STATE_CHANGED: 'Status changed',
  BOOKING_DETAILS_UPDATED: 'Operational details updated', PAYMENT_RECEIVED: 'Payment received',
  PAYMENT_FAILED: 'Payment failed', DISCOUNT_APPLIED: 'Discount applied',
  DISCOUNT_APPROVED: 'Discount approved', JOB_STARTED: 'Move started', JOB_COMPLETED: 'Move completed',
  FILE_UPLOADED: 'File uploaded', RECEIPT_SENT: 'Receipt sent', USER_LOGIN: 'Staff signed in',
  SCHEDULE_MODIFIED: 'Schedule modified',
}

const humanizeAudit = (a: string) => AUDIT_LABELS[a] ?? a.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '')
function fmtPhone(raw?: string | null): string {
  const d = digits(raw); const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : (raw ?? '—')
}
const money = (n?: number | null) => (n == null ? null : `$${n.toFixed(2)}`)          // dollars
const cents = (n?: number | null) => (n == null ? null : `$${(n / 100).toFixed(2)}`)   // cents → $
const dateOnly = (d?: Date | null) => d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '—'
const dateTime = (d?: Date | null) => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'
const gmaps = (a: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`
const amaps = (a: string) => `https://maps.apple.com/?q=${encodeURIComponent(a)}`

function parseItemsBlob(text?: string | null): { label: string | null; value: string }[] {
  if (!text) return []
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const i = line.indexOf(': ')
    return i > 0 && i <= 30 ? { label: line.slice(0, i), value: line.slice(i + 2) } : { label: null, value: line }
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
      notifications: { orderBy: { createdAt: 'desc' }, take: 25 },
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { name: true } } } },
    },
  })
  if (!booking) notFound()

  // Customer lifetime aggregates (across ALL their bookings).
  const custBookings = await prisma.booking.findMany({
    where: { customerId: booking.customerId },
    select: { id: true, status: true, payments: { where: { status: 'COMPLETED', isInternalTest: false }, select: { amount: true } } },
  })
  const totalBookings = custBookings.length
  const lifetimeCents = custBookings.flatMap((b) => b.payments).reduce((s, p) => s + p.amount, 0)
  const previousMoves = custBookings.filter((b) => b.status === 'COMPLETED' && b.id !== booking.id).length

  const collected = booking.payments.filter((p) => p.status === 'COMPLETED' && !p.isInternalTest).reduce((s, p) => s + p.amount, 0)
  const refunded = booking.payments.filter((p) => p.status === 'REFUNDED' && !p.isInternalTest).reduce((s, p) => s + p.amount, 0)
  const moveDayDue = (booking.truckAddonAmount ?? 0) + (booking.travelFee ?? 0) + (booking.additionalTruckFees ?? 0) + effectiveWaitingFeeCents(booking)
    + (booking.stairFee ?? 0) + (booking.longCarryFee ?? 0) + (booking.heavyItemFee ?? 0)
    + (booking.packingFee ?? 0) + (booking.assemblyFee ?? 0) + (booking.disassemblyFee ?? 0) + (booking.taxAmount ?? 0)
  const ua = parseUserAgent(booking.userAgent)
  const items = parseItemsBlob(booking.itemsDescription)
  const c = booking.customer
  const paymentStatus = collected > 0 ? 'PAID DEPOSIT' : booking.status === 'PENDING_PAYMENT' ? 'AWAITING PAYMENT' : 'UNPAID'

  const opsDefaults: Record<string, string> = {
    arrivalWindow: booking.arrivalWindow ?? '', assignedDispatcher: booking.assignedDispatcher ?? '',
    completionProgress: booking.completionProgress != null ? String(booking.completionProgress) : '',
    problemFlags: booking.problemFlags ?? '', truckProvider: booking.truckProvider ?? '',
    truckSize: booking.truckSize ?? '', truckReservationNumber: booking.truckReservationNumber ?? '',
    truckReservationStatus: booking.truckReservationStatus ?? '', truckPickupTime: booking.truckPickupTime ?? '',
    driverName: booking.driverName ?? '', driverPhone: booking.driverPhone ?? '', truckFuelPolicy: booking.truckFuelPolicy ?? '',
    internalNotes: booking.internalNotes ?? '',
    dispatcherNotes: booking.dispatcherNotes ?? '', crewNotes: booking.crewNotes ?? '',
    officeNotes: booking.officeNotes ?? '', outstandingTasks: booking.outstandingTasks ?? '',
  }

  // ── Lifecycle timeline ──
  const firstPaid = booking.payments.filter((p) => p.status === 'COMPLETED').slice(-1)[0]
  const timeline: { label: string; at: Date | null }[] = [
    { label: 'Booking submitted', at: booking.createdAt },
    { label: 'Deposit paid', at: booking.depositPaid && firstPaid ? firstPaid.createdAt : null },
    { label: 'Agreement signed', at: booking.agreementAcceptedAt },
    { label: 'Confirmed', at: booking.confirmedDate },
    { label: 'Crew assigned', at: booking.job?.crew.length ? (booking.job.createdAt ?? null) : null },
    { label: 'Move started', at: booking.job?.startedAt ?? null },
    { label: 'Crew arrived', at: booking.crewArrivedAt ?? null },
    { label: 'Waiting started', at: booking.waitingStartedAt ?? null },
    { label: 'Waiting ended', at: booking.waitingEndedAt ?? null },
    { label: 'Customer ready', at: booking.customerReadyAt ?? null },
    { label: 'Move completed', at: booking.job?.completedAt ?? booking.completedAt ?? null },
  ].filter((e) => e.at || !['Crew arrived', 'Waiting started', 'Waiting ended', 'Customer ready'].includes(e.label))

  // ── Waiting-time summary (fee math from the single source of truth) ──
  const waiting = resolveWaiting(booking)
  const waitingEffectiveFee = effectiveWaitingFeeCents(booking)

  return (
    <div>
      {/* ─── Sticky summary + action bar ─────────────────────── */}
      <div style={stickyBar}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <Link href="/admin/bookings" style={{ color: '#6B7280', fontSize: '13px', textDecoration: 'none' }}>← Bookings</Link>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '6px 0 4px', flexWrap: 'wrap' }}>
              <h1 style={h1}>{c.name}</h1>
              <Badge color={STATUS_COLORS[booking.status] ?? '#9CA3AF'}>{booking.status.replace(/_/g, ' ')}</Badge>
              <Badge color={collected > 0 ? '#10B981' : '#F59E0B'}>{paymentStatus}</Badge>
            </div>
            <div style={{ fontSize: '12px', color: '#9CA3AF' }}>#{booking.displayId} · {booking.serviceAreaZone ? String(booking.serviceAreaZone).replace(/_/g, ' ') : '—'} · booked {dateOnly(booking.createdAt)}</div>
          </div>
          <BookingActions bookingId={booking.id} status={booking.status} />
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
          <QuickLink href={`tel:${digits(c.phone)}`}>📞 Call</QuickLink>
          <QuickLink href={`sms:${digits(c.phone)}`}>💬 Text</QuickLink>
          <QuickLink href={`mailto:${c.email}`}>✉️ Email</QuickLink>
          <QuickLink href={gmaps(booking.originAddress)}>📍 Pickup map</QuickLink>
          <QuickLink href={gmaps(booking.destAddress)}>📍 Drop-off map</QuickLink>
          {booking.stripePaymentIntentId && <QuickLink href={`https://dashboard.stripe.com/payments/${booking.stripePaymentIntentId}`}>💳 Stripe</QuickLink>}
          {booking.receipt?.cloudinaryUrl && <QuickLink href={booking.receipt.cloudinaryUrl}>🧾 Receipt</QuickLink>}
          <PrintButton />
        </div>
      </div>

      {/* ─── Section 1: Booking Summary ──────────────────────── */}
      <Card title="Booking Summary" icon="📋" wide>
        <div style={summaryGrid}>
          <Stat label="Move date" value={dateOnly(booking.confirmedDate ?? booking.requestedDate)} />
          <Stat label="Arrival window" value={booking.arrivalWindow ?? '—'} />
          <Stat label="Est. duration" value={booking.estimatedHours != null ? `${booking.estimatedHours}h` : '—'} />
          <Stat label="Service type" value={items.find((i) => i.label === 'Service')?.value ?? '—'} />
          <Stat label="Estimated total" value={money(booking.totalEstimate) ?? '—'} />
          <Stat label="Source" value={[booking.foundUs, booking.source].filter(Boolean).join(' · ') || '—'} />
          <Stat label="Customer type" value={c.isFirstTime ? 'First-time' : 'Returning'} />
          <Stat label="Language" value={c.locale === 'es' ? 'Spanish' : 'English'} />
          <Stat label="Dispatcher" value={booking.assignedDispatcher ?? '—'} />
          <Stat label="Crew" value={booking.job?.crew.length ? booking.job.crew.map((x) => x.user.name).join(', ') : '—'} />
          <Stat label="Truck" value={booking.truckProvider ?? (booking.truckAddonDueOnMoveDay ? 'WMIWCI pickup/return' : '—')} />
          <Stat label="Last updated" value={dateTime(booking.updatedAt)} />
        </div>
      </Card>

      <div style={grid}>
        {/* Left column */}
        <div style={col}>
          {/* Section 2: Customer */}
          <Card title="Customer Information" icon="👤">
            <Row label="Full name" value={c.name} />
            {c.preferredName && <Row label="Preferred name" value={c.preferredName} />}
            <PhoneRow label="Phone" phone={c.phone} />
            {c.secondaryPhone && <PhoneRow label="Secondary phone" phone={c.secondaryPhone} />}
            <Row label="Email" value={c.email} />
            <Row label="Emergency contact" value={c.emergencyContact ?? '—'} />
            <Row label="Emergency phone" value={c.emergencyContactPhone ? fmtPhone(c.emergencyContactPhone) : '—'} />
            <div style={divider} />
            <Row label="Total bookings" value={String(totalBookings)} />
            <Row label="Previous moves" value={String(previousMoves)} />
            <Row label="Lifetime revenue" value={cents(lifetimeCents) ?? '$0.00'} strong />
            <Row label="First-time customer" value={c.isFirstTime ? 'Yes' : 'No'} />
            <div style={divider} />
            <Row label="Agreement signed" value={booking.agreementAccepted ? `Yes${booking.agreementName ? ` — ${booking.agreementName}` : ''}` : 'No'} />
            {booking.agreementSignature && <Row label="Signature" value={booking.agreementSignature} />}
            <Row label="IP address" value={booking.ipAddress ?? '—'} />
            <Row label="Browser / OS" value={`${ua.browser} · ${ua.os}`} />
            <Row label="Device" value={ua.device} />
            <Row label="Customer ID" value={booking.customerId} mono />
            <Row label="Booking ID" value={booking.id} mono />
          </Card>

          {/* Section 3 & 4: Addresses */}
          <AddressCard title="Pickup Address" icon="🟢" address={booking.originAddress}
            unit={booking.originUnit} floor={booking.originFloor} elevator={booking.originHasElevator}
            stairs={booking.originStairCount} notes={booking.originAccessNotes} code={booking.originAccessCode}
            verification={booking.originVerification} formatted={booking.originFormatted}
            county={booking.originCounty} reason={booking.originValidationReason} />
          <AddressCard title="Delivery Address" icon="🔴" address={booking.destAddress}
            unit={booking.destUnit} floor={booking.destFloor} elevator={booking.destHasElevator}
            stairs={booking.destStairCount} notes={booking.destAccessNotes} code={booking.destAccessCode}
            verification={booking.destVerification} formatted={booking.destFormatted}
            county={booking.destCounty} reason={booking.destValidationReason} />

          {/* Section 5: Move Information */}
          <Card title="Move Information" icon="📦">
            <Row label="Service package" value={items.find((i) => i.label === 'Service')?.value ?? '—'} />
            <Row label="Bedrooms" value={booking.bedrooms != null ? String(booking.bedrooms) : '—'} />
            <Row label="Est. cubic feet" value={booking.estimatedCubicFeet != null ? `${booking.estimatedCubicFeet} ft³` : '—'} />
            <Row label="Est. weight" value={booking.estimatedWeightLbs != null ? `${booking.estimatedWeightLbs} lbs` : '—'} />
            <Row label="Boxes" value={booking.numBoxes != null ? String(booking.numBoxes) : '—'} />
            <BoolRow label="Packing" v={booking.needsPacking} />
            <BoolRow label="Unpacking" v={booking.needsUnpacking} />
            <BoolRow label="Assembly" v={booking.needsAssembly} />
            <BoolRow label="Disassembly" v={booking.needsDisassembly} />
            <BoolRow label="Storage" v={booking.needsStorage} />
            <BoolRow label="Piano" v={booking.hasPiano} />
            <BoolRow label="Safe" v={booking.hasSafe} />
            <BoolRow label="Pool table" v={booking.hasPoolTable} />
            <BoolRow label="Appliances" v={booking.hasAppliances} />
            <Row label="Specialty items" value={booking.specialtyItems ?? '—'} />
            <Row label="Equipment needed" value={booking.equipmentNeeds ?? '—'} />
            {items.filter((i) => i.label && !['Service', 'Truck', 'Notes'].includes(i.label)).map((i, k) => <Row key={k} label={i.label!} value={i.value} />)}
          </Card>

          {/* Section 6: Truck */}
          <Card title="Truck Information" icon="🚚">
            <Row label="Provider" value={booking.truckProvider ?? (booking.truckAddonDueOnMoveDay ? 'WMIWCI (pickup & return)' : 'Customer-provided')} />
            <Row label="Size" value={booking.truckSize ?? '—'} />
            <Row label="Reservation #" value={booking.truckReservationNumber ?? '—'} />
            <Row label="Reservation status" value={booking.truckReservationStatus ?? '—'} />
            <Row label="Pickup time" value={booking.truckPickupTime ?? '—'} />
            <Row label="Pickup location" value={booking.truckPickupLocation ?? '—'} />
            <Row label="Return" value={booking.truckReturnResponsibility ?? booking.truckReturnAddress ?? '—'} />
            <Row label="Driver" value={booking.driverName ?? '—'} />
            <Row label="Driver phone" value={booking.driverPhone ? fmtPhone(booking.driverPhone) : '—'} />
            <Row label="Driver license" value={booking.driverLicense ?? '—'} />
            <Row label="Fuel policy" value={booking.truckFuelPolicy ?? '—'} />
            <Row label="Additional truck fees" value={cents(booking.additionalTruckFees) ?? '—'} />
          </Card>

          {/* Section 14: Customer Notes — the customer's exact words, never truncated */}
          <Card title="Customer Notes" icon="💬">
            {booking.customerNotes?.trim()
              ? <p style={{ fontSize: '13px', color: '#374151', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{booking.customerNotes}</p>
              : <Empty>No notes from the customer</Empty>}
            {booking.crewInstructions?.trim() && (
              <div style={{ marginTop: '12px', borderTop: '1px solid #F3F4F6', paddingTop: '10px' }}>
                <div style={{ fontSize: '11px', color: '#9CA3AF', marginBottom: '2px' }}>Move-day instructions for the crew</div>
                <p style={{ fontSize: '13px', color: '#374151', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{booking.crewInstructions}</p>
              </div>
            )}
          </Card>

          {/* Section 12: Internal Operations (editable) */}
          <Card title="Internal Operations" icon="🛠" action={<span style={{ fontSize: '11px', color: '#9CA3AF' }}>staff-editable</span>}>
            <Row label="Completion" value={booking.completionProgress != null ? `${booking.completionProgress}%` : '—'} />
            <Row label="Problem flags" value={booking.problemFlags ?? '—'} />
            <NotesBlock label="Internal notes" value={booking.internalNotes} />
            <NotesBlock label="Dispatcher notes" value={booking.dispatcherNotes} />
            <NotesBlock label="Crew notes" value={booking.crewNotes} />
            <NotesBlock label="Office notes" value={booking.officeNotes} />
            <NotesBlock label="Outstanding tasks" value={booking.outstandingTasks} />
            <div style={{ marginTop: '12px' }}><OperationsPanel bookingId={booking.id} defaults={opsDefaults} /></div>
          </Card>
        </div>

        {/* Right column */}
        <div style={col}>
          {/* Section 7: Pricing */}
          <Card title="Pricing Breakdown" icon="💵">
            <FeeRow label="Base labor" value={money(booking.baseRate)} />
            <FeeRow label="Travel fee" value={cents(booking.travelFee || null)} />
            <FeeRow label="Truck add-on" value={cents(booking.truckAddonAmount || null)} />
            <FeeRow label="Stair fee" value={cents(booking.stairFee)} />
            <FeeRow label="Long carry" value={cents(booking.longCarryFee)} />
            <FeeRow label="Heavy item" value={cents(booking.heavyItemFee)} />
            <FeeRow label="Packing" value={cents(booking.packingFee)} />
            <FeeRow label="Assembly" value={cents(booking.assemblyFee)} />
            <FeeRow label="Disassembly" value={cents(booking.disassemblyFee)} />
            <FeeRow label="Tax" value={cents(booking.taxAmount)} />
            <FeeRow label="Processing" value={cents(booking.processingFee)} />
            {booking.discountType && <FeeRow label={`Discount (${String(booking.discountType).replace(/_/g, ' ')})`} value={`${booking.discountPercent ?? 0}%`} />}
            <div style={divider} />
            <Row label="Estimated total" value={money(booking.totalEstimate) ?? '—'} strong />
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <PayBadge color="#3B82F6" label="Deposit (Stripe)" value={cents(booking.depositAmount) ?? '$0.00'} note={booking.depositPaid ? 'paid' : 'unpaid'} />
              <PayBadge color="#10B981" label="Collected" value={cents(collected) ?? '$0.00'} />
              {refunded > 0 && <PayBadge color="#EF4444" label="Refunded" value={cents(refunded)!} />}
              <PayBadge color="#F59E0B" label="Due on move day" value={cents(moveDayDue) ?? '$0.00'} note="not in Stripe" />
            </div>
          </Card>

          {/* Section 8: Payment Information */}
          <Card title="Payment Information" icon="💳">
            <Row label="Payment intent" value={booking.stripePaymentIntentId ?? '—'} mono />
            <Row label="Checkout ID" value={booking.stripeCheckoutId ?? '—'} mono />
            <div style={divider} />
            {booking.payments.length === 0 ? <Empty>No payments yet</Empty> : booking.payments.map((p, i) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < booking.payments.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                <div><div style={{ fontSize: '13px', fontWeight: 600 }}>{cents(p.amount)}</div><div style={{ fontSize: '11px', color: '#9CA3AF' }}>{dateTime(p.createdAt)}</div></div>
                <Badge color={p.status === 'COMPLETED' ? '#10B981' : p.status === 'REFUNDED' ? '#EF4444' : '#F59E0B'}>{p.status}</Badge>
              </div>
            ))}
          </Card>

          {/* Section 8b: Waiting Time (Late Arrival & Delay Policy) */}
          <Card title="Waiting Time" icon="⏱" action={<span style={{ fontSize: '11px', color: '#9CA3AF' }}>30 min free · $50/30 min after</span>}>
            <Row label="Crew arrived" value={dateTime(booking.crewArrivedAt)} />
            <Row label="Waiting started" value={dateTime(booking.waitingStartedAt)} />
            <Row label="Waiting ended" value={dateTime(booking.waitingEndedAt)} />
            <Row label="Customer ready" value={dateTime(booking.customerReadyAt)} />
            <div style={divider} />
            <Row label="Minutes waiting" value={waiting.source === 'none' ? '—' : `${waiting.totalMinutes} min${waiting.ongoing ? ' (running)' : ''}`} />
            <Row label="Billable (after 30 min free)" value={waiting.billableMinutes > 0 ? `${waiting.billableMinutes} min · ${waiting.billableBlocks} × $50` : 'None'} />
            <Row label="Auto-calculated fee" value={feeDollars(waiting.feeCents)} />
            {booking.waitingFeeOverride != null && <Row label="Manual override" value={cents(booking.waitingFeeOverride) ?? '—'} strong />}
            <Row label="Fee owed (move day)" value={booking.waitingFeeWaived ? 'Waived — $0' : (cents(waitingEffectiveFee) ?? '$0.00')} strong />
            {booking.waitingFeeWaived && booking.waitingWaiverReason && <Row label="Waiver reason" value={booking.waitingWaiverReason} />}
            <div style={{ margin: '8px 0' }}>
              <Badge color={booking.waitingFeeWaived ? '#6B7280' : waitingEffectiveFee === 0 ? '#10B981' : booking.waitingFeeCollected ? '#10B981' : '#F59E0B'}>
                {booking.waitingFeeWaived ? 'Fee waived' : waitingEffectiveFee === 0 ? 'No fee' : booking.waitingFeeCollected ? 'Collected' : 'Not yet collected'}
              </Badge>
            </div>
            {waiting.exceedsRescheduleThreshold && (
              <div style={{ fontSize: '12px', color: '#B45309', backgroundColor: '#FEF3C7', padding: '8px 10px', borderRadius: '6px', margin: '6px 0' }}>
                ⚠️ Delay exceeded {WAITING_RESCHEDULE_THRESHOLD_MINUTES} min — reschedule / next-opening / cancel is at crew discretion (owner spec).
              </div>
            )}
            <div style={{ marginTop: '10px' }}>
              <WaitingTimePanel
                bookingId={booking.id}
                defaults={{
                  waitingMinutes: booking.waitingMinutes != null ? String(booking.waitingMinutes) : '',
                  waitingFeeOverride: booking.waitingFeeOverride != null ? String(Math.round(booking.waitingFeeOverride / 100)) : '',
                  waitingFeeWaived: booking.waitingFeeWaived,
                  waitingWaiverReason: booking.waitingWaiverReason ?? '',
                  waitingFeeCollected: booking.waitingFeeCollected,
                }}
              />
            </div>
          </Card>

          {/* Section 9: Photos */}
          <Card title={`Uploaded Photos (${booking.files.length})`} icon="📷">
            {booking.files.length === 0 ? <Empty>No photos uploaded</Empty> : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '8px' }}>
                {booking.files.map((f) => (
                  <a key={f.id} href={f.cloudinaryUrl} target="_blank" rel="noreferrer" title={`${f.type} · ${new Date(f.createdAt).toLocaleDateString()} · ${f.uploadedBy ?? ''}`}>
                    <img src={f.cloudinaryUrl} alt={f.filename ?? f.type} style={{ width: '100%', height: '100px', objectFit: 'cover', borderRadius: '8px', border: '1px solid #E5E7EB', display: 'block' }} />
                  </a>
                ))}
              </div>
            )}
          </Card>

          {/* Section 10: Communications */}
          <Card title={`Communications (${booking.notifications.length})`} icon="✉️">
            {booking.notifications.length === 0 ? <Empty>No messages sent yet</Empty> : booking.notifications.map((n, i) => (
              <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: i < booking.notifications.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{TEMPLATE_LABELS[n.template] ?? n.template}</div>
                  <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{n.channel} · {n.sentAt ? `sent ${dateTime(n.sentAt)}` : n.status.toLowerCase()}</div>
                </div>
                {n.channel === 'EMAIL' && <Badge color={n.isOpened ? '#FF6A00' : '#9CA3AF'}>{n.isOpened ? 'Opened' : 'Sent'}</Badge>}
              </div>
            ))}
          </Card>

          {/* Crew */}
          {booking.job && (
            <Card title="Crew & Dispatch" icon="👥">
              <Row label="Job status" value={booking.job.status} />
              {booking.job.startedAt && <Row label="Started" value={dateTime(booking.job.startedAt)} />}
              {booking.job.completedAt && <Row label="Completed" value={dateTime(booking.job.completedAt)} />}
              {booking.job.crew.length > 0 ? booking.job.crew.map((cr) => (
                <div key={cr.id} style={{ fontSize: '13px', padding: '4px 0' }}>{cr.user.name} <span style={{ color: '#9CA3AF' }}>· {cr.user.role}</span></div>
              )) : <Empty>No crew assigned yet</Empty>}
            </Card>
          )}
        </div>
      </div>

      {/* Section 13: Timeline */}
      <Card title="Lifecycle Timeline" icon="🗓" wide>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {timeline.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: t.at ? '#10B981' : '#E5E7EB', border: t.at ? 'none' : '2px solid #D1D5DB', flexShrink: 0, marginTop: '3px' }} />
                {i < timeline.length - 1 && <div style={{ width: '2px', flex: 1, minHeight: '22px', backgroundColor: t.at ? '#D1FAE5' : '#F3F4F6' }} />}
              </div>
              <div style={{ paddingBottom: '14px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: t.at ? '#0A1628' : '#9CA3AF' }}>{t.label}</div>
                <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{t.at ? dateTime(t.at) : 'Pending'}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Section 11: Audit */}
      <Card title="Audit Log" icon="🧾" wide>
        {booking.auditLogs.length === 0 ? <Empty>No activity yet</Empty> : booking.auditLogs.map((log, i) => (
          <div key={log.id} style={{ display: 'flex', gap: '16px', padding: '10px 0', borderBottom: i < booking.auditLogs.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
            <span style={{ fontSize: '11px', color: '#9CA3AF', whiteSpace: 'nowrap', minWidth: '104px', paddingTop: '2px' }}>{dateTime(log.createdAt)}</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>{humanizeAudit(log.action)}</span>
              {log.user && <span style={{ fontSize: '11px', color: '#9CA3AF' }}> · {log.user.name}</span>}
              {log.details != null && typeof log.details === 'object' && (
                <details style={{ marginTop: '4px' }}>
                  <summary style={{ fontSize: '11px', color: '#9CA3AF', cursor: 'pointer' }}>Details</summary>
                  <pre style={{ fontSize: '11px', color: '#6B7280', margin: '4px 0 0', fontFamily: 'monospace', backgroundColor: '#F9FAFB', padding: '6px 8px', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(log.details, null, 2)}</pre>
                </details>
              )}
            </div>
          </div>
        ))}
      </Card>
    </div>
  )
}

// ── Presentational helpers ──────────────────────────────────────
function Card({ title, icon, children, wide, action }: { title: string; icon: string; children: React.ReactNode; wide?: boolean; action?: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '14px', padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #F1F1F1', marginBottom: wide ? '20px' : 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 16px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ fontSize: '15px' }}>{icon}</span>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
function AddressCard({ title, icon, address, unit, floor, elevator, stairs, notes, code, verification, formatted, county, reason }: { title: string; icon: string; address: string; unit?: string | null; floor?: number | null; elevator?: boolean | null; stairs?: number | null; notes?: string | null; code?: string | null; verification?: string | null; formatted?: string | null; county?: string | null; reason?: string | null }) {
  // Verification badge — legacy bookings (verification null) show nothing.
  const vb: Record<string, { color: string; label: string }> = {
    verified: { color: '#10B981', label: '✓ Verified' },
    partial: { color: '#F59E0B', label: '◐ Partial — confirm unit' },
    unverified: { color: '#EF4444', label: '⚠ Unverified' },
    skipped: { color: '#9CA3AF', label: '○ Not verified' },
  }
  const badge = verification ? vb[verification] : null
  const manualReview = !!reason && reason.startsWith('manual_entry')
  return (
    <Card title={title} icon={icon}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '6px' }}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: '#0A1628', margin: 0 }}>{address}</p>
        {badge && <Badge color={badge.color}>{badge.label}</Badge>}
      </div>
      {formatted && formatted !== address && (
        <p style={{ fontSize: '12px', color: '#6B7280', margin: '0 0 6px' }}>Verified as: {formatted}</p>
      )}
      {manualReview && (
        <p style={{ fontSize: '12px', color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '6px', padding: '6px 8px', margin: '0 0 8px' }}>
          ⚠ Manual entry — owner review needed{reason ? `: ${reason.replace(/^manual_entry:\s*/, '')}` : ''}
        </p>
      )}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
        <a href={gmaps(formatted || address)} target="_blank" rel="noreferrer" style={miniLink}>Google Maps ↗</a>
        <a href={amaps(formatted || address)} target="_blank" rel="noreferrer" style={miniLink}>Apple Maps ↗</a>
      </div>
      <Row label="Apartment / Unit" value={unit ?? '—'} />
      <Row label="Floor" value={floor != null ? String(floor) : '—'} />
      <Row label="County" value={county ?? '—'} />
      <Row label="Elevator" value={elevator == null ? '—' : elevator ? 'Yes' : 'No'} />
      <Row label="Flights of stairs" value={stairs != null ? String(stairs) : '—'} />
      <Row label="Access instructions" value={notes ?? '—'} />
      {code && <Row label="🔒 Gate / access code" value={code} />}
    </Card>
  )
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div><div style={{ fontSize: '11px', color: '#9CA3AF', marginBottom: '2px' }}>{label}</div><div style={{ fontSize: '14px', fontWeight: 600, color: '#0A1628' }}>{value}</div></div>
}
function Row({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', marginBottom: '8px' }}><span style={{ fontSize: '12px', color: '#9CA3AF', flexShrink: 0 }}>{label}</span><span style={{ fontSize: '13px', color: '#374151', textAlign: 'right', fontFamily: mono ? 'monospace' : 'inherit', fontWeight: strong ? 700 : 400, wordBreak: mono ? 'break-all' : 'normal' }}>{value}</span></div>
}
function FeeRow({ label, value }: { label: string; value: string | null }) {
  if (value == null) return null
  return <Row label={label} value={value} />
}
function BoolRow({ label, v }: { label: string; v?: boolean | null }) {
  return <Row label={label} value={v == null ? '—' : v ? 'Yes' : 'No'} />
}
function PhoneRow({ label, phone }: { label: string; phone: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', marginBottom: '8px' }}><span style={{ fontSize: '12px', color: '#9CA3AF' }}>{label}</span><a href={`tel:${digits(phone)}`} style={{ fontSize: '15px', color: '#FF5A1F', fontWeight: 700, textDecoration: 'none' }}>{fmtPhone(phone)}</a></div>
}
function NotesBlock({ label, value }: { label: string; value?: string | null }) {
  if (!value?.trim()) return null
  return <div style={{ marginBottom: '10px' }}><div style={{ fontSize: '11px', color: '#9CA3AF', marginBottom: '2px' }}>{label}</div><p style={{ fontSize: '13px', color: '#374151', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{value}</p></div>
}
function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ color: '#FFFFFF', backgroundColor: color, fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '100px', letterSpacing: '0.03em' }}>{children}</span>
}
function PayBadge({ color, label, value, note }: { color: string; label: string; value: string; note?: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: '8px', backgroundColor: `${color}12`, border: `1px solid ${color}30` }}><span style={{ fontSize: '12px', color: '#374151' }}>{label}{note && <span style={{ color: '#9CA3AF' }}> · {note}</span>}</span><span style={{ fontSize: '14px', fontWeight: 700, color }}>{value}</span></div>
}
function QuickLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" style={{ padding: '7px 12px', backgroundColor: '#FFFFFF', color: '#374151', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '12px', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{children}</a>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '13px', color: '#9CA3AF', fontStyle: 'italic', margin: 0 }}>{children}</p>
}

const h1: React.CSSProperties = { fontSize: '22px', fontWeight: 700, color: '#0A1628', margin: 0 }
const stickyBar: React.CSSProperties = { position: 'sticky', top: 0, zIndex: 10, backgroundColor: 'rgba(245,241,234,0.92)', backdropFilter: 'blur(8px)', padding: '16px 0 14px', marginBottom: '20px', borderBottom: '1px solid #E5E7EB' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'start' }
const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 }
const summaryGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '16px' }
const divider: React.CSSProperties = { borderTop: '1px solid #F3F4F6', margin: '10px 0' }
const miniLink: React.CSSProperties = { fontSize: '12px', color: '#FF5A1F', textDecoration: 'none', fontWeight: 600 }
