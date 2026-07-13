// ============================================================================
// Finalized financial-record integrity (increment 2.1). Once a money record is
// finalized, editing the money on it is an owner-only ADJUSTMENT that requires a
// reason and preserves the before→after in the audit log (never a silent
// overwrite). Pure predicates so the API and tests share one definition.
//
// Scope note: the only finalized financial record with an EDIT path in the app
// today is the expense (APPROVED / REIMBURSED). Crew-pay and payment records
// have no edit UI yet, so their adjustment workflow is a roadmap item — this
// module is where that logic lands when those editors ship.
// ============================================================================

// An expense is financially "finalized" once approved or reimbursed.
const FINALIZED_EXPENSE_STATUSES = ['APPROVED', 'REIMBURSED']

export function isFinalizedExpenseStatus(status: string): boolean {
  return FINALIZED_EXPENSE_STATUSES.includes(status)
}

/** True when a numeric money field actually changed (guards against a no-op
 *  PATCH that resends the same amount triggering the adjustment workflow). */
export function financialFieldChanged(before: number | null | undefined, after: number | null | undefined): boolean {
  return (before ?? null) !== (after ?? null)
}
