import { prisma } from '../db/client'
import { BookingState, nextState, InvalidTransitionError } from '../domain/booking-states'
import { EventType, RescheduleRequestedPayload, NewDatePickedPayload } from '../domain/events'
import { saveEmailJob, readBookingOutboxState, writeBookingOutboxState } from '../db/emailJobsRepo'

/**
 * PLACEHOLDER — wire this to your real Discord REST card poster
 * (e.g. src/bot/discord-rest.ts → postBookingApprovalCard).
 */
async function postApprovalCard(input: {
  bookingId: string
  customerName: string
  newDate: string | null
}): Promise<{ messageId: string }> {
  console.log(`[outbox/discord] new approval card for ${input.bookingId} (${input.customerName})`)
  return { messageId: `stub_${Math.random().toString(36).slice(2)}` }
}

export interface RescheduleResult {
  ok: boolean
  state: BookingState
  emailJobCreated: boolean
}

/** Admin offers new dates → RESCHEDULE_REQUESTED + RESCHEDULE_REQUESTED event. */
export async function offerNewDates(params: {
  bookingId: string
  offeredDates: string[]
  rescheduleUrl: string
  customerName: string
  customerEmail: string
  requestedDate: string | null
}): Promise<RescheduleResult> {
  return prisma.$transaction(async (tx) => {
    const current = await readBookingOutboxState(tx, params.bookingId)
    if (current === undefined) throw new Error(`Booking ${params.bookingId} not found`)
    const from = current ?? BookingState.PENDING_APPROVAL

    const target = nextState(from, EventType.RESCHEDULE_REQUESTED) // RESCHEDULE_REQUESTED
    await writeBookingOutboxState(tx, params.bookingId, target)

    const payload: RescheduleRequestedPayload = {
      bookingId: params.bookingId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      requestedDate: params.requestedDate,
      offeredDates: params.offeredDates,
      rescheduleUrl: params.rescheduleUrl,
    }
    const { inserted } = await saveEmailJob(tx, {
      bookingId: params.bookingId,
      eventType: EventType.RESCHEDULE_REQUESTED,
      payload,
    })

    return { ok: true, state: target, emailJobCreated: inserted }
  })
}

/**
 * Customer picks a new date.
 *  - RESCHEDULE_REQUESTED -> PENDING_APPROVAL
 *  - insert NEW_DATE_PICKED event (idempotent)
 *  - post a fresh approval card AFTER the transaction commits.
 */
export async function customerPicksDate(params: {
  bookingId: string
  newDate: string // ISO
  customerName: string
  customerEmail: string
}): Promise<{ ok: boolean; state: BookingState; cardMessageId: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const current = await readBookingOutboxState(tx, params.bookingId)
    if (current === undefined) throw new Error(`Booking ${params.bookingId} not found`)
    const from = current ?? BookingState.RESCHEDULE_REQUESTED

    if (from !== BookingState.RESCHEDULE_REQUESTED) {
      throw new InvalidTransitionError(from, EventType.NEW_DATE_PICKED)
    }
    const target = nextState(from, EventType.NEW_DATE_PICKED) // PENDING_APPROVAL
    await writeBookingOutboxState(tx, params.bookingId, target)

    const payload: NewDatePickedPayload = {
      bookingId: params.bookingId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      requestedDate: params.newDate,
      newDate: params.newDate,
    }
    await saveEmailJob(tx, {
      bookingId: params.bookingId,
      eventType: EventType.NEW_DATE_PICKED,
      payload,
    })

    return target
  })

  // Side effect outside the transaction (don't post a card if the txn rolled back).
  const card = await postApprovalCard({
    bookingId: params.bookingId,
    customerName: params.customerName,
    newDate: params.newDate,
  })

  return { ok: true, state: result, cardMessageId: card.messageId }
}
