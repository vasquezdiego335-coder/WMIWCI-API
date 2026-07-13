import Link from 'next/link'
import { prisma } from '@/lib/db'
import { PageHeader, StatCard, StatGrid, COLORS, Empty, Badge, SoftBadge } from '../_ui'
import {
  ROADMAP_STATUS_LABELS, ROADMAP_STATUS_COLORS, ROADMAP_STATUS_ORDER,
  ROADMAP_PRIORITY_LABELS, ROADMAP_PRIORITY_COLORS, ROADMAP_CATEGORY_LABELS, OWNER_LABELS,
} from '../_labels'
import { RoadmapForm, RoadmapActions, SeedButton } from './RoadmapClient'

export const dynamic = 'force-dynamic'

// Ideas & Roadmap (increment 2, owner spec 2026-07-13): structured internal
// product + business planning. Board view groups by status; table view lists.
// Nothing is ever hard-deleted — REJECTED/ARCHIVED preserve the history.

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const dateOnly = (d: Date) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })

type Search = { view?: string; status?: string; category?: string; priority?: string; owner?: string; q?: string }

type Comment = { by: string; at: string; text: string }

export default async function RoadmapPage({ searchParams }: { searchParams: Search }) {
  const sp = searchParams
  const all = await prisma.roadmapItem.findMany({ orderBy: [{ updatedAt: 'desc' }], take: 500 })

  const active = all.filter((i) => !['COMPLETED', 'REJECTED', 'ARCHIVED'].includes(i.status))
  const counts = {
    total: all.length,
    active: active.length,
    inProgress: all.filter((i) => i.status === 'IN_PROGRESS').length,
    blocked: all.filter((i) => i.status === 'BLOCKED').length,
    ready: all.filter((i) => i.status === 'READY').length,
    completed: all.filter((i) => i.status === 'COMPLETED').length,
  }

  let rows = all.filter((i) => {
    if (sp.status) { if (i.status !== sp.status) return false }
    else if (['ARCHIVED', 'REJECTED'].includes(i.status)) return false
    if (sp.category && i.category !== sp.category) return false
    if (sp.priority && i.priority !== sp.priority) return false
    if (sp.owner && (i.assignedOwner ?? '') !== sp.owner) return false
    if (sp.q) {
      const q = sp.q.toLowerCase()
      const hay = [i.title, i.summary, i.problem, i.solution, i.notes].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  rows = rows.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || b.updatedAt.getTime() - a.updatedAt.getTime())

  const isBoard = sp.view === 'board'
  const boardCols = ROADMAP_STATUS_ORDER
    .map((s) => ({ status: s, items: rows.filter((i) => i.status === s) }))
    .filter((c) => c.items.length > 0)

  return (
    <div>
      <PageHeader
        title="Ideas & Roadmap"
        subtitle="Future features, business ideas, and every known admin gap — organized, prioritized, and dependency-aware."
      />

      <RoadmapForm />

      {all.length === 0 && (
        <div style={{ backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '12px', padding: '20px', marginBottom: '20px' }}>
          <p style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy, margin: '0 0 6px' }}>Start with the known gaps</p>
          <p style={{ fontSize: '13px', color: COLORS.ink, margin: '0 0 12px' }}>
            Load the pre-built roadmap: Calendar & Scheduling, Leads & Marketing, Payroll, Reports & P&L, Customer Balances,
            Notifications, Documents, Settings, the financial architecture decisions, and the future AI CEO concept (“The Foreman”).
            Loading never overwrites anything you have edited.
          </p>
          <SeedButton />
        </div>
      )}

      <StatGrid min={140}>
        <StatCard label="Active" value={String(counts.active)} accent={COLORS.navy} />
        <StatCard label="In Progress" value={String(counts.inProgress)} accent={COLORS.amber} href="/admin/roadmap?status=IN_PROGRESS" />
        <StatCard label="Ready" value={String(counts.ready)} accent={COLORS.blue} href="/admin/roadmap?status=READY" />
        <StatCard label="Blocked" value={String(counts.blocked)} accent={counts.blocked > 0 ? COLORS.red : COLORS.green} href="/admin/roadmap?status=BLOCKED" />
        <StatCard label="Completed" value={String(counts.completed)} accent={COLORS.green} href="/admin/roadmap?status=COMPLETED" />
      </StatGrid>

      {/* Filters + view toggle */}
      <form method="get" style={filterBar}>
        <input type="hidden" name="view" value={sp.view ?? ''} />
        <input name="q" defaultValue={sp.q ?? ''} placeholder="Search ideas…" style={{ ...filterInput, minWidth: '170px' }} />
        <select name="status" defaultValue={sp.status ?? ''} style={filterInput}>
          <option value="">Active (default)</option>
          {Object.entries(ROADMAP_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select name="category" defaultValue={sp.category ?? ''} style={filterInput}>
          <option value="">All categories</option>
          {Object.entries(ROADMAP_CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select name="priority" defaultValue={sp.priority ?? ''} style={filterInput}>
          <option value="">Any priority</option>
          {Object.entries(ROADMAP_PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select name="owner" defaultValue={sp.owner ?? ''} style={filterInput}>
          <option value="">Any owner</option>
          {Object.entries(OWNER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button type="submit" style={filterBtn}>Apply</button>
        <Link href={isBoard ? '/admin/roadmap' : '/admin/roadmap?view=board'} style={{ fontSize: '12px', color: COLORS.orange, fontWeight: 700, textDecoration: 'none', alignSelf: 'center' }}>
          {isBoard ? '☰ List view' : '▦ Board view'}
        </Link>
        <Link href="/admin/roadmap" style={{ fontSize: '12px', color: COLORS.muted, alignSelf: 'center' }}>Reset</Link>
      </form>

      {rows.length === 0 ? (
        all.length > 0 && <Empty>No ideas match these filters.</Empty>
      ) : isBoard ? (
        <div style={{ display: 'flex', gap: '14px', overflowX: 'auto', alignItems: 'flex-start', paddingBottom: '8px' }}>
          {boardCols.map((col) => (
            <div key={col.status} style={{ minWidth: '280px', flex: '0 0 280px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Badge color={ROADMAP_STATUS_COLORS[col.status]}>{ROADMAP_STATUS_LABELS[col.status]}</Badge>
                <span style={{ fontSize: '12px', color: COLORS.faint }}>{col.items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {col.items.map((i) => <ItemCard key={i.id} item={i} compact />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {rows.map((i) => <ItemCard key={i.id} item={i} />)}
        </div>
      )}
    </div>
  )
}

function ItemCard({ item: i, compact }: { item: NonNullable<Awaited<ReturnType<typeof prisma.roadmapItem.findFirst>>>; compact?: boolean }) {
  const comments = (Array.isArray(i.comments) ? (i.comments as unknown as Comment[]) : [])
  const isAiCeo = i.seedKey === 'ai-ceo-the-foreman'
  return (
    <div style={{ ...card, ...(isAiCeo ? { border: `1px solid ${COLORS.gold}`, boxShadow: `0 1px 8px ${COLORS.gold}33` } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
        {isAiCeo && <span title="Featured future concept">⭐</span>}
        <span style={{ fontSize: '14px', fontWeight: 700, color: COLORS.navy }}>{i.title}</span>
        <SoftBadge color={ROADMAP_PRIORITY_COLORS[i.priority] ?? COLORS.muted}>{ROADMAP_PRIORITY_LABELS[i.priority]}</SoftBadge>
        {!compact && <Badge color={ROADMAP_STATUS_COLORS[i.status] ?? COLORS.muted}>{ROADMAP_STATUS_LABELS[i.status]}</Badge>}
        <SoftBadge color={COLORS.blue}>{ROADMAP_CATEGORY_LABELS[i.category] ?? i.category}</SoftBadge>
      </div>
      {i.summary && <p style={{ fontSize: '13px', color: COLORS.ink, margin: '0 0 6px', lineHeight: 1.5 }}>{i.summary}</p>}
      {!compact && (i.problem || i.solution || i.benefit || i.risks || i.notes) && (
        <details style={{ marginBottom: '6px' }}>
          <summary style={{ fontSize: '12px', color: COLORS.orange, cursor: 'pointer', fontWeight: 600 }}>Details</summary>
          <div style={{ fontSize: '12px', color: COLORS.ink, lineHeight: 1.6, padding: '8px 0 0' }}>
            {i.problem && <p style={{ margin: '0 0 6px' }}><b>Problem:</b> {i.problem}</p>}
            {i.solution && <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap' }}><b>Solution:</b> {i.solution}</p>}
            {i.benefit && <p style={{ margin: '0 0 6px' }}><b>Benefit:</b> {i.benefit}</p>}
            {i.risks && <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap' }}><b>Risks / safeguards:</b> {i.risks}</p>}
            {i.notes && <p style={{ margin: '0 0 6px' }}><b>Notes:</b> {i.notes}</p>}
            {comments.length > 0 && (
              <div style={{ borderTop: '1px solid #F3F4F6', paddingTop: '6px' }}>
                {comments.map((c, k) => (
                  <p key={k} style={{ margin: '0 0 4px' }}><b>{c.by}</b> <span style={{ color: COLORS.faint }}>{new Date(c.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>: {c.text}</p>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
      <div style={{ fontSize: '11px', color: COLORS.faint, display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: compact ? 0 : '8px' }}>
        {i.dependencies && <span>needs: {i.dependencies}</span>}
        {i.blockers && <span style={{ color: COLORS.red }}>blocked: {i.blockers}</span>}
        {i.targetIncrement && <span>target: {i.targetIncrement}</span>}
        {i.assignedOwner && <span>owner: {OWNER_LABELS[i.assignedOwner]}</span>}
        {i.impact != null && <span>impact {i.impact}/5</span>}
        {i.effort != null && <span>effort {i.effort}/5</span>}
        {comments.length > 0 && <span>💬 {comments.length}</span>}
        <span>updated {dateOnly(i.updatedAt)}</span>
      </div>
      {!compact && <RoadmapActions id={i.id} status={i.status} priority={i.priority} assignedOwner={i.assignedOwner} />}
    </div>
  )
}

const card: React.CSSProperties = { backgroundColor: '#fff', border: '1px solid #EFEFEF', borderRadius: '12px', padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
const filterBar: React.CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px', alignItems: 'center' }
const filterInput: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', backgroundColor: '#fff', fontFamily: 'inherit' }
const filterBtn: React.CSSProperties = { padding: '8px 16px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
