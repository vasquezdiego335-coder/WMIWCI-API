'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function DiscountActions({ bookingId }: { bookingId: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function act(approve: boolean) {
    const confirmMsg = approve
      ? 'Approve this 10% door hanger discount? This will notify the customer.'
      : 'Deny this discount request? The customer will be notified.'
    if (!confirm(confirmMsg)) return

    setLoading(true)
    setError('')

    try {
      // Reuse the discord interactions handler — but this is a direct admin override
      // so we call a dedicated admin endpoint
      const res = await fetch(`/api/admin/discounts/${bookingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve }),
      })

      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Action failed')
        return
      }

      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
      <button
        onClick={() => act(true)}
        disabled={loading}
        style={{ padding: '8px 20px', backgroundColor: '#10B981', color: '#FFFFFF', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
      >
        Approve 10%
      </button>
      <button
        onClick={() => act(false)}
        disabled={loading}
        style={{ padding: '8px 20px', backgroundColor: '#F3F4F6', color: '#374151', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
      >
        Deny
      </button>
      {error && <p style={{ fontSize: '11px', color: '#EF4444', margin: '0' }}>{error}</p>}
    </div>
  )
}
