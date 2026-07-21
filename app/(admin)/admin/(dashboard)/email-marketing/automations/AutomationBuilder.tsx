'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Automation = {
  id: string
  name: string
  description: string | null
  status: string
  activeVersion: number | null
  updatedAt: string
  summary: string | null
  invalidReason: string | null
  versions: Array<{ version: number; createdAt: string; createdByName: string | null }>
}

type Vocabulary = {
  triggers: Record<string, string>
  segments: Record<string, string>
  stopRules: Record<string, string>
  lockedStopRules: string[]
  templates: Array<{ key: string; name: string }>
}

const C = { navy: '#0A1628', orange: '#FF5A1F', green: '#10B981', red: '#EF4444', amber: '#F59E0B', blue: '#3B82F6', muted: '#6B7280', faint: '#9CA3AF', line: '#F1F1F1' }

const STATE_COLOR: Record<string, string> = {
  DRAFT: C.faint, VALIDATING: C.amber, TEST: C.blue, ACTIVE: C.green, PAUSED: C.amber, ARCHIVED: C.faint,
}

const HOUR = 3_600_000

export default function AutomationBuilder({ automations, vocabulary, mayEdit }: { automations: Automation[]; vocabulary: Vocabulary; mayEdit: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('')
  const [segment, setSegment] = useState('')
  const [stages, setStages] = useState<Array<{ template: string; hours: string }>>([{ template: '', hours: '24' }])
  const [rules, setRules] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(vocabulary.stopRules).map((k) => [k, true]))
  )

  async function save() {
    setBusy('save')
    setErrors([])
    setNote(null)
    const definition = {
      trigger,
      audience: segment ? { segment, filters: {} } : null,
      stages: stages.map((s, i) => ({ key: `stage-${i + 1}`, template: s.template, delayMs: Math.round(Number(s.hours) * HOUR) })),
      stopRules: rules,
      caps: { perRecipientPerMonth: 0 },
      respectQuietHours: true,
      maxStages: Math.max(stages.length, 1),
    }
    try {
      const res = await fetch('/api/admin/email-marketing/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, definition }),
      })
      const body = await res.json()
      if (!res.ok) {
        setErrors(body.errors ?? [body.error ?? `Save failed (${res.status})`])
        return
      }
      if (body.note) setNote(body.note)
      setOpen(false)
      setName('')
      setTrigger('')
      setSegment('')
      setStages([{ template: '', hours: '24' }])
      router.refresh()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Save failed'])
    } finally {
      setBusy(null)
    }
  }

  async function transition(id: string, status: string) {
    if (status === 'ACTIVE' && !confirm('Activate this automation?\n\nIt will begin scheduling email to real customers when its trigger fires.')) return
    setBusy(id + status)
    setErrors([])
    try {
      const res = await fetch('/api/admin/email-marketing/automations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
      const body = await res.json()
      if (!res.ok) setErrors([body.error ?? `Failed (${res.status})`])
      else router.refresh()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Failed'])
    } finally {
      setBusy(null)
    }
  }

  const NEXT: Record<string, string[]> = {
    DRAFT: ['VALIDATING', 'ARCHIVED'],
    VALIDATING: ['TEST', 'DRAFT'],
    TEST: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
    ACTIVE: ['PAUSED', 'ARCHIVED'],
    PAUSED: ['ACTIVE', 'ARCHIVED'],
    ARCHIVED: [],
  }

  return (
    <div>
      {mayEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '14px' }}>
          <button onClick={() => setOpen(!open)} style={{ ...btn(false, C.navy), width: 'auto', padding: '8px 16px' }}>
            {open ? 'Cancel' : '+ New automation'}
          </button>
        </div>
      )}

      {open && (
        <div style={{ ...card, marginBottom: '18px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px', marginBottom: '14px' }}>
            <Field label="Automation name" value={name} onChange={setName} />
            <SelectField label="Trigger" value={trigger} onChange={setTrigger} options={Object.entries(vocabulary.triggers).map(([v, l]) => ({ value: v, label: l }))} />
            <SelectField label="Audience (optional)" value={segment} onChange={setSegment} options={Object.entries(vocabulary.segments).map(([v, l]) => ({ value: v, label: l }))} />
          </div>

          <p style={fieldLabel}>Stages</p>
          {stages.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: '9px', marginBottom: '9px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: '2 1 200px' }}>
                <SelectField label={`Stage ${i + 1} template`} value={s.template} onChange={(v) => setStages((st) => st.map((x, k) => (k === i ? { ...x, template: v } : x)))} options={vocabulary.templates.map((t) => ({ value: t.key, label: t.name }))} />
              </div>
              <div style={{ flex: '1 1 110px' }}>
                <Field label="Hours after trigger" type="number" value={s.hours} onChange={(v) => setStages((st) => st.map((x, k) => (k === i ? { ...x, hours: v } : x)))} />
              </div>
              {stages.length > 1 && (
                <button onClick={() => setStages((st) => st.filter((_, k) => k !== i))} style={{ ...smallBtn, color: C.red, borderColor: '#FECACA' }}>Remove</button>
              )}
            </div>
          ))}
          <button onClick={() => setStages((st) => [...st, { template: '', hours: '72' }])} style={{ ...smallBtn, marginBottom: '14px' }}>+ Add stage</button>

          <p style={fieldLabel}>Stop rules</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '4px', marginBottom: '14px' }}>
            {Object.entries(vocabulary.stopRules).map(([k, label]) => {
              const locked = vocabulary.lockedStopRules.includes(k)
              return (
                <label key={k} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: locked ? C.faint : '#374151' }}>
                  <input type="checkbox" checked={locked ? true : rules[k]} disabled={locked} onChange={(e) => setRules((r) => ({ ...r, [k]: e.target.checked }))} style={{ marginTop: '2px' }} />
                  <span>{label}{locked ? ' (always on)' : ''}</span>
                </label>
              )
            })}
          </div>

          <button onClick={save} disabled={!name || !trigger || busy !== null} style={{ ...btn(!name || !trigger || busy !== null, C.orange), maxWidth: '240px' }}>
            {busy === 'save' ? 'Saving…' : 'Save as draft version'}
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <ul style={{ margin: '0 0 14px', paddingLeft: '17px', fontSize: '12px', color: C.red, lineHeight: 1.6 }}>
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {note && <p style={{ fontSize: '12px', color: C.amber, marginBottom: '14px', fontWeight: 600 }}>{note}</p>}

      {automations.length === 0 ? (
        <div style={card}><p style={{ fontSize: '13px', color: C.faint, fontStyle: 'italic', margin: 0 }}>No automations yet.</p></div>
      ) : (
        automations.map((a) => (
          <div key={a.id} style={{ ...card, marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap', marginBottom: '6px' }}>
              <strong style={{ fontSize: '15px', color: C.navy }}>{a.name}</strong>
              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 9px', borderRadius: '100px', color: '#FFFFFF', backgroundColor: STATE_COLOR[a.status] ?? C.faint }}>{a.status}</span>
              {a.activeVersion != null && <span style={{ fontSize: '11px', color: C.faint }}>version {a.activeVersion}</span>}
            </div>
            {a.summary && <p style={{ fontSize: '12px', color: C.muted, margin: '0 0 8px' }}>{a.summary}</p>}
            {a.invalidReason && (
              <p style={{ fontSize: '12px', color: C.red, margin: '0 0 8px' }}>
                This stored definition is INVALID and will not run: {a.invalidReason}
              </p>
            )}
            {mayEdit && (
              <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                {(NEXT[a.status] ?? []).map((s) => (
                  <button
                    key={s}
                    onClick={() => transition(a.id, s)}
                    disabled={busy === a.id + s}
                    style={{ ...smallBtn, ...(s === 'ACTIVE' ? { color: C.green, borderColor: '#BBF7D0' } : {}) }}
                  >
                    {busy === a.id + s ? '…' : s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <p style={fieldLabel}>{label}</p>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={input} />
    </div>
  )
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div>
      <p style={fieldLabel}>{label}</p>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={input}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

const btn = (disabled: boolean, bg: string): React.CSSProperties => ({
  width: '100%', padding: '10px', borderRadius: '8px', border: 'none', fontSize: '13px', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', backgroundColor: disabled ? '#E5E7EB' : bg, color: disabled ? C.faint : '#FFFFFF',
})
const smallBtn: React.CSSProperties = { fontSize: '11px', fontWeight: 600, padding: '6px 12px', borderRadius: '6px', border: '1px solid #D1D5DB', backgroundColor: '#FFFFFF', color: '#374151', cursor: 'pointer' }
const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '14px', padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `1px solid ${C.line}` }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '8px', border: '1px solid #D1D5DB', fontFamily: 'inherit' }
const fieldLabel: React.CSSProperties = { fontSize: '11px', color: C.muted, margin: '0 0 4px', fontWeight: 600 }
