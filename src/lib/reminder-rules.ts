// ============================================================================
// Action Center rule engine (increment 2, owner spec 2026-07-13).
//
// DETERMINISTIC application rules — no AI anywhere in here. Pure functions over
// plain data shapes (no Prisma imports) so every rule is offline-testable, the
// same pattern as src/lib/profit.ts. The loader (reminder-sync.ts) queries the
// DB, pre-computes money via src/lib/job-money.ts, and feeds this module.
//
// Every candidate carries a stable dedupeKey (ruleId:entityType:entityId[:extra])
// — the anti-spam guarantee. computeSyncActions() is the pure diff that decides
// create / update / auto-resolve / reopen without ever duplicating an open
// reminder or overriding a human DISMISSED decision.
// ============================================================================

import {
  severityByLeadTime, computeFingerprint, unpaidBalanceSeverity, negativeProfitSeverity,
  ADDRESS_TIERS, ADDRESS_FALLBACK, MISSING_ADDRESS_TIERS, MISSING_ADDRESS_FALLBACK,
} from './reminder-severity'
import { entityLink } from './entity-links'

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
export type Category =
  | 'BOOKING_DATA'
  | 'JOBS_SCHEDULING'
  | 'FINANCIAL'
  | 'CUSTOMER_BALANCE'
  | 'CREW_PAYROLL'
  | 'LEADS'
  | 'DATA_QUALITY'

export interface ReminderCandidate {
  reminderType: string
  category: Category
  title: string
  description: string
  severity: Severity
  sourceEntityType: string
  sourceEntityId: string
  sourceUrl: string | null
  dedupeKey: string
  dueAt: Date | null
  // Deterministic hash of the material state; filled by evaluateAll. Drives
  // dismissal reopen (OCCURRENCE / UNTIL_ENTITY_CHANGES) when it changes.
  fingerprint?: string
}

// ── Input shapes (loader fills these from Prisma + job-money) ────────────────

export interface RuleCrew {
  userId: string
  userName: string
  payStatus: string
  payMethod: string | null
  flatPay: number | null
  payRate: number | null
  userPayRate: number | null
  actualHours: number | null
  scheduledHours: number | null
}

export interface RuleBooking {
  id: string
  displayId: string
  status: string
  customerName: string
  customerPhone: string
  customerEmail: string
  originAddress: string
  destAddress: string
  originVerification: string | null
  destVerification: string | null
  manualReviewRequired: boolean
  agreementAccepted: boolean
  totalEstimate: number | null // dollars (legacy field)
  scheduledStart: Date | null
  scheduledEnd: Date | null
  requestedDate: Date | null
  completedAt: Date | null
  truckAddonDueOnMoveDay: boolean
  truckProvider: string | null
  truckReservationStatus: string | null
  truckReservationNumber: string | null
  jobStartedAt: Date | null
  crew: RuleCrew[]
  hasFailedPayment: boolean
  hasWorkerPayExpense: boolean
  // Pre-computed by the loader from src/lib/job-money.ts (single-source math):
  moveDayDueCents: number
  grossRevenueCents: number
  netProfitCents: number
}

export interface RuleExpense {
  id: string
  category: string
  amount: number // cents
  status: string
  receiptUrl: string | null
  vendor: string | null
  createdAt: Date
}

export interface RuleOwnerTx {
  id: string
  owner: string
  type: string
  amount: number // cents
  approvalStatus: string
  createdAt: Date
}

export interface RuleLead {
  id: string
  name: string
  status: string
  lostReason: string | null
  createdAt: Date
  quotedAt: Date | null
  updatedAt: Date
}

export interface RuleCustomer {
  id: string
  name: string
  phone: string
}

export interface RuleInput {
  bookings: RuleBooking[]
  expenses: RuleExpense[] // general (non-booking) + booking expenses alike
  ownerTransactions: RuleOwnerTx[]
  leads: RuleLead[]
  customers: RuleCustomer[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const DAY = 24 * HOUR

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
const et = (d: Date) =>
  d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
const key = (rule: string, type: string, id: string, extra?: string) =>
  extra ? `${rule}:${type}:${id}:${extra}` : `${rule}:${type}:${id}`
// Centralized so a booking link is never hand-built (and lead links stay null).
const jobUrl = (id: string) => entityLink('booking', id)
const digits = (s: string) => (s ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')

const ACTIVE_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']
const LIVE_STATUSES = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']

// True when this booking needs a truck someone must confirm.
function truckUnresolved(b: RuleBooking): boolean {
  const needsTruck = b.truckAddonDueOnMoveDay || (b.truckProvider ?? '').toLowerCase() === 'customer'
  if (!needsTruck) return false
  const reserved = (b.truckReservationStatus ?? '').toLowerCase() === 'reserved' || !!b.truckReservationNumber
  return !reserved
}

// A crew row that has any pay signal at all (rate, hours, or flat pay).
const crewHasPaySignal = (c: RuleCrew) =>
  c.flatPay != null || c.actualHours != null || c.payRate != null || c.userPayRate != null

/** THE labor double-count guardrail check (financial architecture, Part 5):
 *  a job that has crew payroll data AND a WORKER_PAY expense may be counting
 *  the same labor twice. Pure so it's unit-tested directly. */
export function hasLaborDoubleCountRisk(b: Pick<RuleBooking, 'hasWorkerPayExpense' | 'crew'>): boolean {
  return b.hasWorkerPayExpense && b.crew.some(crewHasPaySignal)
}

// ── Booking-level rules ──────────────────────────────────────────────────────

export function evaluateBooking(b: RuleBooking, now: Date): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  const start = b.scheduledStart ?? b.requestedDate
  const startsWithin = (ms: number) => !!start && start.getTime() - now.getTime() < ms && start.getTime() > now.getTime() - DAY
  const when = start ? ` (move ${et(start)})` : ''

  // BOOKING_DATA ---------------------------------------------------------------
  if (ACTIVE_STATUSES.includes(b.status)) {
    if (!b.originAddress?.trim() || !b.destAddress?.trim()) {
      const which = !b.originAddress?.trim() ? 'pickup' : 'drop-off'
      out.push({
        reminderType: 'booking-missing-address', category: 'BOOKING_DATA',
        severity: severityByLeadTime(start, now, MISSING_ADDRESS_TIERS, MISSING_ADDRESS_FALLBACK),
        title: `${b.customerName}: missing ${which} address`,
        description: `The ${which} address for this booking is blank${when}. The crew cannot be dispatched without it.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('booking-missing-address', 'booking', b.id), dueAt: start,
      })
    }

    if (b.manualReviewRequired || b.originVerification === 'unverified' || b.destVerification === 'unverified') {
      const which = b.originVerification === 'unverified' ? 'pickup' : b.destVerification === 'unverified' ? 'drop-off' : 'an'
      out.push({
        reminderType: 'booking-address-unverified', category: 'BOOKING_DATA',
        severity: severityByLeadTime(start, now, ADDRESS_TIERS, ADDRESS_FALLBACK),
        title: `${b.customerName}: address needs verification`,
        description: `The ${which} address could not be verified automatically${when}. Confirm it with the customer before the crew is assigned.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('booking-address-unverified', 'booking', b.id), dueAt: start,
      })
    }

    if (!digits(b.customerPhone) || !b.customerEmail?.trim()) {
      const missing = [!digits(b.customerPhone) && 'phone number', !b.customerEmail?.trim() && 'email'].filter(Boolean).join(' and ')
      out.push({
        reminderType: 'booking-missing-contact', category: 'BOOKING_DATA',
        severity: digits(b.customerPhone) ? 'MEDIUM' : 'HIGH',
        title: `${b.customerName}: missing ${missing}`,
        description: `There is no ${missing} on file for this customer${when}. The crew and office cannot reach them.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('booking-missing-contact', 'booking', b.id), dueAt: start,
      })
    }

    if (truckUnresolved(b) && startsWithin(3 * DAY)) {
      out.push({
        reminderType: 'booking-truck-unresolved', category: 'BOOKING_DATA', severity: 'HIGH',
        title: `${b.customerName}: truck not confirmed`,
        description: `This move needs a truck but there is no confirmed reservation${when}. Confirm who is providing the truck and record the reservation.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('booking-truck-unresolved', 'booking', b.id), dueAt: start,
      })
    }

    if (LIVE_STATUSES.includes(b.status) && !b.agreementAccepted) {
      out.push({
        reminderType: 'booking-agreement-missing', category: 'BOOKING_DATA', severity: 'MEDIUM',
        title: `${b.customerName}: service agreement not signed`,
        description: `This booking is ${b.status.toLowerCase().replace(/_/g, ' ')} but the moving agreement has not been accepted${when}.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('booking-agreement-missing', 'booking', b.id), dueAt: start,
      })
    }
  }

  if (b.status === 'PENDING_APPROVAL' && startsWithin(2 * DAY)) {
    out.push({
      reminderType: 'booking-approval-overdue', category: 'BOOKING_DATA', severity: 'CRITICAL',
      title: `${b.customerName}: booking not approved and move is close`,
      description: `The requested move date is ${start ? et(start) : 'soon'} but the booking is still waiting for approval. Approve or decline it now.`,
      sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
      dedupeKey: key('booking-approval-overdue', 'booking', b.id), dueAt: start,
    })
  }

  // JOBS_SCHEDULING ------------------------------------------------------------
  if (LIVE_STATUSES.includes(b.status)) {
    if (b.crew.length === 0 && startsWithin(DAY)) {
      out.push({
        reminderType: 'job-24h-no-crew', category: 'JOBS_SCHEDULING', severity: 'CRITICAL',
        title: `${b.customerName}: job starts within 24 hours with no crew`,
        description: `This job starts ${start ? et(start) : 'soon'} and nobody is assigned to it. Assign the crew now.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-24h-no-crew', 'booking', b.id), dueAt: start,
      })
    }

    if (b.status === 'CONFIRMED' && !b.scheduledStart) {
      out.push({
        reminderType: 'job-no-start-time', category: 'JOBS_SCHEDULING', severity: 'HIGH',
        title: `${b.customerName}: confirmed job has no start time`,
        description: `This booking is confirmed but has no scheduled start time, so it is invisible to the calendar and daily digest.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-no-start-time', 'booking', b.id), dueAt: null,
      })
    }

    if (b.status === 'SCHEDULED' && b.scheduledStart && now.getTime() - b.scheduledStart.getTime() > HOUR) {
      out.push({
        reminderType: 'job-not-started', category: 'JOBS_SCHEDULING', severity: 'HIGH',
        title: `${b.customerName}: job has not been started`,
        description: `The job was scheduled to start ${et(b.scheduledStart)} but has not been marked in progress. Check on the crew.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-not-started', 'booking', b.id), dueAt: b.scheduledStart,
      })
    }

    if (b.status === 'IN_PROGRESS' && b.jobStartedAt && now.getTime() - b.jobStartedAt.getTime() > 12 * HOUR) {
      out.push({
        reminderType: 'job-running-long', category: 'JOBS_SCHEDULING', severity: 'MEDIUM',
        title: `${b.customerName}: job has been running over 12 hours`,
        description: `This job started ${et(b.jobStartedAt)} and is still marked in progress. Confirm it is actually still running and complete it if done.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-running-long', 'booking', b.id), dueAt: null,
      })
    }
  }

  // FINANCIAL / CUSTOMER_BALANCE ------------------------------------------------
  if (b.status === 'COMPLETED') {
    if (b.moveDayDueCents > 0) {
      const daysSince = b.completedAt ? (now.getTime() - b.completedAt.getTime()) / DAY : 0
      out.push({
        reminderType: 'job-balance-unpaid', category: 'CUSTOMER_BALANCE',
        severity: unpaidBalanceSeverity(b.moveDayDueCents, daysSince),
        title: `${b.customerName}: ${money(b.moveDayDueCents)} still owed after completed job`,
        description: `The job is complete but ${money(b.moveDayDueCents)} in move-day charges has not been recorded as collected. Collect it or record the payment on the job page.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-balance-unpaid', 'booking', b.id),
        dueAt: b.completedAt ? new Date(b.completedAt.getTime() + 3 * DAY) : null,
      })
    }

    if (b.grossRevenueCents > 0 && b.netProfitCents < 0) {
      out.push({
        reminderType: 'job-negative-profit', category: 'FINANCIAL',
        severity: negativeProfitSeverity(b.netProfitCents),
        title: `${b.customerName}: job lost money (${money(b.netProfitCents)})`,
        description: `Recorded costs on this completed job exceed the revenue collected. Review the crew pay and expenses — or record the missing customer payment.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-negative-profit', 'booking', b.id), dueAt: null,
      })
    }

    const missingHours = b.crew.filter((c) => c.actualHours == null && c.flatPay == null)
    if (missingHours.length > 0) {
      out.push({
        reminderType: 'job-completed-no-hours', category: 'CREW_PAYROLL', severity: 'HIGH',
        title: `${b.customerName}: crew hours missing on completed job`,
        description: `${missingHours.map((c) => c.userName).join(', ')} worked this job but no hours or flat pay were recorded. Pay cannot be calculated until this is entered.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-completed-no-hours', 'booking', b.id), dueAt: null,
      })
    }
  }

  if (b.hasFailedPayment && b.status !== 'CANCELLED') {
    out.push({
      reminderType: 'payment-failed', category: 'CUSTOMER_BALANCE', severity: 'HIGH',
      title: `${b.customerName}: a payment failed`,
      description: `A payment on this booking failed. Check Stripe and follow up with the customer about how they will pay.`,
      sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
      dedupeKey: key('payment-failed', 'booking', b.id), dueAt: null,
    })
  }

  // CREW_PAYROLL -----------------------------------------------------------------
  if ([...LIVE_STATUSES, 'COMPLETED'].includes(b.status)) {
    for (const c of b.crew) {
      if (c.flatPay == null && c.payRate == null && c.userPayRate == null) {
        out.push({
          reminderType: 'crew-missing-rate', category: 'CREW_PAYROLL', severity: 'HIGH',
          title: `${c.userName}: no pay rate set`,
          description: `${c.userName} is assigned to ${b.customerName}'s job but has no hourly rate or flat pay anywhere. Their pay cannot be calculated.`,
          sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
          dedupeKey: key('crew-missing-rate', 'booking', b.id, c.userId), dueAt: null,
        })
      }
      if (c.payStatus === 'PAY_APPROVED') {
        out.push({
          reminderType: 'crew-pay-approved-unpaid', category: 'CREW_PAYROLL', severity: 'MEDIUM',
          title: `${c.userName}: pay approved but not paid`,
          description: `Pay for ${c.userName} on ${b.customerName}'s job is approved but has not been marked paid.`,
          sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
          dedupeKey: key('crew-pay-approved-unpaid', 'booking', b.id, c.userId), dueAt: null,
        })
      }
      if (c.payStatus === 'PAID' && !c.payMethod) {
        out.push({
          reminderType: 'crew-paid-no-method', category: 'CREW_PAYROLL', severity: 'LOW',
          title: `${c.userName}: paid with no payment method recorded`,
          description: `${c.userName} was marked paid on ${b.customerName}'s job but no payment method was recorded. Add it for the payment history.`,
          sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
          dedupeKey: key('crew-paid-no-method', 'booking', b.id, c.userId), dueAt: null,
        })
      }
    }
  }

  // DATA_QUALITY -------------------------------------------------------------------
  if (['CONFIRMED', 'SCHEDULED', 'COMPLETED'].includes(b.status) && b.totalEstimate == null) {
    out.push({
      reminderType: 'job-revenue-missing', category: 'DATA_QUALITY', severity: 'MEDIUM',
      title: `${b.customerName}: job has no quoted total`,
      description: `There is no estimated total on this booking, so revenue and profit reporting for it will be wrong. Enter the quoted price.`,
      sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
      dedupeKey: key('job-revenue-missing', 'booking', b.id), dueAt: null,
    })
  }

  if (hasLaborDoubleCountRisk(b)) {
    out.push({
      reminderType: 'worker-pay-double-count', category: 'DATA_QUALITY', severity: 'HIGH',
      title: `${b.customerName}: possible double-counted labor`,
      description: `This job has crew pay in payroll AND a "Worker pay" expense. If both describe the same labor, the job's profit is understated — the Worker pay expense category is only for helpers who are not in the crew system. Review and remove one.`,
      sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
      dedupeKey: key('worker-pay-double-count', 'booking', b.id), dueAt: null,
    })
  }

  return out
}

// ── Cross-booking rule: crew double-booked ───────────────────────────────────

export function evaluateCrewOverlaps(bookings: RuleBooking[], now: Date): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  const live = bookings.filter((b) => LIVE_STATUSES.includes(b.status) && b.scheduledStart && b.scheduledStart.getTime() > now.getTime() - DAY)
  const seen = new Set<string>()
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j]
      const aEnd = a.scheduledEnd ?? new Date(a.scheduledStart!.getTime() + 4 * HOUR)
      const bEnd = b.scheduledEnd ?? new Date(b.scheduledStart!.getTime() + 4 * HOUR)
      if (a.scheduledStart! < bEnd && b.scheduledStart! < aEnd) {
        for (const ca of a.crew) {
          const cb = b.crew.find((c) => c.userId === ca.userId)
          if (!cb) continue
          // Stable pair key regardless of order.
          const pair = [a.id, b.id].sort().join(':')
          const k = key('crew-double-booked', 'crew', ca.userId, pair)
          if (seen.has(k)) continue
          seen.add(k)
          out.push({
            reminderType: 'crew-double-booked', category: 'JOBS_SCHEDULING', severity: 'CRITICAL',
            title: `${ca.userName} is assigned to two overlapping jobs`,
            description: `${ca.userName} is on ${a.customerName}'s job (${et(a.scheduledStart!)}) and ${b.customerName}'s job (${et(b.scheduledStart!)}) at the same time. Reassign one of them.`,
            sourceEntityType: 'booking', sourceEntityId: a.id, sourceUrl: jobUrl(a.id),
            dedupeKey: k, dueAt: a.scheduledStart,
          })
        }
      }
    }
  }
  return out
}

// ── Expense / owner-money / lead / customer rules ─────────────────────────────

export function evaluateExpenses(expenses: RuleExpense[], now: Date): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  for (const e of expenses) {
    const label = `${e.vendor ? `${e.vendor} — ` : ''}${money(e.amount)}`
    if (['SUBMITTED', 'NEEDS_REVIEW'].includes(e.status) && now.getTime() - e.createdAt.getTime() > 3 * DAY) {
      out.push({
        reminderType: 'expense-needs-review', category: 'FINANCIAL', severity: 'MEDIUM',
        title: `Expense waiting for approval: ${label}`,
        description: `This expense was submitted over 3 days ago and is still waiting for review. Approve or reject it so reports stay accurate.`,
        sourceEntityType: 'expense', sourceEntityId: e.id, sourceUrl: '/admin/expenses',
        dedupeKey: key('expense-needs-review', 'expense', e.id), dueAt: null,
      })
    }
    if (!e.receiptUrl && e.amount >= 2500 && !['REJECTED'].includes(e.status)) {
      out.push({
        reminderType: 'expense-missing-receipt', category: 'FINANCIAL', severity: 'LOW',
        title: `Expense missing a receipt: ${label}`,
        description: `This expense is $25 or more and has no receipt attached. Upload one for tax records.`,
        sourceEntityType: 'expense', sourceEntityId: e.id, sourceUrl: '/admin/expenses',
        dedupeKey: key('expense-missing-receipt', 'expense', e.id), dueAt: null,
      })
    }
  }
  return out
}

export function evaluateOwnerTransactions(txs: RuleOwnerTx[], now: Date): ReminderCandidate[] {
  return txs
    .filter((t) => t.approvalStatus === 'PENDING' && now.getTime() - t.createdAt.getTime() > 2 * DAY)
    .map((t) => ({
      reminderType: 'owner-tx-pending', category: 'FINANCIAL' as Category, severity: 'MEDIUM' as Severity,
      title: `Owner transaction waiting for approval (${t.owner === 'DIEGO' ? 'Diego' : 'Sebastian'}, ${money(t.amount)})`,
      description: `A ${t.type.toLowerCase().replace(/_/g, ' ')} recorded over 2 days ago is still pending approval on the Owner Money page.`,
      sourceEntityType: 'owner_transaction', sourceEntityId: t.id, sourceUrl: '/admin/owner-money',
      dedupeKey: key('owner-tx-pending', 'owner_transaction', t.id), dueAt: null,
    }))
}

export function evaluateLeads(leads: RuleLead[], now: Date): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  for (const l of leads) {
    if (l.status === 'NEW' && now.getTime() - l.createdAt.getTime() > DAY) {
      out.push({
        reminderType: 'lead-not-contacted', category: 'LEADS', severity: 'HIGH',
        title: `Lead not contacted: ${l.name}`,
        description: `${l.name} reached out over 24 hours ago and nobody has contacted them yet. Fast response wins moving jobs.`,
        sourceEntityType: 'lead', sourceEntityId: l.id, sourceUrl: null,
        dedupeKey: key('lead-not-contacted', 'lead', l.id), dueAt: new Date(l.createdAt.getTime() + DAY),
      })
    }
    if (l.status === 'QUOTE_SENT' && l.quotedAt && now.getTime() - l.quotedAt.getTime() > 2 * DAY) {
      out.push({
        reminderType: 'lead-followup-overdue', category: 'LEADS', severity: 'HIGH',
        title: `Quote follow-up overdue: ${l.name}`,
        description: `A quote went to ${l.name} over 48 hours ago with no follow-up recorded. Call or text them.`,
        sourceEntityType: 'lead', sourceEntityId: l.id, sourceUrl: null,
        dedupeKey: key('lead-followup-overdue', 'lead', l.id), dueAt: new Date(l.quotedAt.getTime() + 2 * DAY),
      })
    }
    if (l.status === 'LOST' && !l.lostReason) {
      out.push({
        reminderType: 'lead-lost-no-reason', category: 'LEADS', severity: 'LOW',
        title: `Lost lead has no reason recorded: ${l.name}`,
        description: `This lead was marked lost without a reason. Recording why (price, timing, competitor) is what makes marketing reports useful.`,
        sourceEntityType: 'lead', sourceEntityId: l.id, sourceUrl: null,
        dedupeKey: key('lead-lost-no-reason', 'lead', l.id), dueAt: null,
      })
    }
  }
  return out
}

export function evaluateCustomers(customers: RuleCustomer[]): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  const byPhone = new Map<string, RuleCustomer[]>()
  for (const c of customers) {
    const p = digits(c.phone)
    if (p.length !== 10) continue
    const list = byPhone.get(p) ?? []
    list.push(c)
    byPhone.set(p, list)
  }
  for (const [phone, list] of Array.from(byPhone.entries())) {
    if (list.length < 2) continue
    const ids = list.map((c) => c.id).sort()
    out.push({
      reminderType: 'customer-duplicate-phone', category: 'DATA_QUALITY', severity: 'MEDIUM',
      title: `Possible duplicate customers: ${list.map((c) => c.name).join(' / ')}`,
      description: `${list.length} customer records share the same phone number. If they are the same person, their booking history and lifetime value are split.`,
      sourceEntityType: 'customer', sourceEntityId: ids[0], sourceUrl: '/admin/customers',
      dedupeKey: key('customer-duplicate-phone', 'customer', ids.join('+'), phone.slice(-4)),
      dueAt: null,
    })
  }
  return out
}

// ── Top-level evaluation ──────────────────────────────────────────────────────

export function evaluateAll(input: RuleInput, now: Date): ReminderCandidate[] {
  const raw = [
    ...input.bookings.flatMap((b) => evaluateBooking(b, now)),
    ...evaluateCrewOverlaps(input.bookings, now),
    ...evaluateExpenses(input.expenses, now),
    ...evaluateOwnerTransactions(input.ownerTransactions, now),
    ...evaluateLeads(input.leads, now),
    ...evaluateCustomers(input.customers),
  ]
  // Stamp the deterministic fingerprint once, centrally, so no rule has to.
  return raw.map((c) => ({ ...c, fingerprint: computeFingerprint(c) }))
}

// ── Pure sync diff (the deduplication contract) ──────────────────────────────
// Given the current candidates and the existing reminder rows, decide what to
// create, update, auto-resolve, reopen, or wake from snooze — WITHOUT ever
// duplicating an open reminder or overriding a human DISMISSED decision.

export interface ExistingReminder {
  id: string
  dedupeKey: string
  status: string
  createdBy: string
  snoozedUntil: Date | null
  title: string
  description: string
  severity: string
  dueAt: Date | null
  // Increment 2.1: dismissal scope + fingerprint drive whether a DISMISSED
  // reminder can reopen. A legacy dismissal (scope null) is treated as
  // permanent — existing dismissed reminders never resurface unexpectedly.
  dismissalScope?: string | null
  entityFingerprint?: string | null
}

export interface SyncActions {
  create: ReminderCandidate[]
  /** Refresh title/description/severity/dueAt on a live reminder (assignment + notes preserved). */
  update: { id: string; candidate: ReminderCandidate }[]
  /** Condition cleared → auto-resolve (system reminders only, never human-dismissed). */
  autoResolve: { id: string }[]
  /** Previously resolved, condition returned → reopen. */
  reopen: { id: string; candidate: ReminderCandidate }[]
  /** Snooze expired and the condition still exists → wake to OPEN. */
  wake: { id: string; candidate: ReminderCandidate }[]
}

const ACTIVE_REMINDER = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS']

export function computeSyncActions(existing: ExistingReminder[], candidates: ReminderCandidate[], now: Date): SyncActions {
  const byKey = new Map(existing.map((r) => [r.dedupeKey, r]))
  const candidateKeys = new Set(candidates.map((c) => c.dedupeKey))
  const actions: SyncActions = { create: [], update: [], autoResolve: [], reopen: [], wake: [] }

  for (const c of candidates) {
    const r = byKey.get(c.dedupeKey)
    if (!r) {
      actions.create.push(c)
      continue
    }
    if (r.status === 'DISMISSED') {
      // Dismissal scope decides whether the still-detected issue can return.
      //  • PERMANENT_RULE_ENTITY (or legacy null scope): never reopens here.
      //  • UNTIL_ENTITY_CHANGES / OCCURRENCE: reopen only when the material
      //    state changed (fingerprint differs from what was dismissed).
      const scope = r.dismissalScope ?? 'PERMANENT_RULE_ENTITY'
      if (scope === 'PERMANENT_RULE_ENTITY') continue
      const changed = !!c.fingerprint && c.fingerprint !== (r.entityFingerprint ?? null)
      if (changed) actions.reopen.push({ id: r.id, candidate: c })
      continue
    }
    if (r.status === 'RESOLVED') {
      actions.reopen.push({ id: r.id, candidate: c })
      continue
    }
    if (r.status === 'SNOOZED') {
      if (r.snoozedUntil && r.snoozedUntil.getTime() <= now.getTime()) actions.wake.push({ id: r.id, candidate: c })
      continue // still snoozed — leave it alone
    }
    // Active: refresh volatile fields if anything changed.
    const changed =
      r.title !== c.title || r.description !== c.description || r.severity !== c.severity ||
      (r.dueAt?.getTime() ?? null) !== (c.dueAt?.getTime() ?? null)
    if (changed) actions.update.push({ id: r.id, candidate: c })
  }

  // Anything the system created that is still live but no longer detected → resolved.
  for (const r of existing) {
    if (r.createdBy !== 'system') continue
    if (candidateKeys.has(r.dedupeKey)) continue
    if (ACTIVE_REMINDER.includes(r.status) || r.status === 'SNOOZED') actions.autoResolve.push({ id: r.id })
  }

  return actions
}
