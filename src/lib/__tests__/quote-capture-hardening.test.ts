// ════════════════════════════════════════════════════════════════════════
//  quote-capture-hardening.test.ts — three route-level defects, each of which
//  let a request reach a state the surrounding code assumed was impossible.
//
//   5 · PERSISTENCE FAILURE ANSWERED HTTP 200. An outage was indistinguishable
//       from a success to every proxy, uptime check and log aggregator, and the
//       browser was left to infer failure from a body field — with no server
//       estimate to display, so its only fallback was its own mirror. That
//       fallback is what put a retired $379 on screen.
//
//   6 · `quoteMode: 'in_person'` SKIPPED PRICING ENTIRELY. The route read
//       `const priced = inPerson ? { manual_plan } : quoteEstimate(…)`, so a
//       withdrawn Studio, an invented package and an unsupported truck all
//       bypassed the refusals and were written as in-person plans. Asking for
//       a visit is a statement about HOW a price is set — never a way around
//       the gate the 2026-08-22 incident was about.
//
//   7 · THE PARTIAL-ROUTE HONEYPOT WAS UNREACHABLE. `company: z.string().max(0)`
//       meant a filled value failed the schema, so the request returned from
//       the parse guard as `invalid_shape` and the honeypot branch never ran.
//
//  Everything here drives the REAL route handlers through the dependency seam.
//  No database, no network, no email, no Discord.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PRICE_BOOK_VERSION, LEGACY_PACKAGE_KEYS } from '../pricing-config'
import { __setQuoteCaptureRouteDeps } from '../quote-capture-deps'
import type { PartialLeadInput } from '../leads'

type RouteModule = { POST: (req: Request) => Promise<Response> }
let POST_QUOTE: RouteModule['POST']
let POST_PARTIAL: RouteModule['POST']

before(async () => {
  ;({ POST: POST_QUOTE } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as RouteModule)
  ;({ POST: POST_PARTIAL } = (await import('../../../app/api/leads/partial/route')) as unknown as RouteModule)
})

type Recorder = { captured: PartialLeadInput[]; partial: PartialLeadInput[]; sideEffects: string[] }
let rec: Recorder
let restore: () => void
/** When true the persistence seam reports failure the way the real one does:
 *  capturePartialLeadSafe swallows the error and returns null. */
let persistenceFails = false

beforeEach(() => {
  rec = { captured: [], partial: [], sideEffects: [] }
  persistenceFails = false
  restore = __setQuoteCaptureRouteDeps({
    async capture(input) {
      if (persistenceFails) return null
      rec.captured.push(input as PartialLeadInput)
      return { lead: { id: 'lead_test', status: 'NEW' as never }, isNew: true }
    },
    async partialCapture(input) {
      if (persistenceFails) return null
      rec.partial.push(input as PartialLeadInput)
      return { lead: { id: 'lead_partial', status: 'NEW' as never }, isNew: true }
    },
    async onCaptured(leadId) {
      rec.sideEffects.push(leadId)
      return { emailStatus: 'queued', notificationStatus: 'queued' }
    },
  })
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
  process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED = 'true'
})

afterEach(() => {
  restore()
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
  process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED = 'true'
})

async function post(handler: RouteModule['POST'], path: string, body: Record<string, unknown>) {
  const res = await handler(
    new Request(`https://api.example.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
      body: JSON.stringify(body),
    }) as never,
  )
  let json: any = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json }
}

function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  return {
    firstName: 'Test',
    lastName: 'Fixture',
    phone: '8625550000',
    email: 'fixture@example.com',
    moveDate: soon,
    pickupZip: '08817',
    destinationZip: '07030',
    ...extra,
  }
}

// ══════════════════════════════════════════════════════════════════════
//  5. PRICED, THEN NOT SAVED
// ══════════════════════════════════════════════════════════════════════
test('route: a persistence failure is 503, never 200', async () => {
  persistenceFails = true
  const r = await post(POST_QUOTE, '/api/leads/quote-capture', payload({ moveSize: '2br' }))

  assert.equal(r.status, 503, 'an outage must not answer with a success status')
  assert.notEqual(r.status, 200, 'HTTP 200 makes an outage invisible to every monitor')
  assert.equal(r.json.ok, false)
  assert.equal(r.json.captured, false)
  assert.equal(r.json.error, 'server_error')
})

test('route: the 503 still carries the authoritative estimate and review state', async () => {
  // Without this the browser has no server number to show, and its only
  // fallback is its own mirror — the exact path that displayed a retired price.
  persistenceFails = true
  const r = await post(POST_QUOTE, '/api/leads/quote-capture', payload({ moveSize: '2br' }))

  assert.equal(r.json.priceBookVersion, PRICE_BOOK_VERSION)
  assert.ok(r.json.estimate, 'the already-computed estimate must be returned')
  assert.equal(r.json.estimate.totalDollars, 779, 'and it must be the SERVER price')
  assert.equal(r.json.estimate.truckUpgrade, 0, 'the included truck is never charged')
  assert.equal(r.json.manualReview, false)
  assert.deepEqual(r.json.reviewReasons, [])
})

test('route: a 503 on a REVIEW-GATED package carries the review state too', async () => {
  persistenceFails = true
  const r = await post(POST_QUOTE, '/api/leads/quote-capture', payload({ moveSize: '3br' }))

  assert.equal(r.status, 503)
  assert.equal(r.json.estimate.totalDollars, 1049)
  assert.equal(r.json.manualReview, true, '3BR is review-gated whether or not we saved it')
  assert.ok(r.json.reviewReasons.length > 0, 'and the reason travels with it')
})

test('route: a 503 on a HAND-QUOTED move returns estimate null, not a number', async () => {
  // 5BR has no automatic price. "No number" and "a number we withheld" are
  // different states and the response must not blur them.
  persistenceFails = true
  const r = await post(POST_QUOTE, '/api/leads/quote-capture', payload({ moveSize: '5br' }))

  assert.equal(r.status, 503)
  assert.equal(r.json.estimate, null, 'there is genuinely no automatic price for 5BR')
  assert.equal(r.json.manualReview, true)
  const asText = JSON.stringify(r.json)
  assert.ok(!asText.includes('1799'), 'the 5BR starting figure must never appear in the response')
})

test('route: a persistence failure never echoes the browser total', async () => {
  persistenceFails = true
  const r = await post(
    POST_QUOTE,
    '/api/leads/quote-capture',
    payload({ moveSize: '2br', estimateTotal: 99_999 }),
  )
  const asText = JSON.stringify(r.json)
  assert.ok(!asText.includes('99999'), 'the browser figure must not travel back out')
  assert.equal(r.json.estimate.totalDollars, 779, 'only the server price is returned')
})

// ══════════════════════════════════════════════════════════════════════
//  6. VALIDATE BEFORE APPLYING in_person
// ══════════════════════════════════════════════════════════════════════
for (const retired of LEGACY_PACKAGE_KEYS) {
  test(`route: in-person mode does NOT smuggle retired package ${retired} past the gate`, async () => {
    const r = await post(
      POST_QUOTE,
      '/api/leads/quote-capture',
      payload({ moveSize: retired, quoteMode: 'in_person' }),
    )
    assert.equal(r.status, 409, 'a withdrawn package is refused in every mode')
    assert.equal(r.json.error, 'pricing_expired')
    assert.equal(rec.captured.length, 0, 'and NOTHING is written')
    const asText = JSON.stringify(r.json)
    for (const amount of ['379', '439', '549']) {
      assert.ok(!asText.includes(amount), `the retired price $${amount} must not be echoed`)
    }
  })
}

test('route: in-person mode does NOT accept an invented package', async () => {
  const r = await post(
    POST_QUOTE,
    '/api/leads/quote-capture',
    payload({ moveSize: 'penthouse-mansion', quoteMode: 'in_person' }),
  )
  assert.equal(r.status, 422, 'a package we do not sell is a validation failure')
  assert.equal(r.json.error, 'validation_error')
  assert.deepEqual(r.json.fields, ['moveSize'])
  assert.equal(rec.captured.length, 0, 'and NOTHING is written')
})

test('route: in-person mode does NOT accept an unsupported truck', async () => {
  const r = await post(
    POST_QUOTE,
    '/api/leads/quote-capture',
    payload({ moveSize: '2br', truckSize: '53ft', quoteMode: 'in_person' }),
  )
  assert.equal(r.status, 422)
  assert.deepEqual(r.json.fields, ['truckSize'])
  assert.equal(rec.captured.length, 0, 'and NOTHING is written')
})

test('route: an ACTIVE package in in-person mode still becomes a manual plan', async () => {
  // The other half: validation must not break the feature it now runs before.
  const r = await post(
    POST_QUOTE,
    '/api/leads/quote-capture',
    payload({ moveSize: '2br', quoteMode: 'in_person' }),
  )
  assert.equal(r.status, 200)
  assert.equal(r.json.captured, true, 'the lead is still captured')
  assert.equal(r.json.estimate, null, 'an in-person request is deliberately not auto-priced')
  assert.equal(r.json.manualReview, true)
  assert.ok(r.json.reviewReasons.length > 0, 'and says why')
  const asText = JSON.stringify(r.json)
  assert.ok(!asText.includes('779'), 'a price the customer asked us not to guess must not appear')
})

// ══════════════════════════════════════════════════════════════════════
//  7. THE PARTIAL HONEYPOT IS REACHABLE
// ══════════════════════════════════════════════════════════════════════
test('partial route: a filled honeypot is reported AS a honeypot, and writes nothing', async () => {
  const r = await post(POST_PARTIAL, '/api/leads/partial', {
    email: 'bot@example.com',
    phone: '8625550000',
    company: 'Acme Spam Co',
    serviceTypeKey: 'full_service',
    moveSize: '2br',
  })

  assert.equal(r.status, 200, 'a bot learns nothing from a status code')
  assert.equal(r.json.ok, true, 'and nothing from the shape either')
  assert.equal(
    r.json.skipped,
    'honeypot',
    'the trap must own this decision. `invalid_shape` means the schema rejected ' +
      'the value first and the honeypot branch never ran — which was dead code.',
  )
  assert.equal(rec.partial.length, 0, 'nothing is persisted')
})

test('partial route: an EMPTY company is not a honeypot hit', async () => {
  const r = await post(POST_PARTIAL, '/api/leads/partial', {
    email: 'human@example.com',
    phone: '8625550000',
    company: '',
    serviceTypeKey: 'full_service',
    moveSize: '2br',
  })
  assert.notEqual(r.json.skipped, 'honeypot', 'humans leave the hidden field empty')
  assert.equal(rec.partial.length, 1, 'a real submission is still captured')
})

test('partial route: a WHITESPACE-only company is not a honeypot hit', async () => {
  // Autofill and some keyboards leave a stray space. Treating that as a bot
  // would silently drop a real lead.
  const r = await post(POST_PARTIAL, '/api/leads/partial', {
    email: 'human2@example.com',
    phone: '8625550000',
    company: '   ',
    serviceTypeKey: 'full_service',
    moveSize: '2br',
  })
  assert.notEqual(r.json.skipped, 'honeypot')
  assert.equal(rec.partial.length, 1, 'a real submission is still captured')
})

test('partial route: an over-long honeypot value is rejected, not absorbed', async () => {
  // The field is bounded so an unbounded string is not free memory.
  const r = await post(POST_PARTIAL, '/api/leads/partial', {
    email: 'bot2@example.com',
    phone: '8625550000',
    company: 'x'.repeat(5_000),
    serviceTypeKey: 'full_service',
    moveSize: '2br',
  })
  assert.equal(r.json.ok, true, 'still a generic answer')
  assert.equal(rec.partial.length, 0, 'and still nothing written')
})
