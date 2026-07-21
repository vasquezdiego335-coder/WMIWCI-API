// ============================================================================
// Owner-money ledger math (extracted from the Owner Money page in increment 2
// so the financial invariants are unit-testable). Pure functions, integer
// cents, no Prisma — same pattern as src/lib/profit.ts.
//
// FINANCIAL DEFINITIONS (docs/financial-architecture.md):
//  • Owner CONTRIBUTIONS increase cash but are NEVER revenue.
//  • Owner WITHDRAWALS / DISTRIBUTIONS reduce cash but are NEVER operating
//    expenses.
//  • PERSONAL_PURCHASE doesn't touch business cash until REIMBURSEMENT pays
//    the owner back (the reimbursement is the cash event).
// ============================================================================

export interface OwnerTxLike {
  owner: string // 'DIEGO' | 'SEBASTIAN'
  type: string // OwnerTransactionType
  amount: number // cents
  approvalStatus: string // PENDING | APPROVED | REJECTED
}

/** Money OUT of the business to an owner (cash events). */
const CASH_OUT_TYPES = ['WITHDRAWAL', 'DISTRIBUTION']

/** Rejected transactions never count anywhere. */
export const liveTxs = (txs: OwnerTxLike[]): OwnerTxLike[] => txs.filter((t) => t.approvalStatus !== 'REJECTED')

export interface OwnerRollup {
  contributed: number
  withdrawn: number // withdrawals + distributions
  reimbursementOwed: number // personal purchases not yet reimbursed (floor 0)
}

export function rollupOwner(txs: OwnerTxLike[], owner: string): OwnerRollup {
  const rows = liveTxs(txs).filter((t) => t.owner === owner)
  const sum = (type: string) => rows.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0)
  return {
    contributed: sum('CONTRIBUTION'),
    withdrawn: sum('WITHDRAWAL') + sum('DISTRIBUTION'),
    reimbursementOwed: Math.max(0, sum('PERSONAL_PURCHASE') - sum('REIMBURSEMENT')),
  }
}

export interface CashEstimateInput {
  /** NET collected revenue — captured minus refunds minus lost chargebacks
   *  (money-rules.summarizeRevenue). Never the gross capture. */
  netRevenueCents: number
  /** ELIGIBLE business expenses only — REJECTED rows excluded
   *  (money-rules.eligibleExpenseCents / ELIGIBLE_EXPENSE_WHERE). */
  expenseCents: number
  /** Crew labor already settled in cash (JobCrew payStatus = PAID).
   *  PHASE 0 FIX: this was missing entirely, so paying a worker never reduced
   *  estimated cash — and because safe-to-distribute only held back UNPAID
   *  labor, marking someone paid actually INCREASED the distributable figure.
   *  Labor is deliberately not an Expense row (docs/financial-architecture.md,
   *  Option A), so it has to be subtracted here explicitly. */
  paidLaborCents: number
  ownerTxs: OwnerTxLike[]
}

/** Estimated business cash from the recorded ledger (labeled estimate — there
 *  is no bank reconciliation). Contributions add; withdrawals, distributions,
 *  paid reimbursements, expenses and PAID labor subtract; personal purchases do
 *  NOT touch cash until reimbursed. */
export function estimateBusinessCash(i: CashEstimateInput): number {
  const live = liveTxs(i.ownerTxs)
  const contributions = live.filter((t) => t.type === 'CONTRIBUTION').reduce((s, t) => s + t.amount, 0)
  const cashOut = live.filter((t) => CASH_OUT_TYPES.includes(t.type)).reduce((s, t) => s + t.amount, 0)
  const reimbursed = live.filter((t) => t.type === 'REIMBURSEMENT').reduce((s, t) => s + t.amount, 0)
  return contributions + i.netRevenueCents - i.expenseCents - i.paidLaborCents - cashOut - reimbursed
}

/** Total personal spend awaiting reimbursement across ALL owners — held back
 *  from distributable cash (the business owes it before anyone splits profit). */
export function totalReimbursementOwed(txs: OwnerTxLike[], owners: string[]): number {
  return owners.reduce((s, o) => s + rollupOwner(txs, o).reimbursementOwed, 0)
}

/** GUARDRAIL: operating revenue never includes owner money. This exists so a
 *  future P&L implementation has one blessed helper instead of ad-hoc sums.
 *  Pass the NET collected figure from money-rules.summarizeRevenue. */
export function operatingRevenueCents(paymentsCents: number, _ownerTxs: OwnerTxLike[]): number {
  // Owner transactions are intentionally ignored — contributions are not revenue.
  return paymentsCents
}

/** Operating profit estimate used as the TAX RESERVE BASE. Phase 0 fix: the
 *  reserve used to be (revenue − expenses) with labor ignored entirely, which
 *  overstated the amount held back. Labor is a cost like any other. */
export function operatingProfitCents(i: { netRevenueCents: number; expenseCents: number; laborCents: number }): number {
  return i.netRevenueCents - i.expenseCents - i.laborCents
}

/** GUARDRAIL: operating expenses never include owner withdrawals/distributions. */
export function operatingExpenseCents(expensesCents: number, _ownerTxs: OwnerTxLike[]): number {
  // Owner cash-out is intentionally ignored — distributions are not expenses.
  return expensesCents
}
