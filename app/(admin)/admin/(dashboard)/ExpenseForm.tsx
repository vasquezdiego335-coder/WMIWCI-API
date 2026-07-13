'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { dollarsToCents } from '@/lib/profit'
import { csrfHeader, uploadReceipt } from './_client'
import { EXPENSE_CATEGORY_LABELS, EXPENSE_CATEGORY_ORDER, PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from './_labels'

// Add-expense form (owner spec 2026-07-13). Reusable: on the Expenses page it
// adds a general/business expense; embed with `presetBookingId` on a job page to
// lock the expense to that job (it then reduces that job's profit). Receipt is
// uploaded to Cloudinary first, then the expense is created with its URL.

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // YYYY-MM-DD
}

export default function ExpenseForm({ presetBookingId, presetJobLabel, compact }: { presetBookingId?: string; presetJobLabel?: string; compact?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const [f, setF] = useState({
    amount: '',
    incurredOn: today(),
    category: 'GAS',
    vendor: '',
    paymentMethod: 'CASH',
    paidBy: '',
    bookingId: presetBookingId ?? '',
    purpose: '',
    reimbursable: false,
    notes: '',
  })
  const set = (k: string, v: string | boolean) => setF((p) => ({ ...p, [k]: v }))

  async function submit() {
    setMsg('')
    const amountCents = dollarsToCents(f.amount)
    if (!amountCents) {
      setMsg('Enter a valid amount')
      return
    }
    setSaving(true)
    try {
      let receiptUrl: string | undefined
      let receiptPublicId: string | undefined
      if (file) {
        const up = await uploadReceipt(file, presetBookingId || f.bookingId || undefined)
        receiptUrl = up.url
        receiptPublicId = up.publicId
      }
      const res = await fetch('/api/admin/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          amountCents,
          incurredOn: f.incurredOn,
          category: f.category,
          vendor: f.vendor || undefined,
          paymentMethod: f.paymentMethod || undefined,
          paidBy: f.paidBy || undefined,
          bookingId: (presetBookingId || f.bookingId) || undefined,
          purpose: f.purpose || undefined,
          reimbursable: f.reimbursable,
          notes: f.notes || undefined,
          receiptUrl,
          receiptPublicId,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setMsg(d.error ?? 'Could not save expense')
        return
      }
      setMsg('Saved ✓')
      setF((p) => ({ ...p, amount: '', vendor: '', paidBy: '', purpose: '', notes: '' }))
      setFile(null)
      router.refresh()
      if (compact) setOpen(false)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return <button onClick={() => setOpen(true)} style={primaryBtn}>＋ Add expense</button>
  }

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0A1628', margin: 0 }}>
          Add expense{presetJobLabel ? ` · ${presetJobLabel}` : ''}
        </h3>
        <button onClick={() => setOpen(false)} style={closeBtn}>✕</button>
      </div>

      <div style={grid}>
        <Field label="Amount *">
          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #D1D5DB', borderRadius: '7px', overflow: 'hidden' }}>
            <span style={{ padding: '0 8px', color: '#9CA3AF', fontSize: '14px' }}>$</span>
            <input inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" style={{ ...input, border: 'none', borderRadius: 0 }} />
          </div>
        </Field>
        <Field label="Date *">
          <input type="date" value={f.incurredOn} onChange={(e) => set('incurredOn', e.target.value)} style={input} />
        </Field>
        <Field label="Category *">
          <select value={f.category} onChange={(e) => set('category', e.target.value)} style={input}>
            {EXPENSE_CATEGORY_ORDER.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
          </select>
          {f.category === 'WORKER_PAY' && (
            <span style={{ fontSize: '11px', color: '#B45309', backgroundColor: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '6px', padding: '5px 8px', marginTop: '4px', lineHeight: 1.4 }}>
              ⚠ Crew labor is tracked in payroll on the job page — use “Worker pay” ONLY for
              helpers who are not in the crew system, or the same labor will be counted twice.
            </span>
          )}
        </Field>
        <Field label="Payment method">
          <select value={f.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)} style={input}>
            {PAYMENT_METHOD_ORDER.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
          </select>
        </Field>
        <Field label="Vendor">
          <input value={f.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="e.g. Shell, U-Haul" style={input} />
        </Field>
        <Field label="Who paid">
          <input value={f.paidBy} onChange={(e) => set('paidBy', e.target.value)} placeholder="Diego / Sebastian / business" style={input} />
        </Field>
        {!presetBookingId && (
          <Field label="Link to job (booking ID)" hint="leave blank for a general business expense">
            <input value={f.bookingId} onChange={(e) => set('bookingId', e.target.value)} placeholder="optional" style={input} />
          </Field>
        )}
        <Field label="Business purpose">
          <input value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="e.g. fuel for the Newark job" style={input} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '10px', marginTop: '10px' }}>
        <Field label="Notes">
          <textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.reimbursable} onChange={(e) => set('reimbursable', e.target.checked)} />
            Reimbursable
          </label>
          <label style={{ fontSize: '13px', color: '#374151' }}>
            <span style={{ marginRight: '8px', fontWeight: 600, color: '#6B7280' }}>Receipt</span>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: '12px' }} />
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
        <button onClick={submit} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save expense'}</button>
        <button onClick={() => setOpen(false)} style={closeTextBtn}>Cancel</button>
        {msg && <span style={{ fontSize: '13px', fontWeight: 600, color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: '#6B7280' }}>{label}{hint && <span style={{ fontWeight: 400, color: '#9CA3AF' }}> — {hint}</span>}</span>
      {children}
    </label>
  )
}

const panel: React.CSSProperties = { backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px 22px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)', marginBottom: '20px' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '10px' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '7px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box', backgroundColor: '#fff' }
const primaryBtn: React.CSSProperties = { padding: '9px 16px', backgroundColor: '#FF5A1F', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#9CA3AF', fontSize: '16px', cursor: 'pointer', lineHeight: 1 }
const closeTextBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#6B7280', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
