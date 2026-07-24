import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'
import type { Prisma } from '@prisma/client'

export const revalidate = 30

// ════════════════════════════════════════════════════════════════════════
//  /admin/leads — the Leads inbox (owner spec 2026-07-24).
//  Shows CRM leads AND self-captured PARTIAL booking leads together, with a
//  clear "Partial" badge so a partial lead is NEVER presented as a confirmed
//  booking. Read + filter view (server component + direct Prisma, mirroring
//  /admin/customers). Consent + suppression status are surfaced so promotional
//  audiences can be reasoned about at a glance.
// ════════════════════════════════════════════════════════════════════════

type View = 'all' | 'partial' | 'converted' | 'abandoned' | 'opted_in' | 'no_consent' | 'door_hanger' | 'referral'

const PARTIAL_LIFECYCLES = ['PARTIAL', 'IN_PROGRESS', 'ABANDONED'] as const

export default async function AdminLeads({
  searchParams,
}: {
  searchParams: { q?: string; view?: string; campaign?: string; from?: string; to?: string; page?: string }
}) {
  await getSession()

  const q = (searchParams.q ?? '').trim()
  const view = (searchParams.view ?? 'all') as View
  const campaign = (searchParams.campaign ?? '').trim()
  const from = searchParams.from ?? ''
  const to = searchParams.to ?? ''
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  const where: Prisma.LeadWhereInput = {}
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
    ]
  }
  if (campaign) where.utmCampaign = { contains: campaign, mode: 'insensitive' }
  if (from || to) {
    where.createdAt = {}
    if (from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(from + 'T00:00:00')
    if (to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(to + 'T23:59:59')
  }
  switch (view) {
    case 'partial': where.lifecycle = { in: [...PARTIAL_LIFECYCLES] }; break
    case 'converted': where.lifecycle = 'CONVERTED'; break
    case 'abandoned': where.lifecycle = 'ABANDONED'; break
    case 'opted_in': where.emailMarketingConsent = true; break
    case 'no_consent': where.emailMarketingConsent = { not: true }; break
    case 'door_hanger': where.source = 'DOOR_HANGER'; break
    case 'referral': where.source = 'REFERRAL'; break
  }

  const PER = 25
  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: { lastActivityAt: { sort: 'desc', nulls: 'last' } },
      skip: (page - 1) * PER,
      take: PER,
      select: {
        id: true, name: true, email: true, phone: true, source: true, status: true, lifecycle: true,
        formStep: true, utmCampaign: true, referrer: true, estimatedValue: true, convertedBookingId: true,
        emailMarketingConsent: true, lastActivityAt: true, createdAt: true,
      },
    }),
    prisma.lead.count({ where }),
  ])

  // Suppression status for the emails on THIS page (one query, then map).
  const emails = leads.map((l) => l.email).filter((e): e is string => !!e)
  const suppressions = emails.length
    ? await prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true, reason: true, scope: true } })
    : []
  const suppByEmail = new Map(suppressions.map((s) => [s.email, s]))

  const pages = Math.ceil(total / PER)
  const counts = await leadCounts()

  return (
    <div>
      <h1 style={h1}>Leads</h1>
      <p style={subtitle}>
        {total.toLocaleString()} shown · {counts.partial.toLocaleString()} partial booking lead{counts.partial === 1 ? '' : 's'} · {counts.optedIn.toLocaleString()} opted in to marketing
      </p>

      {/* Views */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {([
          ['all', 'All'], ['partial', 'Partial booking'], ['converted', 'Converted'], ['abandoned', 'Abandoned'],
          ['opted_in', 'Opted in'], ['no_consent', 'No consent'], ['door_hanger', 'Door hanger'], ['referral', 'Referral'],
        ] as [View, string][]).map(([v, label]) => (
          <Link key={v} href={`/admin/leads?view=${v}`} style={{ ...chip, ...(view === v ? chipActive : {}) }}>{label}</Link>
        ))}
      </div>

      {/* Search + campaign + date range */}
      <div style={filterBar}>
        <form method="GET" style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="hidden" name="view" value={view} />
          <input name="q" defaultValue={q} placeholder="Search name, email, phone…" style={searchInput} />
          <input name="campaign" defaultValue={campaign} placeholder="Campaign…" style={{ ...searchInput, minWidth: '160px' }} />
          <label style={dateLabel}>From <input type="date" name="from" defaultValue={from} style={dateInput} /></label>
          <label style={dateLabel}>To <input type="date" name="to" defaultValue={to} style={dateInput} /></label>
          <button type="submit" style={filterBtn}>Filter</button>
          {(q || campaign || from || to) && <Link href={`/admin/leads?view=${view}`} style={{ fontSize: '13px', color: '#6B7280' }}>Clear</Link>}
        </form>
      </div>

      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {['Lead', 'Phone', 'Step', 'Source', 'Campaign', 'Status', 'Marketing', 'Est. value', 'Last activity'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 ? (
              <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: '#9CA3AF', fontStyle: 'italic', padding: '40px' }}>No leads found.</td></tr>
            ) : leads.map((l) => {
              const supp = l.email ? suppByEmail.get(l.email) : undefined
              return (
                <tr key={l.id} style={tr}>
                  <td style={td}>
                    <div style={{ fontWeight: 500, color: '#0A1628' }}>{l.name}</div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{l.email ?? '—'}</div>
                  </td>
                  <td style={td}>{l.phone ?? '—'}</td>
                  <td style={td}>{l.formStep ? l.formStep.replace(/^card/, 'Step ') : '—'}</td>
                  <td style={td}>{(l.source ?? 'OTHER').replace(/_/g, ' ').toLowerCase()}</td>
                  <td style={td}>{l.utmCampaign ?? '—'}</td>
                  <td style={td}>{statusBadge(l.lifecycle, l.status, l.convertedBookingId)}</td>
                  <td style={td}>{marketingBadge(l.emailMarketingConsent, supp)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{typeof l.estimatedValue === 'number' ? `$${Math.round(l.estimatedValue / 100).toLocaleString()}` : '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontSize: '12px' }}>
                    {(l.lastActivityAt ?? l.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '24px', flexWrap: 'wrap' }}>
          {Array.from({ length: Math.min(pages, 20) }, (_, i) => i + 1).map((p) => (
            <Link key={p} href={`/admin/leads?view=${view}&q=${encodeURIComponent(q)}&campaign=${encodeURIComponent(campaign)}&from=${from}&to=${to}&page=${p}`}
              style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '13px', fontWeight: p === page ? 700 : 400, backgroundColor: p === page ? '#FF5A1F' : '#FFFFFF', color: p === page ? '#FFFFFF' : '#374151', textDecoration: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

async function leadCounts() {
  const [partial, optedIn] = await Promise.all([
    prisma.lead.count({ where: { lifecycle: { in: [...PARTIAL_LIFECYCLES] } } }),
    prisma.lead.count({ where: { emailMarketingConsent: true } }),
  ])
  return { partial, optedIn }
}

function statusBadge(lifecycle: string | null, status: string, convertedBookingId: string | null) {
  if (lifecycle === 'CONVERTED' || convertedBookingId) {
    const inner = <span style={{ ...badge, background: '#DCFCE7', color: '#166534' }}>Converted</span>
    return convertedBookingId ? <Link href={`/admin/jobs/${convertedBookingId}`} style={{ textDecoration: 'none' }}>{inner}</Link> : inner
  }
  if (lifecycle && (PARTIAL_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    const label = lifecycle === 'ABANDONED' ? 'Abandoned' : 'Partial'
    return <span style={{ ...badge, background: '#FEF3C7', color: '#92400E' }}>{label}</span>
  }
  return <span style={{ ...badge, background: '#EFF2F6', color: '#475569' }}>{status.replace(/_/g, ' ').toLowerCase()}</span>
}

function marketingBadge(consent: boolean | null, supp?: { reason: string; scope: string }) {
  if (supp) {
    const label = supp.reason === 'UNSUBSCRIBED' ? 'Unsubscribed' : 'Suppressed'
    return <span style={{ ...badge, background: '#FEE2E2', color: '#991B1B' }} title={`${supp.reason} (${supp.scope})`}>{label}</span>
  }
  if (consent === true) return <span style={{ ...badge, background: '#DBEAFE', color: '#1E40AF' }}>Opted in</span>
  return <span style={{ fontSize: '12px', color: '#9CA3AF' }}>—</span>
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: 700, color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0 0 20px' }
const chip: React.CSSProperties = { padding: '6px 12px', borderRadius: '100px', fontSize: '12.5px', fontWeight: 600, color: '#475569', background: '#FFFFFF', textDecoration: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
const chipActive: React.CSSProperties = { background: '#0A1628', color: '#FFFFFF' }
const filterBar: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '14px 16px', marginBottom: '18px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const searchInput: React.CSSProperties = { padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', minWidth: '220px', outline: 'none' }
const dateLabel: React.CSSProperties = { fontSize: '12px', color: '#6B7280', display: 'flex', gap: '6px', alignItems: 'center' }
const dateInput: React.CSSProperties = { padding: '6px 8px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '12px', outline: 'none' }
const filterBtn: React.CSSProperties = { padding: '8px 20px', backgroundColor: '#FF5A1F', color: '#FFFFFF', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflowX: 'auto', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const badge: React.CSSProperties = { fontSize: '11px', padding: '3px 8px', borderRadius: '100px', fontWeight: 600, whiteSpace: 'nowrap' }
