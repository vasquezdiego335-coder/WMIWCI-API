'use client'

// ════════════════════════════════════════════════════════════════════════
//  ScopePanel — where the owner ANSWERS the questions the scope block asks.
//
//  Owner spec 2026-08-14 (booking WMIC-1019). Before this, the only way to
//  fix a customer who picked 1 Bedroom for a two-bedroom load was to cancel
//  and make them book again — losing the $49 authorization, the signed
//  agreement, the attribution and the history along with it.
//
//  THE PRICE NEVER MOVES SILENTLY. Changing the size changes the flat rate,
//  so the first save is REFUSED by the API with the exact before/after
//  figures; this panel shows them and asks. Only a second, deliberate
//  confirmation carries `approvePriceChange`, and the API records who agreed
//  to it. There is no path through this UI that changes what a customer pays
//  without an owner reading the new number first.
// ════════════════════════════════════════════════════════════════════════

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

const SIZES: { key: string; label: string }[] = [
  { key: 'little-studio', label: 'Small Studio' },
  { key: 'half-studio', label: 'Standard Studio' },
  { key: 'full-studio', label: 'Large Studio' },
  { key: '1br', label: '1 Bedroom' },
  { key: '2br', label: '2 Bedrooms' },
  { key: '3br', label: '3 Bedrooms' },
  { key: '4br', label: '4 Bedrooms' },
  { key: '5br', label: '5 Bedrooms' },
]

const COI = [
  { key: 'unknown', label: 'Unknown' },
  { key: 'yes', label: 'Yes — required' },
  { key: 'no', label: 'No' },
]

export type ScopePanelProps = {
  bookingId: string
  moveSizeKey: string | null
  suggestedSizeKey: string | null
  serviceTypeKey: string
  disassemblyItems: string | null
  assemblyItems: string | null
  coiRequiredOrigin: string | null
  coiRequiredDest: string | null
  originUnit: string | null
  destUnit: string | null
  inventoryReviewRequired: boolean
}

export default function ScopePanel(p: ScopePanelProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  /** Set when the API refuses a price change; holds the sentence to agree to. */
  const [pricePrompt, setPricePrompt] = useState<string | null>(null)

  const [moveSizeKey, setMoveSizeKey] = useState(p.moveSizeKey ?? '')
  const [reason, setReason] = useState('')
  const [serviceTypeKey, setServiceTypeKey] = useState(p.serviceTypeKey)
  const [disassemblyItems, setDisassemblyItems] = useState(p.disassemblyItems ?? '')
  const [assemblyItems, setAssemblyItems] = useState(p.assemblyItems ?? '')
  const [coiOrigin, setCoiOrigin] = useState(p.coiRequiredOrigin ?? 'unknown')
  const [coiDest, setCoiDest] = useState(p.coiRequiredDest ?? 'unknown')
  const [originUnit, setOriginUnit] = useState(p.originUnit ?? '')
  const [destUnit, setDestUnit] = useState(p.destUnit ?? '')

  const sizeChanged = moveSizeKey !== (p.moveSizeKey ?? '')

  async function save(approvePriceChange = false) {
    setMsg('')
    if (sizeChanged && reason.trim().length < 3) {
      setMsg('Say why the size is changing — it goes on the record.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/bookings/${p.bookingId}/scope`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          ...(sizeChanged ? { moveSizeKey, reason: reason.trim() } : {}),
          ...(serviceTypeKey !== p.serviceTypeKey ? { serviceTypeKey } : {}),
          disassemblyItems: disassemblyItems.trim(),
          assemblyItems: assemblyItems.trim(),
          coiRequiredOrigin: coiOrigin,
          coiRequiredDest: coiDest,
          originUnit: originUnit.trim(),
          destUnit: destUnit.trim(),
          ...(approvePriceChange ? { approvePriceChange: true } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))

      // 409 = the API is refusing to move a customer's price without a yes.
      if (res.status === 409 && d.error === 'price_change_requires_approval') {
        setPricePrompt(d.message ?? 'This changes what the customer pays. Approve?')
        return
      }
      if (!res.ok) {
        setMsg(d.error ?? 'Could not save')
        return
      }
      setPricePrompt(null)
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
      <button onClick={() => setOpen(true)} style={btn}>
        {p.inventoryReviewRequired ? '⚠️ Review scope & size' : '✎ Edit scope'}
      </button>
    )
  }

  return (
    <div style={wrap}>
      <Field label="Move size">
        <select value={moveSizeKey} onChange={(e) => setMoveSizeKey(e.target.value)} style={input}>
          <option value="">Not selected</option>
          {SIZES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
              {s.key === p.suggestedSizeKey ? ' — suggested by the inventory' : ''}
            </option>
          ))}
        </select>
      </Field>

      {sizeChanged && (
        <Field label="Why is the size changing?">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Inventory is a 2-bedroom load — customer confirmed by phone"
            style={input}
          />
        </Field>
      )}

      <Field label="Service type">
        <select value={serviceTypeKey} onChange={(e) => setServiceTypeKey(e.target.value)} style={input}>
          <option value="labor_only">Labor Only — customer supplies the truck</option>
          <option value="full_service">Full Service — we bring the truck</option>
        </select>
      </Field>

      <Field label="Items needing DISASSEMBLY">
        <input value={disassemblyItems} onChange={(e) => setDisassemblyItems(e.target.value)} placeholder="Both bed frames, dining table" style={input} />
      </Field>
      <Field label="Items needing REASSEMBLY">
        <input value={assemblyItems} onChange={(e) => setAssemblyItems(e.target.value)} placeholder="Both bed frames" style={input} />
      </Field>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Field label="COI — pickup building">
          <select value={coiOrigin} onChange={(e) => setCoiOrigin(e.target.value)} style={input}>
            {COI.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="COI — destination building">
          <select value={coiDest} onChange={(e) => setCoiDest(e.target.value)} style={input}>
            {COI.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Field label="Pickup unit"><input value={originUnit} onChange={(e) => setOriginUnit(e.target.value)} placeholder="443A" style={input} /></Field>
        <Field label="Destination unit"><input value={destUnit} onChange={(e) => setDestUnit(e.target.value)} placeholder="427" style={input} /></Field>
      </div>

      {/* THE price gate. Nothing here saves a new customer total until this
          exact sentence has been read and agreed to. */}
      {pricePrompt && (
        <div style={priceBox}>
          <div style={{ fontWeight: 700, marginBottom: '6px' }}>This changes what the customer pays</div>
          <div style={{ marginBottom: '10px' }}>{pricePrompt}</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => save(true)} disabled={saving} style={{ ...btn, backgroundColor: '#B45309', color: '#FFFFFF', borderColor: '#B45309' }}>
              Approve the new price
            </button>
            <button onClick={() => { setPricePrompt(null); setMsg('') }} disabled={saving} style={btn}>Cancel</button>
          </div>
        </div>
      )}

      {msg && <div style={{ fontSize: '12px', color: msg.includes('✓') ? '#047857' : '#B91C1C' }}>{msg}</div>}

      {!pricePrompt && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <button onClick={() => save(false)} disabled={saving} style={{ ...btn, backgroundColor: '#FF5A1F', color: '#FFFFFF', borderColor: '#FF5A1F' }}>
            {saving ? 'Saving…' : 'Save scope'}
          </button>
          <button onClick={() => setOpen(false)} disabled={saving} style={btn}>Cancel</button>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 200px' }}>
      <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{label}</span>
      {children}
    </label>
  )
}

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '14px', marginTop: '10px' }
const input: React.CSSProperties = { padding: '7px 10px', border: '1px solid #D1D5DB', borderRadius: '7px', fontSize: '13px', outline: 'none', width: '100%', backgroundColor: '#FFFFFF' }
const btn: React.CSSProperties = { padding: '7px 14px', backgroundColor: '#FFFFFF', color: '#374151', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }
const priceBox: React.CSSProperties = { backgroundColor: '#FFFBEB', border: '1px solid #FDE68A', borderLeft: '4px solid #B45309', borderRadius: '8px', padding: '12px', fontSize: '13px', color: '#78350F' }
