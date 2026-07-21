import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../_ui'
import {
  PageShell, BasisStrip, Metric, MetricGrid, EmptyState, FilterBar, AllocationPanel,
  fetchReport, money, pctText, GLOSSARY,
} from './_shared'

// ════════════════════════════════════════════════════════════════════════════
//  Reporting Overview (Stage 3B, owner spec 2026-07-20) — /admin/reports
//
//  The page renders NOTHING it cannot vouch for: the basis strip states the
//  accounting basis, reporting mode and timezone above every figure, and an
//  unmeasurable metric shows "No verified data" rather than $0.00.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

const LINKS: { href: string; label: string; blurb: string; action: Parameters<typeof can>[1] }[] = [
  { href: '/admin/reports/profit-loss', label: 'Profit & loss', blurb: 'Revenue, costs and profit vs the previous period', action: 'report.view_financial' },
  { href: '/admin/reports/revenue-profit', label: 'Revenue vs profit', blurb: 'Which moves were actually worth doing', action: 'report.view_financial' },
  { href: '/admin/reports/moves', label: 'Move profitability', blurb: 'Every move, filterable and exportable', action: 'report.view_operational' },
  { href: '/admin/reports/variance', label: 'Estimate vs actual', blurb: 'Where quotes miss, and why', action: 'report.view_operational' },
  { href: '/admin/reports/marketing', label: 'Marketing profitability', blurb: 'Profit ROAS by source and campaign', action: 'report.view_marketing' },
  { href: '/admin/reports/customers', label: 'Customer profitability', blurb: 'Repeat customers and realized value', action: 'report.view_operational' },
  { href: '/admin/reports/pricing', label: 'Pricing intelligence', blurb: 'Comparables, break-even and quote ranges', action: 'pricing.view_intelligence' },
]

export default async function ReportsOverview({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''

  const allowed = can(role, 'report.view_financial')
  const result = allowed ? await fetchReport('overview', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'overview', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))

  return (
    <PageShell
      title="Reports"
      subtitle="Company performance from finalized financial records."
    >
      <FilterBar
        action="/admin/reports"
        period={period} basis={basis} scope={scope}
        start={searchParams.start as string} end={searchParams.end as string}
        exportHref={can(role, 'report.export_sensitive') ? `/api/admin/reports/export?${exportQs}` : undefined}
      />

      {!allowed && (
        <EmptyState
          state="PERMISSION"
          message="Company profit reporting is limited to owners. Operational reports are available from the links below."
        />
      )}

      {allowed && result && !result.ok && (
        <EmptyState state={result.dataState ?? 'UNAVAILABLE'} message={result.error} />
      )}

      {allowed && result?.ok && (
        <>
          <BasisStrip
            basisLabel={result.meta.basisLabel}
            periodLabel={result.meta.periodLabel}
            timezone={result.meta.timezone}
            finalized={result.meta.finalizedMoveCount}
            provisional={result.meta.provisionalMoveCount}
            incomplete={result.meta.incompleteMoveCount}
            warnings={result.meta.warnings}
          />

          {result.dataState !== 'OK' ? (
            <EmptyState state={result.dataState} message={result.dataStateMessage} />
          ) : (
            <>
            {/* The owner's policy, stated in the owner's terms, above the
                metric grid — never the raw 50/50 split on its own. */}
            <AllocationPanel allocation={result.data.allocation} />
            <MetricGrid>
              {(result.data.metrics as MetricRow[]).map((m) => (
                <Metric
                  key={m.metric}
                  label={m.metric}
                  value={money(m.valueCents)}
                  note={noteFor(m)}
                  tone={toneFor(m)}
                  help={GLOSSARY[m.metric] ?? undefined}
                />
              ))}
              <Metric
                label="Profit margin"
                value={result.data.marginPct == null ? '—' : pctText(result.data.marginPct * 100)}
                note={result.data.marginPct == null ? 'No collected revenue in this period' : 'Company net profit ÷ collected revenue'}
              />
            </MetricGrid>
            </>
          )}
        </>
      )}

      <h2 style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy, margin: '22px 0 10px' }}>All reports</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '10px' }}>
        {LINKS.filter((l) => can(role, l.action)).map((l) => (
          <Link key={l.href} href={l.href} style={{
            display: 'block', backgroundColor: '#fff', border: '1px solid #EFEFEF',
            borderRadius: '12px', padding: '14px 16px', textDecoration: 'none', minHeight: '44px',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy }}>{l.label}</div>
            <div style={{ fontSize: '12px', color: COLORS.muted, marginTop: '3px', lineHeight: 1.4 }}>{l.blurb}</div>
          </Link>
        ))}
      </div>

      <details style={{ marginTop: '22px' }}>
        <summary style={{ fontSize: '13px', fontWeight: 700, color: COLORS.navy, cursor: 'pointer' }}>
          What do these terms mean?
        </summary>
        <dl style={{ margin: '10px 0 0', fontSize: '12px', color: COLORS.ink }}>
          {Object.entries(GLOSSARY).map(([term, desc]) => (
            <div key={term} style={{ marginBottom: '7px' }}>
              <dt style={{ fontWeight: 700, color: COLORS.navy }}>{term}</dt>
              <dd style={{ margin: '1px 0 0 0', color: COLORS.muted, lineHeight: 1.5 }}>{desc}</dd>
            </div>
          ))}
        </dl>
      </details>
    </PageShell>
  )
}

type MetricRow = { metric: string; valueCents: number | null; note: string | null; delta: { changeBp: number | null; note: string | null; changeCents: number } | null }

function noteFor(m: MetricRow): string | null {
  if (m.note) return m.note
  if (!m.delta) return null
  if (m.delta.changeBp == null) return m.delta.note
  const dir = m.delta.changeCents >= 0 ? '▲' : '▼'
  return `${dir} ${money(Math.abs(m.delta.changeCents))} (${(m.delta.changeBp / 100).toFixed(1)}%) vs previous period`
}

function toneFor(m: MetricRow): string | undefined {
  if (m.valueCents == null) return undefined
  if (/profit/i.test(m.metric)) return m.valueCents < 0 ? COLORS.red : COLORS.gold
  if (/outstanding/i.test(m.metric)) return m.valueCents > 0 ? COLORS.amber : undefined
  return undefined
}
