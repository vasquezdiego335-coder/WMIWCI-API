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
  checkProductAvailability, isFullServiceIntakeEnabled, activeProducts, checkIntake,
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

// ── P0-01: the legal gate ────────────────────────────────────────────────

test('full-service fails CLOSED — anything but the literal "true" is off', () => {
  const original = process.env.FULL_SERVICE_INTAKE_ENABLED
  for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes', 'enabled']) {
    if (v === undefined) delete process.env.FULL_SERVICE_INTAKE_ENABLED
    else process.env.FULL_SERVICE_INTAKE_ENABLED = v
    assert.equal(isFullServiceIntakeEnabled(), false, `"${v}" must not enable it`)
    assert.equal(checkProductAvailability('full_service').available, false, `"${v}"`)
  }
  process.env.FULL_SERVICE_INTAKE_ENABLED = 'true'
  assert.equal(checkProductAvailability('full_service').available, true)
  if (original === undefined) delete process.env.FULL_SERVICE_INTAKE_ENABLED
  else process.env.FULL_SERVICE_INTAKE_ENABLED = original
})

test('labor-only is always available — it needs no carrier licence', () => {
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
  assert.equal(checkProductAvailability('labor_only').available, true)
  assert.deepEqual(activeProducts(), ['labor_only'])
})

test('the unavailable message makes no claim we cannot substantiate', () => {
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
  const v = checkProductAvailability('full_service')
  assert.equal(v.available, false)
  const both = `${(v as { message: string }).message} ${(v as { message_es: string }).message_es}`
  // No licensing status, no promised date, no insurance or carrier claim.
  for (const forbidden of [/licens/i, /insur/i, /carrier/i, /DOT/, /soon/i, /apply/i, /pending/i]) {
    assert.ok(!forbidden.test(both), `must not say: ${forbidden}`)
  }
  // It must still offer the product we CAN legally sell.
  assert.match((v as { message: string }).message, /labor-only/i)
  assert.match((v as { message: string }).message, /\$150\/hour/)
})

test('a full-service payload is refused while the gate is off, before anything else', () => {
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
  const errs = checkIntake({ product: 'full_service', packageKey: '2br' })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'product_unavailable')
})

// ── Contradictory products ───────────────────────────────────────────────

test('a one-hour labor-only request is rejected before it can reach Stripe', () => {
  const errs = checkIntake({ product: 'labor_only', laborMinutes: 60 })
  assert.equal(errs[0].code, 'labor_below_minimum')
  assert.match(errs[0].message, /2-hour minimum/)
})

test('labor-only carrying company-truck fields is a contradiction, not a preference', () => {
  const errs = checkIntake({ product: 'labor_only', laborMinutes: 180, hasCompanyTruckFields: true })
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
  const errs = checkIntake({ product: 'labor_only', laborMinutes: hoursToMinutes(1) })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'labor_below_minimum')
  assert.equal(errs[0].field, 'laborHours')
})

test('§5.5 — labor-only carrying company-truck fields is rejected as contradictory', () => {
  const errs = checkIntake({ product: 'labor_only', laborMinutes: 180, hasCompanyTruckFields: true })
  assert.ok(errs.some((e) => e.code === 'contradictory_product'))
})

test('§5.6 — full-service is refused while the legal gate is off, with no checkout', () => {
  delete process.env.FULL_SERVICE_INTAKE_ENABLED
  const errs = checkIntake({ product: 'full_service', packageKey: '2br' })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'product_unavailable')
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
