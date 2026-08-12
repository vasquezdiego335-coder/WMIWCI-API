import { prisma } from '@/lib/db'
import { etDayRange, effectiveMoveDate } from '@/lib/scheduling'
import { TRUCK_CONFLICT_STATUSES } from '@/lib/truck-conflicts'
import { PageHeader, StatCard, StatGrid, COLORS, Empty, tableStyles as T, tableScrollProps, Badge, SoftBadge, Callout } from '../_ui'
import TruckForm from './TruckForm'
import TruckActions from './TruckActions'

export const dynamic = 'force-dynamic'

// Moving OS Phase 1 — fleet trucks (owner spec 2026-08-11). Trucks are
// ENTITIES now, so a double-booking is detectable (truck-double-booked Action
// Center rule + the Book Move conflict check). RETIRED/inactive trucks stay
// listed so historical bookings keep their assignment.

const STATUS_COLORS: Record<string, string> = {
  AVAILABLE: COLORS.green,
  MAINTENANCE: COLORS.amber,
  RETIRED: COLORS.faint,
}
const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: 'Available',
  MAINTENANCE: 'Maintenance',
  RETIRED: 'Retired',
}
const SOURCE_LABELS: Record<string, string> = {
  CUSTOMER_PROVIDED: 'Customer provided',
  COMPANY_OWNED: 'Company owned',
  RENTAL: 'Rental',
  THIRD_PARTY: 'Third party',
  NOT_REQUIRED: 'Not required',
}

type TruckRow = {
  id: string
  name: string
  size: string
  source: string
  status: string
  capacityNotes: string | null
  active: boolean
}

type AssignmentRow = {
  truckId: string | null
  scheduledStart: Date | null
  confirmedDate: Date | null
  requestedDate: Date | null
}

export default async function TrucksPage() {
  let trucks: TruckRow[] = []
  let assignments: AssignmentRow[] = []
  let migrationMissing = false

  // Fail SOFT when the trucks table is missing: migrations are applied
  // manually (house rule), so an unapplied database renders an honest callout
  // instead of crashing the page.
  try {
    trucks = await prisma.truck.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] })
    assignments = await prisma.booking.findMany({
      where: {
        truckId: { not: null },
        isInternalTest: false,
        status: { in: [...TRUCK_CONFLICT_STATUSES] },
      },
      select: { truckId: true, scheduledStart: true, confirmedDate: true, requestedDate: true },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if ((err as { code?: string })?.code === 'P2021' || /does not exist/i.test(msg)) {
      migrationMissing = true
    } else {
      throw err
    }
  }

  const { start: todayStart, end: todayEnd } = etDayRange(0)
  const todayCount = new Map<string, number>()
  const upcomingCount = new Map<string, number>()
  for (const a of assignments) {
    const when = effectiveMoveDate(a)
    if (!when || !a.truckId) continue
    if (when >= todayStart && when <= todayEnd) {
      todayCount.set(a.truckId, (todayCount.get(a.truckId) ?? 0) + 1)
    } else if (when > todayEnd) {
      upcomingCount.set(a.truckId, (upcomingCount.get(a.truckId) ?? 0) + 1)
    }
  }

  const activeTrucks = trucks.filter((t) => t.active)
  const available = activeTrucks.filter((t) => t.status === 'AVAILABLE').length
  const maintenance = activeTrucks.filter((t) => t.status === 'MAINTENANCE').length
  const todayTotal = Array.from(todayCount.values()).reduce((s, n) => s + n, 0)

  return (
    <div>
      <PageHeader
        title="Trucks"
        subtitle="The fleet. Assign a truck on Book Move and double-bookings become detectable — the Action Center flags two jobs sharing one truck."
      />

      {migrationMissing ? (
        <Callout tone="danger" title="Trucks table missing — migration 20260811000000_moving_os_phase1 not applied">
          This database does not have the Moving OS Phase 1 tables yet. Apply the migration manually
          (see docs/deployment.md), then reload this page. Nothing is broken — the fleet is simply not
          available until then.
        </Callout>
      ) : (
        <>
          <StatGrid>
            <StatCard label="Fleet" value={String(activeTrucks.length)} accent={COLORS.navy} sub={trucks.length > activeTrucks.length ? `${trucks.length - activeTrucks.length} deactivated` : 'active trucks'} />
            <StatCard label="Available" value={String(available)} accent={COLORS.green} sub="ready to assign" />
            <StatCard label="In maintenance" value={String(maintenance)} accent={maintenance > 0 ? COLORS.amber : COLORS.green} sub={maintenance > 0 ? 'not assignable' : 'all healthy'} />
            <StatCard label="Assigned today" value={String(todayTotal)} accent={todayTotal > 0 ? COLORS.orange : COLORS.navy} sub="live jobs with this fleet" />
          </StatGrid>

          <TruckForm />

          {trucks.length === 0 ? (
            <div style={{ ...T.wrap, padding: '28px' }}>
              <Empty>No trucks yet. Add the first one above — even a rented U-Haul is worth tracking, so two jobs can never silently share it.</Empty>
            </div>
          ) : (
            <div style={T.wrap}>
              <div style={T.scroll} {...tableScrollProps('Fleet trucks')}>
                <table style={T.table}>
                  <thead>
                    <tr>
                      {['Truck', 'Size', 'Source', 'Status', 'Active', 'Today', 'Upcoming', ''].map((h) => (
                        <th key={h} style={T.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trucks.map((t) => (
                      <tr key={t.id} style={t.active ? undefined : { opacity: 0.55 }}>
                        <td style={{ ...T.td, fontWeight: 700 }}>
                          {t.name}
                          {t.capacityNotes && <div style={{ fontSize: '11px', fontWeight: 400, color: COLORS.faint, marginTop: '2px' }}>{t.capacityNotes}</div>}
                        </td>
                        <td style={T.td}>{t.size}</td>
                        <td style={T.td}>{SOURCE_LABELS[t.source] ?? t.source}</td>
                        <td style={T.td}><Badge color={STATUS_COLORS[t.status] ?? COLORS.muted}>{STATUS_LABELS[t.status] ?? t.status}</Badge></td>
                        <td style={T.td}>{t.active ? <SoftBadge color={COLORS.green}>Active</SoftBadge> : <SoftBadge color={COLORS.faint}>Deactivated</SoftBadge>}</td>
                        <td style={{ ...T.td, fontVariantNumeric: 'tabular-nums' }}>{todayCount.get(t.id) ?? 0}</td>
                        <td style={{ ...T.td, fontVariantNumeric: 'tabular-nums' }}>{upcomingCount.get(t.id) ?? 0}</td>
                        <td style={T.td}>
                          <TruckActions
                            id={t.id}
                            name={t.name}
                            size={t.size}
                            source={t.source}
                            status={t.status}
                            capacityNotes={t.capacityNotes}
                            active={t.active}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
