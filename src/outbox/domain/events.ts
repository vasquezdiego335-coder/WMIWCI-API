// ════════════════════════════════════════════════════════════════════════
//  Outbox events + payloads.
//  Each event is recorded as one row in email_jobs and (optionally) maps to a
//  customer email. The idempotency key is always `${bookingId}::${eventType}`.
// ════════════════════════════════════════════════════════════════════════

export enum EventType {
  PAYMENT_COMPLETED = 'PAYMENT_COMPLETED',
  APPROVED = 'APPROVED',
  RESCHEDULE_REQUESTED = 'RESCHEDULE_REQUESTED',
  NEW_DATE_PICKED = 'NEW_DATE_PICKED',
}

export type EmailJobStatus = 'pending' | 'processing' | 'sent' | 'failed'

/** Fields every email payload carries (denormalized so the worker never has to
 *  read the booking — the outbox stays self-contained). */
export interface BookingSnapshot {
  bookingId: string
  customerName: string
  customerEmail: string
  requestedDate: string | null // ISO
  items?: string // job details incl. access difficulty (stairs/long walk/heavy items)
}

export interface PaymentCompletedPayload extends BookingSnapshot {
  /**
   * ITEM C1 (round 8) — DOLLARS STRIPE REPORTED IT AUTHORIZED, e.g. "49.00", or
   * ABSENT when it reported none.
   *
   * This is the figure the customer's PRE-APPROVAL email prints as "$X hold",
   * and it used to be `(session.amount_total ?? 4900)` — so a Checkout Session
   * that carried no `amount_total` (the field is nullable in Stripe's API) put
   * the house $49 into a customer's inbox as an authorization nobody had
   * measured. The same run's AUDIT row records `amount: null` for that
   * authorization and the owner's fallback notice says "Stripe reported no
   * amount", so the system already knew; only the customer was told a number.
   *
   * OPTIONAL/UNDEFINED IS A REAL ANSWER: `renderPreApproval` passes it straight
   * through and `src/emails/pre-approval.tsx` then names the fee without naming
   * a figure. It must NEVER be filled from `Booking.depositAmount` or from
   * `BOOKING_FEE_CENTS` — neither is evidence of what was authorized.
   */
  amountPaid?: string | null
}
export interface ApprovedPayload extends BookingSnapshot {
  approvedBy: string
  /**
   * ITEM D2 — the CAPTURED amount in CENTS, and ONLY when this approval proved
   * one (item M1's `capturedAmountFromIntent`: Stripe's figure or `null`).
   *
   * It used to be absent entirely, so the renderer fell back to
   * `booking.depositAmount` and the customer's confirmation stated a figure
   * nothing had measured. ABSENT/NULL IS A REAL ANSWER — "captured, amount not
   * reported" is a state Stripe returns — and it means the confirmation names no
   * amount rather than guessing one. The renderer then re-checks the COMPLETED
   * Payment row, which is the same proof, before giving up on a figure.
   */
  capturedAmountCents?: number | null
}
export interface RescheduleRequestedPayload extends BookingSnapshot {
  offeredDates: string[]
  rescheduleUrl: string
}
export interface NewDatePickedPayload extends BookingSnapshot {
  newDate: string // ISO
}

export type EmailJobPayload =
  | PaymentCompletedPayload
  | ApprovedPayload
  | RescheduleRequestedPayload
  | NewDatePickedPayload

/** A row from email_jobs after it is read back from the DB. */
export interface EmailJob {
  id: string
  bookingId: string
  eventType: EventType
  idempotencyKey: string
  payload: EmailJobPayload
  status: EmailJobStatus
  attempts: number
  maxAttempts: number
  nextAttemptAt: Date
  createdAt: Date
}
