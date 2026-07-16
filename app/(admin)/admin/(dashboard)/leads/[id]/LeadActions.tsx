'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const STATUSES = ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP', 'BOOKED', 'LOST', 'SPAM']
const LOST_REASONS = ['PRICE_TOO_HIGH', 'NO_RESPONSE', 'DATE_UNAVAILABLE', 'CHOSE_COMPETITOR', 'NEEDED_IMMEDIATE', 'OUTSIDE_SERVICE_AREA', 'OTHER']

export default function LeadActions(props: {
  id: string
  status: string
  lostReason: string | null
  assignedTo: string | null
  followUpAt: string | null // ISO or ''
  archived: boolean
  convertedBookingId: string | null
}) {
  const router = useRouter()
  const [status, setStatus] = useState(props.status)
  const [lostReason, setLostReason] = useState(props.lostReason ?? '')
  const [assignedTo, setAssignedTo] = useState(props.assignedTo ?? '')
  const [followUpAt, setFollowUpAt] = useState(props.followUpAt ? props.followUpAt.slice(0, 10) : '')
  const [note, setNote] = useState('')
  const [convertedBookingId, setConvertedBookingId] = useState(props.convertedBookingId ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const isLost = status === 'LOST' || status === 'SPAM'

  async function patch(payload: Record<string, unknown>, okMsg: string) {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch(`/api/admin/leads/${props.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg(data.error || `Error ${res.status}`); return }
      setMsg(okMsg); setNote('')
      router.refresh()
    } catch (e) {
      setMsg('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  const saveDetails = () =>
    patch(
      {
        status,
        lostReason: isLost ? (lostReason || 'OTHER') : null,
        assignedTo: assignedTo.trim() || null,
        followUpAt: followUpAt ? new Date(followUpAt + 'T12:00:00.000Z').toISOString() : null,
      },
      'Saved.',
    )

  return (
    <div style={panel}>
      <h3 style={hdr}>Manage lead</h3>

      <label style={lbl}>Status</label>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={input} disabled={busy}>
        {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
      </select>

      {isLost && (
        <>
          <label style={lbl}>Lost / spam reason</label>
          <select value={lostReason} onChange={(e) => setLostReason(e.target.value)} style={input} disabled={busy}>
            <option value="">Select…</option>
            {LOST_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
          </select>
        </>
      )}

      <label style={lbl}>Assigned to (owner)</label>
      <input value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} placeholder="Diego / Sebastian" style={input} disabled={busy} />

      <label style={lbl}>Follow-up date</label>
      <input type="date" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} style={input} disabled={busy} />

      <button onClick={saveDetails} style={primaryBtn} disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>

      <hr style={hr} />

      <label style={lbl}>Add an internal note</label>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} placeholder="Called, left voicemail…" disabled={busy} />
      <button onClick={() => note.trim() && patch({ appendNote: note.trim() }, 'Note added.')} style={secondaryBtn} disabled={busy || !note.trim()}>Add note</button>

      <hr style={hr} />

      <label style={lbl}>Convert to booking (paste booking ID / reference)</label>
      <input value={convertedBookingId} onChange={(e) => setConvertedBookingId(e.target.value)} placeholder="WMIC-1234 / booking id" style={input} disabled={busy} />
      <button onClick={() => patch({ convertedBookingId: convertedBookingId.trim() || null, status: 'BOOKED' }, 'Linked to booking.')} style={secondaryBtn} disabled={busy}>Mark converted</button>

      <hr style={hr} />

      <button
        onClick={() => patch({ archived: !props.archived }, props.archived ? 'Unarchived.' : 'Archived.')}
        style={props.archived ? secondaryBtn : dangerBtn}
        disabled={busy}
      >
        {props.archived ? 'Unarchive lead' : 'Archive lead'}
      </button>
      <p style={{ fontSize: 11, color: '#9CA3AF', margin: '6px 0 0' }}>Archiving hides the lead but never deletes it.</p>

      {msg && <p style={{ fontSize: 13, color: msg === 'Saved.' || msg.includes('added') || msg.includes('Archived') || msg.includes('Linked') || msg.includes('Unarchived') ? '#166534' : '#B91C1C', marginTop: 12 }}>{msg}</p>}
    </div>
  )
}

const panel: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const hdr: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: '#0A1628', margin: '0 0 14px' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '12px 0 4px' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' }
const primaryBtn: React.CSSProperties = { marginTop: 14, width: '100%', padding: '9px', backgroundColor: '#FF5A1F', color: '#FFF', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const secondaryBtn: React.CSSProperties = { marginTop: 10, width: '100%', padding: '9px', backgroundColor: '#FFFFFF', color: '#374151', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const dangerBtn: React.CSSProperties = { marginTop: 10, width: '100%', padding: '9px', backgroundColor: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const hr: React.CSSProperties = { border: 'none', borderTop: '1px solid #F3F4F6', margin: '16px 0' }
