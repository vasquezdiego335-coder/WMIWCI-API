// ════════════════════════════════════════════════════════════════════════
//  product-catalog.test.ts — the 2026-08-14 repair audit's binding rules,
//  asserted directly.
//
//  Covers audit items:
//    P0-01  full-service intake fails CLOSED while unlicensed
//    P0-02  labor-only is $150/hr, two movers, two-hour minimum
//    P0-04  retired studio rates are historical-only
//
//  Offline and pure — no database, no network, no API key.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABOR_ONLY_RATE_CENTS, LABOR_ONLY_MINIMUM_MINUTES, LABOR_ONLY_WORKERS,
  laborOnlyEstimateCents, hoursToMinutes,
  ACTIVE_PACKAGE_KEYS, RETIRED_PACKAGE_KEYS, isPackageActiveForNewIntake,
  isRetiredPackage, isKnownPackage,
  ACTIVE_PRODUCTS, isProductActive, serviceCatalog, PRICING_VERSION, checkIntake,
} from '../product-catalog'
import { computeQuote } from '../booking-quote'
import { PACKAGES } from '../pricing-config'

// ── P0-02: the published labor-only rate ─────────────────────────────────

test('the rate is $150/hour for TWO movers with a two-hour minimum', () => {
  assert.equal(LABOR_ONLY_RATE_CENTS, 15_000)
  assert.equal(LABOR_ONLY_MINIMUM_MINUTES, 120)
  assert.equal(LABOR_ONLY_WORKERS, 2) // the rate covers both, not per person
})

test('three hours is $450 — the audit acceptance figure', () => {
  const e = laborOnlyEstimateCents(180)
  assert.equal(e.subtotalCents, 45_000)
  assert.equal(e.billableMinutes, 180)
  assert.equal(e.minimumApplied, false)
})

test('the two-hour minimum lifts the price but never rewrites the request', () => {
  const e = laborOnlyEstimateCents(60)
  assert.equal(e.requestedMinutes, 60)   // what they asked for is preserved
  assert.equal(e.billableMinutes, 120)   // what we bill
  assert.equal(e.minimumApplied, true)   // and the owner can see why
  assert.equal(e.subtotalCents, 30_000)  // $300
})

test('half-hours are exact in cents — no float drift', () => {
  assert.equal(laborOnlyEstimateCents(150).subtotalCents, 37_500) // 2.5h = $375
  assert.equal(laborOnlyEstimateCents(210).subtotalCents, 52_500) // 3.5h = $525
  assert.equal(laborOnlyEstimateCents(270).subtotalCents, 67_500) // 4.5h = $675
  assert.equal(hoursToMinutes(2.5), 150)
})

test('no rounding policy is invented beyond the published minimum', () => {
  // 2h05m bills as 2h05m, NOT rounded up to 2h30m. Inventing a rounding rule
  // silently raises prices, and the audit forbids it without owner approval.
  assert.equal(laborOnlyEstimateCents(125).billableMinutes, 125)
  assert.equal(laborOnlyEstimateCents(125).subtotalCents, 31_250)
})

test('a nonsense duration cannot produce a negative or NaN price', () => {
  for (const bad of [NaN, Infinity, -60, undefined as unknown as number]) {
    const e = laborOnlyEstimateCents(bad)
    assert.equal(e.subtotalCents, 30_000) // falls back to the minimum
    assert.ok(Number.isInteger(e.subtotalCents))
  }
})

// ── P0-04: retired studio rates ──────────────────────────────────────────

test('the three retired studio rates are not sellable', () => {
  for (const key of ['little-studio', 'half-studio', 'full-studio']) {
    assert.ok(RETIRED_PACKAGE_KEYS.has(key), key)
    assert.equal(isPackageActiveForNewIntake(key), false, key)
    assert.equal(isRetiredPackage(key), true, key)
    // …but they remain READABLE, so historical bookings still render.
    assert.equal(isKnownPackage(key), true, key)
  }
})

test('the active list is what a new customer may choose', () => {
  assert.ok(ACTIVE_PACKAGE_KEYS.includes('1br'))
  assert.ok(ACTIVE_PACKAGE_KEYS.includes('2br'))
  assert.ok(!ACTIVE_PACKAGE_KEYS.some((k) => RETIRED_PACKAGE_KEYS.has(k)))
})

test('a retired key is REJECTED at intake, never remapped to a live price', () => {
  process.env.FULL_SERVICE_INTAKE_ENABLED = 'true'
  const errs = checkIntake({ product: 'full_service', packageKey: 'little-studio' })
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'package_retired')
  // Silently mapping $379 → $550 would charge someone $171 they never agreed to.
  assert.ok(!/550/.test(errs[0].message))
})

// ── BOTH PRODUCTS ARE ACTIVE (owner decision 2026-08-14) ─────────────────

test('both products are active and bookable', () => {
  assert.deepEqual(Array.from(ACTIVE_PRODUCTS).sort(), ['full_service', 'labor_only'])
  assert.equal(isProductActive('full_service'), true)
  assert.equal(isProductActive('labor_only'), true)
})

test('no environment variable can switch a product off', () => {
  // The old FULL_SERVICE_INTAKE_ENABLED gate defaulted to OFF wherever it had
  // not been set, which is how a live product disappeared. Sellability is a
  // business fact, not deployment configuration.
  process.env.FULL_SERVICE_INTAKE_ENABLED = 'false'
  assert.equal(isProductActive('full_service'), true)
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
  assert.equal(isProductActive('full_service'), true)
})

test('the catalogue returns both services with everything the SITE needs', () => {
  const cat = serviceCatalog()
  assert.equal(cat.length, 2)

  const fs = cat.find((c) => c.key === 'full_service')!
  assert.equal(fs.pricingModel, 'flat_package')
  assert.equal(fs.truckResponsibility, 'company')
  assert.equal(fs.active, true)
  assert.equal(fs.pricingVersion, PRICING_VERSION)
  assert.ok(fs.label && fs.label_es && fs.description && fs.description_es)
  // The published full-service prices, unchanged, in integer cents.
  const price = (k: string) => fs.packages!.find((p) => p.key === k)!.priceCents
  assert.equal(price('1br'), 55_000)
  assert.equal(price('2br'), 77_900)
  assert.equal(price('3br'), 104_900)
  assert.equal(price('4br'), 144_900)
  assert.equal(price('5br'), 179_900)
  // Retired studios are absent from what may be sold.
  assert.ok(!fs.packages!.some((p) => RETIRED_PACKAGE_KEYS.has(p.key)))

  const lo = cat.find((c) => c.key === 'labor_only')!
  assert.equal(lo.pricingModel, 'hourly')
  assert.equal(lo.truckResponsibility, 'customer')
  assert.equal(lo.active, true)
  assert.equal(lo.hourly!.rateCents, 15_000)
  assert.equal(lo.hourly!.minimumMinutes, 120)
  assert.equal(lo.hourly!.workers, 2)
  // SIX services, from the price book — the live form builds its grid from
  // this list, so a shorter one here would silently drop half the products.
  assert.equal(lo.hourly!.services.length, 6)
  assert.deepEqual(lo.hourly!.services.map((s) => s.key), [
    'loading_only', 'unloading_only', 'loading_and_unloading',
    'in_home_furniture', 'storage_unit_help', 'moving_container_help',
  ])
  for (const s of lo.hourly!.services) assert.ok(s.label && s.label_es)
  // Only loading AND unloading spans two addresses, which is what makes the
  // crew's time between them billable.
  assert.deepEqual(
    lo.hourly!.services.filter((s) => s.twoAddresses).map((s) => s.key),
    ['loading_and_unloading'],
  )
})

test('a valid full-service intake succeeds', () => {
  assert.deepEqual(checkIntake({ product: 'full_service', packageKey: '1br' }), [])
  assert.deepEqual(checkIntake({ product: 'full_service', packageKey: '5br' }), [])
})

test('the service type is REQUIRED and never inferred', () => {
  for (const missing of [undefined, null, '', 'moving', 'labor-only-ish']) {
    const errs = checkIntake({ product: missing as string, packageKey: '1br' })
    assert.equal(errs[0].code, 'service_type_missing', String(missing))
    assert.equal(errs[0].field, 'serviceTypeKey')
  }
})

test('full-service without an active package is rejected', () => {
  assert.equal(checkIntake({ product: 'full_service' })[0].code, 'package_missing')
  assert.equal(checkIntake({ product: 'full_service', packageKey: 'nope' })[0].code, 'package_unknown')
  assert.equal(checkIntake({ product: 'full_service', packageKey: 'little-studio' })[0].code, 'package_retired')
})

test('full-service carrying labor hours is rejected — two pricing models, one booking', () => {
  const errs = checkIntake({ product: 'full_service', packageKey: '2br', laborMinutes: 180 })
  assert.ok(errs.some((e) => e.code === 'contradictory_product' && e.field === 'laborHours'))
})

test('labor-only carrying a full-service package is rejected', () => {
  const errs = checkIntake({ product: 'labor_only', laborMinutes: 180, laborService: 'load_and_unload', packageKey: '2br' })
  assert.ok(errs.some((e) => e.code === 'contradictory_product' && e.field === 'moveSizeKey'))
})

test('labor-only requires an estimate and a labor service', () => {
  assert.ok(checkIntake({ product: 'labor_only', laborService: 'load_and_unload' }).some((e) => e.code === 'labor_hours_missing'))
  assert.ok(checkIntake({ product: 'labor_only', laborMinutes: 180 }).some((e) => e.code === 'labor_service_missing'))
})

// ── Contradictory products ───────────────────────────────────────────────

test('a one-hour labor-only request is rejected before it can reach Stripe', () => {
  const errs = checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: 60 })
  assert.equal(errs[0].code, 'labor_below_minimum')
  assert.match(errs[0].message, /2-hour minimum/)
})

test('labor-only carrying company-truck fields is a contradiction, not a preference', () => {
  const errs = checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: 180, hasCompanyTruckFields: true })
  assert.equal(errs[0].code, 'contradictory_product')
})

test('a clean three-hour labor-only request passes', () => {
  assert.deepEqual(checkIntake({ product: 'labor_only', laborMinutes: 180, laborService: 'load_and_unload' }), [])
})

// ══════════════════════════════════════════════════════════════════════════
//  AUDIT ACCEPTANCE SCENARIOS (§5 of the 2026-08-14 repair audit)
//  The money figures below are the audit's own, asserted in integer cents
//  through the canonical quote engine.
// ══════════════════════════════════════════════════════════════════════════

test('§5.1 — labor-only, 3 hours, no add-ons: the quote is $450', () => {
  const labor = laborOnlyEstimateCents(hoursToMinutes(3))
  assert.equal(labor.subtotalCents, 45_000)
  const q = computeQuote({ totalEstimate: labor.subtotalCents / 100, depositCents: 4900 })
  assert.equal(q.finalTotalCents, 45_000)
  // The $49 is an AUTHORIZATION, not a collection: nothing is collected yet.
  assert.equal(q.collectedCents, 0)
  assert.equal(q.depositCaptured, false)
})

test('§5.2 — same booking with 10% off: $405, and $356 after one capture', () => {
  const labor = laborOnlyEstimateCents(hoursToMinutes(3))
  const before = computeQuote({ totalEstimate: labor.subtotalCents / 100, discountPercent: 10, depositCents: 4900 })
  assert.equal(before.discountCents, 4_500)
  assert.equal(before.finalTotalCents, 40_500) // $405
  const after = computeQuote({
    totalEstimate: labor.subtotalCents / 100, discountPercent: 10,
    depositCents: 4900, collectedCents: 4900,
  })
  assert.equal(after.remainingCents, 35_600) // $356
})

test('§5.4 — a one-hour labor-only request never reaches Stripe', () => {
  const errs = checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: hoursToMinutes(1) })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'labor_below_minimum')
  assert.equal(errs[0].field, 'laborHours')
})

test('§5.5 — labor-only carrying company-truck fields is rejected as contradictory', () => {
  const errs = checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: 180, hasCompanyTruckFields: true })
  assert.ok(errs.some((e) => e.code === 'contradictory_product'))
})

// §5.6 of the repair audit required full-service to be REFUSED behind a
// licensing gate. SUPERSEDED by the owner on 2026-08-14: Move It Clear It sells
// two products and both are bookable. The assertion is inverted deliberately —
// full-service submissions must SUCCEED — so that reintroducing the gate breaks
// a test instead of silently removing a live product again.
test('full-service is bookable — the licensing gate is gone, and stays gone', () => {
  assert.deepEqual(checkIntake({ product: 'full_service', packageKey: '2br' }), [])
  assert.deepEqual(checkIntake({ product: 'full_service', packageKey: '1br' }), [])
})

test('§5.7 — a historical $379 studio still reads; a new one is refused', () => {
  process.env.FULL_SERVICE_INTAKE_ENABLED = 'true'
  // READ: the package still resolves, so an old booking renders its own price.
  assert.equal(isKnownPackage('little-studio'), true)
  assert.equal(PACKAGES['little-studio'].price.amount, 379)
  // WRITE: a new intake using it is refused outright.
  assert.equal(checkIntake({ product: 'full_service', packageKey: 'little-studio' })[0].code, 'package_retired')
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
})
