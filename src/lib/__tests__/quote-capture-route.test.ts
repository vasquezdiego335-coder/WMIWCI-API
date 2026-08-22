// ════════════════════════════════════════════════════════════════════════
//  quote-capture-route.test.ts — the REAL route, the REAL Zod schema, and the
//  EXACT input it hands to persistence.
//
//  WHY IT LOOKS LIKE THIS NOW. The previous round called the real route with
//  no database, watched persistence fail, and then asserted `quoteEstimate()`
//  separately — describing that as "captured at $550". It was not: nothing was
//  captured, and the two halves were never connected. The route now resolves
//  persistence through `quote-capture-deps`, so these tests install a recording
//  store, drive the real handler, and read the actual object the route stored.
//
//  Nothing here opens a socket. No database, no Redis, no Discord, no email.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PRICE_BOOK_VERSION, LEGACY_PACKAGE_KEYS } from '../pricing-config'
import { __setQuoteCaptureRouteDeps } from '../quote-capture-deps'
import type { PartialLeadInput } from '../leads'

type RouteModule = { POST: (req: Request) => Promise<Response> }
let POST: RouteModule['POST']

before(async () => {
  ;({ POST } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as RouteModule)
})

/** Everything the route handed to persistence and to the side effects. */
type Recorder = { captured: PartialLeadInput[]; sideEffects: string[] }
let rec: Recorder
let restore: () => void

beforeEach(() => {
  rec = { captured: [], sideEffects: [] }
  restore = __setQuoteCaptureRouteDeps({
    async capture(input) {
      rec.captured.push(input as PartialLeadInput)
      return { lead: { id: 'lead_test', status: 'NEW' as never }, isNew: true }
    },
    async onCaptured(leadId) {
      rec.sideEffects.push(leadId)
      return { emailStatus: 'queued', notificationStatus: 'queued' }
    },
  })
  // Default: capture ENABLED. Individual tests override.
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
})

afterEach(() => {
  restore()
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
})

/** A complete, valid submission from a PREVIOUS mirror: no priceBookVersion. */
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

export async function postQuote(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
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

const FLAG_STATES: Array<[label: string, apply: () => void]> = [
  ['flag TRUE', () => { process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true' }],
  ['flag FALSE', () => { process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'false' }],
  ['flag UNSET', () => { delete process.env.QUOTE_LEAD_CAPTURE_ENABLED }],
]

// ══════════════════════════════════════════════════════════════════════
//  1. RETIRED PRICING IS REFUSED IN EVERY CONFIGURATION OF THE FLAG
// ══════════════════════════════════════════════════════════════════════
test('route: a retired Studio is 409 pricing_expired with the flag true, false OR unset', async () => {
  // THE HOLE THIS CLOSES. `if (!enabled()) return 200` was the FIRST line of
  // the handler, before parsing and pricing. With the flag at its default —
  // unset — a cached bundle submitting a withdrawn Studio got a bare 200, the
  // page saw no `pricing_expired`, and unlocked showing the retired price from
  // its own stale mirror. A flag meaning "do not write leads yet" had quietly
  // become "do not enforce pricing either".
  for (const [label, apply] of FLAG_STATES) {
    for (const retired of LEGACY_PACKAGE_KEYS) {
      apply()
      const { status, json } = await postQuote(payload({ moveSize: retired, estimateTotal: 379 }))
      assert.equal(status, 409, `${label} / ${retired}: expected 409, got ${status}`)
      assert.equal(json.error, 'pricing_expired', `${label} / ${retired}`)
      assert.equal(json.priceBookVersion, PRICE_BOOK_VERSION, `${label} / ${retired}`)

      // NO retired amount may appear anywhere in the body.
      const body = JSON.stringify(json)
      for (const amount of ['379', '439', '549', '649']) {
        assert.ok(!body.includes(amount), `${label} / ${retired}: refusal leaked $${amount} — ${body}`)
      }
      // And nothing was written, in any flag state.
      assert.deepEqual(rec.captured, [], `${label} / ${retired}: a refused quote must persist nothing`)
    }
  }
})

test('route: an explicit null priceBookVersion still reaches the retired check', async () => {
  for (const [label, apply] of FLAG_STATES) {
    apply()
    const { status, json } = await postQuote(
      payload({ moveSize: 'little-studio', estimateTotal: 379, priceBookVersion: null }),
    )
    assert.notEqual(status, 422, `${label}: an explicit null must not fail shape validation`)
    assert.equal(status, 409, label)
    assert.equal(json.error, 'pricing_expired', label)
  }
})

test('route: with capture DISABLED an active package is priced but never stored', async () => {
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'false'
  const { status, json } = await postQuote(payload({ moveSize: '1br', estimateTotal: 1 }))
  assert.equal(status, 200)
  assert.equal(json.captured, false, 'the flag still means "do not write"')
  assert.equal(json.reason, 'feature_disabled')
  assert.deepEqual(rec.captured, [], 'nothing may be persisted while capture is disabled')
  // But the customer gets the SERVER's price, not whatever their mirror says.
  assert.equal(json.estimate.totalDollars, 550)
  assert.equal(json.priceBookVersion, PRICE_BOOK_VERSION)
})

// ══════════════════════════════════════════════════════════════════════
//  2. AN ACTIVE PACKAGE IS ACTUALLY CAPTURED, AT THE SERVER'S PRICE
// ══════════════════════════════════════════════════════════════════════
test('route: an OLD mirror + active 1BR is CAPTURED at 55000, snapshot and all', async () => {
  const { status, json } = await postQuote(payload({ moveSize: '1br', estimateTotal: 379 }))
  assert.equal(status, 200)
  assert.equal(json.captured, true, 'the lead must actually be captured')

  assert.equal(rec.captured.length, 1, 'exactly one persistence call')
  const stored = rec.captured[0]
  assert.equal(stored.estimatedValue, 55_000, 'the stored figure is the SERVER total')
  assert.equal(stored.estimateAuthoritative, true)
  assert.equal(stored.moveSize, '1br')
  assert.ok(stored.quoteSnapshot, 'a numeric quote must persist a snapshot')
  assert.equal(stored.quoteSnapshot?.totalCents, 55_000)
  assert.equal(stored.quoteSnapshot?.baseCents, 55_000)
  assert.equal(stored.quoteSnapshot?.truckCents, 0, 'the included 10ft truck adds nothing')
  assert.equal(stored.quoteSnapshot?.includedTruck, '10ft')
  assert.equal(stored.quoteSnapshot?.mileageStatus, 'pending')
  assert.equal(stored.quoteSnapshot?.priceBookVersion, PRICE_BOOK_VERSION)
  assert.equal(stored.quoteSnapshot?.requiresReview, false)
  // And the side effects ran for the real lead id.
  assert.deepEqual(rec.sideEffects, ['lead_test'])
})

test('route: a forged $1 is discarded — the SERVER total is what gets stored', async () => {
  await postQuote(payload({ moveSize: '2br', estimateTotal: 1 }))
  const stored = rec.captured[0]
  assert.equal(stored.estimatedValue, 77_900, '2BR is $779 and the browser does not get a vote')
  assert.notEqual(stored.estimatedValue, 100)
  assert.equal(stored.quoteSnapshot?.totalCents, 77_900)
  assert.equal(stored.quoteSnapshot?.truckCents, 0, 'no surcharge for the included 15ft truck')
  assert.equal(stored.quoteSnapshot?.includedTruck, '15ft')
})

// ══════════════════════════════════════════════════════════════════════
//  3. REVIEW STATE IS RETURNED **AND** PERSISTED
// ══════════════════════════════════════════════════════════════════════
test('route: 3BR and 4BR are returned AND stored as needing review', async () => {
  for (const [key, total] of [['3br', 104_900], ['4br', 144_900]] as const) {
    rec.captured = []
    const { json } = await postQuote(payload({ moveSize: key }))

    // `manualReview: inPerson || manualPlan` returned FALSE for these — the
    // server had decided a human must look and the response said otherwise.
    assert.equal(json.manualReview, true, `${key}: the response must say it needs review`)
    assert.ok(json.reviewReasons.length > 0, `${key}: and say why`)
    assert.equal(json.estimate.requiresReview, true, `${key}: inside the estimate too`)
    assert.ok(json.estimate.reviewReasons.length > 0)
    assert.equal(json.estimate.isStarting, true, `${key} is a floor, not a flat rate`)

    const stored = rec.captured[0]
    assert.equal(stored.quoteSnapshot?.totalCents, total, `${key} total`)
    assert.equal(stored.quoteSnapshot?.requiresReview, true, `${key}: persisted review flag`)
    assert.ok(
      (stored.quoteSnapshot?.reviewReasons ?? []).length > 0,
      `${key}: persisted reasons — a flag with no reason tells the owner nothing`,
    )
  }
})

test('route: an explicit larger truck is returned and stored as needing review', async () => {
  const { json } = await postQuote(payload({ moveSize: '2br', truckSize: '26ft' }))
  assert.equal(json.manualReview, true, 'an upgrade is APPROVED, never automatic')
  assert.match(json.reviewReasons.join(' '), /larger truck/i)
  assert.equal(json.estimate.truckUpgrade, 150, 'the 26ft fee, charged once')
  assert.equal(json.estimate.totalDollars, 779 + 150)

  const stored = rec.captured[0]
  assert.equal(stored.quoteSnapshot?.requiresReview, true)
  assert.equal(stored.quoteSnapshot?.truckCents, 15_000)
})

test('route: 5BR is a manual plan — review persisted WITHOUT inventing a total', async () => {
  const { json } = await postQuote(payload({ moveSize: '5br' }))
  assert.equal(json.captured, true, 'the lead is still worth saving')
  assert.equal(json.estimate, null, 'no automatic number for a job that may need several trucks')
  assert.equal(json.manualReview, true)
  assert.ok(json.reviewReasons.length > 0)

  const stored = rec.captured[0]
  assert.equal(stored.estimatedValue, null, 'no total may be invented')
  assert.equal(stored.quoteSnapshot ?? null, null, 'and no numeric snapshot')
  assert.ok(
    (stored.reviewReasonsOnly ?? []).length > 0,
    'but the review reasons are still persisted — review state used to live only ' +
      'inside the snapshot, so exactly the leads needing a human recorded none',
  )
})

test('route: an in-person request persists review reasons and no number', async () => {
  const { json } = await postQuote(payload({ moveSize: '2br', quoteMode: 'in_person' }))
  assert.equal(json.manualReview, true)
  assert.equal(json.estimate, null, 'the customer declined an automatic price')
  const stored = rec.captured[0]
  assert.equal(stored.estimatedValue, null)
  assert.ok((stored.reviewReasonsOnly ?? []).length > 0)
})

test('route: 1BR and 2BR are NOT flagged for review', async () => {
  for (const key of ['1br', '2br']) {
    rec.captured = []
    const { json } = await postQuote(payload({ moveSize: key }))
    assert.equal(json.manualReview, false, `${key} is a settled flat price`)
    assert.deepEqual(json.reviewReasons, [], key)
    assert.equal(json.estimate.requiresReview, false, key)
    assert.equal(rec.captured[0].quoteSnapshot?.requiresReview, false, key)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  4. EVERY RESPONSE VARIANT CARRIES THE PRICE-BOOK VERSION
// ══════════════════════════════════════════════════════════════════════
test('route: priceBookVersion is present on every response variant', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['captured', payload({ moveSize: '1br' })],
    ['manual plan (no estimate)', payload({ moveSize: '5br' })],
    ['in person (no estimate)', payload({ moveSize: '2br', quoteMode: 'in_person' })],
    ['retired', payload({ moveSize: 'little-studio' })],
    ['honeypot', payload({ moveSize: '1br', company: 'bot' })],
  ]
  for (const [label, body] of cases) {
    const { json } = await postQuote(body)
    assert.equal(json.priceBookVersion, PRICE_BOOK_VERSION, `${label}: missing priceBookVersion`)
  }
  // ...and with capture disabled.
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'false'
  const { json } = await postQuote(payload({ moveSize: '1br' }))
  assert.equal(json.priceBookVersion, PRICE_BOOK_VERSION, 'feature_disabled: missing priceBookVersion')
})

test('route: an invented package is a validation error, NOT an expired price', async () => {
  const { status, json } = await postQuote(payload({ moveSize: 'penthouse' }))
  assert.equal(status, 422)
  assert.equal(json.error, 'validation_error')
  assert.deepEqual(rec.captured, [])
})

// ══════════════════════════════════════════════════════════════════════
//  5. THE TEST SEAM IS A TEST SEAM
// ══════════════════════════════════════════════════════════════════════
test('route: the dependency seam is never called from production code', async () => {
  // A seam that a route, worker or script could call would be a configuration
  // hook, and this suite would stop describing production.
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root = resolve(__dirname, '../../..')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', '.git', '__tests__'].includes(name)) continue
      const full = resolve(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name) && !/quote-capture-deps\.ts$/.test(name)) {
        if (readFileSync(full, 'utf8').includes('__setQuoteCaptureRouteDeps')) {
          offenders.push(full.slice(root.length + 1))
        }
      }
    }
  }
  for (const d of ['src', 'app', 'scripts']) {
    try { walk(resolve(root, d)) } catch { /* absent */ }
  }
  assert.deepEqual(offenders, [], 'the test-only seam is referenced from production code')
})
