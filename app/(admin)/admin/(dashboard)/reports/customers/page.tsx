import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag,
  type CustomerRow,
} from '../_shared'
import SavedViews from '../SavedViews'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function CustomerReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'report.view_operational')
  const result = allowed ? await fetchReport('customers', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'customers', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export') && can(role, 'report.export_sensitive')

  return (
    <PageShell title="Customer profitability" subtitle="Ranked by profit, never by revenue alone.">
      <SavedViews reportType="customers" canShare={can(role, 'report.save_shared_view')} />
      <FilterBar
        action="/admin/reports/customers"
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
            : (<ResponsiveTable headers={['Customer', 'Moves', 'Completed', 'Finalized', 'Collected', 'Outstanding', 'Net profit', 'Margin', 'Acquisition', 'Repeat']}>
                {(result.data.rows as CustomerRow[]).map((c) => (
                  <tr key={c.customerId}>
                    <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{c.customerName}</th>
                    <td style={tdNum}>{c.moves}</td>
                    <td style={tdNum}>{c.completedMoves}</td>
                    <td style={tdNum}>{c.finalizedMoves}</td>
                    <td style={tdNum}>{money(c.netCollectedRevenueCents)}</td>
                    <td style={{ ...tdNum, color: (c.outstandingBalanceCents ?? 0) > 0 ? COLORS.amber : COLORS.faint }}>{money(c.outstandingBalanceCents)}</td>
                    <td style={tdNum}><ProfitCell cents={c.companyNetProfitCents ?? null} /></td>
                    <td style={tdNum}>{pctText(c.marginBp)}</td>
                    <td style={td}>{c.acquisitionSource}</td>
                    <td style={td}>{c.isRepeat ? <Tag color={COLORS.green}>Repeat</Tag> : <span style={{ color: COLORS.faint }}>New</span>}</td>
                  </tr>
                ))}
              </ResponsiveTable>)}
        </>
      )}
    </PageShell>
  )
}
