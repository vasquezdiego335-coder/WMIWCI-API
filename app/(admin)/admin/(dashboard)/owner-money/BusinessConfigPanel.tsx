'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { dollarsToCents } from '@/lib/profit'
import { csrfHeader } from '../_client'

// Ownership split + reserves editor (owner spec 2026-07-13). Owner-only; the
// server rejects a split that doesn't total 100%.

export default function BusinessConfigPanel({ diego, sebastian, taxPct, emergencyCents, canEdit }: { diego: number; sebastian: number; taxPct: number; emergencyCents: number; canEdit: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [d, setD] = useState(String(diego))
  const [s, setS] = useState(String(sebastian))
  const [tax, setTax] = useState(String(taxPct))
  const [emergency, setEmergency] = useState((emergencyCents / 100).toFixed(2))

  async function save() {
    setMsg('')
    const di = parseInt(d, 10)
    const se = parseInt(s, 10)
    if (di + se !== 100) { setMsg('Split must total 100%'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/business-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ diegoSplitPercent: di, sebastianSplitPercent: se, taxReservePercent: parseInt(tax, 10) || 0, emergencyReserveCents: dollarsToCents(emergency) ?? 0 }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); setMsg(j.error ?? 'Failed'); return }
      setMsg('Saved ✓')
      router.refresh()
      setOpen(false)
    } catch {
      setMsg('Network error')
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: '#6B7280' }}>Split <b>{diego}/{sebastian}</b> · Tax reserve <b>{taxPct}%</b> · Emergency <b>${(emergencyCents / 100).toLocaleString('en-US')}</b></span>
        {canEdit && <button onClick={() => setOpen(true)} style={btn}>Edit</button>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <Field label="Diego %"><input value={d} onChange={(e) => setD(e.target.value)} inputMode="numeric" style={input} /></Field>
      <Field label="Sebastian %"><input value={s} onChange={(e) => setS(e.target.value)} inputMode="numeric" style={input} /></Field>
      <Field label="Tax reserve %"><input value={tax} onChange={(e) => setTax(e.target.value)} inputMode="numeric" style={input} /></Field>
      <Field label="Emergency reserve $"><input value={emergency} onChange={(e) => setEmergency(e.target.value)} inputMode="decimal" style={input} /></Field>
      <button onClick={save} disabled={saving} style={{ ...btn, backgroundColor: '#0A1628', color: '#fff', borderColor: '#0A1628' }}>{saving ? 'Saving…' : 'Save'}</button>
      <button onClick={() => setOpen(false)} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
      {msg && <span style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}><span style={{ fontSize: '10px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>{label}</span>{children}</label>
}
const input: React.CSSProperties = { width: '90px', padding: '7px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box' }
const btn: React.CSSProperties = { padding: '7px 12px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }
