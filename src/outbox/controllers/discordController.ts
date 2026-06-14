import { prisma } from '../db/client'
import { BookingState, nextState, InvalidTransitionError } from '../domain/booking-states'
import { EventType, ApprovedPayload } from '../domain/events'
import { saveEmailJob, readBookingOutboxState, writeBookingOutboxState } from '../db/emailJobsRepo'

export interface ApproveResult {
  ok: boolean
  state: BookingState
  emailJobCreated: boolean
  alreadyApproved?: boolean
}

/**
 * Admin clicked "Approve".
 *  - validate the booking is in PENDING_APPROVAL (idempotent if already APPROVED)
 *  - transition PENDING_APPROVAL -> APPROVED
 *  - insert the APPROVED event (idempotency key bookingId::APPROVED)
 * The state update and the event insert happen in ONE transaction, so an email
 * job exists if and only if the state actually changed.
 *
 * Email-payload fields are passed in by the caller (your existing Discord
 * handler) so the outbox never needs to read your Booking/Customer models.
 */
export async function handleApprove(params: {
  bookingId: string
  approvedBy: string
  customerName: string
  customerEmail: string
  requestedDate: string | null // ISO
  items?: string
}): Promise<ApproveResult> {
  return prisma.$transaction(async (tx) => {
    const current = await readBookingOutboxState(tx, params.bookingId)
    if (current === undefined) throw new Error(`Booking ${params.bookingId} not found`)

    // Bootstrap: a booking whose outbox_state was never set is treated as
    // PENDING_APPROVAL (the only state from which Approve is legal).
    const from = current ?? BookingState.PENDING_APPROVAL

    // Idempotent: a second Approve click is a no-op, not an error.
    if (from === BookingState.APPROVED) {
      return { ok: true, state: BookingState.APPROVED, emailJobCreated: false, alreadyApproved: true }
    }
    if (from !== BookingState.PENDING_APPROVAL) {
      throw new InvalidTransitionError(from, EventType.APPROVED)
    }

    const target = nextState(from, EventType.APPROVED) // APPROVED
    await writeBookingOutboxState(tx, params.bookingId, target)

    const payload: ApprovedPayload = {
      bookingId: params.bookingId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      requestedDate: params.requestedDate,
      approvedBy: params.approvedBy,
      items: params.items,
    }
    const { inserted } = await saveEmailJob(tx, {
      bookingId: params.bookingId,
      eventType: EventType.APPROVED,
      payload,
    })

    return { ok: true, state: target, emailJobCreated: inserted }
  })
}
