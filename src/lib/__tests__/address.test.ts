// Offline tests for the shared address assessment utilities (Part 3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessAddress, assessStructured, isVagueAddress, looksCommercial } from '../address'

test('address: a complete single-line address passes every check', () => {
  const a = assessAddress('123 Main St, Newark, NJ 07102')
  assert.deepEqual(
    { sn: a.hasStreetNumber, zip: a.hasZip, cs: a.hasCityState, vague: a.isVague, complete: a.complete },
    { sn: true, zip: true, cs: true, vague: false, complete: true },
  )
})

test('address: the reported "Myrtle Ave boonton nj" is partial (no #, no ZIP, weak city/state)', () => {
  const a = assessAddress('Myrtle Ave boonton nj')
  assert.equal(a.hasStreetNumber, false)
  assert.equal(a.hasZip, false)
  assert.equal(a.complete, false)
  assert.equal(a.isVague, false) // it's partial, not empty — do NOT treat as blank
})

test('address: placeholder / empty is vague, not a real address', () => {
  assert.equal(isVagueAddress('Provided at confirmation'), true)
  assert.equal(isVagueAddress(''), true)
  assert.equal(isVagueAddress(null), true)
  assert.equal(assessAddress(null).complete, false)
})

test('address: commercial/storage signals are detected', () => {
  assert.equal(looksCommercial('32 Broadway, Suite 2, Denville NJ'), true)
  assert.equal(looksCommercial('CubeSmart Self Storage, Unit 44'), true)
  assert.equal(looksCommercial('45 Oak Ave, Montclair NJ 07042'), false)
})

test('address: structured components assess independently (pickup/dest never merged)', () => {
  const pickup = assessStructured({ street: '123 Main St', city: 'Newark', state: 'NJ', zip: '07102', unit: '4B' })
  const dest = assessStructured({ street: 'Broadway', city: '', state: '', zip: '' }) // deliberately partial
  assert.equal(pickup.complete, true)
  assert.equal(pickup.isCommercial, true) // has a unit
  assert.equal(dest.complete, false)
  assert.equal(dest.hasStreetNumber, false)
  // Asserting they're distinct objects with distinct verdicts (no cross-contamination).
  assert.notEqual(pickup.complete, dest.complete)
})
