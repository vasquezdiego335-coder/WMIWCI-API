'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// Inline "add a truck" form (Moving OS Phase 1). POSTs to /api/admin/trucks
// (truck.manage — server enforces; audited TRUCK_CREATED). Size is free text
// with the common rental sizes as quick picks, matching the schema's contract.

const SIZES = ['10ft', '15ft', '26ft']
const SOURCES: Array<[string, string]> = [
  ['RENTAL', 'Rental'],
  ['COMPANY_OWNED', 'Company owned'],
  ['THIRD_PARTY', 'Third party'],
]

export default function TruckForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [size, setSize] = useState('15ft')
  const [source, setSource] = useState('RENTAL')
  const [capacityNotes, setCapacityNotes] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const res = await fetch('/api/admin/trucks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          name: name.trim(),
          size: size.trim(),
          source,
          capacityNotes: capacityNotes.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error ?? 'Failed to create the truck')
        return
      }
      setName('')
      setCapacityNotes('')
      setOpen(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div style={{ marginBottom: '18px' }}>
        <button onClick={() => setOpen(true)} style={primaryBtn}>+ Add truck</button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={panel}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={field}>
          <span style={label_}>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="U-Haul 15ft #1" required maxLength={120} style={input} />
        </label>
        <label style={field}>
          <span style={label_}>Size</span>
          <input value={size} onChange={(e) => setSize(e.target.value)} list="truck-sizes" required maxLength={40} style={{ ...input, width: '90px' }} />
          <datalist id="truck-sizes">
            {SIZES.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label style={field}>
          <span style={label_}>Source</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={input}>
            {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label style={{ ...field, flex: 1, minWidth: '180px' }}>
          <span style={label_}>Capacity notes (optional)</span>
          <input value={capacityNotes} onChange={(e) => setCapacityNotes(e.target.value)} placeholder="Fits a 2-bedroom; no liftgate" maxLength={1000} style={input} />
        </label>
        <button type="submit" disabled={busy || !name.trim() || !size.trim()} style={primaryBtn}>{busy ? 'Saving…' : 'Add truck'}</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} style={ghostBtn}>Cancel</button>
      </div>
      {err && <p style={{ fontSize: '12px', color: '#EF4444', margin: '8px 0 0' }}>{err}</p>}
    </form>
  )
}

const panel: React.CSSProperties = { backgroundColor: '#FFFFFF', border: '1px solid #F1F1F1', borderRadius: '12px', padding: '14px 16px', marginBottom: '18px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }
const label_: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#6B7280', letterSpacing: '0.04em', textTransform: 'uppercase' }
const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', fontFamily: 'inherit', backgroundColor: '#fff' }
const primaryBtn: React.CSSProperties = { padding: '9px 16px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
const ghostBtn: React.CSSProperties = { padding: '9px 14px', backgroundColor: '#fff', color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
