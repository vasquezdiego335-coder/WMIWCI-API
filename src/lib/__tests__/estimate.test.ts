// Offline unit tests for the canonical booking estimate (src/lib/estimate.ts).
// Run: npm test  (tsx --test)  — no DB, no network.
//
// The guarantee: the number the customer sees on the booking form and the
// number the server stores/emails CANNOT silently disagree. Since the
// 2026-07-21 cutover both sides read the SAME price book (pricing-config.ts) —
// the server imports it directly, the form loads the generated mirror — so this
// file tests the CALCULATION, and pricing-parity.test.ts tests that the mirror
// still matches its source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeEstimate, storedTotalEstimate, MOVE_SIZES, TRUCK_ADDON_DOLLARS } from '../estimate'
import { PACKAGES, TRUCK_PICKUP_RETURN } from '../pricing-config'

// ── Base prices come from the config, not a local table ─────────────────────
test('estimate: every base price is the config price', () => {
  for (const pkg of Object.values(PACKAGES)) {
    assert.equal(MOVE_SIZES[pkg.key].price, pkg.price.amount ?? 0, `${pkg.key} base`)
  }
  assert.equal(computeEstimate({ serviceType: '1br' }).base, 649)
  assert.equal(computeEstimate({ serviceType: '2br' }).base, 779)
  assert.equal(computeEstimate({ serviceType: 'little-studio' }).base, 379)
})

test('estimate: 3BR+ are floors and flag review, never a settled flat rate', () => {
  for (const key of ['3br', '4br', '5br']) {
    const est = computeEstimate({ serviceType: key })
    assert.equal(est.baseIsStarting, true, `${key} must be a floor`)
    assert.equal(est.requiresReview, true, `${key} must require review`)
    assert.ok(est.reviewReasons.some((r) => /review/i.test(r)), `${key} needs a stated reason`)
  }
  // A 2BR is a real flat rate — no review, not a floor.
  const twoBr = computeEstimate({ serviceType: '2br' })
  assert.equal(twoBr.baseIsStarting, false)
  assert.equal(twoBr.requiresReview, false)
})

// ── Stairs: PER ADDRESS, first flight included ──────────────────────────────
test('estimate: stairs are per address — first flight free, 2nd $40, 3rd $70', () => {
  assert.equal(computeEstimate({ serviceType: '1br', pickupStairFlights: 1 }).accessAddons, 0)
  assert.equal(computeEstimate({ serviceType: '1br', pickupStairFlights: 2 }).accessAddons, 40)
  assert.equal(computeEstimate({ serviceType: '1br', pickupStairFlights: 3 }).accessAddons, 70)

  // Both ends charge independently: 2 flights at pickup + 3 at drop-off.
  const both = computeEstimate({ serviceType: '1br', pickupStairFlights: 2, dropoffStairFlights: 3 })
  assert.equal(both.accessAddons, 110)
  assert.equal(both.estimatedTotal, 649 + 110)
})

test('estimate: 4+ flights is review-gated, never silently summed', () => {
  const est = computeEstimate({ serviceType: '1br', pickupStairFlights: 5 })
  assert.equal(est.accessAddons, 0, 'a review line must not be added to the total')
  assert.equal(est.requiresReview, true)
  assert.equal(est.reviewLines.length, 1)
  assert.equal(est.reviewLines[0].display, 'Starting at $100')
  assert.equal(est.reviewLines[0].pendingReview, true)
})

// ── Long carry: PER LOCATION ────────────────────────────────────────────────
test('estimate: carry distance tiers — <100ft free, 40, 75, review', () => {
  assert.equal(computeEstimate({ serviceType: '1br', pickupCarryFeet: 99 }).accessAddons, 0)
  assert.equal(computeEstimate({ serviceType: '1br', pickupCarryFeet: 100 }).accessAddons, 40)
  assert.equal(computeEstimate({ serviceType: '1br', pickupCarryFeet: 250 }).accessAddons, 40)
  assert.equal(computeEstimate({ serviceType: '1br', pickupCarryFeet: 251 }).accessAddons, 75)
  assert.equal(computeEstimate({ serviceType: '1br', pickupCarryFeet: 400 }).accessAddons, 75)

  const far = computeEstimate({ serviceType: '1br', pickupCarryFeet: 401 })
  assert.equal(far.accessAddons, 0)
  assert.equal(far.requiresReview, true)
})

// ── Heavy items: by WEIGHT ──────────────────────────────────────────────────
test('estimate: heavy items are $50 / $100 by weight — never $75 / $125', () => {
  const light = computeEstimate({ serviceType: '1br', heavyItems: [{ label: 'Safe', pounds: 200 }] })
  assert.equal(light.accessAddons, 50)

  const mid = computeEstimate({ serviceType: '1br', heavyItems: [{ label: 'Gun safe', pounds: 300 }] })
  assert.equal(mid.accessAddons, 100)

  // Boundaries.
  assert.equal(computeEstimate({ serviceType: '1br', heavyItems: [{ pounds: 249 }] }).accessAddons, 50)
  assert.equal(computeEstimate({ serviceType: '1br', heavyItems: [{ pounds: 250 }] }).accessAddons, 100)
  assert.equal(computeEstimate({ serviceType: '1br', heavyItems: [{ pounds: 399 }] }).accessAddons, 100)
})

test('estimate: NORMAL large furniture gets no surcharge at all', () => {
  // A sectional and an armoire, both under 150 lb — the oversized-furniture fee
  // that must never exist. Total is the bare package price.
  const est = computeEstimate({
    serviceType: '2br',
    heavyItems: [
      { label: 'Sectional sofa', pounds: 140 },
      { label: 'Armoire', pounds: 120 },
      { label: 'Large mirror', pounds: 40 },
    ],
  })
  assert.equal(est.accessAddons, 0, 'normal furniture must not be surcharged')
  assert.equal(est.reviewLines.length, 0)
  assert.equal(est.estimatedTotal, 779)
})

test('estimate: 400lb+ and piano/safe are review or custom quote, never priced', () => {
  const heavy = computeEstimate({ serviceType: '1br', heavyItems: [{ label: 'Slate table', pounds: 450 }] })
  assert.equal(heavy.accessAddons, 0)
  assert.equal(heavy.reviewLines[0].display, 'Pending review')
  assert.equal(heavy.requiresReview, true)

  const piano = computeEstimate({ serviceType: '1br', heavyItems: [{ label: 'Upright piano', isPianoOrSafe: true }] })
  assert.equal(piano.accessAddons, 0)
  assert.equal(piano.reviewLines[0].display, 'Custom quote')
  assert.equal(piano.reviewLines[0].label, 'Upright piano')
})

// ── Additional stops ────────────────────────────────────────────────────────
test('estimate: extra stops are $75 / $125 / custom — the $20–$40 fee is gone', () => {
  assert.equal(computeEstimate({ serviceType: '1br', additionalStops: [{ miles: 5 }] }).accessAddons, 75)
  assert.equal(computeEstimate({ serviceType: '1br', additionalStops: [{ miles: 20 }] }).accessAddons, 125)

  const far = computeEstimate({ serviceType: '1br', additionalStops: [{ label: 'Storage unit', miles: 40 }] })
  assert.equal(far.accessAddons, 0)
  assert.equal(far.reviewLines[0].display, 'Custom quote')

  // Two stops both bill.
  assert.equal(computeEstimate({ serviceType: '1br', additionalStops: [{ miles: 3 }, { miles: 8 }] }).accessAddons, 150)
})

// ── Removed charges ─────────────────────────────────────────────────────────
test('estimate: the building-age surcharge is GONE', () => {
  // buildingYear is no longer an input at all; a difficult building is an
  // explicit, reviewed $50 instead of a silent $40.
  const est = computeEstimate({ serviceType: '1br', pickupDifficultBuilding: true })
  assert.equal(est.accessAddons, 0, 'difficult access must not auto-charge')
  assert.equal(est.reviewLines[0].display, '$50')
  assert.equal(est.reviewLines[0].pendingReview, true)
})

test('estimate: a normal elevator is never charged', () => {
  // No elevator input at all → nothing.
  assert.equal(computeEstimate({ serviceType: '1br' }).accessAddons, 0)
  // Only genuinely difficult elevator access, and only after review.
  const hard = computeEstimate({ serviceType: '1br', pickupDifficultElevator: true })
  assert.equal(hard.accessAddons, 0)
  assert.equal(hard.reviewLines[0].display, '$40–$75')
})

// ── Travel ──────────────────────────────────────────────────────────────────
test('estimate: travel ladder 50 / 100 / 150 / custom by drive time', () => {
  assert.equal(computeEstimate({ serviceType: '2br', travelMinutes: 15 }).travel, 0)
  assert.equal(computeEstimate({ serviceType: '2br', travelMinutes: 30 }).travel, 50)
  assert.equal(computeEstimate({ serviceType: '2br', travelMinutes: 50 }).travel, 100)
  assert.equal(computeEstimate({ serviceType: '2br', travelMinutes: 75 }).travel, 150)

  const far = computeEstimate({ serviceType: '2br', travelMinutes: 120 })
  assert.equal(far.travel, 0, 'over 90 minutes is a custom quote, not a number')
  assert.equal(far.requiresReview, true)
})

test('estimate: travel is IN the total and also flagged due-on-move-day', () => {
  const est = computeEstimate({ serviceType: '2br', travelFeeCents: 5000 })
  assert.equal(est.base, 779)
  assert.equal(est.travel, 50)
  assert.equal(est.estimatedTotal, 829)
  assert.equal(est.dueOnMoveDay, 50)
})

// ── The two $49 charges ─────────────────────────────────────────────────────
test('estimate: truck add-on is $49, on its own line, NOT in estimatedTotal', () => {
  assert.equal(TRUCK_ADDON_DOLLARS, 49)
  assert.equal(TRUCK_ADDON_DOLLARS, TRUCK_PICKUP_RETURN.amount)

  const est = computeEstimate({ serviceType: '1br', truckAddonDueOnMoveDay: true })
  assert.equal(est.truckAddon, 49)
  assert.equal(est.estimatedTotal, 649, 'the add-on must stay out of the quote total')
  assert.equal(est.dueOnMoveDay, 49)
})

test('estimate: truck add-on is never discountable', () => {
  assert.equal(TRUCK_PICKUP_RETURN.discountable, false)
})

// ── Legacy inputs (pre-cutover browser tab) ─────────────────────────────────
test('estimate: legacy booleans map to the LOWEST tier and never crash', () => {
  const est = computeEstimate({ serviceType: '1br', stairs: true, longWalk: true })
  // stairs:true → 2nd flight ($40); longWalk:true → 100ft ($40).
  assert.equal(est.accessAddons, 80)
  assert.equal(est.estimatedTotal, 729)
})

test('estimate: a weightless legacy heavy-item checkbox becomes a REVIEW line', () => {
  const est = computeEstimate({ serviceType: '1br', legacyHeavyItems: true })
  assert.equal(est.accessAddons, 0, 'never guess a weight into a charge')
  assert.equal(est.requiresReview, true)
  assert.equal(est.reviewLines[0].display, 'Pending review')
})

// ── Stored total ────────────────────────────────────────────────────────────
test('storedTotalEstimate: matches the headline whenever a size is chosen', () => {
  const inputs = { serviceType: '1br', pickupStairFlights: 2, heavyItems: [{ pounds: 200 }] }
  assert.equal(computeEstimate(inputs).estimatedTotal, 649 + 40 + 50)
  assert.equal(storedTotalEstimate(inputs), 739)
})

test('storedTotalEstimate: null when there is genuinely nothing to estimate', () => {
  assert.equal(storedTotalEstimate({}), null)
  assert.equal(storedTotalEstimate({ serviceType: 'not-sure' }), null)
})

test('estimate: a review line is never displayed as $0', () => {
  const est = computeEstimate({
    serviceType: '5br',
    pickupStairFlights: 6,
    heavyItems: [{ pounds: 800 }],
    additionalStops: [{ miles: 100 }],
  })
  for (const line of est.reviewLines) {
    assert.notEqual(line.display, '$0', `${line.label} rendered as $0`)
    assert.ok(line.display.length > 0)
    assert.equal(line.pendingReview, true)
  }
  assert.ok(est.reviewLines.length >= 3)
})
