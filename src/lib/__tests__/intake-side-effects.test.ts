// ════════════════════════════════════════════════════════════════════════
//  intake-side-effects.test.ts — NOTHING IS WRITTEN FOR A BOOKING WE ARE
//  NOT ALLOWED TO TAKE.
//
//  THE REGRESSION THIS EXISTS TO PREVENT (found 2026-08-14): the product gate
//  was placed AFTER `prisma.customer.upsert`, so a one-hour labor-only request
//  — which we refuse — had already created a Customer row before being told
//  no. A refusal that leaves a real person in the database is not a refusal.
//
//  ⚠ WHAT THESE TESTS ARE: a STATIC ORDERING GUARD over the route source, plus
//  runtime tests of the pure decision function. They are NOT a live HTTP
//  invocation with a mocked database — Node 20 has no `mock.module`, and the
//  route has no dependency injection seam. The ordering guard is what actually
//  broke, so it is what is pinned; the honest limitation is stated here rather
//  than implied away.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  checkIntake, isRetiredTruckOption, RETIRED_TRUCK_OPTION_ALIASES, hoursToMinutes,
} from '../product-catalog'

const ROUTE = resolve(__dirname, '../../../app/api/bookings/route.ts')
const raw = readFileSync(ROUTE, 'utf8')

/**
 * Source with comments blanked out, LENGTH-PRESERVING so byte offsets still
 * line up with the original file.
 *
 * Load-bearing: the gate's own comment explains the regression by NAMING
 * `prisma.customer.upsert`, and that prose sits above the gate. Ordering
 * checks run against code, so a rule about code must not be satisfied — or
 * broken — by a sentence that merely mentions the same identifier.
 */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))

/** Every call in the booking route that writes, charges, or costs money. */
const SIDE_EFFECTS: { label: string; needle: string }[] = [
  { label: 'customer lookup', needle: 'prisma.customer.findUnique' },
  { label: 'customer upsert', needle: 'prisma.customer.upsert' },
  { label: 'booking insert', needle: 'prisma.booking.create' },
  { label: 'Stripe checkout', needle: 'createBookingCheckout(' },
  { label: 'address verification (paid API)', needle: 'verifyAddress(' },
]

test('the product gate precedes EVERY side effect in the booking route', () => {
  const gate = src.indexOf('const intakeErrors = checkIntake({')
  assert.ok(gate > -1, 'the route must run checkIntake')
  const refusal = src.indexOf('if (intakeErrors.length) {')
  assert.ok(refusal > gate, 'the refusal must follow the check')

  for (const { label, needle } of SIDE_EFFECTS) {
    const at = src.indexOf(needle)
    if (at === -1) continue // call removed entirely — nothing to order against
    assert.ok(
      refusal < at,
      `${label} (${needle}) runs at ${at}, BEFORE the gate's refusal at ${refusal}. ` +
        'A refused booking must not write anything.',
    )
  }
})

test('the gate reads the RAW truckOption, not the alias-normalised one', () => {
  // booking-schema folds `full-148`/`reserve-99` into `truck-pickup-return`,
  // so reading the parsed value would hide which spelling arrived.
  assert.ok(src.includes('rawTruckOption(body)'), 'the gate must read the unparsed body')
})

// ── The retired add-on ───────────────────────────────────────────────────

test('every known Truck Pickup & Return alias is recognised as retired', () => {
  for (const alias of ['truck-pickup-return', 'full-148', 'reserve-99', 'truck_pickup_return', 'truckPickupReturn']) {
    assert.equal(isRetiredTruckOption(alias), true, alias)
    assert.ok(RETIRED_TRUCK_OPTION_ALIASES.has(alias), alias)
  }
  // A live option is untouched.
  assert.equal(isRetiredTruckOption('own-truck'), false)
  assert.equal(isRetiredTruckOption(null), false)
  assert.equal(isRetiredTruckOption(''), false)
})

test('a retired add-on is REFUSED — never dropped, never substituted', () => {
  for (const alias of Array.from(RETIRED_TRUCK_OPTION_ALIASES)) {
    const errs = checkIntake({ product: 'labor_only', laborMinutes: 180, truckOption: alias })
    assert.equal(errs.length, 1, alias)
    assert.equal(errs[0].code, 'service_retired', alias)
    assert.equal(errs[0].field, 'truckOption', alias)
    // Silently dropping it would send no one for the truck they are expecting;
    // silently substituting would bill a service nobody chose.
    assert.match(errs[0].message, /no longer offer/i)
    assert.ok(!/\$49|\$50/.test(errs[0].message), 'must not quote a retired price')
  }
})

test('the retirement is checked FIRST — before product, package or hours', () => {
  // A request that is wrong in several ways still reports the withdrawn
  // service, because re-booking without it is the only next step that helps.
  const errs = checkIntake({
    product: 'full_service',
    packageKey: 'little-studio', // also retired
    truckOption: 'truck-pickup-return',
  })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'service_retired')
})

// ── The two-hour minimum ─────────────────────────────────────────────────

test('below two hours is refused, and the refusal names the minimum', () => {
  for (const hours of [0.5, 1, 1.5, 1.75]) {
    const errs = checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: hoursToMinutes(hours) })
    assert.equal(errs.length, 1, `${hours}h`)
    assert.equal(errs[0].code, 'labor_below_minimum', `${hours}h`)
    assert.equal(errs[0].field, 'laborHours', `${hours}h`)
  }
  // Exactly two hours is fine.
  assert.deepEqual(checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: 120 }), [])
})

test('one hour is never silently billed as two — it is refused outright', () => {
  const errs = checkIntake({ product: 'labor_only', laborService: 'load_and_unload', laborMinutes: 60 })
  assert.equal(errs[0].code, 'labor_below_minimum')
  // The message tells them what to choose; it does not announce a substitution.
  assert.ok(!/we will bill|billed at|charged for two/i.test(errs[0].message))
})
