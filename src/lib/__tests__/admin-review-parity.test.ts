// ════════════════════════════════════════════════════════════════════════════
//  admin-review-parity.test.ts — R2-5: an admin booking must be review-gated
//  exactly like the identical public booking.
//
//  THE DEFECT (round 1 shipped a green test over it): POST /api/admin/bookings
//  calls computeEstimate() WITHOUT any heavy/specialty input, and every
//  heavy/specialty review reason in the canonical estimator exists only under
//  that input. So an admin 2BR booking carrying the catalog's "Piano (upright)"
//  landed with hasPiano = true and specialtyItems = "Piano (upright)" but
//  manualReviewRequired = false and reviewReasons = [] — a row that contradicts
//  itself, and one that Action Center rules, booking-completeness, the Discord
//  card and the "pending review" copy all treat as a settled job. The IDENTICAL
//  public booking is gated.
//
//  WHY ROUND 1'S TEST DID NOT CATCH IT: it hand-built an estimate the route
//  cannot produce (`computeEstimate({ heavyItems: [{ pounds: 450 }] })`) and
//  asserted that buildBookingCreateData copied its reasons through. That proves
//  the plumbing, not the guarantee — the route never passes heavyItems, so the
//  branch under test was unreachable in production.
//
//  SO THIS FILE DRIVES THE ROUTE'S OWN PIPELINE, from a raw POST payload:
//      raw JSON  →  AdminBookingSchema.safeParse
//                →  resolveInventorySnapshots(catalog built from the REAL
//                   DEFAULT_INVENTORY_CATALOG rows)
//                →  computeEstimate(...)  ← the route's exact argument list,
//                   heavy/specialty input included nowhere
//                →  buildBookingCreateData(input, ctx, snapshots)
//  and asserts the COLUMNS. Every test below first pins the precondition that
//  made the bug possible (`estimate.requiresReview === false`), so none of them
//  can pass by accident through the estimator.
//
//  Offline: no DB, no network. Run:
//    npx tsx --test src/lib/__tests__/admin-review-parity.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AdminBookingSchema,
  buildBookingCreateData,
  resolveInventorySnapshots,
  type AdminBookingInput,
  type CatalogSnapshotSource,
  type InventorySnapshot,
} from '../admin-booking'
import { computeEstimate, type Estimate } from '../estimate'
import { DEFAULT_INVENTORY_CATALOG } from '../inventory-catalog'

// ── The catalog, built from the REAL default rows ───────────────────────────
// Not a hand-written fixture: the piano/safe/pool-table rows the picker offers
// an owner are the rows this test books with, so a catalog edit moves the test
// with it. `id` mirrors the row name (the DB assigns cuids; the id is opaque to
// everything under test).

function catalogRow(name: string): CatalogSnapshotSource {
  const row = DEFAULT_INVENTORY_CATALOG.find((r) => r.name === name)
  assert.ok(row, `${name} must exist in DEFAULT_INVENTORY_CATALOG`)
  return {
    id: `cat_${name.replace(/\W+/g, '_').toLowerCase()}`,
    name: row!.name,
    isHeavy: !!row!.isHeavy,
    needsDisassembly: !!row!.needsDisassembly,
    recommendedMovers: row!.recommendedMovers ?? null,
    category: row!.category,
    typicalVolumeCuFt: null,
  }
}

const CATALOG = new Map<string, CatalogSnapshotSource>()
for (const name of ['Piano (upright)', 'Safe', 'Pool table', 'Couch (3-seat)', 'Medium box']) {
  const row = catalogRow(name)
  CATALOG.set(row.id, row)
}
const catalogIdFor = (name: string): string => catalogRow(name).id

/** A future ISO date (UTC-derived is never behind the ET calendar day). */
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

/** The raw body the Book Move form POSTs — the DEFAULT owner path: stripe_link
 *  deposit, no crew start time (day-level), full service. */
function payload(inventory: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    customer: { name: 'Dana Mover', email: 'dana@example.com', phone: '862-640-0625' },
    move: {
      serviceType: '2br',
      moveDate: FUTURE,
      originAddress: { street: '12 Main St', city: 'West Orange', zip: '07052' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory,
    pricing: { ownerTotal: 950 },
    deposit: { mode: 'stripe_link' },
  }
}

function parsePayload(inventory: Array<Record<string, unknown>>): AdminBookingInput {
  const res = AdminBookingSchema.safeParse(payload(inventory))
  assert.ok(res.success, `payload must be valid: ${!res.success ? JSON.stringify(res.error.flatten()) : ''}`)
  return res.data
}

/** EXACTLY the argument list app/api/admin/bookings/route.ts hands
 *  computeEstimate — no heavy/specialty input anywhere. Reproduced here so the
 *  tests inherit the real blind spot instead of quietly fixing it. */
function routeEstimate(input: AdminBookingInput, travelFeeCents = 0): Estimate {
  return computeEstimate({
    serviceType: input.move.serviceType,
    pickupStairFlights: input.move.originStairFlights,
    dropoffStairFlights: input.move.destStairFlights,
    longWalk: input.move.longCarry,
    additionalStops: input.move.additionalStopsCount
      ? Array.from({ length: input.move.additionalStopsCount }, (_, n) => ({ label: `Additional stop ${n + 1}` }))
      : null,
    travelFeeCents,
  })
}

/** The whole route pipeline for one inventory: payload → columns. */
function bookWith(inventory: Array<Record<string, unknown>>): {
  data: ReturnType<typeof buildBookingCreateData>
  estimate: Estimate
  snapshots: InventorySnapshot[]
  reasons: string[]
} {
  const input = parsePayload(inventory)
  const snapshots = resolveInventorySnapshots(input.inventory, CATALOG)
  const estimate = routeEstimate(input)
  const data = buildBookingCreateData(
    input,
    {
      estimate,
      travel: { zone: 'primary', travelFeeCents: 0, message: null, manualReviewRequired: false },
      reference: 'WMIC-3001',
      tokenExpiry: new Date('2026-10-01T00:00:00Z'),
      requestedDate: new Date('2026-09-11T04:00:00Z'),
      // The DEFAULT path: no crew start time was captured.
      schedule: {
        requestedDate: new Date('2026-09-11T04:00:00Z'),
        scheduledStart: null,
        scheduledEnd: null,
        dayLevel: true,
        startTime: null,
      },
      // Verification "ran" and came back skipped (no provider key) — the
      // ordinary case, and one that is NOT a review reason on its own, so an
      // address verdict can never be what makes these assertions pass.
      verification: {
        origin: { status: 'skipped', reason: 'no_provider_key' },
        dest: { status: 'skipped', reason: 'no_provider_key' },
      },
      estimatedHours: 6,
    },
    snapshots,
  )
  return { data, estimate, snapshots, reasons: (data.reviewReasons as string[]) ?? [] }
}

const PIANO_LINE = { catalogItemId: catalogIdFor('Piano (upright)'), name: 'Piano (upright)', quantity: 1 }
const COUCH_LINE = { catalogItemId: catalogIdFor('Couch (3-seat)'), name: 'Couch (3-seat)', quantity: 2 }
const BOX_LINE = { catalogItemId: catalogIdFor('Medium box'), name: 'Medium box', quantity: 15 }

// ════════════════════════════════════════════════════════════════════════════
//  The guarantee
// ════════════════════════════════════════════════════════════════════════════

test('R2-5: an admin booking whose inventory contains a piano is review-gated', () => {
  const { data, estimate, reasons } = bookWith([COUCH_LINE, BOX_LINE, PIANO_LINE])

  // PRECONDITION — this is the blind spot the defect lived in. The estimator,
  // called the way the route calls it, sees no piano at all. If this ever
  // becomes true on its own the assertions below stop proving R2-5 and this
  // line will say so.
  assert.equal(
    estimate.requiresReview,
    false,
    'guard: the route-shaped estimate does NOT know about the piano — the gate must come from the inventory',
  )

  // THE GUARANTEE.
  assert.equal(data.manualReviewRequired, true, 'a piano books review-gated, exactly like the public path')
  assert.ok(reasons.length > 0, 'a gated booking must carry readable reasons')
  const named = reasons.find((r) => /piano/i.test(r))
  assert.ok(named, `a reason must name the piano — got ${JSON.stringify(reasons)}`)
  assert.ok(named!.includes('Piano (upright)'), 'the reason names the exact line the owner captured')

  // And the row is INTERNALLY CONSISTENT, which is what the defect broke: the
  // booking said "there is a piano" and "nothing needs review" at once.
  assert.equal(data.hasPiano, true)
  assert.match(String(data.specialtyItems), /Piano \(upright\)/)
})

test('R2-5: admin and public paths agree — the same piano gates both', () => {
  // The PUBLIC path's semantics for a piano: computeEstimate's piano/safe line
  // is a manual_quote → requiresReview, whatever the weight.
  const publicEstimate = computeEstimate({
    serviceType: '2br',
    heavyItems: [{ label: 'Piano (upright)', isPianoOrSafe: true }],
  })
  assert.equal(publicEstimate.requiresReview, true, 'guard: the public path really does gate a piano')

  const admin = bookWith([PIANO_LINE])
  assert.equal(
    admin.data.manualReviewRequired,
    publicEstimate.requiresReview,
    'who typed the booking in must not decide whether it is reviewed',
  )
})

test('R2-5: safes and pool tables gate an admin booking too', () => {
  for (const name of ['Safe', 'Pool table']) {
    const { data, estimate, reasons } = bookWith([
      COUCH_LINE,
      { catalogItemId: catalogIdFor(name), name, quantity: 1 },
    ])
    assert.equal(estimate.requiresReview, false, `guard: the estimate is still blind to the ${name}`)
    assert.equal(data.manualReviewRequired, true, `${name} must gate the booking`)
    assert.ok(
      reasons.some((r) => r.toLowerCase().includes(name.toLowerCase())),
      `a reason must name the ${name} — got ${JSON.stringify(reasons)}`,
    )
  }
})

test('R2-5 + R2-7.2: a HAND-TYPED specialty line gates the booking as well', () => {
  // No catalogItemId — the owner typed it on the phone. This is the same line
  // that sets hasPiano through the name regex, so it must reach the same gate;
  // otherwise the contradictory row simply moves from catalog lines to typed
  // ones.
  const { data, estimate, snapshots, reasons } = bookWith([{ name: 'Piano', quantity: 1 }])
  assert.equal(snapshots[0].catalogItemId, null, 'guard: this really is a custom line')
  assert.equal(snapshots[0].recommendedMovers, null, 'guard: a custom line carries no catalog rating')
  assert.equal(estimate.requiresReview, false, 'guard: the estimate is blind to it')
  assert.equal(data.hasPiano, true)
  assert.equal(data.manualReviewRequired, true, 'a typed piano is still a piano')
  assert.ok(reasons.some((r) => /piano/i.test(r)))
})

// ════════════════════════════════════════════════════════════════════════════
//  What must NOT change
// ════════════════════════════════════════════════════════════════════════════

test('R2-5: an ordinary inventory is NOT gated (no false positives)', () => {
  const ordinary = bookWith([COUCH_LINE, BOX_LINE])
  assert.deepEqual(ordinary.reasons, [], 'a couch and boxes need nobody to review anything')
  assert.equal(ordinary.data.manualReviewRequired, false)
  assert.equal(ordinary.data.hasPiano, false)

  // An inventory that was never captured is "not asked", not "specialty-free"
  // — and it still must not be gated by this rule (its own warning covers it).
  const empty = bookWith([])
  assert.deepEqual(empty.reasons, [])
  assert.equal(empty.data.manualReviewRequired, false)
  assert.equal(empty.data.hasPiano, null)
})

test('R2-5: gating a booking never moves the money', () => {
  // The specialty reasons are review lines worth $0 in the estimator, and the
  // owner-price comparison (requiresOverrideReason) is built on estimatedTotal.
  // Adding a piano must change the REVIEW verdict and nothing about the price.
  const without = bookWith([COUCH_LINE, BOX_LINE])
  const withPiano = bookWith([COUCH_LINE, BOX_LINE, PIANO_LINE])

  assert.equal(withPiano.estimate.estimatedTotal, without.estimate.estimatedTotal)
  assert.equal(withPiano.data.baseRate, without.data.baseRate)
  assert.equal(withPiano.data.totalEstimate, without.data.totalEstimate)
  assert.equal(withPiano.data.travelFee, without.data.travelFee)
  assert.equal(withPiano.data.depositAmount, 4900)
  // Only the verdict moved.
  assert.equal(without.data.manualReviewRequired, false)
  assert.equal(withPiano.data.manualReviewRequired, true)
})

test('R2-5: the specialty verdict rides ON TOP of the other review reasons', () => {
  // A service area needing owner review and a piano both raise their own
  // reason — one must never swallow the other, and neither is duplicated.
  const input = parsePayload([PIANO_LINE])
  const snapshots = resolveInventorySnapshots(input.inventory, CATALOG)
  const data = buildBookingCreateData(
    input,
    {
      estimate: routeEstimate(input),
      travel: {
        zone: 'new_york',
        travelFeeCents: 0,
        message: 'New York — owner review required',
        manualReviewRequired: true,
      },
      reference: 'WMIC-3002',
      tokenExpiry: new Date('2026-10-01T00:00:00Z'),
      requestedDate: new Date('2026-09-11T04:00:00Z'),
      estimatedHours: 6,
      verification: {
        origin: { status: 'skipped', reason: 'no_provider_key' },
        dest: { status: 'skipped', reason: 'no_provider_key' },
      },
    },
    snapshots,
  )
  const reasons = (data.reviewReasons as string[]) ?? []
  assert.equal(data.manualReviewRequired, true)
  assert.ok(reasons.includes('New York — owner review required'), 'the service-area reason survives')
  assert.ok(reasons.some((r) => /piano/i.test(r)), 'the inventory reason survives')
  assert.equal(new Set(reasons).size, reasons.length, 'no duplicated reasons')
  assert.ok(
    reasons.every((r) => typeof r === 'string' && r.trim().length > 10),
    'every reason must be a sentence an owner can read at 6am',
  )
})

test('R2-5: a specialty flag and a clean review verdict can never coexist', () => {
  // The property the defect violated, asserted over the whole matrix rather
  // than one example: if the booking says it carries a piano / safe / pool
  // table, it must also say somebody has to look at it.
  const inventories: Array<Array<Record<string, unknown>>> = [
    [],
    [COUCH_LINE],
    [BOX_LINE, COUCH_LINE],
    [PIANO_LINE],
    [COUCH_LINE, PIANO_LINE, BOX_LINE],
    [{ catalogItemId: catalogIdFor('Safe'), name: 'Safe', quantity: 1 }],
    [{ catalogItemId: catalogIdFor('Pool table'), name: 'Pool table', quantity: 1 }],
    [{ name: 'Piano', quantity: 1 }],
    [{ name: 'Gun safe (600 lb)', quantity: 1 }],
    [{ name: 'Billiards table', quantity: 1 }],
    [{ name: 'Fish tank (55 gal)', quantity: 1 }],
  ]
  for (const inv of inventories) {
    const { data } = bookWith(inv)
    const carriesSpecialty = data.hasPiano === true || data.hasSafe === true || data.hasPoolTable === true
    if (carriesSpecialty) {
      assert.equal(
        data.manualReviewRequired,
        true,
        `contradictory row for ${JSON.stringify(inv)}: specialty item present, review not required`,
      )
    }
  }
})
