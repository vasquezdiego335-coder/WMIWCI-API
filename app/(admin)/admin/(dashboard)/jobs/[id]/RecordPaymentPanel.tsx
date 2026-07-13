'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { dollarsToCents } from '@/lib/profit'
import { csrfHeader } from '../../_client'
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '../../_labels'

// Record a cash / move-day payment on a job (owner spec 2026-07-13). Feeds the
// profit math + revenue so "what was paid" is real, not just the $49 deposit.

export default function RecordPaymentPanel({ bookingId }: { bookingId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('CASH')
  const [note, setNote] = useState('')

  async function submit() {
    setMsg('')
    const amountCents = dollarsToCents(amount)
    if (!amountCents) { setMsg('Enter a valid amount'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ bookingId, amountCents, method, note: note || undefined }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setMsg(d.error ?? 'Could not record payment')
        return
      }
      setAmount(''); setNote(''); setMsg('Recorded ✓')
      router.refresh()
      setOpen(false)
    } catch {
      setMsg('Network error')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return <button onClick={() => setOpen(true)} style={btn}>＋ Record payment</button>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid #E5E7EB', borderRadius: '8px', padding: '12px', marginTop: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #D1D5DB', borderRadius: '7px', overflow: 'hidden', flex: '1 1 110px' }}>
          <span style={{ padding: '0 8px', color: '#9CA3AF' }}>$</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ ...input, border: 'none' }} />
        </div>
        <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ ...input, flex: '1 1 110px' }}>
          {PAYMENT_METHOD_ORDER.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
        </select>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (e.g. balance collected on move day)" style={input} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button onClick={submit} disabled={saving} style={{ ...btn, backgroundColor: '#0A1628', color: '#fff', borderColor: '#0A1628', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={() => setOpen(false)} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
        {msg && <span style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

const btn: React.CSSProperties = { padding: '7px 13px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '7px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box' }
