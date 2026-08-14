import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Prisma } from '@prisma/client'
import {
  buildStaffingPlan,
  derivePlanFromBooking,
  deriveTransportFromBooking,
  ensureStaffingRequirement,
  isSingleLocationMode,
  normalizeServiceMode,
  parseStaffingPlan,
  planOpsWarnings,
  planForBooking,
  reconcilePlanWithBooking,
  serviceModeStaffingRules,
  staffingRequirementDataFromPlan,
  STAFFING_PLAN_VERSION,
  type StaffingBookingRow,
  type StaffingPlan,
  type StaffingRequirementSnapshot,
  type StaffingServiceMode,
  type StaffingTx,
} from '../staffing-plan'
import { buildAdminStaffingPlan, AdminBookingSchema, type AdminBookingInput } from '../admin-booking'
import {
  approveBooking,
  isMigrationMissing,
  loadStaffingBookingRow,
  type ApprovableBooking,
  type ApprovalDeps,
  type ApprovalStore,
} from '../booking-approval'

// ════════════════════════════════════════════════════════════════════════════
//  Offline regression tests for the staffing spine (Moving OS correctness pass
//  items 1 + 4, ROUND 2 items R2-3 + R2-4). No prisma, no Stripe, no network —
//  the DB surface is a fake tx so the invariants can be proven with
//  `npx tsx --test`.
//
//  ROUND-2 RULE: every test asserts THE GUARANTEE, on the DEFAULT path. Round 1
//  shipped green tests over live defects — an approve-twice test whose
//  {create:1, update:0} was really proof that the second approval never called
//  ensure at all, and a derived-plan test that asserted the full-service driver
//  as though it were intended. So:
//
//    • the unapplied-migration test makes the new-column select THROW
//    • the replay test makes the FIRST ensure THROW and the second one heal it
//    • the owner-edit test starts from a hand-tuned row
//    • the public-booking test uses a row the PUBLIC route actually writes
//      (serviceMode null + the truck columns) and asserts NO driver
// ════════════════════════════════════════════════════════════════════════════

// ── Fakes ────────────────────────────────────────────────────────────────────

type FakeRow = Record<string, unknown>

/** A fake JobStaffingRequirement delegate. `create` THROWS on a duplicate, like
 *  the real @unique(jobId) index does — so a test can never pass by silently
 *  overwriting a row the spine was supposed to leave alone. */
function makeFakeTx(seed: Record<string, FakeRow> = {}) {
  const rows = new Map<string, FakeRow>(Object.entries(seed))
  const calls = { find: 0, create: 0, update: 0 }
  const tx: StaffingTx = {
    jobStaffingRequirement: {
      async findUnique(args) {
        calls.find++
        return (rows.get(args.where.jobId) as StaffingRequirementSnapshot | undefined) ?? null
      },
      async create(args) {
        if (rows.has(args.data.jobId)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`job_id`)'), { code: 'P2002' })
        }
        calls.create++
        rows.set(args.data.jobId, { ...args.data })
        return rows.get(args.data.jobId)
      },
      async update(args) {
        calls.update++
        const existing = rows.get(args.where.jobId) ?? {}
        rows.set(args.where.jobId, { ...existing, ...args.data })
        return rows.get(args.where.jobId)
      },
    },
  }
  return { tx, rows, calls }
}

/** A plan literal — used where the MAPPING is under test, so the assertions do
 *  not ride on estimate-assistant's numbers. */
function makePlan(over: Partial<StaffingPlan> = {}): StaffingPlan {
  return {
    version: STAFFING_PLAN_VERSION,
    source: 'admin_book_move',
    serviceType: '2br',
    jobSizeLabel: '2 Bedroom',
    serviceMode: 'full_service',
    crewSize: 3,
    minimumWorkers: 2,
    requiredDrivers: 1,
    requiresLead: true,
    requiredSkills: ['DRIVING'],
    truckAssigned: true,
    truckSize: '15ft',
    truckSource: 'RENTAL',
    customerProvidedTruck: false,
    rentalTruckPickup: true,
    drivingRequired: true,
    singleLocation: false,
    estimatedHoursMin: 4,
    estimatedHoursMax: 6,
    possibleTrips: 1,
    difficulty: 'elevated',
    flags: {
      hasStairs: true,
      hasElevator: false,
      longCarry: false,
      heavyItems: true,
      packing: false,
      assembly: true,
      additionalStops: 1,
    },
    reasons: ['2 Bedroom inventory — base crew of 3, 4-6h'],
    notes: ['Our truck is assigned — a driver is required on this crew.'],
    workerInstructions: 'Gate code at the dock',
    ...over,
  }
}

// ── ITEM 4 — the service-mode × truck matrix ─────────────────────────────────

const MODES: StaffingServiceMode[] = ['full_service', 'labor_only', 'loading_only', 'unloading_only']

test('item 4: every {serviceMode} × {truck assigned?} combination staffs correctly', () => {
  const expected: Record<
    string,
    { customerProvidedTruck: boolean; requiredDrivers: number; note: RegExp }
  > = {
    // No truck of ours on the job.
    'full_service|no-truck': {
      customerProvidedTruck: false,
      requiredDrivers: 1,
      note: /NO truck assigned yet/i,
    },
    'labor_only|no-truck': {
      customerProvidedTruck: true,
      requiredDrivers: 0,
      note: /customer provides transportation/i,
    },
    'loading_only|no-truck': {
      customerProvidedTruck: true,
      requiredDrivers: 0,
      note: /customer provides transportation/i,
    },
    'unloading_only|no-truck': {
      customerProvidedTruck: true,
      requiredDrivers: 0,
      note: /customer provides transportation/i,
    },
    // One of OUR trucks is assigned — rule 1 wins for every mode.
    'full_service|truck': {
      customerProvidedTruck: false,
      requiredDrivers: 1,
      note: /driver is required/i,
    },
    'labor_only|truck': { customerProvidedTruck: false, requiredDrivers: 1, note: /we are driving/i },
    'loading_only|truck': { customerProvidedTruck: false, requiredDrivers: 1, note: /we are driving/i },
    'unloading_only|truck': {
      customerProvidedTruck: false,
      requiredDrivers: 1,
      note: /we are driving/i,
    },
  }

  for (const mode of MODES) {
    for (const truckAssigned of [false, true]) {
      const key = `${mode}|${truckAssigned ? 'truck' : 'no-truck'}`
      const want = expected[key]
      const plan = buildStaffingPlan({
        source: 'admin_book_move',
        serviceType: '1br',
        serviceMode: mode,
        truckAssigned,
        truckSource: truckAssigned ? 'COMPANY_OWNED' : null,
        inventory: [],
      })
      assert.equal(plan.customerProvidedTruck, want.customerProvidedTruck, `${key}: customerProvidedTruck`)
      assert.equal(plan.requiredDrivers, want.requiredDrivers, `${key}: requiredDrivers`)
      assert.equal(plan.drivingRequired, want.requiredDrivers > 0, `${key}: drivingRequired`)
      assert.ok(
        plan.notes.some((n) => want.note.test(n)),
        `${key}: expected a note matching ${want.note} — got ${JSON.stringify(plan.notes)}`,
      )
      // The driver SKILL follows the driver requirement, never the mode alone.
      assert.equal(plan.requiredSkills.includes('DRIVING'), want.requiredDrivers > 0, `${key}: skills`)
      // Unchanged rules: a lead is always required, minimum is crew-1 floored at 2.
      assert.equal(plan.requiresLead, true, `${key}: requiresLead`)
      assert.equal(plan.minimumWorkers, Math.max(2, plan.crewSize - 1), `${key}: minimumWorkers`)
      // A recorded mode is the owner's own answer — the R2-4 derivation never
      // second-guesses it, so no verdict is stamped.
      assert.equal(plan.transportVerdict ?? null, null, `${key}: transportVerdict`)
    }
  }
})

test('item 4: rentalTruckPickup mirrors the assigned truck source', () => {
  const rental = buildStaffingPlan({
    source: 'admin_book_move',
    serviceType: '1br',
    serviceMode: 'full_service',
    truckAssigned: true,
    truckSource: 'RENTAL',
  })
  assert.equal(rental.rentalTruckPickup, true)
  assert.ok(rental.notes.some((n) => /Rental truck/i.test(n)))

  const owned = buildStaffingPlan({
    source: 'admin_book_move',
    serviceType: '1br',
    serviceMode: 'full_service',
    truckAssigned: true,
    truckSource: 'COMPANY_OWNED',
  })
  assert.equal(owned.rentalTruckPickup, false)

  // No truck of ours → never a rental pickup, whatever the stale source says.
  const none = buildStaffingPlan({
    source: 'admin_book_move',
    serviceType: '1br',
    serviceMode: 'labor_only',
    truckAssigned: false,
    truckSource: 'RENTAL',
  })
  assert.equal(none.rentalTruckPickup, false)
  assert.equal(none.customerProvidedTruck, true)
})

test('item 4: loading/unloading-only are single-location — the other end never counts', () => {
  const base = {
    source: 'admin_book_move' as const,
    serviceType: '1br',
    truckAssigned: false,
    originStairFlights: 0,
    destStairFlights: 3,
    destHasElevator: false,
  }
  const loading = buildStaffingPlan({ ...base, serviceMode: 'loading_only' })
  assert.equal(loading.singleLocation, true)
  assert.equal(loading.flags.hasStairs, false, 'drop-off stairs must not staff a loading-only job')
  assert.ok(loading.notes.some((n) => /single-location job at the pickup/i.test(n)))

  const unloading = buildStaffingPlan({ ...base, serviceMode: 'unloading_only' })
  assert.equal(unloading.singleLocation, true)
  assert.equal(unloading.flags.hasStairs, true, 'drop-off stairs DO staff an unloading-only job')
  assert.ok(unloading.notes.some((n) => /single-location job at the drop-off/i.test(n)))

  // Both-ends modes still see both ends.
  const full = buildStaffingPlan({ ...base, serviceMode: 'full_service' })
  assert.equal(full.singleLocation, false)
  assert.equal(full.flags.hasStairs, true)
})

test('item 4: with NO mode and NO booking evidence at all, the full-service default holds', () => {
  // This is the form-input caller (no booking row, so nothing to derive from).
  // The booking-row path is item R2-4 below and behaves differently ON PURPOSE.
  const plan = buildStaffingPlan({ source: 'derived', serviceType: '1br', serviceMode: null })
  assert.equal(plan.serviceMode, null)
  assert.equal(plan.requiredDrivers, 1)
  assert.equal(plan.customerProvidedTruck, false)
  assert.ok(plan.notes.some((n) => /not recorded/i.test(n)))
  assert.equal(normalizeServiceMode('LABOR_ONLY'), 'labor_only')
  assert.equal(normalizeServiceMode('nonsense'), null)
  assert.equal(isSingleLocationMode('loading_only'), true)
  assert.equal(isSingleLocationMode('labor_only'), false)
  // The rule table is directly callable and self-consistent.
  const rules = serviceModeStaffingRules({ serviceMode: 'labor_only', truckAssigned: false })
  assert.deepEqual(
    { d: rules.requiredDrivers, c: rules.customerProvidedTruck, s: rules.requiredSkills },
    { d: 0, c: true, s: [] },
  )
})

test('item 4: the ops gaps reach the owner, and never contradict the staffing', () => {
  const noTruck = buildStaffingPlan({
    source: 'admin_book_move',
    serviceType: '2br',
    serviceMode: 'full_service',
    truckAssigned: false,
  })
  const gaps = planOpsWarnings(noTruck)
  assert.equal(gaps.length, 1)
  assert.match(gaps[0], /no truck assigned/i)

  const laborOnly = planOpsWarnings(
    buildStaffingPlan({ source: 'admin_book_move', serviceType: '2br', serviceMode: 'labor_only', truckAssigned: false }),
  )
  assert.equal(laborOnly.length, 1)
  assert.match(laborOnly[0], /no driver is being staffed/i)

  // Truck assigned + full service = nothing to warn about.
  assert.deepEqual(
    planOpsWarnings(
      buildStaffingPlan({
        source: 'admin_book_move',
        serviceType: '2br',
        serviceMode: 'full_service',
        truckAssigned: true,
        truckSource: 'RENTAL',
      }),
    ),
    [],
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  ITEM R2-4 — the PUBLIC / legacy path: never staff a driver we are not
//  sending, and never claim certainty we do not have.
//
//  Every public and legacy booking has serviceMode = null. Round 1 let those
//  fall through to the full-service branch (customerProvidedTruck=false,
//  requiredDrivers=1, skills=['DRIVING']) and round 1's test asserted that as
//  though it were intended. These tests assert the opposite, from rows the
//  PUBLIC route (app/api/bookings/route.ts) actually writes.
// ════════════════════════════════════════════════════════════════════════════

/** A booking row shaped like what POST /api/bookings persists: no serviceMode,
 *  no fleet truck, the truck facts in truckProvider / truckAddonDueOnMoveDay /
 *  the `Truck:` line of itemsDescription. */
function publicBookingRow(over: Partial<StaffingBookingRow> = {}): StaffingBookingRow {
  return {
    id: 'bk_public',
    serviceMode: null, // the public route never writes it — THE defect's root
    truckId: null, // no fleet truck: Booking.truckId is admin-only
    bedrooms: 2,
    originStairCount: 1,
    destStairCount: 0,
    needsPacking: false,
    crewInstructions: null,
    staffingPlan: null,
    scheduledStart: null,
    scheduledEnd: null,
    // Written by the public route from truckOption === 'own-truck'.
    truckProvider: 'customer',
    truckAddonDueOnMoveDay: false,
    itemsDescription: 'Service: 2 Bedroom\nTruck: Customer provides truck ($0)\nEstimated moving total: $699',
    inventoryItems: [
      { name: 'Couch (3-seat)', quantity: 1, isHeavy: false, needsDisassembly: false, catalogItem: null },
    ],
    ...over,
  }
}

test('R2-4: a real public booking (customer truck) staffs NO driver', () => {
  const plan = derivePlanFromBooking(publicBookingRow())

  assert.equal(plan.customerProvidedTruck, true, 'the customer is bringing the truck')
  assert.equal(plan.requiredDrivers, 0, 'we are not driving — never staff a driver we are not sending')
  assert.equal(plan.drivingRequired, false)
  assert.deepEqual(plan.requiredSkills, [], 'no DRIVING skill on a job we do not drive')
  assert.equal(plan.rentalTruckPickup, false)
  assert.equal(plan.transportVerdict, 'customer_drives')
  assert.ok(
    plan.notes.some((n) => /truck provider recorded as "customer"/i.test(n)),
    `the deciding column must be quoted — got ${JSON.stringify(plan.notes)}`,
  )

  // And the columns dispatch actually reads carry it through.
  const data = staffingRequirementDataFromPlan(plan, { jobId: 'job_pub' })
  assert.equal(data.requiredDrivers, 0)
  assert.equal(data.customerProvidedTruck, true)
  assert.equal(data.drivingRequired, false)
  assert.deepEqual(data.requiredSkills, [])
})

test('R2-4: the truck pickup & return add-on DOES require a driver', () => {
  // truckOption === 'truck-pickup-return' → truckAddonDueOnMoveDay. Its
  // published terms are "our driver", so this is decisive even though the
  // rental is in the customer's name.
  const plan = derivePlanFromBooking(
    publicBookingRow({
      truckProvider: 'U-Haul',
      truckAddonDueOnMoveDay: true,
      itemsDescription: 'Service: 2 Bedroom\nTruck: Truck Pickup & Return (+$49 due on move day)',
    }),
  )
  assert.equal(plan.requiredDrivers, 1)
  assert.equal(plan.drivingRequired, true)
  assert.deepEqual(plan.requiredSkills, ['DRIVING'])
  assert.equal(plan.customerProvidedTruck, false)
  assert.equal(plan.rentalTruckPickup, true, 'somebody has to collect and return the rental')
  assert.equal(plan.transportVerdict, 'we_drive')

  // The ops warning names the real situation instead of "assign a truck".
  const warnings = planOpsWarnings(plan)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /collects the rental/i)

  // A LEGACY row whose only evidence is the itemsDescription line reaches the
  // same verdict (the structured boolean predates neither, but old rows exist).
  const legacy = derivePlanFromBooking(
    publicBookingRow({
      truckProvider: null,
      truckAddonDueOnMoveDay: false,
      itemsDescription: 'Service: Studio\nTruck: Truck Pickup & Return (+$49 due on move day)',
    }),
  )
  assert.equal(legacy.requiredDrivers, 1)
  assert.equal(legacy.transportVerdict, 'we_drive')
})

test('R2-4: ambiguous truck details resolve to NON-driving, and say so', () => {
  // A bare rental brand: the reservation can be in either name. Nothing here
  // says who drives, so nobody is staffed as a driver — and the plan says the
  // mode was not recorded rather than claiming the customer has a truck.
  const brandOnly = derivePlanFromBooking(
    publicBookingRow({ truckProvider: 'U-Haul', itemsDescription: 'Service: 1 Bedroom' }),
  )
  assert.equal(brandOnly.requiredDrivers, 0)
  assert.equal(brandOnly.drivingRequired, false)
  assert.equal(brandOnly.customerProvidedTruck, true)
  assert.equal(brandOnly.transportVerdict, 'unclear')
  assert.ok(brandOnly.notes.some((n) => /does not say who drives/i.test(n)))
  assert.ok(brandOnly.notes.some((n) => /Confirm before dispatch/i.test(n)))
  assert.match(planOpsWarnings(brandOnly)[0], /Nobody recorded who provides the truck/i)

  // Nothing recorded at all — same conservative answer, different evidence line.
  const empty = derivePlanFromBooking(
    publicBookingRow({ truckProvider: null, itemsDescription: 'Service: 1 Bedroom' }),
  )
  assert.equal(empty.requiredDrivers, 0)
  assert.equal(empty.transportVerdict, 'unclear')
  assert.ok(empty.notes.some((n) => /No truck details recorded/i.test(n)))

  // Contradicting columns are reported, never silently resolved in favour of
  // sending a driver.
  const conflict = deriveTransportFromBooking({
    truckProvider: 'customer',
    truckReturnResponsibility: 'WMIWCI crew returns it',
  })
  assert.equal(conflict.verdict, 'unclear')
  assert.equal(conflict.ambiguous, true)
  assert.ok(conflict.evidence.some((e) => /contradict/i.test(e)))
})

test('R2-4: the derivation reads only signals that actually mean something', () => {
  // truckReservationStatus says whether a truck is booked, never who drives it.
  const reservation = deriveTransportFromBooking({ truckReservationStatus: 'reserved', truckSize: '15ft' })
  assert.equal(reservation.verdict, 'unclear')

  // Word boundaries: "cardboard" is not "card", and a provider that merely
  // CONTAINS a keyword's letters is not a match.
  assert.equal(deriveTransportFromBooking({ truckProvider: 'Customs Broker Ltd' }).verdict, 'unclear')
  assert.equal(deriveTransportFromBooking({ truckProvider: 'Customer-provided' }).verdict, 'customer_drives')
  assert.equal(deriveTransportFromBooking({ truckReturnResponsibility: 'Customer returns it' }).verdict, 'customer_drives')
  assert.equal(deriveTransportFromBooking({ truckProvider: 'Move It Clear It' }).verdict, 'we_drive')
  assert.equal(deriveTransportFromBooking({ truckReturnResponsibility: 'Our driver takes it back' }).verdict, 'we_drive')
  // A loose pronoun is NOT a driving decision — an unrecognised value stays
  // 'unclear', which staffs nobody, rather than guessing a driver onto the job.
  assert.equal(
    deriveTransportFromBooking({ truckReturnResponsibility: 'We will sort it out on the day' }).verdict,
    'unclear',
  )

  // A FLEET truck outranks everything: if one of ours is on the job, one of ours
  // drives it, whatever the free text says.
  const fleet = derivePlanFromBooking(publicBookingRow({ truckId: 'tr_9', truck: { source: 'COMPANY_OWNED' } }))
  assert.equal(fleet.requiredDrivers, 1)
  assert.equal(fleet.customerProvidedTruck, false)
  assert.deepEqual(fleet.requiredSkills, ['DRIVING'])
})

test('R2-4: reconcile does not undo the derivation at approval time', () => {
  // planForBooking → reconcilePlanWithBooking runs on EVERY plan at approval.
  // It re-applies the rule table, so if it ignored the transport evidence it
  // would put the driver straight back on a customer-truck job.
  const row = publicBookingRow()
  const plan = planForBooking(row)
  assert.equal(plan.requiredDrivers, 0)
  assert.equal(plan.customerProvidedTruck, true)
  assert.equal(plan.transportVerdict, 'customer_drives')

  const direct = reconcilePlanWithBooking(derivePlanFromBooking(row), row)
  assert.equal(direct.requiredDrivers, 0)
  assert.equal(direct.customerProvidedTruck, true)
})

// ── plan → JobStaffingRequirement columns ────────────────────────────────────

test('mapping: plan → requirement columns (and an estimated end from the plan hours)', () => {
  const start = new Date('2026-09-10T12:00:00.000Z')
  const data = staffingRequirementDataFromPlan(makePlan(), { jobId: 'job_1', estimatedStartAt: start })
  assert.equal(data.jobId, 'job_1')
  assert.equal(data.requiredWorkers, 3)
  assert.equal(data.minWorkers, 2)
  assert.equal(data.requiredDrivers, 1)
  assert.equal(data.requiresLead, true)
  assert.deepEqual(data.requiredSkills, ['DRIVING'])
  assert.equal(data.customerProvidedTruck, false)
  assert.equal(data.rentalTruckPickup, true)
  assert.equal(data.drivingRequired, true)
  assert.equal(data.hasStairs, true)
  assert.equal(data.hasElevator, false)
  assert.equal(data.heavyItems, true)
  assert.equal(data.assembly, true)
  assert.equal(data.packing, false)
  assert.equal(data.additionalStops, 1)
  assert.equal(data.workerInstructions, 'Gate code at the dock')
  assert.equal(data.estimatedStartAt?.toISOString(), start.toISOString())
  // 6 max hours after the start — the column is an estimate and the plan is its basis.
  assert.equal(data.estimatedEndAt?.toISOString(), '2026-09-10T18:00:00.000Z')

  // An explicit end always wins over the derived one.
  const end = new Date('2026-09-10T20:00:00.000Z')
  const explicit = staffingRequirementDataFromPlan(makePlan(), { estimatedStartAt: start, estimatedEndAt: end })
  assert.equal(explicit.estimatedEndAt?.toISOString(), end.toISOString())
  assert.equal(explicit.jobId, undefined)

  // Day-level scheduling: no start → NO invented times.
  const dayLevel = staffingRequirementDataFromPlan(makePlan(), { estimatedStartAt: null })
  assert.equal(dayLevel.estimatedStartAt, null)
  assert.equal(dayLevel.estimatedEndAt, null)

  // Unknown skill names never reach the CrewSkill[] column.
  const junk = staffingRequirementDataFromPlan(makePlan({ requiredSkills: ['DRIVING', 'TELEPORTING'] }), {})
  assert.deepEqual(junk.requiredSkills, ['DRIVING'])
})

// ── Derived plans (public bookings + legacy rows) ────────────────────────────

function bookingRow(over: Partial<StaffingBookingRow> = {}): StaffingBookingRow {
  return {
    id: 'bk_1',
    truckId: null,
    serviceMode: null,
    bedrooms: 2,
    originStairCount: 2,
    destStairCount: 0,
    originHasElevator: false,
    destHasElevator: null,
    needsPacking: true,
    needsAssembly: false,
    needsDisassembly: false,
    crewInstructions: 'Ring the buzzer twice',
    scheduledStart: new Date('2026-09-10T13:00:00.000Z'),
    scheduledEnd: new Date('2026-09-10T19:00:00.000Z'),
    staffingPlan: null,
    inventoryItems: [
      { name: 'Washer', quantity: 1, isHeavy: true, needsDisassembly: false, catalogItem: { recommendedMovers: 2 } },
      { name: 'Queen bed frame', quantity: 1, isHeavy: false, needsDisassembly: true, catalogItem: null },
    ],
    ...over,
  }
}

test('derived: a booking with no persisted plan still gets an honest one', () => {
  const plan = derivePlanFromBooking(bookingRow())
  assert.equal(plan.source, 'derived')
  assert.ok(plan.notes.some((n) => /derived from the booking record/i.test(n)))
  // Built from the booking's OWN columns.
  assert.equal(plan.flags.hasStairs, true) // originStairCount 2
  assert.equal(plan.flags.hasElevator, false)
  assert.equal(plan.flags.heavyItems, true) // the washer line
  assert.equal(plan.flags.packing, true) // needsPacking
  assert.equal(plan.flags.assembly, true) // the bed frame needs disassembly
  assert.equal(plan.workerInstructions, 'Ring the buzzer twice')
  // Nothing invented: no long-carry column on Booking → false, not a guess.
  assert.equal(plan.flags.longCarry, false)
  assert.ok(plan.crewSize >= 2 && plan.crewSize <= 5)
  assert.equal(plan.minimumWorkers, Math.max(2, plan.crewSize - 1))
  // No truck of ours, no recorded mode, no truck details (item R2-4): nobody is
  // staffed as a driver, and the plan says the mode was never recorded.
  assert.equal(plan.requiredDrivers, 0)
  assert.equal(plan.transportVerdict, 'unclear')

  // Same booking with our truck on it: driver + no customer truck.
  const withTruck = derivePlanFromBooking(bookingRow({ truckId: 'tr_1', truck: { source: 'RENTAL' } }))
  assert.equal(withTruck.customerProvidedTruck, false)
  assert.equal(withTruck.rentalTruckPickup, true)
  assert.equal(withTruck.requiredDrivers, 1)

  // Labor-only public booking, customer's own U-Haul: nobody of ours drives.
  const laborOnly = derivePlanFromBooking(bookingRow({ serviceMode: 'labor_only' }))
  assert.equal(laborOnly.customerProvidedTruck, true)
  assert.equal(laborOnly.requiredDrivers, 0)
})

test('parse: garbage in the JSON column degrades to a derived plan, never a bad requirement', () => {
  assert.equal(parseStaffingPlan(null), null)
  assert.equal(parseStaffingPlan('not a plan'), null)
  assert.equal(parseStaffingPlan([1, 2, 3]), null)
  assert.equal(parseStaffingPlan({ crewSize: 0, estimatedHoursMax: 0 }), null)

  // A real plan survives the JSON round trip the DB column performs.
  const plan = makePlan()
  const round = parseStaffingPlan(JSON.parse(JSON.stringify(plan)))
  assert.ok(round)
  assert.equal(round.crewSize, plan.crewSize)
  assert.equal(round.estimatedHoursMax, plan.estimatedHoursMax)
  assert.deepEqual(round.flags, plan.flags)
  assert.equal(round.source, 'admin_book_move')

  // Unusable JSON on the booking → planForBooking derives instead of failing.
  const derived = planForBooking(bookingRow({ staffingPlan: { crewSize: 'three' } }))
  assert.equal(derived.source, 'derived')
})

test('reconcile: a truck assigned after the plan was captured re-derives the driver rules', () => {
  const captured = makePlan({
    truckAssigned: false,
    truckSource: null,
    serviceMode: 'labor_only',
    customerProvidedTruck: true,
    requiredDrivers: 0,
    requiredSkills: [],
    drivingRequired: false,
    rentalTruckPickup: false,
  })
  const booking = bookingRow({ truckId: 'tr_9', truck: { source: 'RENTAL' }, serviceMode: 'labor_only' })
  const plan = reconcilePlanWithBooking(captured, booking)
  assert.equal(plan.truckAssigned, true)
  assert.equal(plan.requiredDrivers, 1)
  assert.equal(plan.customerProvidedTruck, false)
  assert.equal(plan.rentalTruckPickup, true)
  assert.ok(plan.notes.some((n) => /changed after the plan was captured/i.test(n)))
  // The owner's crew/hours are NOT recomputed — only the truck facts.
  assert.equal(plan.crewSize, captured.crewSize)
  assert.equal(plan.estimatedHoursMax, captured.estimatedHoursMax)

  // Nothing changed → the captured notes stay as they were.
  const stable = reconcilePlanWithBooking(makePlan({ truckAssigned: false, serviceMode: 'labor_only', customerProvidedTruck: true, requiredDrivers: 0, drivingRequired: false, requiredSkills: [], rentalTruckPickup: false }), bookingRow({ serviceMode: 'labor_only' }))
  assert.ok(!stable.notes.some((n) => /changed after the plan was captured/i.test(n)))
})

// ── EXACTLY ONE row, and the OWNER's row is never overwritten (item R2-3c) ───

test('ensure: exactly one row, and a replay never rewrites it', async () => {
  const { tx, rows, calls } = makeFakeTx()
  const booking = bookingRow()
  const plan = makePlan()

  const first = await ensureStaffingRequirement(tx, {
    jobId: 'job_1',
    booking,
    plan,
    createdById: 'user_owner',
  })
  assert.equal(rows.size, 1)
  assert.equal(first.outcome, 'created')
  assert.deepEqual(calls, { find: 1, create: 1, update: 0 })
  assert.equal(first.data.requiredWorkers, plan.crewSize)
  const created = rows.get('job_1')!
  assert.equal(created.jobId, 'job_1')
  assert.equal(created.createdById, 'user_owner')
  assert.equal(created.requiredWorkers, plan.crewSize)
  // Times come from the booking when the caller does not pass any.
  assert.equal((created.estimatedStartAt as Date).toISOString(), '2026-09-10T13:00:00.000Z')
  assert.equal((created.estimatedEndAt as Date).toISOString(), '2026-09-10T19:00:00.000Z')

  // approve → reopen → approve: still one row, and NOTHING was written the
  // second time (the fake `create` would throw on a duplicate).
  const second = await ensureStaffingRequirement(tx, { jobId: 'job_1', booking, plan, updatedById: 'user_manager' })
  assert.equal(rows.size, 1, 'a second ensure must never create a second requirement')
  assert.equal(second.outcome, 'unchanged')
  assert.deepEqual(calls, { find: 2, create: 1, update: 0 })
  assert.equal(rows.get('job_1')!.createdById, 'user_owner', 'the row author never changes')

  // A different job gets its own row.
  await ensureStaffingRequirement(tx, { jobId: 'job_2', booking, plan })
  assert.equal(rows.size, 2)
})

test('R2-3c: an owner-tuned requirement survives a replayed approval', async () => {
  // The owner assigned crew early and hand-tuned the requirement through
  // PATCH /api/admin/jobs/[id]/staffing: 5 workers, no driver (the customer is
  // driving), their own instructions. Then the booking is approved (or
  // re-approved), which replays the plan.
  const ownerRow: FakeRow = {
    jobId: 'job_tuned',
    requiredWorkers: 5,
    minWorkers: 4,
    requiredDrivers: 0,
    requiresLead: true,
    requiredSkills: ['HEAVY_ITEMS'],
    drivingRequired: false,
    customerProvidedTruck: true,
    heavyItems: true,
    workerInstructions: 'Owner: use the freight elevator, super has the key',
    estimatedStartAt: new Date('2026-09-10T13:00:00.000Z'),
    estimatedEndAt: new Date('2026-09-10T19:00:00.000Z'),
    createdById: 'user_owner',
  }
  const { tx, rows, calls } = makeFakeTx({ job_tuned: { ...ownerRow } })

  const res = await ensureStaffingRequirement(tx, {
    jobId: 'job_tuned',
    booking: bookingRow(),
    // A plan that disagrees with the owner about every one of those numbers.
    plan: makePlan({ crewSize: 3, minimumWorkers: 2, requiredDrivers: 1, workerInstructions: 'Park in the alley' }),
    updatedById: 'user_manager',
  })

  assert.equal(res.outcome, 'unchanged')
  assert.deepEqual(res.filled, [])
  assert.equal(calls.update, 0, 'nothing may be written when the row already exists')
  const after = rows.get('job_tuned')!
  assert.equal(after.requiredWorkers, 5, "the owner's crew size stands")
  assert.equal(after.minWorkers, 4)
  assert.equal(after.requiredDrivers, 0, "the owner's 'no driver' decision stands")
  assert.equal(after.drivingRequired, false)
  assert.equal(after.workerInstructions, 'Owner: use the freight elevator, super has the key')
  assert.deepEqual(after.requiredSkills, ['HEAVY_ITEMS'])
})

test('R2-3c: a NULL column on an existing row is filled, and only that column', async () => {
  // Filling a null adds information the owner never entered; it never
  // overwrites a decision they made.
  const { tx, rows, calls } = makeFakeTx({
    job_partial: {
      jobId: 'job_partial',
      requiredWorkers: 4,
      requiredDrivers: 0,
      estimatedStartAt: null,
      estimatedEndAt: null,
      workerInstructions: null,
      createdById: 'user_owner',
    },
  })

  const res = await ensureStaffingRequirement(tx, {
    jobId: 'job_partial',
    booking: bookingRow(),
    plan: makePlan({ crewSize: 2, workerInstructions: 'Park in the alley' }),
    updatedById: 'user_manager',
  })

  assert.equal(res.outcome, 'filled')
  assert.deepEqual(res.filled.sort(), ['estimatedEndAt', 'estimatedStartAt', 'workerInstructions'])
  assert.equal(calls.update, 1)
  const after = rows.get('job_partial')!
  assert.equal(after.requiredWorkers, 4, 'a non-null owner value is still untouched')
  assert.equal((after.estimatedStartAt as Date).toISOString(), '2026-09-10T13:00:00.000Z')
  assert.equal(after.workerInstructions, 'Park in the alley')
  assert.equal(after.updatedById, 'user_manager')
})

test('ensure: with no persisted plan it derives one from the booking (public bookings)', async () => {
  const { tx, rows } = makeFakeTx()
  const res = await ensureStaffingRequirement(tx, { jobId: 'job_pub', booking: bookingRow() })
  assert.equal(res.plan.source, 'derived')
  assert.equal(rows.size, 1)
  const row = rows.get('job_pub')!
  assert.equal(row.requiredWorkers, res.plan.crewSize)
  assert.equal(row.heavyItems, true)
  assert.equal(row.packing, true)
})

test('ensure: a day-level booking never gets an invented crew hour', async () => {
  // R2-1's guarantee, one layer down: confirmedDate / requestedDate are 00:00 ET
  // day anchors and must never become an estimatedStartAt.
  const { tx, rows } = makeFakeTx()
  const res = await ensureStaffingRequirement(tx, {
    jobId: 'job_day',
    booking: bookingRow({
      scheduledStart: null,
      scheduledEnd: null,
      startTimeKnown: false,
      confirmedDate: new Date('2026-01-15T05:00:00.000Z'), // midnight ET
    }),
  })
  assert.equal(res.data.estimatedStartAt, null)
  assert.equal(res.data.estimatedEndAt, null)
  const row = rows.get('job_day')!
  assert.equal(row.estimatedStartAt, null)
  assert.equal(row.estimatedEndAt, null)
})

// ── ITEM 1 / R2-3 — the stripe_link path end to end (offline, with fakes) ────

function adminInput(over: Record<string, unknown> = {}): AdminBookingInput {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const res = AdminBookingSchema.safeParse({
    customer: { name: 'Dana Mover', email: 'dana@example.com', phone: '862-640-0625' },
    move: {
      serviceType: '2br',
      moveDate: future,
      originAddress: { street: '12 Main St', city: 'West Orange', zip: '07052' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
      destStairFlights: 2,
      additionalStopsCount: 1,
    },
    services: { serviceMode: 'full_service', needsPacking: true },
    inventory: [{ name: 'Couch (3-seat)', quantity: 1 }],
    truckId: 'tr_1',
    pricing: { ownerTotal: 700, overrideReason: 'matched competitor quote' },
    // THE DEFAULT owner path — the one that used to lose its staffing plan.
    deposit: { mode: 'stripe_link' },
    crewInstructions: 'Park in the alley',
    ...over,
  })
  assert.ok(res.success, `fixture must parse: ${!res.success ? JSON.stringify(res.error.flatten()) : ''}`)
  return res.data
}

function makeApprovableBooking(): ApprovableBooking {
  return {
    id: 'bk_stripe',
    status: 'PENDING_APPROVAL',
    stripePaymentIntentId: 'pi_1',
    depositAmount: 4900,
    displayId: 'WMIC-2001',
    customerToken: 'tok_1',
    itemsDescription: '2 Bedroom move',
    arrivalWindow: '8:00-10:00 AM',
    totalEstimate: 700,
    originAddress: '12 Main St, West Orange, NJ 07052',
    destAddress: '99 Oak Ave, Montclair, NJ 07042',
    serviceAreaZone: 'primary',
    travelFee: 0,
    manualReviewRequired: false,
    requestedDate: new Date('2026-09-10T11:00:00.000Z'),
    confirmedDate: null,
    scheduledStart: null,
    scheduledEnd: null,
    estimatedHours: 6,
    customer: { name: 'Dana Mover', email: 'dana@example.com', phone: '+15555550123', locale: 'en' },
  }
}

type HarnessOpts = {
  /** Make the FIRST ensure throw, like a transient DB failure. */
  failFirstStaffing?: boolean
  /** Make every ensure throw. */
  failStaffing?: boolean
  /** The booking row the store would read (public-booking shapes go here). */
  row?: StaffingBookingRow
  /** Simulate migration 20260812000000 / 20260812010000 NOT applied: any select
   *  naming staffingPlan or startTimeKnown raises P2022. */
  newColumnsMissing?: boolean
}

/** An approval harness whose ensureStaffing runs the REAL spine — including the
 *  REAL two-tier column read — against fakes, exactly as prismaApprovalStore
 *  does in production. */
function makeApprovalHarness(persistedPlan: unknown, over: HarnessOpts = {}) {
  const { tx, rows, calls } = makeFakeTx()
  let booking = makeApprovableBooking()
  const errors: string[] = []
  const infos: unknown[] = []
  const selects: Prisma.BookingSelect[] = []
  let ensureAttempts = 0

  const dbRow: Record<string, unknown> = {
    ...(over.row ?? {
      id: 'bk_stripe',
      truckId: 'tr_1',
      truck: { source: 'RENTAL' },
      serviceMode: 'full_service',
      bedrooms: 2,
      inventoryItems: [],
    }),
    staffingPlan: persistedPlan,
  }

  // Stands in for `prisma.booking.findUnique({ where, select })`: returns only
  // the selected keys, and raises P2022 for a column the database lacks.
  const read = async (select: Prisma.BookingSelect): Promise<unknown> => {
    selects.push(select)
    if (over.newColumnsMissing && ('staffingPlan' in select || 'startTimeKnown' in select)) {
      throw Object.assign(
        new Error('The column `bookings.staffing_plan` does not exist in the current database.'),
        { code: 'P2022' },
      )
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(select)) if (key in dbRow) out[key] = dbRow[key]
    return out
  }

  const store: ApprovalStore = {
    async loadBooking() {
      return { ...booking }
    },
    async claimConfirm(_id, sched) {
      if (booking.status !== 'PENDING_APPROVAL') return 0
      booking = { ...booking, status: 'CONFIRMED', ...(sched ?? {}) }
      return 1
    },
    async rollbackClaim() {},
    async reloadStatus() {
      return { ...booking }
    },
    async commitApproval() {},
    async ensureStaffing() {
      ensureAttempts++
      if (over.failStaffing || (over.failFirstStaffing && ensureAttempts === 1)) {
        throw new Error('could not connect to the database')
      }
      const { booking: row, degraded, reason } = await loadStaffingBookingRow(read)
      assert.ok(row, 'the harness row must exist')
      const res = await ensureStaffingRequirement(tx, { jobId: 'job_stripe', booking: row })
      return {
        ensured: true,
        action: res.outcome,
        planSource: res.plan.source,
        requiredWorkers: res.data.requiredWorkers,
        requiredDrivers: res.data.requiredDrivers,
        ...(degraded ? { degraded, reason } : {}),
      }
    },
    async claimCancel() {
      return 1
    },
    async recordDecline() {},
  }
  const deps: ApprovalDeps = {
    store,
    stripe: {
      async capture(pi) {
        return { id: pi, amount_received: 4900, latest_charge: 'ch_1', metadata: {} }
      },
      async retrieveCharge() {
        return { id: 'ch_1', receipt_url: 'https://receipt.example/ch_1' }
      },
      async releaseHold() {},
    },
    notifier: { async sendApproved() {}, async sendDeclined() {} },
    logger: {
      info(obj) {
        infos.push(obj)
      },
      warn() {},
      error(obj) {
        errors.push(JSON.stringify(obj))
      },
    },
  }
  return { deps, rows, calls, errors, infos, selects, current: () => booking, attempts: () => ensureAttempts }
}

test('item 1: the stripe_link plan survives payment → approval and becomes the requirement', async () => {
  // 1. The owner books on the phone with the DEFAULT deposit mode. The booking
  //    is created PENDING_PAYMENT with NO job — only the plan is persisted.
  const input = adminInput()
  const plan = buildAdminStaffingPlan(
    input,
    [{ catalogItemId: null, name: 'Couch (3-seat)', quantity: 1, isHeavy: true, needsDisassembly: false, recommendedMovers: null, notes: null }],
    { truckSource: 'RENTAL' },
  )
  assert.equal(plan.source, 'admin_book_move')
  assert.equal(plan.truckAssigned, true)
  assert.equal(plan.flags.additionalStops, 1)
  assert.equal(plan.flags.packing, true)
  assert.equal(plan.flags.hasStairs, true)
  assert.equal(plan.workerInstructions, 'Park in the alley')

  // 2. Stripe hold paid → PENDING_APPROVAL → the owner approves.
  const persisted = JSON.parse(JSON.stringify(plan)) // what the JSON column returns
  const h = makeApprovalHarness(persisted)
  const res = await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.ok(res.ok && res.outcome === 'captured')

  // 3. The confirmed job has EXACTLY ONE requirement carrying the owner's plan.
  assert.equal(h.rows.size, 1)
  const row = h.rows.get('job_stripe')!
  assert.equal(row.requiredWorkers, plan.crewSize)
  assert.equal(row.minWorkers, plan.minimumWorkers)
  assert.equal(row.requiredDrivers, plan.requiredDrivers)
  assert.equal(row.rentalTruckPickup, true)
  assert.equal(row.customerProvidedTruck, false)
  assert.equal(row.packing, true)
  assert.equal(row.additionalStops, 1)
  assert.equal(row.workerInstructions, 'Park in the alley')

  // 4. Approving again (idempotent replay) re-runs the ensure — it is the
  //    repair path — and leaves exactly one, unmodified row.
  const again = await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.ok(again.ok && again.outcome === 'already_confirmed')
  assert.equal(h.attempts(), 2, 'the replay MUST call ensureStaffing — that is the repair mechanism')
  assert.equal(h.rows.size, 1)
  assert.deepEqual(h.calls, { find: 2, create: 1, update: 0 })
})

test('R2-3b: a failed ensure is REPAIRED by re-approving', async () => {
  // The exact scenario the round-1 test could not see: the first approval's
  // staffing write fails (transient DB error). The booking is CONFIRMED and the
  // $49 is captured — correctly — but there is no requirement. The owner's only
  // repair is to hit Approve again, which used to return at the
  // `already_confirmed` early return WITHOUT ever calling ensure again.
  const h = makeApprovalHarness(null, { failFirstStaffing: true })

  const first = await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.ok(first.ok && first.outcome === 'captured', 'a staffing failure must never block the capture')
  assert.equal(h.current().status, 'CONFIRMED')
  assert.equal(h.rows.size, 0, 'precondition: the first ensure really did fail')
  assert.ok(h.errors.some((e) => /bk_stripe/.test(e)), 'the failure must be logged, not swallowed')

  // Re-approve. The booking is already CONFIRMED, so nothing is re-captured —
  // but the requirement MUST now exist.
  const second = await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.ok(second.ok && second.outcome === 'already_confirmed')
  assert.equal(second.ok && second.capturedCents, null, 'no second capture')
  assert.equal(h.rows.size, 1, 'the replay must create the missing staffing requirement')
  assert.equal(h.calls.create, 1)
  assert.ok((h.rows.get('job_stripe')!.requiredWorkers as number) >= 2)

  // A third approval is still safe: one row, nothing rewritten.
  await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.equal(h.rows.size, 1)
  assert.deepEqual({ create: h.calls.create, update: h.calls.update }, { create: 1, update: 0 })
})

test('R2-3a: an UNAPPLIED migration still leaves the job staffed (derived plan)', async () => {
  // The normal deploy state here is code-before-SQL. Selecting `staffingPlan`
  // then raises P2022 and used to kill the ENTIRE ensure — including the derived
  // path, which needs none of the new columns. Result: $49 captured, job
  // created, no staffing requirement, for the whole deploy window.
  const h = makeApprovalHarness({ crewSize: 4, estimatedHoursMax: 8 }, { newColumnsMissing: true })

  const res = await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.ok(res.ok && res.outcome === 'captured')

  assert.equal(h.rows.size, 1, 'the requirement must still be created without the new columns')
  const row = h.rows.get('job_stripe')!
  assert.ok((row.requiredWorkers as number) >= 2)
  assert.equal(row.requiredDrivers, 1, 'a fleet truck is on this job, so a driver is staffed')

  // It fell back to the pre-migration select, and said so honestly.
  assert.equal(h.selects.length, 2, 'one attempt with the new columns, one without')
  assert.ok('staffingPlan' in h.selects[0])
  assert.ok(!('staffingPlan' in h.selects[1]) && !('startTimeKnown' in h.selects[1]))
  assert.ok(
    h.infos.some((i) => (i as { degraded?: boolean }).degraded === true),
    'the degraded read must be reported, not hidden',
  )
  // The plan could not be read, so it was DERIVED — never silently treated as
  // the owner's captured plan.
  assert.ok(h.infos.some((i) => (i as { planSource?: string }).planSource === 'derived'))
})

test('R2-3a: the column ladder degrades ONLY for migration errors', async () => {
  assert.equal(isMigrationMissing(Object.assign(new Error('x'), { code: 'P2022' })), true)
  assert.equal(isMigrationMissing(Object.assign(new Error('x'), { code: 'P2021' })), true)
  assert.equal(isMigrationMissing(new Error('relation "jobs" does not exist')), true)
  assert.equal(isMigrationMissing(new Error('connection terminated')), false)

  // A real outage must NOT be mistaken for a missing column and answered with a
  // silently degraded plan — it has to propagate to the caller's fail-soft wrap.
  await assert.rejects(
    () => loadStaffingBookingRow(async () => { throw new Error('connection terminated unexpectedly') }),
    /connection terminated/,
  )

  // And a healthy database takes the full select in one call.
  let calls = 0
  const ok = await loadStaffingBookingRow(async () => {
    calls++
    return { id: 'bk_1', staffingPlan: null, startTimeKnown: false }
  })
  assert.equal(calls, 1)
  assert.equal(ok.degraded, false)
  assert.equal(ok.booking?.startTimeKnown, false)
})

test('R2-4 + R2-3: approving a PUBLIC booking staffs it without a driver', async () => {
  // The highest-volume path, end to end: a public booking (serviceMode null, no
  // fleet truck, customer's own truck) pays the $49 hold and is approved.
  const h = makeApprovalHarness(null, { row: publicBookingRow({ id: 'bk_stripe' }) })

  const res = await approveBooking({ actor: { name: 'Diego' }, source: 'discord', notify: false }, h.deps)
  assert.ok(res.ok && res.outcome === 'captured')

  assert.equal(h.rows.size, 1, 'a public booking must get a staffing requirement at all (item 1)')
  const row = h.rows.get('job_stripe')!
  assert.ok((row.requiredWorkers as number) >= 2)
  assert.equal(row.requiredDrivers, 0, 'we are not driving this job — MISSING_DRIVER must not fire')
  assert.equal(row.drivingRequired, false)
  assert.equal(row.customerProvidedTruck, true)
  assert.deepEqual(row.requiredSkills, [])
})

test('item 1: a staffing failure NEVER blocks the capture or the confirmation', async () => {
  const h = makeApprovalHarness(null, { failStaffing: true })
  const res = await approveBooking({ actor: { name: 'Diego' }, source: 'admin', notify: false }, h.deps)
  assert.ok(res.ok, 'approval must still succeed when staffing blows up')
  assert.equal(res.ok && res.outcome, 'captured')
  assert.equal(res.ok && res.capturedCents, 4900)
  assert.equal(h.current().status, 'CONFIRMED')
  assert.equal(h.rows.size, 0)
  assert.ok(h.errors.some((e) => /bk_stripe/.test(e)), 'the failure must be logged, not swallowed silently')
})

// ── The admin CONFIRMED path uses the SAME spine ─────────────────────────────

test('item 4: the admin create path is service-mode aware too (labor-only, no truck)', () => {
  const input = adminInput({
    services: { serviceMode: 'labor_only', needsPacking: false },
    truckId: undefined,
    deposit: { mode: 'collect_on_day' },
  })
  const plan = buildAdminStaffingPlan(input, [])
  assert.equal(plan.serviceMode, 'labor_only')
  assert.equal(plan.truckAssigned, false)
  assert.equal(plan.customerProvidedTruck, true)
  assert.equal(plan.requiredDrivers, 0)
  assert.deepEqual(plan.requiredSkills, [])
  assert.ok(plan.notes.some((n) => /customer provides transportation/i.test(n)))

  // The columns that reach dispatch carry it through.
  const data = staffingRequirementDataFromPlan(plan, { jobId: 'job_x', estimatedStartAt: null })
  assert.equal(data.requiredDrivers, 0)
  assert.equal(data.customerProvidedTruck, true)
  assert.equal(data.drivingRequired, false)
  assert.deepEqual(data.requiredSkills, [])
})
