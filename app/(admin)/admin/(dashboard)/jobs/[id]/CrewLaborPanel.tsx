'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

// ════════════════════════════════════════════════════════════════════════════
//  Crew & Labor — the Phase 1 entry surface (owner spec 2026-07-20).
//
//  MOBILE FIRST, deliberately: hours get entered standing next to a truck, not
//  at a desk. Every assignment is a stacked CARD (never a horizontal table),
//  actions are full-size tap targets, and hours use a numeric keypad. The rest
//  of the admin's desktop-only layout is a later phase — this page had to work
//  on a phone now, because that is where the data comes from.
// ════════════════════════════════════════════════════════════════════════════

export type Assignment = {
  id: string
  userId: string
  userName: string
  workerType: string
  role: string
  assignmentStatus: string
  approvalStatus: string
  paymentStatus: string
  payModel: string
  clockIn: string | null
  clockOut: string | null
  breakRunning: boolean
  workedMinutes: number | null
  regularMinutes: number | null
  overtimeMinutes: number | null
  travelMinutes: number | null
  breakMinutes: number | null
  hourlyRateCentsSnapshot: number | null
  flatPayCentsSnapshot: number | null
  economicRateCentsSnapshot: number | null
  driverBonusCents: number | null
  crewLeaderBonusCents: number | null
  otherBonusCents: number | null
  calculatedPayCents: number | null
  approvedPayCents: number | null
  paidCents: number
  cashCostCents: number
  economicValueCents: number
  zeroLaborConfirmed: boolean
  rateSnapshotAt: string | null
  payments: { id: string; amountCents: number; method: string; paidOn: string; voided: boolean; reference: string | null }[]
}

export type StaffOption = { id: string; name: string; role: string; payRateCents: number | null; workerType: string }

const money = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`
const mins = (m: number | null | undefined) => {
  const v = Math.max(0, Math.round(m ?? 0))
  const h = Math.floor(v / 60)
  const r = v % 60
  return h === 0 ? `${r}m` : r === 0 ? `${h}h` : `${h}h ${r}m`
}

const APPROVAL_COLOR: Record<string, string> = {
  DRAFT: '#9CA3AF', SUBMITTED: '#3B82F6', NEEDS_REVIEW: '#F59E0B', APPROVED: '#10B981', REJECTED: '#EF4444',
}
const PAYMENT_COLOR: Record<string, string> = {
  UNPAID: '#F59E0B', PARTIALLY_PAID: '#3B82F6', PAID: '#10B981', VOIDED: '#9CA3AF',
}

export default function CrewLaborPanel({
  bookingId,
  assignments,
  staff,
  isOwner,
  currentUserId,
}: {
  bookingId: string
  assignments: Assignment[]
  staff: StaffOption[]
  isOwner: boolean
  currentUserId: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [openRow, setOpenRow] = useState<string | null>(null)

  async function call(url: string, method: string, body?: unknown, label = 'action') {
    setBusy(label); setError(null); setNotice(null)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Something went wrong.'); return false }
      if (Array.isArray(data.warnings) && data.warnings.length) {
        setNotice(data.warnings.map((w: { message: string }) => w.message).join(' '))
      }
      router.refresh()
      return true
    } catch {
      setError('Network error — nothing was saved.')
      return false
    } finally {
      setBusy(null)
    }
  }

  const totalCash = assignments.filter((a) => a.approvalStatus === 'APPROVED').reduce((s, a) => s + a.cashCostCents, 0)
  const totalEconomic = assignments.filter((a) => a.approvalStatus === 'APPROVED').reduce((s, a) => s + a.economicValueCents, 0)
  const totalOwed = assignments.filter((a) => a.approvalStatus === 'APPROVED').reduce((s, a) => s + Math.max(0, a.cashCostCents - a.paidCents), 0)

  return (
    <div>
      {error && <div style={alertBox('#FEF2F2', '#FECACA', '#B91C1C')} role="alert">{error}</div>}
      {notice && <div style={alertBox('#FFFBEB', '#FDE68A', '#B45309')}>{notice}</div>}

      {/* Totals */}
      {assignments.length > 0 && (
        <div style={totalsRow}>
          <Total label="Approved labor (cash)" value={money(totalCash)} />
          <Total label="Still owed" value={money(totalOwed)} accent={totalOwed > 0 ? '#F59E0B' : '#10B981'} />
          {totalEconomic !== totalCash && (
            <Total label="Economic value" value={money(totalEconomic)} accent="#6366F1" hint="includes unpaid owner time" />
          )}
        </div>
      )}

      {/* Assignments — stacked cards, never a horizontal table */}
      {assignments.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#9CA3AF', fontStyle: 'italic', margin: '0 0 14px' }}>
          No crew assigned yet. Labor cost for this move is <strong>unknown</strong>, not zero.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
          {assignments.map((a) => {
            const owed = Math.max(0, a.cashCostCents - a.paidCents)
            const clockedIn = !!a.clockIn && !a.clockOut
            const canApprove = isOwner && a.userId !== currentUserId
            return (
              <div key={a.id} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '15px', fontWeight: 700, color: '#0A1628' }}>{a.userName}</span>
                      <Chip color="#6B7280">{a.role.replace(/_/g, ' ')}</Chip>
                      {a.workerType === 'OWNER' && <Chip color="#C9A961">OWNER</Chip>}
                      <Chip color={APPROVAL_COLOR[a.approvalStatus] ?? '#9CA3AF'}>{a.approvalStatus.replace(/_/g, ' ')}</Chip>
                      {a.approvalStatus === 'APPROVED' && <Chip color={PAYMENT_COLOR[a.paymentStatus] ?? '#9CA3AF'}>{a.paymentStatus.replace(/_/g, ' ')}</Chip>}
                      {clockedIn && <Chip color="#EF4444">{a.breakRunning ? 'ON BREAK' : 'CLOCKED IN'}</Chip>}
                    </div>
                    <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '4px' }}>
                      {a.zeroLaborConfirmed
                        ? '$0 labor confirmed'
                        : a.payModel === 'UNPAID_OWNER'
                          ? `Unpaid owner labor · valued at ${money(a.economicRateCentsSnapshot)}/h`
                          : a.payModel === 'FLAT'
                            ? `Flat ${money(a.flatPayCentsSnapshot)}`
                            : `${money(a.hourlyRateCentsSnapshot)}/h`}
                      {a.rateSnapshotAt && <span title="Rate locked at assignment; later profile changes do not affect this move."> · rate locked</span>}
                    </div>
                    <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '2px' }}>
                      {mins(a.workedMinutes)} worked
                      {(a.overtimeMinutes ?? 0) > 0 && ` · ${mins(a.overtimeMinutes)} OT`}
                      {(a.travelMinutes ?? 0) > 0 && ` · ${mins(a.travelMinutes)} travel`}
                      {(a.breakMinutes ?? 0) > 0 && ` · ${mins(a.breakMinutes)} break`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: '17px', fontWeight: 800, color: '#0A1628', fontVariantNumeric: 'tabular-nums' }}>
                      {money(a.approvedPayCents ?? a.calculatedPayCents)}
                    </div>
                    {a.approvalStatus !== 'APPROVED' && <div style={{ fontSize: '10px', color: '#B45309' }}>not yet a cost</div>}
                    {owed > 0 && a.approvalStatus === 'APPROVED' && <div style={{ fontSize: '11px', color: '#F59E0B' }}>{money(owed)} owed</div>}
                    {a.paidCents > 0 && <div style={{ fontSize: '11px', color: '#10B981' }}>{money(a.paidCents)} paid</div>}
                  </div>
                </div>

                {/* Clock actions — big tap targets */}
                <div style={actionRow}>
                  {!a.clockIn && (
                    <Btn primary onClick={() => call(`/api/admin/crew-assignments/${a.id}/clock`, 'POST', { action: 'CLOCK_IN' }, a.id)} busy={busy === a.id}>▶ Clock in</Btn>
                  )}
                  {clockedIn && !a.breakRunning && (
                    <>
                      <Btn onClick={() => call(`/api/admin/crew-assignments/${a.id}/clock`, 'POST', { action: 'BREAK_START' }, a.id)} busy={busy === a.id}>⏸ Break</Btn>
                      <Btn primary onClick={() => call(`/api/admin/crew-assignments/${a.id}/clock`, 'POST', { action: 'CLOCK_OUT' }, a.id)} busy={busy === a.id}>⏹ Clock out</Btn>
                    </>
                  )}
                  {clockedIn && a.breakRunning && (
                    <Btn primary onClick={() => call(`/api/admin/crew-assignments/${a.id}/clock`, 'POST', { action: 'BREAK_END' }, a.id)} busy={busy === a.id}>▶ End break</Btn>
                  )}
                  <Btn onClick={() => setOpenRow(openRow === a.id ? null : a.id)}>{openRow === a.id ? 'Close' : '✎ Hours & pay'}</Btn>
                  {a.approvalStatus === 'DRAFT' && !clockedIn && (
                    <Btn onClick={() => call(`/api/admin/crew-assignments/${a.id}/approval`, 'POST', { action: 'SUBMIT' }, a.id)} busy={busy === a.id}>Submit hours</Btn>
                  )}
                  {canApprove && ['SUBMITTED', 'NEEDS_REVIEW'].includes(a.approvalStatus) && (
                    <Btn primary onClick={() => call(`/api/admin/crew-assignments/${a.id}/approval`, 'POST', { action: 'APPROVE' }, a.id)} busy={busy === a.id}>✓ Approve</Btn>
                  )}
                </div>

                {openRow === a.id && (
                  <RowEditor
                    a={a}
                    isOwner={isOwner}
                    canApprove={canApprove}
                    onCall={call}
                    busy={busy}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add crew */}
      {showAdd ? (
        <AddCrewForm bookingId={bookingId} staff={staff} assigned={assignments.map((a) => a.userId)} isOwner={isOwner} onDone={() => setShowAdd(false)} busy={busy} />
      ) : (
        <Btn primary wide onClick={() => setShowAdd(true)}>+ Add crew member</Btn>
      )}
    </div>
  )
}

// ── Row editor: hours, bonuses, approval, payment, $0 confirmation ──────────
function RowEditor({
  a, isOwner, canApprove, onCall, busy,
}: {
  a: Assignment
  isOwner: boolean
  canApprove: boolean
  onCall: (url: string, method: string, body?: unknown, label?: string) => Promise<boolean>
  busy: string | null
}) {
  const [hours, setHours] = useState(a.workedMinutes ? (a.workedMinutes / 60).toFixed(2) : '')
  const [breakM, setBreakM] = useState(a.breakMinutes ? String(a.breakMinutes) : '')
  const [travelM, setTravelM] = useState(a.travelMinutes ? String(a.travelMinutes) : '')
  const [bonus, setBonus] = useState(a.otherBonusCents ? (a.otherBonusCents / 100).toFixed(2) : '')
  const [bonusReason, setBonusReason] = useState('')
  const [reason, setReason] = useState('')
  const [payAmt, setPayAmt] = useState('')
  const [payMethod, setPayMethod] = useState('CASH')

  const owed = Math.max(0, a.cashCostCents - a.paidCents)

  return (
    <div style={editor}>
      <Section title="Hours">
        <div style={fieldGrid}>
          <Field label="Hours worked">
            <input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="8" style={input} />
          </Field>
          <Field label="Break (min)">
            <input inputMode="numeric" value={breakM} onChange={(e) => setBreakM(e.target.value)} placeholder="30" style={input} />
          </Field>
          <Field label="Travel (min)">
            <input inputMode="numeric" value={travelM} onChange={(e) => setTravelM(e.target.value)} placeholder="0" style={input} />
          </Field>
        </div>
        <Btn
          busy={busy === a.id}
          onClick={() =>
            onCall(`/api/admin/crew-assignments/${a.id}`, 'PATCH', {
              workedHours: hours === '' ? null : Number(hours),
              actualBreakMinutes: breakM === '' ? null : Number(breakM),
              travelMinutes: travelM === '' ? null : Number(travelM),
              timeAdjustReason: reason || undefined,
            }, a.id)
          }
        >Save hours</Btn>
      </Section>

      <Section title="Bonus">
        <div style={fieldGrid}>
          <Field label="Other bonus ($)">
            <input inputMode="decimal" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="0.00" style={input} />
          </Field>
          <Field label="Reason">
            <input value={bonusReason} onChange={(e) => setBonusReason(e.target.value)} placeholder="Heavy piano carry" style={input} />
          </Field>
        </div>
        <Btn
          busy={busy === a.id}
          onClick={() =>
            onCall(`/api/admin/crew-assignments/${a.id}`, 'PATCH', {
              otherBonusCents: bonus === '' ? null : Math.round(Number(bonus) * 100),
              otherBonusReason: bonusReason || null,
            }, a.id)
          }
        >Save bonus</Btn>
      </Section>

      {/* Approval */}
      {canApprove && (
        <Section title="Approval">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required to reject, reopen or adjust)" style={{ ...input, width: '100%' }} />
          <div style={actionRow}>
            {['SUBMITTED', 'NEEDS_REVIEW', 'DRAFT'].includes(a.approvalStatus) && (
              <Btn primary busy={busy === a.id} onClick={() => onCall(`/api/admin/crew-assignments/${a.id}/approval`, 'POST', { action: 'APPROVE', reason: reason || undefined }, a.id)}>✓ Approve {money(a.calculatedPayCents)}</Btn>
            )}
            {a.approvalStatus !== 'REJECTED' && (
              <Btn danger busy={busy === a.id} onClick={() => onCall(`/api/admin/crew-assignments/${a.id}/approval`, 'POST', { action: 'REJECT', reason }, a.id)}>Reject</Btn>
            )}
            {a.approvalStatus === 'APPROVED' && (
              <Btn busy={busy === a.id} onClick={() => onCall(`/api/admin/crew-assignments/${a.id}/approval`, 'POST', { action: 'REOPEN', reason }, a.id)}>Reopen</Btn>
            )}
          </div>
        </Section>
      )}
      {isOwner && a.userId && !canApprove && (
        <p style={{ fontSize: '11px', color: '#B45309', margin: '6px 0 0' }}>
          You cannot approve your own labor — the other owner must approve it.
        </p>
      )}

      {/* Payment */}
      {a.approvalStatus === 'APPROVED' && owed > 0 && (
        <Section title={`Record payment · ${money(owed)} owed`}>
          <div style={fieldGrid}>
            <Field label="Amount ($)">
              <input inputMode="decimal" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} placeholder={(owed / 100).toFixed(2)} style={input} />
            </Field>
            <Field label="Method">
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} style={input}>
                {['CASH', 'ZELLE', 'VENMO', 'CASHAPP', 'CHECK', 'BANK_TRANSFER', 'CARD', 'OTHER'].map((m) => (
                  <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </Field>
          </div>
          <Btn
            primary
            busy={busy === a.id}
            onClick={() =>
              onCall(`/api/admin/crew-assignments/${a.id}/payments`, 'POST', {
                amountCents: Math.round(Number(payAmt || (owed / 100).toFixed(2)) * 100),
                method: payMethod,
              }, a.id)
            }
          >Mark paid</Btn>
        </Section>
      )}

      {a.payments.filter((p) => !p.voided).length > 0 && (
        <Section title="Payments">
          {a.payments.filter((p) => !p.voided).map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '4px 0' }}>
              <span>{money(p.amountCents)} · {p.method} · {new Date(p.paidOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              {isOwner && (
                <button
                  style={linkBtn}
                  onClick={() => {
                    if (!reason.trim()) { alert('Enter a reason in the Approval box before voiding a payment.'); return }
                    onCall(`/api/admin/crew-assignments/${a.id}/payments`, 'DELETE', { paymentId: p.id, reason }, a.id)
                  }}
                >void</button>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* $0 labor — the only route to "complete with no labor cost" */}
      {isOwner && !a.zeroLaborConfirmed && (
        <Section title="Confirm $0 labor">
          <p style={{ fontSize: '11px', color: '#6B7280', margin: '0 0 6px' }}>
            Records a deliberate zero for this person — different from labor that was never entered. Requires a reason and is audited.
          </p>
          <Btn
            busy={busy === a.id}
            onClick={() => {
              if (!reason.trim()) { alert('Enter a reason above first.'); return }
              onCall(`/api/admin/crew-assignments/${a.id}/approval`, 'POST', { action: 'CONFIRM_ZERO', reason }, a.id)
            }}
          >Confirm $0 labor</Btn>
        </Section>
      )}

      <div style={{ marginTop: '10px' }}>
        <Btn
          danger
          busy={busy === a.id}
          onClick={() => {
            if (!reason.trim()) { alert('Enter a reason above first.'); return }
            onCall(`/api/admin/crew-assignments/${a.id}`, 'PATCH', { assignmentStatus: 'CANCELLED', cancelReason: reason }, a.id)
          }}
        >Cancel assignment</Btn>
      </div>
    </div>
  )
}

// ── Add crew ────────────────────────────────────────────────────────────────
function AddCrewForm({
  bookingId, staff, assigned, isOwner, onDone, busy,
}: {
  bookingId: string
  staff: StaffOption[]
  assigned: string[]
  isOwner: boolean
  onDone: () => void
  busy: string | null
}) {
  const router = useRouter()
  const available = staff.filter((s) => !assigned.includes(s.id))
  const [userId, setUserId] = useState(available[0]?.id ?? '')
  const [role, setRole] = useState('CREW_MEMBER')
  const [payModel, setPayModel] = useState('HOURLY')
  const [rate, setRate] = useState('')
  const [flat, setFlat] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Conflicts returned by the server on a refused save. Warnings can be
  // overridden by an OWNER with a written reason; hard blocks cannot.
  const [conflicts, setConflicts] = useState<{ code: string; severity: string; message: string }[]>([])
  const [overrideReason, setOverrideReason] = useState('')

  const worker = staff.find((s) => s.id === userId)
  const profileRate = worker?.payRateCents != null ? (worker.payRateCents / 100).toFixed(2) : null
  const warnings = conflicts.filter((c) => c.severity === 'OVERRIDABLE_WARNING')
  const hardBlocks = conflicts.filter((c) => c.severity === 'HARD_BLOCK')

  async function submit(withOverrides: boolean) {
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/admin/jobs/${bookingId}/crew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          userId,
          role,
          payModel,
          workerType: worker?.workerType,
          hourlyRateCents: payModel === 'HOURLY' && rate ? Math.round(Number(rate) * 100) : undefined,
          flatPayCents: payModel === 'FLAT' && flat ? Math.round(Number(flat) * 100) : undefined,
          dayRateCents: payModel === 'DAY_RATE' && flat ? Math.round(Number(flat) * 100) : undefined,
          ...(withOverrides ? { overrideCodes: warnings.map((w) => w.code), overrideReason } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong.')
        setConflicts(Array.isArray(data.conflicts) ? data.conflicts : [])
        return
      }
      router.refresh()
      onDone()
    } catch {
      setError('Network error — nothing was saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={editor}>
      <div style={fieldGrid}>
        <Field label="Worker">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} style={input}>
            {available.length === 0 && <option value="">Everyone is already assigned</option>}
            {available.map((s) => <option key={s.id} value={s.id}>{s.name}{s.workerType === 'OWNER' ? ' (owner)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)} style={input}>
            {['CREW_MEMBER', 'CREW_LEADER', 'DRIVER', 'HELPER', 'OWNER_OPERATOR', 'OTHER'].map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </Field>
        <Field label="Pay model">
          <select value={payModel} onChange={(e) => setPayModel(e.target.value)} style={input}>
            <option value="HOURLY">Hourly</option>
            <option value="FLAT">Flat pay</option>
            <option value="DAY_RATE">Day rate</option>
            <option value="UNPAID_OWNER">Unpaid owner labor</option>
          </select>
        </Field>
        {payModel === 'HOURLY' && (
          <Field label={`Rate ($/h)${profileRate ? ` · profile ${profileRate}` : ''}`}>
            <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={profileRate ?? '25.00'} style={input} />
          </Field>
        )}
        {(payModel === 'FLAT' || payModel === 'DAY_RATE') && (
          <Field label="Amount ($)">
            <input inputMode="decimal" value={flat} onChange={(e) => setFlat(e.target.value)} placeholder="400.00" style={input} />
          </Field>
        )}
      </div>
      {payModel === 'UNPAID_OWNER' && (
        <p style={{ fontSize: '11px', color: '#B45309', margin: '0 0 8px' }}>
          No cash will be owed. The hours are still valued at the owner economic rate so you can see whether this
          move was profitable on its own.
        </p>
      )}
      <p style={{ fontSize: '11px', color: '#6B7280', margin: '0 0 8px' }}>
        The rate is <strong>locked in</strong> when you assign. Changing a profile rate later will not change what this move cost.
      </p>
      {error && (
        <p style={{ fontSize: '12px', color: '#B91C1C', margin: '0 0 8px' }}>{error}</p>
      )}
      {conflicts.length > 0 && (
        <div style={{ backgroundColor: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }}>
          {hardBlocks.map((c) => (
            <p key={c.code} style={{ fontSize: '12px', color: '#B91C1C', margin: '0 0 4px' }}>⛔ {c.message}</p>
          ))}
          {warnings.map((c) => (
            <p key={c.code} style={{ fontSize: '12px', color: '#92400E', margin: '0 0 4px' }}>⚠ {c.message}</p>
          ))}
          {hardBlocks.length === 0 && warnings.length > 0 && (isOwner ? (
            <div style={{ marginTop: '8px' }}>
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Reason for overriding (required)"
                style={{ ...input, marginBottom: '6px' }}
              />
              <Btn primary busy={saving} onClick={() => submit(true)}>Override & assign anyway</Btn>
            </div>
          ) : (
            <p style={{ fontSize: '11px', color: '#92400E', margin: '4px 0 0' }}>Only an owner can override these warnings.</p>
          ))}
        </div>
      )}
      <div style={actionRow}>
        <Btn primary busy={saving || busy === 'add'} onClick={() => submit(false)}>Assign</Btn>
        <Btn onClick={onDone}>Cancel</Btn>
      </div>
    </div>
  )
}

// ── Presentational bits ─────────────────────────────────────────────────────
function Total({ label, value, accent, hint }: { label: string; value: string; accent?: string; hint?: string }) {
  return (
    <div style={{ flex: '1 1 130px' }}>
      <div style={{ fontSize: '10px', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '17px', fontWeight: 800, color: accent ?? '#0A1628', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: '10px', color: '#9CA3AF' }}>{hint}</div>}
    </div>
  )
}
function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ color, backgroundColor: `${color}18`, border: `1px solid ${color}33`, fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '100px', whiteSpace: 'nowrap' }}>{children}</span>
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>{title}</div>
      {children}
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 130px', minWidth: 0 }}>
      <span style={{ fontSize: '11px', color: '#6B7280' }}>{label}</span>
      {children}
    </label>
  )
}
function Btn({ children, onClick, primary, danger, wide, busy }: { children: React.ReactNode; onClick?: () => void; primary?: boolean; danger?: boolean; wide?: boolean; busy?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        // 44px min height: a real tap target on a phone.
        minHeight: '44px',
        padding: '10px 16px',
        borderRadius: '10px',
        fontSize: '14px',
        fontWeight: 700,
        cursor: busy ? 'wait' : 'pointer',
        border: primary ? 'none' : `1px solid ${danger ? '#FECACA' : '#D1D5DB'}`,
        backgroundColor: primary ? '#FF5A1F' : danger ? '#FEF2F2' : '#FFFFFF',
        color: primary ? '#FFFFFF' : danger ? '#B91C1C' : '#374151',
        opacity: busy ? 0.6 : 1,
        width: wide ? '100%' : undefined,
        fontFamily: 'inherit',
      }}
    >{busy ? '…' : children}</button>
  )
}

const alertBox = (bg: string, border: string, color: string): React.CSSProperties => ({
  backgroundColor: bg, border: `1px solid ${border}`, color, borderRadius: '8px', padding: '10px 12px', fontSize: '13px', marginBottom: '12px',
})
const totalsRow: React.CSSProperties = { display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '10px 0 14px', borderBottom: '1px solid #F3F4F6', marginBottom: '14px' }
const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: '12px', padding: '14px', backgroundColor: '#FFFFFF' }
const actionRow: React.CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }
const editor: React.CSSProperties = { marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed #E5E7EB' }
const fieldGrid: React.CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }
const input: React.CSSProperties = { minHeight: '44px', padding: '10px 12px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '16px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box', backgroundColor: '#fff' }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#EF4444', fontSize: '12px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }
