import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ════════════════════════════════════════════════════════════════════════
//  ABANDONED-CHECKOUT CONTINUATION LINK (link audit 2026-07-25).
//
//  All three abandoned-checkout recovery emails pointed at
//  `${APP_URL}/api/stripe/checkout?resume=<id>` — a route that DID NOT EXIST
//  (app/api/stripe/checkout contained only cancel/ and success/, and nothing
//  handled a `resume` param). Every "finish your booking" button was a 404.
//  Confirmed against production with a real PENDING_PAYMENT booking id.
//
//  These tests pin the route AND — more importantly — the money guards, so a
//  refactor cannot turn a recovery link into a way to charge someone twice.
// ════════════════════════════════════════════════════════════════════════

const ROUTE = resolve(__dirname, '../../../app/api/stripe/checkout/resume/route.ts')
const src = () => readFileSync(ROUTE, 'utf8')

test('the resume route exists and handles GET (it is an email link target)', () => {
  assert.ok(existsSync(ROUTE), 'app/api/stripe/checkout/resume/route.ts must exist')
  assert.ok(/export\s+async\s+function\s+GET\s*\(/.test(src()), 'must export a GET handler')
})

test('DOUBLE-CHARGE GUARD: a paid or advanced booking never gets a new session', () => {
  const s = src()
  // depositPaid must be checked, and PENDING_PAYMENT must be required.
  assert.ok(s.includes('depositPaid'), 'must inspect depositPaid')
  assert.ok(s.includes("'PENDING_PAYMENT'"), 'must require PENDING_PAYMENT')
  // The refusal must happen BEFORE any session is created.
  const guardIdx = s.indexOf('depositPaid ||')
  const createIdx = s.indexOf('createBookingCheckout(')
  assert.ok(guardIdx > -1, 'must refuse on depositPaid')
  assert.ok(createIdx > -1, 'must create a checkout session')
  assert.ok(guardIdx < createIdx, 'the double-charge guard must precede session creation')
})

test('internal test bookings are refused', () => {
  assert.ok(src().includes('isInternalTest'), 'must refuse internal test bookings')
})

/** Source with `//` comments removed — so a rule about CODE is not satisfied or
 *  broken by prose that merely mentions the same identifier. */
function code(): string {
  return src()
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

test('it never captures funds — authorization only (inherited manual capture)', () => {
  // The route must not set its own capture behaviour; createBookingCheckout owns
  // capture_method: 'manual'. A route that captured here would take money before
  // an owner ever approved the job. Checked against CODE, not comments.
  assert.ok(!/capture_method/.test(code()), 'the resume route must not override capture behaviour')
})

test('failures redirect instead of showing an error to an email clicker', () => {
  const s = src()
  assert.ok(s.includes('fallbackUrl'), 'must have a fallback destination')
  assert.ok(/catch\s*\(/.test(s), 'must catch errors')
  assert.ok(s.includes('NextResponse.redirect'), 'must redirect rather than render an error')
})

test('it is rate limited', () => {
  assert.ok(/rateLimit\(/.test(src()), 'must be rate limited')
})

test('BOTH email producers now point at the real route', () => {
  for (const f of ['../../workers/scheduled.worker.ts', '../email-recipient-context.ts']) {
    const s = readFileSync(resolve(__dirname, f), 'utf8')
    assert.ok(
      !/checkout\?resume=/.test(s),
      `${f} still points at the dead /api/stripe/checkout?resume= route`
    )
  }
  // And at least one of them builds the new path.
  const w = readFileSync(resolve(__dirname, '../../workers/scheduled.worker.ts'), 'utf8')
  assert.ok(w.includes('/api/stripe/checkout/resume?booking='), 'the worker must build the resume URL')
})
