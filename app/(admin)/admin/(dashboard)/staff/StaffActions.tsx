'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

export default function StaffActions({ userId, active, role }: { userId: string; active: boolean; role: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function toggleActive() {
    if (!confirm(`${active ? 'Deactivate' : 'Reactivate'} this staff member?`)) return
    setLoading(true)
    await fetch(`/api/admin/staff/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ active: !active }),
    })
    setLoading(false)
    router.refresh()
  }

  async function changeRole(newRole: string) {
    if (!confirm(`Change role to ${newRole}?`)) return
    setLoading(true)
    await fetch(`/api/admin/staff/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ role: newRole }),
    })
    setLoading(false)
    router.refresh()
  }

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
      <select
        defaultValue={role}
        onChange={(e) => changeRole(e.target.value)}
        disabled={loading}
        style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '12px', outline: 'none', backgroundColor: '#FFFFFF' }}
      >
        <option value="CREW">CREW</option>
        <option value="MANAGER">MANAGER</option>
        <option value="OWNER">OWNER</option>
      </select>
      <button
        onClick={toggleActive}
        disabled={loading}
        style={{
          padding: '6px 14px',
          backgroundColor: active ? '#FEF2F2' : '#F0FDF4',
          color: active ? '#EF4444' : '#10B981',
          border: 'none',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: '600',
          cursor: 'pointer',
        }}
      >
        {active ? 'Deactivate' : 'Reactivate'}
      </button>
    </div>
  )
}
