// ════════════════════════════════════════════════════════════════════════
//  deposit-evidence.ts — ONE reader for "what can this booking PROVE about the
//  $49?", shared by every surface that has to say something about it.
//
//  ITEM C1/C2 (2026-08-16). Before this, each surface answered the question its
//  own way and every one of them answered it from an INTENTION column:
//
//    • app/my-booking/[token]/page.tsx  — `booking.depositAmount ?? 4900` for
//      the figure and `status === 'cancelled'` for the outcome, so a cancelled
//      booking said "$49 hold released · you were not charged" over a CAPTURED
//      $49 (release blocker B2);
//    • the admin cancellation email      — `booking.depositPaid` chose the
//      template and `booking.depositAmount` supplied the amount. `depositPaid`
//      is set by the approval CLAIM, before the money moves;
//    • the job money card                — "Deposit (Stripe) $X · captured",
//      same two columns.
//
//  THE FACTS THIS MODULE USES, and why each one is evidence:
//    money            — Payment rows, through `provenDepositMoney`: a captured
//                       row must carry Stripe's own processor id and sit on
//                       THIS booking's PaymentIntent.
//    authorizedCents  — the AuditLog row src/lib/fulfillment.ts writes at
//                       checkout: `{ authorized: true, amount }`, where `amount`
//                       is Stripe's `session.amount_total`. That is the only
//                       recorded figure for the HOLD; `Booking.depositAmount` is
//                       what the booking was supposed to be charged.
//    release          — the AuditLog row `recordDecline` writes:
//                       `{ stripeResult: 'hold_released' | 'no_hold' |
//                       'release_failed: …' }`, written from the OUTCOME of the
//                       Stripe call. There is no `Booking.depositReleasedAt`
//                       column (migrations here are applied by hand), and this
//                       row already exists in every live database.
//
//  FAILS TO UNKNOWN, NEVER TO A GUESS: any read that throws (including the
//  code-before-SQL window) yields `degraded: true` with no money, no figure and
//  no release claim — which every renderer must treat as "say nothing".
//
//  The derivation is PURE (`depositEvidenceFrom`) so it is unit-testable
//  offline; only `readDepositEvidence` touches Prisma.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import {
  provenDepositMoney,
  provenAuthorizedHoldCents,
  provenHoldRelease,
  PROOF_PAYMENT_SELECT,
  type AuditEvidenceRow,
  type DepositMoney,
  type HoldReleaseEvidence,
  type ProofPayment,
} from '../outbox/domain/captured-amount'

/** Exactly the Payment columns the proof rule reads. An explicit select can
 *  never break on a column the running deploy's database has not got.
 *
 *  ITEM C1 (round 8) — this is now the SAME object the receipt route and the
 *  outbox confirmation renderer select with (`PROOF_PAYMENT_SELECT`). It used
 *  to be one of three hand-copied lists, and the other two had not been updated
 *  when the rule began asking for `stripeChargeId`. */
export const DEPOSIT_PROOF_PAYMENT_SELECT = PROOF_PAYMENT_SELECT

/** The AuditLog actions that carry money evidence. Both predate every pending
 *  migration, so this read is safe in the deploy window. */
const EVIDENCE_ACTIONS = ['PAYMENT_RECEIVED', 'BOOKING_STATE_CHANGED'] as const

export interface DepositEvidence {
  /** What the card was actually charged, if anything. */
  money: DepositMoney
  /** CENTS Stripe reported as AUTHORIZED, or null. */
  authorizedCents: number | null
  /** What became of that authorization. */
  release: HoldReleaseEvidence
  /** TRUE when a read failed: nothing below is knowledge, so no surface may
   *  make a claim from it. */
  degraded: boolean
}

/**
 * ITEM C1 (round 8) — THE FLAG NOBODY READ.
 *
 * `degraded` was computed here and consulted by NO shipped caller — the same
 * shape as C3-2's `failed`. It matters because the "unknown" evidence value is
 * NOT neutral downstream: `money.state === 'none'` reads as "the card was not
 * charged", and `release === 'unknown'` reads as "the hold is unresolved". So a
 * ledger read that merely FAILED produced, from the shipped code:
 *
 *   • the admin cancellation email choosing `booking-declined` over
 *     `booking-cancellation` for a CAPTURED booking — "your booking is
 *     cancelled and we're releasing the authorization on your card", sent about
 *     a $49 we had taken. That is release blocker B2 reached through a P2022 or
 *     a Neon blip instead of through the mis-ordered ternary;
 *   • the customer portal rendering "Nothing is owed · we're releasing the
 *     authorization on your card" on that same booking.
 *
 * A read failure is not evidence of anything. `canClaimDepositState` is the ONE
 * predicate every money surface asks before it words a sentence about the card;
 * `false` means say the booking's state and nothing about the money.
 */
export const canClaimDepositState = (e: DepositEvidence): boolean => !e.degraded

export const UNKNOWN_DEPOSIT_EVIDENCE: DepositEvidence = {
  money: { state: 'none', reason: 'no_payment_row' },
  authorizedCents: null,
  release: 'unknown',
  degraded: true,
}

/** PURE. Rows in, evidence out. `audits` must be NEWEST FIRST — a retried
 *  release that finally succeeded has to outrank the earlier failure. */
export function depositEvidenceFrom(
  payments: ProofPayment[] | null | undefined,
  audits: AuditEvidenceRow[] | null | undefined,
  opts: { stripePaymentIntentId?: string | null } = {},
): DepositEvidence {
  return {
    money: provenDepositMoney(payments, opts),
    authorizedCents: provenAuthorizedHoldCents(audits),
    release: provenHoldRelease(audits),
    degraded: false,
  }
}

/**
 * Read the evidence for one booking. NEVER THROWS — a surface that cannot read
 * the ledger must render "unknown", not 500 and not a default.
 */
export async function readDepositEvidence(
  bookingId: string,
  opts: { stripePaymentIntentId?: string | null } = {},
): Promise<DepositEvidence> {
  try {
    const [payments, audits] = await Promise.all([
      prisma.payment.findMany({ where: { bookingId }, select: DEPOSIT_PROOF_PAYMENT_SELECT }),
      prisma.auditLog.findMany({
        where: { bookingId, action: { in: [...EVIDENCE_ACTIONS] } },
        select: { action: true, details: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ])
    return depositEvidenceFrom(payments as unknown as ProofPayment[], audits as AuditEvidenceRow[], opts)
  } catch (err) {
    console.error(
      `[deposit-evidence] could not read the money evidence for ${bookingId} — every surface will state nothing:`,
      err instanceof Error ? err.message : err,
    )
    return UNKNOWN_DEPOSIT_EVIDENCE
  }
}

/** Dollars for a proven CENTS figure, or null. The one formatter, so a null can
 *  never become "$0.00" on the way to a customer. */
export const provenDollars = (cents: number | null | undefined): string | null =>
  typeof cents === 'number' && Number.isFinite(cents) ? (cents / 100).toFixed(2) : null
