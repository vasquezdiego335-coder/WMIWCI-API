'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { dollarsToCents, fmtCents } from '@/lib/profit'
import { csrfHeader, uploadReceipt } from '../_client'
import { COLORS, Badge } from '../_ui'
import {
  EXPENSE_CATEGORY_GROUPS, EXPENSE_CATEGORY_LABELS, EXPENSE_STATUS_LABELS, EXPENSE_STATUS_COLORS,
  PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER, SUBCATEGORY_SUGGESTIONS, ALL_SUBCATEGORY_SUGGESTIONS,
  PAID_BY_OPTIONS, categoryGroupLabel, expenseDisplayTitle,
} from '@/lib/expense-format'
import ExpenseActions from './ExpenseActions'
import type { ExpenseRow } from './ExpenseTable'

// OWNER-only expense details drawer (owner spec 2026-07-14). Shows the complete
// record — full notes, vendor, category + subcategory, related job, receipt,
// created/edited audit stamps — and lets an owner edit every field, upload a
// receipt, re-link the job, and approve/reject/delete. The API enforces the
// finalized-record + permission rules; this only surfaces them.

const IMG_RE = /\.(png|jpe?g|gif|webp|avif)$/i
const FINALIZED = ['APPROVED', 'REIMBURSED']

function toDateInput(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
function dateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
}

export default function ExpenseDrawer({ expense: e, onClose }: { expense: ExpenseRow; onClose: () => void }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const [f, setF] = useState({
    itemTitle: e.itemTitle ?? '',
    amount: (e.amount / 100).toFixed(2),
    category: e.category,
    subcategory: e.subcategory ?? '',
    vendor: e.vendor ?? '',
    paymentMethod: e.paymentMethod ?? '',
    paidBy: e.paidBy ?? '',
    incurredOn: toDateInput(e.incurredOn),
    bookingId: e.bookingId ?? '',
    purpose: e.purpose ?? '',
    notes: e.notes ?? '',
    reimbursable: e.reimbursable,
    adjustmentReason: '',
  })
  const set = (k: string, v: string | boolean) => setF((p) => ({ ...p, [k]: v }))

  // A finalized expense needs a reason when the money-affecting fields change.
  const amountCents = dollarsToCents(f.amount)
  const financialChange =
    (amountCents != null && amountCents !== e.amount) ||
    f.category !== e.category ||
    (f.bookingId || null) !== (e.bookingId || null)
  const reasonRequired = FINALIZED.includes(e.status) && financialChange

  async function save() {
    setMsg('')
    if (!f.itemTitle.trim()) { setMsg('Item title is required'); return }
    if (amountCents == null) { setMsg('Enter a valid amount'); return }
    if (reasonRequired && !f.adjustmentReason.trim()) { setMsg('A reason is required to change the amount, category, or job of a finalized expense'); return }

    // Send only fields the owner actually changed, so the audit log's "changed"
    // list stays truthful and unchanged values never trigger a write.
    const patch: Record<string, unknown> = {}
    if (f.itemTitle.trim() !== (e.itemTitle ?? '')) patch.itemTitle = f.itemTitle.trim()
    if (amountCents !== e.amount) patch.amountCents = amountCents
    if (f.category !== e.category) patch.category = f.category
    if ((f.subcategory || null) !== (e.subcategory || null)) patch.subcategory = f.subcategory || null
    if ((f.vendor || null) !== (e.vendor || null)) patch.vendor = f.vendor || null
    if ((f.paymentMethod || null) !== (e.paymentMethod || null)) patch.paymentMethod = f.paymentMethod || null
    if ((f.paidBy || null) !== (e.paidBy || null)) patch.paidBy = f.paidBy || null
    if (f.incurredOn !== toDateInput(e.incurredOn)) patch.incurredOn = f.incurredOn
    if ((f.bookingId || null) !== (e.bookingId || null)) patch.bookingId = f.bookingId || null
    if ((f.purpose || null) !== (e.purpose || null)) patch.purpose = f.purpose || null
    if ((f.notes || null) !== (e.notes || null)) patch.notes = f.notes || null
    if (f.reimbursable !== e.reimbursable) patch.reimbursable = f.reimbursable

    if (Object.keys(patch).length === 0) { setMsg('No changes to save'); return }
    if (reasonRequired) patch.adjustmentReason = f.adjustmentReason.trim()

    setSaving(true)
    try {
      const res = await fetch(`/api/admin/expenses/${e.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(patch),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setMsg(d.error ?? 'Could not save'); return }
      setMsg('Saved ✓')
      setEditing(false)
      router.refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function onReceipt(file: File) {
    setMsg('')
    setSaving(true)
    try {
      const up = await uploadReceipt(file, e.bookingId ?? undefined)
      const res = await fetch(`/api/admin/expenses/${e.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ receiptUrl: up.url, receiptPublicId: up.publicId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setMsg(d.error ?? 'Could not attach receipt'); return }
      setMsg('Receipt attached ✓')
      router.refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Receipt upload failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(ev) => ev.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '4px' }}>
          <div>
            <div style={{ fontSize: '19px', fontWeight: 800, color: COLORS.navy, lineHeight: 1.2 }}>{expenseDisplayTitle(e)}</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: COLORS.navy, marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>{fmtCents(e.amount)}</div>
          </div>
          <button onClick={onClose} style={closeBtn} title="Close">✕</button>
        </div>
        <div style={{ marginBottom: '14px' }}>
          <Badge color={EXPENSE_STATUS_COLORS[e.status] ?? COLORS.muted}>{EXPENSE_STATUS_LABELS[e.status] ?? e.status}</Badge>
        </div>

        {!editing ? (
          <>
            <dl style={dl}>
              <Detail label="Category">{categoryGroupLabel(e.category)}<span style={{ color: COLORS.faint }}> · {EXPENSE_CATEGORY_LABELS[e.category] ?? e.category}</span></Detail>
              {e.subcategory && <Detail label="Subcategory">{e.subcategory}</Detail>}
              <Detail label="Vendor">{e.vendor ?? '—'}</Detail>
              <Detail label="Amount">{fmtCents(e.amount)}</Detail>
              <Detail label="Payment method">{e.paymentMethod ? (PAYMENT_METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod) : '—'}</Detail>
              <Detail label="Paid by">{e.paidBy ?? '—'}{e.reimbursable ? ' · reimbursable' : ''}</Detail>
              <Detail label="Purchase date">{new Date(e.incurredOn).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}</Detail>
              <Detail label="Related job">
                {e.job ? <Link href={`/admin/jobs/${e.job.id}`} style={{ color: COLORS.orange, textDecoration: 'none' }}>{e.job.label}</Link> : <span style={{ color: COLORS.faint }}>General business expense</span>}
              </Detail>
              {e.purpose && <Detail label="Business purpose">{e.purpose}</Detail>}
            </dl>

            {e.notes && (
              <div style={notesBox}>
                <div style={sectionLabel}>Notes</div>
                <div style={{ fontSize: '13px', color: COLORS.ink, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{e.notes}</div>
              </div>
            )}

            {/* Receipt */}
            <div style={{ marginTop: '16px' }}>
              <div style={sectionLabel}>Receipt</div>
              {e.receiptUrl ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {IMG_RE.test(e.receiptUrl) && <img src={e.receiptUrl} alt="Receipt" style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, border: `1px solid ${COLORS.line}` }} />}
                  <a href={e.receiptUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.orange, fontSize: '13px', fontWeight: 600 }}>Open / download receipt ↗</a>
                </div>
              ) : (
                <div style={{ fontSize: '13px', color: COLORS.faint, fontStyle: 'italic' }}>No receipt attached</div>
              )}
              <label style={{ display: 'inline-block', marginTop: '8px', fontSize: '12px', color: COLORS.muted }}>
                <span style={{ marginRight: '8px', fontWeight: 600 }}>{e.receiptUrl ? 'Replace' : 'Attach'}:</span>
                <input type="file" accept="image/*,application/pdf" disabled={saving} onChange={(ev) => { const file = ev.target.files?.[0]; if (file) onReceipt(file) }} style={{ fontSize: '12px' }} />
              </label>
            </div>

            {/* Audit */}
            <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: `1px solid ${COLORS.line}`, fontSize: '12px', color: COLORS.faint, lineHeight: 1.6 }}>
              <div>Created by <strong style={{ color: COLORS.muted }}>{e.createdByName ?? 'system'}</strong> · {dateTime(e.createdAt)}</div>
              <div>Last edited {e.updatedByName ? <>by <strong style={{ color: COLORS.muted }}>{e.updatedByName}</strong> · </> : ''}{dateTime(e.updatedAt)}</div>
            </div>

            {/* Actions */}
            <div style={actionBar}>
              <button onClick={() => setEditing(true)} style={editBtn}>✎ Edit</button>
              <ExpenseActions id={e.id} status={e.status} reimbursable={e.reimbursable} canDelete />
            </div>
          </>
        ) : (
          /* ── Edit form ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <Field label="Item title *">
              <input value={f.itemTitle} onChange={(ev) => set('itemTitle', ev.target.value)} style={{ ...input, fontWeight: 600 }} />
            </Field>
            <div style={twoCol}>
              <Field label="Amount *">
                <input inputMode="decimal" value={f.amount} onChange={(ev) => set('amount', ev.target.value)} style={input} />
              </Field>
              <Field label="Date *">
                <input type="date" value={f.incurredOn} onChange={(ev) => set('incurredOn', ev.target.value)} style={input} />
              </Field>
            </div>
            <div style={twoCol}>
              <Field label="Category *">
                <select value={f.category} onChange={(ev) => set('category', ev.target.value)} style={input}>
                  {EXPENSE_CATEGORY_GROUPS.map((g) => (
                    <optgroup key={g.key} label={g.label}>
                      {g.categories.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <Field label="Subcategory">
                <input list="drawer-subcats" value={f.subcategory} onChange={(ev) => set('subcategory', ev.target.value)} style={input} />
                <datalist id="drawer-subcats">
                  {(SUBCATEGORY_SUGGESTIONS[f.category] ?? ALL_SUBCATEGORY_SUGGESTIONS).map((s) => <option key={s} value={s} />)}
                </datalist>
              </Field>
            </div>
            <div style={twoCol}>
              <Field label="Vendor">
                <input value={f.vendor} onChange={(ev) => set('vendor', ev.target.value)} style={input} />
              </Field>
              <Field label="Payment method">
                <select value={f.paymentMethod} onChange={(ev) => set('paymentMethod', ev.target.value)} style={input}>
                  <option value="">—</option>
                  {PAYMENT_METHOD_ORDER.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
                </select>
              </Field>
            </div>
            <div style={twoCol}>
              <Field label="Paid by">
                <select value={f.paidBy} onChange={(ev) => set('paidBy', ev.target.value)} style={input}>
                  <option value="">—</option>
                  {PAID_BY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Link to job (booking ID)">
                <input value={f.bookingId} onChange={(ev) => set('bookingId', ev.target.value)} placeholder="blank = general" style={input} />
              </Field>
            </div>
            <Field label="Business purpose">
              <input value={f.purpose} onChange={(ev) => set('purpose', ev.target.value)} style={input} />
            </Field>
            <Field label="Notes">
              <textarea value={f.notes} onChange={(ev) => set('notes', ev.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} />
            </Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', color: COLORS.ink, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.reimbursable} onChange={(ev) => set('reimbursable', ev.target.checked)} />
              Reimbursable
            </label>
            {reasonRequired && (
              <Field label="Reason for adjustment *" hint="this expense is finalized — the change is logged">
                <input value={f.adjustmentReason} onChange={(ev) => set('adjustmentReason', ev.target.value)} style={{ ...input, borderColor: COLORS.amber }} />
              </Field>
            )}
            <div style={actionBar}>
              <button onClick={save} disabled={saving} style={{ ...editBtn, backgroundColor: COLORS.orange, color: '#fff', borderColor: COLORS.orange, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save changes'}</button>
              <button onClick={() => { setEditing(false); setMsg('') }} style={editBtn}>Cancel</button>
            </div>
          </div>
        )}

        {msg && <div style={{ marginTop: '10px', fontSize: '13px', fontWeight: 600, color: msg.includes('✓') ? COLORS.green : COLORS.red }}>{msg}</div>}
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '7px 0', borderBottom: `1px solid ${COLORS.line}` }}>
      <dt style={{ fontSize: '12px', color: COLORS.muted, fontWeight: 600 }}>{label}</dt>
      <dd style={{ fontSize: '13px', color: COLORS.ink, margin: 0, textAlign: 'right' }}>{children}</dd>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: COLORS.muted }}>{label}{hint && <span style={{ fontWeight: 400, color: COLORS.faint }}> — {hint}</span>}</span>
      {children}
    </label>
  )
}

const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, backgroundColor: 'rgba(10,22,40,0.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }
const panel: React.CSSProperties = { width: 'min(480px, 100%)', height: '100%', backgroundColor: '#fff', boxShadow: '-8px 0 32px rgba(0,0,0,0.18)', padding: '22px 24px', overflowY: 'auto' }
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#9CA3AF', fontSize: '20px', cursor: 'pointer', lineHeight: 1 }
const dl: React.CSSProperties = { margin: 0 }
const sectionLabel: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }
const notesBox: React.CSSProperties = { marginTop: '16px', backgroundColor: '#F9FAFB', border: `1px solid ${COLORS.line}`, borderRadius: '10px', padding: '12px 14px' }
const actionBar: React.CSSProperties = { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '18px', paddingTop: '16px', borderTop: `1px solid ${COLORS.line}` }
const editBtn: React.CSSProperties = { padding: '8px 14px', backgroundColor: '#fff', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', fontWeight: 700, color: '#374151', cursor: 'pointer' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '7px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box', backgroundColor: '#fff' }
const twoCol: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }
