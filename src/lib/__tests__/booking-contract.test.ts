// Field-contract tests (owner spec Part 10). These FAIL when the booking data
// pipeline drifts: a form field the API doesn't recognize, an undocumented
// field, a sensitive field that is customer-visible, or sensitive data present
// in a public projection. Run: npm test (tsx --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOKING_FIELD_MAP,
  CUSTOMER_PORTAL_OMIT,
  contractViolations,
  sensitiveKeysPresent,
} from '../booking-contract'

test('contract: the documented field map holds all its invariants', () => {
  const problems = contractViolations()
  assert.deepEqual(problems, [], `contract violations:\n${problems.join('\n')}`)
})

test('contract: every form-sent field maps to an API property', () => {
  for (const [key, spec] of Object.entries(BOOKING_FIELD_MAP)) {
    if (spec.form) assert.ok(spec.api, `${key} is sent by the form but has no API property`)
  }
})

test('contract: no sensitive field is ever customer-visible', () => {
  for (const [key, spec] of Object.entries(BOOKING_FIELD_MAP)) {
    if (spec.sensitive) assert.ok(!spec.visibility.includes('customer'), `${key} is sensitive but customer-visible`)
  }
})

test('contract: access codes are documented owner/crew-only + in the portal omit list', () => {
  for (const col of ['originAccessCode', 'destAccessCode']) {
    const spec = Object.values(BOOKING_FIELD_MAP).find((s) => s.db === col)
    assert.ok(spec?.sensitive, `${col} must be sensitive`)
    assert.ok(!spec!.visibility.includes('customer'))
    assert.ok(CUSTOMER_PORTAL_OMIT.includes(col), `${col} must be stripped from the customer portal`)
  }
})

test('contract: a simulated customer portal projection carries NO sensitive fields', () => {
  // Model the real projection: full booking minus the omit list.
  const fullBooking: Record<string, unknown> = {
    id: 'b1', displayId: 'MIC-1', originAddress: '1 A St 07102', destAddress: '2 B St 07042',
    originAccessCode: '1988#', destAccessCode: 'gate-4321', internalNotes: 'owner only',
    stripePaymentIntentId: 'pi_x', stripeCheckoutId: 'cs_x', ipAddress: '1.2.3.4',
    customerNotes: 'bring blankets', originUnit: '4B',
  }
  const projection = { ...fullBooking }
  for (const k of CUSTOMER_PORTAL_OMIT) delete projection[k]

  assert.deepEqual(sensitiveKeysPresent(projection), [], 'sensitive keys leaked into the customer projection')
  // Non-sensitive customer fields survive.
  assert.equal(projection.customerNotes, 'bring blankets')
  assert.equal(projection.originUnit, '4B')
})
