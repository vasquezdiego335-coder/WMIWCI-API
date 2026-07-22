// EMAIL CAMPAIGN ATTRIBUTION (owner spec 2026-07-21).
//
// Owner-only: this page ends in FINALIZED COMPANY NET PROFIT.
//
// It deliberately builds NO second attribution system. An EMAIL campaign is a
// MarketingCampaign with channel=EMAIL, and its bookings are found through the
// SAME Stage 3 source fields a door hanger uses. Campaign creation lives on the
// existing Marketing Campaigns admin — duplicating it here would create two
// records of the same thing.

import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { emailCampaignResults } from '@/lib/email-attribution'
import { parseRange } from '@/lib/email-admin'
import { prisma } from '@/lib/db'
import { templateRegistry } from '@/lib/email-registry'
import { allowedTransitions, type CampaignState } from '@/lib/email-campaign'
import CampaignComposer from './CampaignComposer'
import { PageHeader, Card, COLORS, Empty, tableStyles as T, SoftBadge } from '../../_ui'
import { EmailTabs, RangePicker, money } from '../_shared'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>

export default async function EmailCampaignsPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  if (!can(session?.role as never, 'email.view_attribution')) {
    return (
      <div>
        <PageHeader title="Email campaigns" />
        <EmailTabs active="/admin/email-marketing/campaigns" isOwner={isOwner} />
        <Card>
          <Empty>Campaign financial results are limited to owners.</Empty>
        </Card>
      </div>
    )
  }

  const range = parseRange(searchParams.range as string | undefined)
  const { rows, error } = await emailCampaignResults(range)

  // Composer inputs. Only PROMOTIONAL templates can be broadcast: a
  // transactional template states a fact about one specific booking.
  const templates = templateRegistry()
    .filter((t) => t.emailClass === 'promotional')
    .map((t) => ({ key: t.key, name: t.name }))

  let audiences: Array<{ id: string; name: string }> = []
  let manageRows: React.ComponentProps<typeof CampaignComposer>['campaigns'] = []
  let manageError: string | null = null
  try {
    const [aud, camps] = await Promise.all([
      prisma.emailAudience.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      prisma.marketingCampaign.findMany({
        where: { channel: 'EMAIL' },
        orderBy: { createdAt: 'desc' },
        include: {
          emailConfig: { include: { audience: { select: { name: true } } } },
          // Execution truth: recent runs, with recipient counts joined below.
          emailRuns: { orderBy: { startedAt: 'desc' }, take: 2 },
        },
      }),
    ])
    audiences = aud
    const runIds = camps.flatMap((c) => c.emailRuns.map((r) => r.id))
    const recipientGroups = runIds.length
      ? await prisma.emailCampaignRecipient.groupBy({ by: ['runId', 'status'], where: { runId: { in: runIds } }, _count: { _all: true } })
      : []
    const countsByRun = new Map<string, Record<string, number>>()
    for (const g of recipientGroups) {
      const entry = countsByRun.get(g.runId) ?? {}
      entry[g.status] = g._count._all
      countsByRun.set(g.runId, entry)
    }
    manageRows = camps.map((c) => ({
      id: c.id,
      name: c.name,
      sourceKey: c.sourceKey,
      status: c.status,
      allowedTransitions: allowedTransitions(c.status as CampaignState),
      template: c.emailConfig?.template ?? null,
      audienceName: c.emailConfig?.audience?.name ?? null,
      scheduledAt: c.emailConfig?.scheduledAt ? c.emailConfig.scheduledAt.toISOString() : null,
      approvedByName: c.emailConfig?.approvedByName ?? null,
      approvedAt: c.emailConfig?.approvedAt ? c.emailConfig.approvedAt.toISOString() : null,
      statusNote: c.emailConfig?.statusNote ?? null,
      validation: (c.emailConfig?.validation ?? null) as never,
      runs: c.emailRuns.map((r) => ({
        id: r.id,
        status: r.status,
        totalRecipients: r.totalRecipients,
        sentCount: r.sentCount,
        skippedCount: r.skippedCount,
        failedCount: r.failedCount,
        cancelledCount: r.cancelledCount,
        recipientCounts: countsByRun.get(r.id) ?? {},
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        error: r.error,
      })),
    }))
  } catch (err) {
    manageError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div>
      <PageHeader
        title="Email campaigns"
        subtitle="Email → booking → collected revenue → finalized profit. A campaign is judged by money, never by opens."
        actions={<RangePicker base="/admin/email-marketing/campaigns" active={range} />}
      />
      <EmailTabs active="/admin/email-marketing/campaigns" isOwner={isOwner} />

      <div style={{ marginBottom: '20px' }}>
        <CampaignComposer
          templates={templates}
          audiences={audiences}
          campaigns={manageRows}
          promotionsEnabled={process.env.EMAIL_PROMOTIONS_ENABLED === 'true'}
        />
        {manageError && (
          <p style={{ fontSize: '12px', color: COLORS.red, marginTop: '10px' }}>Campaign management unavailable: {manageError}</p>
        )}
      </div>

      <Card wide>
        {error && <p style={{ fontSize: '13px', color: COLORS.red }}>Could not read campaign results: {error}</p>}
        {!error && rows.length === 0 && (
          <Empty>
            No campaigns with channel EMAIL exist yet. Create one on the{' '}
            <Link href="/admin/reports/marketing" style={{ color: COLORS.orange }}>
              Marketing report
            </Link>{' '}
            — campaigns are managed there so there is only one campaign record in the business.
          </Empty>
        )}
        {rows.length > 0 && (
          <div style={T.scroll}>
            <table style={T.table}>
              <thead>
                <tr>
                  <th style={T.th}>Campaign</th>
                  <th style={T.th}>Status</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Delivered</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Clicked</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Bookings</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Collected revenue</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Finalized profit</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Spend</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Contribution</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.campaignId}>
                    <td style={T.td}>
                      <strong style={{ color: COLORS.navy }}>{c.name}</strong>
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: COLORS.faint, marginTop: '3px' }}>
                        {c.sourceKey}
                      </div>
                      {c.caveat && (
                        <div style={{ fontSize: '11px', color: COLORS.amber, marginTop: '5px', maxWidth: '260px', lineHeight: 1.4 }}>
                          {c.caveat}
                        </div>
                      )}
                    </td>
                    <td style={T.td}>
                      <SoftBadge color={c.status === 'ACTIVE' ? COLORS.green : COLORS.faint}>{c.status}</SoftBadge>
                    </td>
                    <td style={{ ...T.td, textAlign: 'right' }}>{c.emailsDelivered}</td>
                    <td style={{ ...T.td, textAlign: 'right' }}>{c.clicked > 0 ? c.clicked : '—'}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700 }}>{c.bookings}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(c.netCollectedRevenueCents)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, color: COLORS.gold, fontVariantNumeric: 'tabular-nums' }}>
                      {money(c.finalizedNetProfitCents)}
                    </td>
                    <td style={{ ...T.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(c.spendCents)}</td>
                    <td
                      style={{
                        ...T.td,
                        textAlign: 'right',
                        fontWeight: 800,
                        fontVariantNumeric: 'tabular-nums',
                        color: c.contributionCents > 0 ? COLORS.green : c.contributionCents < 0 ? COLORS.red : COLORS.ink,
                      }}
                    >
                      {money(c.contributionCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ marginTop: '18px', padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        <strong style={{ color: COLORS.ink }}>Finalized profit</strong> counts only moves with a current financial
        snapshot. A move that completed but has not been closed out contributes nothing here and is named in the caveat
        column — uncollected revenue is never reported as profit, and provisional profit is never reported as finalized.
        <br />
        <br />
        <strong style={{ color: COLORS.ink }}>Contribution</strong> = finalized profit − campaign spend.
      </div>
    </div>
  )
}
