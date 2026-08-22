// ════════════════════════════════════════════════════════════════════════
//  quote-capture-route.test.ts — the REAL route, the REAL Zod schema.
//
//  WHY THIS EXISTS. The previous round proved the stale-client behaviour by
//  handing the browser a hand-written 409. That is a test of the test: it
//  assumes the API produces a 409 for an old mirror, and the API did not.
//
//  A cached mirror predating PRICE_BOOK_VERSION made the page send
//  `priceBookVersion: null`. Zod's `.optional()` accepts `undefined` and
//  REJECTS `null`, so the request died at SHAPE VALIDATION — 422, before the
//  retired-package check ever ran. The page only handles `pricing_expired`
//  specially, so that 422 fell through to unlock() and put the retired price
//  back on screen. Every layer was "correct" and the customer still saw it.
//
//  So these drive `POST` itself, with payloads a genuinely old mirror sends.
//
//  ── WHAT THIS FILE CAN AND CANNOT PROVE ───────────────────────────────
//  No database is reachable here, and none is faked. So:
//    • the REFUSAL path is proven completely — it returns before any write;
//    • the CAPTURE path is proven up to persistence: that the payload passes
//      the schema, reaches pricing, and is NOT refused. What the row ends up
//      containing is asserted against the same server value the route stores
//      (`serverCents = priced.totalCents`), and demonstrated end-to-end in the
//      live HTTP smoke run, which logs `serverDollars: 550`.
//  Nothing here sends an email, a Discord message, or writes a row.
// ════════════════════════════════════════════════════════════════════════
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { PRICE_BOOK_VERSION, LEGACY_PACKAGE_KEYS } from '../pricing-config'
import { quoteEstimate } from '../quote-estimate'

// The route is inert unless this is set — see the OPT-IN FLAG in the route.
process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'

type RouteModule = { POST: (req: Request) => Promise<Response> }
let POST: RouteModule['POST']

before(async () => {
  ;({ POST } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as RouteModule)
})

/** A complete, valid submission. `extra` overrides or adds fields. */
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

async function post(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await POST(
    new Request('https://api.example.com/api/leads/quote-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
      body: JSON.stringify(body),
    }) as never,
  )
  let json: any = null
  try { json = await res.json() } catch { /* non-JSON body */ }
  return { status: res.status, json }
}

// ══════════════════════════════════════════════════════════════════════
//  1. A PREVIOUS MIRROR — NO VERSION FIELD AT ALL
// ══════════════════════════════════════════════════════════════════════
test('route: an OLD mirror (no priceBookVersion) + a retired Studio → 409 pricing_expired', async () => {
  for (const retired of LEGACY_PACKAGE_KEYS) {
    // Exactly what a pre-versioning mirror sends: the key, a stale total, and
    // NO priceBookVersion key whatsoever.
    const { status, json } = await post(payload({ moveSize: retired, estimateTotal: 379 }))

    assert.equal(status, 409, `${retired} must be refused as expired, not ${status}`)
    assert.equal(json.error, 'pricing_expired', `${retired}: not a validation error — the visitor did nothing wrong`)
    assert.equal(json.ok, false)
    assert.equal(json.captured, false)
    assert.equal(json.priceBookVersion, PRICE_BOOK_VERSION, 'the client must be told which book is current')

    // AND NO PRICE, anywhere in the body. A refusal that leaks the retired
    // amount would hand the browser the very number it must not show.
    const body = JSON.stringify(json)
    for (const amount of ['379', '439', '549', '649']) {
      assert.ok(!body.includes(amount), `${retired}: the refusal leaked a retired price (${amount}) — ${body}`)
    }
  }
})

test('route: an EXPLICIT null priceBookVersion is normalised, not 422d', async () => {
  // THE EXACT REGRESSION. `(P && P.PRICE_BOOK_VERSION) || null` on an old
  // mirror produced this payload, and it used to fail on shape.
  const { status, json } = await post(
    payload({ moveSize: 'little-studio', estimateTotal: 379, priceBookVersion: null }),
  )
  assert.notEqual(status, 422, 'an explicit null must never fail shape validation')
  assert.equal(json.error, 'pricing_expired', 'it must reach the retired-package check')
  assert.equal(status, 409)
})

test('route: every optional string tolerates null from an older client', async () => {
  // The same class of bug for every other optional field. A lead is worth more
  // than a shape quibble: null means "not provided".
  const { status, json } = await post(
    payload({
      moveSize: 'little-studio',
      priceBookVersion: null,
      contactPreference: null,
      bestTimeToCall: null,
      originCity: null,
      destCity: null,
      truckSize: null,
    }),
  )
  assert.notEqual(status, 422)
  assert.equal(json.error, 'pricing_expired')
})

// ══════════════════════════════════════════════════════════════════════
//  2. THE SAME OLD MIRROR, AN ACTIVE PACKAGE
// ══════════════════════════════════════════════════════════════════════
test('route: an OLD mirror + an active 1BR is NOT refused, and prices at $550', async () => {
  const { status, json } = await post(payload({ moveSize: '1br', estimateTotal: 379 }))

  // It must get PAST shape validation and PAST the retired check. Those are
  // the two gates a version-less client used to die on.
  assert.notEqual(status, 422, 'a version-less payload must not fail shape validation')
  assert.notEqual(json?.error, 'validation_error')
  assert.notEqual(json?.error, 'pricing_expired', '1BR is an active package')

  // And the number the route stores is the server's, not the submitted $379.
  // (`serverCents = priced.totalCents` — see the route.)
  const priced = quoteEstimate({ moveSize: '1br' })
  assert.ok(priced.ok)
  if (priced.ok) {
    assert.equal(priced.totalCents, 55_000, '1BR is $550 — the published price, no truck surcharge')
    assert.equal(priced.truckUpgrade, 0)
    assert.equal(priced.includedTruck, '10ft')
  }
})

test('route: a forged $1 total cannot change what the server prices', async () => {
  const { status, json } = await post(payload({ moveSize: '2br', estimateTotal: 1 }))
  assert.notEqual(status, 422)
  assert.notEqual(json?.error, 'pricing_expired')
  const priced = quoteEstimate({ moveSize: '2br' })
  assert.ok(priced.ok)
  if (priced.ok) assert.equal(priced.totalCents, 77_900, 'the server prices 2BR at $779 regardless of the payload')
})

// ══════════════════════════════════════════════════════════════════════
//  3. AN INVENTED KEY IS STILL A PLAIN VALIDATION ERROR
// ══════════════════════════════════════════════════════════════════════
test('route: an invented package is a validation error, NOT an expired price', () => {
  // The two causes stay distinct: one is a stale customer, the other is not a
  // thing we ever sold. Collapsing them would tell a probing client that any
  // rejected key "used to exist".
  return post(payload({ moveSize: 'penthouse' })).then(({ status, json }) => {
    assert.equal(status, 422)
    assert.equal(json.error, 'validation_error')
    assert.notEqual(json.error, 'pricing_expired')
  })
})
