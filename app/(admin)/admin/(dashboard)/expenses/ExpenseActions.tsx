'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// Row actions for one expense (owner spec 2026-07-13). Approve / reject / mark
// reimbursed via PATCH; delete (owner-only) via DELETE with a confirm — deleting
// a money record is on the "require confirmation" list. Every action is audited
// server-side.

export default function ExpenseActions({ id, status, reimbursable, canDelete }: { id: string; status: string; reimbursable: boolean; canDelete: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function patch(newStatus: string) {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/admin/expenses/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error ?? 'Failed')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirm('Delete this expense? This removes it from the ledger and job profit. This cannot be undone.')) return
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/admin/expenses/${id}`, { method: 'DELETE', headers: { ...csrfHeader() } })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error ?? 'Failed')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const pending = status === 'SUBMITTED' || status === 'NEEDS_REVIEW'
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      {pending && <button onClick={() => patch('APPROVED')} disabled={busy} style={{ ...btn, color: '#10B981', borderColor: '#A7F3D0' }}>Approve</button>}
      {pending && <button onClick={() => patch('REJECTED')} disabled={busy} style={{ ...btn, color: '#EF4444', borderColor: '#FECACA' }}>Reject</button>}
      {status === 'APPROVED' && reimbursable && <button onClick={() => patch('REIMBURSED')} disabled={busy} style={{ ...btn, color: '#3B82F6', borderColor: '#BFDBFE' }}>Mark reimbursed</button>}
      {canDelete && <button onClick={remove} disabled={busy} style={{ ...btn, color: '#9CA3AF' }} title="Delete">🗑</button>}
      {err && <span style={{ fontSize: '11px', color: '#EF4444' }}>{err}</span>}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '4px 9px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }
