'use client'

// Cancel one queued send. Confirms first — cancelling a move reminder is not
// obviously reversible from the owner's point of view (the trigger has already
// fired once), so a stray click must not silently drop a customer email.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ScheduledActions({ jobId }: { jobId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    if (!confirm('Cancel this scheduled email?\n\nThe customer will not receive it unless the trigger fires again.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/email-marketing/scheduled', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error ?? `Failed (${res.status})`)
        return
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <button
        onClick={cancel}
        disabled={busy}
        style={{
          fontSize: '11px',
          fontWeight: 600,
          padding: '4px 10px',
          borderRadius: '6px',
          border: '1px solid #FECACA',
          backgroundColor: busy ? '#F3F4F6' : '#FEF2F2',
          color: '#B91C1C',
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        {busy ? 'Cancelling…' : 'Cancel'}
      </button>
      {error && <span style={{ fontSize: '11px', color: '#B91C1C' }}>{error}</span>}
    </span>
  )
}
