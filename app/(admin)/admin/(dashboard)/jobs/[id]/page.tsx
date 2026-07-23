import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import JobStaffingPanel from './JobStaffingPanel'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import BookingActions from './BookingActions'
import OperationsPanel, { PrintButton } from './OperationsPanel'
import WaitingTimePanel from './WaitingTimePanel'
import RecordPaymentPanel from './RecordPaymentPanel'
import { parseUserAgent } from '@/lib/ua'
import {
  resolveWaiting,
  effectiveWaitingFeeCents,
  feeDollars,
  WAITING_RESCHEDULE_THRESHOLD_MINUTES,
} from '@/lib/waiting-time'
import { crewPayOwedCents } from '@/lib/profit'
import { jobProfit, jobFinancialCompleteness, jobLabor, customerBalance, JOB_MONEY_CREW_SELECT } from '@/lib/job-money'
import { completenessLabel, LABOR_STATE_LABELS } from '@/lib/financial-completeness'
import { computeLaborPay, paidCentsOf } from '@/lib/labor-calc'
import { isOnBreak } from '@/lib/labor-time'
import CrewLaborPanel from './CrewLaborPanel'
import FinancialCloseoutPanel from './FinancialCloseoutPanel'
import { buildCloseoutView } from '@/lib/closeout-service'
import { bpToPercentLabel } from '@/lib/profit-allocation'
import { isSettledForMoney } from '@/lib/financial-completeness'
import { isEligibleExpense } from '@/lib/money-rules'
import { Callout, CompletenessBadge } from '../../_ui'
import ExpenseForm from '../../ExpenseForm'
import { EXPENSE_CATEGORY_LABELS } from '../../_labels'
import EmailTimeline from './EmailTimeline'

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
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: {
      customer: true,
      payments: { orderBy: { createdAt: 'desc' } },
      // PHASE 1: the blessed crew select — every rate snapshot, minute bucket
      // and labor payment the money math needs, in one place.
      job: { include: { crew: { select: { ...JOB_MONEY_CREW_SELECT, id: true, crewLeader: true, assignedAt: true, breakStartedAt: true, rateSnapshotAt: true, laborPayments: true, user: { select: { id: true, name: true, role: true, payRate: true } } }, orderBy: { assignedAt: 'asc' } } } },
      expenses: { orderBy: { incurredOn: 'desc' } },
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

  // THE customer balance — one model shared with the jobs list, the dashboard
  // KPI, the closeout and the Action Center. Never re-sum fee columns here:
  // that is what made this page report "$100 due" on a move owing $460.
  const balance = customerBalance(booking as never)
  // Per-job profit (recorded money): NET collected revenue (captured − refunds
  // − chargebacks) − crew pay − eligible expenses − Stripe fees. Shares the
  // exact math with the Jobs list + dashboard via src/lib/money-rules.ts.
  const profit = jobProfit(booking)
  // What is still missing from this move's money story (Phase 0). Never present
  // a profit figure without it — crew pay of $0 usually means "not recorded".
  const completeness = jobFinancialCompleteness(booking)
  const collected = profit.netRevenueCents
  const refunded = profit.refundedCents
  const crewRows = booking.job?.crew ?? []
  const labor = jobLabor(booking as never)

  // PHASE 2: the full closeout picture — revenue, costs, profit, reserves,
  // blockers and snapshots — from the ONE centralized derivation. Only for
  // moves that have actually been worked; a pending quote has nothing to close.
  const closeout = isSettledForMoney(booking.status) ? await buildCloseoutView(booking.id) : null

  // Staff roster for the assign form (active users only).
  const staff = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true, payRate: true, workerType: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  })

  // Serialize assignments for the client panel. Money is pre-computed on the
  // server so the browser never re-derives a labor cost.
  const laborAssignments = crewRows.map((c) => {
    const pay = computeLaborPay({
      workerType: c.workerType as never, payModel: c.payModel as never,
      assignmentStatus: c.assignmentStatus as never, approvalStatus: c.approvalStatus as never,
      clockIn: c.clockIn, clockOut: c.clockOut,
      workedMinutes: c.clockIn && c.clockOut ? null : c.workedMinutes,
      actualBreakMinutes: c.actualBreakMinutes, travelMinutes: c.travelMinutes,
      travelPayPolicy: c.travelPayPolicy as never,
      hourlyRateCentsSnapshot: c.hourlyRateCentsSnapshot, overtimeRateCentsSnapshot: c.overtimeRateCentsSnapshot,
      flatPayCentsSnapshot: c.flatPayCentsSnapshot, dayRateCentsSnapshot: c.dayRateCentsSnapshot,
      travelRateCentsSnapshot: c.travelRateCentsSnapshot, economicRateCentsSnapshot: c.economicRateCentsSnapshot,
      driverBonusCentsSnapshot: c.driverBonusCentsSnapshot, crewLeaderBonusCentsSnapshot: c.crewLeaderBonusCentsSnapshot,
      otherBonusCents: c.otherBonusCents, reimbursementCents: c.reimbursementCents,
      approvedPayCents: c.approvedPayCents, zeroLaborConfirmed: c.zeroLaborConfirmed,
      legacyPayRate: c.payRate, legacyFlatPay: c.flatPay, legacyActualHours: c.actualHours,
      legacyTips: c.tips, legacyBonus: c.bonus, legacyDeductions: c.deductions,
      userProfilePayRate: c.user.payRate,
    })
    return {
      id: c.id, userId: c.user.id, userName: c.user.name,
      workerType: String(c.workerType), role: String(c.role),
      assignmentStatus: String(c.assignmentStatus), approvalStatus: String(c.approvalStatus),
      paymentStatus: String(c.paymentStatus), payModel: String(c.payModel),
      clockIn: c.clockIn?.toISOString() ?? null, clockOut: c.clockOut?.toISOString() ?? null,
      breakRunning: isOnBreak(c),
      workedMinutes: c.workedMinutes, regularMinutes: c.regularMinutes, overtimeMinutes: c.overtimeMinutes,
      travelMinutes: c.travelMinutes, breakMinutes: c.actualBreakMinutes,
      hourlyRateCentsSnapshot: c.hourlyRateCentsSnapshot, flatPayCentsSnapshot: c.flatPayCentsSnapshot,
      economicRateCentsSnapshot: c.economicRateCentsSnapshot,
      driverBonusCents: c.driverBonusCentsSnapshot, crewLeaderBonusCents: c.crewLeaderBonusCentsSnapshot,
      otherBonusCents: c.otherBonusCents,
      calculatedPayCents: pay.calculatedPayCents, approvedPayCents: c.approvedPayCents,
      paidCents: paidCentsOf(c.laborPayments ?? []),
      cashCostCents: pay.cashCostCents, economicValueCents: pay.economicValueCents,
      zeroLaborConfirmed: !!c.zeroLaborConfirmed,
      rateSnapshotAt: c.rateSnapshotAt?.toISOString() ?? null,
      payments: (c.laborPayments ?? []).map((p) => ({
        id: p.id, amountCents: p.amountCents, method: String(p.method),
        paidOn: p.paidOn.toISOString(), voided: p.voided, reference: p.reference,
      })),
    }
  })
  const crewTotalOwed = crewRows.reduce((s, cr) => s + crewPayOwedCents({ actualHours: cr.actualHours, scheduledHours: cr.scheduledHours, payRate: cr.payRate, userPayRate: cr.user.payRate, flatPay: cr.flatPay, tips: cr.tips, bonus: cr.bonus, deductions: cr.deductions }), 0)
  const crewPaidOwed = crewRows.filter((cr) => cr.payStatus !== 'PAID').reduce((s, cr) => s + crewPayOwedCents({ actualHours: cr.actualHours, scheduledHours: cr.scheduledHours, payRate: cr.payRate, userPayRate: cr.user.payRate, flatPay: cr.flatPay, tips: cr.tips, bonus: cr.bonus, deductions: cr.deductions }), 0)

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
              {completeness.status !== 'NOT_APPLICABLE' && (
                <CompletenessBadge label={completenessLabel(completeness)} complete={completeness.isComplete} />
              )}
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
            <div style={divider} />
            {/* ── The balance, from the ONE model (job-money.customerBalance).
                Quoted → billed → collected → outstanding. The outstanding
                balance INCLUDES the unpaid base labor; showing only the fee
                columns is what made this card understate a $460 balance as
                "$100 due on move day". ── */}
            <Row label="Quoted (estimate)" value={cents(balance.quotedCents) ?? '—'} />
            {balance.additionalChargeCents > 0 && (
              <Row label="+ Approved add-ons / move-day charges" value={cents(balance.additionalChargeCents)!} />
            )}
            {booking.discountType && (
              <Row
                label={`− Discount (${String(booking.discountType).replace(/_/g, ' ')} ${booking.discountPercent ?? 0}%)`}
                value={cents(balance.discountCents) ?? '$0.00'}
              />
            )}
            <Row label="Final billed amount" value={cents(balance.finalBilledCents) ?? '$0.00'} strong />
            {balance.quoteMissing && (
              <div style={{ fontSize: '11px', color: '#B45309', textAlign: 'right' }}>
                No stored quote — rebuilt from base labor + travel; confirm before collecting
              </div>
            )}
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <PayBadge color="#3B82F6" label="Deposit (Stripe)" value={cents(booking.depositAmount) ?? '$0.00'} note={booking.depositPaid ? 'captured' : 'held, not captured'} />
              <PayBadge color="#10B981" label="Collected" value={cents(balance.collectedCents) ?? '$0.00'} />
              {balance.refundedCents > 0 && <PayBadge color="#EF4444" label="Refunded" value={cents(balance.refundedCents)!} />}
              <PayBadge
                color={balance.outstandingCents > 0 ? '#F59E0B' : '#10B981'}
                label="Outstanding balance"
                value={cents(balance.outstandingCents) ?? '$0.00'}
                note={balance.outstandingCents > 0 ? 'collect on move day — not in Stripe' : 'paid in full'}
              />
            </div>
            {balance.outstandingCents > 0 && (
              <p style={{ fontSize: '11px', color: '#6B7280', margin: '10px 0 0' }}>
                Stripe only ever holds the {cents(booking.depositAmount) ?? '$49.00'} deposit. The full
                outstanding balance — base labor included — is collected in person on move day and must be
                logged with “Record payment”.
              </p>
            )}
          </Card>

          {/* Section 7b: Job Profit & Costs (admin OS; Phase 0 completeness) */}
          <Card
            title="Job Profit & Costs"
            icon="📊"
            action={
              completeness.status === 'NOT_APPLICABLE'
                ? <span style={{ fontSize: '11px', color: '#9CA3AF' }}>recorded money</span>
                : <CompletenessBadge label={completenessLabel(completeness)} complete={completeness.isComplete} />
            }
          >
            {/* The warning comes BEFORE the number on purpose: an incomplete
                profit figure must never be read as final. */}
            {completeness.warnings.length > 0 && (
              <Callout
                tone={completeness.blockers.length > 0 ? 'danger' : 'warning'}
                title={completeness.blockers.length > 0 ? 'This profit figure is incomplete' : 'Check before relying on this figure'}
              >
                <ul style={{ margin: 0, paddingLeft: '18px' }}>
                  {completeness.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              </Callout>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <Row label="Captured payments" value={cents(profit.grossCapturedCents) ?? '$0.00'} />
              {profit.refundedCents > 0 && <Row label="− Refunded" value={cents(profit.refundedCents)!} />}
              {profit.chargebackCents > 0 && <Row label="− Chargebacks (lost)" value={cents(profit.chargebackCents)!} />}
              <Row label="Net revenue collected" value={cents(profit.netRevenueCents) ?? '$0.00'} strong />
              {profit.authorizedNotCapturedCents > 0 && (
                <div style={{ fontSize: '11px', color: '#9CA3AF', textAlign: 'right' }}>
                  {cents(profit.authorizedNotCapturedCents)} authorized but not captured — not revenue
                </div>
              )}
              {profit.pendingDisputeCents > 0 && (
                <div style={{ fontSize: '11px', color: '#B45309', textAlign: 'right' }}>
                  {cents(profit.pendingDisputeCents)} disputed and at risk
                </div>
              )}
              <div style={divider} />
              <Row
                label="− Crew pay"
                value={
                  completeness.missingLabor
                    ? 'not recorded'
                    : completeness.laborConfirmedZero
                      ? '$0.00 (confirmed)'
                      : cents(profit.crewPayCents) ?? '$0.00'
                }
              />
              <Row label="− Job expenses" value={completeness.missingExpenses ? 'none recorded' : cents(profit.expenseCents) ?? '$0.00'} />
              <Row label="− Stripe fees (est.)" value={cents(profit.stripeFeeCents) ?? '$0.00'} />
              <div style={divider} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#0A1628' }}>
                  Cash gross profit{completeness.isComplete ? '' : ' (incomplete)'}
                </span>
                <span style={{ fontSize: '20px', fontWeight: 800, color: !completeness.isComplete && completeness.status !== 'NOT_APPLICABLE' ? '#B45309' : profit.netProfitCents >= 0 ? '#C9A961' : '#EF4444', fontVariantNumeric: 'tabular-nums' }}>{cents(profit.netProfitCents) ?? '$0.00'}</span>
              </div>

              {/* PHASE 1: was this move profitable on its own, or only because
                  the owners worked without paying themselves? */}
              {profit.unpaidOwnerValueCents > 0 && (
                <>
                  <Row label="− Unpaid owner labor (value)" value={cents(profit.unpaidOwnerValueCents)!} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: '#0A1628' }}>Economic profit</span>
                    <span style={{ fontSize: '17px', fontWeight: 800, color: profit.economicProfitCents >= 0 ? '#6366F1' : '#EF4444', fontVariantNumeric: 'tabular-nums' }}>
                      {cents(profit.economicProfitCents) ?? '$0.00'}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#9CA3AF', textAlign: 'right' }}>
                    what this move earned if the owners&apos; hours had to be hired
                  </div>
                </>
              )}
              {profit.pendingLaborCents > 0 && (
                <div style={{ fontSize: '11px', color: '#B45309', textAlign: 'right', marginTop: '2px' }}>
                  {cents(profit.pendingLaborCents)} of labor entered but not approved — not counted above
                </div>
              )}
              <div style={{ fontSize: '11px', color: '#9CA3AF', textAlign: 'right', marginTop: '2px' }}>
                {profit.marginPct != null && <>{Math.round(profit.marginPct * 100)}% margin · </>}
                crew owed {cents(crewPaidOwed) ?? '$0.00'} unpaid
              </div>
              {/* Honest label: overhead allocation is Phase 3, so this is gross. */}
              <div style={{ fontSize: '11px', color: '#9CA3AF', textAlign: 'right' }}>
                before company overhead (not yet allocated)
              </div>
            </div>
            {profit.netRevenueCents <= (booking.depositPaid ? booking.depositAmount : 0) && (
              <p style={{ fontSize: '11px', color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '6px', padding: '7px 9px', margin: '10px 0 0' }}>
                Only the deposit is recorded. Use “Record payment” to log move-day cash so profit is accurate.
              </p>
            )}

            {/* ── The 40/30/30 policy on the job profit summary (Stage 4).
                Rendered from the SHARED allocation model, and from the frozen
                snapshot once the move is finalized — the same numbers the
                closeout panel, Owner Money, the reports and the exports show. */}
            {closeout && (
              <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #F1F1F1' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Profit allocation
                  </span>
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '100px', backgroundColor: closeout.allocationBasis === 'FINALIZED' ? '#ECFDF5' : '#FFFBEB', color: closeout.allocationBasis === 'FINALIZED' ? '#065F46' : '#B45309' }}>
                    {closeout.allocationBasis === 'FINALIZED'
                      ? `Finalized · snapshot v${closeout.allocationSnapshotVersion}`
                      : 'Provisional'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '6px' }}>
                  <span style={{ fontSize: '13px', color: '#6B7280' }}>Final company net profit</span>
                  <span style={{ fontSize: '15px', fontWeight: 800, color: '#0A1628', fontVariantNumeric: 'tabular-nums' }}>
                    {cents(closeout.allocation.companyNetProfitCents) ?? '$0.00'}
                  </span>
                </div>
                {closeout.allocation.lines.map((ln) => (
                  <div key={ln.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '2px 0' }}>
                    <span style={{ fontSize: '12px', color: '#6B7280' }}>
                      {ln.label} — {bpToPercentLabel(ln.ofNetProfitBp)}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: ln.isBusiness ? '#0A1628' : '#C9A961', fontVariantNumeric: 'tabular-nums' }}>
                      {cents(ln.amountCents) ?? '$0.00'}
                    </span>
                  </div>
                ))}
                {!closeout.allocation.hasDistribution && (
                  <p style={{ fontSize: '11px', color: '#6B7280', margin: '6px 0 0' }}>
                    {closeout.allocation.companyNetProfitCents < 0
                      ? 'This move lost money, so nothing is allocated to anyone. The loss stands and the move can still be finalized.'
                      : 'No profit to allocate on this move.'}
                  </p>
                )}
                <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '6px 0 0', lineHeight: 1.5 }}>
                  {closeout.allocation.explanation}
                </p>
              </div>
            )}
          </Card>

          {/* Section 7b-2: Staffing (Stage 5) — assign crew/owners, conflicts, health */}
          {booking.job && (
            <Card title="Staffing" icon="👥" wide>
              <JobStaffingPanel jobId={booking.job.id} isOwner={isOwner} canManage={can(session?.role as Role, 'schedule.manage')} />
            </Card>
          )}

          {/* Section 7c: Job Expenses (admin OS) */}
          <Card title={`Job Expenses (${booking.expenses.length})`} icon="🧾">
            {booking.expenses.length === 0 ? (
              <Empty>No expenses logged for this job</Empty>
            ) : (
              booking.expenses.map((e, i) => {
                // Rejected rows stay VISIBLE (the spend happened and someone
                // should see the decision) but are struck through and excluded
                // from every total — money-rules.isEligibleExpense is the rule.
                const counted = isEligibleExpense(e)
                return (
                  <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: i < booking.expenses.length - 1 ? '1px solid #F3F4F6' : 'none', opacity: counted ? 1 : 0.55 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, textDecoration: counted ? 'none' : 'line-through' }}>{EXPENSE_CATEGORY_LABELS[e.category] ?? e.category}{e.vendor ? ` · ${e.vendor}` : ''}</div>
                      <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                        {new Date(e.incurredOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}
                        {!counted && ' · rejected — not counted'}
                        {e.receiptUrl ? ' · ' : ''}{e.receiptUrl && <a href={e.receiptUrl} target="_blank" rel="noreferrer" style={{ color: '#FF5A1F' }}>receipt</a>}
                      </div>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', textDecoration: counted ? 'none' : 'line-through' }}>{cents(e.amount)}</div>
                  </div>
                )
              })
            )}
            <div style={{ marginTop: '12px' }}>
              <ExpenseForm presetBookingId={booking.id} presetJobLabel={c.name} compact />
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
            <RecordPaymentPanel bookingId={booking.id} />
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

          {/* Section 10b: the send guard's own ledger — including refusals.
              "Communications" above shows what was handed off to be sent; this
              shows what was CONSIDERED, and why anything was not sent. */}
          <EmailTimeline
            bookingId={booking.id}
            customerEmail={booking.customer?.email}
            maySeeRecipients={can(session?.role as never, 'email.view_recipients')}
          />

          {/* ── Crew & Labor (Phase 1, owner spec 2026-07-20) ──
              The canonical labor record for this move. Assign crew, enter or
              clock hours, approve the money, record payments. Everything here
              writes JobCrew — nothing reads the Discord gig board. */}
          <Card
            title="Crew & Labor"
            icon="👥"
            action={<span style={{ fontSize: '11px', color: '#9CA3AF' }}>{LABOR_STATE_LABELS[completeness.laborState]}</span>}
          >
            {completeness.missingLabor && (
              <Callout tone="danger" title="Crew labor has not been recorded for this move.">
                Profit above may be overstated. This move&apos;s labor cost is <strong>unknown</strong>,
                not zero — assign the crew and enter their hours below.
              </Callout>
            )}
            {completeness.laborState === 'MISSING_CLOCK_OUT' && (
              <Callout tone="danger" title="A crew member has no clock-out.">
                Their hours are still open, so the labor cost is incomplete.
              </Callout>
            )}
            {completeness.laborUnapproved && (
              <Callout tone="warning" title="Hours are entered but not approved.">
                Unapproved labor is shown below but is <strong>not yet counted</strong> as a cost on
                this move. Approve it to make it real.
              </Callout>
            )}
            {booking.job && (
              <div style={{ marginBottom: '12px' }}>
                <Row label="Job status" value={booking.job.status} />
                {booking.job.startedAt && <Row label="Started" value={dateTime(booking.job.startedAt)} />}
                {booking.job.completedAt && <Row label="Completed" value={dateTime(booking.job.completedAt)} />}
              </div>
            )}
            <CrewLaborPanel
              bookingId={booking.id}
              assignments={laborAssignments}
              staff={staff.map((s) => ({ id: s.id, name: s.name, role: String(s.role), payRateCents: s.payRate, workerType: String(s.workerType) }))}
              isOwner={isOwner}
              currentUserId={session?.userId ?? ''}
            />
          </Card>
        </div>
      </div>

      {/* ── Financial Closeout (Phase 2, owner spec 2026-07-20) ──
          The move's durable financial record: revenue reconciled against cash,
          costs, profit, reserves and what may actually be distributed. Rendered
          full-width because it is the answer the whole admin exists to give. */}
      {closeout && (
        <Card
          title="Financial Closeout"
          icon="🧮"
          wide
          action={<span style={{ fontSize: '11px', color: '#9CA3AF' }}>{closeout.isFinalized ? 'finalized' : 'not finalized'}</span>}
        >
          <FinancialCloseoutPanel
            bookingId={booking.id}
            isOwner={isOwner}
            data={{
              status: closeout.status,
              isFinalized: closeout.isFinalized,
              canFinalize: closeout.decision.canFinalize,
              financials: {
                netBilledRevenueCents: closeout.financials.netBilledRevenueCents,
                netCollectedRevenueCents: closeout.financials.netCollectedRevenueCents,
                outstandingBalanceCents: closeout.financials.outstandingBalanceCents,
                refundedCents: closeout.financials.refundedCents,
                chargebackCents: closeout.financials.chargebackCents,
                disputedOpenCents: closeout.financials.disputedOpenCents,
                directJobCostCents: closeout.financials.directJobCostCents,
                crewLaborCents: closeout.financials.crewLaborCents,
                ownerEconomicLaborCents: closeout.financials.ownerEconomicLaborCents,
                processingFeeCents: closeout.financials.processingFeeCents,
                directExpenseCents: closeout.financials.directExpenseCents,
                profit: closeout.financials.profit,
                overhead: { amountCents: closeout.financials.overhead.amountCents, method: closeout.financials.overhead.method, basis: closeout.financials.overhead.basis },
                reserves: closeout.financials.reserves,
              },
              blockers: closeout.blockers,
              overrides: closeout.overrides,
              split: closeout.split,
              allocation: closeout.allocation,
              allocationBasis: closeout.allocationBasis,
              liveAllocation: closeout.liveAllocation,
              allocationSnapshotVersion: closeout.allocationSnapshotVersion,
              reopenReason: closeout.reopenReason,
              unpaidLaborCents: closeout.unpaidLaborCents,
              ownerReimbursementOwedCents: closeout.ownerReimbursementOwedCents,
              snapshots: closeout.snapshots.map((sn) => ({
                id: sn.id, version: sn.version,
                createdAt: sn.createdAt.toISOString(),
                supersededAt: sn.supersededAt ? sn.supersededAt.toISOString() : null,
                companyNetProfitCents: sn.companyNetProfitCents,
                distributableProfitCents: sn.distributableProfitCents,
                createdByName: sn.createdByName,
                calculationVersion: sn.calculationVersion,
                configSource: sn.configSource,
                configVersion: sn.configVersion,
                allocation: sn.allocation,
                deltaFromPreviousCents: sn.deltaFromPreviousCents,
              })),
              distributions: closeout.distributions,
            }}
          />
        </Card>
      )}

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
