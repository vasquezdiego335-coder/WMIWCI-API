// SUPPRESSIONS (owner spec 2026-07-21).
//
// The do-not-send list, with the reason each address is on it and whether it
// may be lifted. HARD_BOUNCE and SPAM_COMPLAINT are deliberately NOT restorable
// from this screen: a complaint is a recipient telling a mailbox provider we are
// spam, and re-sending damages the sending domain for every other customer.

import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { listSuppressions, canRestoreSuppression, displayEmail } from '@/lib/email-admin'
import { PageHeader, Card, COLORS, Empty, tableStyles as T, SoftBadge, StatCard, StatGrid } from '../../_ui'
import { EmailTabs, dt } from '../_shared'
import SuppressionActions from './SuppressionActions'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

const REASONS = ['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK', 'PROVIDER_REJECTED']

const REASON_COLOR: Record<string, string> = {
  UNSUBSCRIBED: COLORS.amber,
  HARD_BOUNCE: COLORS.red,
  SPAM_COMPLAINT: COLORS.red,
  INVALID_ADDRESS: COLORS.muted,
  ADMIN_BLOCK: COLORS.blue,
  PROVIDER_REJECTED: COLORS.red,
}

export default async function SuppressionsPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const maySeeRecipients = can(session?.role as never, 'email.view_recipients')
  const mayRestore = can(session?.role as never, 'email.manage_suppression')

  const reason = (searchParams.reason as string) || undefined
  const { rows, total, error } = await listSuppressions({ reason, take: 300 })

  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.reason] = (counts[r.reason] ?? 0) + 1

  return (
    <div>
      <PageHeader
        title="Suppressions"
        subtitle={`${total} address${total === 1 ? '' : 'es'} on the do-not-send list.`}
      />
      <EmailTabs active="/admin/email-marketing/suppressions" isOwner={isOwner} />

      <StatGrid min={170}>
        {REASONS.map((r) => (
          <StatCard
            key={r}
            label={r.replace(/_/g, ' ')}
            value={String(counts[r] ?? 0)}
            accent={REASON_COLOR[r]}
            href={`/admin/email-marketing/suppressions?reason=${r}`}
          />
        ))}
      </StatGrid>

      {reason && (
        <p style={{ fontSize: '12px', color: COLORS.muted, marginBottom: '12px' }}>
          Filtered to <strong>{reason}</strong>.{' '}
          <Link href="/admin/email-marketing/suppressions" style={{ color: COLORS.orange }}>
            Show all
          </Link>
        </p>
      )}

      <Card wide>
        {error && <p style={{ fontSize: '13px', color: COLORS.red }}>Could not read the suppression list: {error}</p>}
        {!error && rows.length === 0 && <Empty>No suppressed addresses. That is the good state.</Empty>}
        {rows.length > 0 && (
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  <th style={T.th}>Address</th>
                  <th style={T.th}>Reason</th>
                  <th style={T.th}>Scope</th>
                  <th style={T.th}>Source</th>
                  <th style={T.th}>Since</th>
                  <th style={T.th}>Detail</th>
                  {mayRestore && <th style={T.th}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const restore = canRestoreSuppression(s.reason)
                  return (
                    <tr key={s.id}>
                      <td style={{ ...T.td, fontFamily: 'ui-monospace, monospace', fontSize: '12px' }}>
                        {displayEmail(s.email, maySeeRecipients)}
                      </td>
                      <td style={T.td}>
                        <SoftBadge color={REASON_COLOR[s.reason] ?? COLORS.muted}>{s.reason.replace(/_/g, ' ')}</SoftBadge>
                      </td>
                      <td style={T.td}>
                        <span style={{ fontSize: '12px', color: s.scope === 'all' ? COLORS.red : COLORS.amber, fontWeight: 600 }}>
                          {s.scope === 'all' ? 'All mail' : 'Promotional only'}
                        </span>
                      </td>
                      <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted }}>{s.source ?? '—'}</td>
                      <td style={{ ...T.td, whiteSpace: 'nowrap' }}>{dt(s.createdAt)}</td>
                      <td style={{ ...T.td, fontSize: '11px', color: COLORS.faint, maxWidth: '240px' }}>{s.detail ?? '—'}</td>
                      {mayRestore && (
                        <td style={T.td}>
                          {restore.allow ? (
                            <SuppressionActions email={s.email} reason={s.reason} />
                          ) : (
                            <span title={restore.why} style={{ fontSize: '11px', color: COLORS.faint, fontStyle: 'italic', cursor: 'help' }}>
                              Not restorable
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ marginTop: '18px', padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        <strong style={{ color: COLORS.ink }}>Promotional only</strong> means the customer still receives booking
        confirmations, receipts and move-day reminders — unsubscribing from marketing must never break the messages a
        paying customer needs.{' '}
        <strong style={{ color: COLORS.ink }}>All mail</strong> means the address is not written to at all.
        <br />
        <br />
        A <strong>spam complaint</strong> and a <strong>hard bounce</strong> cannot be lifted here. A complaint damages
        the sending domain for every customer; a hard bounce means the mailbox does not exist, so the fix is to correct
        the address on the customer record.
      </div>
    </div>
  )
}
