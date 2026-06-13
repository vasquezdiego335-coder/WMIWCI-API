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
}

export interface PaymentCompletedPayload extends BookingSnapshot {
  amountPaid: string // e.g. "49.00"
}
export interface ApprovedPayload extends BookingSnapshot {
  approvedBy: string
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
