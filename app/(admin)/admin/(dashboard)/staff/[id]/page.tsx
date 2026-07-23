import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { isLiveStatus, isAcknowledged } from '@/lib/assignment-lifecycle'
import { upcomingUnavailable } from '@/lib/availability-service'
import { formatMinute } from '@/lib/availability-engine'
import { PageHeader, Card, COLORS, Empty, Badge, tableStyles as T } from '../../_ui'
import StaffProfileEditor from './StaffProfileEditor'
import AvailabilityEditor from './AvailabilityEditor'
import DeactivateControl from './DeactivateControl'

export const dynamic = 'force-dynamic'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const day = (d: Date | null) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '—')
const STATUS_TONE: Record<string, string> = { ACTIVE: '#10B981', INACTIVE: '#9CA3AF', ON_LEAVE: '#F59E0B', UNAVAILABLE: '#F59E0B', SUSPENDED: '#EF4444' }

export default async function StaffDetail({ params }: { params: { id: string } }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, email: true, phone: true, role: true, workerType: true, active: true,
      workerStatus: true, skills: true, canDrive: true, canDriveCustomerVehicle: true, canLeadCrew: true,
      licenseExpiresAt: true, startDate: true, preferredRole: true, discordId: true,
      ownerEconomicRateCents: true, payRate: true, defaultFlatRateCents: true,
      availabilityRules: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
      availabilityExceptions: { orderBy: { date: 'desc' }, take: 30 },
      assignedJobs: {
        orderBy: { assignedAt: 'desc' }, take: 40,
        select: {
          id: true, assignmentStatus: true, isDriver: true, crewLeader: true, acknowledgedAt: true, acknowledgmentStaleAt: true,
          scheduledStartAt: true, workedMinutes: true, approvalStatus: true,
          job: { select: { bookingId: true, booking: { select: { bookingReference: true, scheduledStart: true } } } },
        },
      },
    },
  })
  if (!user) notFound()

  const [unavailable, auditRows] = await Promise.all([
    upcomingUnavailable(params.id, 8),
    isOwner
      ? prisma.auditLog.findMany({
          where: { details: { path: ['targetUserId'], equals: params.id } as never },
          orderBy: { createdAt: 'desc' }, take: 20,
          select: { action: true, createdAt: true, details: true },
        }).catch(() => [])
      : Promise.resolve([]),
  ])

  const live = user.assignedJobs.filter((a) => isLiveStatus(String(a.assignmentStatus)))
  const completed = user.assignedJobs.filter((a) => String(a.assignmentStatus) === 'COMPLETED')
  const totalMinutes = user.assignedJobs.reduce((s, a) => s + (a.workedMinutes ?? 0), 0)
  const rateLabel = user.role === 'OWNER'
    ? (user.ownerEconomicRateCents ? `$${(user.ownerEconomicRateCents / 100).toFixed(2)}/h owner labor` : 'Owner labor rate not configured')
    : (user.payRate ? `$${(user.payRate / 100).toFixed(2)}/h` : user.defaultFlatRateCents ? `$${(user.defaultFlatRateCents / 100).toFixed(2)} flat` : 'Rate not configured')

  return (
    <div>
      <div style={{ marginBottom: '8px' }}>
        <Link href="/admin/staff" style={{ fontSize: '12px', color: COLORS.orange, textDecoration: 'none' }}>← All staff</Link>
      </div>
      <PageHeader title={user.name} subtitle={`${user.role} · ${String(user.workerType)}`} />

      {/* Overview */}
      <Card title="Overview" icon="👤" wide>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px 24px' }}>
          <Field label="Email" value={user.email} />
          <Field label="Phone" value={user.phone ?? '—'} />
          <Field label="Worker status"><Badge color={STATUS_TONE[String(user.workerStatus)] ?? COLORS.muted}>{String(user.workerStatus)}</Badge></Field>
          <Field label="Labor rate" value={rateLabel} />
          <Field label="Driver" value={user.canDrive ? (user.canDriveCustomerVehicle ? 'Yes (+ customer trucks)' : 'Yes') : 'No'} />
          <Field label="License expires" value={day(user.licenseExpiresAt)} />
          <Field label="Can lead a crew" value={user.canLeadCrew ? 'Yes' : 'No'} />
          <Field label="Start date" value={day(user.startDate)} />
          <Field label="Discord" value={user.discordId ? '✓ Connected' : '✗ Not linked'} />
          <Field label="Total jobs" value={String(user.assignedJobs.length)} />
          <Field label="Approved hours" value={(totalMinutes / 60).toFixed(1)} />
          <Field label="Upcoming assignments" value={String(live.length)} />
        </div>
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '11px', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Skills</div>
          {user.skills.length === 0 ? <span style={{ fontSize: '12px', color: COLORS.faint }}>None recorded</span> : (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {user.skills.map((s) => <Badge key={String(s)} color={COLORS.navy}>{String(s).replace(/_/g, ' ')}</Badge>)}
            </div>
          )}
        </div>
      </Card>

      {isOwner && (
        <StaffProfileEditor
          userId={user.id}
          isOwnerProfile={user.role === 'OWNER'}
          initial={{
            phone: user.phone, workerStatus: String(user.workerStatus), skills: user.skills.map(String),
            canDrive: user.canDrive, canDriveCustomerVehicle: user.canDriveCustomerVehicle, canLeadCrew: user.canLeadCrew,
            licenseExpiresAt: user.licenseExpiresAt ? user.licenseExpiresAt.toISOString().slice(0, 10) : null,
            preferredRole: user.preferredRole,
          }}
        />
      )}

      {/* Availability */}
      <Card title="Availability" icon="📆" wide>
        <div style={{ fontSize: '12px', color: COLORS.muted, marginBottom: '10px' }}>
          Recurring weekly blocks and date-specific exceptions. Precedence: admin block &gt; date-unavailable &gt; date-available override &gt; recurring &gt; default unavailable.
        </div>
        {user.availabilityRules.length === 0 && user.availabilityExceptions.length === 0 ? (
          <Empty>No availability configured — this worker reads as unavailable by default.</Empty>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', marginBottom: '6px' }}>Weekly</div>
              {user.availabilityRules.length === 0 ? <span style={{ fontSize: '12px', color: COLORS.faint }}>No recurring rules</span> : user.availabilityRules.map((r) => (
                <div key={r.id} style={{ fontSize: '12px', color: COLORS.ink, padding: '2px 0' }}>
                  <strong>{DAYS[r.dayOfWeek]}</strong> {formatMinute(r.startMinute)}–{formatMinute(r.endMinute)}
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', marginBottom: '6px' }}>Upcoming unavailable</div>
              {unavailable.length === 0 ? <span style={{ fontSize: '12px', color: COLORS.faint }}>None</span> : unavailable.map((u) => (
                <div key={u.date} style={{ fontSize: '12px', color: COLORS.ink, padding: '2px 0' }}>
                  {day(new Date(`${u.date}T00:00:00Z`))} · {u.kind.replace(/_/g, ' ').toLowerCase()}
                </div>
              ))}
            </div>
          </div>
        )}
        {isOwner && (
          <AvailabilityEditor
            userId={user.id}
            rules={user.availabilityRules.map((r) => ({ id: r.id, dayOfWeek: r.dayOfWeek, startMinute: r.startMinute, endMinute: r.endMinute }))}
            exceptions={user.availabilityExceptions.map((e) => ({ id: e.id, kind: String(e.kind), date: e.date.toISOString().slice(0, 10), reason: e.reason }))}
          />
        )}
      </Card>

      {/* Assignments */}
      <Card title={`Assignments (${user.assignedJobs.length})`} icon="🗂️" wide>
        {user.assignedJobs.length === 0 ? <Empty>No assignments yet.</Empty> : (
          <div style={T.wrap}><div style={T.scroll}>
            <table style={T.table}>
              <thead><tr>{['Move', 'Date', 'Role', 'Status', 'Ack', 'Hours'].map((h) => <th key={h} style={T.th}>{h}</th>)}</tr></thead>
              <tbody>
                {user.assignedJobs.map((a) => (
                  <tr key={a.id}>
                    <td style={T.td}><Link href={`/admin/jobs/${a.job?.bookingId}`} style={{ color: COLORS.orange, textDecoration: 'none' }}>{a.job?.booking?.bookingReference ?? a.job?.bookingId?.slice(0, 8)}</Link></td>
                    <td style={T.td}>{day(a.scheduledStartAt ?? a.job?.booking?.scheduledStart ?? null)}</td>
                    <td style={T.td}>{a.isDriver ? 'Driver' : a.crewLeader ? 'Lead' : 'Mover'}</td>
                    <td style={T.td}><Badge color={isLiveStatus(String(a.assignmentStatus)) ? COLORS.navy : COLORS.muted}>{String(a.assignmentStatus)}</Badge></td>
                    <td style={T.td}>{isAcknowledged(String(a.assignmentStatus), a.acknowledgedAt, a.acknowledgmentStaleAt) ? '✓' : a.acknowledgmentStaleAt ? 'stale' : '—'}</td>
                    <td style={T.td}>{a.workedMinutes ? (a.workedMinutes / 60).toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </Card>

      {/* Audit (owner only) */}
      {isOwner && auditRows.length > 0 && (
        <Card title="Audit history" icon="📜" wide>
          {auditRows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '4px 0', borderBottom: '1px solid #F3F4F6' }}>
              <span style={{ color: COLORS.ink }}>{String(r.action).replace(/_/g, ' ').toLowerCase()}</span>
              <span style={{ color: COLORS.faint }}>{day(r.createdAt)}</span>
            </div>
          ))}
        </Card>
      )}

      {isOwner && user.id !== session?.userId && (
        <DeactivateControl userId={user.id} name={user.name} active={user.active} />
      )}
    </div>
  )
}

function Field({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: '10px', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>{label}</div>
      {children ?? <div style={{ fontSize: '13px', color: '#0A1628', fontWeight: 600 }}>{value}</div>}
    </div>
  )
}
