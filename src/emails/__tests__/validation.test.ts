import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import { unsafeUrlReason, isSafeUrl, assertSafeUrls, requireFields, assertEmailPayload, EmailValidationError } from '../validation'

import PreApproval from '../pre-approval'
import FinalConfirmation from '../final-confirmation'
import BookingDeclined from '../booking-declined'
import BookingCancellation from '../booking-cancellation'
import BookingUpdated from '../booking-updated'
import JobReminder from '../job-reminder'
import JobCompletion from '../job-completion'
import PaymentReceipt from '../payment-receipt'
import AbandonedCheckout from '../abandoned-checkout'
import Referral from '../referral'
import ReviewRequest from '../review-request'
import PaymentFailed from '../payment-failed'
import InformationRequired from '../information-required'
import OperationalAlert from '../operational-alert'
import FinalInvoice from '../final-invoice'
import ReferralReward from '../referral-reward'

// ── Link safety ───────────────────────────────────────────────────────────────
test('unsafeUrlReason flags placeholder + unsafe URLs', () => {
  for (const bad of ['#', '', '  ', 'javascript:alert(1)', 'http://localhost:3000/x', 'http://x.com', 'https://foo.vercel.app/y', '/book', undefined, null]) {
    assert.ok(unsafeUrlReason(bad as any), `expected unsafe: ${JSON.stringify(bad)}`)
  }
})
test('unsafeUrlReason passes real production URLs', () => {
  for (const ok of ['https://moveitclearit.com/my-booking/tok', 'mailto:hello@moveitclearit.com', 'tel:+18626400625']) {
    assert.equal(unsafeUrlReason(ok), null, `expected safe: ${ok}`)
    assert.ok(isSafeUrl(ok))
  }
})
test('assertSafeUrls throws on a placeholder', () => {
  assert.throws(() => assertSafeUrls({ portalUrl: '#' }), EmailValidationError)
  assert.doesNotThrow(() => assertSafeUrls({ portalUrl: 'https://moveitclearit.com/x' }))
})

// ── Required data ─────────────────────────────────────────────────────────────
test('requireFields throws when a required field is blank', () => {
  assert.throws(() => requireFields('t', { a: '1', b: '' }, ['a', 'b']), EmailValidationError)
  assert.doesNotThrow(() => requireFields('t', { a: '1', b: '2' }, ['a', 'b']))
})
test('final-confirmation payload with no confirmed date fails', () => {
  assert.throws(
    () => assertEmailPayload('final-confirmation', { displayId: 'W', timeLabel: '8-10', amountPaid: '49', portalUrl: 'https://moveitclearit.com/x' }),
    /date/,
  )
})
test('job-reminder payload with no arrival window fails', () => {
  assert.throws(() => assertEmailPayload('job-reminder', { scheduledStart: '2026-08-01', originAddress: 'a', portalUrl: 'https://moveitclearit.com/x' }), /timeLabel/)
})
test('booking-updated with no changed fields fails', () => {
  assert.throws(() => assertEmailPayload('booking-updated', { portalUrl: 'https://moveitclearit.com/x' }), /no changed fields/)
})
test('a complete final-confirmation payload passes', () => {
  assert.doesNotThrow(() =>
    assertEmailPayload('final-confirmation', {
      displayId: 'WMIC-1', date: '2026-08-01T15:00:00Z', timeLabel: '8:00–10:00 AM',
      amountPaid: '49', portalUrl: 'https://moveitclearit.com/my-booking/tok',
    }),
  )
})
test('assertEmailPayload rejects an unsafe url in the payload', () => {
  assert.throws(() => assertEmailPayload('payment-receipt', { displayId: 'W', date: 'x', amountPaid: '49', portalUrl: '#', receiptUrl: 'http://localhost/r' }), EmailValidationError)
})

// ── Rendered-href scan: no template ships an unsafe link when given real URLs ──
const URL = 'https://moveitclearit.com/my-booking/TOKEN'
const common = { customerName: 'Diego', displayId: 'WMIC-1017', locale: 'en' as const, portalUrl: URL, checkoutUrl: URL, rebookUrl: URL, reviewUrl: URL, referralUrl: URL, googleReviewUrl: URL }
const all: Array<[string, React.ReactElement]> = [
  ['pre-approval', React.createElement(PreApproval, { ...common, amountHold: '1' })],
  ['final-confirmation', React.createElement(FinalConfirmation, { ...common, amountPaid: '1' })],
  ['booking-declined', React.createElement(BookingDeclined, { ...common, amountHold: '1' })],
  ['booking-cancellation', React.createElement(BookingCancellation, { ...common, amount: '1', refundStatus: 'released' })],
  ['booking-updated', React.createElement(BookingUpdated, { ...common, amountHold: '1', changedLabel: 'the date' })],
  ['job-reminder', React.createElement(JobReminder, { ...common })],
  ['job-completion', React.createElement(JobCompletion, { ...common })],
  ['payment-receipt', React.createElement(PaymentReceipt, { ...common, amountPaid: '1.00', captured: true })],
  ['abandoned-checkout', React.createElement(AbandonedCheckout, { ...common, amountHold: '1' })],
  ['referral', React.createElement(Referral, { ...common })],
  ['review-request', React.createElement(ReviewRequest, { ...common })],
  ['payment-failed', React.createElement(PaymentFailed, { ...common, updatePaymentUrl: URL })],
  ['information-required', React.createElement(InformationRequired, { ...common, missing: ['Exact pickup address', 'Apartment / access details'] })],
  ['operational-alert', React.createElement(OperationalAlert, { ...common, alertType: 'reschedule', message: 'Our crew hit a delay on an earlier job.', newDate: '2026-08-02T15:00:00Z', newTimeLabel: '9–11 AM' })],
  ['final-invoice', React.createElement(FinalInvoice, { ...common, laborTotal: '420', grandTotal: '420', amountPaid: '1', balanceDue: '419', payUrl: URL })],
  ['referral-reward', React.createElement(ReferralReward, { ...common, rewardLabel: '$25 credit', rewardCode: 'THANKS25', redeemUrl: URL })],
]

for (const [name, el] of all) {
  test(`${name}: no unsafe href in rendered HTML`, async () => {
    const html = await render(el)
    const hrefs = Array.from(html.matchAll(/href="([^"]*)"/g)).map((m) => m[1])
    const bad = hrefs.map((h) => [h, unsafeUrlReason(h)] as const).filter(([, r]) => r)
    assert.equal(bad.length, 0, `${name} unsafe hrefs: ${bad.map(([h, r]) => `${h} (${r})`).join(', ')}`)
  })
}

// ── PLACEHOLDER URL REGRESSION (production incident 2026-07-24) ──────────────
// APP_URL was left as `https://PASTE_YOUR_LIVE_URL_HERE` in production. It is a
// structurally valid absolute https URL, so it passed every check and shipped to
// a real inbox as a 404 link — the exact failure the placeholder gate exists to
// prevent. These lock the fix: the wording-based markers AND the structural
// "underscore in a hostname is illegal in DNS" catch-all.
test('placeholder URLs are refused (the exact production value + variants)', () => {
  for (const url of [
    'https://PASTE_YOUR_LIVE_URL_HERE',
    'https://PASTE_YOUR_LIVE_URL_HERE/my-booking/abc123',
    'https://your-live-url-here.com',
    'https://ADD_YOUR_URL',
    'https://REPLACE_ME.com',
    'https://YOUR_DOMAIN.com',
  ]) {
    assert.ok(unsafeUrlReason(url) !== null, `must be refused: ${url}`)
    assert.equal(isSafeUrl(url), false, `isSafeUrl must be false: ${url}`)
  }
})

test('an underscore in the HOSTNAME is always refused; in a path it is fine', () => {
  // DNS hostnames cannot contain underscores, so such a host can never resolve.
  assert.ok(unsafeUrlReason('https://not_a_real_host.com') !== null)
  // ...but a path/query underscore is perfectly legitimate.
  assert.equal(unsafeUrlReason('https://moveitclearit.com/path_with_underscore?a=b_c'), null)
})

test('real production URLs still pass (no false positives)', () => {
  assert.equal(unsafeUrlReason('https://moveitclearit.com/my-booking/abc'), null)
  assert.equal(unsafeUrlReason('https://www.moveitclearit.com/quote?src=qr&utm_source=door_hanger'), null)
  assert.equal(unsafeUrlReason('mailto:hello@moveitclearit.com'), null)
})
