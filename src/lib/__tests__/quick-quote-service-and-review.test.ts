// ════════════════════════════════════════════════════════════════════════
//  quick-quote-service-and-review.test.ts
//
//  Three properties the previous rounds got wrong, each in its own way:
//
//   • SERVICE TYPE decides which price book applies. Pricing from `moveSize`
//     alone meant a labor-only submission carrying `moveSize: '1br'` banked
//     the FULL-SERVICE $550 flat rate — on a job billed hourly, with no truck.
//
//   • CANONICAL IDENTIFIERS. '2BR' and ' 2br ' are the same package and must
//     be stored as one value, or the CRM groups the same job three ways.
//
//   • MANUAL REVIEW was computed by the server and then discarded. A 3BR
//     FLOOR price reached the owner looking exactly like a flat rate.
//
//  Pure and offline: no database, no Discord, no email, no payment.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PACKAGES, LEGACY_PACKAGE_KEYS } from '../pricing-config'
import { ACTIVE_PACKAGE_KEYS, isPackageActiveForNewIntake } from '../product-catalog'
import { quoteEstimate } from '../quote-estimate'
import { pricePartialLead } from '../partial-lead-pricing'
import { buildLeadCard } from '../booking-display'
import { formatLeadAlert } from '../lead-alert'
import { quotedCentsOf, formatEstimate } from '../quote-capture'

// ══════════════════════════════════════════════════════════════════════
//  SERVICE TYPE DECIDES WHICH BOOK APPLIES
// ══════════════════════════════════════════════════════════════════════
test('labor-only + a 1BR key never banks the full-service $550', () => {
  for (const interest of ['loading_only', 'loading_and_unloading', 'storage_unit_help']) {
    const r = pricePartialLead({ moveSize: '1br', serviceInterest: interest, estimateTotal: 550 })
    assert.equal(r.serviceType, 'labor_only', `${interest} is a labor service`)
    assert.equal(r.estimateCents, null, `${interest}: a package price must never attach to an hourly job`)
    assert.notEqual(r.estimateCents, 55_000)
    assert.equal(r.snapshot, null, 'and no full-service snapshot may be written')
  }
  // Explicit beats inferred, and is refused just as firmly.
  const explicit = pricePartialLead({ moveSize: '1br', serviceType: 'labor_only', estimateTotal: 550 })
  assert.equal(explicit.estimateCents, null)
  assert.equal(explicit.snapshot, null)
})

test('labor-only prices ONLY from structured crew and time', () => {
  // Two movers, three hours: 180 min at $150/h = $450.
  const ok = pricePartialLead({ serviceType: 'labor_only', laborWorkers: 2, laborMinutes: 180 })
  assert.equal(ok.serviceType, 'labor_only')
  assert.equal(ok.estimateCents, 45_000)

  // Below the published two-hour minimum: refused at intake rather than
  // silently billed up to it.
  assert.equal(pricePartialLead({ serviceType: 'labor_only', laborWorkers: 2, laborMinutes: 60 }).estimateCents, null)
  // No structured time at all: nothing to price from.
  assert.equal(pricePartialLead({ serviceType: 'labor_only', laborWorkers: 2 }).estimateCents, null)
  // And a browser total can never substitute for the missing inputs.
  assert.equal(
    pricePartialLead({ serviceType: 'labor_only', estimateTotal: 9_999 }).estimateCents,
    null,
    'a forged total must not become an hourly quote',
  )
})

test('an UNKNOWN service is never assumed to be the more expensive one', () => {
  const r = pricePartialLead({ moveSize: '1br', estimateTotal: 550 })
  assert.equal(r.serviceType, 'unknown', 'no service was declared and none is a labor service')
  assert.equal(r.estimateCents, null, 'guessing full service is how $550 lands on an hourly job')
  assert.equal(r.snapshot, null)
  // The SIZE is still canonicalised and kept — it is a real thing they picked.
  assert.equal(r.moveSizeToStore, '1br')
})

test('a full-service subtotal carries the complete snapshot, mileage disclosed', () => {
  const r = pricePartialLead({ moveSize: '2br', serviceType: 'full_service', estimateTotal: 1 })
  assert.equal(r.estimateCents, 77_900, 'the SERVER price, not the forged $1')
  assert.ok(r.snapshot)
  assert.equal(r.snapshot?.baseCents, 77_900)
  assert.equal(r.snapshot?.truckCents, 0, 'the included 15ft truck adds nothing')
  assert.equal(r.snapshot?.includedTruck, '15ft')
  assert.equal(r.snapshot?.mileageStatus, 'pending', 'ZIPs cannot price a routed mile')
  assert.ok(r.snapshot?.priceBookVersion)
  assert.deepEqual(r.mismatch, { serverDollars: 779, clientDollars: 1, deltaDollars: -778 })
})

// ══════════════════════════════════════════════════════════════════════
//  STORED IDENTIFIERS ARE CANONICAL
// ══════════════════════════════════════════════════════════════════════
test('mixed case and whitespace are canonicalised before storage', () => {
  for (const raw of ['2BR', ' 2br ', '  2Br', '2br  ']) {
    const r = pricePartialLead({ moveSize: raw, serviceType: 'full_service' })
    assert.equal(r.moveSizeToStore, '2br', `"${raw}" must store as the canonical key`)
    assert.equal(r.estimateCents, 77_900, `"${raw}" must price as a 2BR`)
  }
  const q = quoteEstimate({ moveSize: '  2BR ' })
  assert.ok(q.ok)
  if (q.ok) assert.equal(q.packageKey, '2br', 'the estimator is what produces the canonical key')
})

// ══════════════════════════════════════════════════════════════════════
//  THE FROZEN SNAPSHOT BEATS THE MUTABLE COLUMN, EVERYWHERE
// ══════════════════════════════════════════════════════════════════════
test('quoteTotalCents overrides a conflicting estimatedValue in all three surfaces', () => {
  // A lead whose live CRM column has drifted — an admin edit, or a later
  // capture — away from what was actually quoted and emailed.
  const conflicted = { estimatedValue: 87_900, quoteTotalCents: 77_900 }

  // (a) the shared resolver, which the email formats through
  assert.equal(quotedCentsOf(conflicted), 77_900, 'the frozen snapshot wins')
  assert.equal(formatEstimate(quotedCentsOf(conflicted)), '$779', 'which is what the EMAIL prints')

  // (b) the rich Discord card
  const rich = JSON.stringify(
    buildLeadCard({
      leadId: 'lead_9',
      name: 'Sam Rivera',
      estimateDollars: quotedCentsOf(conflicted)! / 100,
      quoteMileageStatus: 'pending',
      adminUrl: 'https://example.com/admin',
    } as never),
  )
  assert.ok(rich.includes('779'), 'the rich card must show the quoted figure')
  assert.ok(!rich.includes('879'), 'and must not show the drifted one')

  // (c) the PLAIN Discord fallback — the path nobody watches, because it only
  //     runs when the queue is down.
  const plain = formatLeadAlert({
    id: 'lead_9',
    estimatedValue: 87_900,
    quoteTotalCents: 77_900,
    quoteMileageStatus: 'pending',
  })
    .lines.map((l) => l.message)
    .join('\n')
  assert.match(plain, /\$779/, 'the fallback must show the quoted figure')
  assert.ok(!/\$879/.test(plain), 'and must not show the drifted one')
  assert.match(plain, /package subtotal/i, 'and must not call a subtotal a finished estimate')
  assert.match(plain, /Transportation pending/i)
  assert.match(plain, /\$3 per routed mile/i)
  assert.match(plain, /fuel included/i)
})

test('a lead with NO snapshot still renders from estimatedValue', () => {
  // Every lead captured before the snapshot columns existed. Nothing about
  // their display may change.
  assert.equal(quotedCentsOf({ estimatedValue: 37_900, quoteTotalCents: null }), 37_900)
  const plain = formatLeadAlert({ id: 'old', estimatedValue: 37_900 })
    .lines.map((l) => l.message)
    .join('\n')
  assert.match(plain, /\$379/, 'history renders its original amount')
  assert.ok(!/package subtotal/i.test(plain), 'and is not retro-labelled with language it never had')
})

// ══════════════════════════════════════════════════════════════════════
//  MANUAL REVIEW IS RETURNED, PERSISTED AND EXPLAINED
// ══════════════════════════════════════════════════════════════════════
test('3BR and 4BR are flagged for inventory/access/truck-plan review', () => {
  for (const key of ['3br', '4br']) {
    const q = quoteEstimate({ moveSize: key })
    assert.ok(q.ok, `${key} must price`)
    if (!q.ok) continue
    assert.equal(q.requiresReview, true, `${key} publishes a FLOOR, not a flat rate`)
    assert.equal(q.isStarting, true, 'and must render as "starting at"')
    assert.ok(q.reviewReasons.length > 0, `${key} must say WHY, not just that it needs review`)
    assert.match(q.reviewReasons.join(' '), /inventory|access|truck plan/i)
  }
  // 1BR and 2BR are settled prices and must NOT be hedged.
  for (const key of ['1br', '2br']) {
    const q = quoteEstimate({ moveSize: key })
    assert.ok(q.ok)
    if (q.ok) {
      assert.equal(q.requiresReview, false, `${key} is a flat price`)
      assert.deepEqual(q.reviewReasons, [])
    }
  }
})

test('an explicit larger truck is flagged for review, and charged once', () => {
  const up = quoteEstimate({ moveSize: '2br', truckSize: '26ft' })
  assert.ok(up.ok)
  if (!up.ok) return
  assert.equal(up.truckUpgrade, 150, 'the 26ft fee, charged once')
  assert.equal(up.requiresReview, true, 'an upgrade is APPROVED, never automatic')
  assert.match(up.reviewReasons.join(' '), /larger truck/i)
})

test('5BR remains a manual truck plan, with a reason', () => {
  const q = quoteEstimate({ moveSize: '5br' })
  assert.equal(q.ok, false)
  if (!q.ok) assert.equal(q.reason, 'manual_plan')

  const partial = pricePartialLead({ moveSize: '5br', serviceType: 'full_service' })
  assert.equal(partial.requiresReview, true)
  assert.equal(partial.estimateCents, null, 'no automatic number for a job that may need several trucks')
  assert.match(partial.reviewReasons.join(' '), /truck plan/i)
})

test('the review flag and its reasons are persisted, and the owner SEES them', () => {
  const p = pricePartialLead({ moveSize: '3br', serviceType: 'full_service' })
  assert.equal(p.requiresReview, true)
  assert.ok(p.reviewReasons.length > 0)
  assert.ok(p.snapshot, '3BR still produces a snapshot — it is a real starting price')

  const card = JSON.stringify(
    buildLeadCard({
      leadId: 'lead_3',
      name: 'Sam',
      estimateDollars: 1049,
      quoteMileageStatus: 'pending',
      reviewReasons: p.reviewReasons,
      adminUrl: 'https://example.com/admin',
    } as never),
  )
  assert.match(card, /Manual review required/i, 'the owner must SEE that it needs review')

  const plain = formatLeadAlert({ id: 'lead_3', estimatedValue: 104_900, reviewReasons: p.reviewReasons })
    .lines.map((l) => l.message)
    .join('\n')
  assert.match(plain, /Manual review/i, 'including on the fallback notice')
})

// ══════════════════════════════════════════════════════════════════════
//  THE ACTIVE PACKAGE LIST IS EXACTLY THE PUBLISHED ONE
// ══════════════════════════════════════════════════════════════════════
test('the selectable packages are exactly 1br…5br at the published prices', () => {
  const EXPECTED: Array<[string, number]> = [
    ['1br', 550],
    ['2br', 779],
    ['3br', 1049],
    ['4br', 1449],
    ['5br', 1799],
  ]
  const selectable = ACTIVE_PACKAGE_KEYS.filter((k) => k !== 'not-sure')
  assert.deepEqual([...selectable], EXPECTED.map(([k]) => k), 'the selectable set, in published order')
  for (const [key, amount] of EXPECTED) {
    assert.equal(PACKAGES[key as keyof typeof PACKAGES].price.amount, amount, key)
  }
  // The retired tiers — the studios AND the old $649 1BR — stay unsellable.
  for (const key of LEGACY_PACKAGE_KEYS) {
    assert.equal(isPackageActiveForNewIntake(key), false, `${key} must not be selectable`)
  }
  const amounts = selectable.map((k) => PACKAGES[k].price.amount)
  for (const retired of [379, 439, 549, 649]) {
    assert.ok(!amounts.includes(retired), `a selectable package is priced at a retired amount ($${retired})`)
  }
})
