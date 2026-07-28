import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'

export const revalidate = 60

// ════════════════════════════════════════════════════════════════════════
//  /admin/traffic — where the clicks come from (owner spec 2026-07-28)
//
//  The owner pastes moveitclearit.com/m into Messenger all day, plus /fb,
//  /ig, /tt and /qr elsewhere. This page answers the question he actually
//  asked: which of those is worth the effort.
//
//  IT SHOWS CLICKS *AND* LEADS TOGETHER, because either number alone is
//  misleading. A channel with 200 clicks and 0 leads is not working — it
//  just looks busy. A channel with 9 clicks and 4 leads is the best thing
//  he has. The gap between the two columns IS the answer.
//
//  The join is campaign -> campaign (LinkClick.campaign = Lead.utmCampaign),
//  an aggregate-to-aggregate comparison. No click is ever tied to a person;
//  the click table holds no identity to tie (see schema.prisma).
// ════════════════════════════════════════════════════════════════════════

const RANGES = [7, 30, 90] as const
type Range = (typeof RANGES)[number]

/** Friendly names for the links the owner actually pastes. */
const CAMPAIGN_LABELS: Record<string, string> = {
  'fb-messenger': 'Messenger DMs',
  'fb-post': 'Facebook post',
  'ig-bio': 'Instagram',
  'tiktok-bio': 'TikTok',
  'print-doorhanger': 'Door hangers / QR',
}
const CAMPAIGN_LINKS: Record<string, string> = {
  'fb-messenger': '/m',
  'fb-post': '/fb',
  'ig-bio': '/ig',
  'tiktok-bio': '/tt',
  'print-doorhanger': '/qr',
}

const SOURCE_EMOJI: Record<string, string> = {
  facebook: '📘',
  instagram: '📸',
  tiktok: '🎵',
  print: '🚪',
  google: '🔍',
  direct: '↗️',
  other: '•',
}

export default async function AdminTraffic({
  searchParams,
}: {
  searchParams: { days?: string }
}) {
  await getSession()

  const days = (RANGES.includes(Number(searchParams.days) as Range)
    ? Number(searchParams.days)
    : 30) as Range
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Two grouped reads, then paired in memory. Cheap at this volume and far
  // easier to read than a raw SQL join across two unrelated tables.
  const [clickRows, leadRows, totalClicks, totalLeads] = await Promise.all([
    prisma.linkClick.groupBy({
      by: ['campaign', 'source'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ['utmCampaign'],
      where: { createdAt: { gte: since }, utmCampaign: { not: null } },
      _count: { _all: true },
    }),
    prisma.linkClick.count({ where: { createdAt: { gte: since } } }),
    prisma.lead.count({ where: { createdAt: { gte: since } } }),
  ])

  const leadsByCampaign = new Map<string, number>()
  for (const r of leadRows) {
    if (r.utmCampaign) leadsByCampaign.set(r.utmCampaign.toLowerCase(), r._count._all)
  }

  type Row = { campaign: string; source: string; clicks: number; leads: number; rate: number | null }
  const rows: Row[] = clickRows
    .map((r) => {
      const campaign = (r.campaign ?? '(untagged)').toLowerCase()
      const clicks = r._count._all
      const leads = leadsByCampaign.get(campaign) ?? 0
      return {
        campaign,
        source: r.source,
        clicks,
        leads,
        rate: clicks > 0 ? (leads / clicks) * 100 : null,
      }
    })
    .sort((a, b) => b.clicks - a.clicks)

  // Leads whose campaign never produced a click row — e.g. a lead from before
  // click tracking existed, or a tagged link opened with JS disabled. Shown so
  // the lead totals on this page always reconcile with the Leads page.
  const seen = new Set(rows.map((r) => r.campaign))
  // Array.from, not spread: this project's tsconfig targets below ES2015, so
  // spreading a Map iterator fails to compile (TS2802).
  const orphanLeads = Array.from(leadsByCampaign.entries())
    .filter(([c]) => !seen.has(c))
    .sort((a, b) => b[1] - a[1])

  const maxClicks = Math.max(1, ...rows.map((r) => r.clicks))

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, color: '#0A1628' }}>Traffic by channel</h1>
          <p style={{ margin: '6px 0 0', color: '#6B7280', fontSize: 14 }}>
            Where people came from, and how many of them actually asked for a price.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {RANGES.map((d) => (
            <Link
              key={d}
              href={`/admin/traffic?days=${d}`}
              style={{
                padding: '6px 14px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
                border: '1px solid ' + (d === days ? '#0A1628' : '#E5E7EB'),
                background: d === days ? '#0A1628' : '#fff',
                color: d === days ? '#fff' : '#374151',
              }}
            >
              {d} days
            </Link>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, margin: '20px 0 24px', flexWrap: 'wrap' }}>
        <Stat label="Clicks" value={totalClicks} hint="visits from a tagged link" />
        <Stat label="Leads" value={totalLeads} hint="all leads, tagged or not" />
      </div>

      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 640 }}>
            <thead>
              <tr>
                {['Channel', 'Clicks', 'Leads', 'Became a lead', ''].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: h === 'Channel' || h === '' ? 'left' : 'right',
                      padding: '10px 12px',
                      borderBottom: '2px solid #E5E7EB',
                      color: '#6B7280',
                      fontSize: 12,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.campaign + r.source}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <span style={{ marginRight: 8 }}>{SOURCE_EMOJI[r.source] ?? '•'}</span>
                    <strong style={{ color: '#0A1628' }}>{CAMPAIGN_LABELS[r.campaign] ?? r.campaign}</strong>
                    {CAMPAIGN_LINKS[r.campaign] && (
                      <span style={{ marginLeft: 8, color: '#9CA3AF', fontSize: 12 }}>
                        moveitclearit.com{CAMPAIGN_LINKS[r.campaign]}
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.clicks}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.leads}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {r.rate === null ? '—' : (
                      <span style={{ color: r.leads === 0 ? '#B91C1C' : r.rate >= 10 ? '#047857' : '#374151', fontWeight: 600 }}>
                        {r.rate.toFixed(r.rate < 10 ? 1 : 0)}%
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, width: '30%' }}>
                    <div style={{ background: '#F3F4F6', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                      <div style={{ width: `${(r.clicks / maxClicks) * 100}%`, background: '#FF5A1F', height: '100%' }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {orphanLeads.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 15, color: '#0A1628', margin: '0 0 4px' }}>Leads with no matching click</h2>
          <p style={{ margin: '0 0 10px', color: '#6B7280', fontSize: 13 }}>
            Tagged campaigns that produced leads but no recorded click — usually from before click
            tracking was switched on. Listed so these totals reconcile with the Leads page.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#374151', fontSize: 13 }}>
            {orphanLeads.map(([c, n]) => (
              <li key={c}>
                {CAMPAIGN_LABELS[c] ?? c} — {n} lead{n === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p style={{ marginTop: 28, color: '#9CA3AF', fontSize: 12, lineHeight: 1.6, maxWidth: 680 }}>
        A click is one visit, counted once per person per session — not page views. Leads are matched
        to a channel by campaign tag, so a lead only appears against a channel if the visitor arrived
        through one of the short links. Clicks are anonymous: no IP, cookie or identity is stored.
      </p>
    </div>
  )
}

const td: React.CSSProperties = {
  padding: '12px',
  borderBottom: '1px solid #F3F4F6',
  color: '#374151',
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div style={{ border: '1px solid #E5E7EB', borderRadius: 12, padding: '14px 20px', minWidth: 150 }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6B7280' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#0A1628', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#9CA3AF' }}>{hint}</div>
    </div>
  )
}

function Empty() {
  return (
    <div style={{ border: '1px dashed #D1D5DB', borderRadius: 12, padding: 28, color: '#6B7280', fontSize: 14, lineHeight: 1.7 }}>
      <strong style={{ color: '#0A1628' }}>No clicks recorded yet.</strong>
      <p style={{ margin: '8px 0 0' }}>
        Clicks appear here once the short links are live and someone taps one. Paste these instead of
        the plain website address:
      </p>
      <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
        <li><code>moveitclearit.com/m</code> — Messenger DMs</li>
        <li><code>moveitclearit.com/fb</code> — Facebook posts and comments</li>
        <li><code>moveitclearit.com/ig</code> — Instagram</li>
        <li><code>moveitclearit.com/tt</code> — TikTok</li>
        <li><code>moveitclearit.com/qr</code> — door hangers and the QR code</li>
      </ul>
    </div>
  )
}
