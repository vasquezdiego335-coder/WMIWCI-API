import { prisma } from './db'
import { discordQueue } from './queues'
import { findAvailableSlots, formatEastern } from './scheduling'
import { apiLogger } from './logger'

export type OfferRescheduleResult = {
  /** Human-readable Eastern labels, for Discord cards and the admin response. */
  offeredDates: string[]
  /**
   * The same slots as ISO timestamps — what the reschedule EMAIL must be given.
   * The human labels ("Friday, September 18, 2026 at 9:00 AM") do not parse
   * back into dates, so the email used to drop every offered date and tell the
   * customer to reply instead.
   */
  offeredDatesIso: string[]
  rescheduleUrl: string
  customerEmail: string
}

// Shared "Offer New Dates" logic — the single source of truth used by BOTH the
// admin route (POST /api/admin/bookings/[id]/offer-reschedule) and the Discord
// "📅 Offer New Dates" interaction button. Moves the booking back to
// PENDING_APPROVAL, audit-logs the offer, and (optionally) pings Discord. The
// customer EMAIL is emitted by each caller through the transactional outbox;
// no SMS is ever sent. The $49 hold is never touched. Returns null if the
// booking is missing.
//
// Queue adds are timeout-guarded: BullMQ uses maxRetriesPerRequest:null, so a
// Redis stall would otherwise hang the caller forever (and blow the Discord 3s
// interaction window). The race converts a stall into a logged, non-fatal skip.
export async function offerRescheduleToCustomer(
  bookingId: string,
  opts: { offeredBy?: string; userId?: string; notifyDiscord?: boolean } = {}
): Promise<OfferRescheduleResult | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true },
  })
  if (!booking) return null

  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING_APPROVAL' } })

  const from = new Date(Date.now() + 72 * 60 * 60 * 1000)
  const slots = await findAvailableSlots(from, 3)
  const offeredDates = slots.map(formatEastern)

  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
  const rescheduleUrl = `${appUrl}/my-booking/${booking.customerToken}?reschedule=1`

  // MESSAGING POLICY: this helper sends no customer email itself, and no SMS is
  // ever sent (Move It Clear It no longer texts customers, owner 2026-09-15). The
  // reschedule link is surfaced through the customer portal and the (internal,
  // team-only) Discord notice below; the customer EMAIL, when there is one, is
  // emitted by the caller through the transactional outbox.
  if (opts.notifyDiscord) {
    try {
      await Promise.race([
        discordQueue.add('failure-alert', {
          type: 'failure-alert',
          bookingId: booking.id,
          payload: {
            alertType: 'Reschedule Offered',
            message: `📅 Reschedule prepared for **${booking.customer.name}** (${booking.displayId}). Offered: ${offeredDates.join(' · ') || 'no open slots — contact customer'}`,
            bookingId: booking.id,
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('queue add timed out (Redis?)')), 2500)),
      ])
    } catch (err) {
      apiLogger.error(
        { err: err instanceof Error ? err.message : String(err), bookingId: booking.id },
        'Reschedule Discord notice failed/timed out (non-fatal)'
      )
    }
  }

  await prisma.auditLog.create({
    data: {
      action: 'SCHEDULE_MODIFIED',
      userId: opts.userId ?? null,
      bookingId: booking.id,
      details: { action: 'offer_reschedule', offeredDates, by: opts.offeredBy ?? 'system' },
    },
  })

  apiLogger.info({ bookingId: booking.id, count: offeredDates.length }, 'Reschedule offer sent to customer')

  return {
    offeredDates,
    offeredDatesIso: slots.map((d) => d.toISOString()),
    rescheduleUrl,
    customerEmail: booking.customer.email,
  }
}
