'use client'

// Campaign composer + lifecycle controls.
//
// The button layout mirrors the state machine on purpose: at any moment an
// owner sees only the transitions the server would actually accept. Nothing
// here can move a campaign straight from draft to sending — validate, approve
// and schedule are three separate calls, each independently checked.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Template = { key: string; name: string }
type Audience = { id: string; name: string }

type CampaignRow = {
  id: string
  name: string
  sourceKey: string
  status: string
  allowedTransitions: string[]
  template: string | null
  audienceName: string | null
  scheduledAt: string | null
  approvedByName: string | null
  approvedAt: string | null
  statusNote: string | null
  validation: { ok: boolean; errors: string[]; warnings: string[]; checkedAt: string } | null
}

const C = { navy: '#0A1628', orange: '#FF5A1F', green: '#10B981', red: '#EF4444', amber: '#F59E0B', muted: '#6B7280', faint: '#9CA3AF', line: '#F1F1F1' }

const STATE_COLOR: Record<string, string> = {
  DRAFT: C.faint, VALIDATING: C.amber, READY: C.green, SCHEDULED: '#3B82F6',
  ACTIVE: C.green, PAUSED: C.amber, COMPLETED: C.navy, CANCELLED: C.faint, FAILED: C.red, ARCHIVED: C.faint,
}

export default function CampaignComposer({
  templates,
  audiences,
  campaigns,
}: {
  templates: Template[]
  audiences: Audience[]
  campaigns: CampaignRow[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [form, setForm] = useState({
    name: '', sourceKey: '', template: '', subject: '', audienceId: '',
    scheduledAt: '', utmSource: 'email', utmMedium: 'email', utmCampaign: '', utmContent: '', discountCode: '',
  })

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  async function create() {
    setBusy('create')
    setErrors([])
    try {
      const res = await fetch('/api/admin/email-marketing/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, sourceKey: form.sourceKey, template: form.template,
          subject: form.subject || undefined, audienceId: form.audienceId || undefined,
          scheduledAt: form.scheduledAt || undefined, utmSource: form.utmSource || undefined,
          utmMedium: form.utmMedium || undefined, utmCampaign: form.utmCampaign || undefined,
          utmContent: form.utmContent || undefined, discountCode: form.discountCode || undefined,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setErrors(body.detail ?? [body.error ?? `Failed (${res.status})`])
        return
      }
      setOpen(false)
      setForm({ ...form, name: '', sourceKey: '', template: '', subject: '', audienceId: '', scheduledAt: '', utmCampaign: '', utmContent: '', discountCode: '' })
      router.refresh()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Failed'])
    } finally {
      setBusy(null)
    }
  }

  async function act(id: string, action: string, status?: string) {
    let note: string | undefined
    if (status === 'CANCELLED' || status === 'FAILED') {
      const reason = prompt(`Reason for marking this campaign ${status}?`)
      if (!reason?.trim()) return
      note = reason.trim()
    }
    if (status === 'SCHEDULED' || status === 'ACTIVE') {
      if (!confirm(`Move this campaign to ${status}?\n\nOnce ${status}, it may put email in front of real customers.`)) return
    }
    if (action === 'approve' && !confirm('Approve this campaign for sending?\n\nThis is the owner authorization step and is recorded in the audit log.')) return

    setBusy(id + action + (status ?? ''))
    setErrors([])
    try {
      const res = await fetch('/api/admin/email-marketing/campaigns', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, status, note }),
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', gap: '12px', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>
          Campaigns
        </h3>
        <button onClick={() => setOpen(!open)} style={{ ...btn(false, C.navy), flex: 'none', padding: '8px 16px' }}>
          {open ? 'Cancel' : '+ New campaign draft'}
        </button>
      </div>

      {open && (
        <div style={{ ...card, marginBottom: '18px' }}>
          <p style={{ fontSize: '12px', color: C.muted, margin: '0 0 16px', lineHeight: 1.5 }}>
            This creates a <strong>DRAFT</strong>. Nothing sends until it is validated, approved by an owner, and then
            scheduled — three separate steps.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            <Field label="Campaign name" value={form.name} onChange={(v) => set('name', v)} />
            <Field label="Source key (attribution)" value={form.sourceKey} onChange={(v) => set('sourceKey', v)} placeholder="summer-reengagement" />
            <SelectField label="Template" value={form.template} onChange={(v) => set('template', v)} options={templates.map((t) => ({ value: t.key, label: t.name }))} />
            <SelectField label="Audience" value={form.audienceId} onChange={(v) => set('audienceId', v)} options={audiences.map((a) => ({ value: a.id, label: a.name }))} />
            <Field label="Subject override (optional)" value={form.subject} onChange={(v) => set('subject', v)} />
            <Field label="Scheduled time" type="datetime-local" value={form.scheduledAt} onChange={(v) => set('scheduledAt', v)} />
            <Field label="UTM source" value={form.utmSource} onChange={(v) => set('utmSource', v)} />
            <Field label="UTM medium" value={form.utmMedium} onChange={(v) => set('utmMedium', v)} />
            <Field label="UTM campaign" value={form.utmCampaign} onChange={(v) => set('utmCampaign', v)} placeholder="defaults to the source key" />
            <Field label="UTM content" value={form.utmContent} onChange={(v) => set('utmContent', v)} />
            <Field label="Discount code" value={form.discountCode} onChange={(v) => set('discountCode', v)} />
          </div>
          <button
            onClick={create}
            disabled={!form.name || !form.sourceKey || !form.template || busy !== null}
            style={{ ...btn(!form.name || !form.sourceKey || !form.template || busy !== null, C.orange), marginTop: '14px', maxWidth: '220px' }}
          >
            {busy === 'create' ? 'Creating…' : 'Create draft'}
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <ul style={{ margin: '0 0 14px', paddingLeft: '17px', fontSize: '12px', color: C.red, lineHeight: 1.6 }}>
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      {campaigns.length === 0 ? (
        <p style={{ fontSize: '13px', color: C.faint, fontStyle: 'italic' }}>No email campaigns yet.</p>
      ) : (
        campaigns.map((c) => (
          <div key={c.id} style={{ ...card, marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '10px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '15px', color: C.navy }}>{c.name}</strong>
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 9px', borderRadius: '100px', color: '#FFFFFF', backgroundColor: STATE_COLOR[c.status] ?? C.faint }}>
                    {c.status}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: C.faint, marginTop: '4px', fontFamily: 'ui-monospace, monospace' }}>
                  {c.sourceKey} · {c.template ?? 'no template'} · {c.audienceName ?? 'NO AUDIENCE'}
                </div>
                {c.approvedAt && (
                  <div style={{ fontSize: '11px', color: C.green, marginTop: '4px' }}>
                    Approved by {c.approvedByName ?? 'an owner'}
                  </div>
                )}
                {c.statusNote && <div style={{ fontSize: '11px', color: C.muted, marginTop: '4px' }}>{c.statusNote}</div>}
              </div>
            </div>

            {c.validation && (
              <div style={{ marginBottom: '10px' }}>
                {c.validation.errors.map((e) => (
                  <p key={e} style={{ fontSize: '12px', color: C.red, margin: '0 0 4px' }}>✗ {e}</p>
                ))}
                {c.validation.warnings.map((w) => (
                  <p key={w} style={{ fontSize: '12px', color: C.amber, margin: '0 0 4px' }}>⚠ {w}</p>
                ))}
                {c.validation.ok && c.validation.errors.length === 0 && (
                  <p style={{ fontSize: '12px', color: C.green, margin: 0 }}>✓ Validation passing</p>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
              <SmallBtn onClick={() => act(c.id, 'validate')} busy={busy === c.id + 'validate'}>Validate</SmallBtn>
              {(c.status === 'VALIDATING' || c.status === 'READY') && !c.approvedAt && (
                <SmallBtn onClick={() => act(c.id, 'approve')} busy={busy === c.id + 'approve'} tone={C.green}>Approve</SmallBtn>
              )}
              {c.allowedTransitions.map((t) => (
                <SmallBtn
                  key={t}
                  onClick={() => act(c.id, 'transition', t)}
                  busy={busy === c.id + 'transition' + t}
                  tone={t === 'CANCELLED' || t === 'FAILED' ? C.red : t === 'ACTIVE' || t === 'SCHEDULED' ? C.orange : undefined}
                >
                  {t}
                </SmallBtn>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function SmallBtn({ onClick, children, busy, tone }: { onClick: () => void; children: React.ReactNode; busy: boolean; tone?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        fontSize: '11px', fontWeight: 600, padding: '5px 11px', borderRadius: '6px',
        border: `1px solid ${tone ? `${tone}55` : '#D1D5DB'}`, cursor: busy ? 'default' : 'pointer',
        backgroundColor: busy ? '#F3F4F6' : tone ? `${tone}12` : '#FFFFFF', color: tone ?? '#374151',
      }}
    >
      {busy ? '…' : children}
    </button>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div>
      <p style={fieldLabel}>{label}</p>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={input} />
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
const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '14px', padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `1px solid ${C.line}` }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '8px', border: '1px solid #D1D5DB', fontFamily: 'inherit' }
const fieldLabel: React.CSSProperties = { fontSize: '11px', color: C.muted, margin: '0 0 4px', fontWeight: 600 }
