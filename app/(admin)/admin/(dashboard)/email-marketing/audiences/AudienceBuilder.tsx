'use client'

// The builder offers ONLY the vocabulary the server accepts. There is no
// free-text query field, because a UI that can express something the validator
// rejects teaches people the validator is the problem.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

type Vocabulary = {
  segments: Record<string, string>
  filters: Record<string, string>
  serviceTypes: string[]
  serviceAreaZones: string[]
  locales: string[]
  maxAudience: number
}

type Saved = {
  id: string
  name: string
  description: string | null
  definition: unknown
  lastPreviewCount: number | null
  lastPreviewAt: string | null
}

type Preview = {
  segmentLabel: string
  totalCandidates: number
  eligible: number
  truncated: boolean
  excluded: Record<string, number>
  sample: Array<{ email: string; name: string | null }>
}

const C = { navy: '#0A1628', orange: '#FF5A1F', green: '#10B981', red: '#EF4444', amber: '#F59E0B', muted: '#6B7280', faint: '#9CA3AF', line: '#F1F1F1' }

const EXCLUSION_LABELS: Record<string, string> = {
  invalidAddress: 'Invalid email address',
  unsubscribed: 'Unsubscribed',
  hardBounce: 'Hard bounce',
  complaint: 'Spam complaint',
  otherSuppression: 'Other suppression',
  marketingOptOut: 'Marketing opt-out',
  duplicate: 'Duplicate address',
}

export default function AudienceBuilder({ vocabulary, saved }: { vocabulary: Vocabulary; saved: Saved[] }) {
  const router = useRouter()
  const [segment, setSegment] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [name, setName] = useState('')

  const definition = () => ({
    segment,
    filters: Object.fromEntries(
      Object.entries(filters)
        .filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => [k, k === 'inactiveDays' ? Number(v) : v])
    ),
  })

  async function call(action: 'preview' | 'save') {
    setBusy(action)
    setErrors([])
    try {
      const res = await fetch('/api/admin/email-marketing/audiences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ action, name: name.trim() || undefined, definition: definition() }),
      })
      const body = await res.json()
      if (!res.ok) {
        setErrors(body.errors ?? [body.error ?? `Request failed (${res.status})`])
        return
      }
      setPreview(body.preview)
      if (action === 'save') {
        setName('')
        router.refresh()
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Request failed'])
    } finally {
      setBusy(null)
    }
  }

  const setFilter = (key: string, value: string) => setFilters((f) => ({ ...f, [key]: value }))

  const filterInput = (key: string) => {
    const label = vocabulary.filters[key]
    if (key === 'serviceType') return <Select key={key} label={label} value={filters[key] ?? ''} options={vocabulary.serviceTypes} onChange={(v) => setFilter(key, v)} />
    if (key === 'serviceAreaZone') return <Select key={key} label={label} value={filters[key] ?? ''} options={vocabulary.serviceAreaZones} onChange={(v) => setFilter(key, v)} />
    if (key === 'locale') return <Select key={key} label={label} value={filters[key] ?? ''} options={vocabulary.locales} onChange={(v) => setFilter(key, v)} />
    if (key === 'movedAfter' || key === 'movedBefore') {
      return <Field key={key} label={label} type="date" value={filters[key] ?? ''} onChange={(v) => setFilter(key, v)} />
    }
    if (key === 'inactiveDays') return <Field key={key} label={label} type="number" value={filters[key] ?? ''} onChange={(v) => setFilter(key, v)} />
    return <Field key={key} label={label} value={filters[key] ?? ''} onChange={(v) => setFilter(key, v)} />
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 400px) 1fr', gap: '18px', alignItems: 'start' }}>
      <div style={card}>
        <Label>Segment</Label>
        <select value={segment} onChange={(e) => { setSegment(e.target.value); setPreview(null) }} style={input}>
          <option value="">Choose a segment…</option>
          {Object.entries(vocabulary.segments).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>

        {segment && (
          <>
            <Label>Filters (all optional)</Label>
            {Object.keys(vocabulary.filters).map(filterInput)}
          </>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
          <button onClick={() => call('preview')} disabled={!segment || busy !== null} style={btn(!segment || busy !== null, C.navy)}>
            {busy === 'preview' ? 'Counting…' : 'Preview audience'}
          </button>
        </div>

        {preview && (
          <>
            <div style={{ height: '1px', backgroundColor: C.line, margin: '16px 0' }} />
            <Label>Save this audience</Label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Audience name" style={input} />
            <button onClick={() => call('save')} disabled={!name.trim() || busy !== null} style={btn(!name.trim() || busy !== null, C.orange)}>
              {busy === 'save' ? 'Saving…' : 'Save audience'}
            </button>
          </>
        )}

        {errors.length > 0 && (
          <ul style={{ margin: '12px 0 0', paddingLeft: '17px', fontSize: '12px', color: C.red, lineHeight: 1.6 }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>

      <div>
        <div style={card}>
          <h3 style={h3}>Who this reaches</h3>
          {!preview && <p style={muted}>Choose a segment and preview it.</p>}
          {preview && (
            <>
              <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '16px' }}>
                <Stat label="Matched" value={preview.totalCandidates} />
                <Stat label="Will receive it" value={preview.eligible} color={C.green} big />
                <Stat label="Excluded" value={preview.totalCandidates - preview.eligible} color={C.amber} />
              </div>

              {preview.truncated && (
                <p style={{ ...muted, color: C.amber, fontWeight: 600 }}>
                  This segment hit the {vocabulary.maxAudience.toLocaleString()} candidate cap. The real audience is
                  larger than the number shown — narrow it with filters before sending.
                </p>
              )}

              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '10px' }}>
                <tbody>
                  {Object.entries(preview.excluded).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ padding: '5px 0', fontSize: '12px', color: v > 0 ? '#374151' : C.faint }}>{EXCLUSION_LABELS[k] ?? k}</td>
                      <td style={{ padding: '5px 0', fontSize: '12px', fontWeight: 700, textAlign: 'right', color: v > 0 ? C.red : C.faint }}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {preview.sample.length > 0 && (
                <>
                  <Label>Sample recipients</Label>
                  <p style={{ ...muted, fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}>
                    {preview.sample.map((s) => s.email).join(', ')}
                  </p>
                </>
              )}
            </>
          )}
        </div>

        <div style={{ ...card, marginTop: '18px' }}>
          <h3 style={h3}>Saved audiences</h3>
          {saved.length === 0 ? (
            <p style={muted}>None saved yet.</p>
          ) : (
            saved.map((s) => (
              <div key={s.id} style={{ padding: '9px 0', borderBottom: `1px solid ${C.line}` }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: C.navy }}>{s.name}</div>
                <div style={{ fontSize: '11px', color: C.faint, marginTop: '3px' }}>
                  {(s.definition as { segment?: string })?.segment ?? 'unknown segment'}
                  {s.lastPreviewCount != null && ` · ${s.lastPreviewCount} eligible at last preview`}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color, big }: { label: string; value: number; color?: string; big?: boolean }) {
  return (
    <div>
      <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.faint, margin: '0 0 4px' }}>{label}</p>
      <p style={{ fontSize: big ? '30px' : '22px', fontWeight: 800, color: color ?? C.navy, margin: 0, lineHeight: 1 }}>{value.toLocaleString()}</p>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <p style={fieldLabel}>{label}</p>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...input, marginBottom: 0 }} />
    </div>
  )
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <p style={fieldLabel}>{label}</p>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...input, marginBottom: 0 }}>
        <option value="">Any</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.faint, margin: '0 0 6px' }}>{children}</p>
}

const btn = (disabled: boolean, bg: string): React.CSSProperties => ({
  flex: 1, padding: '10px', borderRadius: '8px', border: 'none', fontSize: '13px', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', backgroundColor: disabled ? '#E5E7EB' : bg, color: disabled ? C.faint : '#FFFFFF',
})
const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '14px', padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `1px solid ${C.line}` }
const input: React.CSSProperties = { width: '100%', padding: '9px 11px', fontSize: '13px', borderRadius: '8px', border: '1px solid #D1D5DB', marginBottom: '14px', fontFamily: 'inherit' }
const muted: React.CSSProperties = { fontSize: '12px', color: C.muted, margin: '0 0 12px', lineHeight: 1.5 }
const fieldLabel: React.CSSProperties = { fontSize: '11px', color: C.muted, margin: '0 0 4px', fontWeight: 600 }
const h3: React.CSSProperties = { fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 14px' }
