'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// ════════════════════════════════════════════════════════════════════════════
//  ITEM R2 — the repair the owner is TOLD to perform now EXISTS here.
//
//  When the $49 capture succeeds and the Payment/Job/audit transaction does
//  not, the booking is left CONFIRMED and the owner is told to finish the
//  record. On this surface that used to be impossible: the status route's
//  VALID_TRANSITIONS has no CONFIRMED → CONFIRMED edge, so the 422 fired before
//  the approval branch and the convergence path was never reached. Only the
//  Discord card could execute the repair — and that card is delivered
//  best-effort, so the very incident that causes the failure can also remove
//  the only route to the cure.
//
//  "Retry payment record" posts a NAMED ACTION (`{ action: 'retry_approval' }`)
//  rather than a status change, so the transition table stays exactly as strict
//  as it was for ordinary status changes. The server is the permission gate
//  (booking.approve is OWNER-only); `canApprove` only decides whether to render
//  a button the reader is allowed to press.
//
//  THE LABEL IS LOAD-BEARING: src/lib/booking-approval.ts prints this exact
//  string to the owner ("…click \"Retry payment record\"…"). It cannot import
//  the constant from there — that module pulls in Prisma and Stripe, which must
//  never reach the browser bundle — so the two copies are pinned together by
//  src/lib/__tests__/approval-exactly-once.test.ts.
// ════════════════════════════════════════════════════════════════════════════

const RETRY_APPROVAL_LABEL = 'Retry payment record'

// ── BLOCKER B7/B8 — the post-move recovery, on the only surface that has one.
//
//  A job completed from the Discord move-day card (the way jobs are ACTUALLY
//  completed) sent the customer NOTHING, and this component then offered only
//  "Archive" — so the move-complete email, the balance reminder, the review
//  request and the referral ask were lost permanently. The transition table is
//  deliberately unchanged (COMPLETED → COMPLETED would reopen a guard that was
//  never designed for a retry); this posts a NAMED ACTION instead, exactly like
//  the R2 repair above.
//
//  THE LABEL IS LOAD-BEARING: src/lib/lifecycle-service.ts exports the same
//  string as REPLAY_COMPLETION_ACTION_LABEL. This component cannot import it
//  (that module pulls in Prisma, which must never reach the browser bundle), so
//  the two copies are pinned by src/lib/__tests__/lifecycle-service.test.ts.
const REPLAY_COMPLETION_LABEL = 'Send post-move messages'

// ── D1 — THE OWNER'S EXIT FROM AN UNPAID CHECKOUT HOLD ──────────────────────
//
//  A PENDING_PAYMENT booking holds its truck and nothing could end it: the
//  status route refuses every transition out of PENDING_PAYMENT. B6 filled the
//  gap with an hourly sweep that CANCELLED such bookings automatically — and it
//  cancelled customers who were being redirected into a fresh payment session,
//  irreversibly. That path was removed; this button is what replaced it.
//
//  It posts to its own route (not the status route) because the server-side
//  checks are the point: it refuses when Stripe says the session completed
//  (money may exist) and answers 428 when the session is still payable or
//  Stripe cannot be reached, naming the risk so the owner confirms THAT rather
//  than a generic "are you sure".
const RELEASE_HOLD_LABEL = 'Release truck hold'

type BookingAction = {
  label: string
  color: string
  /** Confirmation prompt. Never promises an outcome the server has not proven. */
  confirm: string
  /** A status transition (POST { status }). */
  next?: string
  /** A named repair action (POST { action }). */
  action?: 'retry_approval' | 'replay_completion'
  /** A dedicated endpoint under the booking, instead of /status. */
  endpoint?: string
  title?: string
  /** Rendered as a quiet outline button — a repair is not a primary action. */
  ghost?: boolean
}

const transition = (label: string, next: string, color: string): BookingAction => ({
  label,
  next,
  color,
  confirm: `Move booking to ${next.replace(/_/g, ' ')}?`,
})

const TRANSITIONS: Record<string, BookingAction[]> = {
  PENDING_PAYMENT: [
    {
      label: RELEASE_HOLD_LABEL,
      endpoint: 'release-hold',
      color: '#EF4444',
      ghost: true,
      title:
        'Cancels this unpaid booking so it stops holding its truck. It never charges, releases or refunds a card, ' +
        'and it refuses if Stripe says a payment was completed for it.',
      confirm:
        'Release the truck hold on this unpaid booking?\n\n' +
        'This CANCELS the booking, and a cancelled booking cannot be un-cancelled. ' +
        'No card is charged, held or released by this.',
    },
  ],
  PENDING_APPROVAL: [
    transition('Confirm booking', 'CONFIRMED', '#3B82F6'),
    transition('Cancel', 'CANCELLED', '#EF4444'),
  ],
  CONFIRMED: [
    transition('Mark scheduled', 'SCHEDULED', '#6366F1'),
    {
      label: RETRY_APPROVAL_LABEL,
      action: 'retry_approval',
      color: '#6B7280',
      ghost: true,
      title:
        'Finishes the payment record for a booking whose $49 was captured at Stripe but never saved here. ' +
        'It cannot capture twice and it cannot email the customer twice.',
      confirm:
        'Finish this booking’s payment record?\n\n' +
        'This checks Stripe and records the $49 only if it was really captured. ' +
        'It never charges the customer again, and it is safe to run when nothing is wrong.',
    },
    transition('Cancel', 'CANCELLED', '#EF4444'),
  ],
  SCHEDULED: [
    transition('Start job', 'IN_PROGRESS', '#F59E0B'),
    transition('Cancel', 'CANCELLED', '#EF4444'),
  ],
  IN_PROGRESS: [transition('Complete job', 'COMPLETED', '#10B981')],
  COMPLETED: [
    {
      label: REPLAY_COMPLETION_LABEL,
      action: 'replay_completion',
      color: '#6B7280',
      ghost: true,
      title:
        'Queues the move-complete email, the balance reminder and the review/referral sequence for a job ' +
        'that was completed without them (for example from the Discord card before this was fixed). ' +
        'It cannot send anything twice.',
      confirm:
        'Send this customer their post-move messages?\n\n' +
        'This queues the move-complete email, the balance reminder and the review/referral sequence. ' +
        'Anything that already went out is not sent again, so it is safe to run when nothing is wrong.',
    },
    transition('Archive', 'ARCHIVED', '#6B7280'),
  ],
}

export default function BookingActions({
  bookingId,
  status,
  canApprove = true,
}: {
  bookingId: string
  status: string
  /** Whether this user holds `booking.approve` (OWNER-only). Defaults to true so
   *  a caller that does not pass it keeps the old surface; the ROUTE is the gate
   *  either way and answers 403. */
  canApprove?: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const actions = (TRANSITIONS[status] ?? []).filter((a) => a.action !== 'retry_approval' || canApprove)
  if (actions.length === 0) return null

  async function run(a: BookingAction) {
    if (!confirm(a.confirm)) return
    setLoading(true)
    setError('')
    setNotice('')

    try {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('moveit_csrf='))?.split('=')[1]
      const url = `/api/admin/bookings/${bookingId}/${a.endpoint ?? 'status'}`
      const headers = { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}) }
      const payload = a.endpoint ? {} : a.action ? { action: a.action } : { status: a.next }
      let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })

      // 428 — the server named a SPECIFIC risk (Stripe says the checkout is
      // still payable, or Stripe could not be reached) and wants that risk
      // acknowledged, not a generic re-confirmation. Show its words verbatim.
      if (res.status === 428) {
        const d = await res.json().catch(() => null)
        const detail = typeof d?.error === 'string' ? d.error : 'This needs an extra confirmation.'
        if (!confirm(`${detail}\n\nProceed anyway?`)) {
          setError('')
          return
        }
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ acknowledgeRisk: true }) })
      }

      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Failed to update status')
        return
      }

      // The repair action answers with a message built from what the server
      // could PROVE (a COMPLETED Payment row, or a capture it performed). Show
      // it verbatim — this component never composes a claim about money.
      const d = await res.json().catch(() => null)
      if (d && typeof d.message === 'string') setNotice(d.message)

      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {actions.map((a) => (
          <button
            key={a.next ?? a.action ?? a.endpoint ?? a.label}
            onClick={() => run(a)}
            disabled={loading}
            title={a.title}
            style={{
              padding: '8px 18px',
              backgroundColor: a.ghost ? 'transparent' : a.color,
              color: a.ghost ? a.color : '#FFFFFF',
              border: a.ghost ? `1px solid ${a.color}` : 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '600',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && <p style={{ fontSize: '12px', color: '#EF4444', margin: '0' }}>{error}</p>}
      {notice && <p style={{ fontSize: '12px', color: '#10B981', margin: '0' }}>{notice}</p>}
    </div>
  )
}
