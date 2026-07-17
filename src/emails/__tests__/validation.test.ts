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
    () => assertEmailPayload('final-confirmation', { displayId: 'W', customerName: 'D', timeLabel: '8-10', originAddress: 'a', destAddress: 'b', service: 's', amountPaid: '49', portalUrl: 'https://moveitclearit.com/x' }),
    /requestedDate/,
  )
})
test('job-reminder payload with no arrival window fails', () => {
  assert.throws(() => assertEmailPayload('job-reminder', { requestedDate: '2026-08-01', service: 's', originAddress: 'a', destAddress: 'b', portalUrl: 'https://moveitclearit.com/x' }), /timeLabel/)
})
test('booking-updated with no changed fields fails', () => {
  assert.throws(() => assertEmailPayload('booking-updated', { portalUrl: 'https://moveitclearit.com/x' }), /no changed fields/)
})
test('a complete final-confirmation payload passes', () => {
  assert.doesNotThrow(() =>
    assertEmailPayload('final-confirmation', {
      displayId: 'WMIC-1', customerName: 'D', requestedDate: '2026-08-01T15:00:00Z', timeLabel: '8:00–10:00 AM',
      originAddress: '1 A St', destAddress: '2 B St', service: '1BR', amountPaid: '49', portalUrl: 'https://moveitclearit.com/my-booking/tok',
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
]

for (const [name, el] of all) {
  test(`${name}: no unsafe href in rendered HTML`, async () => {
    const html = await render(el)
    const hrefs = Array.from(html.matchAll(/href="([^"]*)"/g)).map((m) => m[1])
    const bad = hrefs.map((h) => [h, unsafeUrlReason(h)] as const).filter(([, r]) => r)
    assert.equal(bad.length, 0, `${name} unsafe hrefs: ${bad.map(([h, r]) => `${h} (${r})`).join(', ')}`)
  })
}
