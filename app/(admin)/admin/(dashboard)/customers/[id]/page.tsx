// CUSTOMER EMAIL TIMELINE (owner spec 2026-07-21).
//
// The question this page exists to answer, end to end:
//
//   What has this customer received? Why did they receive it? What was blocked
//   and why? What did they engage with? Did any email lead to a booking, and
//   did that booking produce collected revenue and finalized profit?
//
// It joins the customer's LEADS and BOOKINGS to the send guard's own ledger, so
// refusals sit beside deliveries. A timeline that showed only what was sent
// could not answer half the question.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { prisma } from '@/lib/db'
import { emailTimeline, statusTone, eventTone, displayEmail, explainSend } from '@/lib/email-admin'
import { templateLabel } from '@/lib/email-registry'
import { CAPTURED_PAYMENT_WHERE, netCollectedCentsOf, type PaymentRow } from '@/lib/money-rules'
import { PageHeader, Card, COLORS, Empty, SoftBadge, StatCard, StatGrid, tableStyles as T } from '../../_ui'
import { money, dt } from '../../email-marketing/_shared'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

const TONES: Record<string, string> = { good: COLORS.green, warn: COLORS.amber, bad: COLORS.red, muted: COLORS.faint }

export default async function CustomerDetail({ params, searchParams }: { params: { id: string }; searchParams: SP }) {
  const session = await getSession()
  const maySeeRecipients = can(session?.role as never, 'email.view_recipients')
  const maySeeMoney = can(session?.role as never, 'email.view_attribution')

  const customer = await prisma.customer.findUnique({
    where: { id: params.id },
    include: {
      bookings: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, displayId: true, status: true, createdAt: true, completedAt: true, isInternalTest: true },
      },
    },
  })
  if (!customer) notFound()

  const bookingIds = customer.bookings.map((b) => b.id)

  const [leads, timeline, payments, snapshots] = await Promise.all([
    prisma.lead.findMany({ where: { email: customer.email }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, createdAt: true, quotedAt: true, convertedBookingId: true } }),
    emailTimeline({ email: customer.email, take: 200 }),
    maySeeMoney && bookingIds.length
      ? prisma.payment.findMany({
          where: { bookingId: { in: bookingIds }, ...CAPTURED_PAYMENT_WHERE, isInternalTest: false },
          select: { amount: true, status: true, isInternalTest: true, refundedAmountCents: true, stripeDisputeId: true, disputeStatus: true },
        })
      : Promise.resolve([]),
    maySeeMoney && bookingIds.length
      ? prisma.financialSnapshot.findMany({ where: { bookingId: { in: bookingIds }, supersededAt: null }, select: { bookingId: true, companyNetProfitCents: true } })
      : Promise.resolve([]),
  ])

  const collected = payments.reduce((n, p) => n + netCollectedCentsOf(p as unknown as PaymentRow), 0)
  const finalized = snapshots.reduce((n, s) => n + s.companyNetProfitCents, 0)

  // ── Filters (plain links, no JavaScript required) ──
  const fTemplate = (searchParams.template as string) || ''
  const fStatus = (searchParams.status as string) || ''
  const fJourney = (searchParams.journey as string) || ''
  const fBooking = (searchParams.booking as string) || ''

  let rows = timeline.rows
  if (fTemplate) rows = rows.filter((r) => r.template === fTemplate)
  if (fStatus) rows = rows.filter((r) => r.status === fStatus)
  if (fJourney) rows = rows.filter((r) => r.journey === fJourney)

  const templates = Array.from(new Set(timeline.rows.map((r) => r.template)))
  const statuses = Array.from(new Set(timeline.rows.map((r) => r.status)))
  const journeys = Array.from(new Set(timeline.rows.map((r) => r.journey).filter((v): v is string => Boolean(v))))

  const qs = (patch: Record<string, string>) => {
    const p = new URLSearchParams()
    const merged = { template: fTemplate, status: fStatus, journey: fJourney, booking: fBooking, ...patch }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    const q = p.toString()
    return `/admin/customers/${customer.id}${q ? `?${q}` : ''}`
  }

  const delivered = timeline.rows.filter((r) => r.status === 'delivered').length
  const blocked = timeline.rows.length - delivered

  return (
    <div>
      <PageHeader
        title={customer.name}
        subtitle={`${displayEmail(customer.email, maySeeRecipients)} · ${customer.bookings.length} booking${customer.bookings.length === 1 ? '' : 's'} · ${leads.length} lead${leads.length === 1 ? '' : 's'}`}
        actions={
          <Link href="/admin/customers" style={{ fontSize: '13px', color: COLORS.muted, textDecoration: 'none' }}>
            ← All customers
          </Link>
        }
      />

      <StatGrid min={190}>
        <StatCard label="Emails delivered" value={String(delivered)} accent={COLORS.green} />
        <StatCard label="Not sent" value={String(blocked)} accent={blocked > 0 ? COLORS.amber : undefined} sub="With a recorded reason" />
        <StatCard label="Bookings" value={String(customer.bookings.filter((b) => !b.isInternalTest).length)} />
        {maySeeMoney && <StatCard label="Collected revenue" value={money(collected)} accent={COLORS.navy} />}
        {maySeeMoney && <StatCard label="Finalized profit" value={money(finalized)} accent={COLORS.gold} sub={`${snapshots.length} closed-out move${snapshots.length === 1 ? '' : 's'}`} />}
      </StatGrid>

      {maySeeMoney && snapshots.length < customer.bookings.filter((b) => b.status === 'COMPLETED').length && (
        <p style={{ fontSize: '12px', color: COLORS.amber, marginBottom: '16px' }}>
          Some completed moves are not financially finalized, so their profit is not counted above.
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '18px', marginBottom: '18px' }}>
        <Card title={`Bookings (${customer.bookings.length})`} icon="📦">
          {customer.bookings.length === 0 ? <Empty>No bookings.</Empty> : customer.bookings.map((b) => (
            <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '7px 0', borderBottom: `1px solid ${COLORS.line}` }}>
              <Link href={`/admin/jobs/${b.id}`} style={{ fontSize: '13px', color: COLORS.navy, fontWeight: 600, textDecoration: 'none' }}>
                {b.displayId}
              </Link>
              <SoftBadge color={b.status === 'COMPLETED' ? COLORS.green : b.status === 'CANCELLED' ? COLORS.red : COLORS.blue}>{b.status}</SoftBadge>
            </div>
          ))}
        </Card>

        <Card title={`Leads (${leads.length})`} icon="📈">
          {leads.length === 0 ? <Empty>No leads recorded for this address.</Empty> : leads.map((l) => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '7px 0', borderBottom: `1px solid ${COLORS.line}` }}>
              <span style={{ fontSize: '12px', color: COLORS.muted }}>
                {dt(l.createdAt)}
                {l.quotedAt ? ' · quoted' : ''}
                {l.convertedBookingId ? ' · converted' : ''}
              </span>
              <SoftBadge color={l.convertedBookingId ? COLORS.green : COLORS.faint}>{l.status}</SoftBadge>
            </div>
          ))}
        </Card>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px', alignItems: 'center' }}>
        <Chip href={qs({ template: '', status: '', journey: '' })} on={!fTemplate && !fStatus && !fJourney}>All</Chip>
        {statuses.map((s) => <Chip key={s} href={qs({ status: fStatus === s ? '' : s })} on={fStatus === s}>{s}</Chip>)}
        {journeys.map((j) => <Chip key={j} href={qs({ journey: fJourney === j ? '' : j })} on={fJourney === j}>{j}</Chip>)}
        {templates.slice(0, 8).map((t) => <Chip key={t} href={qs({ template: fTemplate === t ? '' : t })} on={fTemplate === t}>{templateLabel(t)}</Chip>)}
      </div>

      <Card title={`Email timeline (${rows.length})`} icon="📬" wide>
        {timeline.error && <p style={{ fontSize: '12px', color: COLORS.red }}>Could not read the email ledger: {timeline.error}</p>}
        {!timeline.error && rows.length === 0 && <Empty>No email matches these filters.</Empty>}

        {rows.length > 0 && (
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  <th style={T.th}>When</th>
                  <th style={T.th}>Email</th>
                  <th style={T.th}>Journey</th>
                  <th style={T.th}>Status</th>
                  <th style={T.th}>Engagement</th>
                  <th style={T.th}>What happened</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...T.td, whiteSpace: 'nowrap' }}>
                      {dt(r.sentAt ?? r.createdAt)}
                      {!r.sentAt && <div style={{ fontSize: '10px', color: COLORS.faint }}>attempted</div>}
                    </td>
                    <td style={T.td}>
                      <Link href={`/admin/email-marketing/templates/${encodeURIComponent(r.template)}`} style={{ color: COLORS.navy, fontWeight: 600, textDecoration: 'none' }}>
                        {r.label}
                      </Link>
                      <div style={{ fontSize: '10px', color: COLORS.faint, marginTop: '3px' }}>{displayEmail(r.email, maySeeRecipients)}</div>
                    </td>
                    <td style={{ ...T.td, fontSize: '11px', color: COLORS.muted }}>{r.journey ?? '—'}</td>
                    <td style={T.td}>
                      <SoftBadge color={TONES[statusTone(r.status)]}>{r.status}</SoftBadge>
                    </td>
                    <td style={T.td}>
                      {r.events.length === 0 ? (
                        <span style={{ fontSize: '11px', color: COLORS.faint }}>—</span>
                      ) : (
                        <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {r.events.map((e, i) => <SoftBadge key={i} color={TONES[eventTone(e.type)]}>{e.type}</SoftBadge>)}
                        </span>
                      )}
                    </td>
                    <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted, maxWidth: '380px' }}>
                      {r.status === 'delivered' ? 'Accepted by the email provider.' : explainSend(r.status, r.blockedReason, r.nextAttemptAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ marginTop: '18px', padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        Open and click events appear only when the provider records them. An empty engagement column can mean the
        customer did not open the email <em>or</em> that tracking is not enabled — it is not evidence of either.
        {!maySeeMoney && <><br /><br />Revenue and profit attribution are limited to owners.</>}
      </div>
    </div>
  )
}

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        fontSize: '11px', fontWeight: on ? 700 : 500, padding: '5px 10px', borderRadius: '7px', textDecoration: 'none',
        color: on ? '#FFFFFF' : COLORS.muted, backgroundColor: on ? COLORS.navy : '#F3F4F6',
      }}
    >
      {children}
    </Link>
  )
}
