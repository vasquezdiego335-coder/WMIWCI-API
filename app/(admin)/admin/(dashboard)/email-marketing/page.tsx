// EMAIL MARKETING — OVERVIEW (owner spec 2026-07-21).
//
// The one screen that answers, at a glance: is email working, is anything
// stuck, and what is being refused. Every number links to the list it came
// from, because a count nobody can drill into is a number nobody trusts.

import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { getOverview, parseRange, webhookHealth, formatRate } from '@/lib/email-admin'
import { attributionByJourney } from '@/lib/email-attribution'
import { templateRegistry, journeyRegistry } from '@/lib/email-registry'
import { PageHeader, StatCard, StatGrid, Card, COLORS, Empty, Callout, tableStyles as T } from '../_ui'
import { EmailTabs, RangePicker, ToneBadge, CompletenessNote, money, dt } from './_shared'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

export default async function EmailOverviewPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const maySeeMoney = can(session?.role as never, 'email.view_attribution')

  const range = parseRange(searchParams.range as string | undefined)

  const [overview, health, attribution] = await Promise.all([
    getOverview(range),
    webhookHealth(),
    maySeeMoney ? attributionByJourney(range) : Promise.resolve({ rows: [], error: null }),
  ])

  const templates = templateRegistry()
  const journeys = journeyRegistry()
  const activeJourneys = journeys.filter((j) => j.enabled)

  const attributedProfit = attribution.rows.reduce((n, r) => n + r.finalizedNetProfitCents, 0)
  const attributedRevenue = attribution.rows.reduce((n, r) => n + r.netCollectedRevenueCents, 0)

  return (
    <div>
      <PageHeader
        title="Email Marketing"
        subtitle="Every customer email this business sends — what fired it, who got it, and what it produced."
        actions={<RangePicker base="/admin/email-marketing" active={range} />}
      />
      <EmailTabs active="/admin/email-marketing" isOwner={isOwner} />

      {overview.unfinishedSideEffects > 0 && (
        <Callout tone="danger" title={`${overview.unfinishedSideEffects} suppression side effect${overview.unfinishedSideEffects === 1 ? '' : 's'} never completed`}>
          A bounce or complaint was recorded but the address was NOT added to the suppression list, so it can still be
          mailed. This number must be zero.{' '}
          <Link href="/admin/email-marketing/deliverability" style={{ color: COLORS.orange }}>
            Open Deliverability →
          </Link>
        </Callout>
      )}

      {!health.configured && (
        <Callout tone="warning" title="Provider webhook is not configured">
          RESEND_WEBHOOK_SECRET is unset, so <strong>no bounce or complaint is ever processed</strong>. Delivery,
          bounce and complaint rates below will stay empty regardless of how much mail is sent.
        </Callout>
      )}

      {overview.ambiguous > 0 && (
        <Callout tone="warning" title={`${overview.ambiguous} send${overview.ambiguous === 1 ? '' : 's'} with an unknown outcome`}>
          The request reached the provider but the result was never confirmed. These are deliberately never re-sent
          automatically — reconcile them against the Resend dashboard.{' '}
          <Link href="/admin/email-marketing/sends?status=ambiguous" style={{ color: COLORS.orange }}>
            Review them →
          </Link>
        </Callout>
      )}

      <StatGrid>
        <StatCard label="Accepted by provider" value={String(overview.sent)} href={`/admin/email-marketing/sends?range=${range}&status=delivered`} sub={overview.rangeLabel} />
        <StatCard label="Confirmed delivered" value={String(overview.confirmedDelivered)} accent={COLORS.green} sub={`Delivery rate ${formatRate(overview.deliveryRate)}`} />
        <StatCard label="Blocked" value={String(overview.blocked)} accent={overview.blocked > 0 ? COLORS.amber : undefined} href={`/admin/email-marketing/sends?range=${range}&blocked=1`} sub="With a recorded reason" />
        <StatCard label="Deferred" value={String(overview.deferred)} sub="Caps, quiet hours — will retry" href={`/admin/email-marketing/sends?range=${range}&status=deferred`} />
        <StatCard label="Bounced" value={String(overview.bounced)} accent={overview.bounced > 0 ? COLORS.red : undefined} sub={`Bounce rate ${formatRate(overview.bounceRate)}`} />
        <StatCard label="Complaints" value={String(overview.complained)} accent={overview.complained > 0 ? COLORS.red : undefined} sub={`Complaint rate ${formatRate(overview.complaintRate)}`} />
        <StatCard label="Unsubscribes" value={String(overview.unsubscribed)} href="/admin/email-marketing/suppressions?reason=UNSUBSCRIBED" sub="Promotional only" />
        <StatCard label="Failed" value={String(overview.failed)} accent={overview.failed > 0 ? COLORS.red : undefined} sub="Attempts exhausted" href={`/admin/email-marketing/sends?range=${range}&status=failed_terminal`} />
      </StatGrid>

      <CompletenessNote notes={overview.notes} degraded={overview.degraded} />

      {maySeeMoney && (
        <StatGrid min={220}>
          <StatCard label="Attributed collected revenue" value={money(attributedRevenue)} accent={COLORS.navy} sub="On moves credited to an email journey" />
          <StatCard label="Attributed finalized profit" value={money(attributedProfit)} accent={COLORS.gold} sub="Financially closed-out moves only" />
          <StatCard label="Active journeys" value={`${activeJourneys.length} of ${journeys.length}`} sub="Flag-enabled in this environment" href="/admin/email-marketing/journeys" />
          <StatCard label="Templates" value={String(templates.length)} sub="Registered and reachable" href="/admin/email-marketing/templates" />
        </StatGrid>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '18px' }}>
        <Card title="Why email was not sent" icon="🚧">
          {overview.topBlockReasons.length === 0 ? (
            <Empty>Nothing was refused in this window.</Empty>
          ) : (
            <div style={T.scroll}>
              <table style={T.table}>
                <thead>
                  <tr>
                    <th style={T.th}>Reason</th>
                    <th style={T.th}>Kind</th>
                    <th style={{ ...T.th, textAlign: 'right' }}>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.topBlockReasons.map((r) => (
                    <tr key={r.reason}>
                      <td style={{ ...T.td, fontFamily: 'ui-monospace, monospace', fontSize: '12px' }}>{r.reason}</td>
                      <td style={T.td}>
                        <ToneBadge tone={r.blockClass === 'terminal' ? 'muted' : r.blockClass === 'deferred' ? 'warn' : 'bad'}>
                          {r.blockClass}
                        </ToneBadge>
                      </td>
                      <td style={{ ...T.td, textAlign: 'right', fontWeight: 700 }}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ fontSize: '11px', color: COLORS.faint, margin: '12px 0 0', lineHeight: 1.5 }}>
            <strong>terminal</strong> will never be retried. <strong>deferred</strong> is a timing hold and will send
            later. <strong>retryable</strong> is usually a configuration gap worth fixing.
          </p>
        </Card>

        <Card title="Most active templates" icon="✉️">
          {overview.byTemplate.length === 0 ? (
            <Empty>No email activity in this window.</Empty>
          ) : (
            <div style={T.scroll}>
              <table style={T.table}>
                <thead>
                  <tr>
                    <th style={T.th}>Template</th>
                    <th style={{ ...T.th, textAlign: 'right' }}>Attempted</th>
                    <th style={{ ...T.th, textAlign: 'right' }}>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.byTemplate.slice(0, 10).map((t) => (
                    <tr key={t.template}>
                      <td style={T.td}>
                        <Link href={`/admin/email-marketing/sends?range=${range}&template=${encodeURIComponent(t.template)}`} style={{ color: COLORS.navy, textDecoration: 'none', fontWeight: 600 }}>
                          {t.label}
                        </Link>
                      </td>
                      <td style={{ ...T.td, textAlign: 'right' }}>{t.total}</td>
                      <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, color: t.sent > 0 ? COLORS.green : COLORS.faint }}>{t.sent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: '18px' }}>
        <Card title="Provider health" icon="📡" wide>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
            <Fact label="Webhook secret" value={health.configured ? 'Configured' : 'MISSING'} tone={health.configured ? 'good' : 'bad'} />
            <Fact label="Last provider event" value={dt(health.lastEventAt)} tone={health.lastEventAt ? 'good' : 'warn'} />
            <Fact label="Events (7 days)" value={String(health.eventsLast7d)} tone={health.eventsLast7d > 0 ? 'good' : 'muted'} />
            <Fact label="Pending side effects" value={String(health.pendingSideEffects)} tone={health.pendingSideEffects > 0 ? 'bad' : 'good'} />
            <Fact label="Dead-lettered events" value={String(health.deadLettered)} tone={health.deadLettered > 0 ? 'bad' : 'good'} />
          </div>
          {health.error && (
            <p style={{ fontSize: '12px', color: COLORS.red, margin: '12px 0 0' }}>Could not read provider events: {health.error}</p>
          )}
        </Card>
      </div>
    </div>
  )
}

function Fact({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: COLORS.faint, margin: '0 0 5px' }}>{label}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <ToneBadge tone={tone}>{value}</ToneBadge>
      </div>
    </div>
  )
}
