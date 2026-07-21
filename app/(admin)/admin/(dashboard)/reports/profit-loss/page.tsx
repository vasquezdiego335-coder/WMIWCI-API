import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag,
  type PLLine,
} from '../_shared'
import SavedViews from '../SavedViews'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function ProfitLossReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'report.view_financial')
  const result = allowed ? await fetchReport('profit-loss', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'profit-loss', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export') && can(role, 'report.export_sensitive')

  return (
    <PageShell title="Profit and loss" subtitle="Internal management report — not a tax return or audited statement.">
      <SavedViews reportType="profit-loss" canShare={can(role, 'report.save_shared_view')} />
      <FilterBar
        action="/admin/reports/profit-loss"
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
              <ResponsiveTable headers={['Section', 'Line', result.meta.periodLabel, result.meta.comparePeriodLabel, 'Change', 'Change %']}>
                {(result.data.lines as PLLine[]).map((l, i) => (
                  <tr key={`${l.section}-${l.line}`} style={i > 0 && l.section !== (result.data.lines as PLLine[])[i - 1].section ? { borderTop: '2px solid #E5E7EB' } : undefined}>
                    <td style={{ ...td, color: COLORS.muted, fontSize: '11px' }}>{l.section}</td>
                    <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{l.line}</th>
                    <td style={tdNum}>{/profit/i.test(l.line) ? <ProfitCell cents={l.currentCents} /> : money(l.currentCents)}</td>
                    <td style={{ ...tdNum, color: COLORS.muted }}>{money(l.previousCents)}</td>
                    <td style={tdNum}>{money(l.changeCents)}</td>
                    <td style={{ ...tdNum, color: COLORS.muted }}>
                      {l.changePct == null ? <span title={l.changeNote ?? ''}>—</span> : `${l.changePct.toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </ResponsiveTable>
              <p style={{ fontSize: '11px', color: COLORS.faint, marginTop: '10px', lineHeight: 1.5 }}>
                {result.data.disclaimer} Owner distributions and reserves are <strong>equity activity, not expenses</strong>.
                A dash in Change % means there was no comparable prior-period value.
              </p>
            </>)}
        </>
      )}
    </PageShell>
  )
}
