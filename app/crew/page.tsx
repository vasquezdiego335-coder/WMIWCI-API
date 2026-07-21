import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { isLiveStatus, isAcknowledged } from '@/lib/assignment-lifecycle'
import CrewAssignmentCard from './CrewAssignmentCard'

// ════════════════════════════════════════════════════════════════════════════
//  Crew home (Stage 5) — the worker's own upcoming + completed assignments.
//  Worker-safe fields ONLY: never owner allocations, other workers' pay, private
//  customer or staff notes, or financial closeouts.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

const time = (d: Date | null) => (d ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : null)

export default async function CrewHome() {
  const session = await getSession()
  if (!session) return null

  const rows = await prisma.jobCrew.findMany({
    where: { userId: session.userId },
    orderBy: { assignedAt: 'desc' },
    take: 60,
    select: {
      id: true, assignmentStatus: true, role: true, isDriver: true, crewLeader: true,
      reportTime: true, scheduledStartAt: true, workerVisibleNotes: true, clockIn: true, clockOut: true,
      acknowledgedAt: true, acknowledgmentStaleAt: true, workedMinutes: true,
      job: { select: { status: true, booking: { select: { bookingReference: true, scheduledStart: true, originCity: true, destCity: true } }, staffingReq: { select: { reportTime: true, loadingLocation: true, unloadingLocation: true, workerInstructions: true } } } },
    },
  })

  const assignments = rows.map((r) => ({
    id: r.id,
    status: String(r.assignmentStatus),
    role: r.isDriver ? 'Driver' : r.crewLeader ? 'Job lead' : String(r.role).replace(/_/g, ' ').toLowerCase(),
    acknowledged: isAcknowledged(String(r.assignmentStatus), r.acknowledgedAt, r.acknowledgmentStaleAt),
    needsAck: !!r.acknowledgmentStaleAt || String(r.assignmentStatus) === 'OFFERED',
    reportTime: time(r.reportTime ?? r.job?.staffingReq?.reportTime ?? null),
    start: time(r.scheduledStartAt ?? r.job?.booking?.scheduledStart ?? null),
    reference: r.job?.booking?.bookingReference ?? r.id.slice(0, 8),
    route: [r.job?.booking?.originCity, r.job?.booking?.destCity].filter(Boolean).join(' → ') || null,
    loading: r.job?.staffingReq?.loadingLocation ?? null,
    unloading: r.job?.staffingReq?.unloadingLocation ?? null,
    notes: [r.workerVisibleNotes, r.job?.staffingReq?.workerInstructions].filter(Boolean).join('\n') || null,
    clockedIn: !!r.clockIn && !r.clockOut,
    completed: String(r.assignmentStatus) === 'COMPLETED',
    live: isLiveStatus(String(r.assignmentStatus)),
    workedHours: r.workedMinutes ? (r.workedMinutes / 60).toFixed(1) : null,
  }))

  const upcoming = assignments.filter((a) => a.live && !a.completed)
  const completed = assignments.filter((a) => a.completed)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, color: '#0A1628', margin: 0 }}>Your jobs</h1>

      {upcoming.length === 0 ? (
        <div style={{ backgroundColor: '#fff', borderRadius: '12px', padding: '24px', textAlign: 'center', color: '#6B7280', fontSize: '14px' }}>
          You have no upcoming assignments right now.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {upcoming.map((a) => <CrewAssignmentCard key={a.id} a={a} />)}
        </div>
      )}

      {completed.length > 0 && (
        <div>
          <h2 style={{ fontSize: '13px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0' }}>Completed</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {completed.slice(0, 10).map((a) => (
              <div key={a.id} style={{ backgroundColor: '#fff', borderRadius: '10px', padding: '12px 14px', fontSize: '13px', color: '#374151', display: 'flex', justifyContent: 'space-between' }}>
                <span>{a.reference} · {a.start}</span>
                <span style={{ color: '#9CA3AF' }}>{a.workedHours ? `${a.workedHours}h` : 'done'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
