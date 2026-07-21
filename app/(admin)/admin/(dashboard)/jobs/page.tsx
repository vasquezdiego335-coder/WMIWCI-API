import Link from 'next/link'
import { prisma } from '@/lib/db'
import { fmtCents } from '@/lib/profit'
import { customerBalance, jobProfit, jobWarnings, jobFinancialCompleteness, JOB_MONEY_PAYMENT_SELECT, JOB_MONEY_EXPENSE_SELECT } from '@/lib/job-money'
import { completenessLabel } from '@/lib/financial-completeness'
import { PageHeader, COLORS, Empty, Badge, SoftBadge, Callout, CompletenessBadge } from '../_ui'

export const dynamic = 'force-dynamic'

// Jobs = the operational view of bookings. The real BookingStatus enum drives
// everything (no parallel status system); these are friendlier labels + colors.
const STAGES: { status: string; label: string; color: string }[] = [
  { status: 'PENDING_APPROVAL', label: 'Needs Review', color: '#EF4444' },
  { status: 'CONFIRMED', label: 'Confirmed', color: '#3B82F6' },
  { status: 'SCHEDULED', label: 'Scheduled', color: '#6366F1' },
  { status: 'IN_PROGRESS', label: 'In Progress', color: '#F59E0B' },
  { status: 'COMPLETED', label: 'Completed', color: '#10B981' },
]
const STATUS_LABEL: Record<string, string> = {
  ...Object.fromEntries(STAGES.map((s) => [s.status, s.label])),
  ARCHIVED: 'Closed',
  CANCELLED: 'Cancelled',
  PENDING_PAYMENT: 'Awaiting Payment',
}
const STATUS_COLOR: Record<string, string> = {
  ...Object.fromEntries(STAGES.map((s) => [s.status, s.color])),
  ARCHIVED: '#6B7280',
  CANCELLED: '#374151',
  PENDING_PAYMENT: '#F59E0B',
}

const MONEY_INCLUDE = {
  customer: { select: { name: true, phone: true } },
  // Phase 0: the blessed selects carry refund/dispute + expense status so net
  // revenue and expense eligibility are computed from real data, not guesses.
  payments: { select: JOB_MONEY_PAYMENT_SELECT },
  job: { include: { crew: { include: { user: { select: { name: true, payRate: true } } } } } },
  expenses: { select: JOB_MONEY_EXPENSE_SELECT },
} as const

const cityOf = (addr?: string | null) => {
  if (!addr) return '—'
  const parts = addr.split(',').map((p) => p.trim())
  return parts.length >= 2 ? parts[parts.length - 2].replace(/\d{5}(-\d{4})?/, '').trim() || parts[0] : parts[0]
}
const dateTime = (d?: Date | null) => (d ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : 'Unscheduled')

export default async function JobsPage({ searchParams }: { searchParams: { status?: string; view?: string } }) {
  const activeStatuses = STAGES.map((s) => s.status)

  // Counts per stage (operational only, excludes owner test bookings).
  const grouped = await prisma.booking.groupBy({
    by: ['status'],
    where: { isInternalTest: false, status: { in: [...activeStatuses, 'CANCELLED', 'ARCHIVED'] as never } },
    _count: { _all: true },
  })
  const countByStatus: Record<string, number> = {}
  grouped.forEach((g) => { countByStatus[g.status] = g._count._all })

  // Which bookings to show.
  const now = new Date()
  const where: Record<string, unknown> = { isInternalTest: false }
  if (searchParams.status && STATUS_LABEL[searchParams.status]) {
    where.status = searchParams.status
  } else if (searchParams.view === 'today') {
    const start = new Date(now); start.setHours(0, 0, 0, 0)
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    where.scheduledStart = { gte: start, lte: end }
    where.status = { in: ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'] }
  } else if (searchParams.view === 'week') {
    const start = new Date(now); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(end.getDate() + 7)
    where.scheduledStart = { gte: start, lte: end }
    where.status = { in: ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'] }
  } else {
    where.status = { in: activeStatuses }
  }

  let bookings = await prisma.booking.findMany({
    where,
    include: MONEY_INCLUDE,
    orderBy: [{ scheduledStart: 'asc' }, { requestedDate: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  })

  // Client-side special views that need computed money/flags.
  if (searchParams.view === 'attention') bookings = bookings.filter((b) => jobWarnings(b).length > 0)
  if (searchParams.view === 'unpaid') bookings = bookings.filter((b) => customerBalance(b).outstandingCents > 0 && ['IN_PROGRESS', 'COMPLETED'].includes(b.status))

  const totalOperational = activeStatuses.reduce((s, st) => s + (countByStatus[st] ?? 0), 0)

  // Phase 0: how many of the visible moves are missing financial data. The
  // per-card badge is easy to skim past; the aggregate is not.
  const incompleteCount = bookings.filter((b) => {
    const c = jobFinancialCompleteness(b)
    return c.status !== 'NOT_APPLICABLE' && !c.isComplete
  }).length
  const missingLaborCount = bookings.filter((b) => jobFinancialCompleteness(b).missingLabor).length

  return (
    <div>
      <PageHeader title="Jobs" subtitle={`${totalOperational} active job${totalOperational === 1 ? '' : 's'} across the pipeline`} />

      {incompleteCount > 0 && (
        <Callout tone="warning" title={`${incompleteCount} move${incompleteCount === 1 ? '' : 's'} in this view ${incompleteCount === 1 ? 'has' : 'have'} incomplete financial data.`}>
          {missingLaborCount > 0 && <>Crew labor has not been recorded for {missingLaborCount} of them, so their profit is overstated. </>}
          Profit figures below are provisional until the missing information is entered.
        </Callout>
      )}

      {/* Pipeline stages — each pill filters + shows its count */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {STAGES.map((s) => {
          const active = searchParams.status === s.status
          return (
            <Link key={s.status} href={`/admin/jobs?status=${s.status}`} style={{ textDecoration: 'none' }}>
              <div style={{ ...stagePill, borderColor: active ? s.color : '#E5E7EB', backgroundColor: active ? `${s.color}12` : '#fff' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: s.color, display: 'inline-block' }} />
                <span style={{ fontWeight: 600, color: COLORS.ink }}>{s.label}</span>
                <span style={{ fontWeight: 800, color: s.color }}>{countByStatus[s.status] ?? 0}</span>
              </div>
            </Link>
          )
        })}
      </div>

      {/* Quick filters */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {[
          { view: '', label: 'All active' },
          { view: 'today', label: 'Today' },
          { view: 'week', label: 'This week' },
          { view: 'attention', label: '⚠ Needs attention' },
          { view: 'unpaid', label: 'Unpaid balance' },
        ].map((q) => {
          const active = (searchParams.view ?? '') === q.view && !searchParams.status
          return (
            <Link key={q.label} href={q.view ? `/admin/jobs?view=${q.view}` : '/admin/jobs'} style={{ ...chip, backgroundColor: active ? '#0A1628' : '#fff', color: active ? '#fff' : COLORS.ink, borderColor: active ? '#0A1628' : '#E5E7EB' }}>
              {q.label}
            </Link>
          )
        })}
        {(searchParams.status || searchParams.view) && (
          <span style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <SoftBadge color={STATUS_COLOR[searchParams.status ?? ''] ?? COLORS.muted}>{STATUS_LABEL[searchParams.status ?? ''] ?? searchParams.view}</SoftBadge>
            <Link href="/admin/jobs" style={{ fontSize: '12px', color: COLORS.muted }}>Clear</Link>
          </span>
        )}
      </div>

      {bookings.length === 0 ? (
        <Empty>No jobs match this view.</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {bookings.map((b) => {
            const p = jobProfit(b)
            const due = customerBalance(b).outstandingCents
            const warnings = jobWarnings(b)
            const completeness = jobFinancialCompleteness(b)
            const crew = b.job?.crew ?? []
            return (
              <Link key={b.id} href={`/admin/jobs/${b.id}`} style={{ textDecoration: 'none' }}>
                <div style={jobCard}>
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '15px', fontWeight: 700, color: COLORS.navy }}>{b.customer.name}</span>
                      <Badge color={STATUS_COLOR[b.status] ?? COLORS.muted}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
                      {completeness.status !== 'NOT_APPLICABLE' && (
                        <CompletenessBadge label={completenessLabel(completeness)} complete={completeness.isComplete} />
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: COLORS.muted }}>
                      {dateTime(b.scheduledStart ?? b.confirmedDate ?? b.requestedDate)}
                      {' · '}{cityOf(b.originAddress)} → {cityOf(b.destAddress)}
                    </div>
                    <div style={{ fontSize: '12px', color: COLORS.faint, marginTop: '2px' }}>
                      Crew: {crew.length ? crew.map((c) => c.user.name).join(', ') : 'unassigned'}
                    </div>
                  </div>

                  <div style={moneyCol}>
                    <MiniMoney label="Quoted" value={b.totalEstimate != null ? `$${b.totalEstimate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'} />
                    <MiniMoney label="Collected" value={fmtCents(p.netRevenueCents)} color={COLORS.green} />
                    <MiniMoney label="Outstanding" value={due > 0 ? fmtCents(due) : '—'} color={due > 0 ? COLORS.amber : COLORS.faint} />
                    <MiniMoney
                      label={completeness.isComplete || completeness.status === 'NOT_APPLICABLE' ? 'Gross profit' : 'Gross profit *'}
                      value={fmtCents(p.netProfitCents)}
                      color={completeness.status !== 'NOT_APPLICABLE' && !completeness.isComplete ? COLORS.amber : p.netProfitCents >= 0 ? COLORS.gold : COLORS.red}
                    />
                  </div>

                  {warnings.length > 0 && (
                    <div style={{ flexBasis: '100%', display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                      {warnings.map((w) => <SoftBadge key={w} color={COLORS.red}>⚠ {w}</SoftBadge>)}
                    </div>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MiniMoney({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ textAlign: 'right', minWidth: '92px' }}>
      <div style={{ fontSize: '10px', color: COLORS.faint, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 700, color: color ?? COLORS.navy, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

const stagePill: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 12px', border: '1px solid #E5E7EB', borderRadius: '10px', fontSize: '12px' }
const chip: React.CSSProperties = { padding: '7px 13px', border: '1px solid #E5E7EB', borderRadius: '100px', fontSize: '12px', fontWeight: 600, textDecoration: 'none' }
const jobCard: React.CSSProperties = { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '16px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
const moneyCol: React.CSSProperties = { display: 'flex', gap: '18px', flexWrap: 'wrap', justifyContent: 'flex-end' }
