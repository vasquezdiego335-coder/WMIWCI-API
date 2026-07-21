// JOURNEY REGISTRY (owner spec 2026-07-21).
//
// Every automated sequence, its anchor event, its stage timings, and — the part
// that matters most — its STOP RULES. Timings are imported from the scheduling
// code itself, so this page cannot show a schedule the scheduler does not run.

import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { journeyRegistry, formatDelay } from '@/lib/email-registry'
import { attributionByJourney, type AttributionRow } from '@/lib/email-attribution'
import { parseRange } from '@/lib/email-admin'
import { PageHeader, Card, COLORS, SoftBadge, tableStyles as T } from '../../_ui'
import { EmailTabs, ClassBadge, RangePicker, money } from '../_shared'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

export default async function JourneysPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const maySeeMoney = can(session?.role as never, 'email.view_attribution')
  const range = parseRange(searchParams.range as string | undefined)

  const journeys = journeyRegistry()
  const attribution = maySeeMoney ? await attributionByJourney(range) : { rows: [] as AttributionRow[], error: null }
  const byKey = new Map(attribution.rows.map((r) => [r.journey, r]))

  return (
    <div>
      <PageHeader
        title="Journeys"
        subtitle="Automated sequences: what starts them, when each stage fires, and what stops them."
        actions={<RangePicker base="/admin/email-marketing/journeys" active={range} />}
      />
      <EmailTabs active="/admin/email-marketing/journeys" isOwner={isOwner} />

      {journeys.map((j) => {
        const a = byKey.get(j.key)
        return (
          <div key={j.key} id={j.key} style={{ marginBottom: '18px', scrollMarginTop: '20px' }}>
            <Card wide>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', marginBottom: '14px' }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: '17px', fontWeight: 700, color: COLORS.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
                    {j.name}
                    <ClassBadge emailClass={j.emailClass} />
                    <SoftBadge color={j.enabled ? COLORS.green : COLORS.faint}>{j.enabled ? 'Active' : 'Off'}</SoftBadge>
                  </h3>
                  <p style={{ fontSize: '13px', color: COLORS.muted, margin: 0 }}>{j.audience}</p>
                </div>
                {j.flag && (
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: COLORS.faint, margin: '0 0 4px' }}>
                      Controlled by
                    </p>
                    <code style={{ fontSize: '11px', color: COLORS.ink, backgroundColor: '#F3F4F6', padding: '3px 8px', borderRadius: '5px' }}>
                      {j.flag}
                    </code>
                  </div>
                )}
              </div>

              <p style={{ fontSize: '12px', color: COLORS.ink, margin: '0 0 14px' }}>
                <strong style={{ color: COLORS.muted }}>Anchor:</strong> {j.anchor}
              </p>

              {/* Stage timeline */}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
                {j.stages.map((s, i) => (
                  <div
                    key={s.type + i}
                    style={{
                      flex: '1 1 150px',
                      minWidth: '150px',
                      backgroundColor: '#F9FAFB',
                      border: `1px solid ${COLORS.line}`,
                      borderLeft: `3px solid ${COLORS.orange}`,
                      borderRadius: '8px',
                      padding: '10px 12px',
                    }}
                  >
                    <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: COLORS.orange, margin: '0 0 4px' }}>
                      {formatDelay(s.delayMs)}
                    </p>
                    <p style={{ fontSize: '13px', fontWeight: 600, color: COLORS.navy, margin: '0 0 3px' }}>{s.label}</p>
                    <Link
                      href={`/admin/email-marketing/templates/${encodeURIComponent(s.template)}`}
                      style={{ fontSize: '11px', color: COLORS.muted, textDecoration: 'none', fontFamily: 'ui-monospace, monospace' }}
                    >
                      {s.template} →
                    </Link>
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '18px' }}>
                <div>
                  <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: COLORS.faint, margin: '0 0 7px' }}>
                    Stop rules
                  </p>
                  <ul style={{ margin: 0, paddingLeft: '17px', fontSize: '12px', color: COLORS.ink, lineHeight: 1.7 }}>
                    {j.stopRules.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p style={{ fontSize: '11px', color: COLORS.faint, margin: '10px 0 0', lineHeight: 1.5 }}>
                    Scheduling code: <code>{j.source}</code>
                  </p>
                </div>

                <div>
                  <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: COLORS.faint, margin: '0 0 7px' }}>
                    Results — {j.conversionGoal}
                  </p>
                  {!maySeeMoney ? (
                    <p style={{ fontSize: '12px', color: COLORS.faint, fontStyle: 'italic', margin: 0 }}>
                      Conversion and profit figures are limited to owners.
                    </p>
                  ) : !a ? (
                    <p style={{ fontSize: '12px', color: COLORS.faint, fontStyle: 'italic', margin: 0 }}>No data.</p>
                  ) : (
                    <>
                      <table style={{ ...T.table, marginBottom: '8px' }}>
                        <tbody>
                          <Metric label="Delivered" value={String(a.delivered)} />
                          <Metric label="Recipients" value={String(a.recipients)} />
                          <Metric label="Clicked" value={a.clicked > 0 ? String(a.clicked) : '—'} />
                          <Metric label="Bounced / complained" value={`${a.bounced} / ${a.complained}`} />
                          <Metric
                            label="Bookings credited"
                            value={a.bookings == null ? 'n/a' : String(a.bookings)}
                            strong
                          />
                          <Metric label="Collected revenue" value={money(a.netCollectedRevenueCents)} />
                          <Metric label="Finalized profit" value={money(a.finalizedNetProfitCents)} strong accent={COLORS.gold} />
                        </tbody>
                      </table>
                      {a.caveat && (
                        <p style={{ fontSize: '11px', color: COLORS.muted, margin: 0, lineHeight: 1.5, fontStyle: 'italic' }}>
                          {a.caveat}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </Card>
          </div>
        )
      })}

      <div style={{ padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        Cancelling a queued stage is an optimisation, never the only protection. Every stage reloads the live booking or
        lead immediately before sending, so a job that escaped cancellation still cannot produce a wrong email.
      </div>
    </div>
  )
}

function Metric({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: string }) {
  return (
    <tr>
      <td style={{ padding: '4px 0', fontSize: '12px', color: COLORS.muted }}>{label}</td>
      <td
        style={{
          padding: '4px 0',
          fontSize: strong ? '14px' : '12px',
          fontWeight: strong ? 800 : 600,
          color: accent ?? COLORS.ink,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </td>
    </tr>
  )
}
