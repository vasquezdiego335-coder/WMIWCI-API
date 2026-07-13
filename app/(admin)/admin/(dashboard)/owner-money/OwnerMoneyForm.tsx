'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { dollarsToCents } from '@/lib/profit'
import { csrfHeader, uploadReceipt } from '../_client'
import { OWNER_TX_TYPE_LABELS, OWNER_TX_TYPE_ORDER, PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER, OWNER_LABELS } from '../_labels'

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export default function OwnerMoneyForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({ owner: 'DIEGO', amount: '', type: 'CONTRIBUTION', occurredOn: today(), paymentMethod: 'BANK_TRANSFER', explanation: '' })
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  async function submit() {
    setMsg('')
    const amountCents = dollarsToCents(f.amount)
    if (!amountCents) { setMsg('Enter a valid amount'); return }
    setSaving(true)
    try {
      let receiptUrl: string | undefined
      let receiptPublicId: string | undefined
      if (file) {
        const up = await uploadReceipt(file)
        receiptUrl = up.url
        receiptPublicId = up.publicId
      }
      const res = await fetch('/api/admin/owner-money', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ owner: f.owner, amountCents, type: f.type, occurredOn: f.occurredOn, paymentMethod: f.paymentMethod, explanation: f.explanation || undefined, receiptUrl, receiptPublicId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setMsg(d.error ?? 'Could not save')
        return
      }
      setF((p) => ({ ...p, amount: '', explanation: '' }))
      setFile(null)
      setMsg('Saved ✓')
      router.refresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return <button onClick={() => setOpen(true)} style={primaryBtn}>＋ Add owner transaction</button>

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0A1628', margin: 0 }}>Add owner transaction</h3>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: '16px', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={grid}>
        <Field label="Owner *">
          <select value={f.owner} onChange={(e) => set('owner', e.target.value)} style={input}>
            {Object.entries(OWNER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Type *">
          <select value={f.type} onChange={(e) => set('type', e.target.value)} style={input}>
            {OWNER_TX_TYPE_ORDER.map((t) => <option key={t} value={t}>{OWNER_TX_TYPE_LABELS[t]}</option>)}
          </select>
        </Field>
        <Field label="Amount *">
          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #D1D5DB', borderRadius: '7px', overflow: 'hidden' }}>
            <span style={{ padding: '0 8px', color: '#9CA3AF' }}>$</span>
            <input inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" style={{ ...input, border: 'none' }} />
          </div>
        </Field>
        <Field label="Date *">
          <input type="date" value={f.occurredOn} onChange={(e) => set('occurredOn', e.target.value)} style={input} />
        </Field>
        <Field label="Payment method">
          <select value={f.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)} style={input}>
            {PAYMENT_METHOD_ORDER.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
          </select>
        </Field>
        <Field label="Explanation">
          <input value={f.explanation} onChange={(e) => set('explanation', e.target.value)} placeholder="e.g. bought moving blankets" style={input} />
        </Field>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '12px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '13px', color: '#374151' }}>
          <span style={{ marginRight: '8px', fontWeight: 600, color: '#6B7280' }}>Receipt</span>
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: '12px' }} />
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
        <button onClick={submit} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save transaction'}</button>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        {msg && <span style={{ fontSize: '13px', fontWeight: 600, color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: '#6B7280' }}>{label}</span>
      {children}
    </label>
  )
}

const panel: React.CSSProperties = { backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px 22px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)', marginBottom: '20px' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '10px' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '7px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box', backgroundColor: '#fff' }
const primaryBtn: React.CSSProperties = { padding: '9px 16px', backgroundColor: '#FF5A1F', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }
