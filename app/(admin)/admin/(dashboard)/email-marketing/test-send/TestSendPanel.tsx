'use client'

// Preview → validate → send. The preview and the send use the SAME server
// render, so what an owner approves on screen is what leaves the building.

import { useState } from 'react'
import { csrfHeader } from '../../_client'

type Template = { key: string; name: string; emailClass: string; category: string }

type Preview = {
  subject: string
  html: string
  text: string
  emailClass: string
  requiredVariables: string[]
  missingVariables: string[]
  complianceMissing: string[]
  payload: Record<string, unknown>
}

type SendResult = {
  sent: boolean
  subject?: string
  recipient?: string
  isOverride?: boolean
  provider?: { id: string } | null
  reason?: string | null
  explanation?: string | null
  ledger?: Record<string, unknown> | null
  error?: string
}

const C = { navy: '#0A1628', orange: '#FF5A1F', green: '#10B981', red: '#EF4444', amber: '#F59E0B', muted: '#6B7280', faint: '#9CA3AF', line: '#F1F1F1' }

export default function TestSendPanel({ templates, configuredRecipient }: { templates: Template[]; configuredRecipient: string | null }) {
  const [template, setTemplate] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [view, setView] = useState<'html' | 'text'>('html')
  const [recipient, setRecipient] = useState(configuredRecipient ?? '')
  const [override, setOverride] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SendResult | null>(null)

  const usingOverride = override && recipient.trim().toLowerCase() !== (configuredRecipient ?? '').toLowerCase()

  async function loadPreview(key: string) {
    setTemplate(key)
    setPreview(null)
    setResult(null)
    setError(null)
    if (!key) return
    setBusy('preview')
    try {
      const res = await fetch(`/api/admin/email-marketing/test-send?template=${encodeURIComponent(key)}`)
      const body = await res.json()
      if (!res.ok) setError(body.error ?? `Preview failed (${res.status})`)
      else setPreview(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed')
    } finally {
      setBusy(null)
    }
  }

  async function send() {
    if (!template) return
    const target = recipient.trim() || configuredRecipient || ''
    if (!confirm(`Send a [TEST] ${template} email to ${target}?`)) return
    setBusy('send')
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/admin/email-marketing/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ template, to: target, overrideRecipient: usingOverride }),
      })
      const body = await res.json()
      if (!res.ok) setError(body.error ?? `Send failed (${res.status})`)
      else setResult(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(null)
    }
  }

  const blocked = (preview?.missingVariables.length ?? 0) > 0 || (preview?.complianceMissing.length ?? 0) > 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: '18px', alignItems: 'start' }}>
      {/* ── Controls ── */}
      <div style={card}>
        <Label>Template</Label>
        <select value={template} onChange={(e) => loadPreview(e.target.value)} style={input}>
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name} ({t.emailClass === 'promotional' ? 'promo' : 'txn'})
            </option>
          ))}
        </select>

        <Label>Recipient</Label>
        <input
          type="email"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={!override}
          placeholder={configuredRecipient ?? 'EMAIL_TEST_RECIPIENT is unset'}
          style={{ ...input, backgroundColor: override ? '#FFFFFF' : '#F9FAFB', color: override ? C.navy : C.muted }}
        />
        <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: C.muted, margin: '4px 0 14px' }}>
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} style={{ marginTop: '2px' }} />
          <span>
            Send to a different address
            {usingOverride && (
              <strong style={{ display: 'block', color: C.red, marginTop: '4px' }}>
                This is not the configured test address. Make sure it is not a real customer.
              </strong>
            )}
          </span>
        </label>

        {preview && (
          <>
            <Label>Subject</Label>
            <p style={{ fontSize: '13px', color: C.navy, fontWeight: 600, margin: '0 0 14px', wordBreak: 'break-word' }}>{preview.subject}</p>

            <Label>Required variables</Label>
            {preview.requiredVariables.length === 0 ? (
              <p style={muted}>This template declares none.</p>
            ) : (
              <p style={{ ...muted, fontFamily: 'ui-monospace, monospace' }}>{preview.requiredVariables.join(', ')}</p>
            )}

            {preview.missingVariables.length > 0 && (
              <p style={{ ...muted, color: C.red, fontWeight: 600 }}>Missing: {preview.missingVariables.join(', ')}</p>
            )}
            {preview.complianceMissing.length > 0 && (
              <p style={{ ...muted, color: C.red, fontWeight: 600 }}>
                Promotional compliance unconfigured: {preview.complianceMissing.join(', ')}. The guard would block this
                send.
              </p>
            )}
          </>
        )}

        <button
          onClick={send}
          disabled={!template || busy !== null || blocked}
          style={{
            width: '100%',
            marginTop: '10px',
            padding: '10px',
            borderRadius: '8px',
            border: 'none',
            fontSize: '13px',
            fontWeight: 700,
            cursor: !template || busy !== null || blocked ? 'not-allowed' : 'pointer',
            backgroundColor: !template || busy !== null || blocked ? '#E5E7EB' : C.orange,
            color: !template || busy !== null || blocked ? C.faint : '#FFFFFF',
          }}
        >
          {busy === 'send' ? 'Sending…' : 'Send test email'}
        </button>

        {error && <p style={{ ...muted, color: C.red, marginTop: '10px' }}>{error}</p>}

        {result && (
          <div style={{ marginTop: '14px', padding: '12px', borderRadius: '8px', backgroundColor: result.sent ? '#F0FDF4' : '#FEF2F2', border: `1px solid ${result.sent ? '#BBF7D0' : '#FECACA'}` }}>
            <p style={{ fontSize: '13px', fontWeight: 700, color: result.sent ? '#065F46' : '#B91C1C', margin: '0 0 6px' }}>
              {result.sent ? 'Sent' : 'Not sent'}
            </p>
            {result.provider?.id && (
              <p style={{ ...muted, margin: '0 0 4px', fontFamily: 'ui-monospace, monospace' }}>Provider id: {result.provider.id}</p>
            )}
            {result.reason && <p style={{ ...muted, margin: '0 0 4px' }}>Reason: {result.reason}</p>}
            {result.explanation && <p style={{ ...muted, margin: 0 }}>{result.explanation}</p>}
            {result.ledger && (
              <p style={{ ...muted, marginTop: '6px', fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}>
                Ledger: {String((result.ledger as Record<string, unknown>).status)} · test={String((result.ledger as Record<string, unknown>).isTest)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Preview ── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
          {(['html', 'text'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                fontSize: '12px',
                fontWeight: view === v ? 700 : 500,
                padding: '5px 12px',
                borderRadius: '7px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: view === v ? C.navy : '#F3F4F6',
                color: view === v ? '#FFFFFF' : C.muted,
              }}
            >
              {v === 'html' ? 'HTML' : 'Plain text'}
            </button>
          ))}
        </div>

        {busy === 'preview' && <p style={muted}>Rendering…</p>}
        {!preview && busy !== 'preview' && <p style={muted}>Choose a template to preview it.</p>}

        {preview && view === 'html' && (
          <iframe
            title="Email preview"
            srcDoc={preview.html}
            sandbox=""
            style={{ width: '100%', height: '640px', border: `1px solid ${C.line}`, borderRadius: '8px', backgroundColor: '#FFFFFF' }}
          />
        )}
        {preview && view === 'text' && (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', color: '#374151', backgroundColor: '#F9FAFB', padding: '14px', borderRadius: '8px', maxHeight: '640px', overflow: 'auto', margin: 0 }}>
            {preview.text}
          </pre>
        )}
      </div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.faint, margin: '0 0 6px' }}>
      {children}
    </p>
  )
}

const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '14px', padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `1px solid ${C.line}` }
const input: React.CSSProperties = { width: '100%', padding: '9px 11px', fontSize: '13px', borderRadius: '8px', border: '1px solid #D1D5DB', marginBottom: '14px', fontFamily: 'inherit' }
const muted: React.CSSProperties = { fontSize: '12px', color: C.muted, margin: '0 0 12px', lineHeight: 1.5 }
