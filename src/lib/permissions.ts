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
  // Bookings
  | 'booking.approve' // approve a PENDING_APPROVAL booking (captures the $49 hold)
  | 'booking.decline' // decline/deny before capture (releases the hold)
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
]

// Everything not owner-only is available to OWNER + MANAGER. CREW has no admin
// access at all (blocked earlier by middleware, but enforced here too).
export function can(role: Role | null | undefined, action: Action): boolean {
  if (role === 'OWNER') return true
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
