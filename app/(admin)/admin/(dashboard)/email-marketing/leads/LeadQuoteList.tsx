'use client'

// The "Mark quoted" worklist — the owner-facing trigger site for quote
// recovery. Calls POST /api/admin/email-marketing/leads/[id]/quote, which is
// idempotent and audited (EMAIL_LEAD_QUOTED).

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type LeadRow = {
  id: string
  name: string
  email: string | null
  phone: string | null
  status: string
  source: string
  jobType: string | null
  moveDate: string | null
  quotedAt: string | null
  estimatedValueCents: number | null
  lastActivityAt: string | null
}

const C = { navy: '#0A1628', orange: '#FF5A1F', green: '#10B981', red: '#EF4444', muted: '#6B7280', faint: '#9CA3AF', line: '#F1F1F1' }

export default function LeadQuoteList({ leads }: { leads: LeadRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function markQuoted(lead: LeadRow) {
    const raw = prompt(
      `Record a REAL quote for ${lead.name}${lead.email ? ` (${lead.email})` : ''}.\n\nEstimated value in dollars (optional — leave blank if quoted verbally):`
    )
    if (raw === null) return
    const dollars = raw.trim() === '' ? null : Number(raw.trim().replace(/[^0-9.]/g, ''))
    if (dollars !== null && (!Number.isFinite(dollars) || dollars <= 0)) {
      setError('The estimated value must be a positive dollar amount, or blank.')
      return
    }
    setBusy(lead.id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/admin/email-marketing/leads/${lead.id}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dollars !== null ? { estimatedValueCents: Math.round(dollars * 100) } : {}),
      })
      const body = await res.json()
      if (!res.ok) setError(body.error ?? `Failed (${res.status})`)
      else {
        setNotice(
          body.followupStarted
            ? 'Quote recorded — the follow-up sequence is scheduled (and stops on its own if they book).'
            : 'Already quoted earlier — nothing re-fired, the original clock stands.'
        )
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  if (leads.length === 0) {
    return <p style={{ fontSize: '13px', color: C.faint, fontStyle: 'italic' }}>No open leads right now.</p>
  }

  return (
    <div style={{ backgroundColor: '#FFF', borderRadius: '14px', border: `1px solid ${C.line}`, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
      {error && <p style={{ fontSize: '12px', color: C.red, padding: '12px 18px 0' }}>{error}</p>}
      {notice && <p style={{ fontSize: '12px', color: C.green, padding: '12px 18px 0' }}>{notice}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: C.muted, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <th style={th}>Lead</th>
              <th style={th}>Status</th>
              <th style={th}>Job</th>
              <th style={th}>Move date</th>
              <th style={th}>Quote</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={td}>
                  <strong style={{ color: C.navy }}>{l.name}</strong>
                  <div style={{ fontSize: '11px', color: C.faint }}>{l.email ?? l.phone ?? 'no contact'}</div>
                </td>
                <td style={td}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: l.status === 'QUOTE_SENT' ? C.green : C.muted }}>{l.status}</span>
                  <div style={{ fontSize: '10px', color: C.faint }}>{l.source}</div>
                </td>
                <td style={td}>{l.jobType ?? '—'}</td>
                <td style={td}>{l.moveDate ? new Date(l.moveDate).toLocaleDateString() : '—'}</td>
                <td style={td}>
                  {l.quotedAt ? (
                    <span style={{ color: C.green, fontSize: '12px' }}>
                      ✓ {new Date(l.quotedAt).toLocaleDateString()}
                      {l.estimatedValueCents ? ` · $${(l.estimatedValueCents / 100).toFixed(0)}` : ''}
                    </span>
                  ) : (
                    <span style={{ color: C.faint, fontSize: '12px' }}>not quoted</span>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {!l.quotedAt && l.email && (
                    <button
                      onClick={() => markQuoted(l)}
                      disabled={busy === l.id}
                      style={{
                        fontSize: '11px', fontWeight: 700, padding: '6px 12px', borderRadius: '7px',
                        border: 'none', cursor: busy === l.id ? 'default' : 'pointer',
                        backgroundColor: busy === l.id ? '#F3F4F6' : C.orange, color: busy === l.id ? C.faint : '#FFF',
                      }}
                    >
                      {busy === l.id ? '…' : 'Mark quoted'}
                    </button>
                  )}
                  {!l.email && <span style={{ fontSize: '11px', color: C.faint }}>no email — no sequence</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '12px 18px', fontWeight: 700 }
const td: React.CSSProperties = { padding: '12px 18px', verticalAlign: 'top' }
