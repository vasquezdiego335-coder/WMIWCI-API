import { prisma } from '../db/client'
import { BookingState, nextState } from '../domain/booking-states'
import { EventType, PaymentCompletedPayload } from '../domain/events'
import { saveEmailJob, readBookingOutboxState, writeBookingOutboxState } from '../db/emailJobsRepo'

export interface PaymentCompletedResult {
  ok: boolean
  state: BookingState
  emailJobCreated: boolean
}

/**
 * Stripe payment completed (the $49 hold was authorized).
 *  - transition PAYMENT_PENDING -> PENDING_APPROVAL (bootstrapping a NULL state)
 *  - insert the PAYMENT_COMPLETED event (idempotency key bookingId::PAYMENT_COMPLETED)
 * State update + event insert are one transaction. Idempotent: a duplicate
 * webhook/redirect leaves the state put and the ON CONFLICT insert a no-op.
 */
export async function handlePaymentCompleted(params: {
  bookingId: string
  amountPaid: string
  customerName: string
  customerEmail: string
  requestedDate: string | null // ISO
  items?: string
}): Promise<PaymentCompletedResult> {
  return prisma.$transaction(async (tx) => {
    const current = await readBookingOutboxState(tx, params.bookingId)
    if (current === undefined) throw new Error(`Booking ${params.bookingId} not found`)
    const from = current ?? BookingState.PAYMENT_PENDING

    const payload: PaymentCompletedPayload = {
      bookingId: params.bookingId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      requestedDate: params.requestedDate,
      amountPaid: params.amountPaid,
      items: params.items,
    }

    // Already moved past payment (duplicate trigger): just ensure the event
    // exists; ON CONFLICT keeps it exactly-once.
    if (from !== BookingState.PAYMENT_PENDING) {
      const { inserted } = await saveEmailJob(tx, {
        bookingId: params.bookingId,
        eventType: EventType.PAYMENT_COMPLETED,
        payload,
      })
      return { ok: true, state: from, emailJobCreated: inserted }
    }

    const target = nextState(from, EventType.PAYMENT_COMPLETED) // PENDING_APPROVAL
    await writeBookingOutboxState(tx, params.bookingId, target)
    const { inserted } = await saveEmailJob(tx, {
      bookingId: params.bookingId,
      eventType: EventType.PAYMENT_COMPLETED,
      payload,
    })
    return { ok: true, state: target, emailJobCreated: inserted }
  })
}
