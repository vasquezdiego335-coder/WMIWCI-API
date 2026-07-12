// ─────────────────────────────────────────────────────────────────────────
// waiting-time.ts — the SINGLE source of truth for the Late Arrival & Delay
// Policy: the fee math AND every piece of customer-facing copy.
//
// Company policy (owner spec 2026-07-12):
//   • Movers reserve an exclusive arrival window per customer.
//   • Complimentary 30-minute grace period from crew arrival.
//   • After the grace period, waiting time is billable at $50 per additional
//     30-minute block (or any portion thereof).
//   • Delays beyond 90 minutes without prior approval may be rescheduled,
//     moved to the next opening, or cancelled — at our discretion.
//
// Like the travel fee and the truck add-on, the waiting fee is COLLECTED ON
// MOVE DAY. It is NEVER added to the $49 Stripe deposit and is never
// auto-charged; it is tracked, waivable, and marked collected by staff.
//
// This module is PURE (no prisma, no network) so it can be unit-tested and
// shared by the admin dashboard, customer portal, receipts, emails, SMS, the
// Discord crew card, and the /api endpoints. The static marketing site cannot
// import TypeScript, so it re-states the SAME copy verbatim — keep the two in
// sync (public/pricing.html, faq.html, terms/index.html, agreements.html,
// booking-form.html).
// ─────────────────────────────────────────────────────────────────────────

/** Complimentary grace period, in minutes, from crew arrival. */
export const WAITING_GRACE_MINUTES = 30

/** Billing block length, in minutes. Any portion of a block bills as a full block. */
export const WAITING_BLOCK_MINUTES = 30

/** Fee per billable block, in cents. $50. */
export const WAITING_BLOCK_FEE_CENTS = 5000

/**
 * Beyond this many total waiting minutes, and without prior approval, we
 * reserve the right to reschedule / move to the next opening / cancel.
 */
export const WAITING_RESCHEDULE_THRESHOLD_MINUTES = 90

export interface WaitingFeeResult {
  /** Total minutes the crew waited (grace included). Never negative. */
  totalMinutes: number
  /** Minutes covered by the complimentary grace period. */
  freeMinutes: number
  /** Billable minutes after the grace period. */
  billableMinutes: number
  /** Number of billable 30-minute blocks (portion rounds up). */
  billableBlocks: number
  /** Waiting fee in cents (billableBlocks × $50). */
  feeCents: number
  /** True once total waiting exceeds the 90-minute reschedule threshold. */
  exceedsRescheduleThreshold: boolean
}

/**
 * Compute the waiting fee from a total number of waiting minutes.
 *
 * The first 30 minutes are free; every 30-minute block after that (or any
 * portion of one) is $50.
 *
 *   0–30 min  → $0
 *   31–60 min → $50   (1 block)
 *   61–90 min → $100  (2 blocks)
 *   91–120min → $150  (3 blocks)
 */
export function computeWaitingFee(totalWaitingMinutes: number): WaitingFeeResult {
  const totalMinutes = Math.max(0, Math.round(totalWaitingMinutes || 0))
  const freeMinutes = Math.min(totalMinutes, WAITING_GRACE_MINUTES)
  const billableMinutes = Math.max(0, totalMinutes - WAITING_GRACE_MINUTES)
  const billableBlocks =
    billableMinutes > 0 ? Math.ceil(billableMinutes / WAITING_BLOCK_MINUTES) : 0
  const feeCents = billableBlocks * WAITING_BLOCK_FEE_CENTS
  return {
    totalMinutes,
    freeMinutes,
    billableMinutes,
    billableBlocks,
    feeCents,
    exceedsRescheduleThreshold: totalMinutes > WAITING_RESCHEDULE_THRESHOLD_MINUTES,
  }
}

/**
 * Minutes between two timestamps, clamped at 0. `end` defaults to now (for a
 * live, still-waiting job). Either arg missing → 0.
 */
export function waitingMinutesBetween(
  start: Date | string | null | undefined,
  end?: Date | string | null,
): number {
  if (!start) return 0
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0
  return Math.max(0, Math.round((endMs - startMs) / 60000))
}

/**
 * Resolve the effective waiting window from the four crew timestamps and
 * compute the fee. Precedence for the window:
 *   1. waitingStartedAt → waitingEndedAt   (explicit crew taps; the live path
 *      uses `now` when waiting has started but not ended)
 *   2. crewArrivedAt   → customerReadyAt    (fallback if no explicit window)
 *
 * `ongoing` is true when waiting has started but not yet ended.
 */
export function resolveWaiting(input: {
  crewArrivedAt?: Date | string | null
  customerReadyAt?: Date | string | null
  waitingStartedAt?: Date | string | null
  waitingEndedAt?: Date | string | null
}): WaitingFeeResult & { ongoing: boolean; source: 'explicit' | 'arrival' | 'none' } {
  const { crewArrivedAt, customerReadyAt, waitingStartedAt, waitingEndedAt } = input

  if (waitingStartedAt) {
    // Either explicit "Waiting Ended" or "Customer Ready" closes the window.
    const end = waitingEndedAt ?? customerReadyAt ?? null
    const ongoing = !end
    const minutes = waitingMinutesBetween(waitingStartedAt, end)
    return { ...computeWaitingFee(minutes), ongoing, source: 'explicit' }
  }
  if (crewArrivedAt && customerReadyAt) {
    const minutes = waitingMinutesBetween(crewArrivedAt, customerReadyAt)
    return { ...computeWaitingFee(minutes), ongoing: false, source: 'arrival' }
  }
  return { ...computeWaitingFee(0), ongoing: false, source: 'none' }
}

/** Whole dollars string for display, e.g. 10000 → "$100". */
export function feeDollars(cents: number): string {
  return `$${Math.round(cents / 100)}`
}

// ── Policy copy — ONE place the wording lives (mirror into static HTML) ─────
//    Tone: fair, professional, respectful of both the customer's and the
//    crew's time. Explains WHY. Never punitive, never "gotcha".
export const WAITING_POLICY = {
  /** Short headline used on cards/sections. */
  title: 'Arrival & Waiting Time',

  /** One-line summary for tight spaces (booking summary, portal). */
  summary:
    'Complimentary 30-minute grace period on arrival. Additional waiting time is $50 per 30 minutes.',

  /** The empathetic "why" paragraph (pricing page, FAQ, confirmation). */
  why:
    'We understand unexpected delays happen. To keep every move running on schedule for you and the customers after you, we reserve an exclusive arrival window and provide a complimentary 30-minute grace period. Additional waiting time may incur a waiting fee to fairly compensate our crew for the reserved time they’ve set aside for your move.',

  /** The fee schedule, as ordered lines. */
  schedule: [
    'First 30 minutes: complimentary',
    'Each additional 30 minutes (or part thereof): $50',
  ] as string[],

  /** What happens past 90 minutes. */
  extendedDelay:
    'If a delay exceeds 90 minutes without prior arrangement, we may need to reschedule your move to the next available opening so our other customers stay on time. We’ll always talk it through with you first whenever we can.',

  /** Required booking-form acknowledgment (exact owner wording). */
  acknowledgment:
    'I understand Move It Clear It includes a complimentary 30-minute waiting period. Additional waiting time may result in waiting fees or rescheduling.',

  /** Booking confirmation email line. */
  emailConfirmation:
    'Please be packed and ready before your scheduled arrival time. We include a complimentary 30-minute grace period. Extended delays may result in waiting fees or rescheduling.',

  /** 24-hour reminder email line. */
  emailReminder:
    'To help your move begin on time, please have everything packed and accessible before our crew arrives. Your booking includes a complimentary 30-minute grace period on arrival; additional waiting time is billed at $50 per 30 minutes.',

  /** Day-of-move SMS (kept short for one segment where possible). */
  sms:
    'Move It Clear It: our crew is on the way! Please have everything packed and ready. Your move includes a complimentary 30-minute grace period on arrival — additional waiting time may result in waiting charges. Thank you!',
  smsEs:
    'Move It Clear It: ¡nuestro equipo va en camino! Por favor ten todo empacado y listo. Tu mudanza incluye 30 minutos de cortesía al llegar — el tiempo de espera adicional puede generar cargos. ¡Gracias!',

  /** Customer-portal status lines. */
  portalWaitingStarted: 'Your crew has arrived and is waiting for access.',
  portalBillableStarted:
    'Your complimentary grace period has ended, so waiting time is now being applied. Please meet your crew as soon as you can.',
} as const

/**
 * The fee actually owed, honoring a staff waiver / manual override. This is the
 * ONE resolver every surface (receipt, portal, admin, card) must use so the
 * charged amount is consistent.
 *   waived               → $0
 *   waitingFeeOverride   → that exact amount (staff hand-set)
 *   otherwise            → waitingFee (persisted derived value) ?? 0
 */
export function effectiveWaitingFeeCents(booking: {
  waitingFee?: number | null
  waitingFeeOverride?: number | null
  waitingFeeWaived?: boolean | null
}): number {
  if (booking.waitingFeeWaived) return 0
  if (booking.waitingFeeOverride != null) return Math.max(0, Math.round(booking.waitingFeeOverride))
  return Math.max(0, Math.round(booking.waitingFee ?? 0))
}

/** The automatic day-of-move reminder SMS, localized. */
export function dayOfMoveSms(locale?: string | null): string {
  return (locale ?? 'en').toLowerCase().startsWith('es') ? WAITING_POLICY.smsEs : WAITING_POLICY.sms
}

/** Receipt / invoice line-item label for a computed waiting fee. */
export function waitingLineItemLabel(result: WaitingFeeResult): string {
  // Show BILLABLE minutes (grace excluded) so the charge is self-explanatory.
  return `Waiting Time (${result.billableMinutes} min past grace)`
}
