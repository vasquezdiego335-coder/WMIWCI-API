import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag,
  type MarketingRow,
} from '../_shared'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function MarketingReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'report.view_marketing')
  const result = allowed ? await fetchReport('marketing', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'marketing', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export') && can(role, 'report.export_sensitive')

  return (
    <PageShell title="Marketing profitability" subtitle="Judged by Profit ROAS — money made per dollar spent, from finalized moves only.">
      <FilterBar
        action="/admin/reports/marketing"
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
            : (<ResponsiveTable headers={['Source', 'Spend', 'Leads', 'Bookings', 'Completed', 'Finalized', 'Revenue', 'Cost/lead', 'Revenue ROAS', 'Finalized profit', 'Profit ROAS', 'Verdict']}>
                {(result.data.rows as MarketingRow[]).map((r) => (
                  <tr key={r.sourceKey}>
                    <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{r.sourceKey}</th>
                    <td style={tdNum}>{money(r.spendCents)}</td>
                    <td style={tdNum}>{r.leads}</td>
                    <td style={tdNum}>{r.bookings}</td>
                    <td style={tdNum}>{r.completedMoves}</td>
                    <td style={tdNum}>{r.finalizedMoves}</td>
                    <td style={tdNum}>{money(r.netCollectedRevenueCents)}</td>
                    <td style={tdNum}>{r.costPerLeadCents == null ? '—' : money(r.costPerLeadCents)}</td>
                    <td style={{ ...tdNum, color: COLORS.muted }}>{r.revenueRoas}</td>
                    <td style={tdNum}><ProfitCell cents={r.finalizedNetProfitCents ?? null} /></td>
                    <td style={{ ...tdNum, fontWeight: 800 }}>{r.profitRoas}</td>
                    <td style={td}>
                      <Tag color={r.verdict === 'PROFITABLE' ? COLORS.green : r.verdict === 'UNPROFITABLE' ? COLORS.red : COLORS.faint}>{r.verdict}</Tag>
                      {r.caveat && <div style={{ fontSize: '11px', color: COLORS.muted, marginTop: '3px', maxWidth: '260px', lineHeight: 1.4 }}>{r.caveat}</div>}
                    </td>
                  </tr>
                ))}
              </ResponsiveTable>)}
        </>
      )}
    </PageShell>
  )
}
