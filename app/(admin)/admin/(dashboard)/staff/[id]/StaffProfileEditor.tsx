'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'

const SKILLS = ['PACKING', 'FURNITURE_PROTECTION', 'ASSEMBLY', 'HEAVY_ITEMS', 'STAIR_CARRY', 'DRIVING', 'LEAD', 'LOADING', 'UNLOADING']
const STATUSES = ['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'UNAVAILABLE', 'SUSPENDED']

type Initial = {
  phone: string | null; workerStatus: string; skills: string[]
  canDrive: boolean; canDriveCustomerVehicle: boolean; canLeadCrew: boolean
  licenseExpiresAt: string | null; preferredRole: string | null
}

export default function StaffProfileEditor({ userId, isOwnerProfile, initial }: { userId: string; isOwnerProfile: boolean; initial: Initial }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [phone, setPhone] = useState(initial.phone ?? '')
  const [status, setStatus] = useState(initial.workerStatus)
  const [skills, setSkills] = useState<string[]>(initial.skills)
  const [canDrive, setCanDrive] = useState(initial.canDrive)
  const [canDriveCustomer, setCanDriveCustomer] = useState(initial.canDriveCustomerVehicle)
  const [canLead, setCanLead] = useState(initial.canLeadCrew)
  const [license, setLicense] = useState(initial.licenseExpiresAt ?? '')

  const toggleSkill = (s: string) => setSkills((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))

  async function save() {
    setSaving(true); setMsg('')
    try {
      const res = await fetch(`/api/admin/staff/${userId}/profile`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          phone: phone.trim() || null, workerStatus: status, skills, canDrive, canDriveCustomerVehicle: canDriveCustomer,
          canLeadCrew: canLead, licenseExpiresAt: license || null,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg(j.error ?? 'Could not save.'); return }
      setMsg('Saved ✓'); router.refresh(); setOpen(false)
    } catch { setMsg('Network error — nothing saved.') } finally { setSaving(false) }
  }

  if (!open) return <button onClick={() => setOpen(true)} style={btn}>Edit profile, skills & driver status</button>

  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '18px', marginBottom: '16px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
        <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} style={input} /></Field>
        <Field label="Worker status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={input}>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="License expires"><input type="date" value={license} onChange={(e) => setLicense(e.target.value)} style={input} /></Field>
      </div>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <Check label="Can drive" checked={canDrive} onChange={setCanDrive} />
        <Check label="Can drive customer trucks" checked={canDriveCustomer} onChange={setCanDriveCustomer} />
        <Check label={isOwnerProfile ? 'Can lead' : 'Can lead a crew'} checked={canLead} onChange={setCanLead} />
      </div>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', color: '#9CA3AF', textTransform: 'uppercase', marginBottom: '6px' }}>Skills</div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {SKILLS.map((s) => (
            <button key={s} onClick={() => toggleSkill(s)} style={{ ...chip, backgroundColor: skills.includes(s) ? '#0A1628' : '#fff', color: skills.includes(s) ? '#fff' : '#374151' }}>
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button onClick={save} disabled={saving} style={{ ...btn, backgroundColor: '#0A1628', color: '#fff', borderColor: '#0A1628' }}>{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={() => setOpen(false)} style={{ ...btn, color: '#6B7280' }}>Cancel</button>
        {msg && <span style={{ fontSize: '12px', color: msg.includes('✓') ? '#10B981' : '#EF4444' }}>{msg}</span>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}><span style={{ fontSize: '10px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>{label}</span>{children}</label>
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#374151' }}><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>
}
const input: React.CSSProperties = { padding: '8px 9px', border: '1px solid #D1D5DB', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit' }
const btn: React.CSSProperties = { padding: '8px 13px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginBottom: '16px' }
const chip: React.CSSProperties = { padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: '100px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
