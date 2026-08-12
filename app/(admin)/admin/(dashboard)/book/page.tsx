import { prisma } from '@/lib/db'
import { PageHeader } from '../_ui'
import { MOVE_SIZES } from '@/lib/estimate'
import BookMoveForm, { type BookPrefill } from './BookMoveForm'

export const dynamic = 'force-dynamic'

// ════════════════════════════════════════════════════════════════════════
//  /admin/book — the phone-call Book Move workspace (Moving OS Phase 1,
//  owner spec 2026-08-11). One screen, Jobber-simple, no wizard: customer →
//  move → access → services → inventory → recommendation (with WHY) → truck →
//  owner price → deposit mode → BOOK MOVE. The decision cascades server-side
//  (booking + job + staffing + lead conversion + scan); the success panel
//  makes the cascade visible and surfaces the portal/Stripe links for the
//  OWNER to send — this flow emails the customer nothing, by design.
//
//  ?leadId= prefills from the lead pipeline ("Convert to booking →" on
//  /admin/leads/[id]). Fail-soft: an unknown/missing lead simply starts blank.
// ════════════════════════════════════════════════════════════════════════

export default async function BookMovePage({ searchParams }: { searchParams: { leadId?: string } }) {
  let prefill: BookPrefill | undefined
  if (searchParams.leadId) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: searchParams.leadId },
        select: {
          id: true, name: true, email: true, phone: true, moveDate: true, moveSize: true,
          originZip: true, destinationZip: true, originCity: true, destCity: true,
          notes: true, message: true, convertedBookingId: true,
        },
      })
      if (lead && !lead.convertedBookingId) {
        const moveSize = (lead.moveSize ?? '').trim().toLowerCase()
        prefill = {
          leadId: lead.id,
          name: lead.name === 'Website lead' || lead.name === 'Booking lead' ? '' : lead.name,
          email: lead.email ?? '',
          phone: lead.phone ?? '',
          moveDate: lead.moveDate ? lead.moveDate.toISOString().slice(0, 10) : '',
          serviceType: moveSize && (moveSize in MOVE_SIZES || moveSize === 'not-sure') ? moveSize : '',
          originZip: lead.originZip ?? '',
          originCity: lead.originCity ?? '',
          destZip: lead.destinationZip ?? '',
          destCity: lead.destCity ?? '',
          notes: lead.notes ?? lead.message ?? '',
        }
      }
    } catch {
      // Fail soft — a broken lead lookup must never block taking the booking.
    }
  }

  return (
    <div>
      <PageHeader
        title="Book Move"
        subtitle="The phone-call workspace: capture the move, read the recommendation back to the customer, set the price, book. Everything else — job, staffing, lead, scan — happens from that one decision. No emails are sent from here; you send the links."
      />
      <BookMoveForm prefill={prefill} />
    </div>
  )
}
