'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

export default function DeactivateControl({ userId, name, active }: { userId: string; name: string; active: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [resolve, setResolve] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [futureCount, setFutureCount] = useState<number | null>(null)

  async function run(action: 'DEACTIVATE' | 'REACTIVATE') {
    if (action === 'DEACTIVATE' && !reason.trim()) { setErr('A reason is required.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/staff/${userId}/deactivate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ action, reason: reason.trim(), resolveFutureWork: resolve }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j.error ?? 'Failed.'); if (j.futureAssignments != null) setFutureCount(j.futureAssignments); return }
      router.refresh(); setOpen(false)
    } catch { setErr('Network error.') } finally { setBusy(false) }
  }

  if (active) {
    return (
      <div style={{ backgroundColor: '#fff', border: '1px solid #FECACA', borderRadius: '12px', padding: '18px', marginTop: '16px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#B91C1C', marginBottom: '4px' }}>Deactivate {name}</div>
        <p style={{ fontSize: '12px', color: '#6B7280', margin: '0 0 10px' }}>
          Deactivation is not deletion — every past assignment, labor record and financial figure is kept.
          A worker with upcoming assignments is blocked unless you resolve them here.
        </p>
        {!open ? (
          <button onClick={() => setOpen(true)} style={{ ...btn, color: '#B91C1C', borderColor: '#FECACA' }}>Deactivate…</button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '480px' }}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, audited)" style={input} />
            <label style={{ fontSize: '12px', color: '#374151', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
              Cancel their upcoming assignments as part of this{futureCount != null ? ` (${futureCount} found)` : ''}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => run('DEACTIVATE')} disabled={busy} style={{ ...btn, backgroundColor: '#B91C1C', color: '#fff', borderColor: '#B91C1C' }}>{busy ? '…' : 'Confirm deactivation'}</button>
              <button onClick={() => setOpen(false)} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
            </div>
            {err && <span style={{ fontSize: '12px', color: '#EF4444' }}>{err}</span>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #A7F3D0', borderRadius: '12px', padding: '18px', marginTop: '16px' }}>
      <div style={{ fontSize: '13px', fontWeight: 700, color: '#065F46', marginBottom: '8px' }}>{name} is deactivated</div>
      <button onClick={() => run('REACTIVATE')} disabled={busy} style={{ ...btn, backgroundColor: '#065F46', color: '#fff', borderColor: '#065F46' }}>{busy ? '…' : 'Reactivate'}</button>
      {err && <span style={{ fontSize: '12px', color: '#EF4444', marginLeft: '8px' }}>{err}</span>}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '8px 13px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
const input: React.CSSProperties = { padding: '8px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
