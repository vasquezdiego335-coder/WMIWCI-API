// SEND HISTORY (owner spec 2026-07-21).
//
// Every send AND every refusal, with the reason in plain English. The refusals
// are the point: "why didn't this customer get their email?" was previously
// answerable only from the container logs.

import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { listSends, parseRange, explainSend, statusTone, displayEmail, eventTone } from '@/lib/email-admin'
import { templateRegistry } from '@/lib/email-registry'
import { PageHeader, Card, COLORS, Empty, tableStyles as T } from '../../_ui'
import { EmailTabs, RangePicker, ToneBadge, ClassBadge, dt } from '../_shared'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

const STATUSES = [
  'delivered',
  'deferred',
  'blocked_terminal',
  'blocked_retryable',
  'provider_rejected',
  'failed_terminal',
  'ambiguous',
  'sending',
]

export default async function SendsPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const maySeeRecipients = can(session?.role as never, 'email.view_recipients')

  const range = parseRange(searchParams.range as string | undefined)
  const status = (searchParams.status as string) || undefined
  const template = (searchParams.template as string) || undefined
  const blockedOnly = searchParams.blocked === '1'
  const email = (searchParams.email as string) || undefined

  const { rows, total, error } = await listSends({ range, status, template, blockedOnly, email, take: 150 })
  const templates = templateRegistry()

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    const merged = { range, status, template, blocked: blockedOnly ? '1' : undefined, email, ...patch }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v))
    return `/admin/email-marketing/sends?${p.toString()}`
  }

  return (
    <div>
      <PageHeader
        title="Send history"
        subtitle={`${total} matching record${total === 1 ? '' : 's'}. Showing the ${Math.min(rows.length, 150)} most recent.`}
        actions={<RangePicker base="/admin/email-marketing/sends" active={range} />}
      />
      <EmailTabs active="/admin/email-marketing/sends" isOwner={isOwner} />

      {/* Filters — plain links, so this works with JavaScript disabled. */}
      <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '18px', alignItems: 'center' }}>
        <FilterChip href={qs({ status: undefined, blocked: undefined })} on={!status && !blockedOnly}>
          All
        </FilterChip>
        <FilterChip href={qs({ status: undefined, blocked: '1' })} on={blockedOnly}>
          Not sent
        </FilterChip>
        {STATUSES.map((s) => (
          <FilterChip key={s} href={qs({ status: s, blocked: undefined })} on={status === s}>
            {s}
          </FilterChip>
        ))}
      </div>

      {template && (
        <p style={{ fontSize: '12px', color: COLORS.muted, marginBottom: '12px' }}>
          Filtered to template <code>{template}</code>.{' '}
          <Link href={qs({ template: undefined })} style={{ color: COLORS.orange }}>
            Clear
          </Link>
        </p>
      )}

      {!maySeeRecipients && (
        <p style={{ fontSize: '12px', color: COLORS.muted, marginBottom: '12px', fontStyle: 'italic' }}>
          Recipient addresses are masked at your permission level. The operational record is complete.
        </p>
      )}

      <Card wide>
        {error && <p style={{ fontSize: '13px', color: COLORS.red }}>Could not read the send ledger: {error}</p>}
        {!error && rows.length === 0 && <Empty>No sends match these filters.</Empty>}
        {rows.length > 0 && (
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  <th style={T.th}>When</th>
                  <th style={T.th}>Recipient</th>
                  <th style={T.th}>Template</th>
                  <th style={T.th}>Status</th>
                  <th style={T.th}>What happened</th>
                  <th style={T.th}>Events</th>
                  <th style={T.th}>Linked to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const t = templates.find((x) => x.key === r.template)
                  return (
                    <tr key={r.id}>
                      <td style={{ ...T.td, whiteSpace: 'nowrap' }}>{dt(r.createdAt)}</td>
                      <td style={{ ...T.td, fontFamily: 'ui-monospace, monospace', fontSize: '12px' }}>
                        <Link href={qs({ email: r.email })} style={{ color: COLORS.navy, textDecoration: 'none' }}>
                          {displayEmail(r.email, maySeeRecipients)}
                        </Link>
                      </td>
                      <td style={{ ...T.td, minWidth: '150px' }}>
                        <Link
                          href={`/admin/email-marketing/templates/${encodeURIComponent(r.template)}`}
                          style={{ color: COLORS.navy, textDecoration: 'none', fontWeight: 600 }}
                        >
                          {t?.name ?? r.template}
                        </Link>
                        <div style={{ marginTop: '4px' }}>
                          <ClassBadge emailClass={r.emailClass} />
                        </div>
                      </td>
                      <td style={T.td}>
                        <ToneBadge tone={statusTone(r.status)}>{r.status}</ToneBadge>
                        {r.attempts > 1 && (
                          <div style={{ fontSize: '10px', color: COLORS.faint, marginTop: '4px' }}>{r.attempts} attempts</div>
                        )}
                      </td>
                      <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted, maxWidth: '400px' }}>
                        {explainSend(r.status, r.blockedReason, r.nextAttemptAt)}
                      </td>
                      <td style={T.td}>
                        {r.events.length === 0 ? (
                          <span style={{ color: COLORS.faint, fontSize: '11px' }}>—</span>
                        ) : (
                          <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {r.events.map((e, i) => (
                              <ToneBadge key={i} tone={eventTone(e.type)}>
                                {e.type}
                              </ToneBadge>
                            ))}
                          </span>
                        )}
                      </td>
                      <td style={{ ...T.td, fontSize: '11px' }}>
                        {r.bookingId ? (
                          <Link href={`/admin/jobs/${r.bookingId}`} style={{ color: COLORS.orange, textDecoration: 'none' }}>
                            Booking →
                          </Link>
                        ) : r.leadId ? (
                          <span style={{ color: COLORS.muted }}>Lead</span>
                        ) : (
                          <span style={{ color: COLORS.faint }}>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function FilterChip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        fontSize: '11px',
        fontWeight: on ? 700 : 500,
        padding: '5px 10px',
        borderRadius: '7px',
        textDecoration: 'none',
        color: on ? '#FFFFFF' : COLORS.muted,
        backgroundColor: on ? COLORS.navy : '#F3F4F6',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      {children}
    </Link>
  )
}
