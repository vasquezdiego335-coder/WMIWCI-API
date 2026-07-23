'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { csrfHeader } from '../../_client'

// ════════════════════════════════════════════════════════════════════════════
//  Job staffing panel (Stage 5). Client island on the job page. Fetches the
//  live staffing context, shows the roster + conflicts + health, and drives the
//  assignment actions (offer, ack, decline, cancel, driver/lead, complete).
//  Owners staff jobs as OWNER workers here exactly like crew.
// ════════════════════════════════════════════════════════════════════════════

type Ctx = {
  jobStatus: string
  requirement: null | { requiredWorkers: number; requiredDrivers: number; requiresLead: boolean; requiredSkills: string[]; reportTime: string | null; loadingLocation: string | null; unloadingLocation: string | null; workerInstructions: string | null }
  assignments: { id: string; userId: string; name: string; workerType: string; role: string; status: string; isDriver: boolean; isLead: boolean; acknowledged: boolean; reportTime: string | null; rateResolvable: boolean; workedMinutes: number | null; approvalStatus: string }[]
  conflicts: { code: string; severity: string; message: string }[]
  health: { status: string; flags: string[]; liveCount: number; requiredCount: number }
}

const money = (n: number) => n.toFixed(1)
const HEALTH_TONE: Record<string, string> = { READY: '#10B981', FULLY_STAFFED: '#10B981', UNSTAFFED: '#EF4444', CONFLICTED: '#EF4444', OVERSTAFFED: '#C9A961', UNACKNOWLEDGED: '#C9A961' }

export default function JobStaffingPanel({ jobId, isOwner, canManage }: { jobId: string; isOwner: boolean; canManage: boolean }) {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/staffing`, { headers: { ...csrfHeader() } })
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not load staffing.'); return }
      setCtx(await res.json())
    } catch { setErr('Network error loading staffing.') } finally { setLoading(false) }
  }, [jobId])

  useEffect(() => { load() }, [load])

  async function act(assignmentId: string, body: Record<string, unknown>, label: string) {
    setBusy(label); setErr('')
    try {
      const res = await fetch(`/api/admin/crew-assignments/${assignmentId}/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeader() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Warnings can be overridden by an OWNER with a written reason; the
        // server stores the override + audits it. Hard blocks stay blocked.
        const conflicts: { code: string; severity: string; message: string }[] = Array.isArray(j.conflicts) ? j.conflicts : []
        const warnings = conflicts.filter((c) => c.severity === 'OVERRIDABLE_WARNING')
        const hardBlocked = conflicts.some((c) => c.severity === 'HARD_BLOCK')
        if (isOwner && !hardBlocked && warnings.length > 0) {
          const reason = window.prompt(`${warnings.map((w) => w.message).join('\n')}\n\nOverride these warnings? Enter a reason:`)
          if (reason?.trim()) {
            await act(assignmentId, { ...body, overrideCodes: warnings.map((w) => w.code), reason }, label)
            return
          }
        }
        setErr(j.error ?? 'Action failed.'); return
      }
      await load()
    } catch { setErr('Network error.') } finally { setBusy(null) }
  }

  if (loading) return <div style={{ fontSize: '13px', color: '#6B7280', padding: '8px 0' }}>Loading staffing…</div>
  if (err && !ctx) return <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}>{err}</div>
  if (!ctx) return null

  const tone = HEALTH_TONE[ctx.health.status] ?? '#F59E0B'
  const hard = ctx.conflicts.filter((c) => c.severity === 'HARD_BLOCK')
  const warn = ctx.conflicts.filter((c) => c.severity === 'OVERRIDABLE_WARNING')

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <span style={{ ...chip, backgroundColor: tone, color: '#fff' }}>{ctx.health.status.replace(/_/g, ' ')}</span>
        <span style={{ fontSize: '13px', color: '#6B7280' }}>{ctx.health.liveCount}/{ctx.requirement?.requiredWorkers ?? '—'} workers</span>
        <Link href="/admin/scheduling" style={{ fontSize: '12px', color: '#FF5A1F', marginLeft: 'auto' }}>Scheduling board →</Link>
      </div>

      {err && <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}>{err}</div>}
      {!ctx.requirement && <div style={box('#F9FAFB', '#E5E7EB', '#6B7280')}>No staffing requirement is set for this job yet.</div>}
      {hard.length > 0 && <div style={box('#FEF2F2', '#FECACA', '#B91C1C')}><strong>Blocking:</strong><ul style={ul}>{hard.map((c) => <li key={c.code}>{c.message}</li>)}</ul></div>}
      {warn.length > 0 && <div style={box('#FFFBEB', '#FDE68A', '#B45309')}><strong>Warnings:</strong><ul style={ul}>{warn.map((c) => <li key={c.code}>{c.message}</li>)}</ul></div>}

      {ctx.assignments.length === 0 ? (
        <div style={{ fontSize: '13px', color: '#9CA3AF', padding: '10px 0' }}>
          No one is assigned yet. Assign workers (owners as OWNER) from the crew section below or the scheduling board.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {ctx.assignments.map((a) => (
            <div key={a.id} style={{ border: '1px solid #F3F4F6', borderRadius: '10px', padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div>
                  <Link href={`/admin/staff/${a.userId}`} style={{ fontSize: '14px', fontWeight: 700, color: '#0A1628', textDecoration: 'none' }}>{a.name}</Link>
                  <span style={{ fontSize: '11px', color: '#6B7280', marginLeft: '8px' }}>
                    {a.workerType}{a.isDriver ? ' · driver' : ''}{a.isLead ? ' · lead' : ''} · {a.status.toLowerCase()}
                    {a.acknowledged ? ' · ✓ ack' : a.status === 'OFFERED' ? ' · awaiting ack' : ''}
                    {!a.rateResolvable && <span style={{ color: '#B45309' }}> · no rate</span>}
                  </span>
                </div>
                {canManage && a.status !== 'CANCELLED' && a.status !== 'COMPLETED' && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {a.status !== 'OFFERED' && a.status !== 'ACCEPTED' && <Mini busy={busy === `off-${a.id}`} onClick={() => act(a.id, { action: 'OFFER' }, `off-${a.id}`)}>offer</Mini>}
                    {a.status === 'OFFERED' && <Mini busy={busy === `ack-${a.id}`} onClick={() => act(a.id, { action: 'ACKNOWLEDGE' }, `ack-${a.id}`)}>confirm</Mini>}
                    <Mini busy={busy === `drv-${a.id}`} onClick={() => act(a.id, { action: 'SET_DRIVER', isDriver: !a.isDriver }, `drv-${a.id}`)}>{a.isDriver ? 'unset driver' : 'driver'}</Mini>
                    <Mini busy={busy === `lead-${a.id}`} onClick={() => act(a.id, { action: 'SET_LEAD', isLead: !a.isLead }, `lead-${a.id}`)}>{a.isLead ? 'unset lead' : 'lead'}</Mini>
                    <Mini danger busy={busy === `can-${a.id}`} onClick={() => act(a.id, { action: 'CANCEL', reason: 'removed from job' }, `can-${a.id}`)}>remove</Mini>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Mini({ children, onClick, danger, busy }: { children: React.ReactNode; onClick: () => void; danger?: boolean; busy?: boolean }) {
  return <button onClick={onClick} disabled={busy} style={{ padding: '4px 9px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', border: `1px solid ${danger ? '#FECACA' : '#D1D5DB'}`, background: danger ? '#FEF2F2' : '#fff', color: danger ? '#B91C1C' : '#374151', opacity: busy ? 0.6 : 1 }}>{busy ? '…' : children}</button>
}
const box = (bg: string, border: string, color: string): React.CSSProperties => ({ backgroundColor: bg, border: `1px solid ${border}`, borderLeft: `4px solid ${color}`, color, borderRadius: '10px', padding: '10px 12px', fontSize: '13px', marginBottom: '10px', lineHeight: 1.5 })
const ul: React.CSSProperties = { margin: '6px 0 0', paddingLeft: '18px' }
const chip: React.CSSProperties = { fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '100px', letterSpacing: '0.03em' }
