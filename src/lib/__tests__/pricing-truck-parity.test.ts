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

// ── OWNER RULING 2026-08-22: THE INCLUDED TRUCK COSTS NOTHING ─────────────
//  The published package prices INCLUDE the standard truck (1BR/10ft,
//  2BR/15ft, 3BR-5BR/26ft). These tests used to assert the opposite — that a
//  plain 2BR was charged $100 for the 15ft truck already inside its $779 — so
//  they pinned the very defect they were meant to guard. `cases` above records
//  each package's REQUIRED truck; the fee column is now what an upgrade to
//  that size WOULD cost, and is asserted only on genuine upgrades below.
test('each move size assigns its included truck and is charged NOTHING for it', () => {
  for (const [pkg, truck] of cases) {
    const a = assignTruck(pkg)
    assert.equal(a.ok, true, `${pkg} must assign`)
    if (!a.ok) continue
    assert.equal(a.assigned, truck, `${pkg} required truck`)
    assert.equal(a.minimum, truck)
    assert.equal(a.included, truck, `${pkg}: the required truck IS the included truck`)
    assert.equal(a.upgradeAmount, 0, `${pkg}: the included truck must add $0`)
    assert.equal(a.corrected, false)
    assert.equal(a.upgraded, false, 'no upgrade was requested, so none may be recorded')
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

//  Downgrading is still refused — the customer is CORRECTED back up to the
//  truck the job needs. What they are not is BILLED for it: being corrected to
//  the truck the package already includes is not an upgrade, so it costs $0.
//  The dodge these guard against is getting a smaller/cheaper JOB, not a
//  cheaper truck line.
test('a 3BR asking for a 10ft truck is CORRECTED to 26ft, at no extra charge', () => {
  const a = assignTruck('3br', '10ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '26ft', 'the job still gets the truck it needs')
  assert.equal(a.upgradeAmount, 0, 'the 26ft is already inside the 3BR price')
  assert.equal(a.corrected, true, 'the UI must be able to say the size was raised')
  assert.equal(a.upgraded, false, 'a correction is not an upgrade')
})

test('a 4BR asking for a 15ft truck is corrected to 26ft, at no extra charge', () => {
  const a = assignTruck('4br', '15ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '26ft')
  assert.equal(a.upgradeAmount, 0)
  assert.equal(a.corrected, true)
})

test('a 2BR claiming a 10ft truck still gets the 15ft, and still pays $0 for it', () => {
  const a = assignTruck('2br', '10ft')
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.equal(a.assigned, '15ft', 'claiming a smaller truck must not shrink the truck')
  assert.equal(a.upgradeAmount, 0, 'nor may it invent a charge for the included one')
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

test('quoteEstimate totals ARE the published prices — no truck surcharge', () => {
  // These are the owner's published numbers, exactly. Any drift here means a
  // customer is being quoted something other than what the site advertises.
  const expect: Array<[string, number]> = [
    ['1br', 550],
    ['2br', 779],
    ['3br', 1049],
    ['4br', 1449],
  ]
  for (const [key, total] of expect) {
    const q = quoteEstimate({ moveSize: key })
    assert.equal(q.ok, true, `${key} must price`)
    if (!q.ok) continue
    assert.equal(q.totalDollars, total, `${key} total`)
    assert.equal(q.totalCents, total * 100)
    assert.equal(q.truckUpgrade, 0, `${key}: the included truck must never be charged`)
  }
})

test('the breakdown separates the base package from the truck line', () => {
  const q = quoteEstimate({ moveSize: '2br' })
  assert.equal(q.ok, true)
  if (!q.ok) return
  assert.equal(q.baseDollars, 779, 'base package')
  assert.equal(q.truckUpgrade, 0, 'the 15ft is included in the 2BR price')
  assert.equal(q.includedTruck, '15ft', 'and the quote must SAY which truck that is')
  assert.equal(q.baseDollars + q.truckUpgrade, q.totalDollars,
    'routed mileage is calculated separately and is NOT folded into either line')
})

test('a manipulated browser truck cannot lower the server total', () => {
  // "3 bedroom, but I picked the 10ft truck so I get a smaller job"
  const q = quoteEstimate({ moveSize: '3br', truckSize: '10ft' })
  assert.equal(q.ok, true)
  if (!q.ok) return
  assert.equal(q.truckSize, '26ft', 'the server assigns the truck the job needs')
  assert.equal(q.truckUpgrade, 0)
  assert.equal(q.totalDollars, 1049, 'and the published price is unchanged')
  assert.equal(q.truckCorrected, true)
})

test('an EXPLICIT upgrade is charged once, and sends the quote to review', () => {
  // The only path that may ever add a truck charge.
  const up = quoteEstimate({ moveSize: '2br', truckSize: '26ft' })
  assert.equal(up.ok, true)
  if (!up.ok) return
  assert.equal(up.truckUpgrade, 150, 'the 26ft upgrade fee, charged once')
  assert.equal(up.totalDollars, 779 + 150)
  assert.equal(up.requiresReview, true,
    'a larger truck is an APPROVED upgrade — it may not settle automatically')

  const same = quoteEstimate({ moveSize: '2br', truckSize: '15ft' })
  assert.equal(same.ok, true)
  if (!same.ok) return
  assert.equal(same.truckUpgrade, 0, 'asking for the truck you already have is not an upgrade')
  assert.equal(same.requiresReview, false)
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

// ══════════════════════════════════════════════════════════════════════
//  8. THE STARTING PRICES SHOWN ON STEP 1
//
//  The move-size cards display a price before the contact gate. Those
//  amounts are DERIVED in the browser from this price book plus the truck
//  each size requires — never typed into the page. These are the figures the
//  owner approved, pinned here so a price change that would silently alter
//  what the cards advertise fails a test instead.
//
//  Every one of them EXCLUDES transportation, which is why the cards read
//  "From" and why the note beneath them says so.
// ══════════════════════════════════════════════════════════════════════

/** What a step-1 card shows, computed the way the page computes it. */
/** What the step-1 card actually shows. booking-form.html renders
 *  `PRICING.formatCharge(pkg.price)` — the BASE — and states the included
 *  truck in its own badge. This used to return base + the required truck's
 *  fee, a number no page has ever displayed. */
function cardTotal(pkgKey: string): number {
  const pkg = (PACKAGES as Record<string, { price: { amount: number } }>)[pkgKey]
  assert.ok(pkg, `${pkgKey} missing from the price book`)
  const truck = (MIN_TRUCK_BY_PACKAGE as Record<string, string>)[pkgKey]
  assert.ok(truck, `${pkgKey} has no required truck`)
  return pkg.price.amount
}

// ── THE PUBLISHED CARD PRICES (owner ruling 2026-08-22) ───────────────────
//  These are what booking-form.html actually renders — it prints
//  formatCharge(pkg.price), i.e. the BASE, and shows the included truck as a
//  separate "15 ft truck included" badge. This fixture previously read
//  { 2br: 879, 3br: 1199, 4br: 1599 } — base PLUS the required truck — which
//  never matched any page: cardTotal() computes from the price book rather
//  than reading the HTML, so the fixture and the site drifted apart unnoticed
//  while the SERVER quietly charged the surcharge.
const APPROVED_CARD_PRICES: Record<string, number> = {
  '1br': 550,
  '2br': 779,
  '3br': 1049,
  '4br': 1449,
}

test('every priced card shows the approved starting amount', () => {
  for (const [key, expected] of Object.entries(APPROVED_CARD_PRICES)) {
    assert.equal(cardTotal(key), expected, `${key} card must read $${expected}`)
  }
})

test('the card amount adds NO truck surcharge — the truck is included', () => {
  for (const key of Object.keys(APPROVED_CARD_PRICES)) {
    const base = (PACKAGES as Record<string, { price: { amount: number } }>)[key].price.amount
    assert.equal(cardTotal(key) - base, 0, `${key}: the card is the base price; the truck is included in it`)
  }
  // The one that would hide the regression: 2BR's truck has a non-zero UPGRADE
  // fee ($100), so if the surcharge ever creeps back it shows up here first.
  const twoBr = (TRUCK_SIZE_UPGRADE.amountByTruck as Record<string, number>)[
    (MIN_TRUCK_BY_PACKAGE as Record<string, string>)['2br']
  ]
  assert.equal(twoBr, 100, 'the 15ft upgrade fee still exists — it is simply not applied automatically')
  assert.equal(cardTotal('2br'), 779, 'and the 2BR card stays the published $779')
})

test('5+ bedrooms has no card price to show', () => {
  assert.equal(
    (MIN_TRUCK_BY_PACKAGE as Record<string, string>)['5br'],
    undefined,
    '5br must have no required truck — it may need several, which is why it is quoted by hand'
  )
  assert.ok(requiresManualTruckPlan('5br'), 'and it must be flagged as manual')
})

test('the card amount is the server-authoritative PRE-TRANSPORTATION total', () => {
  // Same figure the server returns for the same inputs, before any routed
  // mileage is added — so the card and the revealed estimate cannot disagree.
  for (const key of Object.keys(APPROVED_CARD_PRICES)) {
    const q = quoteEstimate({ moveSize: key })
    assert.ok(q.ok, `${key} must price`)
    if (!q.ok) continue
    assert.equal(
      q.totalDollars,
      cardTotal(key),
      `${key}: the step-1 card and the server total must be the same number`
    )
  }
})

test('the browser mirror can produce those same card amounts', skipSite, () => {
  // The page derives from the MIRROR, not from this file. If the mirror
  // drifts, the cards advertise something the server will not honour.
  const m = loadMirror()
  const pkgs = m.PACKAGES as Record<string, { price: { amount: number; kind: string } }>
  const INCLUDED: Record<string, string> = { '1br': '10ft', '2br': '15ft', '3br': '26ft', '4br': '26ft' }
  for (const [key, expected] of Object.entries(APPROVED_CARD_PRICES)) {
    // The card is formatCharge(pkg.price) — the base. No fee is added, which is
    // exactly what booking-form.html renders.
    assert.equal(pkgs[key].price.amount, expected, `${key} in the browser mirror`)
    // And the mirror must be able to NAME the truck that price covers, or the
    // "15 ft truck included" badge silently disappears.
    assert.equal((pkgs[key] as { includedTruck?: string }).includedTruck, INCLUDED[key],
      `${key}: the mirror must carry the included truck`)
  }
})
