// ════════════════════════════════════════════════════════════════════════
//  TYPED EMAIL STATUS LAYER (Phase 4).
//  A single, tested source of truth for "what is TRUE about a booking in state
//  X" so an email can never mislabel it — e.g. a `final-confirmation` must never
//  go out for a booking that isn't CONFIRMED, and payment language must match
//  the real PaymentStatus (a hold is not a charge; a refund is not a payment).
//
//  The unions below MIRROR the Prisma enums (prisma/schema.prisma). They're
//  written as string-literal unions so the email layer stays free of a runtime
//  dependency on the generated client, and `satisfies` pins them to the Prisma
//  types at compile time (a drift in the schema breaks the build here).
// ════════════════════════════════════════════════════════════════════════
import type { BookingStatus as PrismaBookingStatus, PaymentStatus as PrismaPaymentStatus } from '@prisma/client'

export type BookingStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'PENDING_APPROVAL'
  | 'CONFIRMED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'ARCHIVED'
  | 'CANCELLED'

export type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'

// Compile-time proof the mirror matches Prisma in BOTH directions. If the schema
// adds/removes a value, one of these assignments becomes `never` and the build
// fails here — forcing this file to be kept in sync.
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _bookingMirror: AssertEqual<BookingStatus, PrismaBookingStatus> = true
const _paymentMirror: AssertEqual<PaymentStatus, PrismaPaymentStatus> = true
void _bookingMirror
void _paymentMirror

// ── Truth predicates ─────────────────────────────────────────────────────────
/** A booking is "confirmed" (deposit captured, on the calendar) only in these. */
export const CONFIRMED_STATES: readonly BookingStatus[] = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']
/** Still awaiting owner action / payment — NOTHING may be called "confirmed". */
export const PENDING_STATES: readonly BookingStatus[] = ['DRAFT', 'PENDING_PAYMENT', 'PENDING_APPROVAL']
export const CLOSED_STATES: readonly BookingStatus[] = ['CANCELLED', 'ARCHIVED']

export const isConfirmed = (s?: BookingStatus | string | null): boolean =>
  !!s && (CONFIRMED_STATES as readonly string[]).includes(s)
export const isPending = (s?: BookingStatus | string | null): boolean =>
  !!s && (PENDING_STATES as readonly string[]).includes(s)
export const isClosed = (s?: BookingStatus | string | null): boolean =>
  !!s && (CLOSED_STATES as readonly string[]).includes(s)
export const isCompleted = (s?: BookingStatus | string | null): boolean => s === 'COMPLETED'

// ── Template ↔ status compatibility (Phase 4 core) ───────────────────────────
// For templates whose truthfulness depends on booking state, the set of statuses
// in which the template is HONEST. A template not listed here has no state
// constraint (its own required-data checks still apply). Undefined status =
// unchecked (senders that don't pass a status are unaffected — opt-in gate).
export const TEMPLATE_ALLOWED_STATUSES: Partial<Record<string, readonly BookingStatus[]>> = {
  // A confirmation asserts the booking IS confirmed — only truthful post-capture.
  'final-confirmation': CONFIRMED_STATES,
  // A reminder is for a real, on-the-calendar move.
  'job-reminder': ['CONFIRMED', 'SCHEDULED'],
  // Completion / review / invoice / referral come AFTER the move.
  'job-completion': ['COMPLETED'],
  'review-request': ['COMPLETED', 'ARCHIVED'],
  'final-invoice': ['COMPLETED', 'ARCHIVED'],
  // Cancellation is only honest once the booking is actually cancelled.
  'booking-cancellation': ['CANCELLED'],
}

/**
 * Returns a reason string if `template` would be DISHONEST for a booking in
 * `status`, else null. No status supplied (or template unconstrained) → null.
 */
export function statusMismatchReason(template: string, status?: BookingStatus | string | null): string | null {
  if (!status) return null
  const allowed = TEMPLATE_ALLOWED_STATUSES[template]
  if (!allowed) return null
  return (allowed as readonly string[]).includes(status)
    ? null
    : `${template} is not truthful for a booking in ${status} (allowed: ${allowed.join(', ')})`
}

// ── Payment language (Phase 4) ───────────────────────────────────────────────
export type PaymentPhase = 'hold' | 'charged' | 'failed' | 'refunded' | 'partially_refunded' | 'unknown'

export function paymentPhase(s?: PaymentStatus | string | null): PaymentPhase {
  switch (s) {
    case 'PENDING':
      return 'hold' // an authorization hold — NOT yet a charge
    case 'COMPLETED':
      return 'charged'
    case 'FAILED':
      return 'failed'
    case 'REFUNDED':
      return 'refunded'
    case 'PARTIALLY_REFUNDED':
      return 'partially_refunded'
    default:
      return 'unknown'
  }
}

/** Short, honest, bilingual label for a payment phase (never "paid" for a hold). */
export function paymentLabel(s: PaymentStatus | string | null | undefined, es = false): string {
  const map: Record<PaymentPhase, [string, string]> = {
    hold: ['Authorization hold', 'Autorización (retención)'],
    charged: ['Payment received', 'Pago recibido'],
    failed: ['Payment failed', 'Pago fallido'],
    refunded: ['Refunded', 'Reembolsado'],
    partially_refunded: ['Partially refunded', 'Reembolsado parcialmente'],
    unknown: ['Payment', 'Pago'],
  }
  const [en, esL] = map[paymentPhase(s)]
  return es ? esL : en
}
