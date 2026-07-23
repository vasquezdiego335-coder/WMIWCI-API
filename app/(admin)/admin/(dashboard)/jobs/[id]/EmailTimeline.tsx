// PER-BOOKING EMAIL TIMELINE (owner spec 2026-07-21).
//
// WHY THIS EXISTS ALONGSIDE "Communications": that card reads the legacy
// `Notification` table, which records only what was HANDED OFF to be sent. This
// one reads `email_sends` — the guard's own ledger — which also records every
// email that was considered and REFUSED, with the reason.
//
// That difference is the whole point. "Communications" can answer "what did we
// send?". Only this can answer "why didn't they get the reminder?".

import { emailTimeline, statusTone, displayEmail } from '@/lib/email-admin'
import { Card, COLORS, Empty, SoftBadge } from '../../_ui'

const TONES: Record<string, string> = { good: COLORS.green, warn: COLORS.amber, bad: COLORS.red, muted: COLORS.faint }

const when = (d: Date | null) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'

export default async function EmailTimeline({
  bookingId,
  customerEmail,
  maySeeRecipients,
}: {
  bookingId: string
  customerEmail?: string | null
  maySeeRecipients: boolean
}) {
  const { rows, error } = await emailTimeline({ bookingId, email: customerEmail ?? undefined, take: 60 })

  const notSent = rows.filter((r) => r.status !== 'delivered').length

  return (
    <Card
      title={`Email Ledger (${rows.length})`}
      icon="📬"
      action={
        notSent > 0 ? (
          <SoftBadge color={COLORS.amber}>{notSent} not sent</SoftBadge>
        ) : rows.length > 0 ? (
          <SoftBadge color={COLORS.green}>All delivered</SoftBadge>
        ) : undefined
      }
    >
      {error && <p style={{ fontSize: '12px', color: COLORS.red, margin: 0 }}>Could not read the email ledger: {error}</p>}
      {!error && rows.length === 0 && (
        <Empty>No email has been attempted for this booking or customer.</Empty>
      )}

      {rows.map((r, i) => (
        <div
          key={r.id}
          style={{
            padding: '10px 0',
            borderBottom: i < rows.length - 1 ? `1px solid ${COLORS.line}` : 'none',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: COLORS.navy }}>{r.label}</div>
              <div style={{ fontSize: '11px', color: COLORS.faint, marginTop: '2px' }}>
                {displayEmail(r.email, maySeeRecipients)}
                {r.journey ? ` · ${r.journey}` : ''}
                {' · '}
                {r.sentAt ? `sent ${when(r.sentAt)}` : `attempted ${when(r.createdAt)}`}
                {r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' }}>
              {r.events.map((e, k) => (
                <SoftBadge key={k} color={e.type === 'bounced' || e.type === 'complained' ? COLORS.red : COLORS.green}>
                  {e.type}
                </SoftBadge>
              ))}
              <SoftBadge color={TONES[statusTone(r.status)]}>{r.status}</SoftBadge>
            </div>
          </div>
          {r.status !== 'delivered' && (
            <p style={{ fontSize: '11px', color: COLORS.muted, margin: '6px 0 0', lineHeight: 1.5 }}>{r.explanation}</p>
          )}
        </div>
      ))}

      {rows.length > 0 && (
        <p style={{ fontSize: '11px', color: COLORS.faint, margin: '12px 0 0', lineHeight: 1.5 }}>
          This is the send guard&apos;s own record. Rows that are not <em>delivered</em> were deliberately refused — the
          reason above is the exact one the system recorded.
        </p>
      )}
    </Card>
  )
}
