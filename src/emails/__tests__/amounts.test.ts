import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import PreApproval from '../pre-approval'
import BookingDeclined from '../booking-declined'
import BookingUpdated from '../booking-updated'
import AbandonedCheckout from '../abandoned-checkout'
import BookingCancellation from '../booking-cancellation'
import PaymentReceipt from '../payment-receipt'
import FinalConfirmation from '../final-confirmation'
import { money } from '../_ui'

// ════════════════════════════════════════════════════════════════════════
//  Proves a MISSING amount prop can never silently render "$49", in EN + ES,
//  and that a supplied amount renders correctly. (owner spec 2026-07-17)
// ════════════════════════════════════════════════════════════════════════

const AMOUNT_BEARING: Array<[string, React.ComponentType<any>, string]> = [
  ['pre-approval', PreApproval, 'amountHold'],
  ['booking-declined', BookingDeclined, 'amountHold'],
  ['booking-updated', BookingUpdated, 'amountHold'],
  ['abandoned-checkout', AbandonedCheckout, 'amountHold'],
  ['booking-cancellation', BookingCancellation, 'amount'],
  ['payment-receipt', PaymentReceipt, 'amountPaid'],
  ['final-confirmation', FinalConfirmation, 'amountPaid'],
]

test('money(): $X only when supplied, neutral phrase otherwise (never $49)', () => {
  assert.equal(money('1'), '$1')
  assert.equal(money('49'), '$49') // when explicitly the real amount, fine
  assert.equal(money(undefined), 'the amount shown above')
  assert.equal(money(''), 'the amount shown above')
  assert.equal(money(null), 'the amount shown above')
  assert.equal(money(undefined, true), 'el monto indicado arriba')
  assert.ok(!money(undefined).includes('49'))
})

for (const [name, Comp, prop] of AMOUNT_BEARING) {
  for (const locale of ['en', 'es'] as const) {
    test(`${name} (${locale}): MISSING ${prop} never renders $49`, async () => {
      const html = await render(React.createElement(Comp, { locale }))
      assert.ok(!/\$49\b/.test(html), `${name} (${locale}) rendered $49 with no ${prop}`)
    })
    test(`${name} (${locale}): supplied ${prop}='1' renders $1`, async () => {
      const html = await render(React.createElement(Comp, { locale, [prop]: '1' }))
      assert.ok(/\$1\b/.test(html), `${name} (${locale}) did not render the supplied $1`)
    })
  }
}
