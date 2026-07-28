'use client'

// ════════════════════════════════════════════════════════════════════════
//  AGENT CONTROLS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The buttons that change what the agent is allowed to do.
//
//  TWO OF THEM ARE NOT ORDINARY BUTTONS, and the difference is deliberate:
//  turning on safe-auto hands a program permission to change production data,
//  and resuming dispatch restarts real email to real people. Both require the
//  operator to TYPE a confirmation phrase, and both are re-checked on the
//  server — this component makes the decision deliberate, the API makes it
//  enforced. A client that skipped this dialog would still be refused.
// ════════════════════════════════════════════════════════════════════════

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'
import { COLORS } from '../../_ui'

type Settings = {
  mode: string
  aiEnabled: boolean
  autoActionsEnabled: boolean
  alertsEnabled: boolean
  digestWarnings: boolean
  marketingDispatchPaused: boolean
}

const btn = (bg: string, disabled: boolean): React.CSSProperties => ({
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: 600,
  color: '#FFFFFF',
  backgroundColor: disabled ? COLORS.faint : bg,
  border: 'none',
  borderRadius: '8px',
  cursor: disabled ? 'not-allowed' : 'pointer',
})

const ghost: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: 600,
  color: COLORS.ink,
  backgroundColor: '#FFFFFF',
  border: `1px solid ${COLORS.line}`,
  borderRadius: '8px',
  cursor: 'pointer',
}

export default function AgentControls({ settings }: { settings: Settings }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const disabled = busy || pending

  async function post(body: Record<string, unknown>, successText?: string) {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/email-marketing/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`)
        return
      }
      setMessage(successText ?? 'Done.')
      start(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function enableSafeAuto() {
    // The phrase is not a formality. It is the difference between "I clicked
    // something" and "I decided to let this change production data".
    const typed = window.prompt(
      'SAFE-AUTO MODE\n\n' +
        'The agent will be allowed to perform narrow, policy-approved repairs by itself:\n' +
        '  • recompute run counters from recipient rows\n' +
        '  • close runs whose recipients have all settled\n' +
        '  • release expired send claims\n' +
        '  • re-apply a suppression from a verified webhook\n' +
        '  • retry a transient send failure ONCE\n' +
        '  • pause a campaign or all dispatch when it detects a risk\n\n' +
        'It still CANNOT send, resend, reschedule, change an audience, create consent,\n' +
        'remove a suppression, or raise the 50-recipient limit.\n\n' +
        'Type ENABLE SAFE AUTO to confirm:'
    )
    if (typed === null) return
    void post({ action: 'set_mode', mode: 'safe_auto', confirmation: typed }, 'Safe-auto mode is on.')
  }

  function pauseDispatch() {
    const reason = window.prompt('Pause ALL marketing dispatch.\n\nNo campaign will send until it is resumed.\nWhy are you pausing? (recorded)')
    if (!reason?.trim()) return
    void post({ action: 'pause_dispatch', reason: reason.trim() }, 'Marketing dispatch is paused.')
  }

  function resumeDispatch() {
    const typed = window.prompt(
      'RESUME MARKETING DISPATCH\n\n' +
        'Campaign sending restarts immediately. Any campaign whose scheduled time\n' +
        'has already passed will dispatch on the next sweep.\n\n' +
        'Type RESUME SENDING to confirm:'
    )
    if (typed === null) return
    void post({ action: 'resume_dispatch', confirmation: typed }, 'Marketing dispatch resumed.')
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <button style={btn(COLORS.navy, disabled)} disabled={disabled} onClick={() => post({ action: 'run_now' }, 'Health check finished.')}>
          {disabled ? 'Working…' : 'Run health check now'}
        </button>

        {settings.mode === 'off' ? (
          <button style={btn(COLORS.blue, disabled)} disabled={disabled} onClick={() => post({ action: 'set_mode', mode: 'read_only' }, 'Agent is on, in read-only mode.')}>
            Turn agent on (read-only)
          </button>
        ) : (
          <button style={ghost} disabled={disabled} onClick={() => post({ action: 'set_mode', mode: 'off' }, 'Agent switched off.')}>
            Switch agent off
          </button>
        )}

        {settings.mode === 'safe_auto' ? (
          <button style={ghost} disabled={disabled} onClick={() => post({ action: 'set_mode', mode: 'read_only' }, 'Back to read-only.')}>
            Return to read-only
          </button>
        ) : settings.mode === 'read_only' ? (
          <button style={btn(COLORS.gold, disabled)} disabled={disabled} onClick={enableSafeAuto}>
            Request safe-auto…
          </button>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <button style={ghost} disabled={disabled} onClick={() => post({ action: 'set_ai_enabled', enabled: !settings.aiEnabled })}>
          {settings.aiEnabled ? 'Disable AI analysis' : 'Enable AI analysis'}
        </button>
        <button style={ghost} disabled={disabled} onClick={() => post({ action: 'set_auto_actions', enabled: !settings.autoActionsEnabled })}>
          {settings.autoActionsEnabled ? 'Disable automatic repairs' : 'Enable automatic repairs'}
        </button>
        <button style={ghost} disabled={disabled} onClick={() => post({ action: 'set_alerts', enabled: !settings.alertsEnabled })}>
          {settings.alertsEnabled ? 'Disable Discord alerts' : 'Enable Discord alerts'}
        </button>
        <button style={ghost} disabled={disabled} onClick={() => post({ action: 'set_digest', enabled: !settings.digestWarnings })}>
          {settings.digestWarnings ? 'Alert on every warning' : 'Digest warnings daily'}
        </button>
        <button style={ghost} disabled={disabled} onClick={() => post({ action: 'test_alert' }, 'Test alert sent — check the ops channel.')}>
          Send test alert
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          paddingTop: '14px',
          borderTop: `1px solid ${COLORS.line}`,
        }}
      >
        {settings.marketingDispatchPaused ? (
          <button style={btn(COLORS.green, disabled)} disabled={disabled} onClick={resumeDispatch}>
            Resume marketing dispatch…
          </button>
        ) : (
          <button style={btn(COLORS.red, disabled)} disabled={disabled} onClick={pauseDispatch}>
            Pause ALL marketing dispatch
          </button>
        )}
        <span style={{ fontSize: '12px', color: COLORS.muted, alignSelf: 'center' }}>
          This is enforced on the server, inside the dispatcher — not just here.
        </span>
      </div>

      {message && (
        <p role="status" style={{ fontSize: '13px', color: COLORS.green, marginTop: '12px' }}>
          {message}
        </p>
      )}
      {error && (
        <p role="alert" style={{ fontSize: '13px', color: COLORS.red, marginTop: '12px' }}>
          {error}
        </p>
      )}
    </div>
  )
}
