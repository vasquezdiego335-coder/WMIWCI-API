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
  PACKAGES, PACKAGE_INCLUDES, TRUCK_PICKUP_RETURN, BOOKING_AUTHORIZATION,
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
}
function resolvePath(path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => {
    if (o === null || o === undefined) return undefined
    return (o as Record<string, unknown>)[k]
  }, BOOK)
}

test('services page: every package price fallback matches the price book', { skip }, () => {
  const src = html()
  let checked = 0
  for (const [key, pkg] of Object.entries(PACKAGES)) {
    if (key === 'not-sure') continue          // never rendered as a card
    const m = new RegExp(`data-pkg-price="${key}">([^<]+)<`).exec(src)
    assert.ok(m, `no data-pkg-price="${key}" on the page`)
    assert.equal(decode(m![1]), formatCharge(pkg.price, 'en'),
      `stale fallback for ${key}`)
    checked++
  }
  assert.equal(checked, 8, 'expected all eight room-size packages on the page')
})

test('services page: "Starting at" stays structural on review-gated floors', { skip }, () => {
  const src = html()
  for (const [key, pkg] of Object.entries(PACKAGES)) {
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
  for (const [key, pkg] of Object.entries(PACKAGES)) {
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
