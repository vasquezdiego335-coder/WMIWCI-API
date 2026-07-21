// ════════════════════════════════════════════════════════════════════════
//  pricing-parity.test.ts — THE guard that makes the cutover atomic.
//
//  The booking form is static HTML/JS and cannot import TypeScript, so it reads
//  a GENERATED mirror (WMIWCI-SITE/public/js/pricing-config.js) produced from
//  src/lib/pricing-config.ts by `npm run gen:pricing-config`.
//
//  This test re-generates the payload in memory and asserts the checked-in
//  file matches byte-for-byte. If someone edits a price on either side without
//  regenerating, the browser and the server would quote different numbers —
//  and this test fails instead of a customer being mis-billed.
//
//  It also asserts the static site carries NO hard-coded package price of its
//  own, and that the booking form actually loads the mirror.
//
//  SKIPS CLEANLY when the sibling site repo is not checked out (CI running the
//  API alone) — a missing repo must not be reported as a passing parity check.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildPricingPayload, renderPricingConfigJs } from '../../../scripts/gen-pricing-config'
import { PACKAGES, TRUCK_PICKUP_RETURN, BOOKING_AUTHORIZATION } from '../pricing-config'

const SITE = resolve(__dirname, '../../../../WMIWCI-SITE')
const MIRROR = resolve(SITE, 'public/js/pricing-config.js')
const FORM = resolve(SITE, 'public/booking-form.html')

const siteAvailable = existsSync(SITE)
const skip = siteAvailable ? false : 'WMIWCI-SITE not checked out beside WMIWCI-API'

test('parity: the generated browser mirror matches pricing-config.ts exactly', { skip }, () => {
  assert.ok(existsSync(MIRROR), `missing ${MIRROR} — run: npm run gen:pricing-config`)
  const onDisk = readFileSync(MIRROR, 'utf8')
  const expected = renderPricingConfigJs(buildPricingPayload())
  assert.equal(
    onDisk,
    expected,
    'pricing-config.js is stale or hand-edited — run: npm run gen:pricing-config'
  )
})

test('parity: every package price survives the trip into the mirror', { skip }, () => {
  const js = readFileSync(MIRROR, 'utf8')
  for (const pkg of Object.values(PACKAGES)) {
    if (pkg.price.amount == null) continue
    assert.ok(
      js.includes(`"amount": ${pkg.price.amount}`),
      `${pkg.key} price ${pkg.price.amount} missing from the mirror`
    )
  }
  // The two $49s must BOTH be present as separately-keyed values.
  assert.ok(js.includes('"bookingAuthorizationAmount"'), 'booking authorization id missing')
  assert.ok(js.includes('"truckPickupReturnFee"'), 'truck add-on id missing')
  assert.equal(BOOKING_AUTHORIZATION.amount, TRUCK_PICKUP_RETURN.amount)
})

test('parity: the booking form loads the mirror and defines no prices itself', { skip }, () => {
  assert.ok(existsSync(FORM), `missing ${FORM}`)
  const html = readFileSync(FORM, 'utf8')

  assert.ok(
    /<script[^>]+src=["']\/?js\/pricing-config\.js["']/.test(html),
    'booking-form.html must load js/pricing-config.js'
  )

  // The old local tables must be gone — they were the drift mechanism.
  assert.ok(!/const\s+SERVICES\s*=\s*\{[\s\S]{0,80}price:/.test(html), 'booking-form.html still defines a local SERVICES price table')
  assert.ok(!/const\s+MODIFIERS\s*=\s*\{/.test(html), 'booking-form.html still defines a local MODIFIERS table')
})

test('parity: no retired price appears anywhere in the deployed site', { skip }, () => {
  const RETIRED = [359, 409, 509, 599, 699, 949, 1249, 1549]
  const files = [
    'public/booking-form.html', 'public/pricing.html', 'public/services.html',
    'public/faq.html', 'public/index.html', 'public/terms/index.html',
    'public/js/pricing-config.js', 'public/popup/popup.js',
  ]
  const offenders: string[] = []
  for (const rel of files) {
    const p = resolve(SITE, rel)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const n of RETIRED) {
      // Match a money-formatted retired price: $359 or $1,249 — not a stray
      // coordinate, opacity, or pixel value.
      const re = new RegExp(`\\$\\s?${n.toLocaleString('en-US').replace(',', ',?')}\\b`)
      if (re.test(text)) offenders.push(`${rel}: $${n}`)
    }
  }
  assert.deepEqual(offenders, [], 'retired prices still published on the live site')
})

test('parity: the site publishes the truck add-on at $49, never $50', { skip }, () => {
  const files = ['public/pricing.html', 'public/services.html', 'public/faq.html', 'public/terms/index.html']
  const offenders: string[] = []
  for (const rel of files) {
    const p = resolve(SITE, rel)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    // A "+$50" next to truck wording is the exact stale pattern.
    if (/\+\$50/.test(text)) offenders.push(`${rel}: +$50`)
  }
  assert.deepEqual(offenders, [], 'truck add-on still published at $50')
  assert.equal(TRUCK_PICKUP_RETURN.amount, 49)
})
