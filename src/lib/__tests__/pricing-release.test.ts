// ════════════════════════════════════════════════════════════════════════
//  pricing-release.test.ts — a material price change must ship as a RELEASE.
//
//  THE FAILURE THIS PREVENTS. On 2026-08-22 the truck rule changed (the
//  included truck stopped being charged: 2BR $879 -> $779, 3BR $1,199 ->
//  $1,049, 4BR $1,599 -> $1,449) while PRICE_BOOK_VERSION stayed '2026-08-22'
//  and the browser asset stayed `pricing-config.js?v=7`. Two consequences,
//  both silent:
//
//    • every browser and CDN holding the old ?v=7 file keeps serving it, so
//      the fix reaches nobody until the URL changes;
//    • a stored quote cannot say which of the two 2026-08-22 rule sets made
//      it, because both call themselves '2026-08-22'.
//
//  So this file FINGERPRINTS the material price book. If the fingerprint moves
//  and the version and cache key have not, the release is incomplete and this
//  fails with instructions. It is deliberately noisy: a pricing change is
//  supposed to be a decision, not a diff that slips through.
//
//  WHAT COUNTS AS MATERIAL: anything that can change a number a customer is
//  quoted, or which packages they may pick. Labels, notes and Spanish copy are
//  excluded — rewording a note is not a repricing.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PACKAGES,
  PRICE_BOOK_VERSION,
  PRICING_ASSET_CACHE_KEY,
  TRUCK_SIZE_UPGRADE,
  MIN_TRUCK_BY_PACKAGE,
  TRANSPORTATION_MILEAGE,
  LABOR_ONLY,
  LABOR_PER_WORKER_RATE_CENTS,
  PRICED_PACKAGE_KEYS,
  LEGACY_PACKAGE_KEYS,
  BOOKING_AUTHORIZATION,
} from '../pricing-config'

const SITE = resolve(process.env.WMIWCI_SITE_DIR ?? resolve(__dirname, '../../../../WMIWCI-SITE'))
if (process.env.WMIWCI_SITE_DIR && !existsSync(SITE)) {
  throw new Error(`WMIWCI_SITE_DIR=${process.env.WMIWCI_SITE_DIR} does not exist — the release cannot be verified`)
}
const skipSite = existsSync(SITE) ? false : 'WMIWCI-SITE not available'

/** Deterministic JSON: keys sorted at every level, so property ORDER can never
 *  move the fingerprint on its own. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
}

/** Only the fields that can change what a customer is charged or offered. */
function materialPriceBook(): unknown {
  return {
    packages: Object.fromEntries(
      Object.entries(PACKAGES).map(([key, p]) => [
        key,
        {
          amount: p.price.amount ?? null,
          kind: p.price.kind,
          requiresReview: p.requiresReview === true,
          legacy: p.legacy === true,
          includedTruck: p.includedTruck ?? null,
          upgradeTruck: p.upgradeTruck ?? null,
        },
      ]),
    ),
    truckUpgrade: TRUCK_SIZE_UPGRADE.amountByTruck,
    minTruck: MIN_TRUCK_BY_PACKAGE,
    mileageRateCents: TRANSPORTATION_MILEAGE.ratePerMileCents,
    laborHourlyCents: LABOR_ONLY.hourlyRateCents,
    laborMinimumMinutes: LABOR_ONLY.minimumMinutes,
    laborPerWorkerCents: LABOR_PER_WORKER_RATE_CENTS,
    bookingAuthorizationCents: BOOKING_AUTHORIZATION.amountCents,
    priced: [...PRICED_PACKAGE_KEYS].sort(),
    legacyKeys: [...LEGACY_PACKAGE_KEYS].sort(),
  }
}

const fingerprint = createHash('sha256').update(stable(materialPriceBook())).digest('hex').slice(0, 16)

// ── THE PINNED RELEASE ────────────────────────────────────────────────────
//  Change all three together, or not at all.
const RELEASE = {
  fingerprint: '9fbadf9e91dd2c3c',
  priceBookVersion: '2026-08-22.2',
  assetCacheKey: '8',
} as const

test('release: a material price change carries a new version AND a new cache key', () => {
  assert.equal(
    fingerprint,
    RELEASE.fingerprint,
    [
      '',
      'The MATERIAL price book changed.',
      '',
      `  computed fingerprint : ${fingerprint}`,
      `  pinned fingerprint   : ${RELEASE.fingerprint}`,
      '',
      'That is a RELEASE, not an edit. Do all of these in the same commit:',
      '  1. bump PRICE_BOOK_VERSION in src/lib/pricing-config.ts (monotonic,',
      '     e.g. 2026-08-22.2 -> 2026-08-22.3), and note what changed;',
      '  2. bump PRICING_ASSET_CACHE_KEY (8 -> 9) — without it every browser',
      '     and CDN keeps serving the old mirror and nobody receives the fix;',
      '  3. update the ?v= token on every <script src="js/pricing-config.js">',
      '     in the SITE repo to match;',
      '  4. regenerate the mirror: npm run gen:pricing-config;',
      '  5. update RELEASE above with the three new values.',
      '',
    ].join('\n'),
  )
  assert.equal(PRICE_BOOK_VERSION, RELEASE.priceBookVersion)
  assert.equal(PRICING_ASSET_CACHE_KEY, RELEASE.assetCacheKey)
})

test('release: the price-book version is monotonic, not merely a date', () => {
  // A bare date cannot separate two releases on one day, which is exactly what
  // happened here. Require an explicit ordinal suffix.
  assert.match(
    PRICE_BOOK_VERSION,
    /^\d{4}-\d{2}-\d{2}\.\d+$/,
    'PRICE_BOOK_VERSION must be <date>.<ordinal>, e.g. 2026-08-22.2',
  )
})

test('release: every SITE consumer requests the current cache key', { skip: skipSite }, () => {
  const CONSUMERS = [
    'public/booking-form.html',
    'public/quote.html',
    'public/pricing.html',
    'public/services.html',
  ]
  const stale: string[] = []
  const seen: string[] = []
  for (const rel of CONSUMERS) {
    const p = resolve(SITE, rel)
    if (!existsSync(p)) continue
    seen.push(rel)
    const html = readFileSync(p, 'utf8')
    // Every <script src=...pricing-config.js?v=N> on the page must be current.
    for (const m of Array.from(html.matchAll(/src=["'][^"']*pricing-config\.js\?v=([^"'&]+)["']/g))) {
      if (m[1] !== PRICING_ASSET_CACHE_KEY) stale.push(`${rel}: ?v=${m[1]}`)
    }
  }
  assert.ok(seen.length > 0, 'no SITE consumer pages were found to check')
  assert.deepEqual(stale, [], `these pages still request a stale pricing mirror (expected ?v=${PRICING_ASSET_CACHE_KEY})`)
})

test('release: no SITE consumer loads the mirror without a cache key at all', { skip: skipSite }, () => {
  // An unversioned URL is permanently cacheable and can never be busted.
  const offenders: string[] = []
  for (const rel of ['public/booking-form.html', 'public/quote.html', 'public/pricing.html', 'public/services.html']) {
    const p = resolve(SITE, rel)
    if (!existsSync(p)) continue
    const html = readFileSync(p, 'utf8')
    for (const m of Array.from(html.matchAll(/<script[^>]+src=["']([^"']*pricing-config\.js[^"']*)["']/g))) {
      if (!/\?v=/.test(m[1])) offenders.push(`${rel}: ${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], 'a pricing mirror is loaded without a cache-busting token')
})

test('release: the generated mirror carries the same version the server reports', { skip: skipSite }, () => {
  const mirror = resolve(SITE, 'public/js/pricing-config.js')
  if (!existsSync(mirror)) return
  const js = readFileSync(mirror, 'utf8')
  assert.ok(
    js.includes(`"PRICE_BOOK_VERSION": ${JSON.stringify(PRICE_BOOK_VERSION)}`),
    `the mirror does not carry PRICE_BOOK_VERSION ${PRICE_BOOK_VERSION} — run: npm run gen:pricing-config`,
  )
})
