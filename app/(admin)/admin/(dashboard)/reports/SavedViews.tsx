'use client'

// P1-3 — saved-view controls for the reporting pages.
//
// Applying a view does NOT re-implement filtering: it turns the stored
// configuration into the same query string the report already accepts and
// navigates, so the server re-validates through the one reporting-filter
// contract. There is deliberately no second filter parser on the client.
//
// The server is the only authority on permissions. Buttons are hidden when an
// action is unavailable purely to avoid offering a click that will 403 — every
// route re-checks independently.

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { COLORS } from '../_ui'

type SavedView = {
  id: string
  reportType: string
  name: string
  shared: boolean
  sortKey: string | null
  sortDir: string | null
  columns: string[]
  createdByName: string | null
  createdAt: string
  updatedAt: string
  mine: boolean
}

const BASE = '/api/admin/reports/saved-views'

const btn: React.CSSProperties = {
  padding: '7px 11px', borderRadius: '7px', border: `1px solid ${COLORS.line}`,
  background: '#fff', color: COLORS.navy, fontSize: '12.5px', fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1.2,
}
const btnPrimary: React.CSSProperties = { ...btn, background: COLORS.orange, borderColor: COLORS.orange, color: '#fff' }
const input: React.CSSProperties = {
  padding: '7px 9px', borderRadius: '7px', border: `1px solid ${COLORS.line}`,
  fontSize: '12.5px', minWidth: 0, flex: '1 1 160px',
}

export default function SavedViews({ reportType, canShare }: { reportType: string; canShare: boolean }) {
  const router = useRouter()
  const params = useSearchParams()

  const [views, setViews] = useState<SavedView[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [shareNew, setShareNew] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}?reportType=${encodeURIComponent(reportType)}`, { cache: 'no-store' })
      if (!res.ok) return // 403 for a role without access — stay silent, show nothing
      const data = await res.json()
      setViews(data.views ?? [])
    } catch {
      /* leave the control inert rather than breaking the report above it */
    }
  }, [reportType])

  useEffect(() => { void load() }, [load])

  /** Current report configuration, straight from the URL the server validated. */
  const currentFilters = () => {
    const out: Record<string, string> = {}
    params.forEach((v, k) => { if (v) out[k] = v })
    return out
  }

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text })
    window.setTimeout(() => setMsg(null), 6000)
  }

  async function apply(id: string) {
    setSelected(id)
    if (!id) return
    setBusy(true)
    try {
      const res = await fetch(`${BASE}/${id}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { flash('err', data.error ?? 'Could not open that view.'); return }
      // Rebuild the query string and let the SERVER validate it, exactly as if
      // the filter form had been submitted by hand.
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(data.filters ?? {})) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      }
      if (data.view?.sortKey) qs.set('sort', data.view.sortKey)
      if (data.view?.sortDir) qs.set('dir', data.view.sortDir)
      router.push(`?${qs.toString()}`)
    } catch {
      flash('err', 'Could not open that view.')
    } finally { setBusy(false) }
  }

  async function save() {
    if (!name.trim()) { flash('err', 'Give the view a name.'); return }
    setBusy(true)
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType, name: name.trim(), filters: currentFilters(), shared: shareNew }),
      })
      const data = await res.json()
      if (!res.ok) { flash('err', data.error ?? 'Could not save that view.'); return }
      setName(''); setSaving(false); setShareNew(false)
      await load()
      setSelected(data.view.id)
      flash('ok', `Saved "${data.view.name}".`)
    } catch {
      flash('err', 'Could not save that view.')
    } finally { setBusy(false) }
  }

  async function patch(id: string, body: Record<string, unknown>, okText: string) {
    setBusy(true)
    try {
      const res = await fetch(`${BASE}/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { flash('err', data.error ?? 'Could not update that view.'); return }
      await load()
      flash('ok', okText)
    } catch {
      flash('err', 'Could not update that view.')
    } finally { setBusy(false) }
  }

  async function remove(v: SavedView) {
    if (!window.confirm(`Delete the saved view "${v.name}"? The report itself is unaffected.`)) return
    setBusy(true)
    try {
      const res = await fetch(`${BASE}/${v.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) { flash('err', data.error ?? 'Could not delete that view.'); return }
      setSelected('')
      await load()
      flash('ok', `Deleted "${v.name}".`)
    } catch {
      flash('err', 'Could not delete that view.')
    } finally { setBusy(false) }
  }

  const current = views.find((v) => v.id === selected) ?? null
  // The server decides; this only avoids offering a click that would 403.
  const mayEdit = !!current?.mine || canShare

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px',
      padding: '10px 12px', borderRadius: '9px', background: '#fbfaf8',
      border: `1px solid ${COLORS.line}`,
    }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: '12px', fontWeight: 700, color: COLORS.muted, whiteSpace: 'nowrap' }}>
          Saved views
        </label>

        <select
          value={selected}
          onChange={(e) => void apply(e.target.value)}
          disabled={busy}
          style={{ ...input, flex: '1 1 200px', maxWidth: '320px' }}
          aria-label="Apply a saved view"
        >
          <option value="">
            {views.length ? 'Choose a saved view…' : 'No saved views yet'}
          </option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}{v.shared ? ' · shared' : ''}{!v.mine && v.createdByName ? ` · ${v.createdByName}` : ''}
            </option>
          ))}
        </select>

        {current && (
          <span
            title={current.shared ? 'Visible to other admin users' : 'Only you can see this view'}
            style={{
              fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '999px',
              background: current.shared ? '#e8f1ff' : '#f0efec',
              color: current.shared ? '#1c4f9c' : COLORS.muted, whiteSpace: 'nowrap',
            }}
          >
            {current.shared ? 'SHARED' : 'PRIVATE'}
          </span>
        )}

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginLeft: 'auto' }}>
          {!saving && <button type="button" style={btn} disabled={busy} onClick={() => setSaving(true)}>Save current view</button>}
          {current && mayEdit && (
            <>
              <button
                type="button" style={btn} disabled={busy}
                onClick={() => void patch(current.id, { filters: currentFilters() }, `Updated "${current.name}" to the current filters.`)}
                title="Overwrite this view with the filters currently on screen"
              >Update
              </button>
              <button
                type="button" style={btn} disabled={busy}
                onClick={() => {
                  const next = window.prompt('Rename this view', current.name)
                  if (next && next.trim() && next.trim() !== current.name) void patch(current.id, { name: next.trim() }, 'Renamed.')
                }}
              >Rename
              </button>
              {canShare && (
                <button
                  type="button" style={btn} disabled={busy}
                  onClick={() => void patch(current.id, { shared: !current.shared }, current.shared ? 'Made private.' : 'Shared with other admin users.')}
                >{current.shared ? 'Make private' : 'Share'}
                </button>
              )}
              <button type="button" style={{ ...btn, color: '#a32020' }} disabled={busy} onClick={() => void remove(current)}>Delete</button>
            </>
          )}
          <button
            type="button" style={btn} disabled={busy}
            onClick={() => { setSelected(''); router.push('?') }}
            title="Clear all filters and return to the default report"
          >Reset
          </button>
        </div>
      </div>

      {saving && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
            placeholder="Name this view — e.g. Monthly owner review"
            maxLength={120} style={{ ...input, maxWidth: '320px' }} aria-label="Saved view name"
          />
          {canShare && (
            <label style={{ display: 'flex', gap: '5px', alignItems: 'center', fontSize: '12.5px', color: COLORS.navy, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={shareNew} onChange={(e) => setShareNew(e.target.checked)} />
              Share with other admins
            </label>
          )}
          <button type="button" style={btnPrimary} disabled={busy} onClick={() => void save()}>Save</button>
          <button type="button" style={btn} disabled={busy} onClick={() => { setSaving(false); setName(''); setShareNew(false) }}>Cancel</button>
        </div>
      )}

      {current && (
        <div style={{ fontSize: '11.5px', color: COLORS.muted }}>
          {current.mine ? 'Saved by you' : `Saved by ${current.createdByName ?? 'another user'}`}
          {' · updated '}
          {new Date(current.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
        </div>
      )}

      {msg && (
        <div style={{ fontSize: '12px', fontWeight: 600, color: msg.kind === 'ok' ? '#1d6b3f' : '#a32020' }}>
          {msg.text}
        </div>
      )}
    </div>
  )
}
