// ════════════════════════════════════════════════════════════════════════
//  services-page-parity.test.ts — the Services page carries every price
//  TWICE: hard-written in the markup (so the page is correct with
//  JavaScript disabled) and re-stamped at runtime from the generated
//  browser mirror by public/js/services.js.
//
//  The runtime path keeps the page correct after a price change. THIS test
//  keeps the no-JS FALLBACK honest — without it, a price rise would leave
//  stale numbers rendering for anyone with JS blocked, and the Services
//  page would quietly contradict the booking form.
//
//  It also proves the RENTAL-TRUCK PICKUP AND RETURN add-on is GONE. That
//  service was withdrawn (owner decision 2026-08-14) and the server refuses
//  it at intake, but the page kept selling it — a schema.org Offer, an
//  "Add Truck Pickup & Return — $49" button, a rate row and an FAQ line —
//  until 2026-08-18. These tests now fail if any of it comes back.
//
//  SKIPS CLEANLY when the sibling site repo is absent.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PACKAGES, PACKAGE_INCLUDES, TRUCK_PICKUP_RETURN, BOOKING_AUTHORIZATION, LEGACY_PACKAGE_KEYS,
  TRANSPORTATION_MILEAGE, LABOR_ONLY, TRUCK_SIZE_UPGRADE, SERVICE_TYPES,
  STAIRS, LONG_CARRY, HEAVY_ITEM, ASSEMBLY, ADDITIONAL_LOCATION, TRAVEL,
  WAITING_TIME, ELEVATOR, PARKING_TOLLS_DELAYS, WEEKEND_HOLIDAY, MATERIALS,
  formatCharge, type Charge,
} from '../pricing-config'

const PAGE = resolve(__dirname, '../../../../WMIWCI-SITE/public/services.html')
const skip = existsSync(PAGE) ? false : 'WMIWCI-SITE services.html not present'

const html = (): string => readFileSync(PAGE, 'utf8')

/** The markup uses HTML entities where formatCharge emits real characters. */
const decode = (s: string): string =>
  s.replace(/&ndash;/g, '–')
   .replace(/&mdash;/g, '—')
   .replace(/&amp;/g, '&')
   .replace(/&nbsp;/g, ' ')
   .trim()

/** Customer-visible text only — source comments legitimately discuss the
 *  removed/limited wording and must not be scanned as if they were copy. */
const visible = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '')

/** Same dotted-path resolver services.js uses for data-rate. */
const BOOK: Record<string, unknown> = {
  STAIRS, LONG_CARRY, HEAVY_ITEM, ASSEMBLY, ADDITIONAL_LOCATION, TRAVEL,
  WAITING_TIME, ELEVATOR, PARKING_TOLLS_DELAYS, WEEKEND_HOLIDAY, MATERIALS,
  PACKAGES, TRUCK_PICKUP_RETURN, BOOKING_AUTHORIZATION,
  // The two-product keys the page now quotes from. Their absence here was
  // not the page being wrong — it was this resolver not yet knowing the
  // reconstructed price book, so a correct $3/mile read as "not a number".
  TRANSPORTATION_MILEAGE, LABOR_ONLY, TRUCK_SIZE_UPGRADE, SERVICE_TYPES,
}
function resolvePath(path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => {
    if (o === null || o === undefined) return undefined
    return (o as Record<string, unknown>)[k]
  }, BOOK)
}


/** The package keys this page actually presents, in document order. The page
 *  is a summary; pricing.html carries the full table. */
function pkgKeysOnPage(html: string): string[] {
  const out: string[] = []
  const re = /data-pkg-price="([a-z0-9-]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) if (!out.includes(m[1])) out.push(m[1])
  return out
}

test('services page: every package price fallback matches the price book', { skip }, () => {
  const src = html()
  let checked = 0
  // THE INVARIANT IS PRICE ACCURACY, NOT PAGE INVENTORY.
  //
  // This loop used to walk every entry in PACKAGES and demand a card for each.
  // That failed twice over: it required the three RETIRED studio tiers
  // ($379/$439/$549) to still be advertised, and it required 4BR/5BR cards on
  // a page that is a three-tier summary linking to pricing.html for the full
  // table (which does carry all five).
  //
  // What actually matters is that every price the page DOES show is the price
  // book's, and that no withdrawn package reappears as a current offer. That
  // is strictly stronger against the real risks — a wrong number, or a retired
  // rate resurfacing — and it does not dictate editorial content.
  for (const key of pkgKeysOnPage(src)) {
    assert.ok(
      !LEGACY_PACKAGE_KEYS.includes(key),
      `services.html advertises the RETIRED package "${key}" — withdrawn rates are readable on historical bookings, never a current offer`,
    )
    const pkg = PACKAGES[key as keyof typeof PACKAGES]
    assert.ok(pkg, `services.html shows an unknown package "${key}"`)
    if (key === 'not-sure') continue          // never rendered as a card
    const m = new RegExp(`data-pkg-price="${key}">([^<]+)<`).exec(src)
    assert.ok(m, `no data-pkg-price="${key}" on the page`)
    assert.equal(decode(m![1]), formatCharge(pkg.price, 'en'),
      `stale fallback for ${key}`)
    checked++
  }
  // The page is a three-tier summary, not the full table (pricing.html has all
  // five sellable packages). What must hold is that it shows SOMETHING and that
  // everything it shows is priced from the book — not a fixed count that
  // silently required the retired studios back.
  assert.ok(checked >= 1, 'services.html shows no package prices at all')
})

test('services page: "Starting at" stays structural on review-gated floors', { skip }, () => {
  const src = html()
  // SELLABLE packages only. This loop used to walk every entry in PACKAGES,
  // which includes the three retired studio tiers ($379/$439/$549) — so it
  // demanded that a withdrawn price still be advertised on the live services
  // page. Retired packages stay READABLE on historical bookings and must not
  // appear as a current offer, so the page is right and the loop was wrong.
  for (const key of pkgKeysOnPage(src)) {
    const pkg = PACKAGES[key as keyof typeof PACKAGES]
    if (pkg.price.kind !== 'starting') continue
    const m = new RegExp(`data-pkg-price="${key}">([^<]+)<`).exec(src)
    assert.match(decode(m![1]), /^Starting at /,
      `${key} is a review-gated floor and must never render as a flat rate`)
  }
})

test('services page: every add-on rate fallback matches the price book', { skip }, () => {
  const src = html()
  const re = /data-rate="([^"]+)">([^<]+)</g
  let m: RegExpExecArray | null
  let checked = 0
  while ((m = re.exec(src)) !== null) {
    const charge = resolvePath(m[1]) as Charge | undefined
    assert.ok(charge && typeof charge === 'object' && 'kind' in charge,
      `data-rate="${m[1]}" does not resolve to a Charge`)
    assert.equal(decode(m[2]), formatCharge(charge as Charge, 'en'),
      `stale fallback for ${m[1]}`)
    checked++
  }
  assert.ok(checked >= 25, `expected the full rate table, saw ${checked} rows`)
})

test('services page: plain dollar fallbacks match the price book', { skip }, () => {
  const src = html()
  const re = /data-amount="([^"]+)">([^<]+)</g
  let m: RegExpExecArray | null
  let checked = 0
  while ((m = re.exec(src)) !== null) {
    const n = resolvePath(m[1])
    assert.equal(typeof n, 'number', `data-amount="${m[1]}" is not a number`)
    assert.equal(decode(m[2]), '$' + (n as number).toLocaleString('en-US'),
      `stale amount for ${m[1]}`)
    checked++
  }
  // Was `>= 3`. Four of the five hooks on this page were the RETIRED truck
  // add-on's fee (removed 2026-08-18); the survivor is the transportation
  // per-mile rate. What matters is that whatever IS published resolves to the
  // price book — the loop above — not that a withdrawn product keeps padding
  // the count.
  assert.ok(checked >= 1, `expected at least one data-amount hook, saw ${checked}`)
})

test('services page: crew lines are DERIVED, never a hand-written number', { skip }, () => {
  const src = html()
  // SELLABLE packages only. This loop used to walk every entry in PACKAGES,
  // which includes the three retired studio tiers ($379/$439/$549) — so it
  // demanded that a withdrawn price still be advertised on the live services
  // page. Retired packages stay READABLE on historical bookings and must not
  // appear as a current offer, so the page is right and the loop was wrong.
  for (const key of pkgKeysOnPage(src)) {
    const pkg = PACKAGES[key as keyof typeof PACKAGES]
    if (key === 'not-sure') continue
    const m = new RegExp(`data-pkg-crew="${key}"[^>]*>([^<]+)<`).exec(src)
    assert.ok(m, `no data-pkg-crew="${key}" on the page`)
    const expected = pkg.requiresReview
      ? 'Crew size confirmed after review.'
      : PACKAGE_INCLUDES[0].en
    assert.equal(decode(m![1]), expected, `wrong crew line for ${key}`)
  }
})

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  THE RETIRED TRUCK ADD-ON IS GONE FROM THE SITE — 2026-08-18.
 *
 *  These two tests are INVERTED from what they were. They used to require the
 *  services page to CARRY the add-on: at least two `data-amount=
 *  "TRUCK_PICKUP_RETURN.amount"` hooks, plus six lines of review-gated
 *  honesty copy. That made the page structurally obliged to keep selling a
 *  product the server refuses at intake (`checkIntake` → `service_retired`).
 *
 *  What was live until today: a schema.org Offer for "Rental-Truck Pickup and
 *  Return Labor" (invisible to CSS, fully visible to crawlers), an "Add Truck
 *  Pickup & Return — $49" button, a rate-table row, and an FAQ paragraph.
 *  A customer who clicked it would have been refused by the API with a 422.
 *
 *  The honesty copy is not weakened by its removal — there is no longer an
 *  offer for it to qualify. The constant stays SERVER-side so historical
 *  bookings keep rendering their original line item.
 * ═══════════════════════════════════════════════════════════════════════
 */
test('services page: the RETIRED truck add-on is not sold anywhere on it', { skip }, () => {
  const src = visible(html())
  const raw = html()

  // No price hook can publish the retired fee.
  assert.equal((src.match(/data-amount="TRUCK_PICKUP_RETURN\.amount"/g) ?? []).length, 0,
    'services.html still renders the retired truck add-on price')

  // No customer-visible copy may name it, in either language.
  for (const re of [/truck pickup\s*(?:&amp;|&|and)\s*return/i, /pickup[- ]and[- ]return labor/i, /recogida y devoluci/i]) {
    assert.ok(!re.test(src), `services.html still advertises the retired add-on (${re})`)
  }

  // And no structured-data Offer may keep it alive for crawlers, which CSS
  // hiding never covered — this is how it stayed "hidden" yet published.
  assert.ok(!/Rental-Truck Pickup and Return/i.test(raw),
    'services.html still publishes a schema.org Offer for the retired add-on')

  // The CTA that seeded a booking draft with the retired value must be gone.
  assert.ok(!/data-truck="truck-pickup-return"/i.test(raw),
    'services.html still carries the retired add-on CTA')
})

test('services page: honest full/labor truck copy survives the removal', { skip }, () => {
  const src = visible(html())

  // Language that would over-promise a service without legal/insurance sign-off.
  const banned: [RegExp, string][] = [
    [/we do all the driving/i,        'promises driving outright'],
    [/you don.t need to drive/i,      'promises driving outright'],
    [/guaranteed/i,                   'guarantees an unapproved service'],
    [/automatically approved/i,       'claims automatic approval'],
    [/instantly (?:approved|confirmed)/i, 'claims instant approval'],
  ]
  for (const [re, why] of banned) {
    assert.ok(!re.test(src), `Services page ${why} — remove it`)
  }
})

test('services page: $49 authorization wording is intact', { skip }, () => {
  const src = visible(html())
  assert.equal(BOOKING_AUTHORIZATION.amount, 49, 'authorization amount moved')
  assert.match(src, /captured and applied toward your total only after/i,
    'the hold must be described as captured only AFTER approval')
  assert.match(src, /If the request is declined, the hold is released/i,
    'the release-on-decline promise must be present')
  for (const bad of [/book instantly/i, /lock in your date/i, /pay \$49 today/i]) {
    assert.ok(!bad.test(src), `misleading booking language on the page: ${bad}`)
  }
})

test('services page: room-size prices are scoped to complete moves', { skip }, () => {
  const src = visible(html())
  assert.match(src,
    /room-size prices below are for complete loading-and-unloading labor moves/i,
    'the package grid must state the prices are for COMPLETE moves, so a ' +
    'loading-only customer cannot assume the same price applies')
})
