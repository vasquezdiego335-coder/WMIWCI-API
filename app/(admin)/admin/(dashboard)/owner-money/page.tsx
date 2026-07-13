import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { fmtCents, crewPayOwedCents, safeToDistributeCents } from '@/lib/profit'
import { rollupOwner, estimateBusinessCash } from '@/lib/owner-ledger'
import { PageHeader, StatCard, StatGrid, Card, COLORS, Empty, MoneyRow, tableStyles as T, Badge } from '../_ui'
import { OWNER_TX_TYPE_LABELS, OWNER_LABELS, PAYMENT_METHOD_LABELS, APPROVAL_STATUS_COLORS } from '../_labels'
import OwnerMoneyForm from './OwnerMoneyForm'
import OwnerMoneyActions from './OwnerMoneyActions'
import BusinessConfigPanel from './BusinessConfigPanel'

export const dynamic = 'force-dynamic'

const dateOnly = (d: Date) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })

export default async function OwnerMoneyPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  // Owner money is owner-only (personal cash is not manager business). Managers
  // reaching this URL get a clear, non-leaky message instead of the ledger.
  if (!isOwner) {
    return (
      <div>
        <PageHeader title="Owner Money" subtitle="Diego & Sebastian personal money." />
        <Card>
          <Empty>This page is limited to owners. Ask Diego or Sebastian if you need something here.</Empty>
        </Card>
      </div>
    )
  }

  const [transactions, revenueAgg, expenseAgg, config, liveJobs] = await Promise.all([
    prisma.ownerTransaction.findMany({ orderBy: { occurredOn: 'desc' }, take: 200 }),
    prisma.payment.aggregate({ where: { status: 'COMPLETED', isInternalTest: false }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { status: { not: 'REJECTED' } }, _sum: { amount: true } }),
    prisma.businessConfig.findUnique({ where: { id: 'singleton' } }),
    prisma.booking.findMany({
      where: { status: { in: ['IN_PROGRESS', 'COMPLETED'] }, isInternalTest: false },
      select: { job: { select: { crew: { select: { actualHours: true, scheduledHours: true, payRate: true, flatPay: true, tips: true, bonus: true, deductions: true, payStatus: true, user: { select: { payRate: true } } } } } } },
      take: 500,
    }),
  ])

  const cfg = { diego: config?.diegoSplitPercent ?? 50, sebastian: config?.sebastianSplitPercent ?? 50, taxPct: config?.taxReservePercent ?? 25, emergencyCents: config?.emergencyReserveCents ?? 0 }

  // Per-owner rollup + cash estimate — pure math in src/lib/owner-ledger.ts
  // (unit-tested: contributions are never revenue, withdrawals never expenses,
  // rejected transactions never count, personal purchases don't touch cash).
  const diego = rollupOwner(transactions, 'DIEGO')
  const sebastian = rollupOwner(transactions, 'SEBASTIAN')

  const revenue = revenueAgg._sum.amount ?? 0
  const expenses = expenseAgg._sum.amount ?? 0
  const cashEstimate = estimateBusinessCash({ revenueCents: revenue, expenseCents: expenses, ownerTxs: transactions })

  const unpaidCrew = liveJobs.reduce((s, b) => s + (b.job?.crew ?? [])
    .filter((c) => c.payStatus !== 'PAID')
    .reduce((cs, c) => cs + crewPayOwedCents({ actualHours: c.actualHours, scheduledHours: c.scheduledHours, payRate: c.payRate, userPayRate: c.user?.payRate, flatPay: c.flatPay, tips: c.tips, bonus: c.bonus, deductions: c.deductions }), 0), 0)
  const taxReserve = Math.max(0, Math.round((revenue - expenses) * (cfg.taxPct / 100)))
  const safe = safeToDistributeCents({ cashAvailableCents: cashEstimate, upcomingWorkerPayCents: unpaidCrew, upcomingBillsCents: 0, taxReserveCents: taxReserve, emergencyReserveCents: cfg.emergencyCents })

  return (
    <div>
      <PageHeader title="Owner Money" subtitle="Diego & Sebastian personal money — contributions, withdrawals, reimbursements, and distributions. Kept separate from business expenses on purpose." />

      <OwnerMoneyForm />

      {/* Per-owner rollup */}
      <div style={{ ...T.wrap, marginBottom: '24px' }}>
        <div style={T.scroll}>
          <table style={T.table}>
            <thead>
              <tr>{['Owner', 'Contributed', 'Withdrawn', 'Reimbursement owed'].map((h) => <th key={h} style={T.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {[['DIEGO', diego], ['SEBASTIAN', sebastian]].map(([name, r]) => {
                const roll = r as { contributed: number; withdrawn: number; reimbursementOwed: number }
                return (
                  <tr key={name as string}>
                    <td style={{ ...T.td, fontWeight: 700 }}>{OWNER_LABELS[name as string]}</td>
                    <td style={{ ...T.td, color: COLORS.green, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCents(roll.contributed)}</td>
                    <td style={{ ...T.td, fontVariantNumeric: 'tabular-nums' }}>{fmtCents(roll.withdrawn)}</td>
                    <td style={{ ...T.td, color: roll.reimbursementOwed > 0 ? COLORS.amber : COLORS.faint, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCents(roll.reimbursementOwed)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Distributable cash */}
      <Card title="Available for Distribution" icon="🏦" wide action={<BusinessConfigPanel diego={cfg.diego} sebastian={cfg.sebastian} taxPct={cfg.taxPct} emergencyCents={cfg.emergencyCents} canEdit={!!isOwner} />}>
        <p style={{ fontSize: '12px', color: COLORS.faint, margin: '0 0 12px' }}>
          Not all business cash is splittable. Obligations + reserves come out first. Cash is estimated from the recorded ledger — set the emergency reserve to reconcile with your real bank balance.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px', maxWidth: '640px' }}>
          <MoneyRow label="Estimated business cash" value={fmtCents(cashEstimate)} />
          <MoneyRow label="− Unpaid worker pay" value={fmtCents(unpaidCrew)} negative />
          <MoneyRow label={`− Tax reserve (${cfg.taxPct}%)`} value={fmtCents(taxReserve)} negative />
          <MoneyRow label="− Emergency reserve" value={fmtCents(cfg.emergencyCents)} negative />
        </div>
        <div style={{ borderTop: '1px solid #F1F1F1', margin: '10px 0', maxWidth: '640px' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: '640px' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy }}>Safe to distribute</span>
          <span style={{ fontSize: '22px', fontWeight: 800, color: safe > 0 ? COLORS.gold : COLORS.muted, fontVariantNumeric: 'tabular-nums' }}>{fmtCents(safe)}</span>
        </div>
        {safe > 0 && (
          <div style={{ fontSize: '12px', color: COLORS.faint, textAlign: 'right', maxWidth: '640px', marginTop: '4px' }}>
            Diego {fmtCents(Math.round(safe * cfg.diego / 100))} · Sebastian {fmtCents(Math.round(safe * cfg.sebastian / 100))}
          </div>
        )}
      </Card>

      {/* Ledger */}
      <div style={{ marginTop: '24px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, color: COLORS.navy, margin: '0 0 12px' }}>Transactions</h2>
        {transactions.length === 0 ? (
          <div style={{ ...T.wrap, padding: '28px' }}><Empty>No owner transactions yet. Add the first contribution or purchase above.</Empty></div>
        ) : (
          <div style={T.wrap}>
            <div style={T.scroll}>
              <table style={T.table}>
                <thead>
                  <tr>{['Date', 'Owner', 'Type', 'Amount', 'Method', 'Explanation', 'Receipt', 'Status', ''].map((h) => <th key={h} style={T.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id}>
                      <td style={T.td}>{dateOnly(t.occurredOn)}</td>
                      <td style={{ ...T.td, fontWeight: 600 }}>{OWNER_LABELS[t.owner]}</td>
                      <td style={T.td}>{OWNER_TX_TYPE_LABELS[t.type] ?? t.type}</td>
                      <td style={{ ...T.td, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCents(t.amount)}</td>
                      <td style={T.td}>{t.paymentMethod ? PAYMENT_METHOD_LABELS[t.paymentMethod] : '—'}</td>
                      <td style={T.td}>{t.explanation ?? '—'}</td>
                      <td style={T.td}>{t.receiptUrl ? <a href={t.receiptUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.orange }}>🧾</a> : '—'}</td>
                      <td style={T.td}><Badge color={APPROVAL_STATUS_COLORS[t.approvalStatus] ?? COLORS.muted}>{t.approvalStatus}</Badge></td>
                      <td style={T.td}><OwnerMoneyActions id={t.id} approvalStatus={t.approvalStatus} canDelete={!!isOwner} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
