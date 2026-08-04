'use client'

// The owner-facing resend control for the quote-request confirmation email.
// Calls POST /api/admin/leads/[id]/resend-confirmation, which bumps the send
// version (so the email guard treats it as a new business event) and audits the
// act as LEAD_QUOTE_CONFIRMATION_RESENT.
//
// The Leads page is a server component, so this ships as two pieces: a provider
// that owns the busy/notice/error state and renders the message ABOVE the
// table (mirroring email-marketing/leads/LeadQuoteList), and a per-row button
// that reads that state. The table itself stays server-rendered — it is passed
// through as children.

import { createContext, useContext, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { csrfHeader } from '../_client'

type Ctx = {
  busy: string | null
  resend: (leadId: string, name: string) => void
}

const ResendCtx = createContext<Ctx>({ busy: null, resend: () => undefined })

/** Human sentence for the route's machine reason. Anything unmapped is shown
 *  verbatim rather than swallowed — a reason we do not recognise is still the
 *  truth about what happened. */
function reasonText(reason: string | undefined, status: number): string {
  switch (reason) {
    case 'lead_not_found': return 'That lead no longer exists.'
    case 'lead_has_no_email': return 'This lead has no email address — nothing to resend.'
    case 'enqueue_failed':
    case 'error': return 'The email could not be queued right now. Nothing was sent; try again shortly.'
    default: return reason ? `Failed: ${reason}` : `Failed (${status})`
  }
}

export function ResendConfirmationProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function resend(leadId: string, name: string) {
    setBusy(leadId)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/admin/leads/${leadId}/resend-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) setError(reasonText(body.reason, res.status))
      else {
        setNotice(`Confirmation email resent to ${name} — this is send #${body.version ?? '?'} for that lead.`)
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <ResendCtx.Provider value={{ busy, resend }}>
      {error && <p style={{ fontSize: '12px', color: '#EF4444', margin: '0 0 8px' }}>{error}</p>}
      {notice && <p style={{ fontSize: '12px', color: '#10B981', margin: '0 0 8px' }}>{notice}</p>}
      {children}
    </ResendCtx.Provider>
  )
}

export function ResendConfirmationButton({ leadId, name, sent }: { leadId: string; name: string; sent: boolean }) {
  const { busy, resend } = useContext(ResendCtx)
  const isBusy = busy === leadId
  return (
    <button
      onClick={() => resend(leadId, name)}
      disabled={isBusy}
      style={{
        marginTop: '4px', fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '7px',
        border: 'none', cursor: isBusy ? 'default' : 'pointer',
        backgroundColor: isBusy ? '#F3F4F6' : '#FF5A1F', color: isBusy ? '#9CA3AF' : '#FFFFFF',
      }}
    >
      {isBusy ? '…' : sent ? 'Resend' : 'Send'}
    </button>
  )
}
