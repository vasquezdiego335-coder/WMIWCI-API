import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable, AllocationPanel,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag,
  type RevProfitRow,
} from '../_shared'
import SavedViews from '../SavedViews'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function RevenueVsProfitReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'report.view_financial')
  const result = allowed ? await fetchReport('revenue-profit', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'revenue-profit', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export') && can(role, 'report.export_sensitive')

  return (
    <PageShell title="Revenue versus profit" subtitle="High revenue is not the same as profit. This report shows the difference.">
      <SavedViews reportType="revenue-profit" canShare={can(role, 'report.save_shared_view')} />
      <FilterBar
        action="/admin/reports/revenue-profit"
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
            : (<>
              <AllocationPanel allocation={result.data.allocation} />
              <ResponsiveTable headers={['Move', 'Revenue', 'Direct costs', 'Cash profit', 'Economic profit', 'Margin', 'Hours', 'Rev/hr', 'Profit/hr', 'Alerts']}>
                {(result.data.rows as RevProfitRow[]).map((r) => (
                  <tr key={r.bookingId}>
                    <th scope="row" style={{ ...td, textAlign: 'left' }}>
                      <Link href={`/admin/jobs/${r.bookingId}`} style={{ color: COLORS.orange, fontWeight: 700, textDecoration: 'none' }}>{r.bookingReference}</Link>
                      <div style={{ fontSize: '11px', color: COLORS.muted }}>{r.customerName}</div>
                    </th>
                    <td style={tdNum}>{money(r.netCollectedRevenueCents)}</td>
                    <td style={tdNum}>{money(r.directJobCostCents)}</td>
                    <td style={tdNum}><ProfitCell cents={r.cashGrossProfitCents ?? null} /></td>
                    <td style={tdNum}><ProfitCell cents={r.economicProfitCents ?? null} /></td>
                    <td style={tdNum}>{pctText(r.marginBp)}</td>
                    <td style={tdNum}>{r.actualHours ? `${r.actualHours}h` : '—'}</td>
                    <td style={tdNum}>{money(r.revenuePerCrewHourCents)}</td>
                    <td style={tdNum}>{money(r.profitPerCrewHourCents)}</td>
                    <td style={td}>
                      {r.alerts.length === 0 ? <span style={{ color: COLORS.faint }}>—</span> : (
                        <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {r.alerts.map((a) => <Tag key={a} color={/lost|unpaid/i.test(a) ? COLORS.red : COLORS.amber}>{a}</Tag>)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </ResponsiveTable>
            </>)}
        </>
      )}
    </PageShell>
  )
}
