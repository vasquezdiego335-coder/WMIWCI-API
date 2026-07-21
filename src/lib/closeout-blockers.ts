// ============================================================================
// closeout-blockers.ts — what stops a move being financially finalized.
// Phase 2 (owner spec 2026-07-20). Pure + offline-tested; the finalize route
// calls this, so a forged request cannot skip a blocker.
//
// TWO CLASSES, and the distinction is the whole design:
//   OVERRIDABLE — a judgement call an owner is entitled to make and document
//                 (a missing $8 receipt, a written-off balance, a $0 truck).
//   HARD        — data that is WRONG, not merely absent (a refund larger than
//                 the payment, allocations exceeding profit). No reason makes
//                 those safe, so no override accepts them.
// ============================================================================

export type BlockerSeverity = 'HARD' | 'OVERRIDABLE'

export interface Blocker {
  code: string
  message: string
  severity: BlockerSeverity
  /** Which closeout section fixes it — the UI deep-links here. */
  section: string
}

export interface CloseoutBlockerInput {
  bookingStatus: string
  // revenue
  hasCapturedPayment: boolean
  hasUnknownRefundAmount: boolean
  refundExceedsCaptured: boolean
  outstandingBalanceCents: number
  balanceWriteOffCents: number
  disputedOpenCents: number
  disputeAcknowledged: boolean
  // labor (from Phase 1 completeness)
  laborState: string
  // truck
  truckSourceConfirmed: boolean
  truckSourceIsCostly: boolean // RENTAL / THIRD_PARTY / COMPANY_OWNED
  truckCostRecordedCents: number
  // expenses
  expensesMissingReceipt: { id: string; label: string; amountCents: number }[]
  receiptRequiredAboveCents: number
  pendingExpenseCount: number
  // owner money
  ownerReimbursementOwedCents: number
  // distribution
  allocatedToOwnersCents: number
  distributableProfitCents: number
  reservesExceedProfit: boolean
  // integrity
  hasNegativeValue: boolean
}

const B = (code: string, message: string, severity: BlockerSeverity, section: string): Blocker => ({ code, message, severity, section })

/**
 * Everything currently preventing finalization, most severe first.
 * An empty array means the move is ready.
 */
export function computeCloseoutBlockers(i: CloseoutBlockerInput): Blocker[] {
  const out: Blocker[] = []

  // ── HARD: the data is wrong, not missing ──
  if (i.refundExceedsCaptured) {
    out.push(B('REFUND_EXCEEDS_PAYMENT', 'A refund on this move is larger than the payment it refunds. Fix the payment records before closing out.', 'HARD', 'payments'))
  }
  if (i.hasNegativeValue) {
    out.push(B('NEGATIVE_VALUE', 'This move contains a negative amount that should not exist. Review the records before closing out.', 'HARD', 'status'))
  }
  if (i.allocatedToOwnersCents > i.distributableProfitCents) {
    out.push(B('ALLOCATION_EXCEEDS_PROFIT', 'Owner allocations are larger than the distributable profit.', 'HARD', 'split'))
  }
  if (i.reservesExceedProfit) {
    out.push(B('RESERVES_EXCEED_PROFIT', 'The reserves you selected are larger than the company net profit on this move.', 'HARD', 'reserves'))
  }
  if (!i.hasCapturedPayment) {
    out.push(B('NO_PAYMENT_DATA', 'No captured customer payment is recorded on this move, so revenue cannot be trusted.', 'HARD', 'revenue'))
  }
  if (i.hasUnknownRefundAmount) {
    out.push(B('UNKNOWN_REFUND_AMOUNT', 'A partial refund on this move has no recorded amount. Revenue cannot be reconciled until it does.', 'HARD', 'refunds'))
  }

  // ── HARD: labor that cannot be priced ──
  if (i.laborState === 'NOT_ASSIGNED' || i.laborState === 'ASSIGNED_NO_HOURS') {
    out.push(B('LABOR_MISSING', 'Crew labor has not been recorded for this move. Profit would be overstated.', 'OVERRIDABLE', 'labor'))
  }
  if (i.laborState === 'MISSING_CLOCK_OUT') {
    out.push(B('LABOR_MISSING_CLOCK_OUT', 'A crew member has no clock-out, so their hours are incomplete.', 'HARD', 'labor'))
  }
  if (i.laborState === 'MISSING_RATE') {
    out.push(B('LABOR_MISSING_RATE', 'A crew member has hours but no pay rate, so their labor cannot be priced.', 'HARD', 'labor'))
  }
  if (i.laborState === 'HOURS_UNAPPROVED') {
    out.push(B('LABOR_NOT_APPROVED', 'Crew labor on this move has not been approved, so it is not yet counted as a cost.', 'HARD', 'labor'))
  }

  // ── OVERRIDABLE: judgement calls an owner may document ──
  const unwrittenBalance = Math.max(0, i.outstandingBalanceCents)
  if (unwrittenBalance > 0) {
    out.push(B('OUTSTANDING_BALANCE', `The customer still owes $${(unwrittenBalance / 100).toFixed(2)}. Collect it, or write it off with a reason.`, 'OVERRIDABLE', 'revenue'))
  }
  if (i.disputedOpenCents > 0 && !i.disputeAcknowledged) {
    out.push(B('OPEN_DISPUTE', `$${(i.disputedOpenCents / 100).toFixed(2)} is in an open dispute. Acknowledge it before finalizing.`, 'OVERRIDABLE', 'refunds'))
  }
  if (!i.truckSourceConfirmed) {
    out.push(B('TRUCK_SOURCE_MISSING', 'The truck source has not been confirmed. A missing truck cost is not $0 until someone says so.', 'OVERRIDABLE', 'truck'))
  }
  if (i.truckSourceConfirmed && i.truckSourceIsCostly && i.truckCostRecordedCents <= 0) {
    out.push(B('TRUCK_COST_MISSING', 'The truck source is a rental or company vehicle but no truck expense was recorded.', 'OVERRIDABLE', 'truck'))
  }
  for (const e of i.expensesMissingReceipt) {
    if (i.receiptRequiredAboveCents > 0 && e.amountCents >= i.receiptRequiredAboveCents) {
      out.push(B('RECEIPT_MISSING', `${e.label} ($${(e.amountCents / 100).toFixed(2)}) has no receipt attached.`, 'OVERRIDABLE', 'receipts'))
    }
  }
  if (i.pendingExpenseCount > 0) {
    out.push(B('EXPENSES_PENDING_REVIEW', `${i.pendingExpenseCount} expense${i.pendingExpenseCount === 1 ? '' : 's'} on this move ${i.pendingExpenseCount === 1 ? 'has' : 'have'} not been reviewed.`, 'OVERRIDABLE', 'expenses'))
  }
  if (i.ownerReimbursementOwedCents > 0) {
    out.push(B('OWNER_REIMBURSEMENT_PENDING', `$${(i.ownerReimbursementOwedCents / 100).toFixed(2)} is owed back to an owner. It is held back from distributable profit.`, 'OVERRIDABLE', 'reimbursements'))
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HARD' ? -1 : 1))
}

export const hardBlockers = (b: Blocker[]): Blocker[] => b.filter((x) => x.severity === 'HARD')
export const overridableBlockers = (b: Blocker[]): Blocker[] => b.filter((x) => x.severity === 'OVERRIDABLE')

export interface OverrideRecord {
  code: string
  reason: string
  byId?: string
  byName?: string
  at?: string
}

export interface FinalizeDecision {
  canFinalize: boolean
  blockers: Blocker[]
  /** Overridable blockers still lacking a documented override. */
  unresolved: Blocker[]
  /** Blockers no override can clear. */
  hard: Blocker[]
}

/**
 * May this move be finalized right now, given the overrides already recorded?
 * HARD blockers are never cleared by an override — that is what makes them hard.
 */
export function evaluateFinalize(blockers: Blocker[], overrides: OverrideRecord[] = []): FinalizeDecision {
  const overridden = new Set(overrides.filter((o) => o.reason?.trim()).map((o) => o.code))
  const hard = hardBlockers(blockers)
  const unresolved = overridableBlockers(blockers).filter((b) => !overridden.has(b.code))
  return {
    canFinalize: hard.length === 0 && unresolved.length === 0,
    blockers,
    unresolved,
    hard,
  }
}

/** Codes that may never be overridden, for the route-level guard. */
export function isOverridable(code: string, blockers: Blocker[]): boolean {
  const b = blockers.find((x) => x.code === code)
  return !!b && b.severity === 'OVERRIDABLE'
}

// ── Derived workflow status ─────────────────────────────────────────────────

export type CloseoutStatus =
  | 'NOT_STARTED' | 'IN_PROGRESS' | 'MISSING_INFORMATION'
  | 'READY_FOR_REVIEW' | 'READY_TO_FINALIZE' | 'FINALIZED' | 'REOPENED'

/** What the closeout status SHOULD be, given current reality. Stored status is
 *  updated from this so a stale row cannot claim a move is ready. */
export function deriveCloseoutStatus(current: {
  storedStatus: CloseoutStatus
  started: boolean
  submitted: boolean
  finalized: boolean
  reopened: boolean
  decision: FinalizeDecision
}): CloseoutStatus {
  if (current.finalized) return 'FINALIZED'
  if (!current.started) return 'NOT_STARTED'
  if (current.decision.hard.length > 0 || current.decision.unresolved.length > 0) {
    return current.reopened ? 'REOPENED' : 'MISSING_INFORMATION'
  }
  if (current.submitted) return 'READY_TO_FINALIZE'
  return 'READY_FOR_REVIEW'
}
