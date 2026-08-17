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
import { truckConflictBetween, etDayKey, holdsTruck, isPendingTruckHold } from './truck-conflicts'

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
  // ── Moving OS Phase 1: fleet-truck double-booking detection. Optional so
  //    existing fixtures/callers keep compiling — a missing truckId simply
  //    means the booking has no fleet truck and can never truck-conflict.
  //    confirmedDate is the date-only fallback the pure truck lib uses for
  //    the conservative same-ET-day check on rows without scheduledStart. ──
  truckId?: string | null
  confirmedDate?: Date | null
  /** Booking.estimatedHours (P0-A). How long the job actually runs, which is
   *  how the truck rule knows an 18:00 4BR occupies its truck past midnight
   *  while a 20:00 studio does not. Optional: absent → the flat truck fallback,
   *  the pre-P0-A behaviour, so existing fixtures and callers are unchanged. */
  estimatedHours?: number | null
  /** Booking.createdAt. Only the D1 stale-unpaid-hold rule reads it, and that
   *  rule stays SILENT when it is absent: a row whose age nobody can prove is a
   *  row nobody may call abandoned. Optional so every existing fixture and
   *  caller behaves exactly as before. */
  createdAt?: Date | null
  /** Booking.startTimeKnown (item R2-1). FALSE = the owner booked a DATE and
   *  has not committed to a crew hour, so `requestedDate`/`confirmedDate` are
   *  00:00 ET day anchors whose time-of-day must never be printed. Optional:
   *  absent keeps the legacy assumption (a time is known), so existing
   *  fixtures and a loader running before migration
   *  20260812010000_start_time_known is applied behave exactly as before. */
  startTimeKnown?: boolean | null
  crew: RuleCrew[]
  hasFailedPayment: boolean
  hasWorkerPayExpense: boolean
  // Pre-computed by the loader from src/lib/job-money.ts (single-source math):
  /** Full customer balance still owed (job-money.customerBalance) — base
   *  labor INCLUDED, not just the move-day fee columns. */
  outstandingBalanceCents: number
  netRevenueCents: number
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
  /** Partial-booking lifecycle (owner spec 2026-07-24). PARTIAL/IN_PROGRESS/
   *  ABANDONED leads are browsed on the Leads page, not pushed as individual
   *  owner reminders (a self-abandoned Step-1 email is not a missed callback).
   *  Null on ordinary CRM leads — their reminder behavior is unchanged. */
  lifecycle?: string | null
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
/** Date without the hour — for a move whose crew time nobody has chosen. */
const etDate = (d: Date) =>
  d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
/** THE move-time display rule for rule copy (item R2-1): full timestamp when a
 *  real crew hour exists, date alone when the booking is day-level. A booking
 *  with no `scheduledStart` and `startTimeKnown === false` has a 00:00 ET day
 *  anchor for a date — printing `et()` on it told the owner the job is at
 *  12:00 AM. Anything else (a stored scheduledStart, or an unread/absent flag)
 *  keeps the previous output exactly. */
const etMove = (d: Date, b: Pick<RuleBooking, 'scheduledStart' | 'startTimeKnown'>) =>
  !b.scheduledStart && b.startTimeKnown === false ? etDate(d) : et(d)
const key = (rule: string, type: string, id: string, extra?: string) =>
  extra ? `${rule}:${type}:${id}:${extra}` : `${rule}:${type}:${id}`
// Centralized so a booking link is never hand-built (and lead links stay null).
const jobUrl = (id: string) => entityLink('booking', id)
const digits = (s: string) => (s ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')

const ACTIVE_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']
const LIVE_STATUSES = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']

/** D1: how old an unpaid hold must be before the Action Center lists it.
 *
 *  A REPORTING threshold, not a safety guard — nothing acts on it. It sits well
 *  above `checkout-expiry.STALE_CHECKOUT_MIN_AGE_MS` (the 2 h floor the verified
 *  findings asked for) and above the first two abandoned-checkout recovery
 *  stages, so the owner is never handed a booking the recovery funnel is still
 *  actively working; the relationship to that floor is pinned by a test rather
 *  than trusted, because this module must stay free of Prisma/Stripe imports
 *  and so cannot import the constant. */
export const STALE_UNPAID_HOLD_MS = 24 * 3_600_000

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
  // Item R2-1: a day-level booking's `start` is a 00:00 ET day anchor. It is
  // still the right value to SORT, compare and set `dueAt` from — only its
  // time-of-day is a fiction, so the printed copy drops the hour.
  const when = start ? ` (move ${etMove(start, b)})` : ''

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

  // ── D1: THE STALE UNPAID CHECKOUT HOLD, AS A REPORT ──────────────────────
  //
  // B6 made an hourly sweep CANCEL these. That path cancelled bookings whose
  // customers were mid-payment and could never be undone, so D1 removed it: a
  // stale hold is now SURFACED here and ended only by a person (the audited
  // "Release truck hold" action on the booking page).
  //
  // Everything this says is provable from the row in front of it — the booking
  // is PENDING_PAYMENT (a truck-hold status, R2-2), no deposit is recorded, a
  // fleet truck is assigned, and the row is older than the threshold. It asks
  // Stripe nothing and claims nothing about the customer's card. With no
  // `createdAt` it says NOTHING: age it cannot prove is age it does not assert.
  if (
    b.status === 'PENDING_PAYMENT' &&
    holdsTruck(b.status) &&
    !!b.truckId &&
    !!b.createdAt &&
    now.getTime() - b.createdAt.getTime() >= STALE_UNPAID_HOLD_MS
  ) {
    out.push({
      reminderType: 'checkout-hold-stale', category: 'JOBS_SCHEDULING', severity: 'MEDIUM',
      title: `${b.customerName}: unpaid hold is still holding a truck`,
      description:
        `No deposit has been recorded for this booking since it was created on ${etDate(b.createdAt)}, and it still ` +
        `holds its assigned truck${when}. If the customer is still coming, send them a fresh payment link. If not, open ` +
        `the booking and use "Release truck hold" — that cancels the booking and cannot be undone, so nothing does it ` +
        `automatically.`,
      sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
      dedupeKey: key('checkout-hold-stale', 'booking', b.id), dueAt: start,
    })
  }

  if (b.status === 'PENDING_APPROVAL' && startsWithin(2 * DAY)) {
    out.push({
      reminderType: 'booking-approval-overdue', category: 'BOOKING_DATA', severity: 'CRITICAL',
      title: `${b.customerName}: booking not approved and move is close`,
      description: `The requested move date is ${start ? etMove(start, b) : 'soon'} but the booking is still waiting for approval. Approve or decline it now.`,
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
        description: `This job starts ${start ? etMove(start, b) : 'soon'} and nobody is assigned to it. Assign the crew now.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-24h-no-crew', 'booking', b.id), dueAt: start,
      })
    }

    // Item R2-1. Two different situations share "confirmed with no
    // scheduledStart", and they deserve different words:
    //
    //  • startTimeKnown === false — the owner DELIBERATELY took the booking at
    //    day level. Nothing is broken; the hour is still owed to the crew and
    //    the truck check is holding the whole day until it exists. MEDIUM.
    //  • otherwise — a confirmed job that should have a time and does not
    //    (a legacy row, or a schedule write that did not land). HIGH.
    //
    // The old copy claimed the booking was "invisible to the calendar and daily
    // digest". That was never true: `scheduling.moveDateInRange` coalesces
    // scheduledStart → confirmedDate → requestedDate, which is exactly how the
    // digest and the schedule views query. Saying so trained the owner to
    // distrust a correct list. Same reminderType/dedupeKey in both branches, so
    // a booking that later gets a real time resolves ONE reminder, not two.
    if (b.status === 'CONFIRMED' && !b.scheduledStart) {
      const dayLevel = b.startTimeKnown === false
      out.push({
        reminderType: 'job-no-start-time', category: 'JOBS_SCHEDULING',
        severity: dayLevel ? 'MEDIUM' : 'HIGH',
        title: dayLevel
          ? `${b.customerName}: no crew start time committed yet`
          : `${b.customerName}: confirmed job has no start time`,
        description: dayLevel
          ? `This move is booked at DAY level${when} — no crew hour has been set, so nothing invented one. It still shows on the calendar and the daily digest by date, and the truck is held for the whole day. Set the start time once you commit to it.`
          : `This booking is confirmed but has no scheduled start time. It still appears on the calendar and daily digest by date, but the crew, the customer and the truck check have no hour to work from — set one.`,
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
    if (b.outstandingBalanceCents > 0) {
      const daysSince = b.completedAt ? (now.getTime() - b.completedAt.getTime()) / DAY : 0
      out.push({
        reminderType: 'job-balance-unpaid', category: 'CUSTOMER_BALANCE',
        severity: unpaidBalanceSeverity(b.outstandingBalanceCents, daysSince),
        title: `${b.customerName}: ${money(b.outstandingBalanceCents)} still owed after completed job`,
        description: `The job is complete but ${money(b.outstandingBalanceCents)} of the customer's balance has not been recorded as collected. Collect it or record the payment on the job page.`,
        sourceEntityType: 'booking', sourceEntityId: b.id, sourceUrl: jobUrl(b.id),
        dedupeKey: key('job-balance-unpaid', 'booking', b.id),
        dueAt: b.completedAt ? new Date(b.completedAt.getTime() + 3 * DAY) : null,
      })
    }

    if (b.netRevenueCents > 0 && b.netProfitCents < 0) {
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

// ── Cross-booking rule: truck double-booked (Moving OS Phase 1) ──────────────
// Two bookings HOLDING the SAME fleet truck with overlapping windows — or
// unknown times on the same ET day (the pure lib's conservative rule). The
// dedupeKey is truck+day, so three jobs colliding on one truck on one day
// collapse into ONE reminder listing all of them instead of three near-dupes.
//
// R2-2: "holding" is TRUCK_HOLD_STATUSES (truck-conflicts.holdsTruck), not the
// live statuses. The default `stripe_link` create assigns a truck on a
// PENDING_PAYMENT row, so a rule that only looked at CONFIRMED/SCHEDULED/
// IN_PROGRESS stayed silent until BOTH clashing bookings had been approved —
// i.e. it fired after the damage instead of before it. An unpaid hold is
// called out as such in the copy, because the owner may deliberately let two
// unpaid holds sit on one truck expecting one to fall through.
//
// LOADER (R3-3): reminder-sync.performSync now loads PENDING_PAYMENT as well
// (SCANNED_BOOKING_STATUSES in scan-lock.ts), so the unpaid holds the default
// `stripe_link` create writes are finally evaluated here — round 2's rule was
// correct about statuses and blind in practice, because the rows never reached
// it. The create-time guard (truck-lock.ts) is still what PREVENTS the unpaid
// double-booking; this rule is the detector for rows that got there another way
// (an audited override, a truck reassignment, a hand-edited status).
//
// R3-3 fix 2 — THE ROW MAPPER. The shape below used to drop `requestedDate`
// while `basisOf` coalesced only scheduledStart → confirmedDate. A
// PENDING_PAYMENT row has NEITHER (buildBookingCreateData writes the schedule
// columns only on a CONFIRMED create), so every pending hold was discarded at
// the `!!basis` filter no matter which statuses the loader supplied. Both now
// coalesce through requestedDate — the same chain scheduling.effectiveMoveDate
// / moveDateInRange and truck-conflicts.toTruckBookingShapes use.

// P0-A — THE RULE IS THE BACKSTOP, SO IT NEEDS THE SAME WINDOW. The create-time
// guard PREVENTS a double-booking; this rule is what finds one that got there
// another way. It inherited the flat 6h hold, so the pair P0-A is about (an
// evening job whose real window crosses midnight) was invisible on BOTH sides:
// nothing refused it at create time and nothing flagged it afterwards, right up
// to move day. `estimatedHours` is already loaded — performSync reads bookings
// with `include`, so every scalar is in hand — it just was not carried across.

const toTruckShape = (b: RuleBooking) => ({
  id: b.id,
  truckId: b.truckId ?? null,
  scheduledStart: b.scheduledStart,
  scheduledEnd: b.scheduledEnd,
  // Mirrors toTruckBookingShapes: the day anchor is confirmedDate, else the
  // requested date — never nothing when the booking has a move date at all.
  confirmedDate: b.confirmedDate ?? b.requestedDate ?? null,
  status: b.status,
  estimatedHours: b.estimatedHours ?? null,
})

export function evaluateTruckOverlaps(bookings: RuleBooking[], now: Date): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  const basisOf = (b: RuleBooking) => b.scheduledStart ?? b.confirmedDate ?? b.requestedDate ?? null
  // Same recency window as the crew rule: recent past + future, live statuses.
  const live = bookings.filter((b) => {
    // R2-2: holdsTruck (TRUCK_HOLD_STATUSES) — live jobs AND unpaid/unapproved
    // holds, the ONE list every truck caller uses.
    if (!holdsTruck(b.status) || !b.truckId) return false
    const basis = basisOf(b)
    return !!basis && basis.getTime() > now.getTime() - DAY
  })

  const byTruck = new Map<string, RuleBooking[]>()
  for (const b of live) {
    const list = byTruck.get(b.truckId!) ?? []
    list.push(b)
    byTruck.set(b.truckId!, list)
  }

  for (const [truckId, group] of Array.from(byTruck.entries())) {
    if (group.length < 2) continue
    // Bookings involved in any conflict, bucketed by the ET day they collide on.
    const byDay = new Map<string, Map<string, RuleBooking>>()
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j]
        if (!truckConflictBetween(toTruckShape(a), toTruckShape(b))) continue
        const basisA = basisOf(a)!, basisB = basisOf(b)!
        const day = etDayKey(basisA.getTime() <= basisB.getTime() ? basisA : basisB)
        const bucket = byDay.get(day) ?? new Map<string, RuleBooking>()
        bucket.set(a.id, a)
        bucket.set(b.id, b)
        byDay.set(day, bucket)
      }
    }
    for (const [day, bucket] of Array.from(byDay.entries())) {
      const involved = Array.from(bucket.values())
      const starts = involved.map((b) => basisOf(b)!).sort((x, y) => x.getTime() - y.getTime())
      // Name each booking with its hold kind, so "one of these is not paid for
      // yet" is visible without opening both records (R2-2).
      const names = involved
        .map((b) => (isPendingTruckHold(b.status) ? `${b.customerName} (unpaid hold)` : b.customerName))
        .join(', ')
      const pending = involved.filter((b) => isPendingTruckHold(b.status)).length
      const tail =
        pending === involved.length
          ? ' None of them is paid or approved yet — if one is going to fall through, release its truck now.'
          : pending > 0
            ? ' One of them is only an unpaid hold — release it or confirm it.'
            : ''
      out.push({
        reminderType: 'truck-double-booked', category: 'JOBS_SCHEDULING', severity: 'CRITICAL',
        title: `Truck double-booked: ${involved.length} jobs share one truck on ${day}`,
        description: `${names} are all assigned the same truck with overlapping (or unknown) move windows on ${day}. A truck can only be in one place — reassign a truck or reschedule a job.${tail}`,
        sourceEntityType: 'truck', sourceEntityId: truckId, sourceUrl: '/admin/trucks',
        dedupeKey: key('truck-double-booked', 'truck', truckId, day), dueAt: starts[0],
      })
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

// Self-abandoned booking-form leads (a Step-1 email left behind) are worked as a
// browseable segment on the Leads page — not surfaced as individual "call them
// back" owner reminders, which would flood the Action Center with tire-kickers.
const PARTIAL_BOOKING_LIFECYCLES = new Set(['PARTIAL', 'IN_PROGRESS', 'ABANDONED'])

export function evaluateLeads(leads: RuleLead[], now: Date): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  for (const l of leads) {
    const isPartialBooking = !!l.lifecycle && PARTIAL_BOOKING_LIFECYCLES.has(l.lifecycle)
    if (!isPartialBooking && l.status === 'NEW' && now.getTime() - l.createdAt.getTime() > DAY) {
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
    ...evaluateTruckOverlaps(input.bookings, now),
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
