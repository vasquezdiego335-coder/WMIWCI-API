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
import { readFileSync, existsSync, readdirSync } from 'node:fs'
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
import { SITE_DIR, SKIP_WITHOUT_SITE, siteFile } from './site-dir'

const skipSite = SKIP_WITHOUT_SITE

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

// ── THE RELEASE HISTORY ───────────────────────────────────────────────────
//  APPEND-ONLY. Every material price book that has ever shipped, with the
//  version and cache key it shipped under.
//
//  A single pinned triple was not enough: updating ONLY the fingerprint made
//  the test pass again while the version and cache key stayed put — which is
//  precisely the mistake the file exists to catch, and it required no more
//  effort than pasting the number the failure message printed. A history
//  cannot be satisfied that way. Reusing a version or a cache key for a
//  DIFFERENT fingerprint now fails on its own, whatever else is edited.
const RELEASES: ReadonlyArray<{ fingerprint: string; priceBookVersion: string; assetCacheKey: string; note: string }> = [
  {
    fingerprint: '9fbadf9e91dd2c3c',
    priceBookVersion: '2026-08-22.2',
    assetCacheKey: '8',
    note: 'studios retired; included truck stops being charged (2BR 879->779, 3BR 1199->1049, 4BR 1599->1449)',
  },
  {
    // SAME fingerprint as 2026-08-22.2 on purpose: V4 changed BEHAVIOUR, not a
    // published price. A behaviour release still needs its own version and
    // cache key — the stored quotes it produces are shaped differently, and the
    // browser must fetch the mirror again — so the version and key are unique
    // while the price-book identity is unchanged. That is why fingerprints may
    // repeat across releases and identifiers may never.
    fingerprint: '9fbadf9e91dd2c3c',
    priceBookVersion: '2026-08-22.3',
    assetCacheKey: '9',
    note: 'review state returned/persisted/displayed; retired refusal independent of the capture flag',
  },
]

/** The release being shipped: always the last entry. */
const RELEASE = RELEASES[RELEASES.length - 1]

/** SHA-256 over every entry EXCEPT the newest, so shipped history is frozen.
 *  Recompute ONLY when appending: the value covers entries 0..n-2, so appending
 *  entry n means pinning the hash that now includes what used to be newest. */
const HISTORY_PREFIX_SHA = '8f056f37caa233df'

test('release: shipped history is frozen — earlier entries cannot be rewritten', () => {
  // Without this, the cheapest way to make the fingerprint assertion pass is to
  // overwrite a PREVIOUS release with today's values, erasing the record of
  // what customers were actually quoted under it.
  const prefix = RELEASES.slice(0, -1)
  const sha = createHash('sha256').update(stable(prefix)).digest('hex').slice(0, 16)
  assert.equal(
    sha,
    HISTORY_PREFIX_SHA,
    'A shipped release entry was modified or removed. Shipped history is a record, ' +
      'not a scratchpad — append a new entry instead. If you are legitimately APPENDING, ' +
      `update HISTORY_PREFIX_SHA to ${sha}.`,
  )
})

test('release: the history never reuses a price-book version or a cache key', () => {
  // The identifiers are what a browser and a stored quote are keyed on, so
  // reusing either makes two different releases indistinguishable. Fingerprints
  // MAY repeat (a behaviour-only release does not move a price); the version
  // and the cache key may not, ever.
  const versions = new Set<string>()
  const keys = new Set<string>()
  for (const r of RELEASES) {
    assert.ok(!versions.has(r.priceBookVersion), `two releases share priceBookVersion ${r.priceBookVersion}`)
    assert.ok(!keys.has(r.assetCacheKey), `two releases share assetCacheKey ${r.assetCacheKey}`)
    versions.add(r.priceBookVersion)
    keys.add(r.assetCacheKey)
  }
  // Versions must ASCEND, so history cannot be reordered into nonsense.
  const ordinal = (v: string): number => Number(v.split('.').pop())
  for (let i = 1; i < RELEASES.length; i++) {
    const prev = RELEASES[i - 1].priceBookVersion
    const cur = RELEASES[i].priceBookVersion
    const ascends = cur > prev || (cur.slice(0, 10) === prev.slice(0, 10) && ordinal(cur) > ordinal(prev))
    assert.ok(ascends, `price-book versions must ascend: ${prev} -> ${cur}`)
  }
})

test('release: a material price change carries a new version AND a new cache key', () => {
  assert.equal(
    fingerprint,
    RELEASE.fingerprint,
    [
      '',
      'The MATERIAL price book changed.',
      '',
      `  computed fingerprint : ${fingerprint}`,
      `  newest pinned        : ${RELEASE.fingerprint} (${RELEASE.priceBookVersion}, ?v=${RELEASE.assetCacheKey})`,
      '',
      'That is a RELEASE, not an edit. Do all of these in the same commit:',
      '  1. bump PRICE_BOOK_VERSION in src/lib/pricing-config.ts (monotonic,',
      '     e.g. 2026-08-22.3 -> 2026-08-22.4), and note what changed;',
      '  2. bump PRICING_ASSET_CACHE_KEY (9 -> 10) — without it every browser',
      '     and CDN keeps serving the old mirror and nobody receives the fix;',
      '  3. update the ?v= token on EVERY consumer in the SITE repo to match;',
      '  4. regenerate the mirror: npm run gen:pricing-config;',
      '  5. APPEND a new entry to RELEASES above. Do not edit an existing one:',
      '     the history test refuses a reused version or cache key, so pasting',
      '     this fingerprint over the last entry will not make the suite green.',
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

/** Every tracked HTML/JS file under the SITE's served roots. Walked, not
 *  listed: a hardcoded set of four filenames silently stops covering the fifth
 *  page somebody adds, which is the same "it looked green" failure as before. */
function siteSourceFiles(): string[] {
  const roots = ['public', 'pages', 'sites'].map((r) => siteFile(r)).filter((p) => existsSync(p))
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      // node_modules and build output are not what the site SERVES from source.
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue
        walk(full)
      } else if (/\.(html?|js)$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  roots.forEach(walk)
  return out
}

/** Every `<script src=…pricing-config.js…>` reference, wherever it lives. */
function pricingConsumers(): { file: string; src: string; version: string | null }[] {
  const found: { file: string; src: string; version: string | null }[] = []
  for (const file of siteSourceFiles()) {
    // The generated mirror is the asset itself, not a consumer of it.
    if (/[\\/]js[\\/]pricing-config\.js$/i.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const m of Array.from(text.matchAll(/<script[^>]+src=["']([^"']*pricing-config\.js[^"']*)["']/gi))) {
      const src = m[1]
      const v = /[?&]v=([^"'&]+)/.exec(src)
      found.push({ file: file.slice((SITE_DIR ?? '').length + 1), src, version: v ? v[1] : null })
    }
  }
  return found
}

test('release: EVERY discovered SITE consumer requests the current cache key', { skip: skipSite }, () => {
  const consumers = pricingConsumers()
  assert.ok(consumers.length > 0, 'no pricing-config.js consumer was discovered — the walk is broken')

  const stale = consumers
    .filter((c) => c.version !== PRICING_ASSET_CACHE_KEY)
    .map((c) => `${c.file}: ${c.src}`)
  assert.deepEqual(
    stale,
    [],
    `these consumers do not request ?v=${PRICING_ASSET_CACHE_KEY}. Every page that loads the ` +
      'price book must move together, or some pages quote the new book and others the old one.',
  )
})

test('release: no discovered consumer loads the mirror without a cache key', { skip: skipSite }, () => {
  // An unversioned URL is permanently cacheable and can never be busted.
  const unversioned = pricingConsumers().filter((c) => c.version === null).map((c) => `${c.file}: ${c.src}`)
  assert.deepEqual(unversioned, [], 'a pricing mirror is loaded without a cache-busting token')
})

test('release: the consumer walk actually reaches the known pages', { skip: skipSite }, () => {
  // A walk that silently found nothing would make the two tests above vacuous.
  const files = new Set(pricingConsumers().map((c) => c.file.replace(/\\/g, '/')))
  for (const expected of ['public/quote.html', 'public/booking-form.html', 'public/pricing.html', 'public/services.html']) {
    assert.ok(files.has(expected), `the walk did not reach ${expected} — it is a known consumer`)
  }
})

test('release: the generated mirror carries the same version the server reports', { skip: skipSite }, () => {
  const mirror = siteFile('public/js/pricing-config.js')
  if (!existsSync(mirror)) return
  const js = readFileSync(mirror, 'utf8')
  assert.ok(
    js.includes(`"PRICE_BOOK_VERSION": ${JSON.stringify(PRICE_BOOK_VERSION)}`),
    `the mirror does not carry PRICE_BOOK_VERSION ${PRICE_BOOK_VERSION} — run: npm run gen:pricing-config`,
  )
})
