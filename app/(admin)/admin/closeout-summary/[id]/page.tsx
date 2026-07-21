import { redirect, notFound } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { buildCloseoutView } from '@/lib/closeout-service'
import { bpToPercentLabel } from '@/lib/profit-allocation'

// ════════════════════════════════════════════════════════════════════════════
//  Printable closeout summary for ONE move (Stage 4).
//
//  Deliberately OUTSIDE the dashboard layout: no sidebar, no chrome, one page
//  that prints cleanly to paper or to PDF from the browser.
//
//  It reads the SAME closeout view every other surface reads, so a printed
//  summary can never disagree with the screen — and on a finalized move the
//  numbers come from the frozen snapshot, not from today's settings.
//
//  WHAT IT DOES NOT CONTAIN: receipt links, payment credentials, provider
//  identifiers or access codes. A printout leaves the building.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Closeout summary', robots: 'noindex, nofollow' }

const money = (c: number | null | undefined) =>
  (Math.round(c ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const day = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—'

export default async function CloseoutSummary({ params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) redirect('/admin/login')
  // Money on paper is owner-financial information; the closeout view itself is
  // gated the same way in its API route.
  if (!can(session.role as Role, 'money.view_company_profit')) redirect('/admin')

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    select: {
      id: true, bookingReference: true, completedAt: true, scheduledStart: true,
      originCity: true, destCity: true, isInternalTest: true,
      customer: { select: { name: true } },
    },
  })
  if (!booking) notFound()

  const view = await buildCloseoutView(params.id)
  if (!view) notFound()

  const f = view.financials
  const a = view.allocation
  const finalized = view.allocationBasis === 'FINALIZED'

  return (
    <div style={page}>
      <style>{'@media print { .no-print { display: none } body { background: #fff } }'}</style>

      <header style={{ borderBottom: '2px solid #0A1628', paddingBottom: '12px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#0A1628' }}>Move It Clear It</div>
            <div style={{ fontSize: '13px', color: '#6B7280' }}>Financial closeout summary</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: '12px', color: '#6B7280' }}>
            <div><strong>{booking.bookingReference ?? booking.id.slice(0, 8)}</strong></div>
            <div>{booking.customer.name}</div>
            <div>{day(booking.completedAt ?? booking.scheduledStart)}</div>
            <div>{[booking.originCity, booking.destCity].filter(Boolean).join(' → ') || '—'}</div>
          </div>
        </div>
        <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ ...badge, backgroundColor: finalized ? '#ECFDF5' : '#FFFBEB', color: finalized ? '#065F46' : '#B45309' }}>
            {finalized ? `FINALIZED · SNAPSHOT V${view.allocationSnapshotVersion}` : 'PROVISIONAL — NOT YET FINALIZED'}
          </span>
          {booking.isInternalTest && (
            <span style={{ ...badge, backgroundColor: '#EFF6FF', color: '#1D4ED8' }}>
              INTERNAL TEST — EXCLUDED FROM COMPANY REPORTING
            </span>
          )}
        </div>
      </header>

      <Block title="Revenue">
        <Row label="Net billed revenue" value={money(f.netBilledRevenueCents)} />
        <Row label="Net collected revenue" value={money(f.netCollectedRevenueCents)} strong />
        <Row label="Outstanding receivable" value={money(f.outstandingBalanceCents)} note="a receivable, never profit" />
      </Block>

      <Block title="Costs">
        <Row label="Crew labor (approved)" value={money(f.crewLaborCents)} />
        <Row label="Job expenses" value={money(f.directExpenseCents)} />
        <Row label="Processing fees (estimated)" value={money(f.processingFeeCents)} />
        <Row label="Owner reimbursements owed" value={money(view.ownerReimbursementOwedCents)} />
        <Row label={`Allocated overhead (${f.overhead.basis})`} value={money(f.overhead.amountCents)} />
        <Row label="Total direct job cost" value={money(f.directJobCostCents)} strong />
      </Block>

      <Block title="Profit">
        <Row label="Cash gross profit" value={money(f.profit.cashGrossProfitCents)} />
        {f.ownerEconomicLaborCents > 0 && (
          <Row label="Unpaid owner labor (value)" value={money(f.ownerEconomicLaborCents)} note="never cash" />
        )}
        <Row label="Final company net profit" value={money(f.profit.companyNetProfitCents)} strong />
      </Block>

      <Block title={`Profit allocation${finalized ? '' : ' (provisional)'}`}>
        <Row label="Final company net profit" value={money(a.companyNetProfitCents)} strong />
        {a.lines.map((ln) => (
          <Row key={ln.label} label={`${ln.label} — ${bpToPercentLabel(ln.ofNetProfitBp)}`} value={money(ln.amountCents)} />
        ))}
        {a.roundingRemainderCents > 0 && (
          <Row label="…of which rounding remainder retained by the business" value={money(a.roundingRemainderCents)} />
        )}
        {!a.hasDistribution && (
          <p style={note}>
            {a.companyNetProfitCents < 0
              ? 'This move lost money. Nothing is allocated to the business or to either owner; the loss stands.'
              : 'There is no profit to allocate on this move.'}
          </p>
        )}
        <p style={note}>{a.explanation}</p>
        <p style={note}>
          The retained share is a general company allocation — it may fund taxes, equipment, insurance,
          licensing or growth. This is an internal management summary, not tax advice and not an audited
          financial statement.
        </p>
      </Block>

      {view.snapshots.length > 0 && (
        <Block title="Snapshot history">
          {view.snapshots.map((s) => (
            <div key={s.id} style={{ fontSize: '12px', padding: '4px 0', borderBottom: '1px solid #F3F4F6' }}>
              <strong>v{s.version}</strong> · {day(s.createdAt)}
              {s.createdByName ? ` · ${s.createdByName}` : ''} · {s.supersededAt ? 'superseded' : 'current'} ·
              net {money(s.companyNetProfitCents)} · {s.allocation.lines.map((ln) => `${ln.label} ${money(ln.amountCents)}`).join(' · ')} ·
              calc {s.calculationVersion}
            </div>
          ))}
        </Block>
      )}

      <footer style={{ marginTop: '24px', fontSize: '11px', color: '#9CA3AF' }}>
        Generated {day(new Date())} for {session.name}.
        {finalized
          ? ' Figures come from the finalized snapshot and do not change when settings change.'
          : ' Figures are provisional and may change when this move is financially finalized.'}
      </footer>

      <div className="no-print" style={{ marginTop: '20px' }}>
        <a href={`/admin/jobs/${booking.id}`} style={{ fontSize: '13px', color: '#FF5A1F' }}>← Back to the move</a>
      </div>
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '18px', breakInside: 'avoid' }}>
      <h2 style={{ fontSize: '12px', fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value, strong, note: hint }: { label: string; value: string; strong?: boolean; note?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '3px 0', alignItems: 'baseline' }}>
      <span style={{ fontSize: '13px', color: '#374151' }}>
        {label}{hint && <span style={{ fontSize: '11px', color: '#9CA3AF' }}> · {hint}</span>}
      </span>
      <span style={{ fontSize: strong ? '15px' : '13px', fontWeight: strong ? 800 : 600, color: '#0A1628', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

const page: React.CSSProperties = {
  maxWidth: '760px', margin: '0 auto', padding: '32px 24px', backgroundColor: '#FFFFFF',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: '#0A1628',
}
const badge: React.CSSProperties = { fontSize: '10px', fontWeight: 800, padding: '4px 10px', borderRadius: '100px', letterSpacing: '0.04em' }
const note: React.CSSProperties = { fontSize: '11px', color: '#6B7280', margin: '6px 0 0', lineHeight: 1.5 }
