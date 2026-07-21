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

// ── APP'S OWN HOST (production incident, 2026-07-21) ────────────────────
// The preview-domain rule blocklisted *.railway.app to stop staging links
// reaching customers. Move It Clear It's PRODUCTION host is a railway.app
// subdomain, so every portalUrl the app generated about ITSELF was rejected and
// assertEmailPayload refused every booking confirmation, receipt and reminder.
// Found by /api/email/health on the first production deploy.

test("a URL on the app's OWN host is accepted even on a preview-style domain", () => {
  const saved = process.env.APP_URL
  process.env.APP_URL = 'https://wonderful-strength-production-a0f1.up.railway.app'
  try {
    assert.equal(
      unsafeUrlReason('https://wonderful-strength-production-a0f1.up.railway.app/my-booking/TOKEN'),
      null
    )
    // The real failure: a portalUrl on the app's own host must not block a send.
    assert.doesNotThrow(() =>
      assertEmailPayload('final-confirmation', {
        displayId: 'WMIC-1',
        date: '2026-08-01T00:00:00Z',
        timeLabel: '8-10 AM',
        amountPaid: '49.00',
        portalUrl: 'https://wonderful-strength-production-a0f1.up.railway.app/my-booking/TOKEN',
      })
    )
  } finally {
    if (saved === undefined) delete process.env.APP_URL
    else process.env.APP_URL = saved
  }
})

test('a DIFFERENT preview host is still rejected — the exemption is host-scoped', () => {
  const saved = process.env.APP_URL
  process.env.APP_URL = 'https://wonderful-strength-production-a0f1.up.railway.app'
  try {
    // Someone else's railway/vercel/ngrok deployment is still a stray link.
    assert.notEqual(unsafeUrlReason('https://someone-else.up.railway.app/x'), null)
    assert.notEqual(unsafeUrlReason('https://preview-abc.vercel.app/x'), null)
    assert.notEqual(unsafeUrlReason('https://tunnel.ngrok-free.app/x'), null)
  } finally {
    if (saved === undefined) delete process.env.APP_URL
    else process.env.APP_URL = saved
  }
})

test('the own-host exemption cannot smuggle an unsafe URL through', () => {
  const saved = process.env.APP_URL
  process.env.APP_URL = 'https://wonderful-strength-production-a0f1.up.railway.app'
  try {
    // Every other rule still applies to the app's own host.
    assert.notEqual(unsafeUrlReason('http://wonderful-strength-production-a0f1.up.railway.app/x'), null)
    assert.notEqual(unsafeUrlReason('javascript:alert(1)'), null)
    assert.notEqual(unsafeUrlReason('data:text/html,x'), null)
    assert.notEqual(unsafeUrlReason('#'), null)
    assert.notEqual(
      unsafeUrlReason('https://wonderful-strength-production-a0f1.up.railway.app/REPLACE_WITH_X'),
      null
    )
  } finally {
    if (saved === undefined) delete process.env.APP_URL
    else process.env.APP_URL = saved
  }
})

test('with APP_URL unset, preview domains are rejected as before', () => {
  const saved = process.env.APP_URL
  delete process.env.APP_URL
  try {
    assert.notEqual(unsafeUrlReason('https://anything.up.railway.app/x'), null)
  } finally {
    if (saved !== undefined) process.env.APP_URL = saved
  }
})
