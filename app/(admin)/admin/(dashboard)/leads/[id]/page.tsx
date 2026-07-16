import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import LeadActions from './LeadActions'

export const revalidate = 0

const dt = (d?: Date | null) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—'

export default async function LeadDetail({ params }: { params: { id: string } }) {
  await getSession()

  const lead = await prisma.lead.findUnique({ where: { id: params.id } })
  if (!lead) notFound()

  // Activity history — audit entries tagged with this lead id.
  const activity = await prisma.auditLog.findMany({
    where: { action: 'LEAD_STATUS_CHANGED', details: { path: ['leadId'], equals: lead.id } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { user: { select: { name: true } } },
  })

  const convertedBooking = lead.convertedBookingId
    ? await prisma.booking.findUnique({ where: { id: lead.convertedBookingId }, select: { id: true, displayId: true, status: true } }).catch(() => null)
    : null

  const adRows: [string, string | null][] = [
    ['gclid', lead.gclid], ['gbraid', lead.gbraid], ['wbraid', lead.wbraid],
    ['utm_source', lead.utmSource], ['utm_medium', lead.utmMedium], ['utm_campaign', lead.utmCampaign],
    ['utm_term', lead.utmTerm], ['utm_content', lead.utmContent],
    ['landing page', lead.landingPage], ['referrer', lead.referrer],
    ['first touch', lead.firstTouchAt ? dt(lead.firstTouchAt) : null],
  ]
  const hasAttribution = adRows.some(([, v]) => v)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Link href="/admin/leads" style={{ fontSize: 13, color: '#6B7280' }}>← Leads</Link>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0A1628', margin: '4px 0 0' }}>{lead.name}</h1>
        </div>
        <span style={{ fontSize: 12, backgroundColor: '#F3F4F6', color: '#374151', padding: '5px 12px', borderRadius: 100, fontWeight: 600 }}>{lead.status.replace(/_/g, ' ')}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <section style={card}>
            <h2 style={cardHdr}>Contact</h2>
            <Row k="Email" v={lead.email ?? '—'} />
            <Row k="Phone" v={lead.phone ?? '—'} />
            <Row k="Source" v={lead.source.replace(/_/g, ' ')} />
            <Row k="Assigned to" v={lead.assignedTo ?? '—'} />
            <Row k="Follow-up" v={lead.followUpAt ? dt(lead.followUpAt) : '—'} />
            <Row k="Received" v={dt(lead.createdAt)} />
            <Row k="Last activity" v={dt(lead.lastActivityAt)} />
            {convertedBooking && (
              <Row k="Converted booking" v={<Link href={`/admin/jobs/${convertedBooking.id}`} style={{ color: '#FF5A1F' }}>{convertedBooking.displayId ?? convertedBooking.id} ({convertedBooking.status}) →</Link>} />
            )}
            {lead.archivedAt && <Row k="Archived" v={dt(lead.archivedAt)} />}
          </section>

          <section style={card}>
            <h2 style={cardHdr}>Message &amp; notes</h2>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{lead.notes || lead.message || '—'}</pre>
          </section>

          <section style={card}>
            <h2 style={cardHdr}>Ad attribution</h2>
            {hasAttribution ? adRows.filter(([, v]) => v).map(([k, v]) => <Row key={k} k={k} v={v as string} mono />) : <p style={{ fontSize: 13, color: '#9CA3AF', margin: 0 }}>No ad attribution captured for this lead.</p>}
          </section>

          <section style={card}>
            <h2 style={cardHdr}>Activity history</h2>
            {activity.length === 0 ? <p style={{ fontSize: 13, color: '#9CA3AF', margin: 0 }}>No changes recorded yet.</p> : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
                {activity.map((a) => {
                  const d = (a.details ?? {}) as { changes?: { field: string; from: unknown; to: unknown }[]; actor?: string }
                  return (
                    <li key={a.id} style={{ borderLeft: '2px solid #E5E7EB', paddingLeft: 12 }}>
                      <div style={{ fontSize: 12, color: '#374151' }}>
                        {(d.changes ?? []).map((c, i) => (
                          <span key={i}>{c.field}: {String(c.from ?? '—')} → <strong>{String(c.to ?? '—')}</strong>{i < (d.changes!.length - 1) ? '; ' : ''}</span>
                        ))}
                      </div>
                      <div style={{ fontSize: 11, color: '#9CA3AF' }}>{a.user?.name ?? d.actor ?? 'system'} · {dt(a.createdAt)}</div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        <LeadActions
          id={lead.id}
          status={lead.status}
          lostReason={lead.lostReason}
          assignedTo={lead.assignedTo}
          followUpAt={lead.followUpAt ? lead.followUpAt.toISOString() : null}
          archived={Boolean(lead.archivedAt)}
          convertedBookingId={lead.convertedBookingId}
        />
      </div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '6px 0', borderBottom: '1px solid #F9FAFB' }}>
      <span style={{ fontSize: 12, color: '#6B7280' }}>{k}</span>
      <span style={{ fontSize: 13, color: '#111827', textAlign: 'right', fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', wordBreak: 'break-all' }}>{v}</span>
    </div>
  )
}

const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const cardHdr: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: '#0A1628', margin: '0 0 12px' }
