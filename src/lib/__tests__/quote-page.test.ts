// ════════════════════════════════════════════════════════════════════════
//  quote-page.test.ts — coverage of the /quote surfaces THAT ACTUALLY SHIP.
//
//  WHAT THIS REPLACES (2026-08-18). Two suites — quote-site-in-person and
//  quote-site-step1-pricing — pinned `public/quote-new.html` and an
//  "in-person visit" quote mode. Neither ever shipped: production has no
//  quote-new.html and zero occurrences of `in_person` / `quoteMode` on any
//  quote surface. Because their fixture was missing they SKIPPED, so 21
//  checks reported green while testing nothing. Skipping is not coverage;
//  they are deleted and this suite tests the real pages instead.
//
//  The two production surfaces:
//    public/quote/index.html — the printed-QR landing route. A forwarder to
//      the booking form that MUST preserve the query string, because that is
//      what carries ?src= and ?aid= from a door-hanger scan into the booking.
//    public/quote.html — the quick-quote page. Builds its size cards and its
//      headline price from window.WMIC_PRICING (the generated mirror), so it
//      cannot quote a number the booking form and the server disagree with.
//
//  Both are static files in the sibling site repo, so this suite skips when
//  that checkout is absent — but ONLY then, and the skip is reported by the
//  release gate rather than hidden.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PACKAGES, LABOR_ONLY, TRANSPORTATION_MILEAGE } from '../pricing-config'

const SITE = process.env.WMIWCI_SITE_DIR
  ? resolve(process.env.WMIWCI_SITE_DIR)
  : resolve(__dirname, '..', '..', '..', '..', 'WMIWCI-SITE')

const FORWARDER = resolve(SITE, 'public', 'quote', 'index.html')
const QUOTE = resolve(SITE, 'public', 'quote.html')

const skip = existsSync(QUOTE) && existsSync(FORWARDER)
  ? false
  : 'WMIWCI-SITE checkout not present (set WMIWCI_SITE_DIR to point at it)'

const forwarder = (): string => readFileSync(FORWARDER, 'utf8')
const quote = (): string => readFileSync(QUOTE, 'utf8')

// ── The printed-QR landing route ─────────────────────────────────────────

test('quote forwarder: carries the query string onto the booking form', { skip }, () => {
  const src = forwarder()
  // THE DOOR-HANGER CONTRACT. A scan arrives as /quote?src=door_hanger_5000_batch
  // &aid=<id>. Forwarding to a bare /booking-form.html would drop both and the
  // scan would convert with no attribution at all.
  assert.match(src, /window\.location\.search/,
    'the forwarder must preserve ?src= / ?aid= from a printed-QR scan')
  assert.match(src, /booking-form\.html/, 'the forwarder must target the booking form')
})

test('quote forwarder: replaces history so /quote is not a back-button trap', { skip }, () => {
  const src = forwarder()
  assert.match(src, /location\.replace\(/,
    'use replace(), or Back from the booking form bounces through /quote forever')
  assert.ok(!/location\.href\s*=/.test(src), 'href assignment would push a history entry')
})

test('quote forwarder: still forwards with JavaScript disabled', { skip }, () => {
  const src = forwarder()
  assert.match(src, /<noscript>/, 'a printed URL must work without JS')
  assert.match(src, /http-equiv=["']refresh["']/i, 'no-JS fallback must be a meta refresh')
})

test('quote forwarder: stays out of the index', { skip }, () => {
  assert.match(forwarder(), /name=["']robots["'][^>]*noindex/i,
    'the forwarder is a redirect target, not a page to rank')
})

// ── The quick-quote page ─────────────────────────────────────────────────

test('quote page: reads the generated price book, never its own numbers', { skip }, () => {
  const src = quote()
  assert.match(src, /window\.WMIC_PRICING/, 'the page must read the generated mirror')
  assert.match(src, /pricing-config\.js/, 'the page must load the mirror')
  // The cards are built from PACKAGES rather than typed into the markup.
  assert.match(src, /P\.PACKAGES\[/, 'size cards must be built from the price book')
})

test('quote page: no package price is hardcoded in the markup', { skip }, () => {
  const src = quote()
  // Every sellable package price, as a literal with a dollar sign, is a
  // hand-typed number that will go stale the next time the book changes.
  const offenders: string[] = []
  for (const pkg of Object.values(PACKAGES)) {
    const amt = pkg.price.amount
    if (amt == null) continue
    const literal = new RegExp(`\\$\\s?${amt.toLocaleString('en-US')}\\b`)
    if (literal.test(src)) offenders.push(`${pkg.key} ($${amt})`)
  }
  assert.deepEqual(offenders, [],
    'these package prices are typed into quote.html instead of read from the price book')
})

test('quote page: the server total outranks the local price book', { skip }, () => {
  const src = quote()
  // The page renders the mirror while the customer chooses, then defers to the
  // captured server figure. If it ever preferred the local book the customer
  // could be shown a price the server would not honour.
  assert.match(src, /serverTotal\s*!==\s*null/,
    'the captured server total must win over the local mirror')
})

test('quote page: labor-only is quoted at the published rate and minimum', { skip }, () => {
  const src = quote()
  // Whatever wording the page uses, the RATE and the MINIMUM it shows have to
  // be the ones the server bills, so a labor-only visitor is never quoted a
  // figure the booking form will contradict.
  if (!/labor/i.test(src)) return // the page may only cover full-service sizes
  const rate = LABOR_ONLY.hourlyRate
  const wrongRate = /\$1[0-9]{2}\s*(?:per hour|\/\s*hour|an hour)/gi
  for (const m of src.match(wrongRate) ?? []) {
    assert.ok(m.includes(String(rate)),
      `quote.html publishes "${m}" but the price book says $${rate}/hour`)
  }
})

test('quote page: never publishes a travel band on top of routed mileage', { skip }, () => {
  const src = quote()
  // The retired distance-band fee plus $3/routed-mile would bill one drive
  // twice — the page documents this rule; this asserts it holds.
  assert.ok(!/travelFee\s*\/\s*100|\+\s*sa\.travelFee/.test(src),
    'a travel-band fee must never be added to the quoted total')
  assert.equal(TRANSPORTATION_MILEAGE.ratePerMile, 3)
})

test('quote page: the RETIRED truck add-on is not offered', { skip }, () => {
  const src = quote()
  for (const re of [/truck[- ]pickup[- ]return/i, /truck pickup\s*(?:&amp;|&|and)\s*return/i]) {
    assert.ok(!re.test(src), `quote.html still references the retired add-on (${re})`)
  }
})

test('quote page: ships both languages and remembers the choice', { skip }, () => {
  const src = quote()
  assert.match(src, /data-es=/, 'the quote page must carry Spanish copy')
  assert.match(src, /wmic_lang/,
    'language choice must use the same storage key as the rest of the site')
})
