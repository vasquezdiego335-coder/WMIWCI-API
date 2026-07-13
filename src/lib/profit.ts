// ============================================================================
// Money math for the admin operating system (owner spec 2026-07-13).
//
// Everything is integer CENTS end-to-end — matches deposit_amount / travel_fee
// and the Expense / OwnerTransaction / JobCrew columns. No Prisma imports here
// on purpose: this stays a pile of pure functions so the profit math is
// unit-testable offline (see src/lib/__tests__/profit.test.ts).
//
// The owner rule this enforces: every dollar is JOB revenue, a JOB cost, an
// OWNER transaction, or a GENERAL business expense. Per-job profit =
//   revenue collected − (crew pay + job expenses + Stripe fees + refunds)
// ============================================================================

// Standard US Stripe pricing for card charges (2.9% + 30¢). Used to ESTIMATE
// processing fees on Stripe-collected money only — cash / move-day money has no
// processor fee. Real fees come from Stripe payouts; this is the planning number.
export const STRIPE_PCT = 0.029
export const STRIPE_FLAT_CENTS = 30

/** cents -> "$1,234.56" (always 2 dp, thousands separators). */
export function fmtCents(cents: number | null | undefined): string {
  const n = Math.round(cents ?? 0) / 100
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** "700" | "700.5" | "$1,200.00" -> integer cents (70000 / 70050 / 120000).
 *  Returns null when the input isn't a parseable non-negative number. */
export function dollarsToCents(input: string | number | null | undefined): number | null {
  if (input == null) return null
  const s = String(input).replace(/[$,\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

/** Estimated Stripe processing fee for one captured card charge (2.9% + 30¢). */
export function stripeFeeCents(chargeCents: number): number {
  if (chargeCents <= 0) return 0
  return Math.round(chargeCents * STRIPE_PCT) + STRIPE_FLAT_CENTS
}

// ── Crew pay ────────────────────────────────────────────────────────────────

export interface CrewPayInput {
  actualHours?: number | null
  scheduledHours?: number | null
  payRate?: number | null // cents/hour — the JobCrew per-job override
  userPayRate?: number | null // cents/hour — the worker's default rate
  flatPay?: number | null // cents — a flat job rate; wins over hourly when set
  tips?: number | null // cents
  bonus?: number | null // cents
  deductions?: number | null // cents
}

/** Amount owed to ONE crew member for ONE job, in cents.
 *  flatPay wins over hourly; hours fall back to scheduled when actual isn't
 *  logged yet; the rate falls back to the worker's default. tips + bonus add,
 *  deductions subtract, never below zero. */
export function crewPayOwedCents(c: CrewPayInput): number {
  const base =
    c.flatPay != null && c.flatPay > 0
      ? c.flatPay
      : Math.round((c.actualHours ?? c.scheduledHours ?? 0) * (c.payRate ?? c.userPayRate ?? 0))
  const owed = base + (c.tips ?? 0) + (c.bonus ?? 0) - (c.deductions ?? 0)
  return Math.max(0, Math.round(owed))
}

// ── Per-job profit ───────────────────────────────────────────────────────────

export interface ProfitPayment {
  amount: number // cents
  status: string // PaymentStatus
  isInternalTest?: boolean
  isStripe?: boolean // true when collected through Stripe (fee applies)
}

export interface JobMoneyInput {
  payments: ProfitPayment[]
  crew: CrewPayInput[]
  expenses: { amount: number }[] // job-linked Expense rows (any category)
}

export interface JobProfit {
  grossRevenueCents: number // COMPLETED, non-test money collected on this job
  refundedCents: number // REFUNDED money on this job
  crewPayCents: number // sum of crew owed
  expenseCents: number // job-linked expenses
  stripeFeeCents: number // estimated Stripe fees on Stripe-collected money
  totalCostsCents: number // crew + expenses + stripe + refunds
  netProfitCents: number // gross − totalCosts (can be negative)
  marginPct: number | null // net / gross; null when no revenue yet
}

export function computeJobProfit(input: JobMoneyInput): JobProfit {
  const completed = input.payments.filter((p) => p.status === 'COMPLETED' && !p.isInternalTest)
  const grossRevenueCents = completed.reduce((s, p) => s + p.amount, 0)
  const refundedCents = input.payments
    .filter((p) => (p.status === 'REFUNDED' || p.status === 'PARTIALLY_REFUNDED') && !p.isInternalTest)
    .reduce((s, p) => s + p.amount, 0)
  const crewPayCents = input.crew.reduce((s, c) => s + crewPayOwedCents(c), 0)
  const expenseCents = input.expenses.reduce((s, e) => s + e.amount, 0)
  const stripeFeesCents = completed
    .filter((p) => p.isStripe)
    .reduce((s, p) => s + stripeFeeCents(p.amount), 0)
  const totalCostsCents = crewPayCents + expenseCents + stripeFeesCents + refundedCents
  const netProfitCents = grossRevenueCents - totalCostsCents
  const marginPct = grossRevenueCents > 0 ? netProfitCents / grossRevenueCents : null
  return {
    grossRevenueCents,
    refundedCents,
    crewPayCents,
    expenseCents,
    stripeFeeCents: stripeFeesCents,
    totalCostsCents,
    netProfitCents,
    marginPct,
  }
}

/** True when a payment row represents Stripe-collected money (has a processor
 *  id), vs. a manually-recorded cash / move-day payment. */
export function isStripePayment(p: { stripePaymentIntentId?: string | null; stripeChargeId?: string | null }): boolean {
  return !!(p.stripePaymentIntentId || p.stripeChargeId)
}

// ── Distributable owner cash (Owner Money page) ──────────────────────────────
// Business cash is NOT all splittable. Hold back what's already owed + reserves
// before showing a "safe to distribute" number.

export interface DistributableInput {
  cashAvailableCents: number // money actually in the business
  upcomingWorkerPayCents: number // crew owed but not yet paid
  upcomingBillsCents: number // known unpaid general expenses
  taxReserveCents: number // held for taxes
  emergencyReserveCents: number // rainy-day floor
}

export function safeToDistributeCents(i: DistributableInput): number {
  const held =
    i.upcomingWorkerPayCents + i.upcomingBillsCents + i.taxReserveCents + i.emergencyReserveCents
  return Math.max(0, i.cashAvailableCents - held)
}
