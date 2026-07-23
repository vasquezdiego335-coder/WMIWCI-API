'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// Owner-only crew invitation (Stage 5). Defaults the role to CREW — an owner is
// never granted by accident. Account creation from an accepted invite depends on
// the auth onboarding step, so the panel says so honestly.

export default function InviteCrew() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [f, setF] = useState({ name: '', email: '', phone: '', role: 'CREW', workerType: 'EMPLOYEE', canDrive: false })

  async function submit() {
    if (!f.name.trim() || !f.email.trim()) { setMsg('Name and email are required.'); return }
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/admin/staff/invitations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() || null, role: f.role, workerType: f.workerType, canDrive: f.canDrive }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg(j.error ?? 'Could not create the invitation.'); return }
      setMsg('Invitation created ✓')
      router.refresh()
      setF({ name: '', email: '', phone: '', role: 'CREW', workerType: 'EMPLOYEE', canDrive: false })
    } catch { setMsg('Network error.') } finally { setBusy(false) }
  }

  if (!open) return <button onClick={() => setOpen(true)} style={inviteBtn}>+ Invite crew</button>

  return (
    <div style={{ position: 'absolute', right: 32, marginTop: '44px', zIndex: 20, backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '18px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', width: '320px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0A1628', margin: '0 0 12px' }}>Invite a crew member</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Full name" style={input} />
        <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Email" type="email" style={input} />
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Phone (optional)" style={input} />
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} style={input}>
          <option value="CREW">Crew</option>
          <option value="MANAGER">Manager</option>
        </select>
        <select value={f.workerType} onChange={(e) => setF({ ...f, workerType: e.target.value })} style={input}>
          <option value="EMPLOYEE">Employee</option>
          <option value="CONTRACTOR">Contractor</option>
          <option value="TEMP_HELPER">Temp helper</option>
        </select>
        <label style={{ fontSize: '12px', color: '#374151', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input type="checkbox" checked={f.canDrive} onChange={(e) => setF({ ...f, canDrive: e.target.checked })} /> Eligible driver
        </label>
      </div>
      <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '10px 0', lineHeight: 1.5 }}>
        The invite is recorded with an expiring token. Their login account is created when they complete
        onboarding — this never creates credentials on its own.
      </p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button onClick={submit} disabled={busy} style={{ ...inviteBtn, opacity: busy ? 0.6 : 1 }}>{busy ? '…' : 'Send invite'}</button>
        <button onClick={() => setOpen(false)} style={{ padding: '8px 12px', background: 'none', border: 'none', color: '#6B7280', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit' }}>Close</button>
      </div>
      {msg && <div style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444', marginTop: '8px' }}>{msg}</div>}
    </div>
  )
}

const inviteBtn: React.CSSProperties = { padding: '10px 20px', backgroundColor: '#FF5A1F', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }
const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
