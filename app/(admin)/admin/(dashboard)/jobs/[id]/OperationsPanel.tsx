'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Reads the double-submit CSRF cookie the middleware sets and echoes it as the
// X-CSRF-Token header the API requires for state-mutating calls.
function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const t = document.cookie.split('; ').find((c) => c.startsWith('moveit_csrf='))?.split('=')[1]
  return t ? { 'X-CSRF-Token': decodeURIComponent(t) } : {}
}

type FieldDef = { key: string; label: string; kind?: 'text' | 'number' | 'area' }

const TEXT: FieldDef[] = [
  { key: 'arrivalWindow', label: 'Arrival window' },
  { key: 'assignedDispatcher', label: 'Assigned dispatcher' },
  { key: 'completionProgress', label: 'Completion %', kind: 'number' },
  { key: 'problemFlags', label: 'Problem flags' },
]
const TRUCK: FieldDef[] = [
  { key: 'truckProvider', label: 'Truck provider' },
  { key: 'truckSize', label: 'Truck size' },
  { key: 'truckReservationNumber', label: 'Reservation #' },
  { key: 'truckReservationStatus', label: 'Reservation status' },
  { key: 'truckPickupTime', label: 'Truck pickup time' },
  { key: 'driverName', label: 'Driver name' },
  { key: 'driverPhone', label: 'Driver phone' },
  { key: 'truckFuelPolicy', label: 'Fuel policy' },
]
const AREAS: FieldDef[] = [
  { key: 'dispatcherNotes', label: 'Dispatcher notes', kind: 'area' },
  { key: 'crewNotes', label: 'Crew notes', kind: 'area' },
  { key: 'officeNotes', label: 'Office notes', kind: 'area' },
  { key: 'outstandingTasks', label: 'Outstanding tasks', kind: 'area' },
]

export default function OperationsPanel({ bookingId, defaults }: { bookingId: string; defaults: Record<string, string> }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(defaults)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  function set(k: string, v: string) {
    setValues((prev) => ({ ...prev, [k]: v }))
  }

  async function save() {
    setSaving(true)
    setMsg('')
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/details`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setMsg(d.error ?? 'Save failed')
        return
      }
      setMsg('Saved ✓')
      router.refresh()
    } catch {
      setMsg('Network error')
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={editBtn}>✎ Edit operations</button>
    )
  }

  const renderField = (f: FieldDef) => (
    <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: '#6B7280' }}>{f.label}</span>
      {f.kind === 'area' ? (
        <textarea value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} rows={2} style={input} />
      ) : (
        <input type={f.kind === 'number' ? 'number' : 'text'} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} style={input} />
      )}
    </label>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>{TEXT.map(renderField)}</div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#0A1628', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Truck & driver</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>{TRUCK.map(renderField)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>{AREAS.map(renderField)}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={save} disabled={saving} style={{ ...editBtn, backgroundColor: '#0A1628', color: '#fff', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={() => setOpen(false)} style={{ ...editBtn, color: '#6B7280' }}>Close</button>
        {msg && <span style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

export function PrintButton() {
  return (
    <button onClick={() => window.print()} style={quickLink}>🖨 Print work order</button>
  )
}

const input: React.CSSProperties = { width: '100%', padding: '7px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }
const editBtn: React.CSSProperties = { alignSelf: 'flex-start', padding: '7px 14px', backgroundColor: '#F3F4F6', color: '#374151', border: 'none', borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }
const quickLink: React.CSSProperties = { padding: '7px 12px', backgroundColor: '#FFFFFF', color: '#374151', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }
