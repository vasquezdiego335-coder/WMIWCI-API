// Offline unit tests for the estimating assistant (src/lib/estimate-assistant.ts).
// Run: npx tsx --test src/lib/__tests__/estimate-assistant.test.ts — no DB, no network.
//
// The guarantee under test: the recommendation is ADVISORY, deterministic, and
// derives its truck/size truth from the live tables (MIN_TRUCK_BY_PACKAGE,
// MOVE_SIZES) — it never invents a truck, never hides an adjustment behind a
// bare number, and says "unconfirmed" instead of guessing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recommendEstimate,
  BASE_BY_PACKAGE,
  CREW_MIN,
  CREW_MAX,
  HOURS_MAX,
  type EstimateAssistantInput,
} from '../estimate-assistant'
import { MOVE_SIZES } from '../estimate'
import { MIN_TRUCK_BY_PACKAGE, MANUAL_TRUCK_PLAN_PACKAGES } from '../pricing-config'

const base = (over: Partial<EstimateAssistantInput> = {}): EstimateAssistantInput => ({
  serviceType: null,
  inventory: [],
  ...over,
})

// ── The spec's acceptance case ──────────────────────────────────────────────
// 2-bedroom + two couches + destStairFlights 2 (no elevator) + a bed that
// needs disassembly → crew 3, the LIVE minimum truck for 2br, hours 4..6/4..7,
// difficulty elevated+, reasons naming stairs + disassembly + size.
test('assistant: 2BR acceptance case — crew, truck from the live table, hours, reasons', () => {
  const rec = recommendEstimate(
    base({
      serviceType: '2br',
      inventory: [
        { name: 'Couch (3-seat)', quantity: 2 },
        { name: 'Queen bed frame', quantity: 1, needsDisassembly: true },
      ],
      destStairFlights: 2,
      destHasElevator: false,
    })
  )

  assert.equal(rec.crewSize, 3, 'base 2BR crew, no heavy trigger from plain couches')
  // The truck must be whatever the LIVE table says for 2br — read, not guessed.
  assert.equal(rec.truckSize, MIN_TRUCK_BY_PACKAGE['2br'])
  assert.ok(rec.truckSize, '2br must resolve to a real truck size')
  assert.equal(rec.estimatedHoursMin, 4)
  assert.ok(
    rec.estimatedHoursMax === 6 || rec.estimatedHoursMax === 7,
    `max hours ${rec.estimatedHoursMax} must be 6 or 7 (stair/disassembly rules applied consistently)`
  )
  assert.notEqual(rec.difficulty, 'standard', 'stairs >= 2 flights escalate difficulty')
  assert.ok(rec.reasons.some((r) => /stair/i.test(r)), 'reasons must name the stairs')
  assert.ok(rec.reasons.some((r) => /disassembl/i.test(r)), 'reasons must name the disassembly')
  const sizeLabel = MOVE_SIZES['2br'].label
  assert.ok(rec.reasons.some((r) => r.includes(sizeLabel)), 'reasons must name the move size')
  assert.equal(rec.jobSizeLabel, sizeLabel)
})

// ── not-sure / null honesty ─────────────────────────────────────────────────
test('assistant: not-sure and null size say "unconfirmed" instead of guessing', () => {
  for (const serviceType of ['not-sure', null, undefined, 'made-up-package']) {
    const rec = recommendEstimate(base({ serviceType }))
    assert.equal(rec.crewSize, 2, `${serviceType}: unconfirmed size gets the 2-crew band`)
    assert.equal(rec.estimatedHoursMin, 3, `${serviceType}: 3h floor`)
    assert.equal(rec.estimatedHoursMax, 5, `${serviceType}: 5h ceiling`)
    assert.equal(rec.truckSize, null, `${serviceType}: no truck can be honest yet`)
    assert.ok(
      rec.reasons.some((r) => /size unconfirmed — verify on the call/i.test(r)),
      `${serviceType}: must carry the unconfirmed reason`
    )
  }
})

// ── Truck matches MIN_TRUCK_BY_PACKAGE for EVERY package key ────────────────
test('assistant: truck agrees with the live MIN_TRUCK_BY_PACKAGE for every key', () => {
  for (const key of Object.keys(MOVE_SIZES)) {
    const rec = recommendEstimate(base({ serviceType: key }))
    const expected = MIN_TRUCK_BY_PACKAGE[key]
    if (expected) {
      assert.equal(rec.truckSize, expected, `${key} must get its table minimum`)
    } else {
      // 5br / not-sure: manual truck plan — the honest answer is null + reason.
      assert.equal(rec.truckSize, null, `${key} has no auto-assignable truck`)
      assert.ok(MANUAL_TRUCK_PLAN_PACKAGES.has(key) || key === 'not-sure', `${key} unexpectedly truckless`)
    }
  }
})

test('assistant: every package key has a base crew/hours band', () => {
  for (const key of Object.keys(MOVE_SIZES)) {
    if (key === 'not-sure') continue
    assert.ok(BASE_BY_PACKAGE[key], `${key} missing from BASE_BY_PACKAGE`)
  }
})

// ── Crew adjustments ────────────────────────────────────────────────────────
test('assistant: 2+ heavy items or a 3-mover item add exactly one crew member', () => {
  const heavy = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Safe', quantity: 2, isHeavy: true }] })
  )
  assert.equal(heavy.crewSize, 3, '1br base 2 + 1 for two heavy items')
  assert.ok(heavy.reasons.some((r) => /heavy/i.test(r)))

  const piano = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Upright piano', quantity: 1, isHeavy: true, recommendedMovers: 4 }] })
  )
  assert.equal(piano.crewSize, 3, 'recommendedMovers >= 3 adds one crew member')
  assert.ok(piano.reasons.some((r) => /movers/i.test(r)))

  // One heavy item without a movers recommendation is NOT a crew trigger.
  const one = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Dresser', quantity: 1, isHeavy: true }] })
  )
  assert.equal(one.crewSize, 2)
})

// ── Stairs / elevator hour rules ────────────────────────────────────────────
test('assistant: stair hours count only ends without an elevator', () => {
  // 3 flights at pickup, no elevator: beyond-the-first = 2 → +1h both bounds.
  const stairs = recommendEstimate(base({ serviceType: '1br', originStairFlights: 3 }))
  assert.equal(stairs.estimatedHoursMin, 4, '1br 3h + 1 stair hour')
  assert.equal(stairs.estimatedHoursMax, 5)

  // Same flights but the elevator covers them: no stair hours.
  const lift = recommendEstimate(base({ serviceType: '1br', originStairFlights: 3, originHasElevator: true }))
  assert.equal(lift.estimatedHoursMin, 3)
  assert.equal(lift.estimatedHoursMax, 4)
  assert.equal(lift.difficulty, 'standard', 'elevator-served stairs do not escalate difficulty')
})

// ── Packing / assembly widen the ceiling, never the floor ───────────────────
test('assistant: packing and assembly/disassembly adjust the max bound only', () => {
  const rec = recommendEstimate(
    base({ serviceType: '2br', needsPacking: true, needsAssembly: true, needsDisassembly: true })
  )
  assert.equal(rec.estimatedHoursMin, 4, 'floor unchanged')
  assert.equal(rec.estimatedHoursMax, 6 + 1 + 1 + 1, 'packing + assembly + disassembly each add to the ceiling')
  assert.ok(rec.reasons.some((r) => /packing/i.test(r)))
  assert.ok(rec.reasons.some((r) => /reassembly/i.test(r)))
  assert.ok(rec.reasons.some((r) => /disassembl/i.test(r)))
})

// ── Trips ───────────────────────────────────────────────────────────────────
test('assistant: >40 items or a heavy studio move may take a second trip', () => {
  const many = recommendEstimate(
    base({ serviceType: '2br', inventory: [{ name: 'Box (medium)', quantity: 41 }] })
  )
  assert.equal(many.possibleTrips, 2)
  assert.ok(many.reasons.some((r) => /trip/i.test(r)))

  const studio = recommendEstimate(
    base({ serviceType: 'full-studio', inventory: [{ name: 'Washer', quantity: 1, isHeavy: true }, { name: 'Dryer', quantity: 1, isHeavy: true }] })
  )
  assert.equal(studio.possibleTrips, 2, 'studio-class + 2 heavy items')

  const plain = recommendEstimate(base({ serviceType: '2br', inventory: [{ name: 'Box (large)', quantity: 10 }] }))
  assert.equal(plain.possibleTrips, 1)
})

// ── Difficulty ladder ───────────────────────────────────────────────────────
test('assistant: difficulty escalates standard → elevated → high', () => {
  assert.equal(recommendEstimate(base({ serviceType: '1br' })).difficulty, 'standard')

  const heavyOnly = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Fridge', quantity: 1, isHeavy: true }] })
  )
  assert.equal(heavyOnly.difficulty, 'elevated', 'any heavy item elevates')

  const stairsOnly = recommendEstimate(base({ serviceType: '1br', originStairFlights: 2 }))
  assert.equal(stairsOnly.difficulty, 'elevated', '2+ stair flights elevate')

  const both = recommendEstimate(
    base({ serviceType: '1br', originStairFlights: 2, inventory: [{ name: 'Fridge', quantity: 1, isHeavy: true }] })
  )
  assert.equal(both.difficulty, 'high', 'heavy AND stairs is high')

  const poolTable = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Pool table', quantity: 1 }] })
  )
  assert.equal(poolTable.difficulty, 'high', 'piano/safe/pool-table names are high by themselves')
  assert.ok(poolTable.reasons.some((r) => /pool table/i.test(r)))
})

// ── Caps ────────────────────────────────────────────────────────────────────
test('assistant: crew stays within 2..5 and hours within 2..12, bounds ordered', () => {
  const monster = recommendEstimate(
    base({
      serviceType: '5br',
      inventory: [
        { name: 'Upright piano', quantity: 2, isHeavy: true, recommendedMovers: 4 },
        { name: 'Gun safe', quantity: 3, isHeavy: true, recommendedMovers: 3 },
        { name: 'Box (large)', quantity: 60 },
      ],
      originStairFlights: 8,
      destStairFlights: 8,
      needsPacking: true,
      needsAssembly: true,
      needsDisassembly: true,
    })
  )
  assert.ok(monster.crewSize <= CREW_MAX, `crew ${monster.crewSize} capped at ${CREW_MAX}`)
  assert.ok(monster.crewSize >= CREW_MIN)
  assert.ok(monster.estimatedHoursMax <= HOURS_MAX, `hours ${monster.estimatedHoursMax} capped at ${HOURS_MAX}`)
  assert.ok(monster.estimatedHoursMin <= monster.estimatedHoursMax, 'bounds stay ordered')
  assert.ok(Number.isInteger(monster.estimatedHoursMin) && Number.isInteger(monster.estimatedHoursMax))

  const tiny = recommendEstimate(base({ serviceType: 'little-studio' }))
  assert.ok(tiny.crewSize >= CREW_MIN, 'crew never drops below 2')
  assert.ok(tiny.estimatedHoursMin >= 2, 'hours never drop below 2')
})

// ── Reasons are never empty ─────────────────────────────────────────────────
test('assistant: every recommendation explains itself', () => {
  for (const key of [...Object.keys(MOVE_SIZES), null]) {
    const rec = recommendEstimate(base({ serviceType: key }))
    assert.ok(rec.reasons.length > 0, `${key ?? 'null'}: reasons must be non-empty`)
    assert.ok(rec.reasons.every((r) => typeof r === 'string' && r.trim().length > 0))
  }
})

// ── Bedrooms fallback ───────────────────────────────────────────────────────
test('assistant: bedrooms fall back onto the live package keys when no size chosen', () => {
  const rec = recommendEstimate(base({ serviceType: null, bedrooms: 2, inventory: [] }))
  assert.equal(rec.jobSizeLabel, MOVE_SIZES['2br'].label)
  assert.equal(rec.crewSize, BASE_BY_PACKAGE['2br'].crew)
  assert.equal(rec.truckSize, MIN_TRUCK_BY_PACKAGE['2br'])
  assert.ok(rec.reasons.some((r) => /bedroom count/i.test(r)))

  // An explicit not-sure is NOT overridden by a bedroom count — honesty wins.
  const notSure = recommendEstimate(base({ serviceType: 'not-sure', bedrooms: 3 }))
  assert.equal(notSure.truckSize, null)
  assert.ok(notSure.reasons.some((r) => /size unconfirmed/i.test(r)))
})

// ── Advisory-only inputs still surface as reasons ───────────────────────────
test('assistant: long carry and additional stops are noted for the call', () => {
  const rec = recommendEstimate(base({ serviceType: '1br', longCarry: true, additionalStops: 2 }))
  assert.ok(rec.reasons.some((r) => /long carry/i.test(r)))
  assert.ok(rec.reasons.some((r) => /2 additional stops/i.test(r)))
  // Advisory notes never change the numbers on their own.
  assert.equal(rec.estimatedHoursMin, 3)
  assert.equal(rec.estimatedHoursMax, 4)
  assert.equal(rec.crewSize, 2)
})
