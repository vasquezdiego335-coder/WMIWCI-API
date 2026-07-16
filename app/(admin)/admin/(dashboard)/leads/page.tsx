import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Prisma, LeadStatus } from '@prisma/client'
import Link from 'next/link'

export const revalidate = 0

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  NEW: { bg: '#DBEAFE', fg: '#1E40AF' },
  CONTACTED: { bg: '#E0E7FF', fg: '#3730A3' },
  QUOTE_SENT: { bg: '#FEF3C7', fg: '#92400E' },
  FOLLOW_UP: { bg: '#FEF9C3', fg: '#854D0E' },
  BOOKED: { bg: '#DCFCE7', fg: '#166534' },
  LOST: { bg: '#F3F4F6', fg: '#6B7280' },
  SPAM: { bg: '#FEE2E2', fg: '#991B1B' },
}
const ALL_STATUSES = Object.values(LeadStatus)
const et = (d: Date) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })

export default async function AdminLeads({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; archived?: string; page?: string }
}) {
  await getSession()

  const q = (searchParams.q ?? '').trim()
  const status = ALL_STATUSES.includes(searchParams.status as LeadStatus) ? (searchParams.status as LeadStatus) : undefined
  const showArchived = searchParams.archived === '1'
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  const where: Prisma.LeadWhereInput = {
    ...(showArchived ? {} : { archivedAt: null }),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { notes: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [leads, total, newCount] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * 25,
      take: 25,
    }),
    prisma.lead.count({ where }),
    prisma.lead.count({ where: { status: 'NEW', archivedAt: null } }),
  ])
  const pages = Math.ceil(total / 25)

  const qs = (over: Record<string, string | undefined>) => {
    const sp = new URLSearchParams()
    const merged = { q: q || undefined, status: status || undefined, archived: showArchived ? '1' : undefined, ...over }
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, v)
    const s = sp.toString()
    return `/admin/leads${s ? `?${s}` : ''}`
  }

  return (
    <div>
      <h1 style={h1}>Leads</h1>
      <p style={subtitle}>{total} lead{total === 1 ? '' : 's'}{status ? ` · ${status.replace(/_/g, ' ')}` : ''}{showArchived ? ' · incl. archived' : ''} · {newCount} new</p>

      <div style={filterBar}>
        <form method="GET" style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input name="q" defaultValue={q} placeholder="Search name, email, phone, notes…" style={searchInput} />
          <select name="status" defaultValue={status ?? ''} style={selectInput}>
            <option value="">All statuses</option>
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <label style={{ fontSize: '13px', color: '#374151', display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="checkbox" name="archived" value="1" defaultChecked={showArchived} /> Show archived
          </label>
          <button type="submit" style={filterBtn}>Filter</button>
          {(q || status || showArchived) && <Link href="/admin/leads" style={{ fontSize: '13px', color: '#6B7280' }}>Clear</Link>}
        </form>
      </div>

      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>{['Lead', 'Contact', 'Status', 'Source / Ad', 'Follow-up', 'Received', ''].map((hh) => <th key={hh} style={th}>{hh}</th>)}</tr>
          </thead>
          <tbody>
            {leads.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: '#9CA3AF', fontStyle: 'italic', padding: '40px' }}>No leads found.</td></tr>
            ) : leads.map((l) => {
              const st = STATUS_STYLE[l.status] ?? STATUS_STYLE.LOST
              const ad = l.gclid || l.utmSource
              return (
                <tr key={l.id} style={tr}>
                  <td style={td}>
                    <div style={{ fontWeight: 500, color: '#0A1628' }}>{l.name}{l.archivedAt ? <span style={{ fontSize: 11, color: '#9CA3AF' }}> · archived</span> : null}</div>
                    {l.notes ? <div style={{ fontSize: 11, color: '#9CA3AF', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.notes.split('\n')[0]}</div> : null}
                  </td>
                  <td style={td}><div style={{ fontSize: 12 }}>{l.email ?? '—'}</div><div style={{ fontSize: 11, color: '#9CA3AF' }}>{l.phone ?? '—'}</div></td>
                  <td style={td}><span style={{ fontSize: 11, backgroundColor: st.bg, color: st.fg, padding: '3px 8px', borderRadius: 100, fontWeight: 600 }}>{l.status.replace(/_/g, ' ')}</span></td>
                  <td style={td}><div style={{ fontSize: 12 }}>{l.source.replace(/_/g, ' ')}</div>{ad ? <div style={{ fontSize: 11, color: '#166534' }}>{l.gclid ? 'gclid' : l.utmSource}{l.utmCampaign ? ` · ${l.utmCampaign}` : ''}</div> : null}</td>
                  <td style={td}>{l.followUpAt ? <span style={{ fontSize: 12, color: new Date(l.followUpAt) < new Date() ? '#B91C1C' : '#374151' }}>{et(l.followUpAt)}</span> : '—'}</td>
                  <td style={td}><span style={{ fontSize: 12 }}>{et(l.createdAt)}</span></td>
                  <td style={td}><Link href={`/admin/leads/${l.id}`} style={{ color: '#FF5A1F', fontSize: 12, fontWeight: 600 }}>Open →</Link></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20, alignItems: 'center' }}>
          {page > 1 && <Link href={qs({ page: String(page - 1) })} style={pageBtn}>← Prev</Link>}
          <span style={{ fontSize: 13, color: '#6B7280' }}>Page {page} of {pages}</span>
          {page < pages && <Link href={qs({ page: String(page + 1) })} style={pageBtn}>Next →</Link>}
        </div>
      )}
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0 0 24px' }
const filterBar: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '16px', marginBottom: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const searchInput: React.CSSProperties = { padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', minWidth: '260px', outline: 'none' }
const selectInput: React.CSSProperties = { padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', outline: 'none', backgroundColor: '#FFFFFF' }
const filterBtn: React.CSSProperties = { padding: '8px 20px', backgroundColor: '#FF5A1F', color: '#FFFFFF', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }
const tableWrap: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const th: React.CSSProperties = { padding: '12px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }
const tr: React.CSSProperties = { borderBottom: '1px solid #F3F4F6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: '13px', color: '#374151' }
const pageBtn: React.CSSProperties = { padding: '6px 14px', fontSize: '13px', color: '#374151', border: '1px solid #E5E7EB', borderRadius: '6px', textDecoration: 'none' }
