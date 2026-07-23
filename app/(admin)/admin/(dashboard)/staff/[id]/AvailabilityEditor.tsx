'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EXC_KINDS = ['UNAVAILABLE_FULL', 'UNAVAILABLE_PARTIAL', 'AVAILABLE_OVERRIDE', 'VACATION', 'LEAVE', 'ADMIN_BLOCK']

type Rule = { id: string; dayOfWeek: number; startMinute: number; endMinute: number }
type Exc = { id: string; kind: string; date: string; reason: string | null }

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const toMin = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null }

export default function AvailabilityEditor({ userId, rules, exceptions }: { userId: string; rules: Rule[]; exceptions: Exc[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // rule form
  const [dow, setDow] = useState(1)
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('17:00')
  // exception form
  const [kind, setKind] = useState('UNAVAILABLE_FULL')
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')

  async function post(body: unknown) {
    setBusy(true); setMsg('')
    try {
      const res = await fetch(`/api/admin/staff/${userId}/availability`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeader() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg(j.error ?? 'Could not save.'); return }
      setMsg('Saved ✓'); router.refresh()
    } catch { setMsg('Network error.') } finally { setBusy(false) }
  }
  async function del(id: string, type: 'rule' | 'exception') {
    setBusy(true)
    try {
      await fetch(`/api/admin/staff/${userId}/availability/${id}?type=${type}`, { method: 'DELETE', headers: { ...csrfHeader() } })
      router.refresh()
    } finally { setBusy(false) }
  }

  const addRule = () => {
    const s = toMin(start), e = toMin(end)
    if (s == null || e == null || e <= s) { setMsg('Enter a valid time range.'); return }
    post({ type: 'rule', dayOfWeek: dow, startMinute: s, endMinute: e })
  }
  const addExc = () => { if (!date) { setMsg('Pick a date.'); return } post({ type: 'exception', kind, date, reason: reason.trim() || null }) }

  if (!open) return <button onClick={() => setOpen(true)} style={{ ...btn, marginTop: '12px' }}>Edit availability</button>

  return (
    <div style={{ marginTop: '14px', borderTop: '1px solid #F1F1F1', paddingTop: '14px' }}>
      {msg && <div style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444', marginBottom: '8px' }}>{msg}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '18px' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', marginBottom: '8px' }}>Add weekly block</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <select value={dow} onChange={(e) => setDow(Number(e.target.value))} style={input}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
            <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="08:00" style={{ ...input, width: '80px' }} />
            <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="17:00" style={{ ...input, width: '80px' }} />
            <button onClick={addRule} disabled={busy} style={{ ...btn, backgroundColor: '#0A1628', color: '#fff', borderColor: '#0A1628' }}>Add</button>
          </div>
          <div style={{ marginTop: '8px' }}>
            {rules.map((r) => (
              <div key={r.id} style={row}>
                <span>{DAYS[r.dayOfWeek]} {hhmm(r.startMinute)}–{hhmm(r.endMinute)}</span>
                <button onClick={() => del(r.id, 'rule')} style={del_} disabled={busy}>remove</button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', marginBottom: '8px' }}>Add date exception</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={input}>{EXC_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} />
            <button onClick={addExc} disabled={busy} style={{ ...btn, backgroundColor: '#0A1628', color: '#fff', borderColor: '#0A1628' }}>Add</button>
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" style={{ ...input, width: '100%', marginTop: '6px', boxSizing: 'border-box' }} />
          <div style={{ marginTop: '8px' }}>
            {exceptions.map((e) => (
              <div key={e.id} style={row}>
                <span>{e.date} · {e.kind.replace(/_/g, ' ').toLowerCase()}</span>
                <button onClick={() => del(e.id, 'exception')} style={del_} disabled={busy}>remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <button onClick={() => setOpen(false)} style={{ ...btn, color: '#6B7280', marginTop: '12px' }}>Done</button>
    </div>
  )
}

const input: React.CSSProperties = { padding: '7px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit' }
const btn: React.CSSProperties = { padding: '7px 12px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#374151', padding: '3px 0' }
const del_: React.CSSProperties = { background: 'none', border: 'none', color: '#EF4444', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit' }
