import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { fmtCents, crewPayOwedCents, distributablePosition, taxReserveCentsFor } from '@/lib/profit'
import { rollupOwner, estimateBusinessCash, totalReimbursementOwed, operatingProfitCents } from '@/lib/owner-ledger'
import { summarizeRevenue, ELIGIBLE_EXPENSE_WHERE, CAPTURED_PAYMENT_WHERE, isPaidCrew } from '@/lib/money-rules'
import { PageHeader, Card, COLORS, Empty, MoneyRow, tableStyles as T, Badge, Callout } from '../_ui'
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

  const [transactions, revenueRows, expenseAgg, config, liveJobs] = await Promise.all([
    prisma.ownerTransaction.findMany({ orderBy: { occurredOn: 'desc' }, take: 200 }),
    // Net collected revenue, shared derivation (money-rules) — never the gross
    // capture, so refunds and lost chargebacks leave cash exactly once.
    prisma.payment.findMany({
      where: { ...CAPTURED_PAYMENT_WHERE, isInternalTest: false },
      select: { amount: true, status: true, isInternalTest: true, refundedAmountCents: true, stripeDisputeId: true, disputeStatus: true },
    }),
    prisma.expense.aggregate({ where: ELIGIBLE_EXPENSE_WHERE, _sum: { amount: true } }),
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

  const revenue = summarizeRevenue(revenueRows)
  const expenses = expenseAgg._sum?.amount ?? 0

  // ── Labor: PAID leaves cash, UNPAID is held back. A crew row is one or the
  //    other, never both, so no amount can be subtracted twice. Before Phase 0
  //    paid labor left the business without ever leaving this calculation —
  //    marking a worker PAID moved their pay out of the held-back reserve and
  //    into nothing, which RAISED "safe to distribute" by that amount.
  const allCrew = liveJobs.flatMap((b) => b.job?.crew ?? [])
  const payOf = (c: (typeof allCrew)[number]) => crewPayOwedCents({ actualHours: c.actualHours, scheduledHours: c.scheduledHours, payRate: c.payRate, userPayRate: c.user?.payRate, flatPay: c.flatPay, tips: c.tips, bonus: c.bonus, deductions: c.deductions })
  const paidLabor = allCrew.filter(isPaidCrew).reduce((s, c) => s + payOf(c), 0)
  const unpaidCrew = allCrew.filter((c) => !isPaidCrew(c)).reduce((s, c) => s + payOf(c), 0)
  const laborRecorded = allCrew.length > 0

  const cashEstimate = estimateBusinessCash({
    netRevenueCents: revenue.netCollectedCents,
    expenseCents: expenses,
    paidLaborCents: paidLabor,
    ownerTxs: transactions,
  })

  // Reimbursements the business owes its owners must clear before profit is
  // split — otherwise an owner is "distributed" money that is already theirs.
  const reimbursementsOwed = totalReimbursementOwed(transactions, ['DIEGO', 'SEBASTIAN'])

  // Tax reserve on OPERATING PROFIT (revenue − expenses − labor), not on
  // revenue-minus-expenses with labor ignored, which overstated the hold-back.
  const opProfit = operatingProfitCents({ netRevenueCents: revenue.netCollectedCents, expenseCents: expenses, laborCents: paidLabor + unpaidCrew })
  const taxReserve = taxReserveCentsFor(opProfit, cfg.taxPct)

  const position = distributablePosition({
    cashAvailableCents: cashEstimate,
    unpaidLaborCents: unpaidCrew,
    upcomingBillsCents: 0,
    ownerReimbursementsOwedCents: reimbursementsOwed,
    pendingRefundCents: revenue.pendingDisputeCents,
    taxReserveCents: taxReserve,
    emergencyReserveCents: cfg.emergencyCents,
  })
  const safe = position.distributableCents

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
      <Card title="Estimated Safe to Distribute" icon="🏦" wide action={<BusinessConfigPanel diego={cfg.diego} sebastian={cfg.sebastian} taxPct={cfg.taxPct} emergencyCents={cfg.emergencyCents} canEdit={!!isOwner} />}>
        {!laborRecorded && (
          <Callout tone="warning" title="No crew labor is recorded anywhere in the system.">
            Labor is a real cost that has not been entered on any move, so estimated business cash
            and the figure below are <strong>overstated</strong>. This is an estimate for planning,
            not a finalized distributable profit.
          </Callout>
        )}
        <p style={{ fontSize: '12px', color: COLORS.faint, margin: '0 0 12px' }}>
          An <strong>estimate</strong> from the recorded ledger — not a bank balance and not finalized
          distributable profit. Cash = owner contributions + net collected revenue − eligible expenses
          − labor already paid − owner withdrawals, distributions and reimbursements. Everything below
          the line is money already spoken for. Set the emergency reserve to reconcile with your real
          bank balance.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px', maxWidth: '640px' }}>
          <MoneyRow label="Estimated business cash" value={fmtCents(cashEstimate)} />
          <MoneyRow label="− Unpaid worker pay (accrued)" value={fmtCents(unpaidCrew)} negative />
          <MoneyRow label="− Owner reimbursements owed" value={fmtCents(reimbursementsOwed)} negative />
          <MoneyRow label="− Disputed money at risk" value={fmtCents(revenue.pendingDisputeCents)} negative />
          <MoneyRow label={`− Tax reserve (${cfg.taxPct}% of operating profit)`} value={fmtCents(taxReserve)} negative />
          <MoneyRow label="− Emergency reserve" value={fmtCents(cfg.emergencyCents)} negative />
        </div>
        <div style={{ borderTop: '1px solid #F1F1F1', margin: '10px 0', maxWidth: '640px' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: '640px' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy }}>
            {position.shortfallCents > 0 ? 'Shortfall — do not distribute' : 'Estimated safe to distribute'}
          </span>
          <span style={{ fontSize: '22px', fontWeight: 800, color: position.shortfallCents > 0 ? COLORS.red : safe > 0 ? COLORS.gold : COLORS.muted, fontVariantNumeric: 'tabular-nums' }}>
            {fmtCents(position.rawCents)}
          </span>
        </div>
        {position.shortfallCents > 0 && (
          <div style={{ fontSize: '12px', color: COLORS.red, textAlign: 'right', maxWidth: '640px', marginTop: '4px' }}>
            Obligations exceed estimated cash by {fmtCents(position.shortfallCents)}. Nothing is available to split.
          </div>
        )}
        {safe > 0 && (
          <div style={{ fontSize: '12px', color: COLORS.faint, textAlign: 'right', maxWidth: '640px', marginTop: '4px' }}>
            At the current split — Diego {fmtCents(Math.round(safe * cfg.diego / 100))} · Sebastian {fmtCents(Math.round(safe * cfg.sebastian / 100))}
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
