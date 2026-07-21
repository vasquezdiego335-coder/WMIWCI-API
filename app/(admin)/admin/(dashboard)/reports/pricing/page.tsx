import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag, Row,
} from '../_shared'
import SavedViews from '../SavedViews'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function PricingReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'pricing.view_intelligence')
  const result = allowed ? await fetchReport('pricing', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'pricing', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export')

  return (
    <PageShell title="Pricing intelligence" subtitle="What similar moves really cost — from finalized history only.">
      <SavedViews reportType="pricing" canShare={can(role, 'report.save_shared_view')} />
      <FilterBar
        action="/admin/reports/pricing"
        period={period} basis={basis} scope={scope}
        start={searchParams.start as string} end={searchParams.end as string}
        exportHref={canExportThis ? `/api/admin/reports/export?${exportQs}` : undefined}
      />

      {!allowed && <EmptyState state="PERMISSION" message="You do not have permission to view this report." />}
      {allowed && result && !result.ok && <EmptyState state={result.dataState ?? 'UNAVAILABLE'} message={result.error} />}

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
          {result.dataState !== 'OK'
            ? <EmptyState state={result.dataState} message={result.dataStateMessage} />
            : (<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
                <div style={{ backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '16px' }}>
                  <h2 style={{ fontSize: '13px', fontWeight: 700, color: COLORS.navy, margin: '0 0 4px' }}>Recommendation</h2>
                  <Tag color={result.data.recommendation.confidence === 'INSUFFICIENT' ? COLORS.red : result.data.recommendation.confidence === 'LOW' ? COLORS.amber : COLORS.green}>
                    {result.data.recommendation.confidenceText}
                  </Tag>
                  <p style={{ fontSize: '12px', color: COLORS.muted, margin: '8px 0' }}>
                    Based on {result.data.recommendation.comparableCount} comparable finalized move(s)
                    {result.data.recommendation.outliersDropped > 0 ? `, ${result.data.recommendation.outliersDropped} outlier(s) excluded` : ''}.
                  </p>
                  {result.data.recommendation.suggestedRange ? (
                    <p style={{ fontSize: '22px', fontWeight: 800, color: COLORS.gold, margin: '4px 0' }}>
                      {money(result.data.recommendation.suggestedRange.lowCents)} – {money(result.data.recommendation.suggestedRange.highCents)}
                    </p>
                  ) : (
                    <p style={{ fontSize: '13px', color: COLORS.red, fontWeight: 700, margin: '4px 0' }}>No price recommended</p>
                  )}
                  <dl style={{ fontSize: '12px', margin: '10px 0 0' }}>
                    <Row k="Median price" v={money(result.data.recommendation.medianPriceCents)} />
                    <Row k="Median direct cost" v={money(result.data.recommendation.medianDirectCostCents)} />
                    <Row k="Break-even price" v={money(result.data.recommendation.breakEvenPriceCents)} />
                    <Row k="Lowest profitable price" v={money(result.data.recommendation.lowestProfitablePriceCents)} />
                  </dl>
                  <p style={{ fontSize: '11px', color: COLORS.faint, marginTop: '10px', lineHeight: 1.5 }}>
                    Assumptions: {result.data.recommendation.assumptions.join(' · ')}
                  </p>
                  <ul style={{ fontSize: '11px', color: COLORS.muted, margin: '6px 0 0', paddingLeft: '16px' }}>
                    {result.data.recommendation.caveats.map((c: string) => <li key={c}>{c}</li>)}
                  </ul>
                </div>

                <div style={{ backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '16px' }}>
                  <h2 style={{ fontSize: '13px', fontWeight: 700, color: COLORS.navy, margin: '0 0 8px' }}>Break-even (2 crew, 6h reference)</h2>
                  <dl style={{ fontSize: '12px', margin: 0 }}>
                    <Row k="Direct-cost break-even" v={money(result.data.breakEven.directCostBreakEvenCents)} />
                    <Row k="Cash break-even" v={money(result.data.breakEven.cashBreakEvenCents)} />
                    <Row k="Economic break-even" v={money(result.data.breakEven.economicBreakEvenCents)} />
                    <Row k="Target price" v={money(result.data.breakEven.targetPriceCents)} />
                    <Row k="Expected cash profit" v={money(result.data.breakEven.expectedCashProfitCents)} />
                    <Row k="Expected economic profit" v={money(result.data.breakEven.expectedEconomicProfitCents)} />
                  </dl>
                  <p style={{ fontSize: '11px', color: COLORS.faint, marginTop: '10px', lineHeight: 1.5 }}>
                    Assumptions: {result.data.breakEven.assumptions.join(' · ')}
                  </p>
                  <p style={{ fontSize: '11px', color: COLORS.navy, marginTop: '10px', fontWeight: 700 }}>
                    No quote has been created, sent or applied.
                  </p>
                </div>
              </div>)}
        </>
      )}
    </PageShell>
  )
}
