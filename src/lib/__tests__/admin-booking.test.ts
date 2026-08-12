import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AdminBookingSchema,
  adminPortalTokenExpiry,
  bedroomsFromServiceType,
  buildBookingCreateData,
  buildStaffingRequirementData,
  collectBookingWarnings,
  composeAddress,
  decideStatus,
  requiresOverrideReason,
  resolveInventorySnapshots,
  synthesizePlaceholderEmail,
  type AdminBookingInput,
  type CatalogSnapshotSource,
} from '../admin-booking'
import { computeEstimate } from '../estimate'

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
  assert.equal(d.customer.locale, 'en')
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
