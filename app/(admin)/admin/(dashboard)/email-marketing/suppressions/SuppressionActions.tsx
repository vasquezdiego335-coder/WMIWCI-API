'use client'

// Lift a RESTORABLE suppression. A reason is required and recorded — re-opening
// mail to someone who asked us to stop is a decision that must leave a trace.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

export default function SuppressionActions({ email, reason }: { email: string; reason: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    const why = prompt(
      `Restore ${email}?\n\nThis re-opens promotional email to an address currently suppressed as ${reason}.\nA reason is required and will be recorded in the audit log.`
    )
    if (!why?.trim()) return

    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/email-marketing/suppressions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ email, reason: why.trim() }),
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
        onClick={restore}
        disabled={busy}
        style={{
          fontSize: '11px',
          fontWeight: 600,
          padding: '4px 10px',
          borderRadius: '6px',
          border: '1px solid #D1D5DB',
          backgroundColor: busy ? '#F3F4F6' : '#FFFFFF',
          color: '#374151',
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        {busy ? 'Restoring…' : 'Restore'}
      </button>
      {error && <span style={{ fontSize: '11px', color: '#B91C1C' }}>{error}</span>}
    </span>
  )
}
