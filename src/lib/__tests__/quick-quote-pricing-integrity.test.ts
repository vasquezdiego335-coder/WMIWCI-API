// ════════════════════════════════════════════════════════════════════════
//  quick-quote-pricing-integrity.test.ts — the regression wall around the
//  2026-08-22 incident.
//
//  WHAT HAPPENED. A quick-quote lead was created for "Small Studio — $379",
//  a tier withdrawn on 2026-07-31. Three things had to be true at once:
//
//    1. public/quote.html builds its size cards by iterating the generated
//       price book and skipping `if (pkg.legacy) return;` — but NO package
//       carried a `legacy` field, so the filter was dead code and the retired
//       tier rendered as the FIRST and CHEAPEST option on the page.
//    2. quoteEstimate() priced whatever key it was handed. MOVE_SIZES is
//       derived from PACKAGES, which keeps retired tiers so history still
//       renders — so "sellable never" was a comment, not a rule.
//    3. product-catalog.ts already had the correct guard
//       (isPackageActiveForNewIntake). The quote path simply never asked it.
//
//  Discord was NOT at fault: it read the persisted lead faithfully. It showed
//  a wrong number because a wrong number had been stored.
//
//  Every test below states which of those it prevents. They are offline and
//  pure — no Discord message, no email, no payment, no database write.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import {
  PACKAGES,
  LEGACY_PACKAGE_KEYS,
  PRICE_BOOK_VERSION,
  TRANSPORTATION_MILEAGE,
  mileageChargeForMiles,
  LABOR_ONLY,
  LABOR_PER_WORKER_RATE_CENTS,
  SERVICE_TYPES,
} from '../pricing-config'
import { ACTIVE_PACKAGE_KEYS, isPackageActiveForNewIntake, isRetiredPackage } from '../product-catalog'
import { quoteEstimate, compareClientTotal } from '../quote-estimate'
import { computeQuote } from '../booking-quote'
import { formatLeadAlert } from '../lead-alert'

// ── The site tree under test. See pricing-parity.test.ts for why this is an
//    env var and not the hard-wired sibling directory. ──
const SITE = resolve(process.env.WMIWCI_SITE_DIR ?? resolve(__dirname, '../../../../WMIWCI-SITE'))
const MIRROR = resolve(SITE, 'public/js/pricing-config.js')
const QUOTE_PAGE = resolve(SITE, 'public/quote.html')
const skipSite = existsSync(MIRROR) && existsSync(QUOTE_PAGE) ? false : 'WMIWCI-SITE not available'

/** Evaluate the GENERATED browser mirror in a sandbox — the exact bytes the
 *  customer's browser runs — and hand back window.WMIC_PRICING. */
function loadMirror(): any {
  const sandbox: any = { window: {} }
  runInNewContext(readFileSync(MIRROR, 'utf8'), sandbox)
  return sandbox.window.WMIC_PRICING
}

/** Reproduce, exactly, the option list public/quote.html builds from the
 *  mirror. Mirrors the forEach at public/quote.html:633-652. */
function optionsTheQuotePageRenders(): { key: string; label: string; amount: number }[] {
  const P = loadMirror()
  const out: { key: string; label: string; amount: number }[] = []
  Object.keys(P.PACKAGES).forEach((key) => {
    const pkg = P.PACKAGES[key]
    if (pkg.price.kind === 'manual_quote') return // "Need a Quote" is not a price
    if (!P.isSelectablePackage(key)) return // allowlist — fails closed
    if (pkg.legacy) return // retired from sale
    out.push({ key, label: pkg.label, amount: pkg.price.amount })
  })
  return out
}

/** The prices that must never reach a new customer again. */
const RETIRED_AMOUNTS = [379, 439, 549, 649]

// ════════════════════════════════════════════════════════════════════════
//  1. THE QUICK-QUOTE UI OFFERS NO STUDIO PACKAGE
// ════════════════════════════════════════════════════════════════════════
test('1. the quick-quote page offers no Studio package', { skip: skipSite }, () => {
  const rendered = optionsTheQuotePageRenders()
  const studios = rendered.filter((o) => /studio/i.test(o.label) || LEGACY_PACKAGE_KEYS.includes(o.key))
  assert.deepEqual(studios, [], 'a retired studio tier is selectable on the live quote page')
})

test('1b. the retirement filter the page relies on is actually load-bearing', { skip: skipSite }, () => {
  // THE ROOT CAUSE. The page's filter reads `pkg.legacy`. If the generator ever
  // stops emitting that field the filter silently becomes a no-op again and
  // every retired tier returns to the page — which is exactly what shipped.
  const page = readFileSync(QUOTE_PAGE, 'utf8')
  assert.match(page, /if\s*\(\s*pkg\.legacy\s*\)\s*return/, 'quote.html must still filter on pkg.legacy')
  // The allowlist is the guard that FAILS CLOSED. A missing property makes the
  // flag test always-false; membership of PRICED_PACKAGE_KEYS cannot go missing
  // without the package disappearing from the page entirely.
  assert.match(page, /if\s*\(\s*!P\.isSelectablePackage\(key\)\s*\)\s*return/,
    'quote.html must also allowlist against PRICED_PACKAGE_KEYS')

  const P = loadMirror()
  for (const key of LEGACY_PACKAGE_KEYS) {
    assert.equal(P.isSelectablePackage(key), false, `mirror: ${key} must not be selectable`)
  }
  for (const key of LEGACY_PACKAGE_KEYS) {
    assert.equal(P.PACKAGES[key]?.legacy, true, `mirror: ${key} must carry legacy:true or the page filter is dead`)
    assert.ok(P.PACKAGES[key]?.retiredOn, `mirror: ${key} must carry a retiredOn date`)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  2. THE SMALLEST ACTIVE FULL-SERVICE OPTION IS 1 BEDROOM AT $550
// ════════════════════════════════════════════════════════════════════════
test('2. the smallest sellable full-service package is 1 Bedroom at $550', () => {
  const sellable = ACTIVE_PACKAGE_KEYS
    .filter((k) => k !== 'not-sure')
    .map((k) => PACKAGES[k])
  const cheapest = sellable.reduce((a, b) => ((a.price.amount ?? 0) <= (b.price.amount ?? 0) ? a : b))
  assert.equal(cheapest.key, '1br')
  assert.equal(cheapest.label, '1 Bedroom')
  assert.equal(cheapest.price.amount, 550)
})

test('2b. the canonical base prices are exactly what the price book publishes', () => {
  const CANONICAL: Record<string, { amount: number; kind: string; review: boolean }> = {
    '1br': { amount: 550, kind: 'fixed', review: false },
    '2br': { amount: 779, kind: 'fixed', review: false },
    '3br': { amount: 1049, kind: 'starting', review: true },
    '4br': { amount: 1449, kind: 'starting', review: true },
    '5br': { amount: 1799, kind: 'starting', review: true },
  }
  for (const [key, want] of Object.entries(CANONICAL)) {
    const p = PACKAGES[key as keyof typeof PACKAGES]
    assert.equal(p.price.amount, want.amount, `${key} base price`)
    assert.equal(p.price.kind, want.kind, `${key} must render as ${want.kind}`)
    assert.equal(p.requiresReview, want.review, `${key} review gate`)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  3. THE BACKEND PRICES INDEPENDENTLY OF ANYTHING THE BROWSER SENDS
// ════════════════════════════════════════════════════════════════════════
test('3. the server total ignores a client-submitted total entirely', () => {
  // quoteEstimate takes ONLY the package key and truck. There is no parameter
  // through which a browser total could influence the answer.
  const honest = quoteEstimate({ moveSize: '2br' })
  assert.ok(honest.ok)
  if (!honest.ok) return

  // A forged total is reported as a MISMATCH and never adopted.
  const forged = compareClientTotal(honest.totalDollars, 1)
  assert.equal(forged.matched, false)
  assert.equal(forged.serverDollars, honest.totalDollars, 'the server figure is the one that survives')
  assert.notEqual(forged.serverDollars, 1)
})

test('3b. the quote route stores the SERVER cents, never the submitted ones', () => {
  const route = readFileSync(resolve(__dirname, '../../../app/api/leads/quote-capture/route.ts'), 'utf8')
  assert.match(route, /const serverCents = priced\.ok \? priced\.totalCents : null/,
    'the stored value must come from quoteEstimate')
  assert.match(route, /compareClientTotal\(/, 'the browser figure is compared and logged')
  assert.ok(
    !/estimatedValue:\s*(d|body)\.estimateTotal/.test(route),
    'the submitted total must never be written to the lead',
  )
})

test('3c. the partial-lead route refuses to bank a retired price', () => {
  // /api/leads/partial legitimately accepts the booking form's richer browser
  // figure (it includes add-ons this route never receives). What it must never
  // do is persist the price of a package we withdrew.
  const route = readFileSync(resolve(__dirname, '../../../app/api/leads/partial/route.ts'), 'utf8')
  assert.match(route, /isRetiredPackage\(/, 'the retired-package guard must be present')
  assert.match(route, /const estimateCents =\s*\n?\s*!retiredSelection/,
    'a retired selection must null the estimate rather than store it')
})

// ════════════════════════════════════════════════════════════════════════
//  4. A FORGED OR CACHED RETIRED SERVICE ID IS REJECTED
// ════════════════════════════════════════════════════════════════════════
test('4. every retired studio key is refused, and refused as EXPIRED', () => {
  for (const key of LEGACY_PACKAGE_KEYS) {
    const r = quoteEstimate({ moveSize: key })
    assert.equal(r.ok, false, `${key} must not price`)
    if (r.ok) continue
    assert.equal(r.reason, 'retired_package', `${key} must be reported as retired, not as an unknown key`)
    assert.equal(r.packageKey, key)
  }
})

test('4b. casing and whitespace cannot smuggle a retired key past the gate', () => {
  for (const raw of ['  Little-Studio ', 'LITTLE-STUDIO', 'little-studio']) {
    const r = quoteEstimate({ moveSize: raw })
    assert.equal(r.ok, false, `"${raw}" must not price`)
  }
})

test('4c. an invented key is refused as UNKNOWN, keeping the two causes distinct', () => {
  const r = quoteEstimate({ moveSize: 'penthouse' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, 'unknown_package')
})

test('4d. the route answers a retired key with pricing_expired, not a validation error', () => {
  const route = readFileSync(resolve(__dirname, '../../../app/api/leads/quote-capture/route.ts'), 'utf8')
  assert.match(route, /reason === 'retired_package'/, 'the route must branch on the retired reason')
  assert.match(route, /error: 'pricing_expired'/, 'a stale cached bundle is not the customer being wrong')
  assert.match(route, /priceBookVersion: PRICE_BOOK_VERSION/, 'tell the client which book we are on')
})

// ════════════════════════════════════════════════════════════════════════
//  5. NO NEW QUOTE CAN EVER PRODUCE A RETIRED AMOUNT
// ════════════════════════════════════════════════════════════════════════
test('5. no sellable package can produce $379, $439, $549 or the retired $649', () => {
  for (const key of ACTIVE_PACKAGE_KEYS) {
    const r = quoteEstimate({ moveSize: key })
    if (!r.ok) continue // not-sure / 5br are quoted by hand, which is correct
    for (const bad of RETIRED_AMOUNTS) {
      assert.notEqual(r.totalDollars, bad, `${key} priced at a retired amount ($${bad})`)
      assert.notEqual(r.baseDollars, bad, `${key} base is a retired amount ($${bad})`)
    }
  }
})

test('5b. no retired amount is reachable through the truck axis either', () => {
  for (const key of ACTIVE_PACKAGE_KEYS) {
    for (const truck of ['10ft', '15ft', '26ft', '20ft', 'invented']) {
      const r = quoteEstimate({ moveSize: key, truckSize: truck })
      if (!r.ok) continue
      for (const bad of RETIRED_AMOUNTS) {
        assert.notEqual(r.totalDollars, bad, `${key}+${truck} priced at a retired amount ($${bad})`)
      }
    }
  }
})

test('5c. a new quote carries the price-book version that produced it', () => {
  const r = quoteEstimate({ moveSize: '1br' })
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.priceBookVersion, PRICE_BOOK_VERSION)
  assert.match(PRICE_BOOK_VERSION, /^\d{4}-\d{2}-\d{2}$/)
})

// ════════════════════════════════════════════════════════════════════════
//  6. FRONTEND AND BACKEND PACKAGE DEFINITIONS ARE IDENTICAL
// ════════════════════════════════════════════════════════════════════════
test('6. the browser price book and the server price book agree exactly', { skip: skipSite }, () => {
  const P = loadMirror()
  assert.deepEqual(
    Object.keys(P.PACKAGES),
    Object.keys(PACKAGES),
    'the mirror and the server must carry the same package keys, in the same order',
  )
  for (const [key, server] of Object.entries(PACKAGES)) {
    const browser = P.PACKAGES[key]
    assert.equal(browser.label, server.label, `${key} label`)
    assert.equal(browser.price.amount, server.price.amount, `${key} amount`)
    assert.equal(browser.price.kind, server.price.kind, `${key} kind`)
    assert.equal(!!browser.legacy, !!server.legacy, `${key} retirement flag`)
    assert.equal(browser.retiredOn ?? null, server.retiredOn ?? null, `${key} retiredOn`)
  }
})

test('6b. the retirement list and the per-package flags cannot drift apart', () => {
  // Two spellings of "withdrawn" is what let the browser and the server
  // disagree in the first place. Pin them to each other.
  const flagged = Object.values(PACKAGES).filter((p) => p.legacy).map((p) => p.key).sort()
  assert.deepEqual(flagged, [...LEGACY_PACKAGE_KEYS].sort(),
    'every LEGACY_PACKAGE_KEYS entry must carry legacy:true, and nothing else may')
  for (const p of Object.values(PACKAGES)) {
    if (p.legacy) assert.ok(p.retiredOn, `${p.key}: a retired package must record when`)
    else assert.equal(p.retiredOn, undefined, `${p.key}: only a retired package may carry retiredOn`)
  }
})

test('6c. a retired key is refused identically by every guard that exists', () => {
  for (const key of LEGACY_PACKAGE_KEYS) {
    assert.equal(isPackageActiveForNewIntake(key), false, `${key} must not be active for intake`)
    assert.equal(isRetiredPackage(key), true, `${key} must be reported as retired`)
    assert.ok(!ACTIVE_PACKAGE_KEYS.includes(key as never), `${key} must not appear in ACTIVE_PACKAGE_KEYS`)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  7. DISCORD SHOWS THE PERSISTED SERVER SNAPSHOT
// ════════════════════════════════════════════════════════════════════════
test('7. the lead card is built from the stored lead, never recalculated', () => {
  const src = readFileSync(resolve(__dirname, '../quote-capture.ts'), 'utf8')
  // Both money and label come off the `lead` row that was read back from the DB.
  assert.match(src, /estimateDollars: typeof lead\.estimatedValue === 'number' \? lead\.estimatedValue \/ 100 : null/,
    'the card amount must be the stored estimate')
  assert.match(src, /moveSize: packageLabelOf\(lead\.moveSize\)/,
    'the card label must be resolved from the stored key')
  // It must not reach for pricing at render time, and must not take a total
  // from the request body.
  assert.ok(!/quoteEstimate\(/.test(src), 'the card path must not re-price the job')
  assert.ok(!/estimateDollars:\s*(d|body|input)\./.test(src), 'the card must not accept a client total')
})

test('7b. there is exactly ONE label book, so two notices cannot disagree', () => {
  // lead-alert.ts used to hand-transcribe its own labels and had already
  // drifted ("Little studio" vs the price book's "Small Studio").
  const alert = formatLeadAlert({ id: 'lead_x', moveSize: '2br' })
  const text = alert.lines.map((l) => l.message).join('\n')
  assert.match(text, new RegExp(PACKAGES['2br'].label))
  const src = readFileSync(resolve(__dirname, '../lead-alert.ts'), 'utf8')
  assert.match(src, /Object\.values\(PACKAGES\)/, 'labels must be derived from the price book')
})

// ════════════════════════════════════════════════════════════════════════
//  8. FULL-SERVICE TRANSPORTATION IS $3 PER ROUTED MILE
// ════════════════════════════════════════════════════════════════════════
test('8. transportation is $3 per routed mile, fuel included, rounded UP', () => {
  assert.equal(TRANSPORTATION_MILEAGE.ratePerMile, 3)
  assert.equal(TRANSPORTATION_MILEAGE.ratePerMileCents, 300)
  assert.equal(TRANSPORTATION_MILEAGE.fuelIncluded, true)
  assert.equal(TRANSPORTATION_MILEAGE.appliesTo, 'full_service')

  for (const [miles, wantMiles] of [[0, 0], [1, 1], [10.1, 11], [12.0, 12], [23.4, 24]] as const) {
    const c = mileageChargeForMiles(miles)
    assert.equal(c.billableMiles, wantMiles, `${miles} routed miles must bill as ${wantMiles}`)
    assert.equal(c.amountCents, wantMiles * 300)
  }
})

test('8b. no separate gas charge rides alongside the mileage', () => {
  const note = `${TRANSPORTATION_MILEAGE.note} ${TRANSPORTATION_MILEAGE.label}`
  assert.ok(!/\bgas\b/i.test(note), 'fuel is inside the per-mile rate; a gas line would bill it twice')
  assert.match(TRANSPORTATION_MILEAGE.note, /Fuel is included/)
})

// ════════════════════════════════════════════════════════════════════════
//  9. LABOR-ONLY NEVER CARRIES TRUCK, FUEL, TRANSPORT OR MILEAGE
// ════════════════════════════════════════════════════════════════════════
test('9. labor-only includes no truck and no transportation of any kind', () => {
  assert.equal(LABOR_ONLY.truckIncluded, false)
  assert.equal(LABOR_ONLY.transportationIncluded, false)
  const svc = (SERVICE_TYPES as Record<string, any>).labor_only
  assert.equal(svc.includesTruck, false)
  assert.equal(svc.chargesMileage, false, 'mileage must never attach to a labor-only job')
  assert.equal(svc.includesTransportation, false)
  // And the routed-mileage charge is scoped to full service by construction.
  assert.notEqual(TRANSPORTATION_MILEAGE.appliesTo, 'labor_only')
})

test('9b. the published labor-only rates are the canonical ones', () => {
  assert.equal(LABOR_ONLY.hourlyRate, 150, 'two movers, per hour')
  assert.equal(LABOR_ONLY.includedWorkers, 2)
  assert.equal(LABOR_ONLY.minimumHours, 2, 'two-hour minimum')
  assert.equal(LABOR_ONLY.minimumMinutes, 120)
  assert.equal(LABOR_PER_WORKER_RATE_CENTS, 7500, 'each additional worker is $75/hour')
})

// ════════════════════════════════════════════════════════════════════════
//  10. THE $49 HOLD IS APPLIED TOWARD THE TOTAL, NEVER ADDED TO IT
// ════════════════════════════════════════════════════════════════════════
test('10. the $49 hold reduces what is owed and is never stacked on top', () => {
  // $779 accepted, the $49 authorization captured.
  const q = computeQuote({ totalEstimate: 779, depositCents: 4900, collectedCents: 4900 })
  assert.equal(q.finalTotalCents, 77900, 'the accepted total is unchanged by the hold')
  assert.equal(q.depositAppliedCents, 4900, 'the captured hold counts toward the total')
  assert.equal(q.remainingCents, 77900 - 4900, 'the customer owes the total MINUS the hold')
  assert.ok(q.finalTotalCents < 77900 + 4900, 'the hold must never be added on top')
})

test('10b. a hold that is only AUTHORIZED is forecast, not double-credited', () => {
  const held = computeQuote({ totalEstimate: 779, depositCents: 4900, collectedCents: 0, authorizedNotCapturedCents: 4900 })
  assert.equal(held.depositAppliedCents, 0, 'an authorization is not money yet')
  assert.equal(held.remainingCents, 77900)
  assert.equal(held.remainingAfterDepositCents, 77900 - 4900, 'but the forecast applies it once')

  const captured = computeQuote({ totalEstimate: 779, depositCents: 4900, collectedCents: 4900, authorizedNotCapturedCents: 4900 })
  assert.equal(captured.remainingAfterDepositCents, 77900 - 4900, 'and never twice once captured')
})

// ════════════════════════════════════════════════════════════════════════
//  11. HISTORY KEEPS THE LABEL AND THE AMOUNT IT WAS SOLD AT
// ════════════════════════════════════════════════════════════════════════
test('11. a retired package stays fully readable for historical records', () => {
  const HISTORICAL: Record<string, { label: string; amount: number }> = {
    'little-studio': { label: 'Small Studio', amount: 379 },
    'half-studio': { label: 'Standard Studio', amount: 439 },
    'full-studio': { label: 'Large Studio', amount: 549 },
  }
  for (const [key, want] of Object.entries(HISTORICAL)) {
    const p = PACKAGES[key as keyof typeof PACKAGES]
    assert.ok(p, `${key} must remain in the price book — deleting it would blank historical invoices`)
    assert.equal(p.label, want.label, `${key} must still render its original label`)
    assert.equal(p.price.amount, want.amount, `${key} must still render its original amount`)
    assert.equal(p.retiredOn, '2026-07-31')
  }
})

test('11b. a historical lead alert still names what that customer bought', () => {
  const { lines } = formatLeadAlert({ id: 'old_lead', moveSize: 'little-studio', estimatedValue: 37900 })
  const text = lines.map((l) => l.message).join('\n')
  assert.match(text, /Small Studio/, 'history must not be relabelled')
  assert.match(text, /\$379/, 'nor re-priced')
})

test('11c. inventory may READ every package but may only SUGGEST active ones', () => {
  const src = readFileSync(resolve(__dirname, '../inventory.ts'), 'utf8')
  assert.match(src, /ORDERED_PACKAGES: PackageKey\[\] = ACTIVE_PACKAGE_KEYS/,
    'a suggestion must never name a withdrawn tier')
  assert.match(src, /'little-studio': 150/, 'but the capacity table keeps every key for historical sizing')
})

// ════════════════════════════════════════════════════════════════════════
//  12. A ROUTING FAILURE PRODUCES REVIEW, NOT A CONFIDENT WRONG NUMBER
// ════════════════════════════════════════════════════════════════════════
test('12. unknown routed mileage is pending review, never $0 and never a guess', () => {
  for (const bad of [null, undefined, NaN, -1]) {
    const c = mileageChargeForMiles(bad as never)
    assert.equal(c.kind, 'pending_review', `${String(bad)} miles must not resolve to a number`)
    assert.equal(c.requiresReview, true)
    assert.equal(c.billableMiles, null)
    assert.equal((c as { amountCents?: number }).amountCents, undefined, 'no amount may be implied')
  }
})

test('12b. the quote is explicit that the package price is not the whole job', () => {
  // The quick quote deliberately returns base + truck and NOT mileage, because
  // the route is not known at quote time. The breakdown must therefore expose
  // the pieces separately so no surface can present it as a settled total.
  const r = quoteEstimate({ moveSize: '3br' })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.isStarting, true, '3BR is a floor, not a flat rate')
  assert.equal(r.requiresReview, true)
  assert.equal(typeof r.baseDollars, 'number', 'the base must be separable from the total')
  assert.equal(typeof r.truckUpgrade, 'number', 'and so must the truck line')
})

// ════════════════════════════════════════════════════════════════════════
//  13. REPLAYING A NOTIFICATION DOES NOT DUPLICATE IT
// ════════════════════════════════════════════════════════════════════════
test('13. a replayed lead alert is claimed once and then skipped', () => {
  const src = readFileSync(resolve(__dirname, '../quote-capture.ts'), 'utf8')
  assert.match(src, /claimed === 0/, 'a losing claim must short-circuit')
  assert.match(src, /already_queued/, 'and report that it did not re-send')
  assert.match(src, /deps\.claimAlert\(/, 'the claim is the idempotency key')
})

// ════════════════════════════════════════════════════════════════════════
//  THE REPORTED LEAD — MOCKED. No network, no database, no Discord.
// ════════════════════════════════════════════════════════════════════════
test('REGRESSION: the 2026-08-22 lead cannot be produced again', { skip: skipSite }, () => {
  // Lead cmt4ia8ot0000sthe46dxfvgg, 08817 -> 07030, "Small Studio", $379,
  // captured from the quick quote form. Reconstructed from the price book and
  // the page's own rendering logic — no production data is used or written.
  const SUBMITTED = { moveSize: 'little-studio', estimateTotal: 379, pickupZip: '08817', destinationZip: '07030' }

  // (a) The customer can no longer be shown the option at all.
  const offered = optionsTheQuotePageRenders().map((o) => o.key)
  assert.ok(!offered.includes(SUBMITTED.moveSize), 'the retired tier is still on the page')

  // (b) Even from a cached bundle that still offers it, the server refuses —
  //     and refuses without ever naming a price.
  const priced = quoteEstimate({ moveSize: SUBMITTED.moveSize })
  assert.equal(priced.ok, false)
  if (priced.ok) return
  assert.equal(priced.reason, 'retired_package')
  assert.ok(!('totalDollars' in priced), 'a refusal must not carry an amount')

  // (c) And the submitted $379 is never adopted as the answer.
  const cheapestSellable = Math.min(
    ...ACTIVE_PACKAGE_KEYS.filter((k) => k !== 'not-sure').map((k) => PACKAGES[k].price.amount ?? Infinity),
  )
  assert.equal(cheapestSellable, 550, 'the least a new full-service quote can start at')
  assert.ok(SUBMITTED.estimateTotal < cheapestSellable, 'the reported amount is below every sellable price')
})
