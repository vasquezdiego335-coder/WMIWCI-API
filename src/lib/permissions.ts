// ============================================================================
// Permission matrix (increment 2.1). Replaces ad-hoc `['OWNER','MANAGER']`
// checks with one named action → allowed-roles map. Every sensitive server
// route calls `can(session, ACTION)`; frontend hiding is never the gate. Pure +
// offline-tested (permissions.test.ts).
//
// Policy (owner spec 2.1): OWNER does everything. MANAGER runs operations but
// NOT owner-financial authority — no owner-money visibility, no permanent
// dismissals, no finalized-record edits, no WORKER_PAY override, no seeding.
// ============================================================================

export type Role = 'OWNER' | 'MANAGER' | 'CREW'

// ── Phase 1: CREW gains a NARROW set of self-service labor rights ────────────
// Crew still have no admin access (middleware blocks /admin and /api/admin).
// These exist so a future crew-facing surface can be built on an already-correct
// rule, and so `can()` never accidentally answers true for a worker.
// A worker may act ONLY on their own assignment — ownership of the row is
// checked at the route, because a permission matrix cannot express "own".
const CREW_ALLOWED: Action[] = [
  'labor.clock_self',
  'labor.submit_hours',
  'labor.view_own_labor',
]

export type Action =
  // Action Center
  | 'action_center.view'
  | 'reminder.scan'
  | 'reminder.assign'
  | 'reminder.claim'
  | 'reminder.resolve'
  | 'reminder.snooze'
  | 'reminder.dismiss_occurrence'
  | 'reminder.dismiss_permanent'
  | 'reminder.restore'
  | 'reminder.note'
  // Roadmap
  | 'roadmap.view'
  | 'roadmap.create'
  | 'roadmap.edit'
  | 'roadmap.reject'
  | 'roadmap.archive'
  | 'roadmap.seed'
  // Money
  | 'money.view_job_profit'
  | 'money.view_company_profit'
  | 'money.view_owner_ledger'
  | 'money.create_owner_transaction'
  | 'money.approve_owner_transaction'
  | 'money.create_expense'
  | 'money.approve_expense'
  | 'money.edit_finalized_expense'
  | 'money.delete_expense'
  | 'money.record_payment'
  | 'money.worker_pay_override'
  | 'money.edit_business_config'
  // Payroll
  | 'payroll.view'
  | 'payroll.edit_hours'
  | 'payroll.approve'
  | 'payroll.mark_paid'
  // ── Phase 1 labor system (owner spec 2026-07-20) ──
  | 'labor.assign_crew' // add/remove a worker on a move
  | 'labor.edit_assignment' // role, schedule, notes
  | 'labor.edit_rate_snapshot' // change a FROZEN historical rate — owner only
  | 'labor.enter_hours' // manual time entry for anyone
  | 'labor.clock_self' // clock in/out on one's OWN assignment
  | 'labor.submit_hours' // send hours for review
  | 'labor.view_own_labor' // see one's own assignment, hours and pay
  | 'labor.view_all_labor' // see everyone's hours and pay
  | 'labor.confirm_zero_labor' // record a deliberate $0 — owner only
  | 'labor.set_owner_labor_value' // economic valuation of owner time — owner only
  | 'labor.record_payment' // log a labor payment
  | 'labor.void_payment' // void a recorded labor payment — owner only
  | 'labor.finalize_override' // finalize a move with incomplete labor — owner only
  // Bookings
  | 'booking.approve' // approve a PENDING_APPROVAL booking (captures the $49 hold)
  | 'booking.decline' // decline/deny before capture (releases the hold)
  | 'booking.test_payment' // create a controlled internal test booking (staging only)
  // System
  | 'audit.view'

const OWNER_ONLY: Action[] = [
  'reminder.dismiss_permanent',
  'reminder.restore',
  'roadmap.seed',
  'money.view_company_profit',
  'money.view_owner_ledger',
  'money.create_owner_transaction',
  'money.approve_owner_transaction',
  'money.edit_finalized_expense',
  'money.delete_expense',
  'money.worker_pay_override',
  'money.edit_business_config',
  'payroll.approve',
  'payroll.mark_paid',
  'audit.view',
  // Approving a booking CAPTURES the $49 hold — that is moving money, so it is
  // OWNER-only by decision (owner spec 2026-07-15: do not automatically grant
  // future MANAGER users capture authority). Diego and Sebastian are both OWNER,
  // so this restricts nobody today. To let managers approve, remove this line.
  // `booking.decline` is intentionally NOT here: releasing an uncaptured hold
  // moves no money, so it stays OWNER + MANAGER (operations).
  'booking.approve',
  'booking.test_payment',
  // ── Phase 1 labor (owner spec 2026-07-20) ──
  // A frozen historical rate is the integrity anchor of every past move's
  // profit; only an owner may change one, and only with a reason.
  'labor.edit_rate_snapshot',
  // "$0 labor" is a financial assertion, not a data-entry convenience.
  'labor.confirm_zero_labor',
  // What an owner's hour is worth is owner-financial authority.
  'labor.set_owner_labor_value',
  // Voiding a payment rewrites settled history.
  'labor.void_payment',
  // Finalizing a move whose labor is incomplete is the override Phase 0 defined.
  'labor.finalize_override',
]

// Everything not owner-only is available to OWNER + MANAGER. CREW is limited to
// the narrow self-service set above (and is blocked from /admin by middleware).
export function can(role: Role | null | undefined, action: Action): boolean {
  if (role === 'OWNER') return true
  if (role === 'CREW') return CREW_ALLOWED.includes(action)
  if (role !== 'MANAGER') return false
  return !OWNER_ONLY.includes(action)
}

/** Convenience for API routes: returns null when allowed, or an owner-friendly
 *  error message when not (so callers can respond 403 with a clear reason). */
export function denyReason(role: Role | null | undefined, action: Action): string | null {
  if (can(role, action)) return null
  if (!role || role === 'CREW') return 'You do not have access to this action.'
  return 'Only an owner can perform this action.'
}
