'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// Per-reminder actions (increment 2): acknowledge / start / resolve / dismiss /
// reopen / snooze / assign. Every action is audited server-side.

export default function ReminderActions({ id, status, assignedOwner }: { id: string; status: string; assignedOwner: string | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [snoozing, setSnoozing] = useState(false)
  const [snoozeUntil, setSnoozeUntil] = useState('')

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/admin/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error ?? 'Failed')
        return
      }
      setSnoozing(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const live = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(status)
  const closed = ['RESOLVED', 'DISMISSED'].includes(status)

  if (snoozing) {
    return (
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="datetime-local" value={snoozeUntil} onChange={(e) => setSnoozeUntil(e.target.value)} style={{ padding: '4px 7px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '11px' }} />
        <button onClick={() => snoozeUntil && act({ action: 'snooze', snoozedUntil: new Date(snoozeUntil).toISOString() })} disabled={busy || !snoozeUntil} style={{ ...btn, color: '#3B82F6', borderColor: '#BFDBFE' }}>Snooze</button>
        <button onClick={() => setSnoozing(false)} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
        {err && <span style={errStyle}>{err}</span>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      {status === 'OPEN' && <button onClick={() => act({ action: 'acknowledge' })} disabled={busy} style={btn}>Acknowledge</button>}
      {['OPEN', 'ACKNOWLEDGED'].includes(status) && <button onClick={() => act({ action: 'start' })} disabled={busy} style={{ ...btn, color: '#3B82F6', borderColor: '#BFDBFE' }}>Start</button>}
      {live && <button onClick={() => act({ action: 'resolve' })} disabled={busy} style={{ ...btn, color: '#10B981', borderColor: '#A7F3D0' }}>Resolve</button>}
      {live && <button onClick={() => setSnoozing(true)} disabled={busy} style={btn}>Snooze…</button>}
      {live && <button onClick={() => act({ action: 'dismiss' })} disabled={busy} style={{ ...btn, color: '#9CA3AF' }}>Dismiss</button>}
      {(closed || status === 'SNOOZED') && <button onClick={() => act({ action: 'reopen' })} disabled={busy} style={btn}>Reopen</button>}
      <select
        value={assignedOwner ?? ''}
        onChange={(e) => act({ action: 'assign', assignedOwner: e.target.value || null })}
        disabled={busy}
        style={{ padding: '4px 7px', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, color: assignedOwner ? '#0A1628' : '#9CA3AF', backgroundColor: '#fff' }}
        title="Assign owner"
      >
        <option value="">Unassigned</option>
        <option value="DIEGO">Diego</option>
        <option value="SEBASTIAN">Sebastian</option>
      </select>
      {err && <span style={errStyle}>{err}</span>}
    </div>
  )
}

export function RescanButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function rescan() {
    setBusy(true)
    try {
      await fetch('/api/admin/reminders', { method: 'POST', headers: { ...csrfHeader() } })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button onClick={rescan} disabled={busy} style={{ padding: '8px 14px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
      {busy ? 'Scanning…' : '↻ Rescan now'}
    </button>
  )
}

const btn: React.CSSProperties = { padding: '4px 9px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', color: '#374151' }
const errStyle: React.CSSProperties = { fontSize: '11px', color: '#EF4444' }
