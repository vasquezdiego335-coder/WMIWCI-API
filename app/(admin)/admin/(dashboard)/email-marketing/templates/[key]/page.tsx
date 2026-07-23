// ONE TEMPLATE — the detail an owner needs before deciding anything about it:
// what fires it, what must be true for it to be truthful, what data it needs,
// what stops it, and what it has actually done.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { prisma } from '@/lib/db'
import { templateByKey, journeyByKey } from '@/lib/email-registry'
import { displayEmail, explainSend, statusTone } from '@/lib/email-admin'
import { PageHeader, Card, COLORS, Empty, tableStyles as T, SoftBadge } from '../../../_ui'
import { EmailTabs, ClassBadge, ToneBadge, dt } from '../../_shared'

export const dynamic = 'force-dynamic'

export default async function TemplateDetail({ params }: { params: { key: string } }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const maySeeRecipients = can(session?.role as never, 'email.view_recipients')

  const key = decodeURIComponent(params.key)
  const t = templateByKey(key)
  if (!t) notFound()

  const journey = t.journey ? journeyByKey(t.journey) : null

  let recent: Awaited<ReturnType<typeof prisma.emailSend.findMany>> = []
  let error: string | null = null
  try {
    recent = await prisma.emailSend.findMany({ where: { template: key }, orderBy: { createdAt: 'desc' }, take: 25 })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return (
    <div>
      <PageHeader
        title={t.name}
        subtitle={t.trigger}
        actions={
          <Link href="/admin/email-marketing/templates" style={{ fontSize: '13px', color: COLORS.muted, textDecoration: 'none' }}>
            ← All templates
          </Link>
        }
      />
      <EmailTabs active="/admin/email-marketing/templates" isOwner={isOwner} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px', marginBottom: '18px' }}>
        <Card title="Identity" icon="🏷">
          <Row label="Key" mono>{t.key}</Row>
          <Row label="Class">
            <ClassBadge emailClass={t.emailClass} />
            <span style={{ fontSize: '11px', color: COLORS.faint, marginLeft: '8px' }}>
              {t.emailClass === 'promotional'
                ? 'Subject to unsubscribe, frequency caps and quiet hours.'
                : 'Exempt from caps — a receipt must arrive when the event happens.'}
            </span>
          </Row>
          <Row label="File" mono>{t.file}</Row>
          <Row label="Journey">
            {journey ? (
              <Link href={`/admin/email-marketing/journeys#${journey.key}`} style={{ color: COLORS.navy, fontWeight: 600, textDecoration: 'none' }}>
                {journey.name}
              </Link>
            ) : (
              <span style={{ color: COLORS.faint }}>Not part of a sequence</span>
            )}
          </Row>
          <Row label="Flag">
            {t.flag ? (
              <SoftBadge color={process.env[t.flag] === 'true' ? COLORS.green : COLORS.amber}>
                {t.flag} = {process.env[t.flag] === 'true' ? 'true' : 'off'}
              </SoftBadge>
            ) : (
              <span style={{ color: COLORS.faint }}>Always on</span>
            )}
          </Row>
          <Row label="Subject">{t.subject}</Row>
        </Card>

        <Card title="What must be true" icon="✅">
          <p style={{ fontSize: '12px', color: COLORS.muted, margin: '0 0 10px', lineHeight: 1.5 }}>
            These are enforced at SEND time, not at schedule time — the booking is reloaded immediately before the
            provider call.
          </p>
          <Row label="Booking status">
            {t.allowedStatuses ? (
              <span style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                {t.allowedStatuses.map((s) => (
                  <SoftBadge key={s} color={COLORS.blue}>
                    {s}
                  </SoftBadge>
                ))}
              </span>
            ) : (
              <span style={{ color: COLORS.faint }}>No booking-status restriction</span>
            )}
          </Row>
          <Row label="Required data">
            {t.requiredFields.length > 0 ? (
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: COLORS.ink }}>
                {t.requiredFields.join(', ')}
              </span>
            ) : (
              <span style={{ color: COLORS.faint }}>No declared required fields</span>
            )}
          </Row>
          <div style={{ marginTop: '12px' }}>
            <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: COLORS.faint, margin: '0 0 7px' }}>
              Stop rules
            </p>
            <ul style={{ margin: 0, paddingLeft: '17px', fontSize: '12px', color: COLORS.ink, lineHeight: 1.7 }}>
              {t.stopRules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </Card>
      </div>

      <Card title="Recent activity" icon="📜" wide>
        {error && <p style={{ fontSize: '12px', color: COLORS.red }}>Could not read send history: {error}</p>}
        {!error && recent.length === 0 && <Empty>This template has never been attempted.</Empty>}
        {recent.length > 0 && (
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  <th style={T.th}>When</th>
                  <th style={T.th}>Recipient</th>
                  <th style={T.th}>Status</th>
                  <th style={T.th}>What happened</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...T.td, whiteSpace: 'nowrap' }}>{dt(r.createdAt)}</td>
                    <td style={{ ...T.td, fontFamily: 'ui-monospace, monospace', fontSize: '12px' }}>
                      {displayEmail(r.email, maySeeRecipients)}
                    </td>
                    <td style={T.td}>
                      <ToneBadge tone={statusTone(r.status)}>{r.status}</ToneBadge>
                    </td>
                    <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted, maxWidth: '460px' }}>
                      {explainSend(r.status, r.blockedReason, r.nextAttemptAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '14px', padding: '7px 0', borderBottom: `1px solid ${COLORS.line}`, alignItems: 'flex-start' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: COLORS.faint, minWidth: '120px', paddingTop: '2px' }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: COLORS.ink, fontFamily: mono ? 'ui-monospace, monospace' : undefined, minWidth: 0, wordBreak: 'break-word' }}>
        {children}
      </span>
    </div>
  )
}
