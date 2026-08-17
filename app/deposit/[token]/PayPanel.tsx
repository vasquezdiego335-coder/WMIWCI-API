'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ════════════════════════════════════════════════════════════════════════════
//  The pay button and the post-Stripe confirmation state.
//  ------------------------------------------------------------------------
//  THE RULE THIS COMPONENT EXISTS TO KEEP: reaching the success URL is NOT a
//  payment. Stripe redirects the browser the moment the customer finishes, but
//  the money is only confirmed when the signed webhook arrives. So when the
//  customer comes back this shows "Confirming your payment…" and asks the
//  SERVER whether the deposit is paid. It can never render success on its own.
//
//  If confirmation is still not in after the polling window, it says so plainly
//  and tells them their card was not charged twice — it does not fake success
//  and it does not claim failure either, because neither is known yet.
// ════════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 30_000

type Props = { token: string; amountLabel: string; returning: boolean }

export default function PayPanel({ token, amountLabel, returning }: Props) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'confirming' | 'slow'>(returning ? 'confirming' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const stopped = useRef(false)

  useEffect(() => () => { stopped.current = true }, [])

  // ── Poll for the webhook-confirmed state ──────────────────────────────────
  useEffect(() => {
    if (!returning) return
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      if (stopped.current) return
      try {
        const res = await fetch(`/api/deposit/${encodeURIComponent(token)}/status`, { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { status?: string }
          if (data.status === 'PAID') {
            // Reload so the server re-renders the authoritative paid view —
            // the client never composes a success screen from its own state.
            window.location.replace(`/deposit/${encodeURIComponent(token)}`)
            return
          }
        }
      } catch {
        /* a transient network error is not a payment failure — keep polling */
      }
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        setPhase('slow')
        return
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [returning, token])

  const pay = useCallback(async () => {
    setError(null)
    setPhase('starting')
    try {
      const res = await fetch(`/api/deposit/${encodeURIComponent(token)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // NO AMOUNT IS SENT. The server reads it from the deposit record; there
        // is deliberately nothing here for a tampered client to change.
        body: '{}',
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        setError(data.error ?? 'We could not start the payment. Please try again or text us.')
        setPhase('idle')
        return
      }
      window.location.assign(data.url)
    } catch {
      setError('We could not reach the payment page. Check your connection and try again.')
      setPhase('idle')
    }
  }, [token])

  if (phase === 'confirming') {
    return (
      <div style={statusBox} role="status" aria-live="polite">
        <p style={{ margin: 0, fontWeight: 700, color: '#0A1628' }}>Confirming your payment…</p>
        <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#4B5563' }}>
          This takes a few seconds. Please keep this page open.
        </p>
      </div>
    )
  }

  if (phase === 'slow') {
    return (
      <div style={statusBox} role="status" aria-live="polite">
        <p style={{ margin: 0, fontWeight: 700, color: '#0A1628' }}>Still confirming your payment</p>
        <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#4B5563' }}>
          Your bank may take a moment. You have not been charged twice — do not pay again. Refresh this page shortly,
          or text us at (862) 640-0625 and we will confirm it for you.
        </p>
        <button type="button" onClick={() => window.location.reload()} style={secondaryButton}>
          Refresh
        </button>
      </div>
    )
  }

  return (
    <>
      {error && (
        <p role="alert" style={errorBox}>
          {error}
        </p>
      )}
      <button type="button" onClick={pay} disabled={phase === 'starting'} style={{ ...payButton, opacity: phase === 'starting' ? 0.7 : 1 }}>
        {phase === 'starting' ? 'Opening secure checkout…' : `Pay ${amountLabel} Securely`}
      </button>
    </>
  )
}

const payButton: React.CSSProperties = {
  width: '100%',
  border: 'none',
  borderRadius: '12px',
  background: '#D2450F',
  color: '#FFFFFF',
  fontSize: '18px',
  fontWeight: 700,
  // 17px vertical padding puts the tap target well over the 44px minimum.
  padding: '17px 20px',
  cursor: 'pointer',
  WebkitAppearance: 'none',
}
const secondaryButton: React.CSSProperties = {
  marginTop: '12px',
  border: '1px solid #0A162833',
  borderRadius: '10px',
  background: '#FFFFFF',
  color: '#0A1628',
  fontSize: '14px',
  fontWeight: 600,
  padding: '11px 16px',
  cursor: 'pointer',
}
const statusBox: React.CSSProperties = {
  background: '#EFF6FF',
  border: '1px solid #BFDBFE',
  borderRadius: '12px',
  padding: '16px',
}
const errorBox: React.CSSProperties = {
  background: '#FEF2F2',
  border: '1px solid #FECACA',
  color: '#B91C1C',
  borderRadius: '10px',
  padding: '10px 12px',
  fontSize: '14px',
  margin: '0 0 12px',
}
