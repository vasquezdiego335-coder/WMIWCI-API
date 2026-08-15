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
//  It also pins the compliance wording around the rental-truck pickup and
//  return add-on. That service does NOT yet have rental-agreement,
//  insurance or NJ-licensing sign-off (owner confirmed 2026-07-25), so it
//  is published REVIEW-GATED: the page must never say it is approved,
//  guaranteed or automatic, and must never imply the fee covers the truck
//  rental itself. If someone later softens that copy, this test fails.
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
  assert.ok(checked >= 3, `expected several data-amount hooks, saw ${checked}`)
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

test('services page: truck add-on is priced from the price book, not hardcoded', { skip }, () => {
  const src = visible(html())
  // The fee may only ever appear via the data-amount hook.
  const hooks = src.match(/data-amount="TRUCK_PICKUP_RETURN\.amount">([^<]+)</g) ?? []
  assert.ok(hooks.length >= 2,
    'the truck add-on fee must render from TRUCK_PICKUP_RETURN.amount')
  for (const h of hooks) {
    const v = /">([^<]+)</.exec(h)![1]
    assert.equal(decode(v), '$' + TRUCK_PICKUP_RETURN.amount,
      'truck add-on fallback disagrees with TRUCK_PICKUP_RETURN.amount')
  }
  // Guard the $50 slip that appeared in a 2026-07-25 brief.
  assert.ok(!/\$50\s*(?:pickup|truck)/i.test(src),
    'the truck add-on is $49 in the price book; do not publish $50')
})

test('services page: truck add-on stays review-gated and never claims approval', { skip }, () => {
  const src = visible(html())

  // Required honesty, all of it customer-visible.
  const required: [RegExp, string][] = [
    [/Pending review/i,                          'must be labelled pending review'],
    [/reservation must be in your name/i,         'must state the reservation is the customer\'s'],
    [/must be confirmed before your move is approved/i, 'must state confirmation precedes approval'],
    [/covers our pickup-and-return labor only/i,  'must state the fee is labor only'],
    [/It is not the truck rental/i,               'must state the fee is not the rental'],
    [/remain yours/i,                             'must list the costs that stay the customer\'s'],
  ]
  for (const [re, why] of required) {
    assert.match(src, re, `truck add-on copy ${why}`)
  }

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
