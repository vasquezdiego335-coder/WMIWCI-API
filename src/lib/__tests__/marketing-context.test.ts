// Offline tests for the promotional compliance context (finding EMAIL-P1-06).
process.env.EMAIL_TOKEN_SECRET = 'test-secret-for-marketing-context'
process.env.APP_URL = 'https://app.moveitclearit.com'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import {
  buildMarketingContext,
  applyMarketingContext,
  businessPostalAddress,
  isMarketingContextConfigured,
  promotionalComplianceCheck,
} from '../marketing-context'
import AbandonedCheckout from '../../emails/abandoned-checkout'
import Referral from '../../emails/referral'
import ReviewRequest from '../../emails/review-request'
import QuoteFollowup from '../../emails/quote-followup'

const REAL_ADDRESS = '123 Example Street, Newark, NJ 07102'
const withAddress = <T,>(fn: () => T): T => {
  const saved = process.env.BUSINESS_POSTAL_ADDRESS
  process.env.BUSINESS_POSTAL_ADDRESS = REAL_ADDRESS
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.BUSINESS_POSTAL_ADDRESS
    else process.env.BUSINESS_POSTAL_ADDRESS = saved
  }
}

// ── FAIL CLOSED: no address configured ──────────────────────────────────

test('an unset postal address means promotional mail is NOT configured', () => {
  delete process.env.BUSINESS_POSTAL_ADDRESS
  assert.equal(businessPostalAddress(), null)
  assert.equal(isMarketingContextConfigured(), false)

  const r = buildMarketingContext('a@b.com', 'referral')
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.missing.includes('BUSINESS_POSTAL_ADDRESS'))
})

test('a PLACEHOLDER address is not an address', () => {
  for (const v of ['REPLACE_ME', 'your-address here', 'CHANGE_ME please', 'TODO set this', 'PLACEHOLDER']) {
    process.env.BUSINESS_POSTAL_ADDRESS = v
    assert.equal(businessPostalAddress(), null, v)
  }
  delete process.env.BUSINESS_POSTAL_ADDRESS
})

test('an implausibly short value is rejected', () => {
  process.env.BUSINESS_POSTAL_ADDRESS = 'NJ'
  assert.equal(businessPostalAddress(), null)
  delete process.env.BUSINESS_POSTAL_ADDRESS
})

test('a real address configures the context', () => {
  withAddress(() => {
    assert.equal(businessPostalAddress(), REAL_ADDRESS)
    assert.equal(isMarketingContextConfigured(), true)
    const r = buildMarketingContext('a@b.com', 'referral')
    assert.equal(r.ok, true)
    assert.ok(r.ok && r.context.postalAddress === REAL_ADDRESS)
    assert.ok(r.ok && r.context.unsubscribeUrl.startsWith('https://'))
  })
})

test('the context names EVERY missing piece, not just the first', () => {
  const savedApp = process.env.APP_URL
  delete process.env.APP_URL
  delete process.env.BUSINESS_POSTAL_ADDRESS
  const r = buildMarketingContext('a@b.com', 'referral')
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.missing.length === 2, JSON.stringify(!r.ok && r.missing))
  process.env.APP_URL = savedApp
})

// ── reason for contact ──────────────────────────────────────────────────

test('the reason is SPECIFIC to the template, not a generic line', () => {
  withAddress(() => {
    const abandoned = buildMarketingContext('a@b.com', 'abandoned-checkout')
    const referral = buildMarketingContext('a@b.com', 'referral')
    assert.ok(abandoned.ok && /started a booking/i.test(abandoned.context.reasonForContact))
    assert.ok(referral.ok && /completed a move/i.test(referral.context.reasonForContact))
    assert.notEqual(
      abandoned.ok && abandoned.context.reasonForContact,
      referral.ok && referral.context.reasonForContact
    )
  })
})

test('stage variants inherit their family reason', () => {
  withAddress(() => {
    const a = buildMarketingContext('a@b.com', 'abandoned-checkout')
    const b = buildMarketingContext('a@b.com', 'abandoned-checkout-3')
    const q = buildMarketingContext('a@b.com', 'quote-followup-final')
    assert.equal(a.ok && a.context.reasonForContact, b.ok && b.context.reasonForContact)
    assert.ok(q.ok && /moving quote/i.test(q.context.reasonForContact))
  })
})

test('Spanish gets Spanish', () => {
  withAddress(() => {
    const r = buildMarketingContext('a@b.com', 'referral', 'es')
    assert.ok(r.ok && /Recibes esto/i.test(r.context.reasonForContact))
  })
})

// ── the rendered output actually carries the block ──────────────────────

test('every promotional template renders the full compliance block', () => {
  withAddress(() => {
    const ctx = buildMarketingContext('customer@example.com', 'referral')
    assert.ok(ctx.ok)
    const merged = applyMarketingContext(
      { customerName: 'Diego', displayId: 'X', locale: 'en', portalUrl: 'https://moveitclearit.com/p' },
      ctx.context
    )

    const templates: Array<[string, React.ReactElement]> = [
      ['abandoned-checkout', React.createElement(AbandonedCheckout, { ...merged, amountHold: '1', checkoutUrl: 'https://moveitclearit.com/c' } as never)],
      ['referral', React.createElement(Referral, merged as never)],
      ['review-request', React.createElement(ReviewRequest, { ...merged, googleReviewUrl: 'https://g.page/r/REAL/review' } as never)],
      ['quote-followup', React.createElement(QuoteFollowup, { ...merged, bookingUrl: 'https://moveitclearit.com/b' } as never)],
    ]

    for (const [name, el] of templates) {
      const html = render(el)
      // The physical postal address, verbatim.
      assert.ok(html.includes(REAL_ADDRESS), `${name} is missing the postal address`)
      const check = promotionalComplianceCheck(html)
      assert.deepEqual(check.missing, [], `${name}: ${check.missing.join(', ')}`)
    }
  })
})

test('the same templates render the block in SPANISH too', () => {
  withAddress(() => {
    const ctx = buildMarketingContext('customer@example.com', 'referral', 'es')
    assert.ok(ctx.ok)
    const merged = applyMarketingContext(
      { customerName: 'Diego', displayId: 'X', locale: 'es', portalUrl: 'https://moveitclearit.com/p' },
      ctx.context
    )
    const html = render(React.createElement(Referral, merged as never))
    assert.ok(html.includes(REAL_ADDRESS), 'Spanish referral is missing the postal address')
    assert.deepEqual(promotionalComplianceCheck(html).missing, [])
  })
})

test('WITHOUT the context, the compliance check fails — proving it is not incidental', () => {
  // Rendered with no unsubscribe/postal props: the footer correctly omits the
  // link rather than shipping href="#", and the check reports it missing. This
  // is the state EVERY promotional email was in before this finding was fixed.
  const html = render(
    React.createElement(Referral, {
      customerName: 'Diego',
      displayId: 'X',
      locale: 'en',
      portalUrl: 'https://moveitclearit.com/p',
    } as never)
  )
  const check = promotionalComplianceCheck(html)
  assert.equal(check.ok, false)
  assert.ok(check.missing.includes('visible unsubscribe link'))
  assert.equal(html.includes(REAL_ADDRESS), false)
})

test('applyMarketingContext sets only props the templates declare', () => {
  withAddress(() => {
    const ctx = buildMarketingContext('a@b.com', 'referral')
    assert.ok(ctx.ok)
    const merged = applyMarketingContext({ existing: 1 }, ctx.context)
    assert.equal(merged.existing, 1)
    assert.equal(merged.unsubscribeUrl, ctx.context.unsubscribeUrl)
    assert.equal(merged.postalAddress, REAL_ADDRESS)
    // Dead props must NOT be reintroduced — no template declares these, so
    // passing them would imply a preference link that never renders.
    assert.equal('manageUrl' in merged, false)
    assert.equal('reasonForContact' in merged, false)
  })
})
