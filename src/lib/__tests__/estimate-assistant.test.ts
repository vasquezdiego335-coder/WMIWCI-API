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
  itemCrewFloor,
  specialtyCrewFloor,
  BASE_BY_PACKAGE,
  CREW_MIN,
  CREW_MAX,
  HOURS_MAX,
  type EstimateAssistantInput,
} from '../estimate-assistant'
import { MOVE_SIZES } from '../estimate'
import { DEFAULT_INVENTORY_CATALOG } from '../inventory-catalog'
import { MIN_TRUCK_BY_PACKAGE, MANUAL_TRUCK_PLAN_PACKAGES } from '../pricing-config'

/** The house catalog's own rating for a named item — the number the name-based
 *  floor must agree with. Read from the live table so this test can never
 *  quietly encode a second opinion (the module derives it the same way). */
function catalogMovers(itemName: string): number {
  const row = DEFAULT_INVENTORY_CATALOG.find((r) => r.name === itemName)
  assert.ok(row, `${itemName} must exist in DEFAULT_INVENTORY_CATALOG`)
  assert.ok(row!.recommendedMovers, `${itemName} must carry a mover rating`)
  return row!.recommendedMovers!
}

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

  // A 3-mover item adds exactly one crew member on top of the package base.
  // (Its own 3-mover FLOOR is not binding here — 2 + 1 already reaches 3. The
  // floor rule itself is covered by the "item floor" tests below.)
  const bigCrew = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Gun safe', quantity: 1, isHeavy: true, recommendedMovers: 3 }] })
  )
  assert.equal(bigCrew.crewSize, 3, 'recommendedMovers >= 3 adds one crew member')
  assert.ok(bigCrew.reasons.some((r) => /movers/i.test(r)))

  // One heavy item without a movers recommendation is NOT a crew trigger.
  const one = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Dresser', quantity: 1, isHeavy: true }] })
  )
  assert.equal(one.crewSize, 2)
})

// ── Item crew FLOOR (fix pass item 5) ───────────────────────────────────────
// An item's recommendedMovers is a FLOOR, not one number in an average: the
// package base can never talk a 4-mover item down to a 3-mover crew, and when
// the floor is what decided the number the reason names the item.

test('floor: studio package + a 4-mover piano recommends 4 movers and names the item', () => {
  const rec = recommendEstimate(
    base({
      serviceType: 'full-studio',
      inventory: [{ name: 'Piano (upright)', quantity: 1, isHeavy: true, recommendedMovers: 4 }],
    })
  )
  // Studio base crew is 2 and the big-crew adjustment only adds 1 → the old
  // math landed on 3. The item floor is what makes this a 4-mover job.
  assert.equal(BASE_BY_PACKAGE['full-studio'].crew, 2, 'guard: the package base really is small')
  assert.equal(rec.crewSize, 4, 'the 4-mover item sets the crew, the package base does not average it away')
  const named = rec.reasons.find((r) => /piano \(upright\)/i.test(r) && /requires 4 movers/i.test(r))
  assert.ok(named, `a reason must name the item that set the floor — got ${JSON.stringify(rec.reasons)}`)
  assert.ok(/raised to 4/i.test(named!), 'the reason says the crew was raised to the item floor')
})

test('floor: 2BR + a 3-mover pool table never drops below 3', () => {
  const rec = recommendEstimate(
    base({
      serviceType: '2br',
      inventory: [
        { name: 'Pool table', quantity: 1, isHeavy: true, recommendedMovers: 3 },
        { name: 'Box (medium)', quantity: 12 },
      ],
    })
  )
  assert.ok(rec.crewSize >= 3, `crew ${rec.crewSize} must never fall under the 3-mover item floor`)
  // 2BR base 3 + the existing big-crew adjustment = 4; the floor of 3 is not
  // binding, so no floor reason is written (we never claim a rule we did not use).
  assert.equal(rec.crewSize, 4, '2BR base 3 + one big-crew item')
  assert.ok(
    !rec.reasons.some((r) => /requires 3 movers/i.test(r)),
    'a floor that did not decide the number must not claim credit'
  )
})

test('floor: an item needing more than the cap gets capped at 5 with an explicit reason', () => {
  const rec = recommendEstimate(
    base({
      serviceType: '2br',
      inventory: [{ name: 'Commercial gun safe', quantity: 1, isHeavy: true, recommendedMovers: 7 }],
    })
  )
  assert.equal(rec.crewSize, CREW_MAX, 'the cap still stands — we never promise a crew we cannot field')
  const capped = rec.reasons.find((r) => /commercial gun safe/i.test(r) && /requires 7 movers/i.test(r))
  assert.ok(capped, `the shortfall must be stated, not swallowed — got ${JSON.stringify(rec.reasons)}`)
  assert.ok(/capped at 5/i.test(capped!), 'the reason says the crew was capped')
  assert.ok(
    /second trip|outside help/i.test(capped!),
    'the reason tells the owner what to do about the gap'
  )
  assert.ok(!rec.reasons.some((r) => /raised to 7/i.test(r)), 'never claim a 7-person crew')
})

test('floor: a floor at exactly the cap is honoured without the over-cap warning', () => {
  const rec = recommendEstimate(
    base({ serviceType: '1br', inventory: [{ name: 'Hot tub', quantity: 1, isHeavy: true, recommendedMovers: 5 }] })
  )
  assert.equal(rec.crewSize, 5)
  assert.ok(rec.reasons.some((r) => /hot tub requires 5 movers/i.test(r)))
  assert.ok(!rec.reasons.some((r) => /capped at/i.test(r)), 'nothing was capped away here')
})

test('floor: the floor never LOWERS a crew the job already earned', () => {
  const rec = recommendEstimate(
    base({
      serviceType: '4br',
      inventory: [
        { name: 'Washer', quantity: 1, isHeavy: true, recommendedMovers: 2 },
        { name: 'Dryer', quantity: 1, isHeavy: true, recommendedMovers: 2 },
      ],
    })
  )
  // 4BR base 4 + 1 for two heavy items = 5; a 2-mover item must not pull it down.
  assert.equal(rec.crewSize, 5)
  assert.ok(!rec.reasons.some((r) => /requires 2 movers/i.test(r)))
})

test('floor: missing / junk recommendedMovers values are ignored, never crash', () => {
  const junk = recommendEstimate(
    base({
      serviceType: '1br',
      inventory: [
        { name: 'Lamp', quantity: 1, recommendedMovers: null },
        { name: 'Rug', quantity: 1 },
        { name: 'Broken row', quantity: 1, recommendedMovers: 0 },
        { name: 'Negative row', quantity: 1, recommendedMovers: -3 },
        { name: 'NaN row', quantity: 1, recommendedMovers: Number.NaN },
      ],
    })
  )
  assert.equal(junk.crewSize, BASE_BY_PACKAGE['1br'].crew, 'junk values leave the base crew alone')
  assert.ok(junk.crewSize >= CREW_MIN)
  assert.ok(!junk.reasons.some((r) => /requires .* movers/i.test(r)))

  // A fractional catalog value floors to whole movers (3.9 people is 3 people).
  const fractional = recommendEstimate(
    base({ serviceType: 'little-studio', inventory: [{ name: 'Marble table', quantity: 1, recommendedMovers: 3.9 }] })
  )
  assert.equal(fractional.crewSize, 3, 'base 2 + big-crew adjustment 1, floor 3 not binding above it')
})

test('floor: itemCrewFloor picks the biggest requirement and is tie-stable', () => {
  assert.equal(itemCrewFloor([]), null)
  assert.equal(itemCrewFloor([{ name: 'Rug', quantity: 1 }]), null)

  const biggest = itemCrewFloor([
    { name: 'Couch', quantity: 1, recommendedMovers: 2 },
    { name: 'Piano (upright)', quantity: 1, recommendedMovers: 4 },
    { name: 'Safe', quantity: 1, recommendedMovers: 3 },
  ])
  assert.deepEqual(biggest, { movers: 4, name: 'Piano (upright)' })

  const tie = itemCrewFloor([
    { name: 'Safe', quantity: 1, recommendedMovers: 3 },
    { name: 'Pool table', quantity: 1, recommendedMovers: 3 },
  ])
  assert.deepEqual(tie, { movers: 3, name: 'Safe' }, 'first item wins a tie → deterministic reasons')
})

// ── R2-7.2: the floor fires on a HAND-TYPED specialty line ──────────────────
//
// THE DEFECT: the Book Move inventory picker lets the owner type a line that
// is not in the catalog. A typed "Piano" therefore arrived with
// recommendedMovers = null, so the item floor above never fired and the
// recommendation came back at the package base — a 2-3 mover piano job — even
// though the SAME name sets hasPiano = true on the booking through
// admin-booking's PIANO_RE. The booking said "there is a piano here" while the
// crew plan said "two people".
//
// These tests are written so the DEFECT would fail them: each one uses a line
// with NO catalog id and NO recommendedMovers, which is exactly the input the
// old floor ignored.

test('R2-7.2: a hand-typed "Piano" line reaches the same crew floor as the catalog row', () => {
  const pianoMovers = catalogMovers('Piano (upright)')

  // A custom line: the owner typed it, so there is no catalog row behind it.
  const typed = recommendEstimate(
    base({ serviceType: 'full-studio', inventory: [{ name: 'Piano', quantity: 1 }] })
  )
  assert.equal(
    BASE_BY_PACKAGE['full-studio'].crew,
    2,
    'guard: the package base really is small, so only the floor can produce the right number',
  )
  assert.equal(
    typed.crewSize,
    pianoMovers,
    'a typed piano must reach the house floor, not the package base',
  )
  const named = typed.reasons.find((r) => /piano/i.test(r) && /requires \d+ movers/i.test(r))
  assert.ok(named, `the reason must name the item that set the floor — got ${JSON.stringify(typed.reasons)}`)
  assert.ok(new RegExp(`raised to ${pianoMovers}`, 'i').test(named!), 'the reason says what the crew was raised to')

  // And it agrees with the catalog line for the same item, so which way the
  // owner entered the piano cannot change the crew.
  const fromCatalog = recommendEstimate(
    base({
      serviceType: 'full-studio',
      inventory: [{ name: 'Piano (upright)', quantity: 1, isHeavy: true, recommendedMovers: pianoMovers }],
    })
  )
  assert.equal(typed.crewSize, fromCatalog.crewSize, 'typed and catalog entry must staff the same job the same way')
})

test('R2-7.2: typed safes and pool tables reach their own house floors', () => {
  const safeMovers = catalogMovers('Safe')
  const poolMovers = catalogMovers('Pool table')

  const safe = recommendEstimate(base({ serviceType: 'little-studio', inventory: [{ name: 'Gun safe', quantity: 1 }] }))
  assert.equal(safe.crewSize, safeMovers, 'a typed safe reaches the safe floor')

  const pool = recommendEstimate(base({ serviceType: 'little-studio', inventory: [{ name: 'Pool table', quantity: 1 }] }))
  assert.equal(pool.crewSize, poolMovers, 'a typed pool table reaches the pool-table floor')

  // Plain typed lines are NOT specialty items — the floor must not fire on
  // everything the owner types by hand.
  const plain = recommendEstimate(
    base({ serviceType: 'little-studio', inventory: [{ name: 'Fish tank (55 gal)', quantity: 1 }] })
  )
  assert.equal(plain.crewSize, BASE_BY_PACKAGE['little-studio'].crew, 'an ordinary typed line changes nothing')
  assert.ok(!plain.reasons.some((r) => /requires \d+ movers/i.test(r)))
})

test('R2-7.2: the floor number is READ from the house catalog, never a second opinion', () => {
  // specialtyCrewFloor must agree with DEFAULT_INVENTORY_CATALOG for each kind,
  // so editing a rating there moves this rule with it.
  assert.deepEqual(specialtyCrewFloor('Piano'), { movers: catalogMovers('Piano (upright)'), kind: 'piano' })
  assert.deepEqual(specialtyCrewFloor('upright piano'), { movers: catalogMovers('Piano (upright)'), kind: 'piano' })
  assert.deepEqual(specialtyCrewFloor('Gun safe (600 lb)'), { movers: catalogMovers('Safe'), kind: 'safe' })
  assert.deepEqual(specialtyCrewFloor('Billiards table'), { movers: catalogMovers('Pool table'), kind: 'pool table' })
  assert.deepEqual(specialtyCrewFloor('pool  table'), { movers: catalogMovers('Pool table'), kind: 'pool table' })

  // Not specialty, empty, junk → no claim at all.
  for (const name of ['Couch (3-seat)', 'Medium box', '', '   ']) {
    assert.equal(specialtyCrewFloor(name), null, `${JSON.stringify(name)} must claim no floor`)
  }
  // The regexes have no /g flag, so repeated calls are stable (a lastIndex bug
  // here would make the floor fire on alternate lines only).
  for (let n = 0; n < 3; n++) {
    assert.deepEqual(specialtyCrewFloor('Piano'), { movers: catalogMovers('Piano (upright)'), kind: 'piano' })
  }
})

test('R2-7.2: a typed specialty line still cannot exceed the crew cap or lower an earned crew', () => {
  // 4BR base 4 + two heavy items = 5; a typed pool table (floor 3) must not
  // pull it down.
  const big = recommendEstimate(
    base({
      serviceType: '4br',
      inventory: [
        { name: 'Washer', quantity: 1, isHeavy: true, recommendedMovers: 2 },
        { name: 'Dryer', quantity: 1, isHeavy: true, recommendedMovers: 2 },
        { name: 'Pool table', quantity: 1 },
      ],
    })
  )
  assert.equal(big.crewSize, CREW_MAX)
  assert.ok(!big.reasons.some((r) => /raised to 3/i.test(r)), 'a floor that did not decide the number claims nothing')

  // A typed line with a junk catalog value still gets its NAME floor: the
  // name and the rating are independent signals.
  const junkRating = recommendEstimate(
    base({ serviceType: 'little-studio', inventory: [{ name: 'Piano', quantity: 1, recommendedMovers: Number.NaN }] })
  )
  assert.equal(junkRating.crewSize, catalogMovers('Piano (upright)'))
})

test('floor: the acceptance case is untouched — no item movers, no floor reason', () => {
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
  assert.equal(rec.crewSize, 3)
  assert.ok(!rec.reasons.some((r) => /requires .* movers/i.test(r)))
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
