// LEADS — the quote-recovery worklist (owner spec 2026-07-22). Owner-only.
//
// PART OF THE NORMAL WORKFLOW, not a hidden API: the quote follow-up sequence
// starts from the real action an owner performs — recording that a genuine
// quote was given. This page lists the OPEN leads and gives that action a
// button. It is deliberately NOT a CRM: leads are written by the public
// inquiry paths (contact form / coupon popup / "not sure" bookings) and
// closed automatically when a booking converts them.

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { prisma } from '@/lib/db'
import { PageHeader, Card, Empty, COLORS, Callout } from '../../_ui'
import { EmailTabs } from '../_shared'
import LeadQuoteList from './LeadQuoteList'

export const dynamic = 'force-dynamic'

export default async function EmailLeadsPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  if (!can(session?.role as never, 'email.manage_journey')) {
    return (
      <div>
        <PageHeader title="Leads" />
        <EmailTabs active="/admin/email-marketing/leads" isOwner={isOwner} />
        <Card><Empty>The lead worklist is limited to owners and managers.</Empty></Card>
      </div>
    )
  }

  let error: string | null = null
  let leads: React.ComponentProps<typeof LeadQuoteList>['leads'] = []
  try {
    const rows = await prisma.lead.findMany({
      where: { status: { in: ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP'] } },
      orderBy: { lastActivityAt: 'desc' },
      take: 200,
      select: {
        id: true, name: true, email: true, phone: true, status: true, source: true,
        jobType: true, moveDate: true, quotedAt: true, estimatedValue: true, lastActivityAt: true,
      },
    })
    leads = rows.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      phone: l.phone,
      status: l.status,
      source: String(l.source),
      jobType: l.jobType,
      moveDate: l.moveDate ? l.moveDate.toISOString() : null,
      quotedAt: l.quotedAt ? l.quotedAt.toISOString() : null,
      estimatedValueCents: l.estimatedValue,
      lastActivityAt: l.lastActivityAt ? l.lastActivityAt.toISOString() : null,
    }))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Open inquiries. Recording a real quote here starts the quote follow-up sequence — a booking stops it automatically."
      />
      <EmailTabs active="/admin/email-marketing/leads" isOwner={isOwner} />

      <Callout tone="info" title="No quote sequence without a real quote">
        “Mark quoted” stamps the moment you actually gave the customer a number. It is idempotent — marking twice never
        restarts the clock — and the follow-ups stop on their own the instant the lead books, is lost, or unsubscribes.
        A lead with no recorded quote receives no quote emails, ever.
      </Callout>

      {error && <p style={{ fontSize: '12px', color: COLORS.red, marginBottom: '14px' }}>Leads unavailable: {error}</p>}

      <LeadQuoteList leads={leads} />
    </div>
  )
}
