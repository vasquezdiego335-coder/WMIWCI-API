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
  revenueCents: number // captured, non-test payments (real money in)
  expenseCents: number // approved/committed business expenses (money out)
  ownerTxs: OwnerTxLike[]
}

/** Estimated business cash from the recorded ledger (labeled estimate — there
 *  is no bank reconciliation). Contributions add; withdrawals, distributions,
 *  and paid reimbursements subtract; personal purchases do NOT touch cash. */
export function estimateBusinessCash(i: CashEstimateInput): number {
  const live = liveTxs(i.ownerTxs)
  const contributions = live.filter((t) => t.type === 'CONTRIBUTION').reduce((s, t) => s + t.amount, 0)
  const cashOut = live.filter((t) => CASH_OUT_TYPES.includes(t.type)).reduce((s, t) => s + t.amount, 0)
  const reimbursed = live.filter((t) => t.type === 'REIMBURSEMENT').reduce((s, t) => s + t.amount, 0)
  return contributions + i.revenueCents - i.expenseCents - cashOut - reimbursed
}

/** GUARDRAIL: operating revenue never includes owner money. This exists so a
 *  future P&L implementation has one blessed helper instead of ad-hoc sums. */
export function operatingRevenueCents(paymentsCents: number, _ownerTxs: OwnerTxLike[]): number {
  // Owner transactions are intentionally ignored — contributions are not revenue.
  return paymentsCents
}

/** GUARDRAIL: operating expenses never include owner withdrawals/distributions. */
export function operatingExpenseCents(expensesCents: number, _ownerTxs: OwnerTxLike[]): number {
  // Owner cash-out is intentionally ignored — distributions are not expenses.
  return expensesCents
}
