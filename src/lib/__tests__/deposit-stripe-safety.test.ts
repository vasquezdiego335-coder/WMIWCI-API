// ════════════════════════════════════════════════════════════════════════════
//  deposit-stripe-safety.test.ts — the money-safety rules added in the
//  production-hardening pass, exercised directly.
//  ------------------------------------------------------------------------
//  Covers, offline (no Stripe, no database, no network):
//   · a Stripe Checkout Session may never stay payable materially past the
//     deposit link's own expiry  (depositSessionExpiresAt)
//   · a webhook may not mark a deposit paid unless the amount AND currency match
//     what we asked for  (isConfirmedDepositSession + isAmountOrCurrencyMismatch)
//   · the Rosey-style case renders the right day, the right time, and never the
//     internal note  (the reported end-to-end scenario)
//   · a legacy row with a whole note in serviceSummary renders as a clean,
//     bounded line rather than a wall of text
// ════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depositSessionExpiresAt } from '../stripe'
import {
  isConfirmedDepositSession,
  isAmountOrCurrencyMismatch,
  publicDepositView,
  LEGACY_SERVICE_SUMMARY_DISPLAY_MAX,
} from '../deposit-links'
import { formatMoveWhen } from '../move-date'

// ── Stripe session may not outlive the deposit link ─────────────────────────

const NOON = Date.parse('2026-08-20T12:00:00.000Z')
const asSec = (ms: number) => Math.floor(ms / 1000)

test('with no deposit expiry, the session lasts about 24h (hour-quantized)', () => {
  const exp = depositSessionExpiresAt(null, NOON)
  assert.equal(exp, asSec(NOON) + 24 * 3600, 'exactly on the hour → 24h out')
  // And it never exceeds Stripe's 24h ceiling from a mid-hour "now".
  const mid = Date.parse('2026-08-20T12:30:00.000Z')
  assert.ok(depositSessionExpiresAt(null, mid) <= asSec(mid) + 24 * 3600)
})

test('THE RULE: the session expiry is the SOONER of 24h and the link expiry', () => {
  // Link expires in 3h → the session expires in 3h, not 24h.
  const in3h = new Date(NOON + 3 * 3600_000)
  assert.equal(depositSessionExpiresAt(in3h, NOON), asSec(in3h.getTime()))

  // Link expires in 40h → clamped to our 24h default, never beyond it.
  const in40h = new Date(NOON + 40 * 3600_000)
  assert.equal(depositSessionExpiresAt(in40h, NOON), asSec(NOON) + 24 * 3600)
})

test('a link within Stripe’s 30-minute floor still yields a valid session', () => {
  // Stripe refuses expires_at under 30 min out; a link with 10 min left is at
  // end of life, and payableOrReason will refuse it once it truly expires. The
  // session is clamped UP to the floor rather than rejected.
  const now = Date.parse('2026-08-20T12:30:00.000Z')
  const in10m = new Date(now + 10 * 60_000)
  const exp = depositSessionExpiresAt(in10m, now)
  assert.ok(exp >= asSec(now) + 30 * 60, 'never below Stripe’s 30-minute minimum')
  assert.ok(exp <= asSec(now) + 24 * 3600, 'never above Stripe’s 24-hour maximum')
})

test('every result respects Stripe’s absolute [30min, 24h] bounds', () => {
  const now = Date.parse('2026-08-20T12:17:00.000Z')
  for (const mins of [-1000, 0, 5, 29, 31, 60, 23 * 60, 24 * 60, 25 * 60, 100 * 60]) {
    const exp = depositSessionExpiresAt(new Date(now + mins * 60_000), now)
    assert.ok(exp >= asSec(now) + 30 * 60, `floor violated at ${mins}min`)
    assert.ok(exp <= asSec(now) + 24 * 3600, `ceiling violated at ${mins}min`)
  }
})

// ── Webhook amount + currency verification ──────────────────────────────────

const PAID = { payment_status: 'paid', amount_total: 4900, currency: 'usd' }

test('a paid session matching the expected amount and currency is confirmed', () => {
  const r = isConfirmedDepositSession(PAID, { amountCents: 4900, currency: 'usd' })
  assert.deepEqual(r, { confirmed: true, amountCents: 4900 })
})

test('THE GUARD: a paid session with the WRONG amount is refused, not credited', () => {
  const r = isConfirmedDepositSession({ ...PAID, amount_total: 5000 }, { amountCents: 4900, currency: 'usd' })
  assert.equal(r.confirmed, false)
  assert.match((r as { reason: string }).reason, /amount_mismatch/)
  assert.ok(isAmountOrCurrencyMismatch((r as { reason: string }).reason), 'flagged for a human')
})

test('a paid session in the WRONG currency is refused', () => {
  const r = isConfirmedDepositSession({ ...PAID, currency: 'eur' }, { amountCents: 4900, currency: 'usd' })
  assert.equal(r.confirmed, false)
  assert.match((r as { reason: string }).reason, /currency_mismatch/)
  assert.ok(isAmountOrCurrencyMismatch((r as { reason: string }).reason))
})

test('currency defaults to usd when the row stored none', () => {
  assert.equal(isConfirmedDepositSession(PAID, { amountCents: 4900, currency: null }).confirmed, true)
  assert.equal(isConfirmedDepositSession(PAID, { amountCents: 4900 }).confirmed, true)
})

test('the amount check does not fire for the ordinary "not paid yet" states', () => {
  // A delayed payment method fires completed with payment_status=unpaid FIRST.
  // That is a normal no-op, NOT a mismatch a human needs to see.
  const unpaid = isConfirmedDepositSession({ payment_status: 'unpaid', amount_total: 4900, currency: 'usd' }, { amountCents: 4900 })
  assert.equal(unpaid.confirmed, false)
  assert.ok(!isAmountOrCurrencyMismatch((unpaid as { reason: string }).reason), 'not flagged as a mismatch')
})

test('without an expected figure the gate keeps its original, laxer behaviour', () => {
  // The webhook always passes `expected` now; this proves the extra check is
  // additive and nothing else changed for a caller that does not.
  assert.equal(isConfirmedDepositSession(PAID).confirmed, true)
  assert.equal(isConfirmedDepositSession({ payment_status: 'paid', amount_total: 0 }).confirmed, false)
})

// ── THE ROSEY CASE (the reported end-to-end scenario) ───────────────────────

const ROSEY = {
  publicToken: 'SACBX6T8SZHB',
  customerName: 'Rosey Alvarez',
  quoteTotalCents: 49500,
  balanceBeforeCents: 49500,
  amountCents: 4900,
  serviceSummary: 'Labor-Only Move · 2 Movers',
  moveDetails: [
    'Apartment next door',
    'Old wooden bed frame removal',
    'New queen bed frame assembly',
    '15 stairs at pickup',
    '7 stairs at drop-off',
  ],
  customerNote: 'Please have all bed-frame hardware/screws available.',
  internalNote: 'Job Note: Saturday, 7:00 AM — 2 workers, park rear lot, gate code 4417.',
  moveDate: new Date('2026-08-22T00:00:00.000Z'), // the LEGACY midnight-UTC shape
  moveTimeMinutes: 420,
  status: 'ACTIVE',
  expiresAt: null,
  paidAt: null,
}

test('ROSEY: August 22 (not 21), 7:00 AM, and no internal note anywhere', () => {
  const view = publicDepositView(ROSEY, new Date('2026-08-20T12:00:00.000Z'))

  assert.equal(formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'en'), 'Saturday, August 22 · 7:00 AM')
  assert.ok(!formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'en')!.includes('August 21'))
  assert.equal(formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'es'), 'sábado, 22 de agosto · 7:00 a.m.')

  assert.equal(view.serviceSummary, 'Labor-Only Move · 2 Movers')
  assert.equal(view.moveDetails.length, 5)
  assert.equal(view.customerNote, 'Please have all bed-frame hardware/screws available.')

  const serialized = JSON.stringify(view)
  assert.ok(!('internalNote' in view), 'the projection has no internalNote field')
  assert.ok(!serialized.includes('Job Note'), 'the internal note must never reach the customer')
  assert.ok(!serialized.includes('4417'), 'nor the gate code inside it')

  // The money reconciles on screen: 495 − 49 = 446.
  assert.equal(view.remainingCents, 44600)
})

// ── Legacy rows: a whole note in the OLD serviceSummary field ───────────────

test('a legacy serviceSummary renders as a clean, bounded line — never a wall', () => {
  const legacyNote =
    'Job Note:\r\n\tSaturday 7:00 AM — 2 workers, labor-only move, customer has own truck, ' +
    'park in the rear lot by the loading door, gate code 4417, call on arrival, ' +
    'fragile mirror in the bedroom, be careful with the hardwood floors throughout the apartment.'
  const view = publicDepositView(
    { publicToken: 'SACBX6T8SZHB', amountCents: 4900, status: 'ACTIVE', serviceSummary: legacyNote },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.ok(view.serviceSummary, 'still shown, not dropped')
  assert.ok(!/[\r\n\t]/.test(view.serviceSummary!), 'newlines and tabs collapsed to a single line')
  assert.ok(view.serviceSummary!.length <= LEGACY_SERVICE_SUMMARY_DISPLAY_MAX, 'bounded so it cannot be a paragraph')
})

test('a whitespace-only legacy serviceSummary collapses to null, not an empty row', () => {
  const view = publicDepositView(
    { publicToken: 'SACBX6T8SZHB', amountCents: 4900, status: 'ACTIVE', serviceSummary: '   \n\t  ' },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.equal(view.serviceSummary, null)
})
