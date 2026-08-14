import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approveBooking,
  type ApprovableBooking,
  type ApprovalDeps,
  type ApprovalStore,
  type CapturedIntent,
  type CommitArgs,
} from '../booking-approval'
import {
  AdminBookingSchema,
  buildBookingCreateData,
  findAdminTruckConflicts,
  resolveMoveSchedule,
  type AdminBookingInput,
} from '../admin-booking'
import {
  calculateEndTime,
  confirmationScheduleData,
  etDateTimeToInstant,
  formatEastern,
  formatEasternDate,
  formatMoveWhen,
} from '../scheduling'
import { computeEstimate } from '../estimate'
import { evaluateBooking, type RuleBooking } from '../reminder-rules'
import { moveTimeIsKnown } from '../email-eligibility'
import { moveTimeLabel } from '../../outbox/services/premiumEmails'
import type { TruckBookingShape } from '../truck-conflicts'

// ════════════════════════════════════════════════════════════════════════════
//  ITEM R2-1 — a day-level booking must NEVER acquire a fabricated start time.
//
//  THE DEFECT THESE TESTS EXIST TO CATCH (round 1 shipped it):
//  An admin booking taken without a crew start time stores requestedDate =
//  00:00 ET — a DAY ANCHOR. At approval, confirmationScheduleData() did
//      start = scheduledStart ?? confirmedDate ?? requestedDate
//  and promoted that anchor into scheduledStart, so the job landed at 12:00 AM
//  ET. The expensive consequence is NOT the wrong label: truck-conflicts.ts
//  compares two KNOWN start times as an interval, so a job promoted to 00:00
//  held only 00:00–06:00 ET and an 8 AM job on the same truck the same day
//  sailed through — the conservative "same ET day, unknown time ⇒ conflict"
//  double-booking guard evaporated at the moment of approval.
//
//  EVERY test below runs the REAL shipped functions on the DEFAULT owner path
//  (deposit mode `stripe_link` → PENDING_PAYMENT → approveBooking), and each
//  one FAILS if the promotion comes back. Nothing here hand-builds a schedule
//  the route cannot produce.
// ════════════════════════════════════════════════════════════════════════════

const HELPERS = { toInstant: etDateTimeToInstant, endTime: calculateEndTime }
/** A winter (EST, UTC-5) and a summer (EDT, UTC-4) move date, so every
 *  assertion below is proven on both sides of the DST boundary. */
const EST_DAY = '2027-01-15'
const EDT_DAY = '2027-07-15'

// ── The DEFAULT admin payload, straight through the real zod schema ──────────

function adminPayload(over: { startTime?: string; moveDate?: string } = {}): AdminBookingInput {
  const body = {
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100' },
    move: {
      serviceType: '2br',
      moveDate: over.moveDate ?? EDT_DAY,
      // The whole point: the owner leaves this blank on the phone.
      ...(over.startTime ? { startTime: over.startTime } : {}),
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    // THE DEFAULT deposit mode — the booking is created PENDING_PAYMENT with no
    // Job, and its schedule columns are written days later by approveBooking.
    deposit: { mode: 'stripe_link' },
    pricing: { ownerTotal: 700, overrideReason: 'phone quote' },
  }
  const parsed = AdminBookingSchema.safeParse(body)
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  return parsed.data
}

/** The exact Booking row POST /api/admin/bookings writes for this payload,
 *  built by the REAL buildBookingCreateData through the REAL resolveMoveSchedule
 *  — so a test can never assert a shape the route cannot produce. */
function createdBookingRow(over: { startTime?: string; moveDate?: string } = {}) {
  const input = adminPayload(over)
  const schedule = resolveMoveSchedule(input.move, { estimatedHours: 4, helpers: HELPERS })
  assert.ok(schedule.requestedDate, 'the move date must resolve')
  const data = buildBookingCreateData(
    input,
    {
      estimate: computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1001',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  return { input, schedule, data }
}

// ── Approval harness: the fake store mirrors prismaApprovalStore.claimConfirm
//    exactly ({ status, depositPaid, ...sched }), so what this test observes is
//    what the UPDATE would write. ─────────────────────────────────────────────

function harness(initial: ApprovableBooking) {
  const state = { booking: { ...initial }, commits: [] as CommitArgs[] }
  const store: ApprovalStore = {
    async loadBooking() {
      return { ...state.booking }
    },
    async claimConfirm(_id, sched) {
      if (state.booking.status !== 'PENDING_APPROVAL') return 0
      // Byte-for-byte the production write.
      state.booking = { ...state.booking, status: 'CONFIRMED', ...(sched ?? {}) }
      return 1
    },
    async rollbackClaim() {},
    async reloadStatus() {
      return { ...state.booking }
    },
    async commitApproval(args) {
      state.commits.push(args)
    },
    async claimCancel() {
      return 0
    },
    async recordDecline() {},
  }
  const notifications: Array<{ booking: ApprovableBooking }> = []
  const deps: ApprovalDeps = {
    store,
    stripe: {
      async capture(id): Promise<CapturedIntent> {
        return { id, amount_received: 4900, metadata: {} }
      },
      async retrieveCharge() {
        return { id: 'ch_1', receipt_url: 'https://receipt', payment_method_details: { type: 'card' } }
      },
      async releaseHold() {},
    },
    notifier: {
      async sendApproved(booking) {
        notifications.push({ booking })
      },
      async sendDeclined() {},
    },
    logger: { info() {}, warn() {}, error() {} } as unknown as ApprovalDeps['logger'],
  }
  return { state, deps, notifications }
}

/** The PENDING_APPROVAL row for a booking created by the admin route — every
 *  schedule-bearing field copied from what buildBookingCreateData produced. */
function pendingApproval(row: ReturnType<typeof createdBookingRow>['data']): ApprovableBooking {
  return {
    id: 'bk_1',
    status: 'PENDING_APPROVAL',
    stripePaymentIntentId: 'pi_1',
    depositAmount: 4900,
    displayId: 'WMIC-1001',
    customerToken: 'tok_1',
    itemsDescription: (row.itemsDescription as string) ?? null,
    arrivalWindow: null,
    totalEstimate: 700,
    originAddress: (row.originAddress as string) ?? null,
    destAddress: (row.destAddress as string) ?? null,
    serviceAreaZone: 'primary',
    travelFee: 0,
    manualReviewRequired: false,
    // stripe_link creates PENDING_PAYMENT, so the schedule columns are exactly
    // these: a requested date and nothing else.
    requestedDate: (row.requestedDate as Date) ?? null,
    confirmedDate: null,
    scheduledStart: null,
    scheduledEnd: null,
    startTimeKnown: row.startTimeKnown as boolean,
    estimatedHours: 4,
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
  }
}

async function approveCreated(over: { startTime?: string; moveDate?: string } = {}) {
  const created = createdBookingRow(over)
  const h = harness(pendingApproval(created.data))
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego' }, source: 'admin', notify: true }, h.deps)
  assert.ok(res.ok, 'approval must succeed')
  return { created, approved: h.state.booking, notifications: h.notifications }
}

// ── 1. THE GUARANTEE: no start time survives approval as midnight ────────────

test('R2-1: a day-level booking still has scheduledStart null AFTER approval (EDT)', async () => {
  const { created, approved } = await approveCreated()

  // The create recorded the absence rather than leaving an ambiguous null.
  assert.equal(created.schedule.dayLevel, true)
  assert.equal(created.data.startTimeKnown, false)

  assert.equal(approved.status, 'CONFIRMED')
  // THE assertion. Round 1 wrote the 00:00 ET day anchor here.
  assert.equal(approved.scheduledStart, null, 'approval must not invent a start time')
  assert.equal(approved.scheduledEnd, null, 'no start ⇒ no end')
  // The day anchor is still recorded — the booking is confirmed for a DATE.
  assert.equal(approved.confirmedDate?.toISOString(), '2027-07-15T04:00:00.000Z')
})

test('R2-1: same guarantee in January (EST) — DST is not what saves us', async () => {
  const { approved } = await approveCreated({ moveDate: EST_DAY })
  assert.equal(approved.scheduledStart, null)
  assert.equal(approved.scheduledEnd, null)
  // 00:00 ET on 2027-01-15 is 05:00Z (UTC-5), vs 04:00Z in July (UTC-4).
  assert.equal(approved.confirmedDate?.toISOString(), '2027-01-15T05:00:00.000Z')
})

test('R2-1: a TIMED booking keeps its real start time through approval, both DST sides', async () => {
  const edt = await approveCreated({ startTime: '09:30' })
  assert.equal(edt.created.data.startTimeKnown, true)
  assert.equal(edt.approved.scheduledStart?.toISOString(), '2027-07-15T13:30:00.000Z') // 9:30 EDT
  assert.ok(edt.approved.scheduledEnd, 'a real start still derives an end')

  const est = await approveCreated({ startTime: '09:30', moveDate: EST_DAY })
  assert.equal(est.approved.scheduledStart?.toISOString(), '2027-01-15T14:30:00.000Z') // 9:30 EST
})

// ── 2. THE REGRESSION: the truck double-booking guard must survive approval ──

/** The candidate row the route's loader (`toTruckShapes`) produces for an
 *  already-approved booking: confirmedDate ?? requestedDate as the day key. */
function asTruckCandidate(b: { scheduledStart: Date | null; scheduledEnd: Date | null; confirmedDate: Date | null }): TruckBookingShape {
  return { id: 'bk_1', truckId: 'truck_1', scheduledStart: b.scheduledStart, scheduledEnd: b.scheduledEnd, confirmedDate: b.confirmedDate, status: 'CONFIRMED' }
}

test('R2-1: an APPROVED day-level booking still blocks an 8 AM job on the same truck', async () => {
  const { approved } = await approveCreated()
  const existing = asTruckCandidate(approved)

  // A second booking at 8:00 AM ET the same day, same truck — checked exactly
  // as POST /api/admin/bookings checks it.
  const eightAm = etDateTimeToInstant(EDT_DAY, '08:00')
  assert.ok(eightAm)
  const conflicts = findAdminTruckConflicts([existing], {
    truckId: 'truck_1',
    scheduledStart: eightAm,
    scheduledEnd: calculateEndTime(eightAm, 4),
    moveDay: eightAm,
  })

  // With the defect, `existing.scheduledStart` is 00:00 ET and the check
  // degrades to an interval compare: 00:00–06:00 vs 08:00–13:00 ⇒ NO conflict,
  // and the truck is silently double-booked.
  assert.equal(conflicts.length, 1, 'the day-level booking must still hold the whole day')
  assert.equal(conflicts[0].reason, 'same_day_unknown_times')
})

test('R2-1: the same guard holds in January, and a DIFFERENT day is still free', async () => {
  const { approved } = await approveCreated({ moveDate: EST_DAY })
  const existing = asTruckCandidate(approved)

  const sameDay8am = etDateTimeToInstant(EST_DAY, '08:00')!
  assert.equal(
    findAdminTruckConflicts([existing], { truckId: 'truck_1', scheduledStart: sameDay8am, scheduledEnd: null, moveDay: sameDay8am }).length,
    1,
  )

  // Conservatism must not become paranoia: the next day is free.
  const nextDay8am = etDateTimeToInstant('2027-01-16', '08:00')!
  assert.equal(
    findAdminTruckConflicts([existing], { truckId: 'truck_1', scheduledStart: nextDay8am, scheduledEnd: null, moveDay: nextDay8am }).length,
    0,
  )
})

test('R2-1: two day-level bookings on the same truck and day conflict both ways', async () => {
  const { approved } = await approveCreated()
  const existing = asTruckCandidate(approved)
  const anotherDayLevel = createdBookingRow()
  const conflicts = findAdminTruckConflicts([existing], {
    truckId: 'truck_1',
    scheduledStart: null,
    moveDay: anotherDayLevel.schedule.requestedDate,
  })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].reason, 'same_day_unknown_times')
})

// ── 3. confirmationScheduleData directly (the promotion site) ────────────────

test('R2-1: confirmationScheduleData never invents a start when startTimeKnown is false', () => {
  const anchor = etDateTimeToInstant(EDT_DAY, '00:00')!
  const out = confirmationScheduleData({ requestedDate: anchor, estimatedHours: 4, startTimeKnown: false })
  assert.ok(out)
  assert.equal(out.scheduledStart, null)
  assert.equal(out.scheduledEnd, null)
  assert.equal(out.confirmedDate.toISOString(), anchor.toISOString())
})

test('R2-1: an admin who LATER set a real start keeps it, flag notwithstanding', () => {
  const anchor = etDateTimeToInstant(EDT_DAY, '00:00')!
  const real = etDateTimeToInstant(EDT_DAY, '09:00')!
  const out = confirmationScheduleData({ requestedDate: anchor, scheduledStart: real, estimatedHours: 4, startTimeKnown: false })
  assert.equal(out?.scheduledStart?.toISOString(), real.toISOString())
  assert.ok(out?.scheduledEnd, 'a real start still derives an end')
})

test('R2-1: FAIL-SOFT — an unreadable/absent startTimeKnown keeps the legacy behavior', () => {
  // The code-before-SQL deploy window (migration 20260812010000 unapplied) and
  // every legacy row: `undefined` must behave exactly as it did before, so this
  // column can never retroactively de-schedule a real job.
  const anchor = etDateTimeToInstant(EDT_DAY, '07:00')!
  const legacy = confirmationScheduleData({ requestedDate: anchor, estimatedHours: 3 })
  assert.equal(legacy?.scheduledStart?.toISOString(), anchor.toISOString())
  const explicitTrue = confirmationScheduleData({ requestedDate: anchor, estimatedHours: 3, startTimeKnown: true })
  assert.equal(explicitTrue?.scheduledStart?.toISOString(), anchor.toISOString())
})

// ── 4. Downstream: nothing prints midnight ───────────────────────────────────

test('R2-1: the approval notification says the DATE, not 12:00 AM', async () => {
  const { approved, notifications } = await approveCreated()
  assert.equal(notifications.length, 1)
  const notified = notifications[0].booking

  // The notifier formats `requestedDate` — which for a day-level booking IS the
  // 00:00 ET anchor — through formatMoveWhen.
  const printed = formatMoveWhen(notified.requestedDate!, notified.startTimeKnown)
  assert.equal(printed, 'Thursday, July 15, 2027')
  assert.ok(!/\d{1,2}:\d{2}/.test(printed), 'no time of day may appear')
  // What it USED to print, and what a timed booking still legitimately prints.
  assert.match(formatEastern(notified.requestedDate!), /12:00\s?AM/)
  assert.equal(approved.scheduledStart, null)

  const timed = await approveCreated({ startTime: '09:30' })
  const timedBooking = timed.notifications[0].booking
  assert.match(formatMoveWhen(timedBooking.requestedDate!, timedBooking.startTimeKnown), /9:30\s?AM/)
})

test('R2-1: formatEasternDate is formatEastern minus the invented hour', () => {
  const anchor = etDateTimeToInstant(EST_DAY, '00:00')!
  assert.equal(formatEasternDate(anchor), 'Friday, January 15, 2027')
  assert.match(formatEastern(anchor), /^Friday, January 15, 2027/)
})

test('R2-1: the OUTBOX confirmation email carries "time to be confirmed", not midnight', () => {
  // src/outbox/services/premiumEmails renders `timeOnly = timeLabel || <hour
  // out of `date`>`, and `date` for a day-level booking is the 00:00 ET anchor.
  // Without a timeLabel the customer was told their move is at 12:00 AM.
  assert.equal(moveTimeLabel({ arrivalWindow: null, scheduledStart: null, startTimeKnown: false }, 'en'), 'Time to be confirmed')
  assert.equal(moveTimeLabel({ arrivalWindow: null, scheduledStart: null, startTimeKnown: false }, 'es'), 'Hora por confirmar')
  // An arrival window the owner actually typed always wins.
  assert.equal(moveTimeLabel({ arrivalWindow: '8:00–10:00 AM', scheduledStart: null, startTimeKnown: false }, 'en'), '8:00–10:00 AM')
  // A real hour (or a legacy/unreadable flag) renders exactly as before.
  assert.equal(moveTimeLabel({ arrivalWindow: null, scheduledStart: new Date(), startTimeKnown: false }, 'en'), undefined)
  assert.equal(moveTimeLabel({ arrivalWindow: null, scheduledStart: null, startTimeKnown: true }, 'en'), undefined)
  assert.equal(moveTimeLabel({ arrivalWindow: null, scheduledStart: null }, 'en'), undefined)
  // A reschedule to a customer-picked instant keeps its own hour.
  assert.equal(moveTimeLabel({ arrivalWindow: null, scheduledStart: null, startTimeKnown: false }, 'en', true), undefined)
})

test('R2-1: moveTimeIsKnown — a stored start is proof, an absent flag is not a denial', () => {
  const t = new Date('2027-07-15T13:30:00.000Z')
  assert.equal(moveTimeIsKnown({ scheduledStart: null, startTimeKnown: false }), false)
  assert.equal(moveTimeIsKnown({ scheduledStart: t, startTimeKnown: false }), true)
  assert.equal(moveTimeIsKnown({ scheduledStart: null, startTimeKnown: true }), true)
  assert.equal(moveTimeIsKnown({ scheduledStart: null }), true)
})

// ── 5. Action Center copy ────────────────────────────────────────────────────

const RULE_NOW = new Date('2027-07-12T12:00:00-04:00')

function ruleBooking(over: Partial<RuleBooking> = {}): RuleBooking {
  return {
    id: 'b1', displayId: 'WMIC-1001', status: 'CONFIRMED',
    customerName: 'Maria Lopez', customerPhone: '(973) 555-0100', customerEmail: 'maria@example.com',
    originAddress: '12 Main St, Newark, NJ', destAddress: '99 Oak Ave, Montclair, NJ',
    originVerification: 'verified', destVerification: 'verified', manualReviewRequired: false,
    agreementAccepted: true, totalEstimate: 700,
    scheduledStart: null, scheduledEnd: null,
    requestedDate: etDateTimeToInstant(EDT_DAY, '00:00'),
    confirmedDate: etDateTimeToInstant(EDT_DAY, '00:00'),
    completedAt: null,
    truckAddonDueOnMoveDay: false, truckProvider: null, truckReservationStatus: null, truckReservationNumber: null,
    jobStartedAt: null, crew: [], hasFailedPayment: false, hasWorkerPayExpense: false,
    outstandingBalanceCents: 0, netRevenueCents: 70000, netProfitCents: 40000,
    ...over,
  }
}

test('R2-1: no Action Center reminder prints "12:00 AM" for a day-level move', () => {
  const cands = evaluateBooking(ruleBooking({ startTimeKnown: false }), RULE_NOW)
  assert.ok(cands.length > 0, 'the day-level booking should still raise something')
  for (const c of cands) {
    assert.ok(!/12:00\s?AM/.test(c.description), `"${c.reminderType}" printed midnight: ${c.description}`)
    assert.ok(!/12:00\s?AM/.test(c.title), `"${c.reminderType}" printed midnight in its title`)
  }
})

test('R2-1: job-no-start-time distinguishes day-level-by-choice from a real gap', () => {
  const dayLevel = evaluateBooking(ruleBooking({ startTimeKnown: false }), RULE_NOW)
    .find((c) => c.reminderType === 'job-no-start-time')
  assert.ok(dayLevel, 'a day-level confirmed job is still surfaced')
  assert.equal(dayLevel.severity, 'MEDIUM')
  // The old copy claimed the booking was invisible to the calendar and digest.
  // moveDateInRange coalesces to confirmedDate, so that was never true.
  assert.ok(!/invisible/i.test(dayLevel.description), 'must not claim the booking is invisible')
  assert.match(dayLevel.description, /DAY level/)

  // A confirmed booking that should have a time and does not is still HIGH.
  const gap = evaluateBooking(ruleBooking({ startTimeKnown: true }), RULE_NOW)
    .find((c) => c.reminderType === 'job-no-start-time')
  assert.ok(gap)
  assert.equal(gap.severity, 'HIGH')
  assert.ok(!/invisible/i.test(gap.description))
  // Same dedupeKey either way — one reminder, not two.
  assert.equal(gap.dedupeKey, dayLevel.dedupeKey)
})

test('R2-1: a booking with a REAL start time still prints its hour in the copy', () => {
  const start = etDateTimeToInstant(EDT_DAY, '09:30')!
  const cands = evaluateBooking(
    ruleBooking({ status: 'CONFIRMED', scheduledStart: start, startTimeKnown: true, originAddress: '' }),
    RULE_NOW,
  )
  const hit = cands.find((c) => c.reminderType === 'booking-missing-address')
  assert.ok(hit)
  assert.match(hit.description, /9:30\s?AM/, 'a known hour must still be shown')
})
