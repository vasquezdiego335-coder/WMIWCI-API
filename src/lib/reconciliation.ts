// ════════════════════════════════════════════════════════════════════════
//  reconciliation.ts — durable Stripe ⇄ local Payment reconciliation.
//
//  Detects the money-integrity problems that the architecture review flagged as
//  the residual risk after the shared-approval fix — chiefly a Stripe capture
//  that succeeded while the following DB write failed (money captured, no
//  Payment row). Also catches confirmed-with-no-payment, amount drift, duplicate
//  Payments, and refund/dispute state that never made it into the DB.
//
//  The DETECTION is a pure function (unit-tested offline). The runner does the
//  I/O — list recent Stripe charges + read local Payments/Bookings — and is
//  exposed via GET /api/admin/reconciliation (owner-only) and
//  scripts/reconcile-payments.ts, so it can run on demand or on a cron.
// ════════════════════════════════════════════════════════════════════════

export type ReconIssueType =
  | 'captured_no_payment_row'
  | 'confirmed_no_payment'
  | 'amount_mismatch'
  | 'duplicate_payment'
  | 'refund_state_mismatch'
  | 'dispute_state_mismatch'

export type ReconSeverity = 'critical' | 'high' | 'medium'

export type ReconIssue = {
  type: ReconIssueType
  severity: ReconSeverity
  ref: string // charge id / payment id / booking id — the thing to look at
  detail: string
}

export type StripeChargeLite = {
  paymentIntentId: string | null
  chargeId: string
  amountCaptured: number // cents actually captured
  amountRefunded: number // cents refunded (cumulative)
  captured: boolean
  disputed: boolean
  status: string // 'succeeded' | 'pending' | 'failed'
}

export type PaymentLite = {
  id: string
  bookingId: string
  stripePaymentIntentId: string | null
  stripeChargeId: string | null
  amount: number
  status: string // PaymentStatus
  refundedAmountCents: number | null
  stripeDisputeId: string | null
  isInternalTest?: boolean
}

export type BookingLite = {
  id: string
  displayId: string
  status: string // BookingStatus
  isInternalTest: boolean
}

// Booking statuses that imply the deposit was captured (post-approval).
const CAPTURED_BOOKING_STATES = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']
const REFUNDED_STATES = ['REFUNDED', 'PARTIALLY_REFUNDED']

export type ReconInput = {
  stripeCharges: StripeChargeLite[]
  payments: PaymentLite[]
  bookings: BookingLite[]
}

/**
 * Pure reconciliation. Cross-references Stripe charges with local Payments and
 * Bookings and returns every integrity issue found (empty = all consistent).
 */
export function reconcile(input: ReconInput): ReconIssue[] {
  const issues: ReconIssue[] = []
  const { stripeCharges, payments, bookings } = input

  const byIntent = new Map<string, PaymentLite[]>()
  const byCharge = new Map<string, PaymentLite>()
  for (const p of payments) {
    if (p.stripePaymentIntentId) {
      const arr = byIntent.get(p.stripePaymentIntentId) ?? []
      arr.push(p)
      byIntent.set(p.stripePaymentIntentId, arr)
    }
    if (p.stripeChargeId) byCharge.set(p.stripeChargeId, p)
  }

  const matchPayment = (c: StripeChargeLite): PaymentLite | undefined => {
    if (c.paymentIntentId) {
      const byPi = byIntent.get(c.paymentIntentId)
      if (byPi && byPi.length) return byPi[0]
    }
    return byCharge.get(c.chargeId)
  }

  // 1) Captured Stripe money with NO local Payment row (the money-loss case).
  for (const c of stripeCharges) {
    if (!c.captured || c.amountCaptured <= 0 || c.status === 'failed') continue
    if (!matchPayment(c)) {
      issues.push({
        type: 'captured_no_payment_row',
        severity: 'critical',
        ref: c.chargeId,
        detail: `Stripe captured ${(c.amountCaptured / 100).toFixed(2)} on ${c.chargeId} (pi ${c.paymentIntentId ?? '—'}) but there is no local Payment row.`,
      })
    }
  }

  // 2) A post-approval booking with no COMPLETED payment (skip internal tests).
  const completedByBooking = new Map<string, number>()
  for (const p of payments) {
    if (p.status === 'COMPLETED' && !p.isInternalTest) {
      completedByBooking.set(p.bookingId, (completedByBooking.get(p.bookingId) ?? 0) + 1)
    }
  }
  for (const b of bookings) {
    if (b.isInternalTest) continue
    if (!CAPTURED_BOOKING_STATES.includes(b.status)) continue
    if (!completedByBooking.get(b.id)) {
      issues.push({
        type: 'confirmed_no_payment',
        severity: 'high',
        ref: b.id,
        detail: `Booking ${b.displayId} is ${b.status} but has no COMPLETED payment recorded.`,
      })
    }
  }

  // 3) Amount mismatch between a matched Payment and the Stripe charge.
  for (const c of stripeCharges) {
    if (!c.captured || c.amountCaptured <= 0) continue
    const p = matchPayment(c)
    if (p && p.amount !== c.amountCaptured) {
      issues.push({
        type: 'amount_mismatch',
        severity: 'high',
        ref: p.id,
        detail: `Payment ${p.id} amount ${p.amount} != Stripe captured ${c.amountCaptured} (charge ${c.chargeId}).`,
      })
    }
  }

  // 4) Duplicate Payments: >1 for the same intent, or >1 COMPLETED per booking.
  for (const [intent, arr] of Array.from(byIntent.entries())) {
    if (arr.length > 1) {
      issues.push({
        type: 'duplicate_payment',
        severity: 'high',
        ref: intent,
        detail: `${arr.length} Payment rows share payment intent ${intent} (${arr.map((p: PaymentLite) => p.id).join(', ')}).`,
      })
    }
  }
  for (const [bookingId, n] of Array.from(completedByBooking.entries())) {
    if (n > 1) {
      issues.push({
        type: 'duplicate_payment',
        severity: 'medium',
        ref: bookingId,
        detail: `Booking ${bookingId} has ${n} COMPLETED payments (expected 1 deposit).`,
      })
    }
  }

  // 5) Refund state mismatch — Stripe shows a refund the DB never recorded.
  for (const c of stripeCharges) {
    if (c.amountRefunded <= 0) continue
    const p = matchPayment(c)
    if (!p) continue // already flagged in (1)
    const dbRefunded = p.refundedAmountCents ?? 0
    if (!REFUNDED_STATES.includes(p.status) || dbRefunded !== c.amountRefunded) {
      issues.push({
        type: 'refund_state_mismatch',
        severity: 'high',
        ref: p.id,
        detail: `Stripe refunded ${(c.amountRefunded / 100).toFixed(2)} on ${c.chargeId} but Payment ${p.id} is status=${p.status}, refundedAmountCents=${dbRefunded}.`,
      })
    }
  }

  // 6) Dispute state mismatch — Stripe shows a dispute the DB never recorded.
  for (const c of stripeCharges) {
    if (!c.disputed) continue
    const p = matchPayment(c)
    if (!p) continue
    if (!p.stripeDisputeId) {
      issues.push({
        type: 'dispute_state_mismatch',
        severity: 'high',
        ref: p.id,
        detail: `Stripe charge ${c.chargeId} is disputed but Payment ${p.id} has no stripeDisputeId recorded.`,
      })
    }
  }

  return issues
}

// ── Runner (I/O) — lazy-loads prisma + Stripe so the offline test never does. ──

export type ReconReport = {
  ranAt: string
  windowDays: number
  chargesChecked: number
  paymentsChecked: number
  bookingsChecked: number
  issues: ReconIssue[]
}

export async function runReconciliation(windowDays = 30): Promise<ReconReport> {
  const { prisma } = await import('./db')
  const { stripe } = await import('./stripe')

  const since = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000)

  // Stripe charges (paginate up to a sane cap).
  const stripeCharges: StripeChargeLite[] = []
  let startingAfter: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await stripe.charges.list({ limit: 100, created: { gte: since }, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    for (const c of page.data) {
      stripeCharges.push({
        paymentIntentId: typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id ?? null,
        chargeId: c.id,
        amountCaptured: c.amount_captured ?? 0,
        amountRefunded: c.amount_refunded ?? 0,
        captured: !!c.captured,
        disputed: !!c.disputed,
        status: c.status,
      })
    }
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }

  const sinceDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const [payments, bookings] = await Promise.all([
    prisma.payment.findMany({
      where: { createdAt: { gte: sinceDate } },
      select: { id: true, bookingId: true, stripePaymentIntentId: true, stripeChargeId: true, amount: true, status: true, refundedAmountCents: true, stripeDisputeId: true, isInternalTest: true },
    }),
    prisma.booking.findMany({
      where: { createdAt: { gte: sinceDate } },
      select: { id: true, displayId: true, status: true, isInternalTest: true },
    }),
  ])

  const issues = reconcile({
    stripeCharges,
    payments: payments as PaymentLite[],
    bookings: bookings as BookingLite[],
  })

  return {
    ranAt: new Date().toISOString(),
    windowDays,
    chargesChecked: stripeCharges.length,
    paymentsChecked: payments.length,
    bookingsChecked: bookings.length,
    issues,
  }
}
