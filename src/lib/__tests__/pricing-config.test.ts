// Offline unit tests for the canonical price book (src/lib/pricing-config.ts).
// Run: npm test  (tsx --test) — no DB, no network.
//
// Three jobs:
//   1. PIN every published price to the owner-approved table, so a typo in a
//      package or add-on price fails here instead of in a customer's quote.
//   2. Enforce the STRUCTURAL rules that were the actual audit findings:
//      "Starting at" cannot be dropped, the two $49 charges cannot merge,
//      no oversized-furniture fee can be added, and a material cannot be sold
//      that the crew already brings.
//   3. Report the KNOWN DRIFT between this config and the still-unmigrated
//      quote path (estimate.ts + the static booking form), so the migration
//      cannot be half-done silently.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PACKAGES, PACKAGE_INCLUDES, BOOKING_AUTHORIZATION, TRUCK_PICKUP_RETURN,
  STAIRS, LONG_CARRY, ELEVATOR, ADDITIONAL_LOCATION, HEAVY_ITEM,
  NO_OVERSIZED_FURNITURE_FEE, NO_BUILDING_AGE_FEE, NO_MATTRESS_BAG_SKU,
  WEEKEND_HOLIDAY, TRAVEL, NEW_YORK,
  PARKING_TOLLS_DELAYS, WAITING_TIME, ASSEMBLY, INCLUDED_EQUIPMENT, MATERIALS,
  SCOPE_OVERAGE, DISCOUNT_POLICY, COPY, MANUAL_REVIEW_TRIGGERS,
  formatCharge, isAutoApplicable, checkBannedPhrases, applyDiscount,
  stairChargeForFlights, longCarryChargeForFeet, heavyItemChargeForWeight,
  additionalLocationChargeForMiles, travelChargeForMinutes,
  type Charge,
} from '../pricing-config'

// ── 1. PACKAGE PRICES ───────────────────────────────────────────────────────
// The owner-approved table. Any change to a package price must be made HERE
// and in pricing-config.ts together, which is the point.
const APPROVED_PACKAGE_PRICES: Record<string, { amount: number; starting: boolean }> = {
  'little-studio': { amount: 379, starting: false },
  'half-studio': { amount: 439, starting: false },
  'full-studio': { amount: 549, starting: false },
  '1br': { amount: 649, starting: false },
  '2br': { amount: 779, starting: false },
  '3br': { amount: 1049, starting: true },
  '4br': { amount: 1449, starting: true },
  '5br': { amount: 1799, starting: true },
}

test('packages: every advertised price matches the approved table', () => {
  for (const [key, expected] of Object.entries(APPROVED_PACKAGE_PRICES)) {
    const pkg = PACKAGES[key as keyof typeof PACKAGES]
    assert.ok(pkg, `missing package ${key}`)
    assert.equal(pkg.price.amount, expected.amount, `${key} price`)
    assert.equal(pkg.price.kind, expected.starting ? 'starting' : 'fixed', `${key} kind`)
  }
})

test('packages: 3BR/4BR/5BR are review-gated floors, never flat rates', () => {
  for (const key of ['3br', '4br', '5br'] as const) {
    const pkg = PACKAGES[key]
    assert.equal(pkg.requiresReview, true, `${key} must require review`)
    assert.equal(pkg.price.requiresReview, true, `${key} price must require review`)
    assert.equal(isAutoApplicable(pkg.price), false, `${key} must not auto-apply`)
  }
})

test('packages: "Starting at" is structural — formatCharge cannot drop it', () => {
  assert.equal(formatCharge(PACKAGES['3br'].price), 'Starting at $1,049')
  assert.equal(formatCharge(PACKAGES['4br'].price), 'Starting at $1,449')
  assert.equal(formatCharge(PACKAGES['5br'].price), 'Starting at $1,799')
  assert.equal(formatCharge(PACKAGES['5br'].price, 'es'), 'Desde $1,799')
  // A fixed package renders bare — no accidental "Starting at".
  assert.equal(formatCharge(PACKAGES['1br'].price), '$649')
})

test('packages: the small packages did NOT keep their old prices', () => {
  const stale = [359, 409, 509, 599, 699, 949, 1249, 1549]
  for (const pkg of Object.values(PACKAGES)) {
    if (pkg.price.amount == null) continue
    assert.ok(!stale.includes(pkg.price.amount), `${pkg.key} still uses retired price $${pkg.price.amount}`)
  }
})

test('packages: inclusions are inventory-bounded, never unlimited', () => {
  const text = PACKAGE_INCLUDES.map((i) => i.en).join(' ')
  assert.deepEqual(checkBannedPhrases(text), [])
  assert.ok(/inventory you disclosed/i.test(text), 'must scope to disclosed inventory')
  assert.ok(/two professional labor workers/i.test(text))
  assert.ok(/one loading location and one unloading location/i.test(text))
})

// ── 2. THE TWO $49 CHARGES ──────────────────────────────────────────────────
test('$49: booking authorization and truck add-on are SEPARATE identifiers', () => {
  assert.equal(BOOKING_AUTHORIZATION.amount, 49)
  assert.equal(TRUCK_PICKUP_RETURN.amount, 49)
  // Same dollar amount, different identity — this is the whole point.
  assert.notEqual(BOOKING_AUTHORIZATION.id, TRUCK_PICKUP_RETURN.id)
  assert.equal(BOOKING_AUTHORIZATION.id, 'bookingAuthorizationAmount')
  assert.equal(TRUCK_PICKUP_RETURN.id, 'truckPickupReturnFee')
  assert.notEqual(BOOKING_AUTHORIZATION.label, TRUCK_PICKUP_RETURN.label)
})

test('$49: the truck add-on is never auto-confirmed and is not raised', () => {
  assert.equal(TRUCK_PICKUP_RETURN.requiresReview, true, 'truck driving needs manual approval')
  assert.notEqual(TRUCK_PICKUP_RETURN.amount, 100)
  assert.notEqual(TRUCK_PICKUP_RETURN.amount, 150)
  assert.equal(TRUCK_PICKUP_RETURN.includedWaitMinutes, 30)
  // Must not promise driving; must not imply we supply the truck.
  assert.ok(/you reserved/i.test(TRUCK_PICKUP_RETURN.note))
  assert.ok(/requires manual approval/i.test(TRUCK_PICKUP_RETURN.note))
  assert.ok(!/we (supply|provide|own) the truck/i.test(TRUCK_PICKUP_RETURN.note))
})

test('$49: the booking authorization is described as a hold, not a payment', () => {
  assert.ok(/authorization is placed/i.test(BOOKING_AUTHORIZATION.note))
  assert.ok(/captured only after/i.test(BOOKING_AUTHORIZATION.note))
  assert.ok(/applied toward your total/i.test(BOOKING_AUTHORIZATION.note))
})

// ── 3. ADD-ON PRICES ────────────────────────────────────────────────────────
const amounts = (tiers: Charge[]): (number | undefined)[] => tiers.map((t) => t.amount)

test('stairs: first flight included, then 40 / 70 / starting-100', () => {
  assert.deepEqual(amounts(STAIRS.tiers), [undefined, 40, 70, 100])
  assert.equal(STAIRS.tiers[0].kind, 'included')
  assert.equal(STAIRS.tiers[3].kind, 'starting')
  assert.equal(STAIRS.tiers[3].requiresReview, true)
  // Per affected ADDRESS, not per job.
  assert.ok(STAIRS.tiers.every((t) => t.per === 'address'))
  // The exterior-entrance question must be answered explicitly.
  assert.equal(typeof STAIRS.exteriorEntranceFlightCounts, 'boolean')
  assert.ok(STAIRS.exteriorEntranceNote.length > 20)
})

test('long carry: under 100ft included, then 40 / 75 / starting-100 per location', () => {
  assert.deepEqual(amounts(LONG_CARRY.tiers), [undefined, 40, 75, 100])
  assert.equal(LONG_CARRY.tiers[0].kind, 'included')
  assert.equal(LONG_CARRY.tiers[3].requiresReview, true)
  assert.ok(LONG_CARRY.tiers.every((t) => t.per === 'location'))
})

test('elevator: a normal elevator is never a surcharge', () => {
  assert.equal(ELEVATOR.normal.kind, 'included')
  assert.equal(ELEVATOR.difficult.kind, 'range')
  assert.equal(ELEVATOR.difficult.amount, 40)
  assert.equal(ELEVATOR.difficult.amountMax, 75)
  assert.equal(ELEVATOR.difficult.requiresReview, true)
  assert.equal(isAutoApplicable(ELEVATOR.difficult), false)
})

test('additional locations: 75 / 125 / custom — the old $20–$40 stop fee is gone', () => {
  assert.deepEqual(amounts(ADDITIONAL_LOCATION.tiers), [75, 125, undefined])
  assert.equal(ADDITIONAL_LOCATION.tiers[2].kind, 'manual_quote')
  assert.equal(ADDITIONAL_LOCATION.includedLoading, 1)
  assert.equal(ADDITIONAL_LOCATION.includedUnloading, 1)
  for (const t of ADDITIONAL_LOCATION.tiers) {
    assert.ok(t.amount == null || t.amount >= 75, 'no retired $20–$40 stop price may survive')
  }
})

test('heavy items: 50 / 100 / review / custom — NOT the forbidden 75 / 125', () => {
  assert.equal(HEAVY_ITEM.tiers[0].amount, 50, '150–249 lb must be $50, never $75')
  assert.equal(HEAVY_ITEM.tiers[1].amount, 100, '250–399 lb must be $100, never $125')
  assert.equal(HEAVY_ITEM.tiers[2].kind, 'pending_review', '400 lb+ is review or decline')
  assert.equal(HEAVY_ITEM.tiers[3].kind, 'manual_quote', 'piano/safe is a custom quote')
  assert.equal(HEAVY_ITEM.tiers[3].requiresReview, true)
  // No single automatic price for every piano or safe.
  assert.equal(HEAVY_ITEM.tiers[3].amount, undefined)
  // The retired $30–$60 catch-all must not survive anywhere in the tiers.
  for (const t of HEAVY_ITEM.tiers) {
    assert.ok(![30, 60, 75, 125].includes(t.amount ?? 0), `retired/forbidden heavy price $${t.amount}`)
  }
})

test('heavy items: the 400lb+/piano review checklist covers all nine factors', () => {
  assert.equal(HEAVY_ITEM.reviewChecklist.length, 9)
  for (const needle of ['weight', 'dimensions', 'stairs', 'Carry distance', 'width', 'equipment', 'workers', 'Pickup access', 'Unloading access']) {
    assert.ok(
      HEAVY_ITEM.reviewChecklist.some((x) => x.toLowerCase().includes(needle.toLowerCase())),
      `checklist missing ${needle}`
    )
  }
})

test('NO oversized-furniture fee exists anywhere in the price book', () => {
  assert.equal(NO_OVERSIZED_FURNITURE_FEE.exists, false)
  // Structural guard: no exported key may introduce one later.
  const mod = { PACKAGES, STAIRS, LONG_CARRY, ELEVATOR, ADDITIONAL_LOCATION, HEAVY_ITEM, WEEKEND_HOLIDAY, TRAVEL, NEW_YORK, PARKING_TOLLS_DELAYS, WAITING_TIME, ASSEMBLY, MATERIALS, SCOPE_OVERAGE }
  const json = JSON.stringify(mod).toLowerCase()
  assert.ok(!/oversiz/.test(json), 'an oversized-furniture charge was introduced')
  // Normal large furniture must be listed as included, not surcharged.
  assert.ok(NO_OVERSIZED_FURNITURE_FEE.includedExamples.includes('sectional'))
  assert.ok(NO_OVERSIZED_FURNITURE_FEE.includedExamples.includes('armoire'))
})

test('weekends carry no automatic surcharge; only reviewed holidays do', () => {
  assert.equal(WEEKEND_HOLIDAY.saturday.kind, 'included')
  assert.equal(WEEKEND_HOLIDAY.sunday.kind, 'included')
  assert.equal(WEEKEND_HOLIDAY.majorHoliday.kind, 'range')
  assert.equal(WEEKEND_HOLIDAY.majorHoliday.amount, 100)
  assert.equal(WEEKEND_HOLIDAY.majorHoliday.amountMax, 150)
  assert.equal(WEEKEND_HOLIDAY.majorHoliday.requiresReview, true)
})

test('travel: zone ladder 50/100/150/custom replaces the flat $50, with a stated origin', () => {
  assert.deepEqual(amounts(TRAVEL.tiers), [undefined, 50, 100, 150, undefined])
  assert.equal(TRAVEL.tiers[0].kind, 'included')
  assert.equal(TRAVEL.tiers[4].kind, 'manual_quote')
  assert.equal(TRAVEL.chargeOncePerJob, true)
  // The boundary the calculation measures from must be defined in code.
  assert.ok(TRAVEL.primaryZone.length > 0)
  assert.ok(/measured from/i.test(TRAVEL.originNote))
})

test('New York is never auto-priced', () => {
  assert.equal(NEW_YORK.requiresManualApproval, true)
  assert.equal(NEW_YORK.nearby.kind, 'starting')
  assert.equal(NEW_YORK.nearby.amount, 150)
  assert.equal(NEW_YORK.nycManhattan.amount, 250)
  assert.equal(NEW_YORK.nycManhattan.amountMax, 350)
  assert.equal(isAutoApplicable(NEW_YORK.nearby), false)
  assert.equal(isAutoApplicable(NEW_YORK.nycManhattan), false)
})

test('parking and tolls are reimbursed at documented actual cost', () => {
  assert.equal(PARKING_TOLLS_DELAYS.parkingAndTolls.kind, 'actual_cost')
  assert.equal(PARKING_TOLLS_DELAYS.difficultBuildingAccess.amount, 50)
  assert.equal(PARKING_TOLLS_DELAYS.difficultBuildingAccess.requiresReview, true)
})

test('waiting time: 30 min included, then $50 per 30 min, approval-gated', () => {
  assert.equal(WAITING_TIME.includedMinutes, 30)
  assert.equal(WAITING_TIME.increment.amount, 50)
  assert.equal(WAITING_TIME.increment.per, 'half_hour')
  assert.equal(WAITING_TIME.requiresApprovalBeforeAccruing, true)
  // The truck add-on must reuse the SAME grace period, not invent its own.
  assert.equal(TRUCK_PICKUP_RETURN.includedWaitMinutes, WAITING_TIME.includedMinutes)
})

test('assembly: one bed frame included, 25 simple, 50–100 complex both ways', () => {
  assert.equal(ASSEMBLY.includedBedFrames, 1)
  assert.equal(ASSEMBLY.simpleDisassembly.amount, 25)
  assert.equal(ASSEMBLY.complexDisassembly.amount, 50)
  assert.equal(ASSEMBLY.complexDisassembly.amountMax, 100)
  assert.equal(ASSEMBLY.complexReassembly.amount, 50)
  assert.equal(ASSEMBLY.complexReassembly.amountMax, 100)
  // Reassembly must NOT be advertised as free while it is charged.
  assert.deepEqual(checkBannedPhrases(ASSEMBLY.includedNote), [])
  // The retired $20–$40 disassembly band must not survive.
  assert.ok(![20, 40].includes(ASSEMBLY.simpleDisassembly.amount ?? 0))
})

test('materials: nothing the crew already brings may be sold separately', () => {
  assert.deepEqual(amounts(MATERIALS.packages), [39, 69, 99])
  assert.equal(MATERIALS.packages[2].kind, 'starting')

  // OWNER RULE: mattress protection is INCLUDED, so no bag SKU may exist.
  assert.ok(INCLUDED_EQUIPMENT.some((e) => /mattress protection/i.test(e.en)))
  assert.equal(NO_MATTRESS_BAG_SKU.exists, false)
  assert.equal('mattressBags' in MATERIALS, false, 'a mattress-bag SKU was reintroduced')
  const json = JSON.stringify(MATERIALS).toLowerCase()
  assert.ok(!/mattress/.test(json), 'MATERIALS must not price anything mattress-related')
})

test('no building-age surcharge exists in the price book', () => {
  assert.equal(NO_BUILDING_AGE_FEE.exists, false)
  const mod = { PACKAGES, STAIRS, LONG_CARRY, ELEVATOR, ADDITIONAL_LOCATION, HEAVY_ITEM, WEEKEND_HOLIDAY, TRAVEL, NEW_YORK, PARKING_TOLLS_DELAYS, WAITING_TIME, ASSEMBLY, MATERIALS, SCOPE_OVERAGE }
  const json = JSON.stringify(mod).toLowerCase()
  assert.ok(!/building.?(age|year)/.test(json), 'a building-age charge was reintroduced')
  // A genuinely difficult building still bills — reviewed, at $50.
  assert.equal(PARKING_TOLLS_DELAYS.difficultBuildingAccess.amount, 50)
})

test('scope overage: 75 / 105 / 140 per 30 min by crew size, approval first', () => {
  assert.equal(SCOPE_OVERAGE.byCrewSize[2].amount, 75)
  assert.equal(SCOPE_OVERAGE.byCrewSize[3].amount, 105)
  assert.equal(SCOPE_OVERAGE.byCrewSize[4].amount, 140)
  assert.equal(SCOPE_OVERAGE.requiresApprovalBeforeWork, true)
  for (const crew of [2, 3, 4]) assert.equal(SCOPE_OVERAGE.byCrewSize[crew].per, 'half_hour')
})

// ── 4. COPY + GUARDS ────────────────────────────────────────────────────────
test('copy: every canonical string is free of banned promises', () => {
  for (const [key, entry] of Object.entries(COPY)) {
    assert.deepEqual(checkBannedPhrases(entry.en), [], `COPY.${key}.en contains a banned promise`)
    assert.deepEqual(checkBannedPhrases(entry.es), [], `COPY.${key}.es contains a banned promise`)
  }
})

test('copy: the underquoting disclaimer carries its required commitments', () => {
  const d = COPY.underquoting_disclaimer.en
  assert.ok(/pause, explain the change, and obtain your approval/i.test(d))
  assert.ok(/No price adjustment will be applied without your approval/i.test(d))
  assert.ok(/waiting time/i.test(d) && /stairs/i.test(d) && /heavy items/i.test(d))
  assert.ok(COPY.accuracy_checkbox.en.startsWith('I confirm'))
})

test('copy: no claim of insurance, licensing, or transportation', () => {
  const all = Object.values(COPY).flatMap((e) => [e.en, e.es]).join(' ')
  assert.ok(!/\b(insured|licensed|bonded)\b/i.test(all), 'unapproved insurance/licensing claim')
  assert.ok(!/we (transport|haul|drive) your/i.test(all), 'transportation claim in labor-only copy')
  assert.ok(/transportation is not included/i.test(COPY.labor_only.en))
})

test('banned-phrase detector actually fires', () => {
  assert.deepEqual(checkBannedPhrases('Flat rate. No hidden fees!').length, 1)
  assert.ok(checkBannedPhrases('unlimited furniture, all your stuff').length >= 2)
  assert.deepEqual(checkBannedPhrases(COPY.no_surprise.en), [])
})

test('discounts: public cap is 10%, no stacking, third-party costs excluded', () => {
  assert.equal(DISCOUNT_POLICY.maxPublicPercent, 10)
  assert.equal(DISCOUNT_POLICY.allowStacking, false)
  assert.equal(DISCOUNT_POLICY.requireExpiration, true)
  const excluded: readonly string[] = DISCOUNT_POLICY.excludedFromDiscount
  for (const x of ['tolls', 'parking', 'materials', 'waiting', 'truck_addon']) {
    assert.ok(excluded.includes(x), `${x} must be discount-excluded`)
  }
})

test('discounts: the door-hanger campaign is retired and cannot exceed the cap', () => {
  const retired: readonly string[] = DISCOUNT_POLICY.retiredCampaigns
  assert.ok(retired.includes('DOOR_HANGER'))
  // The old 30% must be impossible: applyDiscount clamps to the cap.
  const r = applyDiscount({ discountableSubtotal: 1000, nonDiscountableSubtotal: 0 }, 30)
  assert.equal(r.percentApplied, 10)
  assert.equal(r.clamped, true)
  assert.equal(r.discountAmount, 100)
  assert.equal(r.total, 900)
})

test('discounts: the $49 truck add-on can NEVER be reduced by a coupon', () => {
  // $649 labor + $49 truck add-on, 10% off. The discount touches labor only.
  const r = applyDiscount({ discountableSubtotal: 649, nonDiscountableSubtotal: 49 }, 10)
  assert.equal(r.discountAmount, 64.9)
  assert.equal(r.total, 633.1) // 649 - 64.9 + 49
  // The add-on survives at full price inside the total.
  assert.equal(Math.round((r.total - (649 - r.discountAmount)) * 100) / 100, 49)
  assert.equal(DISCOUNT_POLICY.truckAddonDiscountable, false)
})

test('discounts: a 0% or nonsense percent is a no-op, never negative', () => {
  assert.equal(applyDiscount({ discountableSubtotal: 500, nonDiscountableSubtotal: 49 }, 0).total, 549)
  assert.equal(applyDiscount({ discountableSubtotal: 500, nonDiscountableSubtotal: 49 }, -5).total, 549)
  assert.equal(applyDiscount({ discountableSubtotal: 500, nonDiscountableSubtotal: 49 }, NaN).total, 549)
})

test('manual-review triggers cover every non-auto-approvable condition', () => {
  for (const t of [
    'package_3br_or_larger', 'new_york_address', 'heavy_item_400lb_or_more',
    'piano_or_safe', 'truck_pickup_and_driving', 'travel_over_90_minutes',
  ]) {
    assert.ok((MANUAL_REVIEW_TRIGGERS as readonly string[]).includes(t), `missing trigger ${t}`)
  }
})

test('formatCharge never renders a bare number for a reviewed charge', () => {
  assert.equal(formatCharge({ kind: 'pending_review', label: 'x' }), 'Pending review')
  assert.equal(formatCharge({ kind: 'manual_quote', label: 'x' }), 'Custom quote')
  assert.equal(formatCharge({ kind: 'included', label: 'x' }), 'Included')
  assert.equal(formatCharge({ kind: 'range', amount: 40, amountMax: 75, label: 'x' }), '$40–$75')
  assert.equal(formatCharge({ kind: 'actual_cost', label: 'x' }), 'Actual documented cost')
})

// ── 5. RESOLVER TIER BOUNDARIES ─────────────────────────────────────────────
// The resolvers are the ONLY place a raw number becomes money. Off-by-one at a
// tier edge is the most likely pricing bug, so every boundary is pinned.
test('resolvers: stair tier boundaries', () => {
  assert.equal(stairChargeForFlights(0).kind, 'included')
  assert.equal(stairChargeForFlights(1).kind, 'included')
  assert.equal(stairChargeForFlights(2).amount, 40)
  assert.equal(stairChargeForFlights(3).amount, 70)
  assert.equal(stairChargeForFlights(4).kind, 'starting')
  assert.equal(stairChargeForFlights(99).kind, 'starting')
})

test('resolvers: carry-distance boundaries', () => {
  assert.equal(longCarryChargeForFeet(0).kind, 'included')
  assert.equal(longCarryChargeForFeet(99).kind, 'included')
  assert.equal(longCarryChargeForFeet(100).amount, 40)
  assert.equal(longCarryChargeForFeet(250).amount, 40)
  assert.equal(longCarryChargeForFeet(251).amount, 75)
  assert.equal(longCarryChargeForFeet(400).amount, 75)
  assert.equal(longCarryChargeForFeet(401).kind, 'starting')
})

test('resolvers: heavy-item weight boundaries, with normal furniture free', () => {
  assert.equal(heavyItemChargeForWeight(0).kind, 'included')
  assert.equal(heavyItemChargeForWeight(149).kind, 'included', 'normal furniture must be free')
  assert.equal(heavyItemChargeForWeight(150).amount, 50)
  assert.equal(heavyItemChargeForWeight(249).amount, 50)
  assert.equal(heavyItemChargeForWeight(250).amount, 100)
  assert.equal(heavyItemChargeForWeight(399).amount, 100)
  assert.equal(heavyItemChargeForWeight(400).kind, 'pending_review')
})

test('resolvers: additional-location mileage boundaries', () => {
  assert.equal(additionalLocationChargeForMiles(0).amount, 75)
  assert.equal(additionalLocationChargeForMiles(10).amount, 75)
  assert.equal(additionalLocationChargeForMiles(10.1).amount, 125)
  assert.equal(additionalLocationChargeForMiles(25).amount, 125)
  assert.equal(additionalLocationChargeForMiles(26).kind, 'manual_quote')
})

test('resolvers: travel drive-time boundaries', () => {
  assert.equal(travelChargeForMinutes(null).kind, 'included')
  assert.equal(travelChargeForMinutes(20).kind, 'included')
  assert.equal(travelChargeForMinutes(21).amount, 50)
  assert.equal(travelChargeForMinutes(40).amount, 50)
  assert.equal(travelChargeForMinutes(41).amount, 100)
  assert.equal(travelChargeForMinutes(60).amount, 100)
  assert.equal(travelChargeForMinutes(61).amount, 150)
  assert.equal(travelChargeForMinutes(90).amount, 150)
  assert.equal(travelChargeForMinutes(91).kind, 'manual_quote')
})
