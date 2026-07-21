'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

// ════════════════════════════════════════════════════════════════════════════
//  Labor-rate editor for one staff profile (Stage 4, D6).
//
//  Owner-only, and rendered only for owners — a crew or manager session never
//  receives these values (the page does not query them, and the API refuses).
//
//  BLANK IS A REAL ANSWER. Every rate field may be left empty, and empty is
//  saved as "not configured" rather than as $0. The form says so, because the
//  difference between "we haven't decided" and "this work is free" is the whole
//  point of the rule.
// ════════════════════════════════════════════════════════════════════════════

export type RateFields = {
  ownerEconomicRateCents: number | null
  payRateCents: number | null
  defaultFlatRateCents: number | null
  defaultPayModel: 'HOURLY' | 'FLAT' | 'DAY_RATE' | null
  rateEffectiveOn: string | null
  rateNotes: string | null
  active: boolean
  canDrive: boolean
  canLeadCrew: boolean
  preferredRole: string | null
  rateUpdatedAt: string | null
  rateUpdatedByName: string | null
}

/** Dollars typed by a human → integer cents. Empty stays EMPTY (null), never 0. */
function toCents(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t.replace(/[$,]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}
const toDollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2))

export default function StaffRates({
  userId, isOwnerProfile, fields,
}: { userId: string; isOwnerProfile: boolean; fields: RateFields }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const [ownerRate, setOwnerRate] = useState(toDollars(fields.ownerEconomicRateCents))
  const [cashRate, setCashRate] = useState(toDollars(fields.payRateCents))
  const [flat, setFlat] = useState(toDollars(fields.defaultFlatRateCents))
  const [payModel, setPayModel] = useState(fields.defaultPayModel ?? '')
  const [effective, setEffective] = useState(fields.rateEffectiveOn?.slice(0, 10) ?? '')
  const [notes, setNotes] = useState(fields.rateNotes ?? '')
  const [active, setActive] = useState(fields.active)
  const [canDrive, setCanDrive] = useState(fields.canDrive)
  const [canLeadCrew, setCanLeadCrew] = useState(fields.canLeadCrew)
  const [preferredRole, setPreferredRole] = useState(fields.preferredRole ?? '')

  async function save() {
    setMsg('')
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/staff/${userId}/rates`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          ownerEconomicRateCents: isOwnerProfile ? toCents(ownerRate) : undefined,
          payRateCents: toCents(cashRate),
          defaultFlatRateCents: toCents(flat),
          defaultPayModel: payModel === '' ? null : payModel,
          rateEffectiveOn: effective === '' ? null : effective,
          rateNotes: notes.trim() === '' ? null : notes.trim(),
          active,
          canDrive,
          canLeadCrew,
          preferredRole: preferredRole.trim() === '' ? null : preferredRole.trim(),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg(json.error ?? 'Could not save.'); return }
      setMsg('Saved ✓')
      router.refresh()
      setOpen(false)
    } catch {
      setMsg('Network error — nothing was saved.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: '#6B7280' }}>
          {isOwnerProfile ? (
            <>Owner labor rate <b>{fields.ownerEconomicRateCents ? `$${toDollars(fields.ownerEconomicRateCents)}/h` : 'Not configured'}</b></>
          ) : (
            <>Pay <b>{fields.payRateCents ? `$${toDollars(fields.payRateCents)}/h` : fields.defaultFlatRateCents ? `$${toDollars(fields.defaultFlatRateCents)} flat` : 'Not configured'}</b></>
          )}
          {fields.rateUpdatedAt && (
            <span style={{ color: '#9CA3AF' }}>
              {' '}· updated {new Date(fields.rateUpdatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {fields.rateUpdatedByName ? ` by ${fields.rateUpdatedByName}` : ''}
            </span>
          )}
        </span>
        <button onClick={() => setOpen(true)} style={btn}>Edit rates</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {isOwnerProfile && (
          <Field label="Owner labor rate $/h" hint="what this hour is worth if hired">
            <input value={ownerRate} onChange={(e) => setOwnerRate(e.target.value)} inputMode="decimal" placeholder="blank = not configured" style={{ ...input, width: '160px' }} />
          </Field>
        )}
        <Field label={isOwnerProfile ? 'Cash labor rate $/h (optional)' : 'Default hourly rate $/h'}>
          <input value={cashRate} onChange={(e) => setCashRate(e.target.value)} inputMode="decimal" placeholder="blank = none" style={{ ...input, width: '150px' }} />
        </Field>
        <Field label="Flat rate $ / move">
          <input value={flat} onChange={(e) => setFlat(e.target.value)} inputMode="decimal" placeholder="blank = none" style={{ ...input, width: '130px' }} />
        </Field>
        <Field label="Pay type">
          <select value={payModel} onChange={(e) => setPayModel(e.target.value as RateFields['defaultPayModel'] extends null ? never : string)} style={{ ...input, width: '120px' }}>
            <option value="">Not set</option>
            <option value="HOURLY">Hourly</option>
            <option value="FLAT">Flat</option>
            <option value="DAY_RATE">Day rate</option>
          </select>
        </Field>
        <Field label="Effective date">
          <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} style={{ ...input, width: '150px' }} />
        </Field>
        {!isOwnerProfile && (
          <Field label="Role">
            <input value={preferredRole} onChange={(e) => setPreferredRole(e.target.value)} placeholder="e.g. Driver" style={{ ...input, width: '130px' }} />
          </Field>
        )}
      </div>

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <Check label="Active" checked={active} onChange={setActive} />
        <Check label="Can drive" checked={canDrive} onChange={setCanDrive} />
        <Check label="Can lead a crew" checked={canLeadCrew} onChange={setCanLeadCrew} />
      </div>

      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this rate, agreed with whom" style={{ ...input, width: '100%', maxWidth: '520px' }} />
      </Field>

      <p style={{ fontSize: '11px', color: '#9CA3AF', margin: 0, lineHeight: 1.5, maxWidth: '620px' }}>
        A blank rate means <strong>not configured</strong> — it is never treated as $0, and it keeps a
        move from being finalized while that person&rsquo;s labor cannot be priced. Changing a rate here
        does <strong>not</strong> change what past moves cost: every assignment froze its own rate when
        the crew was assigned.
      </p>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={save} disabled={saving} style={{ ...btn, backgroundColor: '#0A1628', color: '#fff', borderColor: '#0A1628' }}>{saving ? 'Saving…' : 'Save rates'}</button>
        <button onClick={() => setOpen(false)} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
        {msg && <span style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}{hint && <span style={{ textTransform: 'none', fontWeight: 400 }}> · {hint}</span>}
      </span>
      {children}
    </label>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#374151' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

const input: React.CSSProperties = { padding: '8px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box', fontFamily: 'inherit' }
const btn: React.CSSProperties = { padding: '8px 13px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
