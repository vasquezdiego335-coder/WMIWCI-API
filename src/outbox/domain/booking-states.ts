import { EventType } from './events'

// ════════════════════════════════════════════════════════════════════════
//  Booking state machine (outbox).
//  Independent of the app's existing `BookingStatus` — this enum drives the
//  email-outbox transitions only, and is stored in bookings.outbox_state.
// ════════════════════════════════════════════════════════════════════════

export enum BookingState {
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  CONFIRMED = 'CONFIRMED',
  RESCHEDULE_REQUESTED = 'RESCHEDULE_REQUESTED',
}

/**
 * Deterministic event-driven transitions: (state, event) -> next state.
 * A missing entry means the transition is illegal.
 */
const TRANSITIONS: Record<BookingState, Partial<Record<EventType, BookingState>>> = {
  [BookingState.PAYMENT_PENDING]: {
    [EventType.PAYMENT_COMPLETED]: BookingState.PENDING_APPROVAL,
  },
  [BookingState.PENDING_APPROVAL]: {
    [EventType.APPROVED]: BookingState.APPROVED,
    [EventType.RESCHEDULE_REQUESTED]: BookingState.RESCHEDULE_REQUESTED,
  },
  [BookingState.APPROVED]: {
    [EventType.RESCHEDULE_REQUESTED]: BookingState.RESCHEDULE_REQUESTED,
  },
  [BookingState.RESCHEDULE_REQUESTED]: {
    [EventType.NEW_DATE_PICKED]: BookingState.PENDING_APPROVAL,
  },
  [BookingState.CONFIRMED]: {}, // terminal
}

/**
 * Non-event "system" transition: CONFIRMED is reached by an explicit confirm()
 * once a move is locked in. It emits no customer email, so it is intentionally
 * not part of the event-driven TRANSITIONS table above.
 */
const MANUAL_TRANSITIONS: Partial<Record<BookingState, BookingState[]>> = {
  [BookingState.APPROVED]: [BookingState.CONFIRMED],
}

export class InvalidTransitionError extends Error {
  constructor(public readonly from: BookingState, public readonly event: EventType) {
    super(`Illegal transition: ${from} cannot handle event ${event}`)
    this.name = 'InvalidTransitionError'
  }
}

export function canTransition(from: BookingState, event: EventType): boolean {
  return TRANSITIONS[from]?.[event] !== undefined
}

/** Returns the next state or throws InvalidTransitionError (deterministic). */
export function nextState(from: BookingState, event: EventType): BookingState {
  const to = TRANSITIONS[from]?.[event]
  if (!to) throw new InvalidTransitionError(from, event)
  return to
}

export function canConfirm(from: BookingState): boolean {
  return (MANUAL_TRANSITIONS[from] ?? []).includes(BookingState.CONFIRMED)
}
