'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Echoes the double-submit CSRF cookie as the header the API requires.
function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const t = document.cookie.split('; ').find((c) => c.startsWith('moveit_csrf='))?.split('=')[1]
  return t ? { 'X-CSRF-Token': decodeURIComponent(t) } : {}
}

type Props = {
  bookingId: string
  defaults: {
    waitingMinutes: string
    waitingFeeOverride: string // dollars
    waitingFeeWaived: boolean
    waitingWaiverReason: string
    waitingFeeCollected: boolean
  }
}

// Manual override panel for the Late Arrival & Delay Policy. The crew normally
// set the timestamps from Discord; this lets staff correct the minutes, hand-set
// or waive the fee, and mark it collected on move day.
export default function WaitingTimePanel({ bookingId, defaults }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [minutes, setMinutes] = useState(defaults.waitingMinutes)
  const [overrideDollars, setOverrideDollars] = useState(defaults.waitingFeeOverride)
  const [waived, setWaived] = useState(defaults.waitingFeeWaived)
  const [reason, setReason] = useState(defaults.waitingWaiverReason)
  const [collected, setCollected] = useState(defaults.waitingFeeCollected)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function save() {
    setSaving(true)
    setMsg('')
    try {
      const body: Record<string, unknown> = {
        waitingFeeWaived: waived,
        waitingWaiverReason: reason || null,
        waitingFeeCollected: collected,
      }
      if (minutes.trim() !== '') body.waitingMinutes = Number(minutes)
      // Override is entered in dollars; API stores cents. Empty = clear override.
      body.waitingFeeOverride = overrideDollars.trim() === '' ? null : Math.round(Number(overrideDollars) * 100)

      const res = await fetch(`/api/admin/bookings/${bookingId}/details`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
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
    return <button onClick={() => setOpen(true)} style={editBtn}>✎ Adjust waiting fee</button>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <label style={fieldCol}>
          <span style={fieldLabel}>Minutes waited (total)</span>
          <input type="number" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={input} placeholder="auto from crew taps" />
        </label>
        <label style={fieldCol}>
          <span style={fieldLabel}>Override fee ($)</span>
          <input type="number" min={0} step="1" value={overrideDollars} onChange={(e) => setOverrideDollars(e.target.value)} style={input} placeholder="leave blank = auto" />
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
        <input type="checkbox" checked={waived} onChange={(e) => setWaived(e.target.checked)} />
        Waive the waiting fee (charge $0)
      </label>
      {waived && (
        <label style={fieldCol}>
          <span style={fieldLabel}>Reason for waiver</span>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={input} placeholder="e.g. traffic on our end, goodwill" />
        </label>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
        <input type="checkbox" checked={collected} onChange={(e) => setCollected(e.target.checked)} />
        Waiting fee collected on move day
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={save} disabled={saving} style={{ ...editBtn, backgroundColor: '#0A1628', color: '#fff', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={() => setOpen(false)} style={{ ...editBtn, color: '#6B7280' }}>Close</button>
        {msg && <span style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

const input: React.CSSProperties = { width: '100%', padding: '7px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box' }
const fieldCol: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }
const fieldLabel: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#6B7280' }
const editBtn: React.CSSProperties = { alignSelf: 'flex-start', padding: '7px 14px', backgroundColor: '#F3F4F6', color: '#374151', border: 'none', borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }
