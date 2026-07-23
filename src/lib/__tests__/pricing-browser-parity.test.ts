// ════════════════════════════════════════════════════════════════════════
//  pricing-browser-parity.test.ts — executes the GENERATED browser mirror in
//  a fake `window` and asserts it produces byte-identical results to the
//  TypeScript source for every tier boundary.
//
//  pricing-parity.test.ts proves the mirror's DATA matches. This proves its
//  BEHAVIOUR matches: the resolvers and formatCharge are hand-transcribed into
//  the generated file (the browser cannot import TS), so a transcription slip
//  — an `<=` that should be `<`, a missing "Starting at" — would otherwise
//  ship a browser total that disagrees with the stored total.
//
//  SKIPS CLEANLY when the sibling site repo is absent.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  stairChargeForFlights, longCarryChargeForFeet, heavyItemChargeForWeight,
  additionalLocationChargeForMiles, travelChargeForMinutes,
  formatCharge, isAutoApplicable, applyDiscount, PACKAGES,
} from '../pricing-config'

const MIRROR = resolve(__dirname, '../../../../WMIWCI-SITE/public/js/pricing-config.js')
const skip = existsSync(MIRROR) ? false : 'WMIWCI-SITE mirror not present'

/** Objects created inside the VM sandbox have a DIFFERENT Object prototype, so
 *  deepStrictEqual reports "same structure but not reference-equal". Round-trip
 *  both sides through JSON to compare values in this realm. */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x ?? null))
const sameCharge = (a: unknown, b: unknown, msg: string): void =>
  assert.deepEqual(plain(a), plain(b), msg)

/** Evaluate the generated file in a sandbox and hand back window.WMIC_PRICING. */
function loadMirror(): any {
  const sandbox: any = { window: {} }
  runInNewContext(readFileSync(MIRROR, 'utf8'), sandbox)
  return sandbox.window.WMIC_PRICING
}

test('browser mirror: stair resolver matches the server at every boundary', { skip }, () => {
  const P = loadMirror()
  for (let n = 0; n <= 12; n++) {
    sameCharge(P.stairChargeForFlights(n), stairChargeForFlights(n), `flights=${n}`)
  }
})

test('browser mirror: carry resolver matches the server at every boundary', { skip }, () => {
  const P = loadMirror()
  for (const ft of [0, 1, 99, 100, 101, 250, 251, 400, 401, 1000]) {
    sameCharge(P.longCarryChargeForFeet(ft), longCarryChargeForFeet(ft), `feet=${ft}`)
  }
})

test('browser mirror: heavy-item resolver matches the server at every boundary', { skip }, () => {
  const P = loadMirror()
  for (const lb of [0, 1, 149, 150, 249, 250, 399, 400, 401, 2000]) {
    sameCharge(P.heavyItemChargeForWeight(lb), heavyItemChargeForWeight(lb), `lb=${lb}`)
  }
})

test('browser mirror: stop + travel resolvers match the server', { skip }, () => {
  const P = loadMirror()
  for (const mi of [0, 5, 10, 10.5, 25, 26, 100]) {
    sameCharge(P.additionalLocationChargeForMiles(mi), additionalLocationChargeForMiles(mi), `mi=${mi}`)
  }
  for (const min of [0, 20, 21, 40, 41, 60, 61, 90, 91, 200]) {
    sameCharge(P.travelChargeForMinutes(min), travelChargeForMinutes(min), `min=${min}`)
  }
  sameCharge(P.travelChargeForMinutes(null), travelChargeForMinutes(null), 'travel null')
})

test('browser mirror: formatCharge renders identically, EN and ES', { skip }, () => {
  const P = loadMirror()
  const samples = [
    ...Object.values(PACKAGES).map((p) => p.price),
    { kind: 'included', label: 'x' },
    { kind: 'fixed', amount: 40, label: 'x' },
    { kind: 'range', amount: 40, amountMax: 75, label: 'x' },
    { kind: 'pending_review', label: 'x' },
    { kind: 'manual_quote', label: 'x' },
    { kind: 'actual_cost', label: 'x' },
    { kind: 'starting', amount: 100, label: 'x' },
  ]
  for (const ch of samples as any[]) {
    assert.equal(P.formatCharge(ch, 'en'), formatCharge(ch, 'en'), `EN ${ch.kind} ${ch.amount ?? ''}`)
    assert.equal(P.formatCharge(ch, 'es'), formatCharge(ch, 'es'), `ES ${ch.kind} ${ch.amount ?? ''}`)
  }
  // The headline guarantee, spelled out.
  assert.equal(P.formatCharge(PACKAGES['3br'].price, 'en'), 'Starting at $1,049')
  assert.equal(P.formatCharge(PACKAGES['1br'].price, 'en'), '$649')
})

test('browser mirror: isAutoApplicable agrees — review lines never auto-apply', { skip }, () => {
  const P = loadMirror()
  const samples = [
    { kind: 'included', label: 'x' },
    { kind: 'fixed', amount: 40, label: 'x' },
    { kind: 'fixed', amount: 100, requiresReview: true, label: 'x' },
    { kind: 'starting', amount: 100, requiresReview: true, label: 'x' },
    { kind: 'range', amount: 40, amountMax: 75, requiresReview: true, label: 'x' },
    { kind: 'manual_quote', requiresReview: true, label: 'x' },
    { kind: 'pending_review', requiresReview: true, label: 'x' },
  ]
  for (const ch of samples as any[]) {
    assert.equal(P.isAutoApplicable(ch), isAutoApplicable(ch), `${ch.kind}`)
  }
})

test('browser mirror: discount clamps at 10% and never touches the truck add-on', { skip }, () => {
  const P = loadMirror()
  const cases: [number, number, number][] = [
    [649, 49, 10],
    [649, 49, 30], // the retired door-hanger rate — must clamp
    [1049, 0, 10],
    [500, 49, 0],
  ]
  for (const [d, nd, pct] of cases) {
    const totals = { discountableSubtotal: d, nonDiscountableSubtotal: nd }
    sameCharge(P.applyDiscount(totals, pct), applyDiscount(totals, pct), `${d}/${nd}@${pct}`)
  }
  // Explicitly: the $49 add-on survives a 10% coupon at full price.
  const r = P.applyDiscount({ discountableSubtotal: 649, nonDiscountableSubtotal: 49 }, 10)
  assert.equal(r.total, 633.1)
  assert.equal(P.DISCOUNT_POLICY.truckAddonDiscountable, false)
})

test('browser mirror: carries both $49s as separate values', { skip }, () => {
  const P = loadMirror()
  assert.equal(P.BOOKING_AUTHORIZATION.amount, 49)
  assert.equal(P.TRUCK_PICKUP_RETURN.amount, 49)
  assert.notEqual(P.BOOKING_AUTHORIZATION.id, P.TRUCK_PICKUP_RETURN.id)
  assert.equal(P.TRUCK_PICKUP_RETURN.discountable, false)
  assert.equal(P.TRUCK_PICKUP_RETURN.requiresReview, true)
})

test('browser mirror: no mattress-bag SKU and no building-age fee', { skip }, () => {
  const P = loadMirror()
  assert.equal(P.NO_MATTRESS_BAG_SKU.exists, false)
  assert.equal(P.NO_BUILDING_AGE_FEE.exists, false)
  assert.equal(P.NO_OVERSIZED_FURNITURE_FEE.exists, false)
  assert.equal('mattressBags' in P.MATERIALS, false)

  // Scan only the PRICED sections. The NO_* constants are the negative rules
  // themselves, so their own names would otherwise trip this guard.
  const priced = JSON.stringify({
    PACKAGES: P.PACKAGES, STAIRS: P.STAIRS, LONG_CARRY: P.LONG_CARRY,
    ELEVATOR: P.ELEVATOR, ADDITIONAL_LOCATION: P.ADDITIONAL_LOCATION,
    HEAVY_ITEM: P.HEAVY_ITEM, WEEKEND_HOLIDAY: P.WEEKEND_HOLIDAY,
    TRAVEL: P.TRAVEL, NEW_YORK: P.NEW_YORK,
    PARKING_TOLLS_DELAYS: P.PARKING_TOLLS_DELAYS, WAITING_TIME: P.WAITING_TIME,
    ASSEMBLY: P.ASSEMBLY, MATERIALS: P.MATERIALS, SCOPE_OVERAGE: P.SCOPE_OVERAGE,
  }).toLowerCase()
  assert.ok(!/oversiz/.test(priced), 'an oversized-furniture charge reached the browser')
  assert.ok(!/building.?(age|year)/.test(priced), 'a building-age charge reached the browser')
  assert.ok(!/mattress/.test(priced), 'a mattress SKU reached the browser')
})
