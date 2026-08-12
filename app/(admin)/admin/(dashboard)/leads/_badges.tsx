// Shared lead badge helpers (Stage 2C). Extracted from the list page so the
// new /admin/leads/[id] detail page renders the SAME status + marketing badges
// (Next.js page files may only export page fields, so reuse lives here).
// Server-safe: no 'use client'.

import Link from 'next/link'

export const PARTIAL_LIFECYCLES = ['PARTIAL', 'IN_PROGRESS', 'ABANDONED'] as const

/** LeadStatus → owner-readable label (pipeline vocabulary). */
export const LEAD_STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUOTE_SENT: 'Quote sent',
  FOLLOW_UP: 'Follow-up',
  BOOKED: 'Booked',
  LOST: 'Lost',
}

export function statusBadge(lifecycle: string | null, status: string, convertedBookingId: string | null) {
  if (lifecycle === 'CONVERTED' || convertedBookingId) {
    const inner = <span style={{ ...badge, background: '#DCFCE7', color: '#166534' }}>Converted</span>
    return convertedBookingId ? <Link href={`/admin/jobs/${convertedBookingId}`} style={{ textDecoration: 'none' }}>{inner}</Link> : inner
  }
  if (lifecycle && (PARTIAL_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    const label = lifecycle === 'ABANDONED' ? 'Abandoned' : 'Partial'
    return <span style={{ ...badge, background: '#FEF3C7', color: '#92400E' }}>{label}</span>
  }
  return <span style={{ ...badge, background: '#EFF2F6', color: '#475569' }}>{LEAD_STATUS_LABELS[status] ?? status.replace(/_/g, ' ').toLowerCase()}</span>
}

export function marketingBadge(consent: boolean | null, supp?: { reason: string; scope: string }) {
  if (supp) {
    const label = supp.reason === 'UNSUBSCRIBED' ? 'Unsubscribed' : 'Suppressed'
    return <span style={{ ...badge, background: '#FEE2E2', color: '#991B1B' }} title={`${supp.reason} (${supp.scope})`}>{label}</span>
  }
  if (consent === true) return <span style={{ ...badge, background: '#DBEAFE', color: '#1E40AF' }}>Opted in</span>
  return <span style={{ fontSize: '12px', color: '#9CA3AF' }}>—</span>
}

export const badge: React.CSSProperties = { fontSize: '11px', padding: '3px 8px', borderRadius: '100px', fontWeight: 600, whiteSpace: 'nowrap' }
