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

// ── WHICH SITE CHECKOUT IS BEING VALIDATED (fix 2026-08-22) ───────────────
//  This path was hard-wired to the sibling directory, so the parity gate
//  graded whatever branch happened to be checked out next door — not the
//  branch being released. That is how the deployed mirror drifted out of sync
//  with pricing-config.ts while these tests stayed green: the sibling checkout
//  held a different branch's copy. WMIWCI_SITE_DIR now points the gate at the
//  tree under test (CI and release worktrees set it); the sibling remains the
//  default so an ordinary local run is unchanged.
const SITE = resolve(process.env.WMIWCI_SITE_DIR ?? resolve(__dirname, '../../../../WMIWCI-SITE'))
const MIRROR = resolve(SITE, 'public/js/pricing-config.js')
const FORM = resolve(SITE, 'public/booking-form.html')

const siteAvailable = existsSync(SITE)
//  A MISSING SITE STILL SKIPS, but an EXPLICITLY POINTED one never may: if
//  WMIWCI_SITE_DIR is set and wrong, silently skipping would hand back a green
//  run that proved nothing about the release.
if (process.env.WMIWCI_SITE_DIR && !siteAvailable) {
  throw new Error(`WMIWCI_SITE_DIR=${process.env.WMIWCI_SITE_DIR} does not exist — parity cannot be proven`)
}
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
  // The booking authorization is the ONLY $49 the browser may know about.
  assert.ok(js.includes('"bookingAuthorizationAmount"'), 'booking authorization id missing')
  // ── INVERTED 2026-08-18. This used to require "truckPickupReturnFee" in the
  //    mirror so "both $49s stay separate". The truck add-on is RETIRED, and a
  //    price the browser can read is a price a page can quote — that shipped
  //    constant is what kept a withdrawn product on the services page and in
  //    the booking form's estimate rows. It stays SERVER-side for historical
  //    bookings (see TRUCK_PICKUP_RETURN in pricing-config.ts) and must never
  //    reach the mirror again.
  assert.ok(!js.includes('"truckPickupReturnFee"'), 'RETIRED truck add-on must not ship to the browser')
  assert.ok(!js.includes('TRUCK_PICKUP_RETURN'), 'RETIRED truck add-on must not ship to the browser')
})

test('parity: the booking form loads the mirror and defines no prices itself', { skip }, () => {
  assert.ok(existsSync(FORM), `missing ${FORM}`)
  const html = readFileSync(FORM, 'utf8')

  // The src may carry a cache-buster (`?v=4`) -- bumping it is how a price
  // change reaches returning visitors, so it MUST be allowed. An earlier
  // version of this pattern demanded a bare path and failed the moment the
  // version was bumped, testing the string instead of the behaviour.
  assert.ok(
    /<script[^>]+src=["']\/?js\/pricing-config\.js(\?[^"']*)?["']/.test(html),
    'booking-form.html must load js/pricing-config.js'
  )

  // The old local tables must be gone — they were the drift mechanism.
  assert.ok(!/const\s+SERVICES\s*=\s*\{[\s\S]{0,80}price:/.test(html), 'booking-form.html still defines a local SERVICES price table')
  assert.ok(!/const\s+MODIFIERS\s*=\s*\{/.test(html), 'booking-form.html still defines a local MODIFIERS table')
})

/** Remove HTML comments, JS block comments and JS line comments, so a note
 *  ABOUT a retired price is never mistaken for an offer OF one. `//` inside a
 *  URL (https://…) is deliberately preserved. */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1 ')
}

test('parity: no retired price appears anywhere in the deployed site', { skip }, () => {
  // Every price we have ever withdrawn, oldest generation first. The 2026-07-31
  // studio tiers (379/439/549) and the old 1BR (649) were MISSING here, which
  // is why this test stayed green while public/quote.html offered "Small Studio
  // $379" — the guard listed the previous generation of retired prices only.
  // A price added to LEGACY_PACKAGE_KEYS must be added here in the same commit.
  const RETIRED = [359, 379, 409, 439, 509, 549, 599, 649, 699, 949, 1249, 1549]
  const files = [
    'public/booking-form.html', 'public/pricing.html', 'public/services.html',
    'public/faq.html', 'public/index.html', 'public/terms/index.html',
    'public/js/pricing-config.js', 'public/popup/popup.js',
  ]
  const offenders: string[] = []
  for (const rel of files) {
    const p = resolve(SITE, rel)
    if (!existsSync(p)) continue
    // COMMENTS ARE NOT PUBLISHED PRICES. Several of these files carry a note
    // explaining WHY a tier was withdrawn, and those notes necessarily name the
    // retired amount. Scanning raw bytes flagged the documentation and would
    // pressure the next reader into deleting either the note or this guard.
    // Strip comments first, then assert on what a customer can actually read.
    const text = stripComments(readFileSync(p, 'utf8'))
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
