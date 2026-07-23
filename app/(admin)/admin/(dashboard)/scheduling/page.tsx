import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { loadSchedulingBoard, type BoardJob } from '@/lib/scheduling-service'
import { PageHeader, Card, COLORS, Empty, Badge } from '../_ui'

// ════════════════════════════════════════════════════════════════════════════
//  Scheduling board (Stage 5) — /admin/scheduling
//  Day/week job view with staffing health, plus the at-risk panels. Read-first;
//  every job links to its staffing panel where assignments are actually made.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

const day = (d: Date | null) => (d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '—')
const time = (d: Date | null) => (d ? new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '')

export default async function SchedulingBoard({ searchParams }: { searchParams: { start?: string; end?: string } }) {
  const session = await getSession()
  const role = session?.role as Role

  if (!can(role, 'schedule.view')) {
    return (
      <div>
        <PageHeader title="Scheduling" subtitle="Staff jobs and manage the crew schedule." />
        <Card><Empty>You do not have permission to view the schedule.</Empty></Card>
      </div>
    )
  }

  const start = searchParams.start ? new Date(`${searchParams.start}T00:00:00Z`) : new Date()
  const end = searchParams.end ? new Date(`${searchParams.end}T23:59:59Z`) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  const { jobs } = await loadSchedulingBoard({ start, end })

  const unstaffed = jobs.filter((j) => j.liveCount === 0)
  const understaffed = jobs.filter((j) => j.liveCount > 0 && j.liveCount < j.requiredWorkers)
  const missingDriver = jobs.filter((j) => j.requiredDrivers > 0 && j.driverCount < j.requiredDrivers)
  const missingLead = jobs.filter((j) => j.requiresLead && j.leadCount === 0)
  const unacked = jobs.filter((j) => j.unacknowledged > 0)

  // Group by local date for the day view.
  const byDate = new Map<string, BoardJob[]>()
  for (const j of jobs) {
    const key = j.scheduledStart ? new Date(j.scheduledStart).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : 'Unscheduled'
    if (!byDate.has(key)) byDate.set(key, [])
    byDate.get(key)!.push(j)
  }

  return (
    <div>
      <PageHeader title="Scheduling" subtitle={`${jobs.length} job${jobs.length === 1 ? '' : 's'} in the selected window. Owners and crew both count toward staffing.`} />

      {/* At-risk panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '20px' }}>
        <RiskTile label="Unstaffed" count={unstaffed.length} tone={COLORS.red} />
        <RiskTile label="Understaffed" count={understaffed.length} tone={COLORS.amber} />
        <RiskTile label="Missing driver" count={missingDriver.length} tone={COLORS.amber} />
        <RiskTile label="Missing lead" count={missingLead.length} tone={COLORS.amber} />
        <RiskTile label="Unacknowledged" count={unacked.reduce((s, j) => s + j.unacknowledged, 0)} tone={COLORS.gold} />
      </div>

      {jobs.length === 0 ? (
        <Card><Empty>No jobs are scheduled in this window. Approved bookings with a scheduled date appear here.</Empty></Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {Array.from(byDate.entries()).map(([date, dayJobs]) => (
            <div key={date}>
              <h2 style={{ fontSize: '13px', fontWeight: 700, color: COLORS.navy, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' }}>
                {date === 'Unscheduled' ? 'Unscheduled' : day(dayJobs[0].scheduledStart)}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                {dayJobs.map((j) => (
                  <Link key={j.jobId} href={`/admin/jobs/${j.bookingId}#staffing`} style={{ textDecoration: 'none' }}>
                    <div style={{ backgroundColor: '#fff', border: '1px solid #EFEFEF', borderLeft: `4px solid ${j.healthTone}`, borderRadius: '10px', padding: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy }}>{j.customerName}</div>
                          <div style={{ fontSize: '11px', color: COLORS.muted }}>{j.bookingReference ?? j.bookingId.slice(0, 8)}</div>
                        </div>
                        <Badge color={j.healthTone}>{j.health}</Badge>
                      </div>
                      <div style={{ fontSize: '12px', color: COLORS.muted, marginTop: '8px' }}>
                        {time(j.scheduledStart)}{j.scheduledEnd ? `–${time(j.scheduledEnd)}` : ''} · {[j.originCity, j.destCity].filter(Boolean).join(' → ') || 'No route'}
                      </div>
                      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px', fontSize: '11px', color: COLORS.ink }}>
                        <span>👥 {j.liveCount}/{j.requiredWorkers || '—'}</span>
                        <span style={{ color: j.driverCount < j.requiredDrivers ? COLORS.red : COLORS.green }}>{j.driverCount}/{j.requiredDrivers} driver</span>
                        {j.requiresLead && <span style={{ color: j.leadCount === 0 ? COLORS.red : COLORS.green }}>lead {j.leadCount}</span>}
                        {j.unacknowledged > 0 && <span style={{ color: COLORS.amber }}>{j.unacknowledged} unack</span>}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RiskTile({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '10px', padding: '12px 14px', textAlign: 'center' }}>
      <div style={{ fontSize: '22px', fontWeight: 800, color: count > 0 ? tone : COLORS.muted, fontVariantNumeric: 'tabular-nums' }}>{count}</div>
      <div style={{ fontSize: '11px', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  )
}
