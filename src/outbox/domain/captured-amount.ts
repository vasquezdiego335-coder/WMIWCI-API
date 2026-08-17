// ════════════════════════════════════════════════════════════════════════
//  ITEM D2 — WHAT MONEY THIS SYSTEM CAN PROVE IT TOOK.
//  ------------------------------------------------------------------------
//  Item M1 removed `?? booking.depositAmount` from the APPROVAL path: the
//  captured figure there now comes from Stripe or is `null`. The two paths that
//  actually ship a dollar figure to a customer still derived one from a booking
//  column:
//
//    • the OUTBOX confirmation — `ApprovedPayload` carried no amount, so
//      `premiumEmails.renderFinalConfirmation` fell through to
//      `dollarsFromCents(b?.depositAmount)`. With `depositAmount = 12345` the
//      customer's confirmation read "Your $123.45 deposit is applied to your
//      move" over a capture nothing had measured;
//    • the PAYMENT-RECEIPT resend route — `amountPaid` from `depositAmount`,
//      `captured` from `depositPaid`. A receipt is the strongest claim this
//      system makes about money, and both of its facts came from intention
//      columns. `depositPaid` is set by `claimConfirm` BEFORE any money moves
//      (see booking-approval.ts), so "captured: true" was routinely printed
//      over a Stripe capture that had not happened yet — or had failed.
//
//  THE RULE, in one place, used by both: a dollar figure may be printed only
//  when a COMPLETED Payment row carries it. That row is the ledger the approval
//  path writes ONLY from a Stripe-reported amount and deliberately REFUSES to
//  write when Stripe reports none (booking-approval.ts — `payments.amount` is
//  NOT NULL, so any row at all would be a figure). So a COMPLETED Payment row
//  is proof by construction, and its absence is the honest "unknown".
//
//  The predicates are IMPORTED rather than restated — `isCapturedPayment` /
//  `refundedCentsOf` (money-rules, the shipped revenue filter every aggregate
//  uses) and `isStripePayment` (profit.ts) — so what a customer is told and
//  what the books count can never drift, and a receipt never counts an owner
//  checkout test as money.
//
//  ────────────────────────────────────────────────────────────────────────
//  ITEM C1 — THE RULE ITSELF ACCEPTED MONEY STRIPE NEVER REPORTED.
//
//  The paragraph above says "a COMPLETED Payment row is proof by construction"
//  because the approval path writes that row ONLY from a Stripe-reported
//  amount. That premise is true of the APPROVAL path and false of the ledger:
//  `app/api/admin/payments/route.ts` writes COMPLETED Payment rows for CASH /
//  ZELLE / move-day money from an amount an owner TYPES, with no Stripe id at
//  all, and `scripts/stage4-closeout-rehearsal.ts` writes them from a booking's
//  own expected deposit figure. Two ways that reached a customer:
//
//    • a booking whose $49 was never captured, with a $650 move-day cash
//      payment recorded, PROVED a "$650.00 · Charged to your card" deposit
//      receipt — the oldest-COMPLETED fallback picked a row that is not the
//      deposit and not a card charge;
//    • a rehearsal/manual row carrying `depositAmount` re-entered by hand IS
//      the booking column, one table over. "The ledger has it" was never the
//      question; "Stripe reported it" is.
//
//  So the rule now asks for STRIPE'S OWN EVIDENCE — a processor id on the row
//  (`isStripePayment`, the same shipped predicate profit.ts uses to decide
//  which rows carry a processor fee) — and, when the booking names its own
//  PaymentIntent, for the row to be ON THAT INTENT. A move-day payment carries
//  a different intent (or none) and can never stand in for the deposit; this is
//  the same rule `depositEvidenceLines` (app/api/discord/interactions/route.ts)
//  already applies to the owner's card.
//
//  A manual cash payment is still real money and still counts as revenue — it
//  is simply not evidence of a captured CARD DEPOSIT, which is the only thing
//  this module was ever asked about.
//  ────────────────────────────────────────────────────────────────────────
//
//  PURE — no prisma, no network, no Date.now(). Each caller reads its own rows.
// ════════════════════════════════════════════════════════════════════════

import { isStripePayment } from '../../lib/profit'
import { isCapturedPayment, refundedCentsOf, hasUnknownRefundAmount } from '../../lib/money-rules'

/** The Payment columns this rule needs. A caller may `select` exactly these. */
export interface ProofPayment {
  id?: string | null
  /** CENTS. */
  amount: number
  status: string
  isInternalTest?: boolean | null
  stripePaymentIntentId?: string | null
  /** ITEM C1 — the second half of "Stripe reported this". A row written from a
   *  charge event carries the charge id; a row an owner typed carries neither. */
  stripeChargeId?: string | null
  /** CENTS refunded so far (monotonic, from Stripe's cumulative
   *  `amount_refunded` — see payment-events.refundPatch). */
  refundedAmountCents?: number | null
  createdAt?: Date | null
}

/**
 * ITEM C1 (round 8) — THE ONE SELECT, so every reader runs the SAME rule.
 *
 * Three callers each kept their own copy of "the Payment columns the proof rule
 * needs", and two of them (`premiumEmails.ledgerCapturedCents` and the receipt
 * resend route) had NOT been updated when the rule started asking for Stripe's
 * own evidence: they omitted `stripeChargeId`, so `isStripePayment` below could
 * only ever see half its input, and they omitted `refundedAmountCents`, so a
 * refund was invisible to them. A rule is only as good as the columns handed to
 * it, and a hand-copied column list is exactly what drifts.
 *
 * Declared HERE (pure, no Prisma) so both the outbox and `src/lib` can import
 * it, and typed `as const` so it is usable directly as a Prisma `select`.
 */
export const PROOF_PAYMENT_SELECT = {
  id: true,
  amount: true,
  status: true,
  isInternalTest: true,
  stripePaymentIntentId: true,
  stripeChargeId: true,
  refundedAmountCents: true,
  createdAt: true,
} as const

/** Why no figure may be printed. Each is a different owner instruction, so they
 *  are kept apart rather than collapsed into one "not found". */
export type UnprovenReason =
  | 'no_payment_row' // nothing recorded for this booking at all
  | 'not_completed' // rows exist, none is COMPLETED (hold, failed, refunded)
  | 'internal_test_only' // the only COMPLETED rows are owner checkout tests
  | 'not_stripe_reported' // COMPLETED rows exist, none carries a Stripe id (item C1)
  | 'intent_mismatch' // COMPLETED Stripe rows exist, none on THIS booking's intent
  | 'no_amount' // a COMPLETED row whose amount is not a usable figure

export type CapturedProof =
  | { proven: true; cents: number; paymentId: string | null; capturedAt: Date | null }
  | { proven: false; reason: UnprovenReason }

/** Oldest first; a row with no createdAt sorts last (it cannot claim to be the
 *  first money in). Stable for equal timestamps. */
function oldestFirst(rows: ProofPayment[]): ProofPayment[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const at = a.row.createdAt?.getTime?.()
      const bt = b.row.createdAt?.getTime?.()
      if (at == null && bt == null) return a.index - b.index
      if (at == null) return 1
      if (bt == null) return -1
      return at === bt ? a.index - b.index : at - bt
    })
    .map((x) => x.row)
}

/**
 * ITEM C1 — THE SELECTION, in one place, for both rules below.
 *
 * The ladder is ordered so the caller learns WHICH fact is missing:
 *   1. rows at all               → no_payment_row
 *   2. rows in the asked-for money state (COMPLETED, or captured-incl-refunded)
 *   3. not an owner checkout test → internal_test_only
 *   4. STRIPE REPORTED IT — a processor id on the row. A manual CASH/ZELLE row
 *      is real money and real revenue, but it is not evidence of a captured
 *      card deposit, and its amount was typed by hand → not_stripe_reported
 *   5. ON THIS BOOKING'S INTENT when the booking names one. The deposit IS that
 *      intent; a move-day charge is different money → intent_mismatch
 * With no intent on the booking, the OLDEST qualifying row wins — the deposit
 * is always the first money in.
 */
function chooseDepositRow(
  payments: ProofPayment[] | null | undefined,
  opts: { stripePaymentIntentId?: string | null },
  inState: (p: ProofPayment) => boolean,
  wrongStateReason: UnprovenReason,
): { row: ProofPayment } | { reason: UnprovenReason } {
  const rows = payments ?? []
  if (rows.length === 0) return { reason: 'no_payment_row' }

  const staged = rows.filter(inState)
  if (staged.length === 0) return { reason: wrongStateReason }

  const real = staged.filter((p) => !p.isInternalTest)
  if (real.length === 0) return { reason: 'internal_test_only' }

  // THE C1 FIX. `isStripePayment` is the shipped predicate (src/lib/profit.ts):
  // a row is Stripe's only if it carries a processor id.
  const reported = real.filter((p) =>
    isStripePayment({ stripePaymentIntentId: p.stripePaymentIntentId, stripeChargeId: p.stripeChargeId }),
  )
  if (reported.length === 0) return { reason: 'not_stripe_reported' }

  const intentId = opts.stripePaymentIntentId
  if (intentId) {
    const onIntent = reported.find((p) => p.stripePaymentIntentId === intentId)
    // No silent fallback to "some other completed row": that is how a $650
    // move-day payment became a $650 deposit receipt.
    return onIntent ? { row: onIntent } : { reason: 'intent_mismatch' }
  }
  return { row: oldestFirst(reported)[0] }
}

/**
 * The deposit payment this booking can PROVE, or the reason it cannot.
 *
 * Selection when several COMPLETED rows exist: the one on the booking's own
 * PaymentIntent wins (that intent IS the $49 deposit). Otherwise the OLDEST
 * completed row — the deposit is always the first money collected; anything
 * later is a move-day payment and is not what a deposit receipt states.
 *
 * ITEM C1 — and in EVERY case the row must carry Stripe's own evidence. This is
 * the rule a receipt rests on ("charged to your card"), so a hand-entered cash
 * row is not an answer to it.
 */
export function provenCapturedDeposit(
  payments: ProofPayment[] | null | undefined,
  opts: { stripePaymentIntentId?: string | null } = {},
): CapturedProof {
  const chosenOrReason = chooseDepositRow(payments, opts, (p) => p.status === 'COMPLETED', 'not_completed')
  if ('reason' in chosenOrReason) return { proven: false, reason: chosenOrReason.reason }
  const chosen = chosenOrReason.row

  const cents = chosen.amount
  // A row whose amount is not a positive finite number is not a figure. The
  // column is NOT NULL, so this is the "somebody wrote a 0/NaN" guard, and it
  // fails to UNKNOWN rather than printing "$0.00" on a receipt.
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) {
    return { proven: false, reason: 'no_amount' }
  }
  return { proven: true, cents, paymentId: chosen.id ?? null, capturedAt: chosen.createdAt ?? null }
}

/** Proven cents, or null. The shape every renderer wants. */
export function provenCapturedCents(
  payments: ProofPayment[] | null | undefined,
  opts: { stripePaymentIntentId?: string | null } = {},
): number | null {
  const proof = provenCapturedDeposit(payments, opts)
  return proof.proven ? proof.cents : null
}

/** What the OWNER is told when a receipt cannot be sent. Each sentence names
 *  the missing fact and the next action — never "something went wrong", and
 *  never a guess at the amount. */
export function unprovenExplanation(reason: UnprovenReason): string {
  switch (reason) {
    case 'no_payment_row':
      return 'No payment is recorded for this booking, so a receipt would have to state an amount nothing has verified. Check the deposit in Stripe and record the payment on the booking first.'
    case 'not_completed':
      return 'This booking has no COMPLETED payment — the deposit is still an authorization hold, failed, or was refunded. A receipt may only be sent once the capture is recorded.'
    case 'internal_test_only':
      return 'The only completed payment on this booking is an internal checkout test, which is never counted as money. No receipt was sent.'
    case 'not_stripe_reported':
      return 'The completed payments on this booking are manually recorded (cash / Zelle / move-day) money with no Stripe charge behind them. A deposit receipt states a card charge, so it may not be sent from a hand-entered amount — record the Stripe capture, or send the customer a move-day receipt instead.'
    case 'intent_mismatch':
      return "This booking's own deposit authorization has no completed payment — the completed money on it belongs to a different charge (a move-day payment). A deposit receipt may only state the deposit, so nothing was sent."
    case 'no_amount':
      return 'The completed payment on this booking carries no usable amount, so there is no figure to put on a receipt. Check the payment record against Stripe.'
  }
}

// ════════════════════════════════════════════════════════════════════════
//  ITEM C1/C2 — THE DEPOSIT'S MONEY STATE, for surfaces that must speak about
//  a CANCELLED booking.
//
//  `provenCapturedDeposit` above answers one question — "may a receipt be
//  sent?" — and answers it COMPLETED-only, so a captured-then-refunded deposit
//  correctly reads as "no". But the portal, the cancellation email and the
//  admin card have to say something about that same deposit, and "not
//  COMPLETED" is not an answer a customer can be shown. Blocker B2 is exactly
//  this gap: the portal asked the BOOKING STATUS instead, and every cancelled
//  booking got "you were not charged" — including the ones that were.
//
//  The money states come from the shipped money-rules predicates
//  (`isCapturedPayment` / `refundedCentsOf` / `hasUnknownRefundAmount`), so
//  this cannot drift from what the revenue aggregates count.
// ════════════════════════════════════════════════════════════════════════

export type DepositMoney =
  | {
      /** Money left the customer's card and is (partly) still with us. */
      state: 'captured' | 'partially_refunded' | 'refunded'
      /** CENTS captured. */
      cents: number
      /** CENTS refunded so far. */
      refundedCents: number
      /** TRUE when a refund is recorded but its amount is not knowable. No
       *  figure may be printed for it. */
      refundAmountUnknown: boolean
      paymentId: string | null
      capturedAt: Date | null
    }
  | { state: 'none'; reason: UnprovenReason }

/**
 * What this booking can prove about its DEPOSIT card charge.
 *
 * `state: 'none'` means exactly "nothing here proves the card was charged" —
 * which is the only thing a surface may say. It is NOT proof that the customer
 * was not charged; that needs the release evidence below (or the absence of any
 * authorization at all).
 */
export function provenDepositMoney(
  payments: ProofPayment[] | null | undefined,
  opts: { stripePaymentIntentId?: string | null } = {},
): DepositMoney {
  const chosen = chooseDepositRow(
    payments,
    opts,
    (p) => isCapturedPayment({ amount: p.amount, status: p.status, isInternalTest: p.isInternalTest }),
    'not_completed',
  )
  if ('reason' in chosen) return { state: 'none', reason: chosen.reason }

  const row = chosen.row
  const cents = row.amount
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return { state: 'none', reason: 'no_amount' }

  const refundedCents = refundedCentsOf({
    amount: cents,
    status: row.status,
    refundedAmountCents: row.refundedAmountCents,
  })
  const refundAmountUnknown = hasUnknownRefundAmount({
    amount: cents,
    status: row.status,
    refundedAmountCents: row.refundedAmountCents,
  })
  const state =
    refundedCents >= cents ? 'refunded' : refundedCents > 0 || refundAmountUnknown ? 'partially_refunded' : 'captured'

  return {
    state,
    cents,
    refundedCents,
    refundAmountUnknown,
    paymentId: row.id ?? null,
    capturedAt: row.createdAt ?? null,
  }
}

// ── AuditLog evidence: the hold, and what happened to it ────────────────────
//
// There is no `Booking.depositReleasedAt` column and this repo applies
// migrations by hand, so the evidence used here is what the SHIPPED writers
// already persist:
//   • src/lib/fulfillment.ts   → AuditLog PAYMENT_RECEIVED
//                                `{ authorized: true, amount: <Stripe session
//                                amount_total>, paymentIntentId }`
//     — Stripe's own figure for the authorization, which is why it may be
//       printed as "the hold" where `Booking.depositAmount` may not.
//   • src/lib/booking-approval.ts recordDecline → AuditLog BOOKING_STATE_CHANGED
//                                `{ stripeResult: 'hold_released' | 'no_hold'
//                                | 'release_failed: …' }`
//     — written from the OUTCOME of the Stripe call, so it is the only record
//       of whether the authorization was actually voided.
// Both readers are pure and tolerate any shape (a row from an older writer, a
// JSON blob, a null) by answering "unknown".

export interface AuditEvidenceRow {
  action?: string | null
  details?: unknown
}

function detailsOf(row: AuditEvidenceRow): Record<string, unknown> | null {
  const d = row?.details
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  return d as Record<string, unknown>
}

/** CENTS Stripe reported as AUTHORIZED for this booking, or null when nothing
 *  recorded one. Never `Booking.depositAmount` — that column is the intention. */
export function provenAuthorizedHoldCents(rows: AuditEvidenceRow[] | null | undefined): number | null {
  for (const row of rows ?? []) {
    if (row?.action && row.action !== 'PAYMENT_RECEIVED') continue
    const d = detailsOf(row)
    if (!d || d.authorized !== true) continue
    const amount = d.amount
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return amount
  }
  return null
}

export type HoldReleaseEvidence =
  /** A decline ran and Stripe accepted the cancellation of the authorization. */
  | 'released'
  /** A decline ran and there was no authorization to release (no intent). */
  | 'no_hold'
  /** A decline ran and the Stripe release THREW. The hold may still be live. */
  | 'release_failed'
  /** Nothing recorded an outcome either way. */
  | 'unknown'

/** What the audit trail proves about the authorization on this booking's card.
 *  Newest evidence wins: a retried decline that succeeds must be able to
 *  overwrite an earlier `release_failed`, and callers pass rows newest-first. */
export function provenHoldRelease(rows: AuditEvidenceRow[] | null | undefined): HoldReleaseEvidence {
  for (const row of rows ?? []) {
    if (row?.action && row.action !== 'BOOKING_STATE_CHANGED') continue
    const d = detailsOf(row)
    const result = d?.stripeResult
    if (typeof result !== 'string') continue
    if (result === 'hold_released') return 'released'
    if (result === 'no_hold') return 'no_hold'
    if (result.startsWith('release_failed')) return 'release_failed'
  }
  return 'unknown'
}
