import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'

export const revalidate = 60

function getWeekDays(anchor: Date): Date[] {
  const days: Date[] = []
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - anchor.getDay() + 1) // Monday
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(d)
  }
  return days
}

function toET(date: Date) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: '#3B82F6', SCHEDULED: '#6366F1', IN_PROGRESS: '#F59E0B', COMPLETED: '#10B981',
}

export default async function AdminSchedule({
  searchParams,
}: {
  searchParams: { week?: string }
}) {
  await getSession()

  const now = new Date()
  const anchor = searchParams.week ? new Date(searchParams.week) : now
  const weekDays = getWeekDays(anchor)
  const weekStart = weekDays[0]
  const weekEnd = new Date(weekDays[6])
  weekEnd.setHours(23, 59, 59, 999)

  const bookings = await prisma.booking.findMany({
    where: {
      scheduledStart: { gte: weekStart, lte: weekEnd },
      status: { in: ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] },
    },
    include: { customer: { select: { name: true, phone: true } } },
    orderBy: { scheduledStart: 'asc' },
  })

  // Group by day
  const byDay: Record<string, typeof bookings> = {}
  for (const b of bookings) {
    const key = toET(b.scheduledStart!).toDateString()
    if (!byDay[key]) byDay[key] = []
    byDay[key].push(b)
  }

  const prevWeek = new Date(weekStart)
  prevWeek.setDate(weekStart.getDate() - 7)
  const nextWeek = new Date(weekStart)
  nextWeek.setDate(weekStart.getDate() + 7)

  const weekLabel = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  // Admin day blocks
  const dayBlocks = await prisma.dayBlock.findMany({
    where: {
      date: { gte: weekStart, lte: weekEnd },
      blocked: true,
    },
  })
  const blockedDates = new Set(dayBlocks.map((b) => toET(b.date).toDateString()))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1 style={h1}>Schedule</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <Link href={`/admin/schedule?week=${prevWeek.toISOString().slice(0, 10)}`} style={navBtn}>← Prev</Link>
          <span style={{ fontSize: '14px', fontWeight: '600', color: '#0A1628' }}>{weekLabel}</span>
          <Link href={`/admin/schedule?week=${nextWeek.toISOString().slice(0, 10)}`} style={navBtn}>Next →</Link>
          <Link href="/admin/schedule" style={{ ...navBtn, backgroundColor: '#FF5A1F', color: '#FFFFFF' }}>Today</Link>
        </div>
      </div>

      <div style={calGrid}>
        {weekDays.map((day) => {
          const key = day.toDateString()
          const isToday = day.toDateString() === now.toDateString()
          const isWeekend = day.getDay() === 0 || day.getDay() === 6
          const isBlocked = blockedDates.has(key)
          const jobs = byDay[key] ?? []

          return (
            <div key={key} style={{
              ...dayCol,
              backgroundColor: isWeekend ? '#F9FAFB' : '#FFFFFF',
              borderTop: isToday ? '3px solid #FF5A1F' : '3px solid transparent',
            }}>
              <div style={{ marginBottom: '12px' }}>
                <p style={{ fontSize: '11px', fontWeight: '600', color: '#9CA3AF', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 2px' }}>
                  {day.toLocaleDateString('en-US', { weekday: 'short' })}
                </p>
                <p style={{ fontSize: '20px', fontWeight: isToday ? '800' : '600', color: isToday ? '#FF5A1F' : '#0A1628', margin: '0' }}>
                  {day.getDate()}
                </p>
                {isBlocked && (
                  <span style={{ fontSize: '10px', backgroundColor: '#FEE2E2', color: '#EF4444', padding: '2px 6px', borderRadius: '100px', fontWeight: '600' }}>BLOCKED</span>
                )}
                {isWeekend && !isBlocked && (
                  <span style={{ fontSize: '10px', color: '#9CA3AF' }}>—</span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {jobs.map((b) => (
                  <Link key={b.id} href={`/admin/jobs/${b.id}`} style={{ textDecoration: 'none' }}>
                    <div style={{
                      backgroundColor: '#F9FAFB',
                      border: `2px solid ${STATUS_COLORS[b.status] ?? '#E5E7EB'}`,
                      borderRadius: '8px',
                      padding: '8px 10px',
                    }}>
                      <p style={{ fontSize: '12px', fontWeight: '600', color: '#0A1628', margin: '0 0 2px' }}>{b.customer.name}</p>
                      <p style={{ fontSize: '11px', color: '#6B7280', margin: '0 0 2px' }}>
                        {b.scheduledStart ? new Date(b.scheduledStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'}
                      </p>
                      <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '0' }}>{b.originAddress.split(',')[0]}</p>
                      <span style={{ fontSize: '10px', fontWeight: '700', color: STATUS_COLORS[b.status] ?? '#9CA3AF' }}>
                        {b.status.replace('_', ' ')}
                      </span>
                    </div>
                  </Link>
                ))}

                {jobs.length === 0 && !isWeekend && !isBlocked && (
                  <p style={{ fontSize: '12px', color: '#D1D5DB', fontStyle: 'italic', margin: '0' }}>Open</p>
                )}
              </div>

              {/* Block/unblock toggle */}
              {!isWeekend && (
                <form action="/api/admin/availability" method="POST" style={{ marginTop: '12px' }}>
                  <input type="hidden" name="date" value={day.toISOString().slice(0, 10)} />
                  <input type="hidden" name="blocked" value={isBlocked ? 'false' : 'true'} />
                  <button type="submit" style={{
                    fontSize: '11px',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    border: '1px solid #E5E7EB',
                    backgroundColor: 'transparent',
                    color: '#6B7280',
                    cursor: 'pointer',
                    width: '100%',
                  }}>
                    {isBlocked ? 'Unblock day' : 'Block day'}
                  </button>
                </form>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0' }
const navBtn: React.CSSProperties = { padding: '6px 14px', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '13px', color: '#374151', textDecoration: 'none', backgroundColor: '#FFFFFF' }
const calGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }
const dayCol: React.CSSProperties = { borderRadius: '10px', padding: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minHeight: '220px' }
