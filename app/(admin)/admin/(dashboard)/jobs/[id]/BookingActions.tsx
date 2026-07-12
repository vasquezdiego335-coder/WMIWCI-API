'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const TRANSITIONS: Record<string, { label: string; next: string; color: string }[]> = {
  PENDING_APPROVAL: [
    { label: 'Confirm booking', next: 'CONFIRMED', color: '#3B82F6' },
    { label: 'Cancel', next: 'CANCELLED', color: '#EF4444' },
  ],
  CONFIRMED: [
    { label: 'Mark scheduled', next: 'SCHEDULED', color: '#6366F1' },
    { label: 'Cancel', next: 'CANCELLED', color: '#EF4444' },
  ],
  SCHEDULED: [
    { label: 'Start job', next: 'IN_PROGRESS', color: '#F59E0B' },
    { label: 'Cancel', next: 'CANCELLED', color: '#EF4444' },
  ],
  IN_PROGRESS: [
    { label: 'Complete job', next: 'COMPLETED', color: '#10B981' },
  ],
  COMPLETED: [
    { label: 'Archive', next: 'ARCHIVED', color: '#6B7280' },
  ],
}

export default function BookingActions({ bookingId, status }: { bookingId: string; status: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const actions = TRANSITIONS[status] ?? []
  if (actions.length === 0) return null

  async function transition(next: string) {
    if (!confirm(`Move booking to ${next.replace(/_/g, ' ')}?`)) return
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })

      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Failed to update status')
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {actions.map((a) => (
          <button
            key={a.next}
            onClick={() => transition(a.next)}
            disabled={loading}
            style={{
              padding: '8px 18px',
              backgroundColor: a.color,
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '600',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && <p style={{ fontSize: '12px', color: '#EF4444', margin: '0' }}>{error}</p>}
    </div>
  )
}
