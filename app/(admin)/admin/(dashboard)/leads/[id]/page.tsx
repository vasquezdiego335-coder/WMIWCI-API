import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { allowedActionsFor } from '@/lib/lead-transitions'
import { statusBadge, marketingBadge, badge } from '../_badges'
import { Card, COLORS, Empty } from '../../_ui'
import LeadActions from './LeadActions'

export const revalidate = 0

// ════════════════════════════════════════════════════════════════════════
//  /admin/leads/[id] — lead detail (Moving OS Phase 1, Stage 2C). One page
//  that answers: who is this, how do I reach them, where are they in the
//  pipeline, what did they tell us, and what have we sent them. Pipeline
//  actions live in the LeadActions client island; the allowed set is computed
//  server-side from the pure transition map so no illegal button ever renders.
// ════════════════════════════════════════════════════════════════════════

const CONTACT_PREF_LABELS: Record<string, string> = {
  call_asap: 'Call ASAP',
  text: 'Text',
  email: 'Email',
  customer_will_contact: 'Customer will contact us',
}

const LOST_REASON_LABELS: Record<string, string> = {
  PRICE_TOO_HIGH: 'Price too high',
  NO_RESPONSE: 'No response',
  DATE_UNAVAILABLE: 'Date unavailable',
  CHOSE_COMPETITOR: 'Chose a competitor',
  NEEDED_IMMEDIATE: 'Needed immediate help',
  OUTSIDE_SERVICE_AREA: 'Outside service area',
  OTHER: 'Other',
}

const fmtDate = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : null
const fmtDateTime = (d: Date | null | undefined) =>
  d
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
    : null

export default async function AdminLeadDetail({ params }: { params: { id: string } }) {
  await getSession()

  const lead = await prisma.lead.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, phone: true, email: true, source: true, status: true, lifecycle: true,
      lostReason: true, assignedTo: true, convertedBookingId: true,
      contactPreference: true, bestTimeToCall: true,
      moveDate: true, moveSize: true, originZip: true, destinationZip: true, zip: true,
      originCity: true, destCity: true, jobType: true, notes: true, message: true, estimatedValue: true,
      emailMarketingConsent: true, marketingConsentAt: true, marketingConsentSource: true, marketingConsentVersion: true,
      utmSource: true, utmCampaign: true, landingPage: true, referrer: true, promoCode: true,
      contactedAt: true, quotedAt: true, bookedAt: true, lostAt: true, createdAt: true, lastActivityAt: true,
    },
  })
  if (!lead) notFound()

  const [supp, emailSends] = await Promise.all([
    lead.email
      ? prisma.emailSuppression.findUnique({ where: { email: lead.email }, select: { reason: true, scope: true } })
      : Promise.resolve(null),
    prisma.emailSend.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, email: true, template: true, status: true, createdAt: true },
    }),
  ])

  const actions = allowedActionsFor(lead.status)
  const converted = !!lead.convertedBookingId

  const stages: Array<[string, Date | null]> = [
    ['Created', lead.createdAt],
    ['Contacted', lead.contactedAt],
    ['Quoted', lead.quotedAt],
    ['Booked', lead.bookedAt],
    ['Lost', lead.lostAt],
  ]

  return (
    <div>
      <Link href="/admin/leads" style={{ fontSize: '13px', color: COLORS.muted, textDecoration: 'none' }}>← Leads</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap', margin: '10px 0 20px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: COLORS.navy, margin: '0 0 6px' }}>{lead.name}</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {statusBadge(lead.lifecycle, lead.status, lead.convertedBookingId)}
            {lead.status === 'LOST' && lead.lostReason && (
              <span style={{ ...badge, background: '#FEE2E2', color: '#991B1B' }}>{LOST_REASON_LABELS[lead.lostReason] ?? lead.lostReason}</span>
            )}
            {marketingBadge(lead.emailMarketingConsent, supp ?? undefined)}
            <span style={{ fontSize: '12px', color: COLORS.faint }}>
              {(lead.source ?? 'OTHER').replace(/_/g, ' ').toLowerCase()} · created {fmtDate(lead.createdAt)}
            </span>
          </div>
        </div>
        {converted ? (
          <Link href={`/admin/jobs/${lead.convertedBookingId}`} style={{ ...ctaLink, backgroundColor: '#DCFCE7', color: '#166534' }}>
            View booking →
          </Link>
        ) : (
          <Link href={`/admin/book?leadId=${lead.id}`} style={ctaLink}>Convert to booking →</Link>
        )}
      </div>

      <div style={{ marginBottom: '20px' }}>
        <Card title="Pipeline actions" icon="🧭">
          <LeadActions id={lead.id} actions={actions} assignedTo={lead.assignedTo} />
        </Card>
      </div>

      <div style={grid}>
        <Card title="Contact" icon="📞">
          <InfoRow label="Phone" value={lead.phone ? <a href={`tel:${lead.phone}`} style={link}>{lead.phone}</a> : null} />
          <InfoRow label="Email" value={lead.email ? <a href={`mailto:${lead.email}`} style={link}>{lead.email}</a> : null} />
          <InfoRow label="Prefers" value={lead.contactPreference ? CONTACT_PREF_LABELS[lead.contactPreference] ?? lead.contactPreference : null} />
          <InfoRow label="Best time" value={lead.bestTimeToCall} />
          <InfoRow label="Assigned to" value={lead.assignedTo} />
        </Card>

        <Card title="Stage timestamps" icon="🕐">
          {stages.map(([label, at]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '5px 0', borderBottom: `1px solid ${COLORS.line}` }}>
              <span style={{ fontSize: '13px', color: at ? COLORS.ink : COLORS.faint, fontWeight: at ? 600 : 400 }}>{at ? '● ' : '○ '}{label}</span>
              <span style={{ fontSize: '12.5px', color: at ? COLORS.ink : COLORS.faint, fontVariantNumeric: 'tabular-nums' }}>{fmtDateTime(at) ?? '—'}</span>
            </div>
          ))}
          {lead.lastActivityAt && (
            <p style={{ fontSize: '11.5px', color: COLORS.faint, margin: '8px 0 0' }}>Last activity {fmtDateTime(lead.lastActivityAt)}</p>
          )}
        </Card>

        <Card title="Move info" icon="📦">
          <InfoRow label="Move date" value={fmtDate(lead.moveDate)} />
          <InfoRow label="Size" value={lead.moveSize} />
          <InfoRow label="Service" value={lead.jobType} />
          <InfoRow label="From ZIP" value={lead.originZip ?? lead.zip} />
          <InfoRow label="To ZIP" value={lead.destinationZip} />
          <InfoRow label="From / to city" value={lead.originCity || lead.destCity ? `${lead.originCity ?? '?'} → ${lead.destCity ?? '?'}` : null} />
          <InfoRow
            label="Est. value"
            value={typeof lead.estimatedValue === 'number' ? `$${Math.round(lead.estimatedValue / 100).toLocaleString()}` : null}
          />
        </Card>

        <Card title="Marketing + consent" icon="📣">
          <InfoRow label="Consent" value={lead.emailMarketingConsent === true ? 'Opted in' : lead.emailMarketingConsent === false ? 'Declined' : 'Never asked'} />
          <InfoRow label="Consent at" value={fmtDateTime(lead.marketingConsentAt)} />
          <InfoRow label="Consent source" value={lead.marketingConsentSource} />
          <InfoRow label="Consent version" value={lead.marketingConsentVersion} />
          <InfoRow label="Campaign" value={lead.utmCampaign} />
          <InfoRow label="UTM source" value={lead.utmSource} />
          <InfoRow label="Promo code" value={lead.promoCode} />
        </Card>
      </div>

      {(lead.notes || lead.message) && (
        <div style={{ marginTop: '20px' }}>
          <Card title="Notes" icon="📝">
            {lead.message && <p style={noteText}><strong style={{ color: COLORS.muted }}>Message:</strong> {lead.message}</p>}
            {lead.notes && <p style={{ ...noteText, whiteSpace: 'pre-wrap' }}>{lead.notes}</p>}
          </Card>
        </div>
      )}

      <div style={{ marginTop: '20px' }}>
        <Card title={`Emails (${emailSends.length})`} icon="✉️">
          {emailSends.length === 0 ? (
            <Empty>No emails linked to this lead.</Empty>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['To', 'Template', 'Status', 'Sent'].map((h) => (
                    <th key={h} style={eTh}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {emailSends.map((s) => (
                  <tr key={s.id}>
                    <td style={eTd}>{s.email}</td>
                    <td style={eTd}>{s.template}</td>
                    <td style={eTd}>
                      <span style={{ ...badge, background: s.status === 'delivered' ? '#DCFCE7' : s.status.startsWith('blocked') || s.status === 'failed_terminal' ? '#FEE2E2' : '#F3F4F6', color: s.status === 'delivered' ? '#166534' : s.status.startsWith('blocked') || s.status === 'failed_terminal' ? '#991B1B' : '#475569' }}>
                        {s.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td style={{ ...eTd, whiteSpace: 'nowrap' }}>{fmtDateTime(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode | null }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '5px 0' }}>
      <span style={{ fontSize: '12.5px', color: COLORS.muted }}>{label}</span>
      <span style={{ fontSize: '13px', color: COLORS.ink, fontWeight: 500, textAlign: 'right', overflowWrap: 'anywhere' }}>{value ?? '—'}</span>
    </div>
  )
}

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px' }
const link: React.CSSProperties = { color: '#1D4ED8', textDecoration: 'none', fontWeight: 600 }
const ctaLink: React.CSSProperties = { padding: '9px 16px', backgroundColor: '#FF5A1F', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }
const noteText: React.CSSProperties = { fontSize: '13px', color: '#374151', lineHeight: 1.6, margin: '0 0 8px' }
const eTh: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: '#6B7280', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' }
const eTd: React.CSSProperties = { padding: '8px 10px', fontSize: '12.5px', color: '#374151', borderBottom: '1px solid #F3F4F6' }
