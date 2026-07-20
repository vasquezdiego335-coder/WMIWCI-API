'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

// ════════════════════════════════════════════════════════════════════════════
//  Financial Closeout (Phase 2, owner spec 2026-07-20).
//
//  Turns a completed move into a durable financial record. Mobile-first for the
//  same reason as Crew & Labor: tolls, fuel and receipts get closed out from a
//  phone on the way home, not at a desk.
//
//  The page's job is to make MISSING INFORMATION obvious. A number that cannot
//  be trusted is never presented as if it can.
// ════════════════════════════════════════════════════════════════════════════

export type CloseoutData = {
  status: string
  isFinalized: boolean
  canFinalize: boolean
  financials: {
    netBilledRevenueCents: number
    netCollectedRevenueCents: number
    outstandingBalanceCents: number
    refundedCents: number
    chargebackCents: number
    disputedOpenCents: number
    directJobCostCents: number
    crewLaborCents: number
    ownerEconomicLaborCents: number
    processingFeeCents: number
    directExpenseCents: number
    profit: {
      cashGrossProfitCents: number
      economicProfitCents: number
      companyNetProfitCents: number
      economicNetProfitCents: number
      marginBp: number | null
    }
    overhead: { amountCents: number; method: string; basis: string }
    reserves: {
      taxReserveCents: number
      businessReserveCents: number
      retainedEarningsCents: number
      unresolvedLiabilityCents: number
      distributableProfitCents: number
      overAllocated: boolean
    }
  }
  blockers: { code: string; message: string; severity: string; section: string }[]
  overrides: { code: string; reason: string; byName?: string; at?: string }[]
  split: { ok: boolean; error?: string; method: string; shares: { owner: string; amountCents: number; percentBp: number }[]; undistributedCents: number } | null
  unpaidLaborCents: number
  ownerReimbursementOwedCents: number
  snapshots: { id: string; version: number; createdAt: string; supersededAt: string | null; companyNetProfitCents: number; distributableProfitCents: number }[]
  distributions: { id: string; owner: string; status: string; approvedCents: number; paidCents: number; voided: boolean }[]
}

const money = (c: number | null | undefined) => {
  const n = Math.round(c ?? 0) / 100
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

const STATUS_COLOR: Record<string, string> = {
  NOT_STARTED: '#9CA3AF', IN_PROGRESS: '#3B82F6', MISSING_INFORMATION: '#F59E0B',
  READY_FOR_REVIEW: '#6366F1', READY_TO_FINALIZE: '#10B981', FINALIZED: '#0A1628', REOPENED: '#F97316',
}

export default function FinancialCloseoutPanel({
  bookingId, data, isOwner,
}: { bookingId: string; data: CloseoutData; isOwner: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const f = data.financials
  const hard = data.blockers.filter((b) => b.severity === 'HARD')
  const overriddenCodes = new Set(data.overrides.map((o) => o.code))
  const unresolved = data.blockers.filter((b) => b.severity === 'OVERRIDABLE' && !overriddenCodes.has(b.code))

  async function act(body: Record<string, unknown>, label: string) {
    setBusy(label); setError(null)
    try {
      const res = await fetch(`/api/admin/closeout/${bookingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error ?? 'Something went wrong.'); return false }
      router.refresh()
      return true
    } catch {
      setError('Network error — nothing was saved.')
      return false
    } finally { setBusy(null) }
  }

  const needReason = (fn: () => void) => {
    if (!reason.trim()) { setError('Enter a reason first — it is recorded in the audit log.'); return }
    fn()
  }

  return (
    <div>
      {/* ── 1. Status + blockers ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <span style={{ ...chip, backgroundColor: STATUS_COLOR[data.status] ?? '#9CA3AF', color: '#fff' }}>
          {data.status.replace(/_/g, ' ')}
        </span>
        {data.isFinalized && data.snapshots[0] && (
          <span style={{ fontSize: '12px', color: '#6B7280' }}>
            snapshot v{data.snapshots[0].version} · {new Date(data.snapshots[0].createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        )}
      </div>

      {error && <div style={box('#FEF2F2', '#FECACA', '#B91C1C')} role="alert">{error}</div>}

      {data.isFinalized && (
        <div style={box('#ECFDF5', '#A7F3D0', '#065F46')}>
          <strong>This move is financially finalized.</strong> The numbers below are live; the
          snapshot is the historical record and does not change when settings change. Reopen with a
          reason to make corrections.
        </div>
      )}

      {hard.length > 0 && (
        <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}>
          <strong>Cannot be finalized — these must be fixed:</strong>
          <ul style={ul}>{hard.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
        </div>
      )}
      {unresolved.length > 0 && (
        <div style={box('#FFFBEB', '#FDE68A', '#B45309')}>
          <strong>Needs resolving or an owner override:</strong>
          <ul style={ul}>
            {unresolved.map((b) => (
              <li key={b.code} style={{ marginBottom: '6px' }}>
                {b.message}
                {isOwner && !data.isFinalized && (
                  <button style={miniBtn} disabled={!!busy}
                    onClick={() => needReason(() => act({ action: 'OVERRIDE', blockerCode: b.code, reason }, b.code))}>
                    override
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.overrides.length > 0 && (
        <div style={box('#EFF6FF', '#BFDBFE', '#1D4ED8')}>
          <strong>Overridden by an owner:</strong>
          <ul style={ul}>
            {data.overrides.map((o) => <li key={o.code}>{o.code} — “{o.reason}”{o.byName ? ` (${o.byName})` : ''}</li>)}
          </ul>
        </div>
      )}

      {/* ── 2-4. Revenue reconciliation ── */}
      <Section title="Revenue">
        <Line label="Net billed revenue" value={money(f.netBilledRevenueCents)} hint="what the customer owes" />
        <Line label="Net collected revenue" value={money(f.netCollectedRevenueCents)} strong hint="cash actually received" />
        {f.refundedCents > 0 && <Line label="Refunded" value={`−${money(f.refundedCents)}`} tone="#EF4444" />}
        {f.chargebackCents > 0 && <Line label="Chargebacks (lost)" value={`−${money(f.chargebackCents)}`} tone="#EF4444" />}
        {f.disputedOpenCents > 0 && <Line label="Disputed and at risk" value={money(f.disputedOpenCents)} tone="#B45309" />}
        <Line
          label="Outstanding balance"
          value={money(f.outstandingBalanceCents)}
          tone={f.outstandingBalanceCents > 0 ? '#B45309' : '#10B981'}
          hint={f.outstandingBalanceCents > 0 ? 'NOT counted as profit or cash' : 'fully collected'}
        />
      </Section>

      {/* ── 5-8. Costs ── */}
      <Section title="Direct job costs">
        <Line label="Crew labor (approved)" value={money(f.crewLaborCents)} />
        <Line label="Job expenses" value={money(f.directExpenseCents)} />
        <Line label="Processing fees (est.)" value={money(f.processingFeeCents)} />
        <Line label="Total direct job cost" value={money(f.directJobCostCents)} strong />
        {data.unpaidLaborCents > 0 && (
          <Line label="…of which still owed to crew" value={money(data.unpaidLaborCents)} tone="#B45309" hint="held back from distribution" />
        )}
      </Section>

      {/* ── 11-14. Profit ── */}
      <Section title="Profit">
        <Line label="Cash gross profit" value={money(f.profit.cashGrossProfitCents)} strong tone={f.profit.cashGrossProfitCents < 0 ? '#EF4444' : undefined} />
        {f.ownerEconomicLaborCents > 0 && (
          <>
            <Line label="− Unpaid owner labor (value)" value={money(f.ownerEconomicLaborCents)} />
            <Line label="Economic profit" value={money(f.profit.economicProfitCents)} tone={f.profit.economicProfitCents < 0 ? '#EF4444' : '#6366F1'} hint="if owner hours had to be hired" />
          </>
        )}
        <Line label={`− Allocated overhead (${f.overhead.basis})`} value={money(f.overhead.amountCents)} />
        <Line label="Company net profit" value={money(f.profit.companyNetProfitCents)} strong tone={f.profit.companyNetProfitCents < 0 ? '#EF4444' : '#C9A961'} />
        {f.ownerEconomicLaborCents > 0 && (
          <Line label="Economic net profit" value={money(f.profit.economicNetProfitCents)} tone={f.profit.economicNetProfitCents < 0 ? '#EF4444' : '#6366F1'} />
        )}
        {f.profit.marginBp != null && (
          <Line label="Margin" value={`${(f.profit.marginBp / 100).toFixed(1)}%`} tone={f.profit.marginBp < 0 ? '#EF4444' : undefined} />
        )}
        {f.profit.companyNetProfitCents < 0 && (
          <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}>
            <strong>This move lost money.</strong> Nothing can be distributed. The biggest cost was{' '}
            {f.crewLaborCents >= f.directExpenseCents ? 'crew labor' : 'job expenses'}.
          </div>
        )}
      </Section>

      {/* ── 13-15. Reserves + distributable ── */}
      <Section title="Reserves and what may be distributed">
        <Line label="Tax reserve" value={`−${money(f.reserves.taxReserveCents)}`} hint="internal estimate, not tax advice" />
        <Line label="Business reserves" value={`−${money(f.reserves.businessReserveCents)}`} />
        <Line label="Retained earnings" value={`−${money(f.reserves.retainedEarningsCents)}`} />
        <Line label="Unresolved liabilities" value={`−${money(f.reserves.unresolvedLiabilityCents)}`} hint="unpaid crew + owner reimbursements" />
        <Line label="Distributable profit" value={money(f.reserves.distributableProfitCents)} strong tone="#C9A961" />
        {f.reserves.overAllocated && (
          <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}>Reserves exceed the profit on this move.</div>
        )}
        <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '6px 0 0' }}>
          Reserves are <strong>planned allocations</strong>, not confirmed bank transfers.
        </p>
      </Section>

      {/* ── 15. Owner split ── */}
      {data.split && (
        <Section title={`Owner split · ${data.split.method.replace(/_/g, ' ').toLowerCase()}`}>
          {!data.split.ok && <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}>{data.split.error}</div>}
          {data.split.shares.map((s) => (
            <Line key={s.owner} label={s.owner === 'DIEGO' ? 'Diego' : 'Sebastian'} value={money(s.amountCents)} hint={`${(s.percentBp / 100).toFixed(1)}%`} />
          ))}
          {data.split.undistributedCents > 0 && <Line label="Undistributed" value={money(data.split.undistributedCents)} tone="#6B7280" />}
          <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '6px 0 0' }}>
            A calculation only — no money moves until a distribution is approved and recorded.
          </p>
        </Section>
      )}

      {/* ── 16. Finalize / reopen ── */}
      {isOwner && (
        <Section title={data.isFinalized ? 'Reopen' : 'Finalize'}>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required for overrides, write-offs and reopening)"
            style={input}
          />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
            {!data.isFinalized && (
              <>
                <Btn primary busy={busy === 'finalize'} disabled={!data.canFinalize}
                  onClick={() => act({ action: 'FINALIZE' }, 'finalize')}>
                  {data.canFinalize ? '🔒 Finalize this move' : 'Finalize (blocked)'}
                </Btn>
                {f.outstandingBalanceCents > 0 && (
                  <Btn busy={busy === 'writeoff'}
                    onClick={() => needReason(() => act({ action: 'WRITE_OFF_BALANCE', reason }, 'writeoff'))}>
                    Write off {money(f.outstandingBalanceCents)}
                  </Btn>
                )}
                {f.disputedOpenCents > 0 && (
                  <Btn busy={busy === 'ack'} onClick={() => act({ action: 'ACK_DISPUTE' }, 'ack')}>Acknowledge dispute</Btn>
                )}
              </>
            )}
            {data.isFinalized && (
              <Btn danger busy={busy === 'reopen'}
                onClick={() => needReason(() => act({ action: 'REOPEN', reason }, 'reopen'))}>
                Reopen this move
              </Btn>
            )}
          </div>
        </Section>
      )}

      {/* Truck source — a confirmation, because absence is not zero */}
      {isOwner && !data.isFinalized && data.blockers.some((b) => b.code === 'TRUCK_SOURCE_MISSING') && (
        <Section title="Truck source">
          <p style={{ fontSize: '12px', color: '#6B7280', margin: '0 0 8px' }}>
            A missing truck cost is not $0 until someone confirms it.
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {['CUSTOMER_PROVIDED', 'RENTAL', 'COMPANY_OWNED', 'THIRD_PARTY', 'NOT_REQUIRED'].map((t) => (
              <Btn key={t} busy={busy === t} onClick={() => act({ action: 'CONFIRM_TRUCK', truckSource: t }, t)}>
                {t.replace(/_/g, ' ').toLowerCase()}
              </Btn>
            ))}
          </div>
        </Section>
      )}

      {/* ── 17. Snapshot history ── */}
      {data.snapshots.length > 0 && (
        <Section title="Snapshot history">
          {data.snapshots.map((s) => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '5px 0', color: s.supersededAt ? '#9CA3AF' : '#374151' }}>
              <span>v{s.version} · {new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{s.supersededAt ? ' · superseded' : ' · current'}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>net {money(s.companyNetProfitCents)} · dist {money(s.distributableProfitCents)}</span>
            </div>
          ))}
        </Section>
      )}

      {data.distributions.filter((x) => !x.voided).length > 0 && (
        <Section title="Owner distributions">
          {data.distributions.filter((x) => !x.voided).map((x) => (
            <Line key={x.id} label={`${x.owner === 'DIEGO' ? 'Diego' : 'Sebastian'} · ${x.status.replace(/_/g, ' ').toLowerCase()}`}
              value={`${money(x.paidCents)} / ${money(x.approvedCents)}`} />
          ))}
        </Section>
      )}
    </div>
  )
}

// ── Presentational ──────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '16px', paddingBottom: '14px', borderBottom: '1px solid #F3F4F6' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>{title}</div>
      {children}
    </div>
  )
}
function Line({ label, value, strong, tone, hint }: { label: string; value: string; strong?: boolean; tone?: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0', alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '13px', color: '#6B7280', flex: '1 1 140px', minWidth: 0 }}>
        {label}{hint && <span style={{ fontSize: '11px', color: '#9CA3AF' }}> · {hint}</span>}
      </span>
      <span style={{ fontSize: strong ? '16px' : '13px', fontWeight: strong ? 800 : 600, color: tone ?? '#0A1628', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}
function Btn({ children, onClick, primary, danger, busy, disabled }: { children: React.ReactNode; onClick?: () => void; primary?: boolean; danger?: boolean; busy?: boolean; disabled?: boolean }) {
  const off = busy || disabled
  return (
    <button onClick={onClick} disabled={off} style={{
      minHeight: '44px', padding: '10px 16px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
      cursor: off ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
      border: primary ? 'none' : `1px solid ${danger ? '#FECACA' : '#D1D5DB'}`,
      backgroundColor: primary ? (disabled ? '#D1D5DB' : '#FF5A1F') : danger ? '#FEF2F2' : '#FFFFFF',
      color: primary ? '#FFFFFF' : danger ? '#B91C1C' : '#374151',
      opacity: busy ? 0.6 : 1,
    }}>{busy ? '…' : children}</button>
  )
}
const box = (bg: string, border: string, color: string): React.CSSProperties => ({
  backgroundColor: bg, border: `1px solid ${border}`, borderLeft: `4px solid ${color}`, color,
  borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px', lineHeight: 1.5,
})
const ul: React.CSSProperties = { margin: '6px 0 0', paddingLeft: '18px' }
const chip: React.CSSProperties = { fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '100px', letterSpacing: '0.03em' }
const input: React.CSSProperties = { minHeight: '44px', padding: '10px 12px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '16px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
const miniBtn: React.CSSProperties = { marginLeft: '8px', background: 'none', border: '1px solid currentColor', borderRadius: '6px', color: 'inherit', fontSize: '11px', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }
