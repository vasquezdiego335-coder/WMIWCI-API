import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AdminBookingSchema,
  addressColumnValues,
  addressNeedsReview,
  adminPortalTokenExpiry,
  bedroomsFromServiceType,
  buildBookingCreateData,
  buildStaffingRequirementData,
  collectBookingWarnings,
  composeAddress,
  decideStatus,
  deriveMoveDetails,
  findAdminTruckConflicts,
  requiresOverrideReason,
  resolveCustomerMutation,
  resolveInventorySnapshots,
  resolveMoveSchedule,
  splitStreetLine,
  synthesizePlaceholderEmail,
  type AdminBookingInput,
  type CatalogSnapshotSource,
  type InventorySnapshot,
} from '../admin-booking'
import { computeEstimate } from '../estimate'
// The REAL ET helpers the route injects — so the DST assertions below test the
// exact conversion production performs, not a re-implementation.
import { calculateEndTime, etDateTimeToInstant } from '../scheduling'
import { findTruckConflictsIn, type TruckBookingShape } from '../truck-conflicts'
import type { VerifiedAddress } from '../address-verify'

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A future ISO date (UTC-derived, which is never behind the ET calendar day,
 *  so it always passes the >= today-ET refinement). */
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const PAST = '2020-01-15'

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer: { name: 'Dana Mover', email: 'dana@example.com', phone: '862-640-0625' },
    move: {
      serviceType: '2br',
      moveDate: FUTURE,
      originAddress: { street: '12 Main St', city: 'West Orange', zip: '07052' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
      originPropertyType: 'apartment',
      destPropertyType: 'house',
      destStairFlights: 2,
      coiRequired: true,
    },
    services: { serviceMode: 'full_service', needsDisassembly: true },
    inventory: [{ name: 'Couch (3-seat)', quantity: 1 }],
    pricing: { ownerTotal: 700, overrideReason: 'matched competitor quote' },
    deposit: { mode: 'stripe_link' },
    ...overrides,
  }
}

function parsed(overrides: Record<string, unknown> = {}): AdminBookingInput {
  const res = AdminBookingSchema.safeParse(validBody(overrides))
  assert.ok(res.success, `expected valid input: ${!res.success ? JSON.stringify(res.error.flatten()) : ''}`)
  return res.data
}

// ── Zod schema ───────────────────────────────────────────────────────────────

test('schema: accepts a full valid body and applies defaults', () => {
  const d = parsed()
  // locale is deliberately NOT defaulted (R2-7.1): a default made every
  // submission look like the owner had chosen English, and the customer write
  // then flipped a Spanish-speaking repeat customer's emails to English. Absent
  // means "no language stated"; the 'en' default now applies only when a NEW
  // customer row is created. Covered by admin-customer-locale.test.ts.
  assert.equal(d.customer.locale, undefined)
  assert.equal(d.move.originAddress.state, 'NJ') // defaulted
  assert.equal(d.inventory[0].quantity, 1)
  assert.equal(d.truckConflictOverride, false)
  assert.equal(d.services.needsPacking, false) // defaulted boolean
})

test('schema: email OR phone — neither is rejected, either alone accepted', () => {
  const neither = AdminBookingSchema.safeParse(
    validBody({ customer: { name: 'X' } }),
  )
  assert.equal(neither.success, false)

  const emailOnly = AdminBookingSchema.safeParse(
    validBody({ customer: { name: 'X', email: 'x@example.com' } }),
  )
  assert.equal(emailOnly.success, true)

  const phoneOnly = AdminBookingSchema.safeParse(
    validBody({ customer: { name: 'X', phone: '973 555 0100' } }),
  )
  assert.equal(phoneOnly.success, true)
})

test('schema: an empty-string email is treated as absent, not invalid', () => {
  const res = AdminBookingSchema.safeParse(
    validBody({ customer: { name: 'X', email: '', phone: '973 555 0100' } }),
  )
  assert.equal(res.success, true)
  assert.ok(res.success && res.data.customer.email === undefined)
})

test('schema: a past move date is refused', () => {
  const res = AdminBookingSchema.safeParse(
    validBody({
      move: { ...(validBody().move as Record<string, unknown>), moveDate: PAST },
    }),
  )
  assert.equal(res.success, false)
})

test('schema: unknown serviceType refused; not-sure accepted', () => {
  const bad = AdminBookingSchema.safeParse(
    validBody({ move: { ...(validBody().move as Record<string, unknown>), serviceType: 'mansion' } }),
  )
  assert.equal(bad.success, false)
  const notSure = AdminBookingSchema.safeParse(
    validBody({ move: { ...(validBody().move as Record<string, unknown>), serviceType: 'not-sure' } }),
  )
  assert.equal(notSure.success, true)
})

test('schema: quantity bounds 1..99 enforced', () => {
  const zero = AdminBookingSchema.safeParse(validBody({ inventory: [{ name: 'Box', quantity: 0 }] }))
  assert.equal(zero.success, false)
  const hundred = AdminBookingSchema.safeParse(validBody({ inventory: [{ name: 'Box', quantity: 100 }] }))
  assert.equal(hundred.success, false)
})

// ── Pure decisions ───────────────────────────────────────────────────────────

test('decideStatus: stripe_link → PENDING_PAYMENT; collect/waived → CONFIRMED', () => {
  assert.equal(decideStatus('stripe_link'), 'PENDING_PAYMENT')
  assert.equal(decideStatus('collect_on_day'), 'CONFIRMED')
  assert.equal(decideStatus('waived'), 'CONFIRMED')
})

test('requiresOverrideReason: > $1 from a real recommendation only', () => {
  const est = { hasService: true, estimatedTotal: 700 }
  assert.equal(requiresOverrideReason(650, est), true)
  assert.equal(requiresOverrideReason(700, est), false)
  assert.equal(requiresOverrideReason(700.99, est), false) // within $1
  assert.equal(requiresOverrideReason(702, est), true)
  // 'not-sure' → no recommendation → nothing to differ from.
  assert.equal(requiresOverrideReason(999, { hasService: false, estimatedTotal: 0 }), false)
})

test('synthesizePlaceholderEmail: digits-only local part on the reserved .invalid TLD', () => {
  assert.equal(synthesizePlaceholderEmail('(862) 640-0625'), 'no-email-8626400625@placeholder.invalid')
  assert.equal(synthesizePlaceholderEmail(''), 'no-email-unknown@placeholder.invalid')
})

test('composeAddress: "street, city, STATE zip"', () => {
  assert.equal(
    composeAddress({ street: '12 Main St', city: 'West Orange', state: 'NJ', zip: '07052' }),
    '12 Main St, West Orange, NJ 07052',
  )
})

test('bedroomsFromServiceType: nbr keys map, studios are 0, not-sure is null', () => {
  assert.equal(bedroomsFromServiceType('2br'), 2)
  assert.equal(bedroomsFromServiceType('5br'), 5)
  assert.equal(bedroomsFromServiceType('full-studio'), 0)
  assert.equal(bedroomsFromServiceType('not-sure'), null)
})

test('adminPortalTokenExpiry: max(move+3d, now+7d)', () => {
  const now = new Date('2026-08-12T12:00:00Z')
  // A move 30 days out → expiry rides the move date + 3d.
  const farMove = new Date('2026-09-11T11:00:00Z')
  assert.equal(
    adminPortalTokenExpiry(farMove, now).getTime(),
    farMove.getTime() + 3 * 24 * 60 * 60 * 1000,
  )
  // A move tomorrow → the now+7d floor wins.
  const soonMove = new Date('2026-08-13T11:00:00Z')
  assert.equal(
    adminPortalTokenExpiry(soonMove, now).getTime(),
    now.getTime() + 7 * 24 * 60 * 60 * 1000,
  )
  // No date at all → the floor.
  assert.equal(adminPortalTokenExpiry(null, now).getTime(), now.getTime() + 7 * 24 * 60 * 60 * 1000)
})

// ── Inventory snapshots ──────────────────────────────────────────────────────

test('resolveInventorySnapshots: catalog rows snapshot name + flags; custom lines stay honest', () => {
  const catalog = new Map<string, CatalogSnapshotSource>([
    ['cat1', { id: 'cat1', name: 'Piano (upright)', isHeavy: true, needsDisassembly: false, recommendedMovers: 4 }],
  ])
  const snaps = resolveInventorySnapshots(
    [
      { catalogItemId: 'cat1', name: 'typed-name-ignored', quantity: 1 },
      { name: 'Fish tank', quantity: 2 },
      { catalogItemId: 'gone', name: 'Old couch', quantity: 1 },
    ],
    catalog,
  )
  assert.equal(snaps[0].name, 'Piano (upright)') // catalog name wins
  assert.equal(snaps[0].isHeavy, true)
  assert.equal(snaps[0].recommendedMovers, 4)
  assert.equal(snaps[1].catalogItemId, null)
  assert.equal(snaps[1].isHeavy, false)
  assert.equal(snaps[2].catalogItemId, null) // vanished catalog id → custom line
  assert.equal(snaps[2].name, 'Old couch')
})

// ── buildBookingCreateData column mapping ────────────────────────────────────

function ctxFor(input: AdminBookingInput, travelFeeCents = 5000) {
  const estimate = computeEstimate({
    serviceType: input.move.serviceType,
    dropoffStairFlights: input.move.destStairFlights,
    travelFeeCents,
  })
  return {
    estimate,
    travel: { zone: 'extended_nj', travelFeeCents, message: 'extended NJ' },
    reference: 'WMIC-2001',
    tokenExpiry: new Date('2026-09-15T00:00:00Z'),
    requestedDate: new Date('2026-09-11T11:00:00Z'),
    estimatedHours: 6,
  }
}

test('buildBookingCreateData: address composition + money conventions', () => {
  const input = parsed()
  const ctx = ctxFor(input)
  const data = buildBookingCreateData(input, ctx, [])

  assert.equal(data.originAddress, '12 Main St, West Orange, NJ 07052')
  assert.equal(data.destAddress, '99 Oak Ave, Montclair, NJ 07042')
  assert.equal(data.bookingReference, 'WMIC-2001')
  assert.equal(data.displayId, 'WMIC-2001')
  // baseRate = estimatedTotal − travel (labor + access, never travel-inflated).
  assert.equal(data.baseRate, Math.round((ctx.estimate.estimatedTotal - ctx.estimate.travel) * 100) / 100)
  // totalEstimate is the OWNER's price, not the server's.
  assert.equal(data.totalEstimate, 700)
  assert.equal(data.depositAmount, 4900)
  assert.equal(data.depositPaid, false)
  assert.equal(data.travelFee, 5000)
  assert.equal(data.travelFeeDueOnMoveDay, true)
  assert.equal(data.source, 'admin')
  assert.equal(data.bedrooms, 2)
  assert.equal(data.customerTokenExpiry, ctx.tokenExpiry)
  assert.equal(data.requestedDate, ctx.requestedDate)
  assert.equal(data.estimatedHours, 6)
})

test('buildBookingCreateData: status follows the deposit mode', () => {
  const holds = parsed()
  assert.equal(buildBookingCreateData(holds, ctxFor(holds)).status, 'PENDING_PAYMENT')
  const collect = parsed({ deposit: { mode: 'collect_on_day' } })
  assert.equal(buildBookingCreateData(collect, ctxFor(collect)).status, 'CONFIRMED')
  const waived = parsed({ deposit: { mode: 'waived' } })
  assert.equal(buildBookingCreateData(waived, ctxFor(waived)).status, 'CONFIRMED')
})

test('buildBookingCreateData: Phase-1 columns land (truck/mode/COI/property types)', () => {
  const input = parsed({ truckId: 'truck_1' })
  const data = buildBookingCreateData(input, ctxFor(input))
  assert.equal(data.truckId, 'truck_1')
  assert.equal(data.serviceMode, 'full_service')
  assert.equal(data.coiRequired, true)
  assert.equal(data.originPropertyType, 'apartment')
  assert.equal(data.destPropertyType, 'house')
  assert.equal(data.originStairCount, null) // origin had none
  assert.equal(data.destStairCount, 2)
})

test('buildBookingCreateData: priceOverrideReason stored only when the price actually differs', () => {
  const overridden = parsed() // $700 vs 2br estimate + stairs + $50 travel → differs
  const ctx = ctxFor(overridden)
  assert.notEqual(Math.abs(700 - ctx.estimate.estimatedTotal) <= 1, true, 'fixture should differ from the estimate')
  assert.equal(buildBookingCreateData(overridden, ctx).priceOverrideReason, 'matched competitor quote')

  const matching = parsed({ pricing: { ownerTotal: ctx.estimate.estimatedTotal, overrideReason: 'ignored' } })
  assert.equal(buildBookingCreateData(matching, ctxFor(matching)).priceOverrideReason, null)
})

// ── Staffing requirement derivation ──────────────────────────────────────────

test('buildStaffingRequirementData: crew → required/min workers + flags from inputs+inventory', () => {
  const input = parsed()
  const startAt = new Date('2026-09-11T11:00:00Z')
  const snaps = resolveInventorySnapshots(
    [{ catalogItemId: 'w', name: 'Washer', quantity: 1 }],
    new Map([['w', { id: 'w', name: 'Washer', isHeavy: true, needsDisassembly: false, recommendedMovers: 2 }]]),
  )
  const req = buildStaffingRequirementData({ crewSize: 3, estimatedHoursMax: 6 }, input, snaps, startAt)
  assert.equal(req.requiredWorkers, 3)
  assert.equal(req.minWorkers, 2) // max(2, 3-1)
  assert.equal(req.requiredDrivers, 1)
  assert.equal(req.requiresLead, true)
  assert.equal(req.hasStairs, true) // destStairFlights 2
  assert.equal(req.hasElevator, false)
  assert.equal(req.heavyItems, true) // washer snapshot
  assert.equal(req.assembly, true) // services.needsDisassembly
  assert.equal(req.packing, false)
  assert.equal(req.estimatedStartAt, startAt)

  const big = buildStaffingRequirementData({ crewSize: 5, estimatedHoursMax: 9 }, input, [], startAt)
  assert.equal(big.minWorkers, 4)
  const small = buildStaffingRequirementData({ crewSize: 2, estimatedHoursMax: 3 }, input, [], startAt)
  assert.equal(small.minWorkers, 2) // floor of 2
})

// ── Warnings ─────────────────────────────────────────────────────────────────

test('collectBookingWarnings: empty inventory / review zone / not-sure / truck override', () => {
  const all = collectBookingWarnings({
    inventoryCount: 0,
    zone: 'manual_review',
    serviceType: 'not-sure',
    truckOverrideUsed: true,
  })
  assert.equal(all.length, 4)

  const none = collectBookingWarnings({
    inventoryCount: 3,
    zone: 'primary',
    serviceType: '2br',
    truckOverrideUsed: false,
  })
  assert.deepEqual(none, [])
})

// ════════════════════════════════════════════════════════════════════════════
//  ITEM 2 — no invented 7:00 AM start; capture a real time
// ════════════════════════════════════════════════════════════════════════════

/** The helper pair the route injects (src/lib/scheduling.ts). */
const ET = { toInstant: etDateTimeToInstant, endTime: calculateEndTime }

test('schema: startTime is optional, 24h, and zero-padded; junk is refused', () => {
  const withTime = parsed({
    move: { ...(validBody().move as Record<string, unknown>), startTime: '08:30' },
  })
  assert.equal(withTime.move.startTime, '08:30')

  // A single-digit hour normalises so '9:05' and '09:05' store identically.
  const padded = parsed({
    move: { ...(validBody().move as Record<string, unknown>), startTime: '9:05' },
  })
  assert.equal(padded.move.startTime, '09:05')

  // Absent / empty = "not captured", never midnight.
  assert.equal(parsed().move.startTime, undefined)
  const blank = parsed({ move: { ...(validBody().move as Record<string, unknown>), startTime: '' } })
  assert.equal(blank.move.startTime, undefined)

  for (const bad of ['25:00', '08:60', '8', '8:5', 'morning', '8:30 AM']) {
    const res = AdminBookingSchema.safeParse(
      validBody({ move: { ...(validBody().move as Record<string, unknown>), startTime: bad } }),
    )
    assert.equal(res.success, false, `expected ${bad} to be refused`)
  }
})

test('resolveMoveSchedule: a start time becomes the correct UTC instant in EST and EDT', () => {
  // 15 Jan 2027 is EST (UTC-5): 08:30 ET = 13:30Z.
  const winter = resolveMoveSchedule({ moveDate: '2027-01-15', startTime: '08:30' }, { estimatedHours: 6, helpers: ET })
  assert.equal(winter.dayLevel, false)
  assert.equal(winter.startTime, '08:30')
  assert.equal(winter.scheduledStart?.toISOString(), '2027-01-15T13:30:00.000Z')
  assert.equal(winter.requestedDate?.toISOString(), '2027-01-15T13:30:00.000Z')

  // 15 Jul 2027 is EDT (UTC-4): the SAME wall clock is 12:30Z. A hand-rolled
  // fixed offset would put one of these an hour out.
  const summer = resolveMoveSchedule({ moveDate: '2027-07-15', startTime: '08:30' }, { estimatedHours: 6, helpers: ET })
  assert.equal(summer.scheduledStart?.toISOString(), '2027-07-15T12:30:00.000Z')
})

test('resolveMoveSchedule: scheduledEnd is start + the plan hours + the house buffer', () => {
  const sched = resolveMoveSchedule({ moveDate: '2027-07-15', startTime: '08:30' }, { estimatedHours: 6, helpers: ET })
  const start = sched.scheduledStart!
  // calculateEndTime adds TRAVEL_BUFFER_MINUTES (60 by default) after the job.
  assert.equal(sched.scheduledEnd!.getTime() - start.getTime(), (6 * 60 + 60) * 60_000)
  assert.equal(sched.scheduledEnd!.getTime(), calculateEndTime(start, 6).getTime())

  // No plan hours → no invented job length; the truck lib's fallback window
  // holds the truck instead.
  const noHours = resolveMoveSchedule({ moveDate: '2027-07-15', startTime: '08:30' }, { helpers: ET })
  assert.equal(noHours.scheduledEnd, null)
})

test('resolveMoveSchedule: no start time → day-level, and never a default hour', () => {
  const sched = resolveMoveSchedule({ moveDate: '2027-07-15' }, { estimatedHours: 6, helpers: ET })
  assert.equal(sched.dayLevel, true)
  assert.equal(sched.scheduledStart, null)
  assert.equal(sched.scheduledEnd, null)
  assert.equal(sched.startTime, null)
  // The anchor is 00:00 ET (the day boundary), NOT 07:00 — the old hidden
  // default would have produced 2027-07-15T11:00:00.000Z.
  assert.equal(sched.requestedDate?.toISOString(), '2027-07-15T04:00:00.000Z')
  assert.notEqual(sched.requestedDate?.toISOString(), '2027-07-15T11:00:00.000Z')

  const winter = resolveMoveSchedule({ moveDate: '2027-01-15' }, { helpers: ET })
  assert.equal(winter.requestedDate?.toISOString(), '2027-01-15T05:00:00.000Z')

  // An unparseable date yields nothing at all (the route answers 422).
  const bad = resolveMoveSchedule({ moveDate: 'nope', startTime: '08:30' }, { helpers: ET })
  assert.equal(bad.requestedDate, null)
})

test('resolveMoveSchedule: an arrival window alone NEVER produces a timestamp', () => {
  const input = parsed({
    move: {
      ...(validBody().move as Record<string, unknown>),
      arrivalWindow: '8:00-10:00 AM',
    },
  })
  assert.equal(input.move.arrivalWindow, '8:00-10:00 AM')
  assert.equal(input.move.startTime, undefined)
  const sched = resolveMoveSchedule(input.move, { estimatedHours: 6, helpers: ET })
  assert.equal(sched.scheduledStart, null)
  assert.equal(sched.dayLevel, true)
})

test('buildBookingCreateData: schedule columns follow the captured time, not a default', () => {
  const timedInput = parsed({
    deposit: { mode: 'collect_on_day' },
    move: { ...(validBody().move as Record<string, unknown>), startTime: '08:30' },
  })
  const timed = resolveMoveSchedule(timedInput.move, { estimatedHours: 6, helpers: ET })
  const timedData = buildBookingCreateData(timedInput, {
    ...ctxFor(timedInput),
    requestedDate: timed.requestedDate!,
    schedule: timed,
  })
  assert.equal(timedData.status, 'CONFIRMED')
  assert.equal((timedData.scheduledStart as Date).getTime(), timed.scheduledStart!.getTime())
  assert.equal((timedData.scheduledEnd as Date).getTime(), timed.scheduledEnd!.getTime())
  assert.equal((timedData.confirmedDate as Date).getTime(), timed.requestedDate!.getTime())

  // Day-level CONFIRMED booking: confirmedDate only — the schedule views read
  // it by day and no clock time is claimed.
  const dayInput = parsed({ deposit: { mode: 'collect_on_day' } })
  const day = resolveMoveSchedule(dayInput.move, { estimatedHours: 6, helpers: ET })
  const dayData = buildBookingCreateData(dayInput, {
    ...ctxFor(dayInput),
    requestedDate: day.requestedDate!,
    schedule: day,
  })
  assert.equal(dayData.scheduledStart, null)
  assert.equal(dayData.scheduledEnd, null)
  assert.equal((dayData.confirmedDate as Date).getTime(), day.requestedDate!.getTime())

  // A stripe_link booking is not scheduled at all until the hold is paid.
  const pending = parsed({ move: { ...(validBody().move as Record<string, unknown>), startTime: '08:30' } })
  const pendingSched = resolveMoveSchedule(pending.move, { estimatedHours: 6, helpers: ET })
  const pendingData = buildBookingCreateData(pending, {
    ...ctxFor(pending),
    requestedDate: pendingSched.requestedDate!,
    schedule: pendingSched,
  })
  assert.equal(pendingData.status, 'PENDING_PAYMENT')
  assert.equal(pendingData.scheduledStart, undefined)
  assert.equal(pendingData.confirmedDate, undefined)
  // …but the requested instant IS the owner's real start time.
  assert.equal((pendingData.requestedDate as Date).toISOString(), pendingSched.scheduledStart!.toISOString())
})

test('collectBookingWarnings: day-level scheduling is stated plainly', () => {
  const warned = collectBookingWarnings({
    inventoryCount: 2,
    zone: 'primary',
    serviceType: '2br',
    truckOverrideUsed: false,
    dayLevelScheduling: true,
  })
  assert.equal(warned.length, 1)
  assert.match(warned[0], /No crew start time/i)
  assert.match(warned[0], /day/i)

  const quiet = collectBookingWarnings({
    inventoryCount: 2,
    zone: 'primary',
    serviceType: '2br',
    truckOverrideUsed: false,
    dayLevelScheduling: false,
  })
  assert.deepEqual(quiet, [])
})

test('findAdminTruckConflicts: a day-level booking still holds the whole ET day', () => {
  const existing: TruckBookingShape[] = [
    {
      id: 'b1',
      truckId: 'truck_1',
      // 8 AM EDT job, 4 hours.
      scheduledStart: new Date('2027-07-15T12:00:00.000Z'),
      scheduledEnd: new Date('2027-07-15T16:00:00.000Z'),
      confirmedDate: null,
      status: 'CONFIRMED',
    },
  ]
  const day = resolveMoveSchedule({ moveDate: '2027-07-15' }, { helpers: ET })

  // The naive call (day anchor treated as a real 00:00 start) sees nothing —
  // this is exactly the miss findAdminTruckConflicts exists to prevent.
  assert.equal(
    findTruckConflictsIn(existing, { truckId: 'truck_1', start: day.requestedDate, end: null }).length,
    0,
  )

  const conflicts = findAdminTruckConflicts(existing, {
    truckId: 'truck_1',
    scheduledStart: day.scheduledStart,
    scheduledEnd: day.scheduledEnd,
    moveDay: day.requestedDate,
  })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].reason, 'same_day_unknown_times')

  // A timed booking keeps the precise interval check: 6 PM does not collide
  // with an 8 AM–12 PM job.
  const evening = resolveMoveSchedule({ moveDate: '2027-07-15', startTime: '18:00' }, { estimatedHours: 3, helpers: ET })
  assert.equal(
    findAdminTruckConflicts(existing, {
      truckId: 'truck_1',
      scheduledStart: evening.scheduledStart,
      scheduledEnd: evening.scheduledEnd,
      moveDay: evening.requestedDate,
    }).length,
    0,
  )

  // A different day never conflicts, and no truck means nothing to check.
  const otherDay = resolveMoveSchedule({ moveDate: '2027-07-16' }, { helpers: ET })
  assert.equal(
    findAdminTruckConflicts(existing, {
      truckId: 'truck_1',
      scheduledStart: null,
      scheduledEnd: null,
      moveDay: otherDay.requestedDate,
    }).length,
    0,
  )
  assert.equal(
    findAdminTruckConflicts(existing, { truckId: null, scheduledStart: null, scheduledEnd: null, moveDay: day.requestedDate }).length,
    0,
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  ITEM 3 — the picked customerId is preserved (no repeat-customer duplicates)
// ════════════════════════════════════════════════════════════════════════════

const DANA = { id: 'cust_dana', name: 'Dana Mover', email: 'dana@example.com', phone: '862-640-0625', locale: 'en' }
const OTHER = { id: 'cust_sam', name: 'Sam Other', email: 'sam@example.com', phone: '973-555-0100', locale: 'en' }

test('schema: customer.id is accepted and optional', () => {
  assert.equal(parsed().customer.id, undefined)
  const picked = parsed({
    customer: { id: 'cust_dana', name: 'Dana Mover', email: 'dana@example.com', phone: '862-640-0625' },
  })
  assert.equal(picked.customer.id, 'cust_dana')
})

test('resolveCustomerMutation: a picked customer with nothing new is used as-is', () => {
  const res = resolveCustomerMutation({
    pickedId: DANA.id,
    existing: DANA,
    emailOwner: DANA,
    submitted: { name: 'Dana Mover', email: 'DANA@example.com', phone: '862-640-0625', locale: 'en' },
    fallbackEmail: 'unused@placeholder.invalid',
  })
  assert.equal(res.mode, 'use')
  assert.equal(res.mode === 'use' && res.customerId, DANA.id)
})

test('resolveCustomerMutation: blank submissions never erase stored contact info', () => {
  const res = resolveCustomerMutation({
    pickedId: DANA.id,
    existing: DANA,
    emailOwner: null,
    // The owner cleared the email box and typed nothing in phone.
    submitted: { name: 'Dana Mover', email: '', phone: '   ', locale: 'en' },
    fallbackEmail: 'no-email-8626400625@placeholder.invalid',
  })
  assert.equal(res.mode, 'use')
  // Nothing at all is written — no blank email, no blank phone.
  assert.equal(JSON.stringify(res).includes('"email"'), false)
})

test('resolveCustomerMutation: a supplied value updates the PICKED record, with before/after', () => {
  const res = resolveCustomerMutation({
    pickedId: DANA.id,
    existing: { ...DANA, email: 'dana.old@example.com' },
    // Nobody else owns the new address.
    emailOwner: null,
    submitted: { name: 'Dana Mover-Smith', email: 'dana@example.com', phone: '862-640-0625', locale: 'es' },
    fallbackEmail: 'unused@placeholder.invalid',
  })
  assert.equal(res.mode, 'update')
  if (res.mode !== 'update') return
  assert.equal(res.customerId, DANA.id)
  assert.deepEqual(res.data, { name: 'Dana Mover-Smith', email: 'dana@example.com', locale: 'es' })
  assert.equal(res.before.email, 'dana.old@example.com')
  assert.equal(res.before.name, 'Dana Mover')
  // The unchanged phone is not rewritten.
  assert.equal('phone' in res.data, false)
})

test('resolveCustomerMutation: an email belonging to ANOTHER customer is a conflict, never a merge', () => {
  const res = resolveCustomerMutation({
    pickedId: DANA.id,
    existing: DANA,
    emailOwner: OTHER,
    submitted: { name: 'Dana Mover', email: 'sam@example.com', phone: '862-640-0625', locale: 'en' },
    fallbackEmail: 'unused@placeholder.invalid',
  })
  assert.equal(res.mode, 'conflict')
  if (res.mode !== 'conflict') return
  assert.equal(res.customerId, DANA.id)
  assert.equal(res.conflictingCustomerId, OTHER.id)
  assert.match(res.message, /already belongs to another customer/i)
  assert.match(res.message, /Sam Other/)
})

test('resolveCustomerMutation: the picked id always wins over email matching', () => {
  // The typed email is Sam's OWN address and Sam is the email owner, but the
  // owner picked Dana — so Dana is who this books under (and the clash is
  // refused rather than quietly booking Sam).
  const clash = resolveCustomerMutation({
    pickedId: DANA.id,
    existing: DANA,
    emailOwner: OTHER,
    submitted: { name: 'Dana Mover', email: OTHER.email, phone: null, locale: 'en' },
    fallbackEmail: 'unused@placeholder.invalid',
  })
  assert.equal(clash.mode, 'conflict')

  // With no id picked, the same submission simply updates the email owner —
  // the legacy upsert-by-email behaviour, minus the blanking.
  const byEmail = resolveCustomerMutation({
    pickedId: null,
    existing: null,
    emailOwner: OTHER,
    submitted: { name: 'Sam Other', email: OTHER.email, phone: null, locale: 'en' },
    fallbackEmail: 'unused@placeholder.invalid',
  })
  assert.equal(byEmail.mode, 'use')
  assert.equal(byEmail.mode === 'use' && byEmail.customerId, OTHER.id)
})

test('resolveCustomerMutation: no id and no email owner → create (placeholder when phone-only)', () => {
  const created = resolveCustomerMutation({
    pickedId: null,
    existing: null,
    emailOwner: null,
    submitted: { name: 'New Person', email: null, phone: '(862) 640-0625', locale: 'es' },
    fallbackEmail: 'no-email-8626400625@placeholder.invalid',
  })
  assert.equal(created.mode, 'create')
  if (created.mode !== 'create') return
  assert.deepEqual(created.data, {
    email: 'no-email-8626400625@placeholder.invalid',
    name: 'New Person',
    phone: '(862) 640-0625',
    locale: 'es',
    isFirstTime: true,
  })
})

test('resolveCustomerMutation: a vanished picked id degrades honestly to the email match', () => {
  const res = resolveCustomerMutation({
    pickedId: 'cust_deleted',
    existing: null,
    emailOwner: DANA,
    submitted: { name: 'Dana Mover', email: DANA.email, phone: '973-555-0199', locale: 'en' },
    fallbackEmail: DANA.email,
  })
  assert.equal(res.mode, 'update')
  if (res.mode !== 'update') return
  assert.equal(res.customerId, DANA.id)
  assert.deepEqual(res.data, { phone: '973-555-0199' })
  assert.match(res.warning ?? '', /no longer exists/i)
})

// ════════════════════════════════════════════════════════════════════════════
//  ITEM 6 — structured-data parity with the public booking path
// ════════════════════════════════════════════════════════════════════════════

const SKIPPED: VerifiedAddress = { status: 'skipped', reason: 'no_provider_key' }
const VERIFIED: VerifiedAddress = {
  status: 'verified',
  formatted: '12 Main Street, West Orange, NJ 07052, USA',
  streetNumber: '12',
  route: 'Main Street',
  city: 'West Orange',
  county: 'Essex County',
  state: 'NJ',
  zip: '07052',
  country: 'USA',
  lat: 40.798,
  lng: -74.239,
  placeId: 'place_123',
}

test('splitStreetLine: the house number is split off, never invented', () => {
  assert.deepEqual(splitStreetLine('12 Main St'), { streetNumber: '12', route: 'Main St' })
  assert.deepEqual(splitStreetLine('12B Oak Ave'), { streetNumber: '12B', route: 'Oak Ave' })
  // No leading number → we do not know one; the line stays the route.
  assert.deepEqual(splitStreetLine('Main St'), { streetNumber: null, route: 'Main St' })
  assert.deepEqual(splitStreetLine('  '), { streetNumber: null, route: null })
})

test('addressColumnValues: verification state is the REAL one, never assumed', () => {
  const typed = { street: '12 Main St', city: 'West Orange', state: 'NJ', zip: '07052' }

  // Nothing ran → the owner's components are kept, the verdict columns are null.
  const none = addressColumnValues(typed, null)
  assert.equal(none.verification, null)
  assert.equal(none.validationReason, null)
  assert.equal(none.streetNumber, '12')
  assert.equal(none.route, 'Main St')
  assert.equal(none.city, 'West Orange')
  assert.equal(none.zip, '07052')
  assert.equal(none.lat, null)
  assert.equal(none.formatted, null)

  // Provider unavailable → 'skipped' is recorded honestly, NOT 'verified'.
  const skipped = addressColumnValues(typed, SKIPPED)
  assert.equal(skipped.verification, 'skipped')
  assert.equal(skipped.validationReason, 'no_provider_key')
  assert.equal(skipped.city, 'West Orange') // still the typed value
  assert.equal(skipped.lat, null) // never a fabricated coordinate

  // Verified → the provider's canonical components + geo land.
  const ok = addressColumnValues(typed, VERIFIED)
  assert.equal(ok.verification, 'verified')
  assert.equal(ok.route, 'Main Street')
  assert.equal(ok.county, 'Essex County')
  assert.equal(ok.lat, 40.798)
  assert.equal(ok.placeId, 'place_123')
  assert.equal(ok.formatted, '12 Main Street, West Orange, NJ 07052, USA')
})

test('addressNeedsReview: unverified always, skipped only when the string is incomplete', () => {
  const complete = { street: '12 Main St', city: 'West Orange', state: 'NJ', zip: '07052' }
  const noNumber = { street: 'Main St', city: 'West Orange', state: 'NJ', zip: '07052' }
  assert.equal(addressNeedsReview(complete, null), false)
  assert.equal(addressNeedsReview(complete, SKIPPED), false)
  assert.equal(addressNeedsReview(complete, VERIFIED), false)
  assert.equal(addressNeedsReview(complete, { status: 'partial', reason: 'incomplete' }), false)
  assert.equal(addressNeedsReview(complete, { status: 'unverified', reason: 'granularity_route' }), true)
  assert.equal(addressNeedsReview(noNumber, SKIPPED), true)
  assert.equal(addressNeedsReview(noNumber, null), true)
})

test('buildBookingCreateData: every structured address column is persisted', () => {
  const input = parsed()
  const data = buildBookingCreateData(input, {
    ...ctxFor(input),
    verification: { origin: SKIPPED, dest: SKIPPED },
  })
  assert.equal(data.originStreetNumber, '12')
  assert.equal(data.originRoute, 'Main St')
  assert.equal(data.originCity, 'West Orange')
  assert.equal(data.originState, 'NJ')
  assert.equal(data.originZip, '07052')
  assert.equal(data.originVerification, 'skipped')
  assert.equal(data.destStreetNumber, '99')
  assert.equal(data.destRoute, 'Oak Ave')
  assert.equal(data.destCity, 'Montclair')
  assert.equal(data.destZip, '07042')
  assert.equal(data.destVerification, 'skipped')
  // The composed single-line strings still land unchanged.
  assert.equal(data.originAddress, '12 Main St, West Orange, NJ 07052')
  assert.equal(data.destAddress, '99 Oak Ave, Montclair, NJ 07042')
})

test('buildBookingCreateData: addresses are unverified by default — never claimed verified', () => {
  const input = parsed()
  const data = buildBookingCreateData(input, ctxFor(input))
  assert.equal(data.originVerification, null)
  assert.equal(data.destVerification, null)
  assert.equal(data.originLat, null)
  assert.equal(data.originFormatted, null)
  assert.notEqual(data.originVerification, 'verified')
})

test('buildBookingCreateData: all checkServiceArea outputs are persisted', () => {
  const input = parsed()
  const base = ctxFor(input)
  const data = buildBookingCreateData(input, {
    ...base,
    travel: {
      ...base.travel,
      manualReviewRequired: false,
      distanceFromWestOrangeMiles: 12.4,
      estimatedDriveTimeMinutes: 27,
      evaluatedAddresses: [{ zip: '07052', zone: 'primary' }],
    },
  })
  assert.equal(data.serviceAreaZone, 'extended_nj')
  assert.equal(data.travelFee, 5000)
  assert.equal(data.travelFeeDueOnMoveDay, true)
  assert.equal(data.serviceAreaMessage, 'extended NJ')
  assert.equal(data.distanceFromWestOrangeMiles, 12.4)
  assert.equal(data.estimatedDriveTimeMinutes, 27)
  assert.deepEqual(data.addressEvaluation, [{ zip: '07052', zone: 'primary' }])
})

test('buildBookingCreateData: reviewReasons come from the shared helper (review-gated input)', () => {
  const input = parsed()
  // A 400lb+ item is a review line in the canonical estimator — the SAME input
  // that gates a public booking must gate an admin one.
  const heavyEstimate = computeEstimate({
    serviceType: input.move.serviceType,
    heavyItems: [{ label: 'Gun safe', pounds: 450 }],
    travelFeeCents: 5000,
  })
  assert.equal(heavyEstimate.requiresReview, true)
  const data = buildBookingCreateData(input, { ...ctxFor(input), estimate: heavyEstimate })
  assert.equal(data.manualReviewRequired, true)
  assert.ok((data.reviewReasons as string[]).length > 0)
  assert.deepEqual(data.reviewReasons, heavyEstimate.reviewReasons)

  // A service area needing owner review adds its own reason.
  const base = ctxFor(input)
  const reviewed = buildBookingCreateData(input, {
    ...base,
    travel: { ...base.travel, zone: 'new_york', manualReviewRequired: true, message: 'New York — owner review required' },
  })
  assert.equal(reviewed.manualReviewRequired, true)
  assert.ok((reviewed.reviewReasons as string[]).includes('New York — owner review required'))

  // An unverifiable address is its own honest reason.
  const unverified = buildBookingCreateData(input, {
    ...ctxFor(input),
    verification: { origin: { status: 'unverified', reason: 'granularity_route' }, dest: SKIPPED },
  })
  assert.equal(unverified.manualReviewRequired, true)
  assert.ok((unverified.reviewReasons as string[]).some((r) => /could not be verified/i.test(r)))
})

test('buildBookingCreateData: a clean admin booking is not flagged for review', () => {
  const input = parsed()
  const data = buildBookingCreateData(input, { ...ctxFor(input), verification: { origin: SKIPPED, dest: SKIPPED } })
  assert.deepEqual(data.reviewReasons, [])
  assert.equal(data.manualReviewRequired, false)
})

// ── Derived move details ─────────────────────────────────────────────────────

const catalog = new Map<string, CatalogSnapshotSource>([
  ['box', { id: 'box', name: 'Medium box', isHeavy: false, needsDisassembly: false, recommendedMovers: null, category: 'boxes', typicalVolumeCuFt: 3 }],
  ['couch', { id: 'couch', name: 'Couch (3-seat)', isHeavy: false, needsDisassembly: false, recommendedMovers: 2, category: 'furniture', typicalVolumeCuFt: 40 }],
  ['piano', { id: 'piano', name: 'Piano (upright)', isHeavy: true, needsDisassembly: false, recommendedMovers: 4, category: 'specialty', typicalVolumeCuFt: 70 }],
  ['washer', { id: 'washer', name: 'Washer', isHeavy: true, needsDisassembly: false, recommendedMovers: 2, category: 'appliances', typicalVolumeCuFt: 25 }],
])

test('deriveMoveDetails: numBoxes counts catalog box lines only', () => {
  const snaps = resolveInventorySnapshots(
    [
      { catalogItemId: 'box', name: 'Medium box', quantity: 12 },
      { catalogItemId: 'couch', name: 'Couch', quantity: 1 },
    ],
    catalog,
  )
  assert.equal(deriveMoveDetails(snaps).numBoxes, 12)

  // Custom lines carry no category → "unknown", which is NOT "zero boxes".
  const custom = resolveInventorySnapshots([{ name: 'Fish tank', quantity: 1 }], new Map())
  assert.equal(deriveMoveDetails(custom).numBoxes, null)
  // Nothing captured at all → every derived column stays null.
  assert.deepEqual(deriveMoveDetails([]), {
    numBoxes: null,
    estimatedCubicFeet: null,
    hasPiano: null,
    hasSafe: null,
    hasPoolTable: null,
    hasAppliances: null,
    specialtyItems: null,
  })
})

test('deriveMoveDetails: cubic feet only when EVERY line has a real catalog volume', () => {
  const allCatalog = resolveInventorySnapshots(
    [
      { catalogItemId: 'box', name: 'Medium box', quantity: 10 },
      { catalogItemId: 'couch', name: 'Couch', quantity: 1 },
    ],
    catalog,
  )
  assert.equal(deriveMoveDetails(allCatalog).estimatedCubicFeet, 10 * 3 + 40)

  // One custom line → no honest total, so none is invented.
  const mixed = resolveInventorySnapshots(
    [
      { catalogItemId: 'box', name: 'Medium box', quantity: 10 },
      { name: 'Fish tank (55 gal)', quantity: 1 },
    ],
    catalog,
  )
  assert.equal(deriveMoveDetails(mixed).estimatedCubicFeet, null)
})

test('deriveMoveDetails: specialty flags read the captured inventory', () => {
  const snaps = resolveInventorySnapshots(
    [
      { catalogItemId: 'piano', name: 'Piano', quantity: 1 },
      { catalogItemId: 'washer', name: 'Washer', quantity: 1 },
      { name: 'Gun safe (600 lb)', quantity: 1 },
    ],
    catalog,
  )
  const details = deriveMoveDetails(snaps)
  assert.equal(details.hasPiano, true)
  assert.equal(details.hasSafe, true)
  assert.equal(details.hasAppliances, true)
  assert.equal(details.hasPoolTable, false) // asked, and the answer is no
  assert.match(details.specialtyItems ?? '', /Piano \(upright\)/)
  assert.match(details.specialtyItems ?? '', /Gun safe/)

  const plain = resolveInventorySnapshots([{ catalogItemId: 'couch', name: 'Couch', quantity: 1 }], catalog)
  const plainDetails = deriveMoveDetails(plain)
  assert.equal(plainDetails.hasPiano, false)
  assert.equal(plainDetails.hasSafe, false)
  assert.equal(plainDetails.specialtyItems, null)
})

test('buildBookingCreateData: derived move-detail columns land on the booking', () => {
  const input = parsed()
  const snaps: InventorySnapshot[] = resolveInventorySnapshots(
    [
      { catalogItemId: 'box', name: 'Medium box', quantity: 8 },
      { catalogItemId: 'piano', name: 'Piano', quantity: 1 },
    ],
    catalog,
  )
  const data = buildBookingCreateData(input, ctxFor(input), snaps)
  assert.equal(data.numBoxes, 8)
  assert.equal(data.estimatedCubicFeet, 8 * 3 + 70)
  assert.equal(data.hasPiano, true)
  assert.equal(data.hasPoolTable, false)
  assert.equal(data.bedrooms, 2)
  // Services still come straight from the form's checkboxes.
  assert.equal(data.needsDisassembly, true)
  assert.equal(data.needsPacking, false)

  // No inventory → the columns say "not captured", not "none".
  const empty = buildBookingCreateData(input, ctxFor(input), [])
  assert.equal(empty.numBoxes, null)
  assert.equal(empty.estimatedCubicFeet, null)
  assert.equal(empty.hasPiano, null)
})
