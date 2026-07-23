'use client'

// Delays are edited in HOURS because that is how the business talks about them
// ("the 72h reminder"), and converted to milliseconds on submit. Countdown
// stages keep their sign automatically — asking an owner to type a negative
// number to mean "before the move" is a trap.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type StageType = { type: string; label: string; defaultTemplate: string; isCountdown: boolean }

type Config = {
  enabled: boolean
  stages: Array<{ type: string; template: string; delayMs: number }>
  stopRules: Record<string, boolean>
  caps: { perRecipientPerMonth: number }
  respectQuietHours: boolean
}

type Vocabulary = {
  stopRules: Record<string, string>
  lockedStopRules: string[]
  minDelayMs: number
  maxDelayMs: number
  maxStages: number
}

const C = { navy: '#0A1628', orange: '#FF5A1F', green: '#10B981', red: '#EF4444', muted: '#6B7280', faint: '#9CA3AF', line: '#F1F1F1' }

const HOUR = 3_600_000
const toHours = (ms: number) => Math.round((Math.abs(ms) / HOUR) * 100) / 100

export default function JourneyConfigEditor({
  journeyKey,
  journeyName,
  config,
  version,
  source,
  stageTypes,
  vocabulary,
}: {
  journeyKey: string
  journeyName: string
  config: Config
  version: number
  source: string
  stageTypes: StageType[]
  vocabulary: Vocabulary
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(config.enabled)
  const [quiet, setQuiet] = useState(config.respectQuietHours)
  const [cap, setCap] = useState(String(config.caps.perRecipientPerMonth))
  const [hours, setHours] = useState<Record<string, string>>(
    Object.fromEntries(config.stages.map((s) => [s.type, String(toHours(s.delayMs))]))
  )
  const [rules, setRules] = useState<Record<string, boolean>>(config.stopRules)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [ok, setOk] = useState<string | null>(null)

  async function save() {
    setBusy('save')
    setErrors([])
    setOk(null)
    const stages = config.stages.map((s) => {
      const meta = stageTypes.find((t) => t.type === s.type)
      const h = Number(hours[s.type] ?? toHours(s.delayMs))
      const ms = Math.round(h * HOUR)
      return { type: s.type, template: s.template, delayMs: meta?.isCountdown ? -Math.abs(ms) : Math.abs(ms) }
    })
    try {
      const res = await fetch('/api/admin/email-marketing/journey-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journeyKey,
          config: { enabled, respectQuietHours: quiet, stages, stopRules: rules, caps: { perRecipientPerMonth: Number(cap) || 0 } },
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setErrors(body.errors ?? [body.error ?? `Save failed (${res.status})`])
        return
      }
      setOk(`Saved as version ${body.version}. Sends already scheduled keep the version they were scheduled under.`)
      router.refresh()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Save failed'])
    } finally {
      setBusy(null)
    }
  }

  async function reset() {
    if (!confirm(`Reset ${journeyName} to safe defaults?\n\nThe stored configuration is removed and the code constants take over.`)) return
    setBusy('reset')
    setErrors([])
    setOk(null)
    try {
      const res = await fetch('/api/admin/email-marketing/journey-config', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journeyKey }),
      })
      const body = await res.json()
      if (!res.ok) setErrors([body.error ?? `Reset failed (${res.status})`])
      else {
        setOk('Reset to safe defaults.')
        router.refresh()
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Reset failed'])
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={card}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '22px' }}>
        <div>
          <H>Behaviour</H>
          <Toggle checked={enabled} onChange={setEnabled} label="Journey enabled" />
          <Toggle checked={quiet} onChange={setQuiet} label="Respect quiet hours (9pm–8am ET)" />
          <div style={{ marginTop: '12px' }}>
            <p style={fieldLabel}>Max sends from this journey per recipient per 30 days (0 = no extra cap)</p>
            <input type="number" min={0} max={30} value={cap} onChange={(e) => setCap(e.target.value)} style={input} />
          </div>
        </div>

        <div>
          <H>Stage timing</H>
          {config.stages.map((s) => {
            const meta = stageTypes.find((t) => t.type === s.type)
            return (
              <div key={s.type} style={{ marginBottom: '11px' }}>
                <p style={fieldLabel}>
                  {meta?.label ?? s.type}{' '}
                  <span style={{ color: C.faint, fontWeight: 400 }}>
                    ({meta?.isCountdown ? 'hours BEFORE the anchor' : 'hours after the anchor'})
                  </span>
                </p>
                <input
                  type="number"
                  step="0.25"
                  min={0}
                  value={hours[s.type] ?? ''}
                  onChange={(e) => setHours((h) => ({ ...h, [s.type]: e.target.value }))}
                  style={input}
                />
                <p style={{ fontSize: '10px', color: C.faint, margin: '3px 0 0', fontFamily: 'ui-monospace, monospace' }}>{s.template}</p>
              </div>
            )
          })}
        </div>

        <div>
          <H>Stop rules</H>
          {Object.entries(vocabulary.stopRules).map(([key, label]) => {
            const locked = vocabulary.lockedStopRules.includes(key)
            return (
              <Toggle
                key={key}
                checked={locked ? true : rules[key] ?? true}
                disabled={locked}
                onChange={(v) => setRules((r) => ({ ...r, [key]: v }))}
                label={locked ? `${label} (always on)` : label}
              />
            )
          })}
        </div>
      </div>

      {errors.length > 0 && (
        <ul style={{ margin: '16px 0 0', paddingLeft: '17px', fontSize: '12px', color: C.red, lineHeight: 1.6 }}>
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {ok && <p style={{ fontSize: '12px', color: C.green, margin: '16px 0 0', fontWeight: 600 }}>{ok}</p>}

      <div style={{ display: 'flex', gap: '9px', marginTop: '18px', flexWrap: 'wrap' }}>
        <button onClick={save} disabled={busy !== null} style={btn(busy !== null, C.orange)}>
          {busy === 'save' ? 'Saving…' : `Save (version ${version + 1})`}
        </button>
        <button onClick={reset} disabled={busy !== null || source !== 'database'} style={btn(busy !== null || source !== 'database', '#FFFFFF', true)}>
          {busy === 'reset' ? 'Resetting…' : 'Reset to safe defaults'}
        </button>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: '9px', alignItems: 'flex-start', fontSize: '13px', color: disabled ? C.faint : '#374151', marginBottom: '9px', cursor: disabled ? 'default' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: '3px' }} />
      <span>{label}</span>
    </label>
  )
}

function H({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.faint, margin: '0 0 12px' }}>{children}</p>
}

const btn = (disabled: boolean, bg: string, outline?: boolean): React.CSSProperties => ({
  padding: '10px 20px', borderRadius: '8px', border: outline ? '1px solid #D1D5DB' : 'none', fontSize: '13px', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  backgroundColor: disabled ? '#E5E7EB' : bg,
  color: disabled ? C.faint : outline ? '#374151' : '#FFFFFF',
})
const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '14px', padding: '22px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `1px solid ${C.line}` }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '8px', border: '1px solid #D1D5DB', fontFamily: 'inherit' }
const fieldLabel: React.CSSProperties = { fontSize: '11px', color: C.muted, margin: '0 0 4px', fontWeight: 600 }
