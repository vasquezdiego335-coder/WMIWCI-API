import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable, AllocationPanel,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag,
  type MoveRow,
} from '../_shared'
import SavedViews from '../SavedViews'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function MoveProfitabilityReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'report.view_operational')
  const result = allowed ? await fetchReport('moves', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'moves', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export')

  return (
    <PageShell title="Move profitability" subtitle="Every move in the period, with its financial status.">
      <SavedViews reportType="moves" canShare={can(role, 'report.save_shared_view')} />
      <FilterBar
        action="/admin/reports/moves"
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
              <ResponsiveTable headers={['Move', 'Date', 'Status', 'City', 'Crew', 'Hours', 'Collected', 'Outstanding', 'Costs', 'Profit', 'Margin', 'Source']}>
                {(result.data.rows as MoveRow[]).map((r) => (
                  <tr key={r.bookingId}>
                    <th scope="row" style={{ ...td, textAlign: 'left' }}>
                      <Link href={`/admin/jobs/${r.bookingId}`} style={{ color: COLORS.orange, fontWeight: 700, textDecoration: 'none' }}>
                        {r.bookingReference}
                      </Link>
                      <div style={{ fontSize: '11px', color: COLORS.muted }}>{r.customerName}</div>
                    </th>
                    <td style={td}>{r.moveDate ? r.moveDate.slice(0, 10) : '—'}</td>
                    <td style={td}>
                      <Tag color={r.financialStatus === 'FINALIZED' ? COLORS.green : r.financialStatus === 'PROVISIONAL' ? COLORS.amber : COLORS.faint}>
                        {r.financialStatus === 'FINALIZED' ? 'Finalized' : r.financialStatus === 'PROVISIONAL' ? 'Provisional' : 'Not started'}
                      </Tag>
                    </td>
                    <td style={td}>{r.originCity ?? '—'}</td>
                    <td style={tdNum}>{r.crewSize}</td>
                    <td style={tdNum}>{r.actualHours ? `${r.actualHours}h` : '—'}</td>
                    <td style={tdNum}>{money(r.netCollectedRevenueCents)}</td>
                    <td style={{ ...tdNum, color: (r.outstandingBalanceCents ?? 0) > 0 ? COLORS.amber : COLORS.faint }}>{money(r.outstandingBalanceCents)}</td>
                    <td style={tdNum}>{money(r.directJobCostCents)}</td>
                    <td style={tdNum}><ProfitCell cents={r.companyNetProfitCents ?? null} /></td>
                    <td style={tdNum}>{pctText(r.marginBp)}</td>
                    <td style={td}>
                      {r.marketingSource}{r.attributionInferred ? <span title="Inferred from an earlier touch" style={{ color: COLORS.faint }}> ~</span> : ''}
                    </td>
                  </tr>
                ))}
              </ResponsiveTable>
              {result.page && (
                <p style={{ fontSize: '12px', color: COLORS.muted, marginTop: '10px' }}>
                  Page {result.page.page} of {result.page.totalPages} · {result.page.total} moves
                </p>
              )}
            </>)}
        </>
      )}
    </PageShell>
  )
}
