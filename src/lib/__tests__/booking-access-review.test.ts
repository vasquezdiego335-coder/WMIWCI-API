/**
 * booking-access-review.test.ts
 *
 * Covers the 2026-07-28 booking-form fixes:
 *   1. the five access/inventory fields survive the Zod schema
 *   2. inventoryAccuracyConfirmed is REQUIRED server-side
 *   3. manual review is set from readable reasons, not a bare boolean
 *   4. piano / safe / heavy items force review
 *   5. difficult elevators + building access force review
 *   6. local-date handling in BOTH browser forms (no UTC rollover)
 *   7. service-area pricing stays server-authoritative
 *   8. stale ZIP responses cannot overwrite a newer one
 *   9. every failure mode has its own customer message
 *  10. success is the ONLY path that opens the success overlay
 *  11. THE EMAIL-MARKETING CONSENT IS BYTE-FOR-BYTE UNCHANGED
 *
 * Items 6-11 assert against the shipped browser sources in WMIWCI-SITE, because
 * that is where the behaviour lives and there is no browser test runner in this
 * repo. They are structural assertions, deliberately pinned to the exact code
 * that implements each fix, so a regression fails loudly here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { BookingSchema } from '../booking-schema'
import { PRICED_PACKAGE_KEYS, LEGACY_PACKAGE_KEYS } from '../pricing-config'
import { buildReviewReasons } from '../booking-review'
import { computeEstimate } from '../estimate'

// ── The marketing site lives in a sibling checkout. When it is not present
//    (CI clones only the API) the browser-source tests skip rather than fail. ──
const SITE_ROOT = path.resolve(process.cwd(), '..', 'WMIWCI-SITE', 'public')
const hasSite = existsSync(path.join(SITE_ROOT, 'booking-form.html'))
const site = (f: string) => readFileSync(path.join(SITE_ROOT, f), 'utf8')
const skipSite = { skip: hasSite ? false : 'WMIWCI-SITE checkout not present' }

/** Minimum payload the schema accepts, so each test can vary one thing. */
const base = () => ({
  fullName: 'Sam Ortiz',
  phone: '9735551234',
  email: 'sam@example.com',
  // ── THE PRODUCT IS NOW REQUIRED (owner decision 2026-08-14) ────────────
  //    Move It Clear It sells two products, and a booking must say which one
  //    it is. The server no longer infers it from the package, the truck
  //    provider or the notes — that inference is how a job on the customer's
  //    own truck was recorded as a company-truck move. These fixtures book
  //    FULL-SERVICE, so they carry the product and its flat package.
  serviceTypeKey: 'full_service' as const,
  moveSizeKey: '1br',
  serviceType: '1br', // legacy alias for moveSizeKey; still accepted
  agreementAccepted: true as const,
  agreementName: 'Sam Ortiz',
  inventoryAccuracyConfirmed: true as const,
})

// ═══════════════════════════════════════════════════════════════════════
//  1. The five fields survive the schema
// ═══════════════════════════════════════════════════════════════════════

test('access fields are accepted and preserved by BookingSchema', () => {
  const parsed = BookingSchema.safeParse({
    ...base(),
    difficultElevatorPickup: true,
    difficultElevatorDropoff: false,
    difficultBuildingPickup: true,
    difficultBuildingDropoff: false,
  })
  assert.equal(parsed.success, true, 'payload with access fields must parse')
  if (!parsed.success) return
  // The regression this guards: z.object() STRIPS unknown keys, so before the
  // fields existed in the schema every one of these was silently discarded.
  assert.equal(parsed.data.difficultElevatorPickup, true)
  assert.equal(parsed.data.difficultElevatorDropoff, false)
  assert.equal(parsed.data.difficultBuildingPickup, true)
  assert.equal(parsed.data.difficultBuildingDropoff, false)
})

test('access fields are optional — a pre-cutover browser tab still submits', () => {
  const parsed = BookingSchema.safeParse(base())
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  // undefined means "not asked", which must stay distinguishable from false.
  assert.equal(parsed.data.difficultElevatorPickup, undefined)
  assert.equal(parsed.data.difficultBuildingDropoff, undefined)
})

// ═══════════════════════════════════════════════════════════════════════
//  2. Inventory confirmation is required
// ═══════════════════════════════════════════════════════════════════════

test('inventoryAccuracyConfirmed is REQUIRED', () => {
  const { inventoryAccuracyConfirmed, ...without } = base()
  const parsed = BookingSchema.safeParse(without)
  assert.equal(parsed.success, false, 'a booking without the attestation must be rejected')
  if (parsed.success) return
  assert.ok(
    parsed.error.flatten().fieldErrors.inventoryAccuracyConfirmed,
    'the 422 must name the field so the form can point at it',
  )
})

test('inventoryAccuracyConfirmed must be literally true — false is rejected', () => {
  const parsed = BookingSchema.safeParse({ ...base(), inventoryAccuracyConfirmed: false })
  assert.equal(parsed.success, false)
})

test('agreementAccepted is still required alongside it', () => {
  const { agreementAccepted, ...without } = base()
  const parsed = BookingSchema.safeParse(without)
  assert.equal(parsed.success, false)
})

// ═══════════════════════════════════════════════════════════════════════
//  3-5. Manual review reasons
// ═══════════════════════════════════════════════════════════════════════

const noReview = {
  estimate: { requiresReview: false, reviewReasons: [] as string[] },
  serviceArea: null,
  addressNeedsReview: false,
}

test('a clean booking produces no review reasons', () => {
  assert.deepEqual(buildReviewReasons(noReview), [])
})

test('estimator reasons are carried through verbatim', () => {
  const reasons = buildReviewReasons({
    ...noReview,
    estimate: { requiresReview: true, reviewReasons: ['Upright piano or substantial safe'] },
  })
  assert.deepEqual(reasons, ['Upright piano or substantial safe'])
})

test('a piano forces review end-to-end through computeEstimate', () => {
  const est = computeEstimate({
    serviceType: '1br',
    heavyItems: [{ label: 'upright piano', isPianoOrSafe: true }],
  })
  assert.equal(est.requiresReview, true, 'estimator must flag a piano')
  const reasons = buildReviewReasons({ ...noReview, estimate: est })
  assert.ok(reasons.length > 0, 'and the route must carry that into review reasons')
})

test('a safe forces review end-to-end', () => {
  const est = computeEstimate({
    serviceType: '1br',
    heavyItems: [{ label: 'gun safe', pounds: 420, isPianoOrSafe: true }],
  })
  assert.equal(est.requiresReview, true)
  assert.ok(buildReviewReasons({ ...noReview, estimate: est }).length > 0)
})

test('an unpriced heavy item (weight given, over the top tier) forces review', () => {
  const est = computeEstimate({
    serviceType: '1br',
    heavyItems: [{ label: 'industrial press', pounds: 900 }],
  })
  assert.equal(est.requiresReview, true, '400lb+ is never auto-priced')
})

test('a heavy item with NO weight forces review rather than guessing a charge', () => {
  const est = computeEstimate({ serviceType: '1br', legacyHeavyItems: true })
  assert.equal(est.requiresReview, true)
})

test('each difficult-access flag produces its own readable reason', () => {
  const reasons = buildReviewReasons({
    ...noReview,
    difficultElevatorPickup: true,
    difficultElevatorDropoff: true,
    difficultBuildingPickup: true,
    difficultBuildingDropoff: true,
  })
  assert.equal(reasons.length, 4)
  assert.ok(reasons.some((r) => /elevator/i.test(r) && /pickup/i.test(r)))
  assert.ok(reasons.some((r) => /elevator/i.test(r) && /destination/i.test(r)))
  assert.ok(reasons.some((r) => /building/i.test(r) && /pickup/i.test(r)))
  assert.ok(reasons.some((r) => /building/i.test(r) && /destination/i.test(r)))
  // Sentences the owner can act on, not codes.
  for (const r of reasons) assert.ok(r.length > 20, `reason too terse to act on: "${r}"`)
})

test('a false access flag does NOT create a reason', () => {
  assert.deepEqual(buildReviewReasons({ ...noReview, difficultElevatorPickup: false }), [])
})

test('service-area review is included with its own message', () => {
  const reasons = buildReviewReasons({
    ...noReview,
    serviceArea: { manualReviewRequired: true, zone: 'new_york', message: 'New York address — manual review.' },
  })
  assert.deepEqual(reasons, ['New York address — manual review.'])
})

test('service-area review with no message still yields a usable reason', () => {
  const reasons = buildReviewReasons({
    ...noReview,
    serviceArea: { manualReviewRequired: true, zone: 'unsupported', message: null },
  })
  assert.equal(reasons.length, 1)
  assert.ok(/review/i.test(reasons[0]))
})

test('an unverified address adds a reason', () => {
  const reasons = buildReviewReasons({ ...noReview, addressNeedsReview: true })
  assert.equal(reasons.length, 1)
  assert.ok(/address/i.test(reasons[0]))
})

test('manual address entry names the customer-supplied reason', () => {
  const reasons = buildReviewReasons({
    ...noReview,
    addressNeedsReview: true,
    manualEntryReason: 'New construction, not in Google yet',
  })
  assert.equal(reasons.length, 1, 'manual entry supersedes the generic unverified line')
  assert.ok(reasons[0].includes('New construction'))
})

test('duplicate reasons are collapsed', () => {
  const reasons = buildReviewReasons({
    ...noReview,
    estimate: { requiresReview: true, reviewReasons: ['New York address'] },
    serviceArea: { manualReviewRequired: true, zone: 'new_york', message: 'New York address' },
  })
  assert.deepEqual(reasons, ['New York address'], 'the estimator and service area both raise NY')
})

test('reasons accumulate across every source', () => {
  const reasons = buildReviewReasons({
    estimate: { requiresReview: true, reviewReasons: ['Upright piano or substantial safe'] },
    serviceArea: { manualReviewRequired: true, zone: 'new_york', message: 'New York address' },
    addressNeedsReview: true,
    difficultElevatorDropoff: true,
  })
  assert.equal(reasons.length, 4)
})

test('a 4-bedroom "starting at" package requires inventory review', () => {
  const est = computeEstimate({ serviceType: '4br' })
  assert.equal(est.requiresReview, true, 'a floor price is not a settled quote')
  const reasons = buildReviewReasons({ ...noReview, estimate: est })
  assert.ok(reasons.some((r) => /review/i.test(r)))
})

// ═══════════════════════════════════════════════════════════════════════
//  7. Service-area pricing stays server-authoritative
// ═══════════════════════════════════════════════════════════════════════

test('a client-submitted estimate never becomes the stored total', () => {
  const parsed = BookingSchema.safeParse({ ...base(), estimateTotal: 1, estimateAddons: 1 })
  assert.equal(parsed.success, true)
  // The schema accepts them for display, but computeEstimate is the only source
  // of the stored number — assert the server's own answer disagrees with the lie.
  const est = computeEstimate({ serviceType: '1br' })
  assert.notEqual(est.estimatedTotal, 1)
  assert.ok(est.estimatedTotal > 100)
})

test('travel fee is added by the server, not the browser', () => {
  const withTravel = computeEstimate({ serviceType: '1br', travelFeeCents: 5000 })
  const without = computeEstimate({ serviceType: '1br' })
  assert.equal(withTravel.estimatedTotal - without.estimatedTotal, 50)
})

// ═══════════════════════════════════════════════════════════════════════
//  6. Local-date handling in the browser forms
// ═══════════════════════════════════════════════════════════════════════

test('neither browser form derives "today" from UTC', skipSite, () => {
  for (const f of ['booking-form.html', 'quote.html']) {
    const src = site(f)
    assert.ok(
      !/toISOString\(\)\s*\.\s*split\(\s*['"]T['"]\s*\)/.test(src),
      `${f} still derives a calendar date from toISOString() — that is the UTC date, ` +
        'and New Jersey is UTC-4/-5, so evening bookings were told today was in the past',
    )
  }
})

test('both forms build the date from LOCAL calendar parts', skipSite, () => {
  for (const f of ['booking-form.html', 'quote.html']) {
    const src = site(f)
    assert.ok(/getFullYear\(\)/.test(src) && /getMonth\(\)\s*\+\s*1/.test(src) && /getDate\(\)/.test(src),
      `${f} must build YYYY-MM-DD from local getFullYear/getMonth/getDate`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
//  8. Stale service-area responses
// ═══════════════════════════════════════════════════════════════════════

test('the booking form drops out-of-order service-area replies', skipSite, () => {
  const src = site('booking-form.html')
  assert.ok(/__saSeq/.test(src), 'a request sequence counter must exist')
  assert.ok(/ticket\s*!==\s*__saSeq/.test(src),
    'a reply must be discarded when a newer request has been issued')
  assert.ok(/function invalidateServiceArea/.test(src),
    'changing a ZIP must clear the previous result immediately')
})

test('an unknown travel fee is never silently treated as $0', skipSite, () => {
  const src = site('booking-form.html')
  assert.ok(/travelPending/.test(src),
    'the estimate must expose a pending state rather than defaulting an unknown fee to zero')
  assert.ok(/__saPending/.test(src) && /__saError/.test(src),
    'in-flight and failed lookups must both be distinguishable from a known $0')
})

// ═══════════════════════════════════════════════════════════════════════
//  9-10. Submission outcomes
// ═══════════════════════════════════════════════════════════════════════

test('every failure mode has a distinct branch', skipSite, () => {
  const src = site('booking-form.html')
  for (const kind of ['offline', 'network', 'server', 'stripe', 'no_checkout', 'rate_limited']) {
    assert.ok(new RegExp(`\\b${kind}\\b`).test(src), `missing outcome branch: ${kind}`)
  }
  assert.ok(/res\.status\s*===\s*422/.test(src), '422 must be handled separately from 500')
  assert.ok(/showValidationErrors/.test(src), 'a 422 must return the customer to the bad field')
})

test('failure copy tells the customer the request may not have been saved', skipSite, () => {
  const src = site('booking-form.html')
  assert.ok(/could not confirm that your request was submitted/i.test(src))
  assert.ok(/may not have been saved/i.test(src))
  // Both the dial target and the formatted text a customer reads.
  assert.ok(/tel:8626400625/.test(src), 'the failure banner must offer a tappable tel: link')
  assert.ok(/\(862\)\s*640-0625/.test(src), 'and show the number in readable form')
})

test('the success overlay is unreachable from a failed submit', skipSite, () => {
  const src = site('booking-form.html')
  // showManualFallback is what opens the success overlay ("We received your
  // request"). It must no longer be wired to any failure branch.
  const submitBlock = src.slice(src.indexOf('SUBMIT →'), src.indexOf('function showValidationErrors'))
  assert.ok(!/showManualFallback\(/.test(submitBlock),
    'a failed submit must NOT open the success overlay — that is the false-success bug')
  assert.ok(/res\.ok\s*&&\s*data\.checkoutUrl/.test(src),
    'success must require BOTH a 2xx and a checkout URL')
})

// ═══════════════════════════════════════════════════════════════════════
//  11. EMAIL MARKETING — MUST BE UNTOUCHED
// ═══════════════════════════════════════════════════════════════════════

test('the marketing-consent checkbox is unchanged', skipSite, () => {
  const src = site('booking-form.html')

  // Same element, same id, same form field name.
  assert.ok(/id="emailOptIn"/.test(src), 'the consent checkbox id must remain emailOptIn')

  // Still a checkbox, still UNCHECKED by default — a pre-checked consent box is
  // not consent, and flipping the default would silently opt in every customer.
  const el = src.match(/<input[^>]*id="emailOptIn"[^>]*>/)
  assert.ok(el, 'the consent input must still exist')
  assert.ok(/type="checkbox"/.test(el![0]), 'must remain a checkbox')
  assert.ok(!/\bchecked\b/.test(el![0]), 'must remain UNCHECKED by default')
})

test('the tri-state consent payload contract is unchanged', skipSite, () => {
  const src = site('booking-form.html')
  // true = ticked, false = ticked then unticked, ABSENT = never interacted.
  // Collapsing absent to false would turn "not asked" into "declined".
  assert.ok(/marketingConsent:/.test(src), 'marketingConsent must still be sent')
  assert.ok(/dataset\.touched/.test(src),
    'the touched-flag that distinguishes "declined" from "never asked" must remain')
})

test('the server still accepts marketingConsent on the booking payload', () => {
  for (const value of [true, false]) {
    const parsed = BookingSchema.safeParse({ ...base(), marketingConsent: value })
    assert.equal(parsed.success, true)
    if (parsed.success) assert.equal(parsed.data.marketingConsent, value)
  }
  // Absent stays absent — never coerced to false.
  const absent = BookingSchema.safeParse(base())
  assert.equal(absent.success, true)
  if (absent.success) assert.equal(absent.data.marketingConsent, undefined)
})

test('bookingSessionId still links the booking to its partial lead', () => {
  const parsed = BookingSchema.safeParse({ ...base(), bookingSessionId: 'bk_abc123' })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.bookingSessionId, 'bk_abc123')
})

test('the partial-lead capture flag and endpoint are untouched', skipSite, () => {
  const src = site('booking-form.html')
  assert.ok(/PARTIAL_LEAD_CAPTURE_ENABLED/.test(src), 'the client capture flag must remain')
  assert.ok(/\/api\/leads\/partial/.test(src), 'the capture endpoint must remain')
})

test('legal acceptance is SEPARATE from marketing consent', skipSite, () => {
  const src = site('booking-form.html')
  const legal = src.match(/<p class="submit-legal"[\s\S]*?<\/p>/)
  assert.ok(legal, 'a legal acknowledgement must exist near the submit button')
  assert.ok(/\/terms\//.test(legal![0]) && /\/privacy\//.test(legal![0]),
    'it must link both Terms of Service and Privacy Policy')
  assert.ok(!/emailOptIn|marketing|consent/i.test(legal![0]),
    'legal acceptance must never be bundled into the marketing-consent control')
})

// ═══════════════════════════════════════════════════════════════════════
//  Accessibility + funnel wiring
// ═══════════════════════════════════════════════════════════════════════

test('the photo input has an associated label', skipSite, () => {
  const src = site('booking-form.html')
  assert.ok(/<label[^>]*\bfor="photoInput"/.test(src),
    'the file input must be programmatically labelled, not just visually')
})

test('required checkboxes carry aria-required', skipSite, () => {
  const src = site('booking-form.html')
  for (const id of ['accuracyConfirm', 'agreementAccept']) {
    const el = src.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))
    assert.ok(el, `${id} must exist`)
    assert.ok(/aria-required="true"/.test(el![0]), `${id} must expose aria-required`)
  }
})

test('the quote CTA does not claim an availability check it never performs', skipSite, () => {
  const src = site('quote.html')
  assert.ok(!/Check My Date/i.test(src),
    'the button said "Check My Date" but no availability system is called')
  assert.ok(/Continue to Booking/.test(src))
})

test('pricing package cards preselect their package', skipSite, () => {
  const src = site('pricing.html')
  // SELLABLE packages only. This list was hand-written and included the three
  // retired studio tiers, so it required a withdrawn rate to keep a live
  // "book this" link — the opposite of retiring it. Driven from the price book
  // now, so retiring a package removes its requirement automatically.
  for (const key of PRICED_PACKAGE_KEYS) {
    assert.ok(src.includes(`booking-form.html?size=${key}`), `package card missing preselect: ${key}`)
  }
  // And a retired package must NOT be bookable from the pricing page.
  for (const key of LEGACY_PACKAGE_KEYS) {
    assert.ok(
      !src.includes(`booking-form.html?size=${key}`),
      `pricing.html still offers a booking link for the RETIRED package "${key}"`,
    )
  }
})

test('general estimate CTAs route through the short quote flow', skipSite, () => {
  // The href may carry attribution (`quote.html?src=SERVICES_PAGE`) — that is
  // the point of source tagging. An earlier version of this test demanded the
  // BARE href and failed the moment attribution was added, which tested the
  // string rather than the behaviour it stands for.
  for (const f of ['index.html', 'pricing.html', 'services.html']) {
    assert.ok(/href="quote\.html(\?[^"]*)?"/.test(site(f)), `${f} has no CTA pointing at the quote page`)
  }
})

test('attribution parameters are forwarded across internal navigation', skipSite, () => {
  const src = readFileSync(path.join(SITE_ROOT, 'js', 'site-copy.js'), 'utf8')
  for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'src']) {
    assert.ok(src.includes(`'${p}'`), `attribution forwarding must carry ${p}`)
  }
  assert.ok(/url\.origin\s*!==\s*window\.location\.origin/.test(src),
    'parameters must never be appended to an external host')
})
