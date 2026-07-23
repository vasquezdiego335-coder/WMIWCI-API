// SCHEDULED SENDS (owner spec 2026-07-21).
//
// What is queued but not yet sent. This reads the BullMQ delayed set directly,
// because the queue is the ONLY place a pending send exists — there is no
// scheduled-send table. When Redis is unreachable the page says so rather than
// rendering an empty list, which would read as "nothing is scheduled" and is
// the exact opposite of the truth.

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { listScheduled } from '@/lib/email-admin'
import { journeyRegistry } from '@/lib/email-registry'
import { PageHeader, Card, COLORS, Empty, Callout, tableStyles as T, SoftBadge } from '../../_ui'
import { EmailTabs, dt } from '../_shared'
import ScheduledActions from './ScheduledActions'

export const dynamic = 'force-dynamic'

export default async function ScheduledPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const mayCancel = can(session?.role as never, 'email.cancel_scheduled')

  const { rows, error } = await listScheduled(300)
  const journeys = new Map(journeyRegistry().map((j) => [j.key, j]))

  return (
    <div>
      <PageHeader
        title="Scheduled"
        subtitle="Emails queued to fire later. Eligibility is re-checked at send time, so a queued job is not a promise."
      />
      <EmailTabs active="/admin/email-marketing/scheduled" isOwner={isOwner} />

      {error && (
        <Callout tone="danger" title="The queue could not be read">
          {error}
          <div style={{ marginTop: '6px' }}>
            This is <strong>not</strong> the same as &ldquo;nothing is scheduled&rdquo; — pending sends may exist and
            are simply invisible right now. Check that Redis is reachable from this container.
          </div>
        </Callout>
      )}

      {!error && rows.length === 0 && (
        <Card wide>
          <Empty>Nothing is scheduled. Journeys are flag-gated — check the Journeys tab if you expected sends here.</Empty>
        </Card>
      )}

      {rows.length > 0 && (
        <Card wide>
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  <th style={T.th}>Due</th>
                  <th style={T.th}>Template</th>
                  <th style={T.th}>Journey</th>
                  <th style={T.th}>Subject record</th>
                  <th style={T.th}>State</th>
                  {mayCancel && <th style={T.th}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const j = r.journey ? journeys.get(r.journey) : null
                  return (
                    <tr key={r.jobId}>
                      <td style={{ ...T.td, whiteSpace: 'nowrap', fontWeight: 600 }}>{dt(r.fireAt)}</td>
                      <td style={T.td}>
                        {r.label}
                        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: COLORS.faint, marginTop: '3px' }}>
                          {r.type}
                        </div>
                      </td>
                      <td style={T.td}>
                        {j ? <SoftBadge color={COLORS.blue}>{j.name}</SoftBadge> : <span style={{ color: COLORS.faint }}>—</span>}
                      </td>
                      <td style={{ ...T.td, fontSize: '11px', fontFamily: 'ui-monospace, monospace', color: COLORS.muted }}>
                        {r.bookingId ? `booking ${r.bookingId.slice(0, 10)}…` : r.leadId ? `lead ${r.leadId.slice(0, 10)}…` : '—'}
                      </td>
                      <td style={T.td}>
                        <SoftBadge color={r.state === 'delayed' ? COLORS.amber : COLORS.blue}>{r.state}</SoftBadge>
                      </td>
                      {mayCancel && (
                        <td style={T.td}>
                          <ScheduledActions jobId={r.jobId} />
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div style={{ marginTop: '18px', padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        Cancelling removes the queued job. It does <strong>not</strong> suppress the recipient and it does not stop a
        job that is already running — an in-flight job is stopped by the send-time eligibility recheck, not by the
        queue. A cancelled stage can be re-created by its trigger firing again.
      </div>
    </div>
  )
}
