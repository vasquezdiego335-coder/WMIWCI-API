'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// Row actions for one truck (Moving OS Phase 1). Status changes + activate/
// deactivate are one-click PATCHes; "Edit" expands an inline form for name/
// size/notes. Every change is audited server-side (TRUCK_UPDATED). There is
// deliberately no delete — retire or deactivate, so history keeps its truck.

export default function TruckActions({
  id, name, size, source, status, capacityNotes, active,
}: {
  id: string
  name: string
  size: string
  source: string
  status: string
  capacityNotes: string | null
  active: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(false)
  const [eName, setEName] = useState(name)
  const [eSize, setESize] = useState(size)
  const [eSource, setESource] = useState(source)
  const [eNotes, setENotes] = useState(capacityNotes ?? '')

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/admin/trucks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error ?? 'Failed')
        return false
      }
      router.refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    if (!eName.trim() || !eSize.trim()) {
      setErr('Name and size are required')
      return
    }
    const ok = await patch({ name: eName.trim(), size: eSize.trim(), source: eSource, capacityNotes: eNotes.trim() || null })
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={eName} onChange={(e) => setEName(e.target.value)} maxLength={120} style={{ ...input, width: '130px' }} aria-label="Truck name" />
        <input value={eSize} onChange={(e) => setESize(e.target.value)} maxLength={40} style={{ ...input, width: '60px' }} aria-label="Truck size" />
        <select value={eSource} onChange={(e) => setESource(e.target.value)} style={input} aria-label="Truck source">
          {[['RENTAL', 'Rental'], ['COMPANY_OWNED', 'Company owned'], ['THIRD_PARTY', 'Third party'], ['CUSTOMER_PROVIDED', 'Customer provided'], ['NOT_REQUIRED', 'Not required']].map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input value={eNotes} onChange={(e) => setENotes(e.target.value)} maxLength={1000} placeholder="Capacity notes" style={{ ...input, width: '150px' }} aria-label="Capacity notes" />
        <button onClick={saveEdit} disabled={busy} style={{ ...btn, color: '#10B981', borderColor: '#A7F3D0' }}>Save</button>
        <button onClick={() => { setEditing(false); setErr('') }} disabled={busy} style={btn}>Cancel</button>
        {err && <span style={errStyle}>{err}</span>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      {status !== 'AVAILABLE' && active && (
        <button onClick={() => patch({ status: 'AVAILABLE' })} disabled={busy} style={{ ...btn, color: '#10B981', borderColor: '#A7F3D0' }}>Available</button>
      )}
      {status === 'AVAILABLE' && active && (
        <button onClick={() => patch({ status: 'MAINTENANCE' })} disabled={busy} style={{ ...btn, color: '#F59E0B', borderColor: '#FDE68A' }}>Maintenance</button>
      )}
      {status !== 'RETIRED' && (
        <button
          onClick={() => { if (confirm(`Retire ${name}? It stays on past bookings but stops being assignable.`)) void patch({ status: 'RETIRED', active: false }) }}
          disabled={busy}
          style={{ ...btn, color: '#9CA3AF' }}
        >
          Retire
        </button>
      )}
      {active ? (
        <button onClick={() => patch({ active: false })} disabled={busy} style={{ ...btn, color: '#9CA3AF' }}>Deactivate</button>
      ) : (
        <button onClick={() => patch({ active: true, status: 'AVAILABLE' })} disabled={busy} style={{ ...btn, color: '#10B981', borderColor: '#A7F3D0' }}>Reactivate</button>
      )}
      <button onClick={() => setEditing(true)} disabled={busy} style={btn}>Edit</button>
      {err && <span style={errStyle}>{err}</span>}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '4px 9px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }
const input: React.CSSProperties = { padding: '5px 8px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '12px', fontFamily: 'inherit' }
const errStyle: React.CSSProperties = { fontSize: '11px', color: '#EF4444' }
