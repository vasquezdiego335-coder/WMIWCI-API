import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretVerdict, extractComponents, verifyAddress } from '../address-verify'

// ── interpretVerdict decision table ──
test('verdict: complete PREMISE with nothing unconfirmed → verified', () => {
  assert.equal(interpretVerdict({ addressComplete: true, validationGranularity: 'PREMISE', hasUnconfirmedComponents: false }).status, 'verified')
})
test('verdict: SUB_PREMISE complete → verified (apartment-level)', () => {
  assert.equal(interpretVerdict({ addressComplete: true, validationGranularity: 'SUB_PREMISE' }).status, 'verified')
})
test('verdict: PREMISE but unconfirmed components → partial', () => {
  const r = interpretVerdict({ addressComplete: true, validationGranularity: 'PREMISE', hasUnconfirmedComponents: true })
  assert.equal(r.status, 'partial')
  assert.equal(r.reason, 'unconfirmed_components')
})
test('verdict: incomplete PREMISE → partial', () => {
  assert.equal(interpretVerdict({ addressComplete: false, validationGranularity: 'PREMISE' }).status, 'partial')
})
test('verdict: ROUTE granularity ("Myrtle Ave") → unverified', () => {
  const r = interpretVerdict({ addressComplete: false, validationGranularity: 'ROUTE' })
  assert.equal(r.status, 'unverified')
  assert.equal(r.reason, 'granularity_route')
})
test('verdict: missing verdict → unverified', () => {
  assert.equal(interpretVerdict(undefined).status, 'unverified')
})

// ── extractComponents ──
test('components: standard NJ address extracts all fields', () => {
  const c = extractComponents([
    { componentType: 'street_number', componentName: { text: '32' } },
    { componentType: 'route', componentName: { text: 'Broadway' } },
    { componentType: 'locality', componentName: { text: 'Denville' } },
    { componentType: 'administrative_area_level_2', componentName: { text: 'Morris County' } },
    { componentType: 'administrative_area_level_1', componentName: { text: 'NJ' } },
    { componentType: 'postal_code', componentName: { text: '07834' } },
    { componentType: 'country', componentName: { text: 'USA' } },
  ])
  assert.equal(c.streetNumber, '32')
  assert.equal(c.route, 'Broadway')
  assert.equal(c.city, 'Denville')
  assert.equal(c.county, 'Morris County')
  assert.equal(c.state, 'NJ')
  assert.equal(c.zip, '07834')
})
test('components: locality wins over sublocality; empty input safe', () => {
  const c = extractComponents([
    { componentType: 'locality', componentName: { text: 'Newark' } },
    { componentType: 'sublocality_level_1', componentName: { text: 'Ironbound' } },
  ])
  assert.equal(c.city, 'Newark')
  assert.deepEqual(extractComponents(undefined), {})
})

// ── verifyAddress degrade paths (no key in test env) ──
test('verifyAddress: empty input → unverified/empty_address', async () => {
  const r = await verifyAddress(['  '])
  assert.equal(r.status, 'unverified')
  assert.equal(r.reason, 'empty_address')
})
test('verifyAddress: no provider key → skipped (never throws, never blocks)', async () => {
  const prev = process.env.GOOGLE_MAPS_SERVER_KEY
  delete process.env.GOOGLE_MAPS_SERVER_KEY
  const r = await verifyAddress(['123 Main St', 'West Orange, NJ 07052'])
  assert.equal(r.status, 'skipped')
  assert.equal(r.reason, 'no_provider_key')
  if (prev) process.env.GOOGLE_MAPS_SERVER_KEY = prev
})
