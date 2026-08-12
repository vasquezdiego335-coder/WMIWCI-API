'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

// Lead pipeline action island (Stage 2C). The server page computes which
// actions the CURRENT status allows (allowedActionsFor in lead-transitions.ts)
// and passes them down, so this island can never offer an illegal button —
// and the server route re-validates anyway. Every action PATCHes
// /api/admin/leads/[id] and refreshes the server component.

const LOST_REASONS: Array<[string, string]> = [
  ['PRICE_TOO_HIGH', 'Price too high'],
  ['NO_RESPONSE', 'No response'],
  ['DATE_UNAVAILABLE', 'Date unavailable'],
  ['CHOSE_COMPETITOR', 'Chose a competitor'],
  ['NEEDED_IMMEDIATE', 'Needed immediate help'],
  ['OUTSIDE_SERVICE_AREA', 'Outside service area'],
  ['OTHER', 'Other'],
]

export default function LeadActions({
  id,
  actions,
  assignedTo,
}: {
  id: string
  actions: string[]
  assignedTo: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [lostOpen, setLostOpen] = useState(false)
  const [lostReason, setLostReason] = useState('NO_RESPONSE')
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignee, setAssignee] = useState(assignedTo ?? '')

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/admin/leads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error ?? 'Failed')
        return false
      }
      router.refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  const has = (a: string) => actions.includes(a)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {has('mark_contacted') && (
          <button onClick={() => patch({ action: 'mark_contacted' })} disabled={busy} style={{ ...btn, color: '#1D4ED8', borderColor: '#BFDBFE' }}>
            ✓ Mark contacted
          </button>
        )}
        {has('set_follow_up') && (
          <button onClick={() => patch({ action: 'set_follow_up' })} disabled={busy} style={{ ...btn, color: '#B45309', borderColor: '#FDE68A' }}>
            ⏰ Needs follow-up
          </button>
        )}
        {has('mark_lost') && (
          <button onClick={() => { setLostOpen((v) => !v); setAssignOpen(false) }} disabled={busy} style={{ ...btn, color: '#B91C1C', borderColor: '#FECACA' }}>
            Mark lost…
          </button>
        )}
        {has('reopen') && (
          <button onClick={() => patch({ action: 'reopen' })} disabled={busy} style={{ ...btn, color: '#166534', borderColor: '#BBF7D0' }}>
            ↺ Reopen
          </button>
        )}
        {has('assign') && (
          <button onClick={() => { setAssignOpen((v) => !v); setLostOpen(false) }} disabled={busy} style={btn}>
            {assignedTo ? `Assigned: ${assignedTo}` : 'Assign…'}
          </button>
        )}
      </div>

      {lostOpen && (
        <div style={panel}>
          <span style={panelLabel}>Why was this lead lost?</span>
          <select value={lostReason} onChange={(e) => setLostReason(e.target.value)} style={select} disabled={busy}>
            {LOST_REASONS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <button
            onClick={async () => { if (await patch({ action: 'mark_lost', lostReason })) setLostOpen(false) }}
            disabled={busy}
            style={{ ...btn, color: '#FFFFFF', backgroundColor: '#B91C1C', borderColor: '#B91C1C' }}
          >
            Mark lost
          </button>
          <button onClick={() => setLostOpen(false)} disabled={busy} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
        </div>
      )}

      {assignOpen && (
        <div style={panel}>
          <span style={panelLabel}>Assigned to</span>
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Name (blank to unassign)"
            style={input}
            disabled={busy}
            maxLength={120}
          />
          <button
            onClick={async () => { if (await patch({ action: 'assign', assignedTo: assignee.trim() || null })) setAssignOpen(false) }}
            disabled={busy}
            style={{ ...btn, color: '#FFFFFF', backgroundColor: '#0A1628', borderColor: '#0A1628' }}
          >
            Save
          </button>
          <button onClick={() => setAssignOpen(false)} disabled={busy} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
        </div>
      )}

      {err && <span style={{ fontSize: '12px', color: '#EF4444' }}>{err}</span>}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '7px 13px', backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer', color: '#374151' }
const panel: React.CSSProperties = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '10px' }
const panelLabel: React.CSSProperties = { fontSize: '12px', fontWeight: 600, color: '#6B7280' }
const select: React.CSSProperties = { padding: '7px 10px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', backgroundColor: '#FFFFFF' }
const input: React.CSSProperties = { padding: '7px 10px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', minWidth: '200px', outline: 'none' }
