import { headers } from 'next/headers'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { COLORS } from '../../_ui'
import {
  PageShell, BasisStrip, EmptyState, FilterBar, ResponsiveTable,
  fetchReport, money, pctText, td, tdNum, ProfitCell, Tag,
  type VarianceRow,
} from '../_shared'
import SavedViews from '../SavedViews'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function VarianceReport({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const role = session?.role as Role
  const cookie = headers().get('cookie') ?? ''
  const allowed = can(role, 'report.view_operational')
  const result = allowed ? await fetchReport('variance', searchParams, cookie) : null

  const period = (searchParams.period as string) ?? 'this_month'
  const basis = (searchParams.basis as string) ?? 'CASH'
  const scope = (searchParams.scope as string) ?? 'COMBINED'
  const exportQs = new URLSearchParams({ report: 'variance', format: 'CSV', period, basis, scope })
  if (searchParams.start) exportQs.set('start', String(searchParams.start))
  if (searchParams.end) exportQs.set('end', String(searchParams.end))
  const canExportThis = can(role, 'report.export')

  return (
    <PageShell title="Estimate versus actual" subtitle="Where quotes missed — and whether the scope changed after booking.">
      <SavedViews reportType="variance" canShare={can(role, 'report.save_shared_view')} />
      <FilterBar
        action="/admin/reports/variance"
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
            : (<div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {(result.data.rows as VarianceRow[]).map((r) => (
                  <div key={r.bookingId} style={{ backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '14px' }}>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
                      <Link href={`/admin/jobs/${r.bookingId}`} style={{ color: COLORS.orange, fontWeight: 700, textDecoration: 'none' }}>{r.bookingReference}</Link>
                      <span style={{ fontSize: '12px', color: COLORS.muted }}>{r.customerName}</span>
                      <Tag color={r.severity === 'WARNING' ? COLORS.red : r.severity === 'NOTICE' ? COLORS.amber : COLORS.green}>{r.severity}</Tag>
                      {r.scopeChanged && <Tag color={COLORS.blue}>Scope changed</Tag>}
                      {r.insufficientEstimate && <Tag color={COLORS.faint}>Estimate incomplete</Tag>}
                    </div>
                    {r.scopeChanged && (
                      <p style={{ fontSize: '12px', color: COLORS.blue, margin: '0 0 8px', lineHeight: 1.5 }}>
                        The customer changed this move after booking ({r.scopeChangeReasons.join('; ')}). Judge the estimate against the original scope.
                      </p>
                    )}
                    <ResponsiveTable headers={['Metric', 'Estimate', 'Actual', 'Variance', 'Status']}>
                      {r.lines.map((l) => (
                        <tr key={l.metric}>
                          <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{l.metric}</th>
                          <td style={tdNum}>{l.estimated == null ? '—' : l.unit === 'cents' ? money(l.estimated) : l.unit === 'minutes' ? `${Math.round(l.estimated / 60 * 10) / 10}h` : l.estimated}</td>
                          <td style={tdNum}>{l.actual == null ? '—' : l.unit === 'cents' ? money(l.actual) : l.unit === 'minutes' ? `${Math.round(l.actual / 60 * 10) / 10}h` : l.actual}</td>
                          <td style={tdNum}>{l.varianceBp == null ? <span style={{ color: COLORS.faint }}>{l.note ?? '—'}</span> : `${(l.varianceBp / 100).toFixed(1)}%`}</td>
                          <td style={td}><Tag color={l.severity === 'WARNING' ? COLORS.red : l.severity === 'NOTICE' ? COLORS.amber : COLORS.green}>{l.severity}</Tag></td>
                        </tr>
                      ))}
                    </ResponsiveTable>
                    {r.flags.length > 0 && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12px', color: COLORS.ink }}>
                        {r.flags.map((f) => <li key={f.code} style={{ marginBottom: '2px' }}>{f.message}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>)}
        </>
      )}
    </PageShell>
  )
}
