import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'
import { readBookingWithMigrationFallback } from '@/lib/migration-window'
import { effectiveWaitingFeeCents, resolveWaiting } from '@/lib/waiting-time'
import {
  provenCapturedDeposit,
  unprovenExplanation,
  PROOF_PAYMENT_SELECT,
  type ProofPayment,
} from '@/outbox/domain/captured-amount'

// ════════════════════════════════════════════════════════════════════════
//  RESEND THE PAYMENT RECEIPT.
//
//  ITEM D2 — A RECEIPT IS THE STRONGEST CLAIM THIS SYSTEM MAKES ABOUT MONEY,
//  and this route used to derive both of its facts from intention columns:
//
//      amountPaid: (booking.depositAmount / 100).toFixed(2)
//      captured:   booking.depositPaid
//
//  `depositAmount` is what the booking was SUPPOSED to be charged — the
//  authorization is created for `BOOKING_FEE_CENTS`, not for this column — so a
//  drifted value printed a receipt for money nobody took. Reproduced with
//  `depositAmount = 12345`: a "$123.45 · Charged to your card" receipt over a
//  booking with no completed payment at all.
//
//  `depositPaid` is worse: `claimConfirm` sets it BEFORE the Stripe capture runs
//  (src/lib/booking-approval.ts), so `captured: true` was printed over captures
//  that had not happened yet, and over the exact failure state
//  `reconciliation.ts` reports as `captured_no_payment_row`.
//
//  NOW: the figure comes from the COMPLETED Payment row and nowhere else — the
//  ledger the approval path writes ONLY from a Stripe-reported amount and
//  deliberately refuses to write when Stripe reports none. No proven payment ⇒
//  NO RECEIPT and an owner-honest 409 that names the missing fact. Failing
//  closed is the whole point: an unsendable receipt is an inconvenience, a
//  receipt for an amount nobody captured is a claim the business cannot defend.
//
//  The `RECEIPT_SENT` audit row is written ONLY when a receipt was really
//  queued — `referral-eligibility.ts` treats that row as durable proof that a
//  receipt exists, so writing it for a refused send would be a second false
//  record built on the first.
// ════════════════════════════════════════════════════════════════════════

/** ITEM C1 (round 8) — the SHARED column list (`PROOF_PAYMENT_SELECT`), not a
 *  local copy. The copy that used to live here omitted `stripeChargeId`, so the
 *  "did Stripe report this?" half of the rule ran on half its input. */

const RECEIPT_INCLUDE = { customer: true } as const
type ReceiptBooking = Prisma.BookingGetPayload<{ include: typeof RECEIPT_INCLUDE }>

export async function POST(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── ITEM C1 (round 8) — THE MIGRATION-WINDOW TWIN ────────────────────
  //  This was a bare `include: { customer: true }`, which asks Postgres for
  //  `$scalars` FROM THE GENERATED CLIENT. Migrations here are applied by hand,
  //  so in the ordinary code-before-SQL window it raised P2022 and the owner's
  //  "Resend receipt" answered a bare 500 — for a booking whose receipt was
  //  perfectly provable. Same ladder the approval and portal reads already use;
  //  a degraded row costs at most the newest columns, none of which is money.
  const { row, degraded } = await readBookingWithMigrationFallback<ReceiptBooking>(
    (args) => prisma.booking.findUnique({ where: { id: params.id }, ...(args as object) }),
    RECEIPT_INCLUDE,
  )
  const booking = row
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (degraded) {
    apiLogger.warn({ bookingId: params.id }, 'receipt resend: booking read degraded (unapplied migration) — the money proof below is unaffected')
  }

  // ── THE MONEY, PROVEN ────────────────────────────────────────────────
  //  ITEM C1 (round 8) — THIS READ USED TO BE UNGUARDED. A receipt is the
  //  strongest claim this system makes about money, and the ledger read that
  //  backs it could throw (P2022 in the deploy window, a Neon blip) straight
  //  out of the handler into a 500. The owner then reads "something went wrong"
  //  about a booking whose customer is on the phone asking for their receipt,
  //  and has no way to tell that apart from "we refuse to state this amount".
  //  A failed read is NOT evidence: it is refused in the owner's own words,
  //  with a 503 (retryable) rather than the 409 that means "decided".
  let payments: ProofPayment[]
  try {
    payments = (await prisma.payment.findMany({
      where: { bookingId: booking.id },
      select: PROOF_PAYMENT_SELECT,
    })) as unknown as ProofPayment[]
  } catch (err) {
    apiLogger.error(
      { bookingId: booking.id, err: err instanceof Error ? err.message : String(err) },
      'receipt resend: the payment ledger could not be read — no receipt was sent and no audit row was written',
    )
    return NextResponse.json(
      {
        error: 'No receipt sent - the payment ledger could not be read',
        reason: 'ledger_unreadable',
        message:
          'The payment records for this booking could not be read just now, so nothing here can state what was captured. No receipt was sent and nothing was recorded. Try again in a moment; if it keeps failing, check the deposit in Stripe before telling the customer anything.',
      },
      { status: 503 },
    )
  }
  const proof = provenCapturedDeposit(payments, { stripePaymentIntentId: booking.stripePaymentIntentId })
  if (!proof.proven) {
    // 409, not 500: nothing failed. There is simply nothing this system can
    // honestly put on a receipt, and the owner is told which fact is missing.
    return NextResponse.json(
      { error: 'No receipt sent - this booking has no payment we can prove', reason: proof.reason, message: unprovenExplanation(proof.reason) },
      { status: 409 },
    )
  }

  // Full price breakdown so the receipt separates deposit vs. move total vs.
  // what's due on move day (labor balance + truck add-on + travel fee). Every
  // money field is a formatted string; rows the booking doesn't have are omitted.
  //
  // The deposit is the CAPTURED figure, so "less deposit paid today" subtracts
  // money that was really collected — the balance rows are derived from the same
  // proof as the headline amount rather than from a second, different number.
  const deposit = proof.cents / 100
  const moveTotal = booking.totalEstimate ?? undefined
  const truckAddon = booking.truckAddonDueOnMoveDay && booking.truckAddonAmount ? booking.truckAddonAmount / 100 : undefined
  const travel = booking.travelFeeDueOnMoveDay && booking.travelFee ? booking.travelFee / 100 : undefined
  // Waiting fee (Late Arrival & Delay Policy) — its own line, never in labor.
  const waitingCents = effectiveWaitingFeeCents(booking)
  const waitingFee = waitingCents > 0 ? waitingCents / 100 : undefined
  const waitingMinutes = waitingFee ? resolveWaiting(booking).billableMinutes : undefined
  const laborBalance = moveTotal != null ? Math.max(0, moveTotal - deposit) : undefined
  const dueOnMoveDay =
    laborBalance != null ? laborBalance + (truckAddon ?? 0) + (travel ?? 0) + (waitingFee ?? 0) : undefined
  const money = (n?: number) => (n != null ? n.toFixed(2) : undefined)

  // The receipt's DATE is the payment's own timestamp — `booking.updatedAt` is
  // whenever anything on the booking last changed, which is not when the money
  // moved. It is used only if the ledger row somehow carries no timestamp.
  const paidAt = proof.capturedAt ?? booking.updatedAt

  // Send the premium PAYMENT RECEIPT template (was mistakenly 'job-completion',
  // which the worker allowlist dropped — the receipt silently never sent).
  await emailQueue.add('resend-receipt', {
    template: 'payment-receipt',
    to: booking.customer.email,
    bookingId: booking.id,
    payload: {
      customerName: booking.customer.name,
      displayId: booking.displayId,
      // PROVEN: the amount on the COMPLETED Payment row, cents preserved.
      amountPaid: deposit.toFixed(2),
      // PROVEN: a COMPLETED Payment row IS the capture. Never `depositPaid`,
      // which is set before the money moves.
      captured: true,
      moveTotal: money(moveTotal),
      remainingBalance: money(laborBalance),
      truckAddon: money(truckAddon),
      travelFee: money(travel),
      waitingFee: money(waitingFee),
      waitingMinutes,
      dueOnMoveDay: money(dueOnMoveDay),
      date: paidAt.toISOString(),
      portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
      locale: booking.customer.locale,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'RECEIPT_SENT',
      userId: session.userId,
      bookingId: booking.id,
      // The record states WHICH payment it receipted, so the claim is checkable
      // later against Stripe rather than being a bare "a receipt went out".
      details: { resentBy: session.name, to: booking.customer.email, paymentId: proof.paymentId, amountCents: proof.cents },
    },
  })

  return NextResponse.json({
    ok: true,
    message: `Receipt for $${deposit.toFixed(2)} queued for ${booking.customer.email}`,
    amountCents: proof.cents,
    paymentId: proof.paymentId,
  })
}
