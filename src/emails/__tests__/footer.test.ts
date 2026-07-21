import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import { Footer, TransactionalFooter, MarketingFooter } from '../_ui'

const base = {
  disclaimer: 'You are receiving this because you have a booking with us.',
  phone: '862-640-0625',
  email: 'hello@moveitclearit.com',
  websiteLabel: 'moveitclearit.com',
}
const UNSUB = 'https://moveitclearit.com/unsubscribe/TOKEN'

const html = (el: React.ReactElement) => render(el)

// ── Transactional: CAN-SPAM exempt — never an unsubscribe row ────────────────
test('transactional footer renders no Unsubscribe link even if a URL is passed', () => {
  const out = html(
    React.createElement(TransactionalFooter, { ...base, unsubscribeUrl: UNSUB, manageUrl: UNSUB }),
  )
  assert.ok(!/Unsubscribe/i.test(out), 'transactional footer must not show Unsubscribe')
  assert.ok(!out.includes(UNSUB), 'transactional footer must not link the unsubscribe URL')
})

test('default Footer kind is transactional', () => {
  const out = html(React.createElement(Footer, { ...base, unsubscribeUrl: UNSUB }))
  assert.ok(!/Unsubscribe/i.test(out))
})

// ── Marketing: unsubscribe required, but only a REAL url — never a placeholder ─
test('marketing footer renders Unsubscribe when a real https URL is supplied', () => {
  const out = html(React.createElement(MarketingFooter, { ...base, unsubscribeUrl: UNSUB }))
  assert.ok(/Unsubscribe/i.test(out), 'marketing footer should show Unsubscribe')
  assert.ok(out.includes(UNSUB))
})

test('marketing footer omits Unsubscribe for a placeholder/booking URL', () => {
  for (const bad of ['#', '', undefined]) {
    const out = html(React.createElement(MarketingFooter, { ...base, unsubscribeUrl: bad as any }))
    assert.ok(!/href="#"/.test(out), `must not ship href="#" for ${JSON.stringify(bad)}`)
    // No real unsubscribe link means the label should not appear as a dead anchor.
    assert.ok(!/<a[^>]*>\s*Unsubscribe/i.test(out), `no dead Unsubscribe anchor for ${JSON.stringify(bad)}`)
  }
})

test('marketing footer prints the postal address when provided', () => {
  const out = html(
    React.createElement(MarketingFooter, { ...base, unsubscribeUrl: UNSUB, postalAddress: '123 Main St, Newark, NJ 07102' }),
  )
  assert.ok(out.includes('123 Main St, Newark, NJ 07102'))
})
