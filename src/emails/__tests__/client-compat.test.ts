import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'

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

// ════════════════════════════════════════════════════════════════════════
//  EMAIL-CLIENT COMPATIBILITY SWEEP (Phase 11).
//  Renders every template and fails the build if it ships markup that breaks in
//  Gmail / Outlook (Word engine) / Apple Mail. This LOCKS the current clean
//  state — a future edit that adds a flex layout, a background-image without a
//  fallback, an external stylesheet, a script, or an <img> missing dimensions
//  will fail here instead of shipping a broken email.
// ════════════════════════════════════════════════════════════════════════

const URL = 'https://moveitclearit.com/my-booking/TOKEN'
const common = { customerName: 'Diego', displayId: 'WMIC-1017', locale: 'en' as const, portalUrl: URL }

const all: Array<[string, React.ReactElement]> = [
  ['pre-approval', React.createElement(PreApproval, { ...common, amountHold: '1' })],
  ['final-confirmation', React.createElement(FinalConfirmation, { ...common, amountPaid: '1', date: '2026-08-01T15:00:00Z', timeLabel: '8–10 AM' })],
  ['booking-declined', React.createElement(BookingDeclined, { ...common, amountHold: '1' })],
  ['booking-cancellation', React.createElement(BookingCancellation, { ...common, refundStatus: 'partial', amountCharged: '49', nonRefundable: '20', refundedAmount: '29' })],
  ['booking-updated', React.createElement(BookingUpdated, { ...common, amountHold: '1', changedLabel: 'the date' })],
  ['job-reminder', React.createElement(JobReminder, { ...common, stage: '72_hours' })],
  ['job-completion', React.createElement(JobCompletion, { ...common })],
  ['payment-receipt', React.createElement(PaymentReceipt, { ...common, amountPaid: '1.00', captured: true })],
  ['abandoned-checkout', React.createElement(AbandonedCheckout, { ...common, amountHold: '1' })],
  ['referral', React.createElement(Referral, { ...common })],
  ['review-request', React.createElement(ReviewRequest, { ...common, googleReviewUrl: URL })],
  ['payment-failed', React.createElement(PaymentFailed, { ...common, updatePaymentUrl: URL })],
  ['information-required', React.createElement(InformationRequired, { ...common, missing: ['Exact pickup address'] })],
  ['operational-alert', React.createElement(OperationalAlert, { ...common, alertType: 'reschedule', message: 'Delay.', newDate: '2026-08-02T15:00:00Z' })],
  ['final-invoice', React.createElement(FinalInvoice, { ...common, grandTotal: '480', amountPaid: '1', balanceDue: '479', payUrl: URL })],
  ['referral-reward', React.createElement(ReferralReward, { ...common, rewardLabel: '$25 credit', redeemUrl: URL })],
]

// Patterns Outlook (Word engine) or Gmail silently break on.
const HOSTILE: Array<[RegExp, string]> = [
  [/display:\s*(flex|grid|inline-flex)/i, 'flex/grid layout (Outlook ignores → layout collapses)'],
  [/position:\s*(absolute|fixed|sticky)/i, 'absolute/fixed positioning (unsupported)'],
  [/background-image\s*:|:\s*url\(/i, 'CSS background-image (Outlook needs a VML fallback)'],
  [/<link\b|@import|rel=["']stylesheet/i, 'external stylesheet (stripped by most clients)'],
  [/fonts\.googleapis|@font-face/i, 'remote web font (blocked; use the system stack)'],
  [/<script\b|\son(click|error|load|mouseover)=/i, 'script / inline event handler (stripped; a red flag)'],
]

for (const [name, el] of all) {
  test(`${name}: no client-hostile markup`, async () => {
    const html = await render(el)
    for (const [re, why] of HOSTILE) {
      assert.ok(!re.test(html), `${name} ships ${why}`)
    }
  })

  test(`${name}: every <img> has width, height and alt`, async () => {
    const html = await render(el)
    const imgs = Array.from(html.matchAll(/<img\b[^>]*>/gi)).map((m) => m[0])
    for (const img of imgs) {
      // The open-pixel is injected later by the worker, not by the template.
      assert.match(img, /\swidth=/i, `img missing width in ${name}: ${img.slice(0, 90)}`)
      assert.match(img, /\sheight=/i, `img missing height in ${name}: ${img.slice(0, 90)}`)
      assert.match(img, /\salt=/i, `img missing alt in ${name}: ${img.slice(0, 90)}`)
    }
  })

  test(`${name}: has the email head meta (viewport + apple reformatting guard)`, async () => {
    const html = await render(el)
    assert.match(html, /name=["']viewport["']/i, `${name} missing viewport meta`)
    assert.match(html, /x-apple-disable-message-reformatting/i, `${name} missing apple reformatting guard`)
  })
}
