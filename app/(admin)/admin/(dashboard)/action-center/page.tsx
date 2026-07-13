import Link from 'next/link'
import { prisma } from '@/lib/db'
import { syncReminders } from '@/lib/reminder-sync'
import { PageHeader, StatCard, StatGrid, COLORS, Empty, Badge, SoftBadge } from '../_ui'
import {
  REMINDER_SEVERITY_LABELS, REMINDER_SEVERITY_ICONS, REMINDER_SEVERITY_COLORS, REMINDER_SEVERITY_ORDER,
  REMINDER_STATUS_LABELS, REMINDER_STATUS_COLORS, REMINDER_CATEGORY_LABELS, OWNER_LABELS,
} from '../_labels'
import ReminderActions, { RescanButton } from './ReminderActions'

export const dynamic = 'force-dynamic'

// Action Center (increment 2, owner spec 2026-07-13): reminders, warnings, and
// tasks requiring attention. Rules are DETERMINISTIC (src/lib/reminder-rules.ts)
// — no AI. The page syncs on load (small data; dedupe-keyed writes are no-ops
// when nothing changed), and "Rescan now" forces one.

const dateTime = (d: Date) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
const sevRank = (s: string) => { const i = REMINDER_SEVERITY_ORDER.indexOf(s); return i === -1 ? 99 : i }

type Search = { status?: string; severity?: string; category?: string; owner?: string; q?: string; group?: string }

export default async function ActionCenterPage({ searchParams }: { searchParams: Search }) {
  // Sync first so the page always reflects current reality. Fail open: a
  // scanner bug must never take the Action Center down.
  let scanError = false
  try {
    await syncReminders()
  } catch {
    scanError = true
  }

  const now = new Date()
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)

  const all = await prisma.reminder.findMany({ orderBy: [{ createdAt: 'desc' }], take: 1000 })

  const open = all.filter((r) => ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(r.status))
  const counts = {
    critical: open.filter((r) => r.severity === 'CRITICAL').length,
    dueToday: open.filter((r) => r.dueAt && r.dueAt <= todayEnd).length,
    open: open.length,
    diego: open.filter((r) => r.assignedOwner === 'DIEGO').length,
    sebastian: open.filter((r) => r.assignedOwner === 'SEBASTIAN').length,
    snoozed: all.filter((r) => r.status === 'SNOOZED').length,
    resolvedWeek: all.filter((r) => r.status === 'RESOLVED' && r.resolvedAt && r.resolvedAt >= weekAgo).length,
  }

  // ── Filters (plain GET form → survive reload/bookmark) ──
  const sp = searchParams
  const showDefault = !sp.status && !sp.severity && !sp.category && !sp.owner && !sp.q
  let rows = all.filter((r) => {
    // Explicit status filter wins; otherwise hide closed reminders (history is
    // one click away via the status dropdown — never deleted).
    if (sp.status) {
      if (r.status !== sp.status) return false
    } else if (['RESOLVED', 'DISMISSED'].includes(r.status)) {
      return false
    }
    if (sp.severity && r.severity !== sp.severity) return false
    if (sp.category && r.category !== sp.category) return false
    if (sp.owner && (r.assignedOwner ?? '') !== sp.owner) return false
    if (sp.q) {
      const q = sp.q.toLowerCase()
      if (!r.title.toLowerCase().includes(q) && !r.description.toLowerCase().includes(q)) return false
    }
    return true
  })
  // Sort: severity first, then overdue/due date, then newest.
  rows = rows.sort((a, b) =>
    sevRank(a.severity) - sevRank(b.severity) ||
    (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
    b.createdAt.getTime() - a.createdAt.getTime(),
  )

  // ── Grouping ──
  const group = sp.group ?? 'none'
  const groups: { label: string; rows: typeof rows }[] =
    group === 'category'
      ? Object.keys(REMINDER_CATEGORY_LABELS).map((c) => ({ label: REMINDER_CATEGORY_LABELS[c], rows: rows.filter((r) => r.category === c) })).filter((g) => g.rows.length)
      : group === 'severity'
        ? REMINDER_SEVERITY_ORDER.map((s) => ({ label: `${REMINDER_SEVERITY_ICONS[s]} ${REMINDER_SEVERITY_LABELS[s]}`, rows: rows.filter((r) => r.severity === s) })).filter((g) => g.rows.length)
        : group === 'owner'
          ? [
              { label: 'Diego', rows: rows.filter((r) => r.assignedOwner === 'DIEGO') },
              { label: 'Sebastian', rows: rows.filter((r) => r.assignedOwner === 'SEBASTIAN') },
              { label: 'Unassigned', rows: rows.filter((r) => !r.assignedOwner) },
            ].filter((g) => g.rows.length)
          : [{ label: '', rows }]

  return (
    <div>
      <PageHeader
        title="Action Center"
        subtitle="Reminders, warnings, and tasks requiring attention — generated automatically from live business data."
        actions={<RescanButton />}
      />

      {scanError && (
        <div style={{ backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#991B1B', marginBottom: '16px' }}>
          The automatic scan hit an error — the reminders below may be stale. Try “Rescan now”.
        </div>
      )}

      <StatGrid min={150}>
        <StatCard label="Critical" value={String(counts.critical)} accent={counts.critical > 0 ? COLORS.red : COLORS.green} href="/admin/action-center?severity=CRITICAL" />
        <StatCard label="Due Today" value={String(counts.dueToday)} accent={counts.dueToday > 0 ? COLORS.amber : COLORS.green} />
        <StatCard label="Open" value={String(counts.open)} accent={COLORS.navy} />
        <StatCard label="Diego" value={String(counts.diego)} accent={COLORS.orange} href="/admin/action-center?owner=DIEGO" />
        <StatCard label="Sebastian" value={String(counts.sebastian)} accent={COLORS.orange} href="/admin/action-center?owner=SEBASTIAN" />
        <StatCard label="Snoozed" value={String(counts.snoozed)} accent={COLORS.muted} href="/admin/action-center?status=SNOOZED" />
        <StatCard label="Resolved This Week" value={String(counts.resolvedWeek)} accent={COLORS.green} href="/admin/action-center?status=RESOLVED" />
      </StatGrid>

      {/* Filter bar */}
      <form method="get" style={filterBar}>
        <input name="q" defaultValue={sp.q ?? ''} placeholder="Search reminders…" style={{ ...filterInput, minWidth: '180px' }} />
        <select name="severity" defaultValue={sp.severity ?? ''} style={filterInput}>
          <option value="">Any severity</option>
          {REMINDER_SEVERITY_ORDER.map((s) => <option key={s} value={s}>{REMINDER_SEVERITY_LABELS[s]}</option>)}
        </select>
        <select name="status" defaultValue={sp.status ?? ''} style={filterInput}>
          <option value="">Active (default)</option>
          {Object.entries(REMINDER_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select name="category" defaultValue={sp.category ?? ''} style={filterInput}>
          <option value="">All categories</option>
          {Object.entries(REMINDER_CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select name="owner" defaultValue={sp.owner ?? ''} style={filterInput}>
          <option value="">Any owner</option>
          <option value="DIEGO">Diego</option>
          <option value="SEBASTIAN">Sebastian</option>
        </select>
        <select name="group" defaultValue={sp.group ?? 'none'} style={filterInput}>
          <option value="none">No grouping</option>
          <option value="severity">Group by severity</option>
          <option value="category">Group by category</option>
          <option value="owner">Group by owner</option>
        </select>
        <button type="submit" style={filterBtn}>Apply</button>
        <Link href="/admin/action-center" style={{ fontSize: '12px', color: COLORS.muted, alignSelf: 'center' }}>Reset</Link>
      </form>

      {rows.length === 0 ? (
        <div style={{ backgroundColor: '#fff', borderRadius: '12px', border: '1px solid #EFEFEF', padding: '36px', textAlign: 'center' }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>✅</div>
          <Empty>{showDefault ? 'Nothing needs attention right now. New reminders appear here automatically as rules detect issues.' : 'No reminders match these filters.'}</Empty>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label || 'all'} style={{ marginBottom: '18px' }}>
            {g.label && <h2 style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy, margin: '0 0 10px' }}>{g.label} <span style={{ color: COLORS.faint, fontWeight: 400 }}>({g.rows.length})</span></h2>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {g.rows.map((r) => {
                const overdue = r.dueAt && r.dueAt < now && ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(r.status)
                return (
                  <div key={r.id} style={{ ...card, borderLeft: `4px solid ${REMINDER_SEVERITY_COLORS[r.severity] ?? COLORS.muted}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '3px' }}>
                          <span title={REMINDER_SEVERITY_LABELS[r.severity]}>{REMINDER_SEVERITY_ICONS[r.severity]}</span>
                          <span style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy }}>{r.title}</span>
                          <SoftBadge color={REMINDER_SEVERITY_COLORS[r.severity] ?? COLORS.muted}>{REMINDER_SEVERITY_LABELS[r.severity]}</SoftBadge>
                          <Badge color={REMINDER_STATUS_COLORS[r.status] ?? COLORS.muted}>{REMINDER_STATUS_LABELS[r.status]}</Badge>
                          {overdue && <SoftBadge color={COLORS.red}>OVERDUE</SoftBadge>}
                        </div>
                        <p style={{ fontSize: '13px', color: COLORS.ink, margin: '0 0 6px', lineHeight: 1.5 }}>{r.description}</p>
                        <div style={{ fontSize: '11px', color: COLORS.faint, display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                          <span>{REMINDER_CATEGORY_LABELS[r.category] ?? r.category}</span>
                          {r.dueAt && <span>· due {dateTime(r.dueAt)}</span>}
                          {r.assignedOwner && <span>· assigned to {OWNER_LABELS[r.assignedOwner]}</span>}
                          {r.status === 'SNOOZED' && r.snoozedUntil && <span>· snoozed until {dateTime(r.snoozedUntil)}</span>}
                          {r.resolutionNote && ['RESOLVED', 'DISMISSED'].includes(r.status) && <span>· {r.resolutionNote}</span>}
                          {r.internalNote && <span>· note: {r.internalNote}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
                        {r.sourceUrl && <Link href={r.sourceUrl} style={{ fontSize: '12px', color: COLORS.orange, fontWeight: 700, textDecoration: 'none' }}>Open record →</Link>}
                        <ReminderActions id={r.id} status={r.status} assignedOwner={r.assignedOwner} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

const card: React.CSSProperties = { backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
const filterBar: React.CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px', alignItems: 'center' }
const filterInput: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', backgroundColor: '#fff', fontFamily: 'inherit' }
const filterBtn: React.CSSProperties = { padding: '8px 16px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
