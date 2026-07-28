'use client'

// ════════════════════════════════════════════════════════════════════════
//  APPROVAL + INCIDENT DECISIONS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Where the owner answers the agent.
//
//  THE STALENESS BANNER IS THE POINT OF THIS COMPONENT. An approval carries a
//  checksum of the exact state the human reviewed. When the campaign has since
//  been edited, the owner is told BEFORE they click rather than after — and
//  the Approve button is removed, not merely discouraged, because an approval
//  that no longer describes reality is not a decision anybody made.
// ════════════════════════════════════════════════════════════════════════

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../../_client'
import { COLORS } from '../../_ui'

const btn = (bg: string, disabled: boolean): React.CSSProperties => ({
  padding: '7px 13px',
  fontSize: '13px',
  fontWeight: 600,
  color: '#FFFFFF',
  backgroundColor: disabled ? COLORS.faint : bg,
  border: 'none',
  borderRadius: '7px',
  cursor: disabled ? 'not-allowed' : 'pointer',
})

const ghost: React.CSSProperties = {
  padding: '7px 13px',
  fontSize: '13px',
  fontWeight: 600,
  color: COLORS.ink,
  backgroundColor: '#FFFFFF',
  border: `1px solid ${COLORS.line}`,
  borderRadius: '7px',
  cursor: 'pointer',
}

function useAction() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (url: string, body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `Failed (${res.status})`)
        return false
      }
      start(() => router.refresh())
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { send, disabled: busy || pending, error }
}

export function ApprovalDecision({
  approvalId,
  reference,
  toolName,
  question,
  resourceChanged,
  expired,
}: {
  approvalId: string
  reference: string
  toolName: string
  question: string
  resourceChanged: boolean
  expired: boolean
}) {
  const { send, disabled, error } = useAction()

  if (expired) {
    return (
      <p style={{ fontSize: '12px', color: COLORS.muted, margin: 0 }}>
        This request expired before it was answered. The agent will ask again if the problem is still there.
      </p>
    )
  }

  if (resourceChanged) {
    // No Approve button at all. Showing one that the server will refuse would
    // teach the operator that the warning is noise.
    return (
      <div>
        <p style={{ fontSize: '12px', color: COLORS.red, margin: '0 0 8px', fontWeight: 600 }}>
          The campaign, run or send has changed since this was written, so approving it would authorise something different from what is described here. It can only be rejected.
        </p>
        <button
          style={ghost}
          disabled={disabled}
          onClick={() => {
            const note = window.prompt(`Reject ${reference}?\n\nOptional note (recorded):`) ?? ''
            void send('/api/admin/email-marketing/agent/approvals', { approvalId, decision: 'reject', note })
          }}
        >
          Reject
        </button>
        {error && <p role="alert" style={{ fontSize: '12px', color: COLORS.red, marginTop: '8px' }}>{error}</p>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
      <button
        style={btn(COLORS.green, disabled)}
        disabled={disabled}
        onClick={() => {
          if (!window.confirm(`${question}\n\nApprove and run ${toolName} now?`)) return
          void send('/api/admin/email-marketing/agent/approvals', { approvalId, decision: 'approve', execute: true })
        }}
      >
        Approve &amp; run
      </button>
      <button
        style={ghost}
        disabled={disabled}
        onClick={() => void send('/api/admin/email-marketing/agent/approvals', { approvalId, decision: 'approve', execute: false })}
      >
        Approve only
      </button>
      <button
        style={ghost}
        disabled={disabled}
        onClick={() => {
          const note = window.prompt(`Reject ${reference}?\n\nOptional note (recorded):`) ?? ''
          void send('/api/admin/email-marketing/agent/approvals', { approvalId, decision: 'reject', note })
        }}
      >
        Reject
      </button>
      {error && <span role="alert" style={{ fontSize: '12px', color: COLORS.red }}>{error}</span>}
    </div>
  )
}

export function IncidentDecision({ incidentId, reference, status }: { incidentId: string; reference: string; status: string }) {
  const { send, disabled, error } = useAction()
  const closed = status === 'resolved' || status === 'ignored'

  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
      {closed ? (
        <button
          style={ghost}
          disabled={disabled}
          onClick={() => {
            const note = window.prompt(`Reopen ${reference}?\n\nWhy? (recorded)`)
            if (!note?.trim()) return
            void send('/api/admin/email-marketing/agent/incidents', { incidentId, action: 'reopen', note: note.trim() })
          }}
        >
          Reopen
        </button>
      ) : (
        <>
          <button
            style={btn(COLORS.green, disabled)}
            disabled={disabled}
            onClick={() => {
              const note = window.prompt(`Resolve ${reference}?\n\nWhat fixed it? (recorded, and the agent learns from it)`)
              if (!note?.trim()) return
              void send('/api/admin/email-marketing/agent/incidents', { incidentId, action: 'resolve', note: note.trim() })
            }}
          >
            Resolve
          </button>
          <button
            style={ghost}
            disabled={disabled}
            onClick={() => {
              const note = window.prompt(
                `Mark ${reference} a false positive?\n\nWhy was this not a real problem? (recorded — the agent lowers its confidence in this pattern)`
              )
              if (!note?.trim()) return
              void send('/api/admin/email-marketing/agent/incidents', { incidentId, action: 'ignore', note: note.trim() })
            }}
          >
            False positive
          </button>
        </>
      )}
      {error && <span role="alert" style={{ fontSize: '12px', color: COLORS.red }}>{error}</span>}
    </div>
  )
}
