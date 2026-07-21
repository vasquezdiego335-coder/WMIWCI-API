import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import BookingCancellation from '../booking-cancellation'

const common = { customerName: 'Diego', displayId: 'WMIC-1', locale: 'en' as const }

test('partial refund renders an itemized breakdown (charged / retained / refunded)', async () => {
  const html = await render(
    React.createElement(BookingCancellation, {
      ...common, refundStatus: 'partial', amountCharged: '49', nonRefundable: '20', refundedAmount: '29',
      refundMethod: 'Visa ending in 4242',
    }),
  )
  assert.ok(html.includes('Refund breakdown'))
  assert.ok(html.includes('$49'), 'shows amount charged')
  assert.ok(html.includes('-$20'), 'shows retained (negative)')
  assert.ok(html.includes('$29'), 'shows refunded amount')
  assert.ok(html.includes('Visa ending in 4242'), 'names the real method, never "Stripe"')
  assert.ok(!/stripe/i.test(html), 'never exposes the processor name')
})

test('partial breakdown hides rows with no value (no invented numbers)', async () => {
  const html = await render(
    React.createElement(BookingCancellation, { ...common, refundStatus: 'partial', refundedAmount: '29' }),
  )
  assert.ok(html.includes('$29'))
  assert.ok(!html.includes('Amount charged'), 'no charged row when amountCharged is absent')
  assert.ok(!html.includes('Retained (policy)'), 'no retained row when nonRefundable is absent')
})

test('released cancellation shows NO refund breakdown', async () => {
  const html = await render(React.createElement(BookingCancellation, { ...common, amount: '49', refundStatus: 'released' }))
  assert.ok(!html.includes('Refund breakdown'))
})
