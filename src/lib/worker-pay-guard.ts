// ============================================================================
// WORKER_PAY server-side enforcement (increment 2.1, financial integrity).
// Crew labor's single source of truth is JobCrew payroll (see
// docs/financial-architecture.md). Recording a WORKER_PAY expense on a job that
// ALREADY has crew payroll double-counts the same labor. The expense-form hint
// (increment 2) is not enough — this pure decision is enforced in the API so a
// forged/scripted request cannot bypass it. Offline-tested.
// ============================================================================

export interface WorkerPayContext {
  category: string // ExpenseCategory
  bookingHasCrewLabor: boolean // does the linked job already have crew pay data?
  override: boolean // owner explicitly chose to override
  role: 'OWNER' | 'MANAGER' | 'CREW' | null
  reason?: string // required when overriding
}

export type WorkerPayDecision =
  | { allow: true; overrideUsed: boolean }
  | { allow: false; status: 403 | 422; error: string }

/** Decide whether a WORKER_PAY expense may be created/updated. Non-WORKER_PAY
 *  expenses and WORKER_PAY on jobs without crew payroll (a real non-crew helper)
 *  pass freely. A duplicate-labor attempt is blocked unless an OWNER overrides
 *  with a reason. */
export function evaluateWorkerPayExpense(ctx: WorkerPayContext): WorkerPayDecision {
  if (ctx.category !== 'WORKER_PAY' || !ctx.bookingHasCrewLabor) {
    return { allow: true, overrideUsed: false }
  }
  // This is a duplicate-labor situation (job already has crew payroll).
  if (!ctx.override) {
    return {
      allow: false,
      status: 422,
      error:
        'This job already records crew labor in payroll. Recording a "Worker pay" expense here would count the same labor twice. Use "Worker pay" only for helpers who are not in the crew system, or override as an owner with a reason.',
    }
  }
  if (ctx.role !== 'OWNER') {
    return { allow: false, status: 403, error: 'Only an owner can override the worker-pay double-count rule.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'An override reason is required to record this worker-pay expense.' }
  }
  return { allow: true, overrideUsed: true }
}
