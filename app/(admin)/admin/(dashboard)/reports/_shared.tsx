// Shared building blocks for the reporting pages (Stage 3B, owner spec
// 2026-07-20). Server-safe (no 'use client').
//
// Two rules these components exist to enforce:
//   1. A number is never shown without its BASIS and MODE.
//   2. "$0.00" and "we could not measure this" never look the same.

import Link from 'next/link'
import { COLORS } from '../_ui'

export const money = (cents: number | null | undefined): string => {
  if (cents == null) return '—'
  return (Math.round(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
export const pctText = (bp: number | null | undefined): string =>
  bp == null ? '—' : `${(bp / 100).toFixed(1)}%`

export type ReportMode = 'FINALIZED_ONLY' | 'PROVISIONAL_ONLY' | 'COMBINED'
export type Basis = 'CASH' | 'ACCRUAL'

export const MODE_LABEL: Record<ReportMode, string> = {
  FINALIZED_ONLY: 'Finalized only',
  PROVISIONAL_ONLY: 'Provisional only',
  COMBINED: 'Finalized + provisional',
}

/** Plain-English help for the financial vocabulary. */
export const GLOSSARY: Record<string, string> = {
  Finalized: 'The move completed financial closeout. Its numbers are locked in a snapshot and will not change.',
  Provisional: 'The move has not completed closeout. These numbers are live and may still change.',
  'Cash basis': 'Counts money actually collected and paid.',
  'Accrual basis': 'Counts money billed and owed, whether or not it has been settled.',
  'Cash profit': 'Revenue collected minus the costs actually paid.',
  'Economic profit': 'Cash profit minus the value of unpaid owner labor — what the move earned if the owners had to be hired.',
  'Profit ROAS': 'Finalized company net profit divided by marketing spend. Money made per dollar spent.',
  'Break-even price': 'The lowest price at which a move does not lose money.',
  Outstanding: 'Money the customer still owes. It is a receivable, never profit or cash.',
}

export function PageShell({
  title, subtitle, children, actions,
}: { title: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '12px', color: COLORS.muted, marginBottom: '2px' }}>
            <Link href="/admin/reports" style={{ color: COLORS.orange, textDecoration: 'none' }}>Reports</Link>
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: COLORS.navy, margin: 0 }}>{title}</h1>
          {subtitle && <p style={{ fontSize: '13px', color: COLORS.muted, margin: '4px 0 0' }}>{subtitle}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/**
 * The disclosure strip. Every reporting page renders this ABOVE its numbers so
 * the reader always knows what kind of figures they are looking at.
 */
export function BasisStrip({
  basisLabel, periodLabel, timezone, finalized, provisional, incomplete, warnings,
}: {
  basisLabel: string; periodLabel: string; timezone: string
  finalized: number; provisional: number; incomplete: number; warnings: string[]
}) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{
        display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center',
        backgroundColor: '#FFFFFF', border: '1px solid #EFEFEF', borderRadius: '10px',
        padding: '10px 12px', fontSize: '12px', color: COLORS.ink,
      }}>
        <strong style={{ color: COLORS.navy }}>{periodLabel}</strong>
        <span style={{ color: COLORS.muted }}>{basisLabel}</span>
        <span style={{ color: COLORS.faint }}>· times in {timezone}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Tag color={COLORS.green}>{finalized} finalized</Tag>
          {provisional > 0 && <Tag color={COLORS.amber}>{provisional} provisional</Tag>}
          {incomplete > 0 && <Tag color={COLORS.red}>{incomplete} unusable</Tag>}
        </span>
      </div>
      {warnings.map((w) => (
        <div key={w} role="alert" style={{
          backgroundColor: '#FFFBEB', border: '1px solid #FDE68A', borderLeft: '4px solid #B45309',
          color: '#B45309', borderRadius: '8px', padding: '9px 12px', fontSize: '12px', marginTop: '8px', lineHeight: 1.5,
        }}>⚠️ {w}</div>
      ))}
    </div>
  )
}

export function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      color, backgroundColor: `${color}18`, border: `1px solid ${color}33`,
      fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '100px', whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

/** A KPI card. `unavailable` renders the honest message instead of $0.00. */
export function Metric({
  label, value, note, tone, unavailable, help,
}: { label: string; value: string; note?: string | null; tone?: string; unavailable?: boolean; help?: string }) {
  return (
    <div style={{
      backgroundColor: '#FFFFFF', border: '1px solid #EFEFEF', borderRadius: '12px',
      padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', minWidth: 0,
    }}>
      <p style={{ fontSize: '11px', color: COLORS.muted, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', margin: '0 0 6px' }}
        title={help}>
        {label}{help ? ' ⓘ' : ''}
      </p>
      {unavailable ? (
        <p style={{ fontSize: '13px', color: COLORS.faint, fontStyle: 'italic', margin: 0 }}>No verified data</p>
      ) : (
        <p style={{ fontSize: '22px', fontWeight: 800, color: tone ?? COLORS.navy, margin: 0, fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>{value}</p>
      )}
      {note && <p style={{ fontSize: '11px', color: COLORS.faint, margin: '5px 0 0', lineHeight: 1.4 }}>{note}</p>}
    </div>
  )
}

/** The 40/30/30 profit allocation, as reports render it (Stage 4).
 *
 *  Two things this panel refuses to do: show the internal 50/50 owner split
 *  without saying it divides the remaining 60%, and present a provisional total
 *  as if it were settled. A finalized period reads frozen snapshots; a mixed one
 *  is labelled Provisional and says why. */
export function AllocationPanel({ allocation }: {
  allocation: {
    companyNetProfitCents: number
    hasDistribution: boolean
    lines: { label: string; ofNetProfitBp: number; amountCents: number; isBusiness: boolean }[]
    roundingRemainderCents: number
    explanation: string
    basis?: string
    provisional?: boolean
  } | null | undefined
}) {
  if (!allocation) return null
  const provisional = allocation.provisional ?? allocation.basis !== 'FINALIZED'
  const pctOf = (bp: number) => `${Number.isInteger(bp / 100) ? bp / 100 : (bp / 100).toFixed(1)}%`

  return (
    <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '16px', marginBottom: '18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <h2 style={{ fontSize: '13px', fontWeight: 700, color: COLORS.navy, margin: 0 }}>Profit allocation</h2>
        <Tag color={provisional ? COLORS.amber : COLORS.green}>{provisional ? 'PROVISIONAL' : 'FINALIZED'}</Tag>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', paddingBottom: '6px', borderBottom: '1px solid #F3F4F6' }}>
        <span style={{ fontSize: '13px', color: COLORS.muted }}>Final company net profit</span>
        <span style={{ fontSize: '17px', fontWeight: 800, color: allocation.companyNetProfitCents < 0 ? COLORS.red : COLORS.navy, fontVariantNumeric: 'tabular-nums' }}>
          {money(allocation.companyNetProfitCents)}
        </span>
      </div>

      {allocation.lines.map((ln) => (
        <div key={ln.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0' }}>
          <span style={{ fontSize: '13px', color: COLORS.muted }}>{ln.label} — {pctOf(ln.ofNetProfitBp)}</span>
          <span style={{ fontSize: '14px', fontWeight: 700, color: ln.isBusiness ? COLORS.navy : COLORS.gold, fontVariantNumeric: 'tabular-nums' }}>
            {money(ln.amountCents)}
          </span>
        </div>
      ))}

      {!allocation.hasDistribution && (
        <p style={{ fontSize: '12px', color: COLORS.muted, margin: '6px 0 0' }}>
          {allocation.companyNetProfitCents < 0
            ? 'This period lost money, so nothing is allocated to the business or to either owner. The loss stands.'
            : 'There is no profit to allocate in this period.'}
        </p>
      )}
      {allocation.roundingRemainderCents > 0 && (
        <p style={{ fontSize: '11px', color: COLORS.faint, margin: '4px 0 0' }}>
          Includes {money(allocation.roundingRemainderCents)} of rounding remainder, which stays with the business.
        </p>
      )}
      {provisional && (
        <p style={{ fontSize: '11px', color: COLORS.amber, margin: '6px 0 0' }}>
          Provisional — this period includes moves that have not been financially finalized, so these
          figures can still change.
        </p>
      )}
      <p style={{ fontSize: '11px', color: COLORS.faint, margin: '6px 0 0', lineHeight: 1.5 }}>
        {allocation.explanation} The retained share is a general company allocation — it may fund taxes,
        equipment, insurance, licensing or growth. It is not tax advice.
      </p>
    </div>
  )
}

export function MetricGrid({ children }: { children: React.ReactNode }) {
  // auto-fill + minmax gives stacked cards on a phone and a grid on desktop,
  // with no fixed-width table to scroll sideways.
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '12px', marginBottom: '18px' }}>{children}</div>
}

/** Distinguishes "nothing happened" from "we cannot vouch for anything". */
export function EmptyState({ state, message }: { state: string; message?: string | null }) {
  const isNoVerified = state === 'NO_VERIFIED_DATA'
  const isUnavailable = state === 'UNAVAILABLE'
  return (
    <div style={{
      backgroundColor: isUnavailable ? '#FEF2F2' : '#FFFFFF',
      border: `1px solid ${isUnavailable ? '#FECACA' : '#EFEFEF'}`,
      borderRadius: '12px', padding: '34px 20px', textAlign: 'center',
    }} role={isUnavailable ? 'alert' : undefined}>
      <div style={{ fontSize: '26px', marginBottom: '8px' }} aria-hidden>
        {isUnavailable ? '⚠️' : isNoVerified ? '🔒' : '📭'}
      </div>
      <p style={{ fontSize: '14px', fontWeight: 600, color: isUnavailable ? '#B91C1C' : COLORS.navy, margin: '0 0 4px' }}>
        {isUnavailable ? 'Reporting is unavailable' : isNoVerified ? 'No verified data available' : 'Nothing in this period'}
      </p>
      <p style={{ fontSize: '13px', color: COLORS.muted, margin: 0, maxWidth: '460px', marginInline: 'auto', lineHeight: 1.5 }}>
        {message ?? 'Try a different date range.'}
      </p>
    </div>
  )
}

/** A table that becomes stacked cards on narrow screens. */
export function ResponsiveTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #EFEFEF', borderRadius: '12px', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '640px' }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" style={{
                padding: '10px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 600,
                color: COLORS.muted, letterSpacing: '0.04em', textTransform: 'uppercase',
                backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export const td: React.CSSProperties = {
  padding: '10px 12px', fontSize: '13px', color: COLORS.ink,
  borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle',
}
export const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/** Profit/loss is never signalled by colour alone — a sign and a word ride along. */
export function ProfitCell({ cents }: { cents: number | null | undefined }) {
  if (cents == null) return <span style={{ color: COLORS.faint }}>—</span>
  const negative = cents < 0
  return (
    <span style={{ color: negative ? COLORS.red : COLORS.navy, fontWeight: 700 }}>
      {money(cents)}{negative ? ' (loss)' : ''}
    </span>
  )
}

/** Server-rendered filter bar — a plain GET form, so filters survive reload,
 *  bookmarking and sharing, and work with JavaScript disabled. */
export function FilterBar({
  action, period, basis, scope, start, end, extra, exportHref,
}: {
  action: string; period: string; basis: string; scope: string
  start?: string; end?: string; extra?: React.ReactNode; exportHref?: string
}) {
  return (
    <form method="get" action={action} style={{
      display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '14px',
    }}>
      <Field label="Period">
        <select name="period" defaultValue={period} style={input}>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="this_week">This week</option>
          <option value="previous_week">Previous week</option>
          <option value="this_month">This month</option>
          <option value="previous_month">Previous month</option>
          <option value="this_quarter">This quarter</option>
          <option value="previous_quarter">Previous quarter</option>
          <option value="year_to_date">Year to date</option>
          <option value="previous_year">Previous year</option>
          <option value="custom">Custom range</option>
        </select>
      </Field>
      <Field label="From"><input type="date" name="start" defaultValue={start} style={input} /></Field>
      <Field label="To (inclusive)"><input type="date" name="end" defaultValue={end} style={input} /></Field>
      <Field label="Mode">
        <select name="scope" defaultValue={scope} style={input}>
          <option value="COMBINED">Finalized + provisional</option>
          <option value="FINALIZED_ONLY">Finalized only</option>
          <option value="PROVISIONAL_ONLY">Provisional only</option>
        </select>
      </Field>
      <Field label="Basis">
        <select name="basis" defaultValue={basis} style={input}>
          <option value="CASH">Cash</option>
          <option value="ACCRUAL">Accrual</option>
        </select>
      </Field>
      {extra}
      <button type="submit" style={{
        minHeight: '44px', padding: '10px 18px', backgroundColor: COLORS.navy, color: '#fff',
        border: 'none', borderRadius: '9px', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
      }}>Apply</button>
      {exportHref && (
        <a href={exportHref} style={{
          minHeight: '44px', display: 'inline-flex', alignItems: 'center', padding: '10px 16px',
          backgroundColor: '#fff', color: COLORS.ink, border: '1px solid #D1D5DB', borderRadius: '9px',
          fontSize: '14px', fontWeight: 700, textDecoration: 'none',
        }}>⬇ CSV</a>
      )}
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 130px', minWidth: '120px' }}>
      <span style={{ fontSize: '11px', color: COLORS.muted, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  )
}

const input: React.CSSProperties = {
  minHeight: '44px', padding: '9px 11px', border: '1px solid #D1D5DB', borderRadius: '9px',
  fontSize: '16px', fontFamily: 'inherit', backgroundColor: '#fff', width: '100%', boxSizing: 'border-box',
}

/** Reads a report through the internal API so the page and the export share one
 *  calculation path. Returns a structured failure rather than throwing. */
export async function fetchReport(report: string, searchParams: Record<string, string | string[] | undefined>, cookie: string) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === 'string' && v !== '') qs.set(k, v)
  }
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  try {
    const res = await fetch(`${base}/api/admin/reports/${report}?${qs.toString()}`, {
      headers: { cookie },
      cache: 'no-store',
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false as const, status: res.status, error: json.error ?? 'Report failed', dataState: json.dataState ?? 'UNAVAILABLE' }
    return { ok: true as const, ...json }
  } catch (e) {
    return { ok: false as const, status: 503, error: 'Reporting service unreachable.', dataState: 'UNAVAILABLE' }
  }
}


// ── Row shapes returned by the reporting API ────────────────────────────────
export type PLLine = { section: string; line: string; currentCents: number; previousCents: number; changeCents: number; changePct: number | null; changeNote: string | null }
export type MoveRow = { bookingId: string; bookingReference: string; customerName: string; moveDate: string | null; financialStatus: string; originCity: string | null; crewSize: number; actualHours: number; netCollectedRevenueCents: number | null; outstandingBalanceCents: number | null; directJobCostCents: number | null; companyNetProfitCents?: number | null; marginBp?: number | null; marketingSource: string; attributionInferred: boolean }
export type RevProfitRow = { bookingId: string; bookingReference: string; customerName: string; netCollectedRevenueCents: number | null; directJobCostCents: number | null; cashGrossProfitCents?: number | null; economicProfitCents?: number | null; marginBp?: number | null; actualHours: number; revenuePerCrewHourCents: number | null; profitPerCrewHourCents?: number | null; alerts: string[] }
export type VarianceRow = { bookingId: string; bookingReference: string; customerName: string; severity: string; scopeChanged: boolean; scopeChangeReasons: string[]; insufficientEstimate: boolean; lines: { metric: string; estimated: number | null; actual: number | null; varianceBp: number | null; severity: string; note: string | null; unit: string }[]; flags: { code: string; message: string }[] }
export type MarketingRow = { sourceKey: string; spendCents: number; leads: number; bookings: number; completedMoves: number; finalizedMoves: number; netCollectedRevenueCents: number; costPerLeadCents: number | null; revenueRoas: string; finalizedNetProfitCents?: number | null; profitRoas: string; verdict: string; caveat: string | null }
export type CustomerRow = { customerId: string; customerName: string; moves: number; completedMoves: number; finalizedMoves: number; netCollectedRevenueCents: number; outstandingBalanceCents: number; companyNetProfitCents?: number | null; marginBp?: number | null; acquisitionSource: string; isRepeat: boolean }

/** One definition row inside a card. */
export function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '3px 0' }}>
      <dt style={{ color: COLORS.muted }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 700, color: COLORS.navy, fontVariantNumeric: 'tabular-nums' }}>{v}</dd>
    </div>
  )
}
