// ════════════════════════════════════════════════════════════════════════
//  labor-only-booking.test.ts — THE OWNER ACCEPTANCE CRITERIA for the
//  2026-08-14 labor-only booking fixes, asserted against booking WMIC-1019.
//
//  WMIC-1019, exactly as it arrived:
//    • Service: 1 Bedroom ($550)      • Truck: customer-provided
//    • 15 boxes, 2 beds, 3 dressers, 2 sofas, 2 tables/chairs, 2 TVs,
//      2 standing mirrors, assembly/disassembly needed
//    • FIRST_TIME_AUTO 10% already applied; the customer also asked for MOVE10
//    • $49 authorized, $0 captured
//    • "1000 Executive Dr apt 443a" with the Apartment/Unit field showing "—"
//    • No photos, no COI answer, no furniture named for the assembly
//
//  Every number below is the owner's own arithmetic. Offline and pure — no
//  database, no network, no API key.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveServiceShape, laborOnlyChargeViolations, isLaborOnly } from '../service-shape'
import { assessInventory, parseInventoryText, toInventory, mergeInventory, suggestedPackage, inventoryCubicFeet, INVENTORY_WARNING } from '../inventory'
import { resolveDiscount, isDuplicatePromotion } from '../discount-rules'
import { computeQuote } from '../booking-quote'
import { parseAddressUnit, normalizeAddressAndUnit } from '../address'
import { resolveBookingScope, BANNERS, normalizeCoi } from '../booking-scope'
import { evaluateApproval, isPriceChange, describePriceChange } from '../approval-guards'

/** WMIC-1019 as the database holds it today: nothing structured, everything
 *  in the legacy blob. Nothing here has been back-filled. */
const WMIC_1019 = {
  originAddress: '1000 Executive Dr apt 443a, West Orange, NJ 07052',
  destAddress: '85 Livingston Avenue apt 427, New Brunswick, NJ 08901',
  originUnit: null,
  destUnit: null,
  itemsDescription: 'Service: 1 Bedroom\nTruck: Customer provides truck ($0)\nEstimated moving total: $550',
  customerNotes:
    'Inventory: 15 boxes, 2 beds/mattresses, 3 dressers, 2 sofas, 2 tables/chairs, 2 TVs, 2 standing mirrors, assembly/disassembly needed.',
  baseRate: 550,
  totalEstimate: 550,
  travelFee: 0,
  truckAddonDueOnMoveDay: false,
  truckAddonAmount: 0,
  discountType: 'FIRST_TIME_AUTO',
  discountPercent: 10,
  depositAmount: 4900,
  depositPaid: false,
  photoCount: 0,
}

// ══════════════════════════════════════════════════════════════════════
//  1. LABOR IS NOT THE TRUCK, AND THE SIZE IS NEITHER
// ══════════════════════════════════════════════════════════════════════

test('a customer-provided truck makes the job LABOR ONLY, and the size survives', () => {
  const shape = resolveServiceShape(WMIC_1019)
  assert.equal(shape.serviceType, 'labor_only')
  assert.equal(shape.serviceTypeLabel, 'Labor Only')
  // The size is not discarded — it is what scopes the crew and the price.
  assert.equal(shape.moveSizeKey, '1br')
  assert.equal(shape.moveSizeLabel, '1 Bedroom')
  assert.equal(shape.truckProvider, 'customer')
  // The one fact every truck-shaped cost is gated on.
  assert.equal(shape.companyTruckIncluded, false)
  // Derived, not stored — so it explains itself to the owner.
  assert.equal(shape.explicit, false)
  assert.match(shape.reason, /customer-provided truck/i)
})

test('a stored service type always beats inference, in both directions', () => {
  assert.equal(resolveServiceShape({ serviceTypeKey: 'labor_only', truckProvider: 'WMIWCI' }).serviceType, 'labor_only')
  assert.equal(resolveServiceShape({ serviceTypeKey: 'full_service', truckProvider: 'customer' }).serviceType, 'full_service')
  // An explicit full-service booking is never reported as running on the
  // customer's truck, whatever a stale provider string says.
  assert.equal(resolveServiceShape({ serviceTypeKey: 'full_service', truckProvider: 'customer' }).truckProvider, 'company')
})

test('a rental brand in the free-text provider field means the customer supplies it', () => {
  for (const brand of ['U-Haul', 'uhaul', 'Penske', 'Budget', 'my truck', 'rented']) {
    assert.equal(isLaborOnly({ truckProvider: brand }), true, brand)
  }
  assert.equal(isLaborOnly({ truckProvider: 'WMIWCI' }), false)
})

test('nothing recorded about a truck stays full-service — every package ships with ours', () => {
  const shape = resolveServiceShape({ itemsDescription: 'Service: 2 Bedrooms' })
  assert.equal(shape.serviceType, 'full_service')
  assert.equal(shape.truckProvider, 'unknown')
})

test('truck pickup & return is LABOR on the customer’s rental, not a company truck', () => {
  // We collect and return a truck the CUSTOMER rented. It is still their truck.
  const shape = resolveServiceShape({ truckAddonDueOnMoveDay: true, itemsDescription: 'Service: 1 Bedroom' })
  assert.equal(shape.serviceType, 'labor_only')
  assert.equal(shape.truckProvider, 'customer')
  // And it is NOT a violation — refusing it would refuse a real service.
  assert.deepEqual(laborOnlyChargeViolations({ truckAddonDueOnMoveDay: true }), [])
})

test('no truck, fuel, mileage, rental or truck markup may sit on a labor-only job', () => {
  const violations = laborOnlyChargeViolations({
    ...WMIC_1019,
    additionalTruckFees: 7500,
    transportationCharge: 9000,
    fuelCharge: 4000,
    truckSizeUpgradeAmount: 10000,
  })
  assert.equal(violations.length, 4)
  assert.deepEqual(
    violations.map((v) => v.field).sort(),
    ['additionalTruckFees', 'fuelCharge', 'transportationCharge', 'truckSizeUpgradeAmount'],
  )
  // A full-service job may legitimately carry all four.
  assert.deepEqual(laborOnlyChargeViolations({ serviceTypeKey: 'full_service', additionalTruckFees: 7500 }), [])
})

// ══════════════════════════════════════════════════════════════════════
//  2. THE INVENTORY DOES NOT FIT THE PACKAGE
// ══════════════════════════════════════════════════════════════════════

test('the inventory is read out of the notes blob — no re-submission, no back-fill', () => {
  const inv = parseInventoryText(WMIC_1019.customerNotes)
  assert.equal(inv.boxes, 15)
  assert.equal(inv.beds, 2)
  assert.equal(inv.dressers, 3)
  assert.equal(inv.sofas, 2)
  assert.equal(inv.tables, 2)
  assert.equal(inv.tvs, 2)
  assert.equal(inv.mirrors, 2)
  assert.equal(inv.assembly, true)
  assert.equal(inv.empty, false)
})

test('a count only counts when a number is actually in front of the item', () => {
  // "we have a sofa" is information, not a measurement: one, and no more.
  const loose = parseInventoryText('we have a sofa and some boxes')
  assert.equal(loose.sofas, 1)
  assert.equal(loose.boxes, 1)
  // "box spring" is a bed, never a carton.
  const bed = parseInventoryText('2 box springs')
  assert.equal(bed.boxes, 0)
  assert.equal(bed.beds, 2)
})

test('WMIC-1019 is a 2-bedroom load, and 1 Bedroom is flagged not re-priced', () => {
  const inv = parseInventoryText(WMIC_1019.customerNotes)
  // 15×3 + 2×60 + 3×30 + 2×50 + 2×40 + 2×8 + 2×8 = 467 cu ft.
  assert.equal(inventoryCubicFeet(inv), 467)
  assert.equal(suggestedPackage(inv), '2br')

  const verdict = assessInventory(inv, '1br')
  assert.equal(verdict.exceedsSelected, true)
  assert.equal(verdict.selectedLabel, '1 Bedroom')
  assert.equal(verdict.suggestedLabel, '2 Bedrooms')
  assert.equal(verdict.warning, INVENTORY_WARNING)
  assert.match(verdict.warning!, /INVENTORY EXCEEDS SELECTED MOVE SIZE — MANUAL REVIEW REQUIRED/)
  // Two independent signals: the volume, and the bed count.
  assert.equal(verdict.reasons.length, 2)
  assert.match(verdict.reasons[0], /467 cu ft/)
  assert.match(verdict.reasons[1], /2 beds\/mattresses were listed/)
})

test('a load that genuinely fits raises nothing — a warning on every booking is no warning', () => {
  const modest = toInventory({ boxes: 20, beds: 1, dressers: 1, sofas: 1 })
  const verdict = assessInventory(modest, '1br')
  assert.equal(verdict.exceedsSelected, false)
  assert.equal(verdict.warning, null)
  // 10% of headroom is absorbed, not flagged.
  const borderline = assessInventory(toInventory({ boxes: 10, beds: 1, dressers: 2, sofas: 1, tables: 2 }), '1br')
  assert.equal(borderline.exceedsSelected, false)
})

test('structured counts win over the notes, and fill in from them where silent', () => {
  const merged = mergeInventory(toInventory({ boxes: 30 }), parseInventoryText('15 boxes, 2 sofas'))
  assert.equal(merged.boxes, 30) // structured wins
  assert.equal(merged.sofas, 2) // notes fill the gap
})

test('photos are recommended for exactly the items whose size cannot be counted', () => {
  const verdict = assessInventory(parseInventoryText(WMIC_1019.customerNotes), '1br')
  assert.equal(verdict.photosRecommended, true)
  const why = verdict.photoReasons.join(' ')
  for (const item of ['sofas', 'beds', 'dressers', 'mirrors', 'TVs', 'assembly']) {
    assert.match(why, new RegExp(item, 'i'))
  }
  // A box-only move needs no photographs.
  assert.equal(assessInventory(toInventory({ boxes: 10 }), '1br').photosRecommended, false)
})

// ══════════════════════════════════════════════════════════════════════
//  3. ONE FINAL TOTAL — $550 − $55 = $495
// ══════════════════════════════════════════════════════════════════════

test('the owner’s arithmetic, exactly: $550 − $55 = $495', () => {
  const q = computeQuote({ totalEstimate: 550, discountPercent: 10, depositCents: 4900 })
  assert.equal(q.quotedCents, 55_000)
  assert.equal(q.discountCents, 5_500)
  assert.equal(q.finalTotalCents, 49_500)
  assert.equal(q.finalTotalDollars, 495)
})

test('before approval: $495 owed, $49 authorized, $0 captured, $0 collected', () => {
  const q = computeQuote({
    totalEstimate: 550, discountPercent: 10, depositCents: 4900,
    collectedCents: 0, authorizedNotCapturedCents: 4900,
  })
  assert.equal(q.finalTotalDollars, 495)
  assert.equal(q.depositDollars, 49)
  assert.equal(q.depositCaptured, false)
  assert.equal(q.depositAppliedCents, 0)
  assert.equal(q.collectedDollars, 0)
  // Nothing has been captured, so the whole $495 is still owed today…
  assert.equal(q.remainingDollars, 495)
  // …and $446 once the standing authorization is captured.
  assert.equal(q.remainingAfterDepositDollars, 446)
})

test('after capture: $495 − $49 = $446, and the deposit is not credited twice', () => {
  const q = computeQuote({
    totalEstimate: 550, discountPercent: 10, depositCents: 4900,
    collectedCents: 4900, authorizedNotCapturedCents: 0,
  })
  assert.equal(q.depositCaptured, true)
  assert.equal(q.depositAppliedCents, 4900)
  assert.equal(q.remainingDollars, 446)
  // The forecast has come true; it must not subtract the deposit a second time.
  assert.equal(q.remainingAfterDepositDollars, 446)
})

test('$501 is unreachable — the deposit is applied to the FINAL total, never added', () => {
  const q = computeQuote({ totalEstimate: 550, discountPercent: 10, depositCents: 4900 })
  const everyFigure = [
    q.finalTotalCents, q.remainingCents, q.remainingAfterDepositCents,
    q.quotedCents, q.discountCents, q.depositCents,
  ]
  // $501 is $550 − $49: the deposit taken off a total that ignored the
  // discount. It is neither the quote, the total, nor the balance.
  assert.ok(!everyFigure.includes(50_100), '$501 must not be derivable from the canonical quote')
  // And the deposit is never added on top.
  assert.notEqual(q.finalTotalCents, 55_000 - 5_500 + 4_900)
})

test('a booking with no stored price reports honestly instead of quoting $0', () => {
  const q = computeQuote({ totalEstimate: null, baseRate: null })
  assert.equal(q.quoteMissing, true)
  assert.equal(q.finalTotalCents, 0)
})

// ══════════════════════════════════════════════════════════════════════
//  4. DISCOUNTS DO NOT STACK
// ══════════════════════════════════════════════════════════════════════

test('MOVE10 does not stack on the automatic first-time 10%', () => {
  const d = resolveDiscount({ existingType: 'FIRST_TIME_AUTO', existingPercent: 10, requestedCode: 'MOVE10' })
  assert.equal(d.percent, 10) // NOT 20
  assert.equal(d.appliedCode, 'FIRST_TIME_AUTO')
  assert.equal(d.rejected.length, 1)
  assert.equal(d.rejected[0].code, 'MOVE10')
  assert.equal(d.rejected[0].reason, 'duplicate_promotion')
  assert.equal(
    d.rejected[0].message,
    'MOVE10 not applied — equivalent 10% first-time discount already active.',
  )
})

test('every code that markets the same welcome offer is the same promotion', () => {
  for (const code of ['MOVE10', 'WELCOME10', 'FIRST10', 'NEW10', 'move10', ' Move10 ']) {
    assert.equal(isDuplicatePromotion('FIRST_TIME_AUTO', 10, code), true, code)
  }
})

test('a first-time customer typing MOVE10 gets 10% once, not 10% twice', () => {
  const d = resolveDiscount({ isFirstTimeCustomer: true, requestedCode: 'MOVE10' })
  assert.equal(d.percent, 10)
  assert.equal(d.rejected.length, 1)
  assert.match(d.rejected[0].message, /already active/)
})

test('a returning customer with a valid code still gets it', () => {
  const d = resolveDiscount({ isFirstTimeCustomer: false, requestedCode: 'MOVE10' })
  assert.equal(d.percent, 10)
  assert.equal(d.appliedCode, 'MOVE10')
  assert.equal(d.rejected.length, 0)
})

test('an unknown code is escalated, never silently ignored and never auto-honoured', () => {
  const d = resolveDiscount({ isFirstTimeCustomer: true, requestedCode: 'SUMMER50' })
  assert.equal(d.percent, 10) // the entitlement they do have
  assert.equal(d.needsOwnerDecision, 'SUMMER50')
  assert.equal(d.rejected[0].reason, 'unknown_code')
})

test('nothing exceeds the 10% public cap', () => {
  const d = resolveDiscount({ existingType: 'MANUAL', existingPercent: 40 })
  assert.equal(d.percent, 10)
})

// ══════════════════════════════════════════════════════════════════════
//  5. THE UNIT COMES OUT OF THE STREET ADDRESS
// ══════════════════════════════════════════════════════════════════════

test('"1000 Executive Dr apt 443a" splits into an address and unit 443A', () => {
  const p = parseAddressUnit('1000 Executive Dr apt 443a')
  assert.equal(p.address, '1000 Executive Dr')
  assert.equal(p.unit, '443A') // normalized — it gets printed and read aloud
  assert.equal(p.changed, true)
})

test('"85 Livingston Avenue apt 427" splits into an address and unit 427', () => {
  const p = parseAddressUnit('85 Livingston Avenue apt 427')
  assert.equal(p.address, '85 Livingston Avenue')
  assert.equal(p.unit, '427')
})

test('the unit is never left behind inside the street string', () => {
  for (const raw of [
    '1000 Executive Dr apt 443a, West Orange, NJ 07052',
    '1000 Executive Dr, Apt 443A, West Orange, NJ 07052',
    '1000 Executive Dr #443a, West Orange, NJ 07052',
    '1000 Executive Dr Unit 443A, West Orange, NJ 07052',
    '1000 Executive Dr Suite 443A, West Orange, NJ 07052',
  ]) {
    const p = parseAddressUnit(raw)
    assert.equal(p.unit, '443A', raw)
    assert.ok(!/443a/i.test(p.address), `unit still inside the address: ${p.address}`)
    // City, state and ZIP survive untouched.
    assert.match(p.address, /West Orange, NJ 07052$/)
  }
})

test('a street that merely contains a unit word is left alone', () => {
  // The value must look like a unit: a digit, or a very short code.
  for (const raw of ['12 Building Road, Newark, NJ 07102', '5 Suite Ridge Lane, Newark, NJ 07102']) {
    const p = parseAddressUnit(raw)
    assert.equal(p.unit, null, raw)
    assert.equal(p.address, raw)
  }
})

test('a floor is captured as a floor, and never becomes the unit', () => {
  const p = parseAddressUnit('40 Main St floor 3')
  assert.equal(p.floor, 3)
  assert.equal(p.unit, null)
  assert.equal(p.address, '40 Main St')
})

test('a unit already recorded in its own field wins, and the copy is still removed', () => {
  const n = normalizeAddressAndUnit('1000 Executive Dr apt 443a', '443B')
  assert.equal(n.unit, '443B') // the field the customer was actually asked
  assert.equal(n.address, '1000 Executive Dr') // no duplicate left behind
})

// ══════════════════════════════════════════════════════════════════════
//  6. THE WHOLE BOOKING, READ AT ONCE
// ══════════════════════════════════════════════════════════════════════

test('WMIC-1019: the owner brief, verbatim', () => {
  const scope = resolveBookingScope({
    ...WMIC_1019,
    needsAssembly: true,
    collectedCents: 0,
    authorizedNotCapturedCents: 4900,
  })
  assert.equal(
    scope.alertParagraph,
    '⚠️ Customer selected 1 Bedroom, but inventory appears to be approximately 2-bedroom-sized. ' +
      'Customer provides truck. Assembly/disassembly scope is unknown. COI may be required. ' +
      'Review pricing before approval.',
  )
})

test('WMIC-1019: the top block replaces "1 Bedroom — $550"', () => {
  const scope = resolveBookingScope({ ...WMIC_1019, needsAssembly: true, crewNames: [] })
  const row = (label: string) => scope.summary.find((s) => s.label === label)?.value

  assert.equal(scope.headline, 'LABOR ONLY')
  assert.equal(row('Service Type'), 'Labor Only')
  assert.match(row('Move Size') ?? '', /^1 Bedroom \(selected\) — inventory suggests 2 Bedrooms$/)
  assert.equal(row('Crew'), 'Not assigned')
  assert.equal(row('Customer Truck'), 'Yes')
  assert.equal(row('Inventory Review'), 'Required')
  assert.equal(row('Assembly'), 'Needs clarification')
  assert.equal(row('COI'), 'Needs clarification')
  // A settled price is NOT shown while the size, the assembly and the COI
  // are all still open — that headline is what invited the approval.
  assert.equal(row('Final Quote'), 'Pending review')
})

test('WMIC-1019: every banner the owner asked for, and no others', () => {
  const scope = resolveBookingScope({ ...WMIC_1019, needsAssembly: true })
  const banners = scope.flags.map((f) => f.banner)
  assert.ok(banners.includes(BANNERS.inventory), 'inventory banner')
  assert.ok(banners.includes(BANNERS.assembly), 'assembly scope banner')
  assert.ok(banners.includes(BANNERS.photos), 'photos banner')
  assert.ok(banners.includes(BANNERS.coiUnknown), 'COI unknown banner')
  // No truck cost sits on it, so no truck-cost banner.
  assert.ok(!banners.includes(BANNERS.truckCost))
})

test('a COI the customer says is required is a review flag, not a footnote', () => {
  const scope = resolveBookingScope({ ...WMIC_1019, coiRequiredOrigin: 'yes', coiRequiredDest: 'no' })
  assert.equal(scope.coi.required, true)
  assert.equal(scope.coi.label, 'Required — review before approval')
  const flag = scope.flags.find((f) => f.code === 'coi_required')
  assert.ok(flag)
  assert.equal(flag!.banner, BANNERS.coi)
  assert.match(flag!.detail, /pickup building/)
})

test('"not asked" and "asked, unknown" are both unknown; "no" is an answer', () => {
  assert.equal(normalizeCoi(null), null)
  assert.equal(normalizeCoi('unknown'), 'unknown')
  assert.equal(normalizeCoi('no'), 'no')
  const answered = resolveBookingScope({ ...WMIC_1019, coiRequiredOrigin: 'no', coiRequiredDest: 'no' })
  assert.equal(answered.coi.unknown, false)
  assert.equal(answered.coi.label, 'Not required')
})

test('naming the furniture closes the assembly question', () => {
  const scope = resolveBookingScope({
    ...WMIC_1019,
    needsDisassembly: true,
    disassemblyItems: 'Both bed frames and the dining table',
  })
  assert.equal(scope.assembly.scopeKnown, true)
  assert.equal(scope.assembly.label, 'Both bed frames and the dining table')
  assert.ok(!scope.flags.some((f) => f.code === 'assembly_scope_unknown'))
})

test('the scope’s total is the canonical one — $495, and $446 after capture', () => {
  const scope = resolveBookingScope({ ...WMIC_1019, authorizedNotCapturedCents: 4900 })
  assert.equal(scope.quote.finalTotalDollars, 495)
  assert.equal(scope.quote.remainingAfterDepositDollars, 446)
})

// ══════════════════════════════════════════════════════════════════════
//  7. NOTHING IS CONFIRMED BY ACCIDENT
// ══════════════════════════════════════════════════════════════════════

const APPROVAL_INPUT = { ...WMIC_1019, needsAssembly: true, authorizedNotCapturedCents: 4900 }

test('WMIC-1019 cannot be confirmed without the owner seeing why', () => {
  const v = evaluateApproval(APPROVAL_INPUT)
  // Nothing here is unpriceable or undispatchable, so nothing hard-blocks…
  assert.equal(v.canApprove, true)
  // …but the owner is asked, by name, about each open question.
  const ids = v.mustAcknowledge.map((c) => c.id)
  assert.ok(ids.includes('inventory_size'))
  assert.ok(ids.includes('assembly_scope'))
  assert.ok(ids.includes('coi_reviewed'))
  assert.ok(ids.includes('addresses_valid')) // the unit was inside the street
  assert.ok(ids.includes('truck_provider')) // labor-only was inferred, not stated
  assert.match(v.confirmationPrompt ?? '', /Confirm anyway\?/)
})

test('all eight of the owner’s checks run, in the owner’s order', () => {
  const v = evaluateApproval(APPROVAL_INPUT)
  assert.deepEqual(
    v.checks.map((c) => c.id).slice(0, 8),
    ['inventory_size', 'price_correct', 'discount_single', 'deposit_math',
     'assembly_scope', 'coi_reviewed', 'addresses_valid', 'truck_provider'],
  )
})

test('acknowledging clears the prompts, but never the hard blocks', () => {
  const acked = evaluateApproval({ ...APPROVAL_INPUT, acknowledged: true })
  assert.equal(acked.mustAcknowledge.length, 0)
  assert.equal(acked.canApprove, true)

  // A truck charge on a labor-only job is not a prompt. It is a refusal.
  const blocked = evaluateApproval({ ...APPROVAL_INPUT, acknowledged: true, additionalTruckFees: 7500 })
  assert.equal(blocked.canApprove, false)
  assert.equal(blocked.blocked[0].id, 'truck_provider')
  assert.match(blocked.confirmationPrompt ?? '', /cannot be confirmed yet/)
})

test('an unpriced booking is refused, not approved at $0', () => {
  const v = evaluateApproval({ totalEstimate: null, baseRate: null, originAddress: '1 A St, Newark, NJ 07102', destAddress: '2 B St, Newark, NJ 07102' })
  assert.equal(v.canApprove, false)
  assert.ok(v.blocked.some((c) => c.id === 'price_correct'))
})

test('a stacked discount above the public cap is a refusal', () => {
  const v = evaluateApproval({ ...APPROVAL_INPUT, discountPercent: 20 })
  assert.equal(v.canApprove, false)
  assert.ok(v.blocked.some((c) => c.id === 'discount_single'))
})

test('the deposit check states the arithmetic it just verified', () => {
  const v = evaluateApproval(APPROVAL_INPUT)
  const deposit = v.checks.find((c) => c.id === 'deposit_math')!
  assert.equal(deposit.status, 'pass')
  assert.equal(deposit.message, '$495.00 total − $49.00 deposit on capture = $446.00 remaining.')
})

test('a clean booking prompts for nothing at all', () => {
  const v = evaluateApproval({
    serviceTypeKey: 'labor_only',
    truckProvider: 'customer',
    moveSizeKey: '2br',
    originAddress: '1000 Executive Dr, West Orange, NJ 07052',
    destAddress: '85 Livingston Ave, New Brunswick, NJ 08901',
    originUnit: '443A',
    destUnit: '427',
    totalEstimate: 779,
    baseRate: 779,
    discountPercent: 10,
    coiRequiredOrigin: 'no',
    coiRequiredDest: 'no',
    customerNotes: 'Please wrap the TV.',
  })
  assert.equal(v.canApprove, true)
  assert.equal(v.mustAcknowledge.length, 0)
  assert.equal(v.confirmationPrompt, null)
})

// ══════════════════════════════════════════════════════════════════════
//  8. THE PRICE NEVER MOVES SILENTLY
// ══════════════════════════════════════════════════════════════════════

test('1 Bedroom → 2 Bedroom is a price change, and it says so in dollars', () => {
  assert.equal(isPriceChange(49_500, 70_110), true)
  assert.equal(isPriceChange(49_500, 49_500), false)
  const msg = describePriceChange(49_500, 70_110)
  assert.match(msg, /increase the customer's total from \$495\.00 to \$701\.10/)
  assert.match(msg, /must be told before move day/)
})

test('a price change the customer has not agreed to blocks confirmation outright', () => {
  const v = evaluateApproval({ ...APPROVAL_INPUT, priceChangedSinceCustomerAgreed: true })
  assert.equal(v.canApprove, false)
  assert.ok(v.blocked.some((c) => c.id === 'price_change_approved'))
  // Approving the new amount clears it.
  const approved = evaluateApproval({ ...APPROVAL_INPUT, priceChangedSinceCustomerAgreed: true, priceChangeApprovedAt: new Date() })
  assert.equal(approved.canApprove, true)
})

// ══════════════════════════════════════════════════════════════════════
//  9. THE THREE GAPS FOUND IN THE PRE-PUSH AUDIT (2026-08-14)
// ══════════════════════════════════════════════════════════════════════

test('a corrected size with no price sign-off blocks approval, without being told to', () => {
  // DERIVED, not passed in. The size moved, so the flat rate moved; nothing
  // recorded an owner agreeing to the new total. A caller that has to remember
  // to pass a flag is a caller that will forget.
  const v = evaluateApproval({
    ...APPROVAL_INPUT,
    acknowledged: true,
    moveSizeKey: '2br',
    moveSizeChangedAt: new Date('2026-08-14T10:00:00Z'),
    priceChangeApprovedAt: null,
  })
  assert.equal(v.canApprove, false)
  assert.ok(v.blocked.some((c) => c.id === 'price_change_approved'))
})

test('the same booking approves once the new price is signed off', () => {
  const v = evaluateApproval({
    ...APPROVAL_INPUT,
    acknowledged: true,
    moveSizeKey: '2br',
    moveSizeChangedAt: new Date('2026-08-14T10:00:00Z'),
    priceChangeApprovedAt: new Date('2026-08-14T10:01:00Z'),
  })
  assert.equal(v.canApprove, true)
})

test('a booking whose size was never touched is not accused of a price change', () => {
  const v = evaluateApproval({ ...APPROVAL_INPUT, acknowledged: true })
  assert.ok(!v.checks.some((c) => c.id === 'price_change_approved'))
})
