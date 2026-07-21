import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'
import { fmtCents, crewPayOwedCents } from '@/lib/profit'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from '@/lib/job-money'
import { summarizeRevenue, ELIGIBLE_EXPENSE_WHERE, CAPTURED_PAYMENT_WHERE, isLaborUnrecorded } from '@/lib/money-rules'
import { Callout } from './_ui'
import { evaluateFinancialSetup } from '@/lib/financial-setup'

export const revalidate = 60 // revalidate every 60 seconds

async function getDashboardData() {
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [
    todayBookings,
    pendingApproval,
    pendingDiscounts,
    thisMonthRevenue,
    thisMonthExpenses,
    totalBookings,
    liveJobs,
    allUsers,
    businessConfig,
    attentionReminders,
  ] = await Promise.all([
    prisma.booking.findMany({
      where: { scheduledStart: { gte: todayStart, lte: todayEnd }, status: { in: ['SCHEDULED', 'IN_PROGRESS', 'CONFIRMED'] }, isInternalTest: false },
      include: { customer: { select: { name: true, phone: true } } },
      orderBy: { scheduledStart: 'asc' },
    }),
    prisma.booking.count({ where: { status: 'PENDING_APPROVAL', isInternalTest: false } }),
    prisma.booking.count({ where: { discountType: 'DOOR_HANGER_PENDING', isInternalTest: false } }),
    // PHASE 0: revenue is NET (captured − refunds − chargebacks), derived by
    // money-rules so this card can never disagree with the Revenue page or a
    // job's Profit card. isInternalTest=false: owner tests are never revenue.
    prisma.payment.findMany({
      where: { ...CAPTURED_PAYMENT_WHERE, isInternalTest: false, createdAt: { gte: monthStart } },
      select: { amount: true, status: true, isInternalTest: true, refundedAmountCents: true, stripeDisputeId: true, disputeStatus: true },
    }),
    // PHASE 0: REJECTED expenses are excluded here exactly as they are on Owner
    // Money. Before this fix the two pages reported different monthly totals
    // from the same rows.
    prisma.expense.aggregate({ where: { ...ELIGIBLE_EXPENSE_WHERE, incurredOn: { gte: monthStart } }, _sum: { amount: true } }),
    // REAL operational bookings only. Two exclusions fix the inflated "53":
    //  • PENDING_PAYMENT = abandoned checkout (submitted, Stripe never paid) — not a booking.
    //  • isInternalTest = the owner's own checkout tests (flagged by signal).
    prisma.booking.count({ where: { status: { in: ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] }, isInternalTest: false } }),
    // Live jobs → outstanding move-day balances + unpaid crew (money-spine cards)
    // + how many have no labor recorded at all (Phase 0 aggregate warning).
    prisma.booking.findMany({
      where: { status: { in: ['IN_PROGRESS', 'COMPLETED'] }, isInternalTest: false },
      select: {
        // The balance model needs the QUOTE and the PAYMENTS, not just the fee
        // columns — outstanding balance includes unpaid base labor.
        status: true, totalEstimate: true, baseRate: true, discountPercent: true,
        truckAddonAmount: true, truckAddonDueOnMoveDay: true, travelFee: true, additionalTruckFees: true,
        stairFee: true, longCarryFee: true, heavyItemFee: true, packingFee: true, assemblyFee: true,
        disassemblyFee: true, taxAmount: true, waitingFee: true, waitingFeeOverride: true, waitingFeeWaived: true,
        crewArrivedAt: true, customerReadyAt: true, waitingStartedAt: true, waitingEndedAt: true,
        payments: { select: JOB_MONEY_PAYMENT_SELECT },
        job: { select: { crew: { select: { actualHours: true, scheduledHours: true, payRate: true, flatPay: true, tips: true, bonus: true, deductions: true, payStatus: true, user: { select: { payRate: true } } } } } },
      },
      take: 500,
    }),
    // D6 (Stage 4): what the owner still has to configure before ANY move can
    // be closed out. Reported, never guessed — a missing rate is unknown, not $0.
    prisma.user.findMany({ select: { role: true, workerType: true, name: true, active: true, payRate: true, ownerEconomicRateCents: true } }),
    prisma.businessConfig.findUnique({ where: { id: 'singleton' } }).catch(() => null),
    // Needs Attention: top open reminders (critical → overdue → due today → rest).
    prisma.reminder.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
      orderBy: [{ severity: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 5,
      select: { id: true, title: true, severity: true, dueAt: true, assignedOwner: true, sourceUrl: true },
    }),
  ])

  const outstandingBalances = liveJobs.reduce((s, b) => s + customerBalance(b as never).outstandingCents, 0)
  const unpaidCrew = liveJobs.reduce((s, b) => s + (b.job?.crew ?? [])
    .filter((c) => c.payStatus !== 'PAID')
    .reduce((cs, c) => cs + crewPayOwedCents({ actualHours: c.actualHours, scheduledHours: c.scheduledHours, payRate: c.payRate, userPayRate: c.user?.payRate, flatPay: c.flatPay, tips: c.tips, bonus: c.bonus, deductions: c.deductions }), 0), 0)
  // Worked moves whose labor cost is UNKNOWN (not zero). Drives the banner.
  const movesMissingLabor = liveJobs.filter((b) => isLaborUnrecorded(b.job?.crew ?? [])).length

  const revenue = summarizeRevenue(thisMonthRevenue)

  const setup = evaluateFinancialSetup({
    users: allUsers.map((u) => ({ role: String(u.role), workerType: String(u.workerType), name: u.name, active: u.active, payRate: u.payRate, ownerEconomicRateCents: u.ownerEconomicRateCents })),
    ownerEconomicRateCents: businessConfig?.ownerEconomicRateCents ?? null,
    hasBusinessConfig: !!businessConfig,
  })

  return { setup, todayBookings, pendingApproval, pendingDiscounts, revenue, thisMonthExpenses, totalBookings, outstandingBalances, unpaidCrew, movesMissingLabor, liveJobCount: liveJobs.length, attentionReminders }
}

const SEVERITY_ICON: Record<string, string> = { CRITICAL: '🚨', HIGH: '⚠️', MEDIUM: '🟠', LOW: '🔹', INFO: 'ℹ️' }

export default async function AdminDashboard() {
  const session = await getSession()
  const { setup, todayBookings, pendingApproval, pendingDiscounts, revenue, thisMonthExpenses, totalBookings, outstandingBalances, unpaidCrew, movesMissingLabor, liveJobCount, attentionReminders } = await getDashboardData()

  const revenueCents = revenue.netCollectedCents
  const expenseCents = thisMonthExpenses._sum?.amount ?? 0

  return (
    <div>
      <h1 style={h1}>Dashboard</h1>
      <p style={subtitle}>Good morning, {session?.name}. Here's what's happening today.</p>

      {/* D6 (Stage 4): the owner cannot close ANY move until these are set.
          Shown above the money so it is read before the numbers are trusted. */}
      {!setup.ready && (
        <Callout tone="warning" title={setup.headline ?? 'Financial setup required'}>
          Moves cannot be financially finalized until these are configured. A missing rate is
          treated as <strong>unknown</strong>, never $0 — so profit stays incomplete rather than wrong.
          <ul style={{ margin: '8px 0 0', paddingLeft: '18px' }}>
            {setup.outstanding.map((item) => (
              <li key={item.key}>
                <Link href={item.href} style={{ color: '#FF5A1F', fontWeight: 600 }}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {/* PHASE 0: an aggregate that includes moves with no labor recorded is
          overstated. Say so at the top, before any number is read. */}
      {movesMissingLabor > 0 && (
        <Callout
          tone="warning"
          title={`${movesMissingLabor} of ${liveJobCount} worked move${liveJobCount === 1 ? '' : 's'} ${movesMissingLabor === 1 ? 'has' : 'have'} no crew labor recorded.`}
        >
          Labor is the largest cost on a move, so every profit and cash figure below is
          <strong> overstated</strong> until it is entered. Revenue and expense totals are
          unaffected. Assign the crew and enter their hours in <strong>Crew &amp; Labor</strong> on
          each move. <Link href="/admin/jobs" style={{ color: '#FF5A1F', fontWeight: 700 }}>Review those moves →</Link>
        </Callout>
      )}

      {/* Money-spine cards (owner spec 2026-07-13). Net profit / cash available
          land with the Reports increment where the P&L rule is defined. */}
      <div style={statsGrid}>
        <StatCard label="Net Revenue This Month" value={fmtCents(revenueCents)} color="#10B981" />
        <StatCard label="Expenses This Month" value={fmtCents(expenseCents)} color="#C9A961" />
        <StatCard label="Outstanding Balances" value={fmtCents(outstandingBalances)} color={outstandingBalances > 0 ? '#F59E0B' : '#10B981'} />
        <StatCard label="Unpaid Worker Pay" value={fmtCents(unpaidCrew)} color={unpaidCrew > 0 ? '#EF4444' : '#10B981'} />
        <StatCard label="Today's Jobs" value={todayBookings.length.toString()} color="#FF5A1F" />
        <StatCard label="Pending Approval" value={pendingApproval.toString()} color={pendingApproval > 0 ? '#F59E0B' : '#10B981'} />
        <StatCard label="Discount Requests" value={pendingDiscounts.toString()} color={pendingDiscounts > 0 ? '#EF4444' : '#10B981'} />
        <StatCard label="Total Bookings" value={totalBookings.toString()} color="#6366F1" />
      </div>

      {/* Quick actions */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '28px' }}>
        <Link href="/admin/jobs" style={quickAction}>🚚 Jobs pipeline</Link>
        <Link href="/admin/expenses" style={quickAction}>🧾 Add expense</Link>
        <Link href="/admin/owner-money" style={quickAction}>🏦 Owner money</Link>
        <Link href="/admin/bookings" style={quickAction}>📋 Bookings</Link>
        <Link href="/admin/action-center" style={quickAction}>🔔 Action Center</Link>
      </div>

      {/* Needs Attention — top open reminders from the Action Center */}
      {attentionReminders.length > 0 && (
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '16px 18px', marginBottom: '28px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h2 style={{ fontSize: '14px', fontWeight: 700, color: '#0A1628', margin: 0 }}>🔔 Needs Attention</h2>
            <Link href="/admin/action-center" style={{ fontSize: '12px', color: '#FF5A1F', fontWeight: 700, textDecoration: 'none' }}>View all →</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {attentionReminders.map((r, i) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: i < attentionReminders.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <span title={r.severity}>{SEVERITY_ICON[r.severity] ?? '🔹'}</span>
                  <span style={{ fontSize: '13px', color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, fontSize: '11px', color: '#9CA3AF' }}>
                  {r.dueAt && <span>due {new Date(r.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}</span>}
                  {r.assignedOwner && <span>{r.assignedOwner === 'DIEGO' ? 'Diego' : 'Sebastian'}</span>}
                  <Link href={r.sourceUrl ?? '/admin/action-center'} style={{ color: '#FF5A1F', fontWeight: 700, textDecoration: 'none' }}>Open →</Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Alerts */}
      {pendingApproval > 0 && (
        <div style={alert}>
          ⚠️ {pendingApproval} booking{pendingApproval > 1 ? 's' : ''} waiting for approval —{' '}
          <Link href="/admin/bookings?status=PENDING_APPROVAL" style={{ color: '#FF5A1F' }}>Review now →</Link>
        </div>
      )}
      {pendingDiscounts > 0 && (
        <div style={{ ...alert, backgroundColor: '#FEF3C7', borderColor: '#F59E0B' }}>
          🏷 {pendingDiscounts} door hanger discount{pendingDiscounts > 1 ? 's' : ''} need approval —{' '}
          <Link href="/admin/discounts" style={{ color: '#FF5A1F' }}>Review →</Link>
        </div>
      )}

      {/* Today's schedule */}
      <h2 style={h2}>Today's Jobs</h2>
      {todayBookings.length === 0 ? (
        <p style={empty}>No jobs scheduled for today.</p>
      ) : (
        <div style={tableWrap}>
          <table style={table}>
            <thead>
              <tr>
                {['Time', 'Customer', 'Phone', 'From → To', 'Status', ''].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {todayBookings.map((b) => (
                <tr key={b.id} style={tr}>
                  <td style={td}>{b.scheduledStart ? new Date(b.scheduledStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'}</td>
                  <td style={td}>{b.customer.name}</td>
                  <td style={td}>{b.customer.phone}</td>
                  <td style={td}>{b.originAddress.split(',')[0]} → {b.destAddress.split(',')[0]}</td>
                  <td style={td}><span style={{ ...badge, backgroundColor: statusColor(b.status) }}>{b.status}</span></td>
                  <td style={td}><Link href={`/admin/jobs/${b.id}`} style={{ color: '#FF5A1F', fontSize: '13px' }}>View →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <p style={{ fontSize: '12px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
      <p style={{ fontSize: '28px', fontWeight: '700', color, margin: '0' }}>{value}</p>
    </div>
  )
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    CONFIRMED: '#3B82F6', SCHEDULED: '#6366F1', IN_PROGRESS: '#F59E0B',
    COMPLETED: '#10B981', PENDING_APPROVAL: '#EF4444', ARCHIVED: '#6B7280',
  }
  return map[status] ?? '#9CA3AF'
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '14px', color: '#6B7280', margin: '0 0 28px' }
const quickAction: React.CSSProperties = { padding: '9px 14px', backgroundColor: '#FFFFFF', color: '#374151', border: '1px solid #E5E7EB', borderRadius: '9px', fontSize: '13px', fontWeight: 600, textDecoration: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
const statsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }
const alert: React.CSSProperties = { backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', color: '#374151', marginBottom: '16px' }
const h2: React.CSSProperties = { fontSize: '18px', fontWeight: '600', color: '#0A1628', margin: '28px 0 16px' }
const empty: React.CSSProperties = { color: '#9CA3AF', fontSize: '14px', fontStyle: 'italic' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const badge: React.CSSProperties = { color: '#FFFFFF', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em' }
