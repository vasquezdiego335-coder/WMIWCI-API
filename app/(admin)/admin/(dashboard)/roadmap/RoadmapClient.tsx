'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'
import { ROADMAP_CATEGORY_LABELS, ROADMAP_PRIORITY_LABELS, ROADMAP_STATUS_LABELS, OWNER_LABELS } from '../_labels'

// Ideas & Roadmap client pieces (increment 2): new-idea form, per-item actions
// (status / priority / owner / comment), and the one-time seed button.

export function RoadmapForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [f, setF] = useState({ title: '', summary: '', problem: '', benefit: '', category: 'OTHER', priority: 'MEDIUM' })
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  async function submit() {
    if (!f.title.trim()) { setMsg('A title is required'); return }
    setSaving(true)
    setMsg('')
    try {
      const res = await fetch('/api/admin/roadmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          title: f.title, summary: f.summary || undefined, problem: f.problem || undefined,
          benefit: f.benefit || undefined, category: f.category, priority: f.priority,
        }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setMsg(d.error ?? 'Failed'); return }
      setF({ title: '', summary: '', problem: '', benefit: '', category: 'OTHER', priority: 'MEDIUM' })
      setMsg('Saved ✓')
      router.refresh()
    } catch { setMsg('Network error') } finally { setSaving(false) }
  }

  if (!open) return <button onClick={() => setOpen(true)} style={primaryBtn}>＋ New idea</button>

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0A1628', margin: 0 }}>New idea</h3>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#9CA3AF', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
        <Field label="Title *" wide><input value={f.title} onChange={(e) => set('title', e.target.value)} style={input} placeholder="e.g. Text customers when the crew is on the way" /></Field>
        <Field label="Category">
          <select value={f.category} onChange={(e) => set('category', e.target.value)} style={input}>
            {Object.entries(ROADMAP_CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)} style={input}>
            {Object.entries(ROADMAP_PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>
        <Field label="Summary"><textarea value={f.summary} onChange={(e) => set('summary', e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} /></Field>
        <Field label="Business problem"><textarea value={f.problem} onChange={(e) => set('problem', e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} /></Field>
        <Field label="Expected benefit"><textarea value={f.benefit} onChange={(e) => set('benefit', e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} /></Field>
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '14px' }}>
        <button onClick={submit} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save idea'}</button>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        {msg && <span style={{ fontSize: '13px', fontWeight: 600, color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

export function SeedButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function seed() {
    setBusy(true)
    try {
      await fetch('/api/admin/roadmap/seed', { method: 'POST', headers: { ...csrfHeader() } })
      router.refresh()
    } finally { setBusy(false) }
  }
  return (
    <button onClick={seed} disabled={busy} style={{ ...primaryBtn, backgroundColor: '#0A1628' }}>
      {busy ? 'Loading…' : '⬇ Load the known admin gaps as roadmap items'}
    </button>
  )
}

export function RoadmapActions({ id, status, priority, assignedOwner }: { id: string; status: string; priority: string; assignedOwner: string | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [comment, setComment] = useState('')

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/admin/roadmap/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error ?? 'Failed'); return }
      setCommenting(false)
      setComment('')
      router.refresh()
    } finally { setBusy(false) }
  }

  async function changeStatus(next: string) {
    if (next === 'REJECTED') {
      const reason = prompt('Why is this idea being rejected? (required)')
      if (!reason?.trim()) return
      await patch({ status: next, rejectionReason: reason })
      return
    }
    await patch({ status: next })
  }

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={status} onChange={(e) => changeStatus(e.target.value)} disabled={busy} style={sel} title="Status">
        {Object.entries(ROADMAP_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select value={priority} onChange={(e) => patch({ priority: e.target.value })} disabled={busy} style={sel} title="Priority">
        {Object.entries(ROADMAP_PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select value={assignedOwner ?? ''} onChange={(e) => patch({ assignedOwner: e.target.value || null })} disabled={busy} style={sel} title="Owner">
        <option value="">Unassigned</option>
        {Object.entries(OWNER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {commenting ? (
        <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" style={{ ...sel, minWidth: '160px', fontWeight: 400 }} />
          <button onClick={() => comment.trim() && patch({ comment })} disabled={busy || !comment.trim()} style={miniBtn}>Post</button>
          <button onClick={() => setCommenting(false)} style={{ ...miniBtn, color: '#9CA3AF' }}>✕</button>
        </span>
      ) : (
        <button onClick={() => setCommenting(true)} style={miniBtn}>💬 Comment</button>
      )}
      {err && <span style={{ fontSize: '11px', color: '#EF4444' }}>{err}</span>}
    </div>
  )
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: '#6B7280' }}>{label}</span>
      {children}
    </label>
  )
}

const panel: React.CSSProperties = { backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px 22px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)', marginBottom: '20px' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '7px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box', backgroundColor: '#fff' }
const primaryBtn: React.CSSProperties = { padding: '9px 16px', backgroundColor: '#FF5A1F', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }
const sel: React.CSSProperties = { padding: '4px 7px', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, backgroundColor: '#fff', color: '#374151' }
const miniBtn: React.CSSProperties = { padding: '4px 9px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', color: '#374151' }
