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

// Stage 3: MANAGER additionally does NOT get company profit reporting. They run
// operations (move lists, estimate variance, crew efficiency, marketing
// performance) without seeing what the company earns.
const MANAGER_DENIED_EXTRA: Action[] = ['report.view_financial']

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
  // ── Phase 2 financial closeout (owner spec 2026-07-20) ──
  | 'closeout.view' // see the closeout tab and its numbers
  | 'closeout.edit' // reconcile expenses/receipts/truck source
  | 'closeout.submit' // hand the closeout to an owner for review
  | 'closeout.finalize' // lock the move + write the snapshot — owner only
  | 'closeout.reopen' // reopen a finalized move — owner only
  | 'closeout.override_blocker' // document an overridable blocker — owner only
  | 'closeout.set_overhead' // choose the overhead method/amount — owner only
  | 'closeout.set_reserves' // tax + business reserves — owner only
  | 'closeout.set_owner_split' // decide the owner split — owner only
  | 'distribution.view' // see owner distributions
  | 'distribution.plan' // draft an allocation — owner only
  | 'distribution.approve' // authorize a distribution — owner only
  | 'distribution.record_payment' // record that a distribution was paid — owner only
  | 'distribution.void' // void a distribution — owner only
  // ── Stage 3 reporting (owner spec 2026-07-20) ──
  | 'report.view_operational' // move lists, estimate variance, crew efficiency
  | 'report.view_financial' // P&L, company profit, margins
  | 'report.view_owner_money' // owner equity activity — owner only
  | 'report.view_worker_pay' // labor payables across workers
  | 'report.view_marketing' // campaign performance + profit ROAS
  | 'report.export' // download CSV/XLSX
  | 'report.export_sensitive' // exports containing profit or pay — owner only
  | 'report.save_shared_view' // publish a saved view to other users
  | 'marketing.manage_campaign' // create/edit campaigns
  | 'marketing.record_spend' // record campaign cost
  | 'marketing.correct_attribution' // owner-assign a source — audited
  | 'pricing.view_intelligence' // historical comparables + recommendations
  // ── Email Marketing (owner spec 2026-07-21) ──
  // The split follows one principle: a MANAGER runs email OPERATIONS (what was
  // sent, what bounced, why something did not go out) but does not hold the
  // controls that change what customers receive, expose the full customer email
  // list, or reveal company profit.
  | 'email.view' // overview, templates, journeys, delivery state
  | 'email.view_recipients' // see full recipient addresses (masked otherwise)
  | 'email.view_attribution' // email → booking → collected revenue → PROFIT
  | 'email.manage_journey' // pause or resume a lifecycle journey
  | 'email.cancel_scheduled' // cancel a pending scheduled send
  | 'email.retry_send' // deliberately re-drive a non-delivered send
  | 'email.manage_suppression' // restore a restorable suppression
  | 'email.manage_campaign' // create/activate/pause an EMAIL campaign
  | 'email.send_test' // send a test to the approved test recipient
  | 'email.configure' // sender identity, caps, quiet hours, flags
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
  // ── Phase 2 (owner spec 2026-07-20) ──
  // Finalizing writes an immutable financial record; reopening rewrites
  // history. Both are owner-financial authority, not operations.
  'closeout.finalize',
  'closeout.reopen',
  'closeout.override_blocker',
  // Overhead, reserves and the owner split decide how much money leaves the
  // business and to whom. A manager runs moves; owners decide the money.
  'closeout.set_overhead',
  'closeout.set_reserves',
  'closeout.set_owner_split',
  'distribution.plan',
  'distribution.approve',
  'distribution.record_payment',
  'distribution.void',
  // ── Stage 3 (owner spec 2026-07-20) ──
  // Owner equity activity and cross-worker pay are the two most sensitive
  // report surfaces; a manager runs operations without seeing either.
  'report.view_owner_money',
  'report.view_worker_pay',
  // An export is a file that leaves the building. Profit and pay exports are
  // owner-only even though running the report on screen may not be.
  'report.export_sensitive',
  'report.save_shared_view',
  // Overwriting how a customer was attributed changes marketing history.
  'marketing.correct_attribution',
  // ── Email Marketing (owner spec 2026-07-21) ──
  // The full recipient list IS the customer list. A manager sees the operational
  // record (template, status, why it was blocked) with addresses masked.
  'email.view_recipients',
  // Attribution ends in FINALIZED COMPANY NET PROFIT — the same authority line
  // already drawn by money.view_company_profit and report.view_financial.
  'email.view_attribution',
  // Pausing a journey silently stops customer communication (including move
  // reminders). That is a business decision, not an operational toggle.
  'email.manage_journey',
  // Re-driving a send can put a second copy of an email in a real inbox.
  'email.retry_send',
  // Lifting a suppression re-opens mail to someone who asked us to stop.
  'email.manage_suppression',
  // Activating a campaign mails a whole audience at once.
  'email.manage_campaign',
  // Sender identity, frequency caps and quiet hours govern every customer send.
  'email.configure',
]

// Everything not owner-only is available to OWNER + MANAGER. CREW is limited to
// the narrow self-service set above (and is blocked from /admin by middleware).
export function can(role: Role | null | undefined, action: Action): boolean {
  if (role === 'OWNER') return true
  if (role === 'CREW') return CREW_ALLOWED.includes(action)
  if (role !== 'MANAGER') return false
  if (MANAGER_DENIED_EXTRA.includes(action)) return false
  return !OWNER_ONLY.includes(action)
}

/** Convenience for API routes: returns null when allowed, or an owner-friendly
 *  error message when not (so callers can respond 403 with a clear reason). */
export function denyReason(role: Role | null | undefined, action: Action): string | null {
  if (can(role, action)) return null
  if (!role || role === 'CREW') return 'You do not have access to this action.'
  return 'Only an owner can perform this action.'
}
