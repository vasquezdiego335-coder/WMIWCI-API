import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { AuditAction, Prisma } from '@prisma/client'
import Link from 'next/link'
import { PageHeader, Card, Empty, SoftBadge, tableStyles, COLORS } from '../_ui'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

// Activity Log — a read-only window on the AuditLog. Owner-only (audit.view is
// OWNER-only in the permission matrix). Never renders secrets: AuditLog.details
// holds business fields (statuses, ids, amounts), never card data / tokens /
// raw webhook payloads (those live in webhook_logs, which is NOT surfaced here).

type SP = { action?: string; from?: string; to?: string; q?: string; page?: string }

function parseDate(s?: string): Date | undefined {
  if (!s) return undefined
  const d = new Date(s)
  return isNaN(d.getTime()) ? undefined : d
}

// Compact, safe rendering of the details JSON: a "from → to" change and a short
// summary of whitelisted business fields only.
function summarizeDetails(details: unknown): { change: string | null; note: string | null; source: string | null } {
  if (!details || typeof details !== 'object') return { change: null, note: null, source: null }
  const d = details as Record<string, unknown>
  const str = (v: unknown) => (v == null ? null : String(v))
  const from = str(d.previousStatus ?? d.from ?? d.oldValue)
  const to = str(d.newStatus ?? d.to ?? d.newValue)
  const change = from || to ? `${from ?? '—'} → ${to ?? '—'}` : null
  const source = str(d.source)
  const noteParts: string[] = []
  if (d.approvedBy) noteParts.push(`by ${str(d.approvedBy)}`)
  if (d.changedBy) noteParts.push(`by ${str(d.changedBy)}`)
  if (d.captured != null) noteParts.push(`captured ${(Number(d.captured) / 100).toFixed(2)}`)
  if (d.amountRefunded != null) noteParts.push(`refunded ${(Number(d.amountRefunded) / 100).toFixed(2)}`)
  if (d.status && !change) noteParts.push(String(d.status))
  if (d.reason) noteParts.push(String(d.reason).slice(0, 80))
  return { change, note: noteParts.length ? noteParts.join(' · ') : null, source }
}

const ACTION_COLOR: Record<string, string> = {
  PAYMENT_RECEIVED: COLORS.green,
  PAYMENT_REFUNDED: COLORS.amber,
  PAYMENT_DISPUTED: COLORS.red,
  PAYMENT_FAILED: COLORS.red,
  BOOKING_STATE_CHANGED: COLORS.blue,
  USER_LOGIN: COLORS.muted,
}

export default async function ActivityLogPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession()
  if (!session || !can(session.role as Role, 'audit.view')) {
    return (
      <div>
        <PageHeader title="Activity Log" subtitle="Owner-only" />
        <Card>
          <Empty>The Activity Log is restricted to owners.</Empty>
        </Card>
      </div>
    )
  }

  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)
  const actionFilter = searchParams.action && (Object.values(AuditAction) as string[]).includes(searchParams.action)
    ? (searchParams.action as AuditAction)
    : undefined
  const from = parseDate(searchParams.from)
  const to = parseDate(searchParams.to)
  const q = searchParams.q?.trim()

  const where: Prisma.AuditLogWhereInput = {}
  if (actionFilter) where.action = actionFilter
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
  if (q) {
    where.OR = [
      { bookingId: q },
      { booking: { is: { displayId: q } } },
      { booking: { is: { bookingReference: q } } },
      { user: { is: { name: { contains: q, mode: 'insensitive' } } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { name: true, role: true } },
        booking: { select: { displayId: true, bookingReference: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.auditLog.count({ where }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const qs = (p: number) => {
    const u = new URLSearchParams()
    if (actionFilter) u.set('action', actionFilter)
    if (searchParams.from) u.set('from', searchParams.from)
    if (searchParams.to) u.set('to', searchParams.to)
    if (q) u.set('q', q)
    u.set('page', String(p))
    return `/admin/logs?${u.toString()}`
  }

  return (
    <div>
      <PageHeader title="Activity Log" subtitle={`${total.toLocaleString('en-US')} recorded actions`} />

      {/* Filters (GET form) */}
      <form method="GET" action="/admin/logs" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '18px' }}>
        <Field label="Action">
          <select name="action" defaultValue={actionFilter ?? ''} style={inputStyle}>
            <option value="">All actions</option>
            {(Object.values(AuditAction) as string[]).sort().map((a) => (
              <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </Field>
        <Field label="From"><input type="date" name="from" defaultValue={searchParams.from ?? ''} style={inputStyle} /></Field>
        <Field label="To"><input type="date" name="to" defaultValue={searchParams.to ?? ''} style={inputStyle} /></Field>
        <Field label="Search (booking ref or actor)"><input type="text" name="q" defaultValue={q ?? ''} placeholder="WMIC-1042 or name" style={{ ...inputStyle, minWidth: '220px' }} /></Field>
        <button type="submit" style={btnStyle}>Filter</button>
        {(actionFilter || from || to || q) && (
          <Link href="/admin/logs" style={{ ...btnStyle, background: '#FFFFFF', color: COLORS.ink, border: '1px solid #E5E7EB' }}>Clear</Link>
        )}
      </form>

      {rows.length === 0 ? (
        <Card><Empty>No activity matches these filters.</Empty></Card>
      ) : (
        <div style={tableStyles.wrap}>
          <div style={tableStyles.scroll}>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  {['Time (ET)', 'Actor', 'Action', 'Entity', 'Change', 'Source'].map((h) => (
                    <th key={h} style={tableStyles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const { change, note, source } = summarizeDetails(r.details)
                  const actor = r.user ? `${r.user.name}` : 'system'
                  const actorRole = r.user?.role
                  const ref = r.booking?.bookingReference ?? r.booking?.displayId ?? (r.bookingId ? r.bookingId.slice(0, 8) : null)
                  const src = source ?? (r.userId ? 'admin' : 'system')
                  return (
                    <tr key={r.id}>
                      <td style={{ ...tableStyles.td, whiteSpace: 'nowrap', color: COLORS.muted }}>
                        {new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}
                      </td>
                      <td style={tableStyles.td}>
                        {actor}{actorRole && <span style={{ color: COLORS.faint, fontSize: '11px' }}> · {actorRole}</span>}
                      </td>
                      <td style={tableStyles.td}>
                        <SoftBadge color={ACTION_COLOR[r.action] ?? COLORS.muted}>{r.action.replace(/_/g, ' ')}</SoftBadge>
                      </td>
                      <td style={tableStyles.td}>
                        {ref ? <Link href={`/admin/jobs/${r.bookingId}`} style={{ color: COLORS.orange, textDecoration: 'none', fontWeight: 600 }}>{ref}</Link> : <span style={{ color: COLORS.faint }}>—</span>}
                      </td>
                      <td style={{ ...tableStyles.td, color: COLORS.ink }}>
                        {change ? <span style={{ fontWeight: 600 }}>{change}</span> : <span style={{ color: COLORS.faint }}>—</span>}
                        {note && <div style={{ fontSize: '11px', color: COLORS.faint, marginTop: '2px' }}>{note}</div>}
                      </td>
                      <td style={{ ...tableStyles.td, color: COLORS.muted, textTransform: 'capitalize' }}>{src}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', fontSize: '13px', color: COLORS.muted }}>
        <span>Page {page} of {totalPages}</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          {page > 1 && <Link href={qs(page - 1)} style={pageBtn}>← Newer</Link>}
          {page < totalPages && <Link href={qs(page + 1)} style={pageBtn}>Older →</Link>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      {children}
    </label>
  )
}

const inputStyle: React.CSSProperties = { padding: '8px 10px', borderRadius: '8px', border: '1px solid #E5E7EB', fontSize: '13px', color: COLORS.ink, background: '#FFFFFF' }
const btnStyle: React.CSSProperties = { padding: '9px 16px', borderRadius: '8px', border: 'none', background: COLORS.orange, color: '#FFFFFF', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textDecoration: 'none' }
const pageBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: '8px', border: '1px solid #E5E7EB', background: '#FFFFFF', color: COLORS.ink, fontSize: '13px', fontWeight: 600, textDecoration: 'none' }
