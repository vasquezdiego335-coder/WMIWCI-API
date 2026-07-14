// Offline unit tests for the canonical booking estimate (src/lib/estimate.ts).
// Run: npm test  (tsx --test)  — no DB, no network.
//
// The whole point of this file is Part 1's guarantee: the number the customer
// sees on the booking form and the number the server stores/emails CANNOT
// silently disagree. The `FORM_*` constants below are a byte-for-byte copy of
// the booking form's own tables (WMIWCI-SITE/public/booking-form.html); the
// parity matrix recomputes the form's headline independently and asserts the
// server module produces the identical total for every combination.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeEstimate, storedTotalEstimate, MOVE_SIZES, ACCESS_MODIFIERS } from '../estimate'

// ── The exact bug scenario: 1BR + stairs + heavy items ──────────────────────
// Form showed $699 (599 + 40 + 60); server used to store $599. They must match.
test('estimate: 1BR + stairs + heavy items = $699 (the regression)', () => {
  const est = computeEstimate({ serviceType: '1br', stairs: true, heavyItems: true })
  assert.equal(est.base, 599)
  assert.equal(est.accessAddons, 100)
  assert.equal(est.travel, 0)
  assert.equal(est.estimatedTotal, 699)
  assert.equal(storedTotalEstimate({ serviceType: '1br', stairs: true, heavyItems: true }), 699)
})

// ── Travel is IN the total but flagged due-on-move-day ──────────────────────
test('estimate: travel fee is included in the total and in dueOnMoveDay', () => {
  const est = computeEstimate({ serviceType: '2br', travelFeeCents: 5000 })
  assert.equal(est.base, 699)
  assert.equal(est.travel, 50)
  assert.equal(est.estimatedTotal, 749) // 699 + 50 travel
  assert.equal(est.dueOnMoveDay, 50)
})

// ── Truck add-on is NOT in the estimatedTotal (its own move-day line) ───────
test('estimate: truck add-on is move-day only, never in estimatedTotal', () => {
  const est = computeEstimate({ serviceType: '1br', truckAddonDueOnMoveDay: true })
  assert.equal(est.estimatedTotal, 599) // truck NOT added
  assert.equal(est.truckAddon, 50)
  assert.equal(est.dueOnMoveDay, 50)
})

// ── Every access add-on lands in the total, none silently discarded ─────────
test('estimate: all access add-ons contribute to the total', () => {
  const est = computeEstimate({
    serviceType: 'full-studio', // 509
    stairs: true, // 40
    longWalk: true, // 30
    heavyItems: true, // 60
    elevatorAccess: 'far', // 25
    parkingDistance: 'far', // 50
    buildingYear: 'old', // 40
  })
  assert.equal(est.accessAddons, 40 + 30 + 60 + 25 + 50 + 40)
  assert.equal(est.estimatedTotal, 509 + 245)
  assert.equal(est.accessLines.length, 6)
  assert.ok(est.accessLines.every((l) => l.timing === 'included'))
})

// ── Zero-cost access selections don't create phantom lines ──────────────────
test('estimate: zero-value access selections add nothing', () => {
  const est = computeEstimate({ serviceType: '1br', elevatorAccess: 'close', parkingDistance: 'door', buildingYear: 'newer' })
  assert.equal(est.accessAddons, 0)
  assert.equal(est.estimatedTotal, 599)
  assert.equal(est.accessLines.length, 0)
})

// ── storedTotalEstimate: null only when genuinely empty ─────────────────────
test('estimate: storedTotalEstimate is null with no size and no fees', () => {
  assert.equal(storedTotalEstimate({}), null)
  assert.equal(storedTotalEstimate({ serviceType: 'not-sure' }), 0) // known size (Need a Quote) → 0, not null
  assert.equal(storedTotalEstimate({ travelFeeCents: 5000 }), 50) // fee with no size still surfaces
})

// ════════════════════════════════════════════════════════════════════════
//  FORM PARITY — the anti-divergence guarantee.
//  A byte-for-byte copy of the form's SERVICES + MODIFIERS + headline formula.
//  If anyone edits the server constants without the form (or vice-versa and
//  updates this copy), the matrix assertion fails.
// ════════════════════════════════════════════════════════════════════════
const FORM_SERVICES: Record<string, number> = {
  'little-studio': 359, 'half-studio': 409, 'full-studio': 509, '1br': 599,
  '2br': 699, '3br': 949, '4br': 1249, '5br': 1549, 'not-sure': 0,
}
const FORM_MODIFIERS = {
  stairs: 40, longWalk: 30, heavyItems: 60,
  elevator: { none: 0, close: 0, far: 25 } as Record<string, number>,
  parking: { door: 0, short: 0, medium: 25, far: 50 } as Record<string, number>,
  building: { newer: 0, mid: 0, old: 40, unsure: 0, '': 0 } as Record<string, number>,
}
// The form's headline formula: base + access add-ons + travel (truck excluded).
function formHeadline(inp: {
  serviceType: string; stairs?: boolean; longWalk?: boolean; heavyItems?: boolean
  elevatorAccess?: string; parkingDistance?: string; buildingYear?: string; travelFeeCents?: number
}): number {
  const base = FORM_SERVICES[inp.serviceType] ?? 0
  let addons = 0
  if (inp.stairs) addons += FORM_MODIFIERS.stairs
  if (inp.longWalk) addons += FORM_MODIFIERS.longWalk
  if (inp.heavyItems) addons += FORM_MODIFIERS.heavyItems
  addons += FORM_MODIFIERS.elevator[inp.elevatorAccess ?? ''] || 0
  addons += FORM_MODIFIERS.parking[inp.parkingDistance ?? ''] || 0
  addons += FORM_MODIFIERS.building[inp.buildingYear ?? ''] || 0
  return base + addons + (inp.travelFeeCents ?? 0) / 100
}

test('estimate: server constants match the form tables exactly', () => {
  for (const [k, v] of Object.entries(FORM_SERVICES)) assert.equal(MOVE_SIZES[k]?.price, v, `size ${k}`)
  assert.equal(ACCESS_MODIFIERS.stairs, FORM_MODIFIERS.stairs)
  assert.equal(ACCESS_MODIFIERS.longWalk, FORM_MODIFIERS.longWalk)
  assert.equal(ACCESS_MODIFIERS.heavyItems, FORM_MODIFIERS.heavyItems)
  assert.equal(ACCESS_MODIFIERS.elevator.far, FORM_MODIFIERS.elevator.far)
  assert.equal(ACCESS_MODIFIERS.parking.far, FORM_MODIFIERS.parking.far)
  assert.equal(ACCESS_MODIFIERS.parking.medium, FORM_MODIFIERS.parking.medium)
  assert.equal(ACCESS_MODIFIERS.building.old, FORM_MODIFIERS.building.old)
})

test('estimate: form headline == server estimatedTotal across a full matrix', () => {
  const sizes = Object.keys(FORM_SERVICES)
  const elevators = ['none', 'close', 'far', '']
  const parkings = ['door', 'short', 'medium', 'far', '']
  const buildings = ['newer', 'mid', 'old', 'unsure', '']
  const travels = [0, 5000]
  let checked = 0
  for (const serviceType of sizes)
    for (const stairs of [false, true])
      for (const longWalk of [false, true])
        for (const heavyItems of [false, true])
          for (const elevatorAccess of elevators)
            for (const parkingDistance of parkings)
              for (const buildingYear of buildings)
                for (const travelFeeCents of travels) {
                  const inp = { serviceType, stairs, longWalk, heavyItems, elevatorAccess, parkingDistance, buildingYear, travelFeeCents }
                  const server = computeEstimate(inp).estimatedTotal
                  const form = formHeadline(inp)
                  assert.equal(server, form, `mismatch for ${JSON.stringify(inp)}`)
                  checked++
                }
  assert.ok(checked > 5000, `expected a large matrix, checked ${checked}`)
})
