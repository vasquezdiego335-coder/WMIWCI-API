// HTML-injection + URL-safety tests for customer-controlled text (EMAIL-P1-13).
//
// The reschedule-request email used to be built by interpolating customer-
// supplied values straight into an HTML string in
// src/outbox/services/emailService.ts:
//
//     `<p>Hi ${p.customerName},</p> … <a href="${p.rescheduleUrl}">`
//
// Customer names come from a public booking form, so markup in a name was
// injected verbatim, and the URL was never validated — a `javascript:` link
// would have shipped as clickable. These tests lock the replacement behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import OperationalAlert from '../operational-alert'
import PreApproval from '../pre-approval'
import FinalConfirmation from '../final-confirmation'
import { assertEmailPayload, unsafeUrlReason } from '../validation'

const SAFE_URL = 'https://moveitclearit.com/my-booking/TOKEN'

const HOSTILE_NAMES = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '<b>Diego</b>',
  "'; DROP TABLE customers;--",
  '<a href="https://evil.example">click</a>',
]

test('markup in a customer name is ESCAPED, never rendered as live HTML', () => {
  for (const name of HOSTILE_NAMES) {
    const html = render(
      React.createElement(OperationalAlert, {
        customerName: name,
        displayId: 'WMIC-1',
        alertType: 'reschedule',
        message: 'That date was not available.',
        portalUrl: SAFE_URL,
        locale: 'en',
      })
    )
    // The security property is that no TAG FORMS — not that the substring is
    // absent. React escapes `<`, `>` and `"`, so the payload survives as inert
    // text (`&lt;img src=x onerror=alert(1)&gt;`), which is correct and safe.
    // Asserting on the bare substring `onerror=` would fail on that harmless
    // escaped text; assert on real markup instead.
    assert.equal(/<script/i.test(html), false, `script tag formed for: ${name}`)
    assert.equal(/<img[^>]*onerror/i.test(html), false, `img+handler tag formed for: ${name}`)
    assert.equal(/<a[^>]+href=["']?https?:\/\/evil\.example/i.test(html), false, `injected anchor for: ${name}`)
    assert.equal(/<b>Diego<\/b>/i.test(html), false, `raw bold tag survived for: ${name}`)
  }
})

test('a hostile name appears in the output ESCAPED — proof it was treated as text', () => {
  const html = render(
    React.createElement(OperationalAlert, {
      customerName: '<script>alert(1)</script>',
      alertType: 'reschedule',
      message: 'm',
      portalUrl: SAFE_URL,
      locale: 'en',
    })
  )
  assert.match(html, /&lt;script&gt;/i, 'the tag must appear escaped, not stripped and not live')
})

test('markup inside the operational MESSAGE is escaped too', () => {
  // The reschedule renderer folds the offered dates into `message`, so this is
  // the field that now carries semi-structured text.
  const html = render(
    React.createElement(OperationalAlert, {
      customerName: 'Diego',
      alertType: 'reschedule',
      message: 'These dates work: <script>alert(1)</script> · <b>Friday</b>',
      portalUrl: SAFE_URL,
      locale: 'en',
    })
  )
  assert.equal(/<script/i.test(html), false)
  assert.match(html, /&lt;script&gt;/i, 'the tag should appear escaped, proving it was rendered as text')
})

test('hostile names are escaped in the booking templates too', () => {
  for (const name of HOSTILE_NAMES) {
    const html = render(
      React.createElement(PreApproval, { customerName: name, displayId: 'X', portalUrl: SAFE_URL, amountHold: '1', locale: 'en' })
    )
    assert.equal(/<script/i.test(html), false, name)
    assert.equal(/<img[^>]*onerror/i.test(html), false, name)
  }
})

// ── URL safety: the second half of P1-13 ────────────────────────────────

test('unsafe URL schemes are rejected by the shared validator', () => {
  for (const url of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    '',
    '#',
    'http://moveitclearit.com/insecure',
    'https://localhost:3000/x',
    'https://127.0.0.1/x',
    'https://preview-abc.vercel.app/x',
    'https://tunnel.ngrok-free.app/x',
  ]) {
    assert.notEqual(unsafeUrlReason(url), null, `should be rejected: ${url}`)
  }
})

test('a genuine production URL passes', () => {
  assert.equal(unsafeUrlReason(SAFE_URL), null)
  assert.equal(unsafeUrlReason('https://www.moveitclearit.com/booking-form.html'), null)
})

test('the send gate blocks a payload carrying an unsafe action URL', () => {
  // This is what actually protects production: any *Url key in the payload is
  // URL-checked before the provider call.
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '#', 'http://x.com']) {
    assert.throws(
      () =>
        assertEmailPayload('final-confirmation', {
          displayId: 'X',
          date: '2026-08-01T00:00:00Z',
          timeLabel: '8–10 AM',
          amountPaid: '1.00',
          portalUrl: bad,
        }),
      (err: Error) => err.name === 'EmailValidationError',
      `should block: ${bad}`
    )
  }
})

test('a valid final-confirmation payload is accepted', () => {
  assert.doesNotThrow(() =>
    assertEmailPayload('final-confirmation', {
      displayId: 'WMIC-1017',
      date: '2026-08-01T00:00:00Z',
      timeLabel: '8–10 AM',
      amountPaid: '49.50',
      portalUrl: SAFE_URL,
    })
  )
})

test('the status gate rejects a final-confirmation payload carrying a pending status', () => {
  for (const status of ['DRAFT', 'PENDING_PAYMENT', 'PENDING_APPROVAL', 'CANCELLED', 'ARCHIVED']) {
    assert.throws(
      () =>
        assertEmailPayload('final-confirmation', {
          displayId: 'X',
          date: '2026-08-01T00:00:00Z',
          timeLabel: '8–10 AM',
          amountPaid: '1.00',
          portalUrl: SAFE_URL,
          bookingStatus: status,
        }),
      (err: Error) => err.name === 'EmailValidationError',
      status
    )
  }
})

test('rendered confirmation output contains no unresolved template tokens', () => {
  const html = render(
    React.createElement(FinalConfirmation, {
      customerName: 'Diego',
      displayId: 'WMIC-1017',
      date: '2026-08-01T15:00:00Z',
      timeLabel: '8–10 AM',
      amountPaid: '49.50',
      portalUrl: SAFE_URL,
      locale: 'en',
    })
  )
  for (const token of ['{{', '}}', 'undefined', 'REPLACE_WITH', 'NaN', '[object Object]']) {
    assert.equal(html.includes(token), false, `rendered output contains ${token}`)
  }
})
