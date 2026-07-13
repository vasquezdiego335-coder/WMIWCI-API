'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// Approve / reject / delete an owner transaction (owner spec 2026-07-13).

export default function OwnerMoneyActions({ id, approvalStatus, canDelete }: { id: string; approvalStatus: string; canDelete: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function patch(status: string) {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/owner-money/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...csrfHeader() }, body: JSON.stringify({ approvalStatus: status }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error ?? 'Failed'); return }
      router.refresh()
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!confirm('Delete this owner transaction? This cannot be undone.')) return
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/owner-money/${id}`, { method: 'DELETE', headers: { ...csrfHeader() } })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error ?? 'Failed'); return }
      router.refresh()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      {approvalStatus === 'PENDING' && <button onClick={() => patch('APPROVED')} disabled={busy} style={{ ...btn, color: '#10B981', borderColor: '#A7F3D0' }}>Approve</button>}
      {approvalStatus === 'PENDING' && <button onClick={() => patch('REJECTED')} disabled={busy} style={{ ...btn, color: '#EF4444', borderColor: '#FECACA' }}>Reject</button>}
      {canDelete && <button onClick={remove} disabled={busy} style={{ ...btn, color: '#9CA3AF' }} title="Delete">🗑</button>}
      {err && <span style={{ fontSize: '11px', color: '#EF4444' }}>{err}</span>}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '4px 9px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }
