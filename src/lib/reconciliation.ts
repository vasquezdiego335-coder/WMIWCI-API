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
//
//  ── ITEM B1 (release blocker, 2026-08-14) — IT ALSO HAS TO BE RUN ──────────
//  Verification found this detector ALREADY reports both shapes of the B1
//  defect correctly (`captured_no_payment_row` critical + `confirmed_no_payment`
//  high) — and that nothing ever ran it: no cron, no scheduled job, no admin
//  page linking the route. A money defect nobody is told about is invisible
//  whether or not a detector exists.
//
//  So `reconcile()` is UNCHANGED (it is correct; do not rewrite it) and what is
//  added around it is delivery: a pure severity summary, a pure alert body, and
//  `runReconciliationWithAlert`, which posts critical/high findings to the ops
//  channel. The route can then be driven by a scheduler as well as by the owner.
// ════════════════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto'

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

// ── ITEM B1 — turning findings into something a human is told ────────────────

export type ReconSummary = {
  total: number
  critical: number
  high: number
  medium: number
  /** True when at least one finding needs a human today. Critical and high are
   *  both money-integrity findings (`captured_no_payment_row` is money taken and
   *  never recorded; `confirmed_no_payment` is a confirmed job whose deposit is
   *  either unrecorded or was never captured at all). Medium is drift worth
   *  reading, not worth paging for. */
  needsAttention: boolean
}

/** Pure. Counts findings by severity. */
export function summarizeIssues(issues: ReconIssue[]): ReconSummary {
  const count = (s: ReconSeverity): number => issues.filter((i) => i.severity === s).length
  const critical = count('critical')
  const high = count('high')
  return { total: issues.length, critical, high, medium: count('medium'), needsAttention: critical + high > 0 }
}

/** What the owner is told to DO about each kind of finding. Every line is
 *  derived from a detected row — nothing here claims an outcome. */
const ISSUE_ACTIONS: Record<ReconIssueType, string> = {
  captured_no_payment_row:
    'Stripe has this money and the app does not. Open the booking and click Approve again — it re-drives the same record. Do NOT charge the customer again.',
  confirmed_no_payment:
    'Either the deposit was captured and never recorded, or it was never captured. Click Approve again on the booking; it checks Stripe and converges. Do NOT charge the customer again before it does.',
  amount_mismatch: 'Compare the Stripe charge with the Payment row and correct the local amount.',
  duplicate_payment: 'Two Payment rows describe one deposit — reporting and the customer balance will both be wrong.',
  refund_state_mismatch: 'A refund exists at Stripe that the database never recorded.',
  dispute_state_mismatch: 'A dispute exists at Stripe that the database never recorded — evidence deadlines are short.',
}

export type ReconAlert = { title: string; lines: Array<{ message: string; action?: string }> }

/**
 * Pure. The ops-channel body for a report, or null when nothing needs a human.
 *
 * Only critical/high findings are alerted: a channel that pings for routine
 * drift gets muted, and a muted channel loses the critical alerts with it
 * (ops-alert.ts design rule 3).
 */
export function buildReconAlert(report: ReconReport): ReconAlert | null {
  const summary = summarizeIssues(report.issues)
  if (!summary.needsAttention) return null
  const urgent = report.issues.filter((i) => i.severity === 'critical' || i.severity === 'high')
  return {
    title:
      `Payment reconciliation: ${summary.critical} critical, ${summary.high} high ` +
      `(last ${report.windowDays}d, ${report.chargesChecked} charges checked)`,
    // postToChannels caps the body at 8 lines; take the critical ones first so
    // the cap can never drop the worst finding.
    lines: [...urgent]
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1))
      .slice(0, 8)
      .map((i) => ({ message: `[${i.severity.toUpperCase()}] ${i.detail}`, action: ISSUE_ACTIONS[i.type] })),
  }
}

// ── ITEM B1 — who may trigger a SCHEDULED run ────────────────────────────────

/** Placeholder-shaped secrets, so an unconfigured deployment LOOKS unconfigured
 *  rather than accidentally authenticating (same rule as ops-alert.configured). */
const PLACEHOLDER_SECRET = /^(REPLACE|PASTE|PUT|ADD|SET|INSERT|YOUR|CHANGE|EXAMPLE|SAMPLE|TODO|XXX)([_-]|$)/i

/**
 * May this request run the reconciliation WITHOUT an owner session?
 *
 * Used by GET /api/admin/reconciliation so a scheduler (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`) can drive the detector that nobody was
 * running. Pure and exported so the guard is unit-tested offline.
 *
 * FAILS CLOSED, three ways: no secret configured, a placeholder secret, or a
 * secret short enough to be guessable all mean "no scheduled access" — never
 * "everybody passes". The comparison is length-checked then constant-time.
 */
export function isScheduledRunAuthorized(authHeader: string | null | undefined, secret: string | undefined | null): boolean {
  const expected = secret?.trim()
  if (!expected || expected.length < 16 || PLACEHOLDER_SECRET.test(expected)) return false
  const header = authHeader?.trim()
  if (!header) return false
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : header
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
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

export type ReconRunResult = ReconReport & {
  summary: ReconSummary
  /** Whether an ops channel ACCEPTED the alert. `false` with a reason when
   *  nothing was delivered — including "nothing needed reporting", so a silent
   *  run and an undeliverable alert never look the same. */
  alerted: boolean
  alertReason?: string
}

/**
 * ITEM B1 — run the detector AND tell somebody. This is what a scheduled run
 * calls; the alert is best-effort and can never fail the report.
 *
 * `postAlert` is injected so the offline test proves the wiring without a
 * network call; production defaults to ops-alert.postOpsAlert (bare HTTPS POST,
 * never throws).
 */
export async function runReconciliationWithAlert(
  windowDays = 30,
  postAlert?: (title: string, lines: Array<{ message: string; action?: string }>) => Promise<{ delivered: boolean; reason?: string }>,
): Promise<ReconRunResult> {
  const report = await runReconciliation(windowDays)
  const summary = summarizeIssues(report.issues)
  const alert = buildReconAlert(report)
  if (!alert) return { ...report, summary, alerted: false, alertReason: 'nothing needed reporting' }

  const send = postAlert ?? (await import('./ops-alert')).postOpsAlert
  try {
    const res = await send(alert.title, alert.lines)
    return { ...report, summary, alerted: res.delivered, ...(res.delivered ? {} : { alertReason: res.reason ?? 'not delivered' }) }
  } catch (e) {
    // postOpsAlert does not throw, but an injected sender might.
    return { ...report, summary, alerted: false, alertReason: e instanceof Error ? e.message : String(e) }
  }
}
