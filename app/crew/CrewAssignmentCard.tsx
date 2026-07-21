'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// A worker's assignment card: acknowledge / decline, and clock in / break / out.
// Uses /api/crew endpoints (own-assignment only). CSRF token read from cookie.

function csrf(): Record<string, string> {
  const m = typeof document !== 'undefined' ? document.cookie.match(/(?:^|; )moveit_csrf=([^;]+)/) : null
  return m ? { 'x-csrf-token': decodeURIComponent(m[1]) } : {}
}

type A = {
  id: string; status: string; role: string; acknowledged: boolean; needsAck: boolean
  reportTime: string | null; start: string | null; reference: string; route: string | null
  loading: string | null; unloading: string | null; notes: string | null; clockedIn: boolean
}

export default function CrewAssignmentCard({ a }: { a: A }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')

  async function respond(action: 'ACKNOWLEDGE' | 'DECLINE') {
    if (action === 'DECLINE' && !reason.trim()) { setErr('Please add a reason.'); return }
    setBusy(action); setErr('')
    try {
      const res = await fetch(`/api/crew/assignments/${a.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrf() }, body: JSON.stringify({ action, reason: reason.trim() || undefined }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j.error ?? 'Failed.'); return }
      router.refresh()
    } catch { setErr('Network error.') } finally { setBusy(null) }
  }

  async function clock(action: 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT') {
    setBusy(action); setErr('')
    try {
      const res = await fetch(`/api/admin/crew-assignments/${a.id}/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrf() }, body: JSON.stringify({ action }) })
      if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j.error ?? 'Clock action failed.'); return }
      router.refresh()
    } catch { setErr('Network error.') } finally { setBusy(null) }
  }

  return (
    <div style={{ backgroundColor: '#fff', borderRadius: '14px', padding: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', borderLeft: `4px solid ${a.needsAck ? '#F59E0B' : a.clockedIn ? '#10B981' : '#0A1628'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: '#0A1628' }}>{a.reference}</div>
          <div style={{ fontSize: '12px', color: '#6B7280' }}>{a.role}</div>
        </div>
        {a.acknowledged && !a.needsAck && <span style={{ fontSize: '11px', fontWeight: 700, color: '#065F46', background: '#ECFDF5', padding: '3px 8px', borderRadius: '100px' }}>Confirmed</span>}
      </div>

      <div style={{ marginTop: '10px', fontSize: '13px', color: '#374151', lineHeight: 1.7 }}>
        {a.reportTime && <div><strong>Report:</strong> {a.reportTime}</div>}
        {a.start && !a.reportTime && <div><strong>Start:</strong> {a.start}</div>}
        {a.route && <div><strong>Route:</strong> {a.route}</div>}
        {a.loading && <div><strong>Pickup:</strong> {a.loading}</div>}
        {a.unloading && <div><strong>Drop-off:</strong> {a.unloading}</div>}
        {a.notes && <div style={{ marginTop: '4px', color: '#6B7280', whiteSpace: 'pre-wrap' }}>{a.notes}</div>}
      </div>

      {a.needsAck && (
        <div style={{ marginTop: '12px' }}>
          {!declining ? (
            <div style={{ display: 'flex', gap: '8px' }}>
              <Btn primary busy={busy === 'ACKNOWLEDGE'} onClick={() => respond('ACKNOWLEDGE')}>Confirm</Btn>
              <Btn onClick={() => setDeclining(true)}>Can't make it</Btn>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for declining" style={input} />
              <div style={{ display: 'flex', gap: '8px' }}>
                <Btn danger busy={busy === 'DECLINE'} onClick={() => respond('DECLINE')}>Decline</Btn>
                <Btn onClick={() => { setDeclining(false); setReason('') }}>Back</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {a.acknowledged && !a.needsAck && (
        <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {!a.clockedIn ? <Btn primary busy={busy === 'CLOCK_IN'} onClick={() => clock('CLOCK_IN')}>Clock in</Btn> : (
            <>
              <Btn busy={busy === 'BREAK_START'} onClick={() => clock('BREAK_START')}>Start break</Btn>
              <Btn busy={busy === 'BREAK_END'} onClick={() => clock('BREAK_END')}>End break</Btn>
              <Btn danger busy={busy === 'CLOCK_OUT'} onClick={() => clock('CLOCK_OUT')}>Clock out</Btn>
            </>
          )}
        </div>
      )}

      {err && <div style={{ marginTop: '8px', fontSize: '12px', color: '#EF4444' }}>{err}</div>}
    </div>
  )
}

function Btn({ children, onClick, primary, danger, busy }: { children: React.ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; busy?: boolean }) {
  return (
    <button onClick={onClick} disabled={busy} style={{
      minHeight: '44px', padding: '10px 18px', borderRadius: '10px', fontSize: '14px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', flex: primary ? 1 : undefined,
      border: primary ? 'none' : `1px solid ${danger ? '#FECACA' : '#D1D5DB'}`,
      background: primary ? '#FF5A1F' : danger ? '#FEF2F2' : '#fff', color: primary ? '#fff' : danger ? '#B91C1C' : '#374151', opacity: busy ? 0.6 : 1,
    }}>{busy ? '…' : children}</button>
  )
}
const input: React.CSSProperties = { minHeight: '44px', padding: '10px 12px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '16px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
