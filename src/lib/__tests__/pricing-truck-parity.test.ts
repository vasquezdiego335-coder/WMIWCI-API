// ════════════════════════════════════════════════════════════════════════
//  PRICING RECONCILIATION + TRUCK ASSIGNMENT (owner decision 2026-08-04)
//
//  The live customer-facing prices ARE the business decision. The server was
//  behind on exactly one package (1BR $649 vs the published $550), and truck
//  upgrade amounts existed ONLY as a hand edit inside the GENERATED browser
//  mirror — a file the generator overwrites, which is precisely how the two
//  came to disagree. This file locks both down.
//
//  Truck size is DERIVED from the move size and ENFORCED. A customer cannot
//  select a smaller truck to avoid the fee, a larger truck's fee REPLACES the
//  smaller one rather than stacking, and 5BR+ is not auto-quotable at all.
//
//  OFFLINE + PURE: no DB, no network, no env.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import {
  PACKAGES,
  TRUCK_SIZE_UPGRADE,
  SELECTABLE_TRUCK_SIZES,
  MIN_TRUCK_BY_PACKAGE,
  assignTruck,
  truckUpgradeAmount,
  isSelectableTruckSize,
  requiresManualTruckPlan,
} from '../pricing-config'
import { computeEstimate } from '../estimate'
import { quoteEstimate } from '../quote-estimate'

// ══════════════════════════════════════════════════════════════════════
//  1. THE PUBLISHED PRICES ARE THE BUSINESS DECISION
// ══════════════════════════════════════════════════════════════════════

/** Every package price as published to customers on the live site. */
const PUBLISHED: Record<string, number | null> = {
  'little-studio': 379,
  'half-studio': 439,
  'full-studio': 549,
  '1br': 550,
  '2br': 779,
  '3br': 1049,
  '4br': 1449,
  '5br': 1799,
  'not-sure': null,
}

test('1BR is $550 — the live price, NOT the stale $649', () => {
  assert.equal(PACKAGES['1br'].price.amount, 550,
    'raising the published 1-bedroom price by $99 would be a silent price increase to real customers')
})

test('EVERY package matches the published price, and nothing else moved', () => {
  for (const [key, expected] of Object.entries(PUBLISHED)) {
    const pkg = (PACKAGES as Record<string, { price: { amount?: number } }>)[key]
    assert.ok(pkg, `${key} must exist in the price book`)
    assert.equal(pkg.price.amount ?? null, expected, `${key} must be ${expected}`)
  }
})

test('the price book contains no package the published list does not', () => {
  for (const key of Object.keys(PACKAGES)) {
    assert.ok(key in PUBLISHED, `${key} is priced but not in the published list — one of the two is wrong`)
  }
})

test('computeEstimate returns the published base for every package', () => {
  for (const [key, expected] of Object.entries(PUBLISHED)) {
    if (expected === null) continue
    assert.equal(computeEstimate({ serviceType: key }).base, expected, `${key} base`)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  2. TRUCK FEES
// ══════════════════════════════════════════════════════════════════════

test('the truck fees are 10ft $0 / 15ft $100 / 26ft $150', () => {
  assert.equal(truckUpgradeAmount('10ft'), 0)
  assert.equal(truckUpgradeAmount('15ft'), 100)
  assert.equal(truckUpgradeAmount('26ft'), 150)
})

test('20ft is RETIRED and rejected, not silently repriced', () => {
  assert.equal(truckUpgradeAmount('20ft'), null,
    'returning 0 would read as "this truck is free" and let a retired size through')
  assert.equal(isSelectableTruckSize('20ft'), false)
  assert.ok(!SELECTABLE_TRUCK_SIZES.includes('20ft' as never))
})

test('an unknown truck size is rejected rather than defaulted', () => {
  for (const bad of ['30ft', '', '   ', 'big', 'DROP TABLE']) {
    assert.equal(truckUpgradeAmount(bad), null, `${JSON.stringify(bad)} must not price`)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  3. THE MINIMUM IS DERIVED FROM THE MOVE SIZE
// ══════════════════════════════════════════════════════════════════════

const cases: Array<[string, '10ft' | '15ft' | '26ft', number]> = [
  ['little-studio', '10ft', 0],
  ['half-studio', '10ft', 0],
  ['full-studio', '10ft', 0],
  ['1br', '10ft', 0],
  ['2br', '15ft', 100],
  ['3br', '26ft', 150],
  ['4br', '26ft', 150],
]

test('each move size assigns its required minimum truck and fee', () => {
  for (const [pkg, truck, fee] of cases) {
    const a = assignTruck(pkg)
    assert.equal(a.ok, true, `${pkg} must assign`)
    if (!a.ok) continue
    assert.equal(a.assigned, truck, `${pkg} minimum truck`)
    assert.equal(a.minimum, truck)
    assert.equal(a.upgradeAmount, fee, `${pkg} truck fee`)
    assert.equal(a.corrected, false)
  }
})

test('5BR+ is NOT auto-quotable — it may need several trucks or trips', () => {
  assert.equal(requiresManualTruckPlan('5br'), true)
  const a = assignTruck('5br')
  assert.equal(a.ok, false)
  if (!a.ok) assert.equal(a.reason, 'manual_plan')
  assert.ok(!('5br' in MIN_TRUCK_BY_PACKAGE), '5BR must not carry a single-truck minimum')
})

test('"not sure" is also a manual plan', () => {
  assert.equal(requiresManualTruckPlan('not-sure'), true)
})

// ══════════════════════════════════════════════════════════════════════
//  4. THE CUSTOMER CANNOT DOWNGRADE TO DODGE THE FEE
// ══════════════════════════════════════════════════════════════════════

test('a 3BR asking for a 10ft truck is CORRECTED to 26ft and still charged $150', () => {
  const a = assignTruck('3br', '10ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '26ft')
  assert.equal(a.upgradeAmount, 150)
  assert.equal(a.corrected, true, 'the UI must be able to say the size was raised')
})

test('a 4BR asking for a 15ft truck is corrected to 26ft at $150', () => {
  const a = assignTruck('4br', '15ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '26ft')
  assert.equal(a.upgradeAmount, 150)
  assert.equal(a.corrected, true)
})

test('a 2BR claiming a 10ft truck still pays the $100 15ft fee', () => {
  const a = assignTruck('2br', '10ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '15ft')
  assert.equal(a.upgradeAmount, 100, 'claiming a smaller truck must not zero the fee')
})

// ══════════════════════════════════════════════════════════════════════
//  5. FEES REPLACE, THEY NEVER STACK
// ══════════════════════════════════════════════════════════════════════

test('upgrading 10ft -> 26ft costs $150, NOT $250', () => {
  const a = assignTruck('1br', '26ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '26ft')
  assert.equal(a.upgradeAmount, 150, 'the larger fee REPLACES the smaller one')
  assert.equal(a.upgraded, true)
  assert.notEqual(a.upgradeAmount, 250, 'charging both the 15ft and 26ft fees would double-bill the same truck')
})

test('a 1BR upgrading to 15ft pays exactly $100', () => {
  const a = assignTruck('1br', '15ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.upgradeAmount, 100)
})

test('a retired truck request is REJECTED, never swapped for another size', () => {
  const a = assignTruck('2br', '20ft')
  assert.equal(a.ok, false)
  if (!a.ok) assert.equal(a.reason, 'unsupported_truck')
})

// ══════════════════════════════════════════════════════════════════════
//  6. THE SERVER TOTAL IS AUTHORITATIVE
// ══════════════════════════════════════════════════════════════════════

test('quoteEstimate totals = published base + required truck', () => {
  const expect: Array<[string, number]> = [
    ['1br', 550 + 0],
    ['2br', 779 + 100],
    ['3br', 1049 + 150],
    ['4br', 1449 + 150],
  ]
  for (const [key, total] of expect) {
    const q = quoteEstimate({ moveSize: key })
    assert.equal(q.ok, true, `${key} must price`)
    if (!q.ok) continue
    assert.equal(q.totalDollars, total, `${key} total`)
    assert.equal(q.totalCents, total * 100)
  }
})

test('the breakdown separates the base package from the truck line', () => {
  const q = quoteEstimate({ moveSize: '2br' })
  assert.equal(q.ok, true)
  if (!q.ok) return
  assert.equal(q.baseDollars, 779, 'base package')
  assert.equal(q.truckUpgrade, 100, 'required truck upgrade')
  assert.equal(q.baseDollars + q.truckUpgrade, q.totalDollars,
    'routed mileage is calculated separately and is NOT folded into either line')
})

test('a manipulated browser truck cannot lower the server total', () => {
  // "3 bedroom, but I picked the 10ft truck so I owe no upgrade"
  const q = quoteEstimate({ moveSize: '3br', truckSize: '10ft' })
  assert.equal(q.ok, true)
  if (!q.ok) return
  assert.equal(q.truckSize, '26ft')
  assert.equal(q.truckUpgrade, 150)
  assert.equal(q.totalDollars, 1049 + 150)
  assert.equal(q.truckCorrected, true)
})

test('5BR through quoteEstimate is a manual plan, not a silent price', () => {
  const q = quoteEstimate({ moveSize: '5br' })
  assert.equal(q.ok, false)
  if (!q.ok) assert.equal(q.reason, 'manual_plan')
})

// ══════════════════════════════════════════════════════════════════════
//  7. THE BROWSER MIRROR IS GENERATED FROM THIS SOURCE
// ══════════════════════════════════════════════════════════════════════

// The sibling checkout by default, but overridable: the site is developed in
// git worktrees, and a test that can only ever see ONE checkout silently
// reports on a branch nobody is working in. Point it at the branch under
// review with WMIWCI_SITE_DIR=/path/to/site-worktree.
const SITE_DIR = process.env.WMIWCI_SITE_DIR
  ? path.resolve(process.env.WMIWCI_SITE_DIR)
  : path.resolve(__dirname, '..', '..', '..', '..', 'WMIWCI-SITE')
const MIRROR = path.join(SITE_DIR, 'public', 'js', 'pricing-config.js')
// THESE TEST AGREEMENT, NOT PROVENANCE — which is why they no longer skip.
//
// They were gated on `MIRROR_REGENERATED`, on the reasoning that nothing could
// be asserted until the mirror was rebuilt from this source. That conflated
// two different things. Full REGENERATION is still blocked: the server price
// book does not yet carry the fields the live site reads (legacy,
// includedTruck, serviceType), which live in the owner's in-flight two-product
// work, so regenerating today would strip them — un-retiring three studio
// packages and blanking the booking form's truck copy.
//
// But AGREEMENT on the numbers can be checked right now, and it is the thing
// that actually protects a customer: a browser total that differs from the
// stored one is the bug, whoever authored the file. Skipping until the
// provenance was perfect meant the drift these tests exist to catch went
// unchecked for as long as the blocker lasted. Checking agreement found a real
// one — the mirror had no `10ft` entry, so a 1-bedroom truck fee read
// `undefined` on any path that trusted it.
const skipSite = {
  skip: !existsSync(MIRROR) ? 'WMIWCI-SITE checkout not present' : false,
}

function loadMirror(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { window: {} }
  runInNewContext(readFileSync(MIRROR, 'utf8'), sandbox)
  return (sandbox.window as Record<string, unknown>).WMIC_PRICING as Record<string, unknown>
}

test('browser and server agree on EVERY package price', skipSite, () => {
  const m = loadMirror()
  const pkgs = m.PACKAGES as Record<string, { price: { amount?: number } }>
  for (const [key, expected] of Object.entries(PUBLISHED)) {
    assert.ok(pkgs[key], `${key} missing from the browser mirror`)
    assert.equal(pkgs[key].price.amount ?? null, expected, `${key}: browser and server must agree`)
  }
})

test('browser and server agree on the truck fees', skipSite, () => {
  const m = loadMirror()
  const t = m.TRUCK_SIZE_UPGRADE as { amountByTruck: Record<string, number> } | undefined
  assert.ok(t, 'the mirror must carry TRUCK_SIZE_UPGRADE, generated from the server')
  // Spread BOTH sides. The mirror is executed with runInNewContext, so its
  // objects carry that realm's Object.prototype and a strict deep-equal fails
  // on prototype identity even when every key and value matches — "same
  // structure but not reference-equal". This never surfaced because the test
  // was skipped; it failed the moment it was allowed to run.
  assert.deepEqual({ ...t!.amountByTruck }, { ...TRUCK_SIZE_UPGRADE.amountByTruck })
  assert.equal((t!.amountByTruck as Record<string, number>)['20ft'], undefined,
    'the retired size must not reach the browser')
})

test('the mirror is GENERATED — a hand edit is what let the two drift', skipSite, () => {
  const src = readFileSync(MIRROR, 'utf8')
  assert.match(src.slice(0, 600), /GENERATED FILE/,
    'the header must keep saying so; the truck fees previously lived here as a hand edit and nowhere else')
})
