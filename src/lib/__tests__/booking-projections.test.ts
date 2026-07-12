// Security regression tests for the explicit allow-list projections (Part 5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  customerBookingProjection,
  crewBookingProjection,
  CUSTOMER_BOOKING_ALLOW,
  CREW_BOOKING_ALLOW,
  SENSITIVE_BOOKING_COLUMNS,
} from '../booking-projections'

// A full booking with every sensitive field populated + safe relations.
const FULL = {
  id: 'b1', displayId: 'MIC-1', status: 'PENDING_APPROVAL',
  originAddress: '1 A St, Newark NJ 07102', destAddress: '2 B St, Montclair NJ 07042',
  originUnit: '4B', originAccessCode: '1988#', destAccessCode: 'gate-4321',
  originAccessNotes: 'rear lot', baseRate: 699, totalEstimate: 749, depositAmount: 4900,
  customerNotes: 'bring blankets', internalNotes: 'owner only — upsell',
  stripeCheckoutId: 'cs_x', stripePaymentIntentId: 'pi_x', ipAddress: '1.2.3.4', userAgent: 'UA',
  discordJobChannelId: '123', discordApprovalMessageId: '456', addressEvaluation: { zones: [] }, discountApprovedById: 'u9',
  truckProvider: 'U-Haul', crewInstructions: 'call ahead',
  customer: { name: 'Diego', email: 'd@x.com', phone: '(973) 555-0147', locale: 'en' },
  payments: [{ amount: 4900, status: 'COMPLETED', createdAt: '2026-07-12', stripePaymentIntentId: 'pi_x', stripeChargeId: 'ch_x' }],
  files: [{ id: 'f1', type: 'PHOTO_BEFORE', filename: 'p.jpg', cloudinaryUrl: 'https://x/p.jpg', createdAt: '2026-07-12' }],
  receipt: { cloudinaryUrl: 'https://x/r.pdf', sentAt: '2026-07-12' },
}

test('projection: no sensitive column is on the customer allow-list', () => {
  for (const s of SENSITIVE_BOOKING_COLUMNS) {
    assert.ok(!CUSTOMER_BOOKING_ALLOW.includes(s as never), `sensitive "${s}" is on the customer allow-list`)
  }
})

test('projection: customer payload carries NO sensitive fields (codes, Stripe IDs, internal notes, IP/UA, Discord IDs)', () => {
  const p = customerBookingProjection(FULL) as Record<string, unknown>
  for (const s of SENSITIVE_BOOKING_COLUMNS) assert.ok(!(s in p), `customer payload leaked ${s}`)
  // Nested payments must not carry Stripe IDs either.
  const pay = (p.payments as Record<string, unknown>[])[0]
  assert.ok(!('stripePaymentIntentId' in pay) && !('stripeChargeId' in pay), 'payment stripe IDs leaked')
  // But the customer-safe data survives.
  assert.equal(p.originAddress, '1 A St, Newark NJ 07102')
  assert.equal(p.customerNotes, 'bring blankets')
  assert.equal((p.customer as Record<string, unknown>).email, 'd@x.com')
})

test('projection: crew payload has access codes (needed on site) but NO payment/pricing/Stripe data', () => {
  const c = crewBookingProjection(FULL) as Record<string, unknown>
  assert.equal(c.originAccessCode, '1988#') // crew needs it near move day
  assert.ok(!('baseRate' in c) && !('totalEstimate' in c) && !('depositAmount' in c), 'pricing leaked to crew')
  assert.ok(!('payments' in c) && !('stripePaymentIntentId' in c), 'payment data leaked to crew')
  assert.ok(!('internalNotes' in c), 'internal notes leaked to crew')
  // Contact only — no email.
  assert.equal((c.customer as Record<string, unknown>).phone, '(973) 555-0147')
  assert.ok(!('email' in (c.customer as Record<string, unknown>)))
})

test('projection: a brand-new sensitive column is excluded by default (allow-list, not deny-list)', () => {
  const withNewSecret = { ...FULL, someNewSecretColumn: 'leak-me' } as Record<string, unknown>
  const p = customerBookingProjection(withNewSecret)
  assert.ok(!('someNewSecretColumn' in p), 'unknown field must not appear unless explicitly allowed')
})
