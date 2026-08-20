import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyStripeSignature } from '../stripe-events'
import { can } from '../permissions'

// ════════════════════════════════════════════════════════════════════════════
//  The deposit ROUTES: who may call them, what they trust, and the guards that
//  stop a customer being charged twice or a browser choosing its own price.
//
//  Route handlers here are asserted against their SOURCE, the pattern already
//  used by checkout-resume-route.test.ts. It is the honest option in this repo:
//  there is no test database, and a rule like "the refusal happens BEFORE the
//  Stripe call" is about ORDER, which is exactly what source assertions can
//  pin and a mocked unit test usually cannot.
// ════════════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../../..')
const read = (p: string): string => {
  const full = resolve(ROOT, p)
  assert.ok(existsSync(full), `${p} must exist`)
  return readFileSync(full, 'utf8')
}
/** Source with comment lines stripped, so prose cannot satisfy a code rule. */
const code = (p: string): string =>
  read(p)
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

const CHECKOUT = 'app/api/deposit/[token]/checkout/route.ts'
const STATUS = 'app/api/deposit/[token]/status/route.ts'
const ADMIN = 'app/api/admin/deposit-links/route.ts'
const ADMIN_ID = 'app/api/admin/deposit-links/[id]/route.ts'
const NOTIFY = 'app/api/admin/deposit-links/[id]/notify/route.ts'
const SERVICE = 'src/lib/deposit-service.ts'
const STRIPE = 'src/lib/stripe.ts'
const EVENTS = 'src/lib/stripe-events.ts'

// ── Admin authorization ─────────────────────────────────────────────────────

test('deposit permissions: creating a link is OWNER-only, viewing is not', () => {
  // Minting a link is asking a customer for money at an amount the person
  // typing chooses — the same authority line as capturing the $49 hold.
  assert.equal(can('OWNER', 'deposit.create'), true)
  assert.equal(can('MANAGER', 'deposit.create'), false)
  assert.equal(can('CREW', 'deposit.create'), false)
  assert.equal(can(null, 'deposit.create'), false)

  assert.equal(can('OWNER', 'deposit.cancel'), true)
  assert.equal(can('MANAGER', 'deposit.cancel'), false)
  assert.equal(can('OWNER', 'deposit.notify_test'), true)
  assert.equal(can('MANAGER', 'deposit.notify_test'), false)

  // Viewing is operational — "did Natalia pay yet?" — and exposes no profit.
  assert.equal(can('OWNER', 'deposit.view'), true)
  assert.equal(can('MANAGER', 'deposit.view'), true)
  assert.equal(can('CREW', 'deposit.view'), false)
  assert.equal(can(null, 'deposit.view'), false)
})

test('every admin deposit route checks a session AND a permission', () => {
  for (const p of [ADMIN, ADMIN_ID, NOTIFY, 'app/api/admin/deposit-links/test-notification/route.ts', 'app/api/admin/deposit-links/targets/route.ts']) {
    const src = code(p)
    assert.match(src, /getSession\(\)/, `${p} must load the session`)
    assert.match(src, /status: 401/, `${p} must 401 without a session`)
    assert.match(src, /can\(session\.role as Role, '/, `${p} must check a permission`)
    assert.match(src, /status: 403/, `${p} must 403 on a permission failure`)
  }
})

test('the admin deposit pages are covered by the auth middleware matcher', () => {
  const mw = code('middleware.ts')
  assert.match(mw, /'\/admin\/deposit-links'/, 'the page itself must be matched')
  assert.match(mw, /'\/admin\/deposit-links\/:path\*'/, 'its children must be matched')
  // /api/admin/:path* already covers the API routes.
  assert.match(mw, /'\/api\/admin\/:path\*'/)
})

test('the admin deposit-links segment re-checks auth in its own layout', () => {
  const layout = code('app/(admin)/admin/deposit-links/layout.tsx')
  assert.match(layout, /getSession\(\)/)
  assert.match(layout, /redirect\('\/admin\/login/)
  assert.match(layout, /\['OWNER', 'MANAGER'\]/)
})

// ── The amount is the server's, not the browser's ───────────────────────────

test('checkout reads the amount from the DATABASE and never from the request', () => {
  const src = code(CHECKOUT)
  assert.match(src, /amountCents: row\.amountCents/, 'the charge amount must come off the row')
  // The POST body is never parsed. There is no field to tamper with.
  assert.ok(!src.includes('req.json()'), 'the public checkout route must not read a request body')
  assert.ok(!src.includes('req.text()'), 'the public checkout route must not read a request body')
  assert.ok(!/searchParams\.get\(['"]amount/.test(src), 'no amount may ride in the query string')
  assert.ok(!/formData\(\)/.test(src))
})

test('the pay button sends no amount at all', () => {
  const panel = code('app/deposit/[token]/DepositView.tsx')
  assert.match(panel, /body: '\{\}'/, 'the client posts an empty body')
  const payFn = panel.split('const pay = useCallback')[1]?.split('}, [token, t, lang])')[0] ?? ''
  assert.ok(payFn.length > 0, 'the pay handler must exist')
  assert.ok(!/amountCents|amount:/i.test(payFn), 'the pay call must not send an amount')
  // The ONLY thing that rides along is the display language, in the query
  // string — never the body, which stays literally '{}'.
  assert.match(payFn, /checkout\?lang=\$\{lang\}/, 'the language rides in the query string')
})

test('the deposit URL carries a token only — no amount, no ids', () => {
  const links = code('src/lib/deposit-links.ts')
  assert.match(links, /\/deposit\/\$\{token\}/)
  // If an amount were ever appended it would be a query param.
  assert.ok(!/deposit\/\$\{token\}\?/.test(links))
})

test('createDepositCheckout refuses a nonsensical amount rather than charging it', () => {
  const src = code(STRIPE)
  const fn = src.slice(src.indexOf('export async function createDepositCheckout'))
  assert.match(fn, /Number\.isInteger\(params\.amountCents\)/)
  assert.match(fn, /params\.amountCents < 100/)
  assert.match(fn, /throw new Error/)
})

test('NO processing fee is ever added to a deposit', () => {
  const stripeFn = code(STRIPE)
  const fn = stripeFn.slice(stripeFn.indexOf('export async function createDepositCheckout'))
  // unit_amount is the stored amount, unmodified — no multiplier, no surcharge.
  assert.match(fn, /unit_amount: params\.amountCents/)
  assert.ok(!/amountCents\s*[*+]/.test(fn), 'the amount must not be arithmetically adjusted')
  assert.ok(!/fee/i.test(fn.split('line_items')[1] ?? ''), 'no fee line item')
  // And only ONE line item exists, so nothing can be added alongside it.
  assert.equal((fn.match(/price_data:/g) ?? []).length, 1)
})

// ── Stripe metadata ─────────────────────────────────────────────────────────

test('Stripe carries the deposit + booking identifiers on BOTH objects', () => {
  const src = code(STRIPE)
  const fn = src.slice(src.indexOf('export async function createDepositCheckout'))
  assert.match(fn, /depositRequestId: params\.depositRequestId/)
  assert.match(fn, /paymentKind: 'move_deposit'/)
  assert.match(fn, /bookingId: params\.bookingId/)
  assert.match(fn, /client_reference_id: params\.depositRequestId/)
  // The SAME metadata object is attached to the session and the PaymentIntent.
  assert.match(fn, /payment_intent_data: \{[\s\S]*?metadata,/)
  assert.match(fn, /\n {6}metadata,/)
})

test('a deposit is an immediate CHARGE — it never inherits the manual-capture hold', () => {
  const src = code(STRIPE)
  const fn = src.slice(src.indexOf('export async function createDepositCheckout'), src.indexOf('// Capture the held $49'))
  assert.ok(!fn.includes('capture_method'), 'a deposit must not set manual capture')
  assert.match(fn, /mode: 'payment'/)
  // The booking hold, a different product, still authorizes only.
  const booking = src.slice(src.indexOf('export async function createBookingCheckout'), src.indexOf('export async function createDepositCheckout'))
  assert.match(booking, /capture_method: 'manual'/, 'the $49 booking flow must be unchanged')
})

test('no Stripe secret can reach the browser', () => {
  for (const p of [CHECKOUT, 'app/deposit/[token]/page.tsx', 'app/deposit/[token]/DepositView.tsx', 'app/(admin)/admin/deposit-links/DepositLinksClient.tsx']) {
    const src = read(p)
    assert.ok(!src.includes('STRIPE_SECRET_KEY'), `${p} must not reference the secret key`)
    assert.ok(!src.includes('sk_live'), `${p} must not contain a live key`)
  }
  // The two CLIENT components must not import the Stripe SDK at all.
  for (const p of ['app/deposit/[token]/DepositView.tsx', 'app/(admin)/admin/deposit-links/DepositLinksClient.tsx']) {
    const src = read(p)
    assert.ok(src.trimStart().startsWith("'use client'"), `${p} is a client component`)
    assert.ok(!src.includes("from 'stripe'"), `${p} must not import Stripe`)
    assert.ok(!src.includes('@/lib/stripe'), `${p} must not import the Stripe helper`)
    assert.ok(!src.includes('@/lib/db'), `${p} must not import prisma`)
  }
})

// ── Rapid double-clicks ─────────────────────────────────────────────────────

test('a rapid double-tap cannot create two usable payment sessions', () => {
  const route = code(CHECKOUT)
  const service = code(SERVICE)

  // 1. a live session is REUSED rather than replaced
  assert.match(route, /claim\.kind === 'reuse'/)
  assert.match(service, /kind: 'reuse'/)
  assert.match(service, /checkoutSessionExpiresAt\.getTime\(\) > now\.getTime\(\) \+ 60_000/)

  // 2. minting is gated by a CONDITIONAL update (an atomic claim), not a read
  assert.match(service, /updateMany\(\{[\s\S]*?checkoutAttempts: row\.checkoutAttempts[\s\S]*?\}\)/)
  assert.match(service, /if \(claim\.count === 0\) return \{ kind: 'busy' \}/)

  // 3. the loser re-reads instead of racing again
  assert.match(route, /claim\.kind === 'busy'/)

  // 4. and Stripe itself dedupes the winner's call
  assert.match(route, /idempotencyKey: `deposit_\$\{row\.id\}_\$\{claim\.attempt\}`/)
  assert.match(code(STRIPE), /params\.idempotencyKey \? \{ idempotencyKey: params\.idempotencyKey \}/)
})

test('expires_at is QUANTIZED, or the idempotency key silently does nothing', () => {
  const src = code(STRIPE)
  const fn = src.slice(src.indexOf('export async function createDepositCheckout'))
  const line = /expires_at:[^\n]+/.exec(fn)?.[0] ?? ''

  // Stripe honours an idempotency key only when EVERY parameter matches the
  // first use. A raw Date.now() differs by milliseconds between two calls, so
  // the retry the key exists to collapse comes back as StripeIdempotencyError
  // and the customer is told "We could not start the payment" instead of being
  // handed the session that already exists. Verified against real test-mode
  // Stripe: unquantized -> error, quantized -> same session id returned.
  assert.ok(line.includes('60 * 60 * 1000'), 'expires_at must be quantized to the hour, not raw Date.now()')
  assert.ok(!/expires_at:\s*Math\.floor\(Date\.now\(\) \/ 1000\)/.test(fn),
    'a raw per-millisecond expires_at breaks the idempotency key')

  // And it must still actually expire — an unbounded session is a payable page
  // loose on the internet forever.
  assert.ok(line.includes('24 * 60 * 60'), 'the session must still expire within a day')
})

test('the database enforces one session and one payment intent per deposit', () => {
  const schema = read('prisma/schema.prisma')
  const model = schema.slice(schema.indexOf('model DepositRequest'))
  assert.match(model, /publicToken\s+String\s+@unique/)
  assert.match(model, /stripeCheckoutSessionId\s+String\?\s+@unique/)
  assert.match(model, /stripePaymentIntentId\s+String\?\s+@unique/)

  const migration = read('prisma/migrations/20260815120000_deposit_links/migration.sql')
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_public_token_key"/)
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_stripe_checkout_session_id_key"/)
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_stripe_payment_intent_id_key"/)
})

test('the migration is additive and reversible — it alters no existing table', () => {
  const raw = read('prisma/migrations/20260815120000_deposit_links/migration.sql')
  // The reversal is documented in `--` comments, which legitimately contain
  // DROP statements. Assert on the EXECUTED sql only.
  const sql = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')

  assert.ok(!/ALTER TABLE "bookings"/i.test(sql), 'bookings must not be altered')
  assert.ok(!/ALTER TABLE "payments"/i.test(sql), 'payments must not be altered')
  assert.ok(!/ALTER TABLE "customers"/i.test(sql), 'customers must not be altered')
  assert.ok(!/ALTER TABLE "crm_leads"/i.test(sql), 'leads must not be altered')
  assert.ok(!/\bDROP\b/i.test(sql), 'nothing is dropped')
  // A back-fill is `UPDATE <table> SET`. `ON UPDATE CASCADE` on the new table's
  // own foreign key is referential-action syntax, not a data rewrite.
  assert.ok(!/\bUPDATE\s+"?\w+"?\s+SET\b/i.test(sql), 'no back-fill')
  assert.ok(!/\bDELETE\s+FROM\b/i.test(sql), 'nothing is deleted')
  // The only ALTER touches the new table's own FK and the additive enum values.
  const alters = sql.match(/ALTER TABLE "([a-z_]+)"/gi) ?? []
  for (const a of alters) assert.match(a, /deposit_requests/, `unexpected ${a}`)

  assert.match(sql, /CREATE TABLE IF NOT EXISTS "deposit_requests"/)
  assert.match(sql, /ADD VALUE IF NOT EXISTS 'DEPOSIT_LINK_PAID'/)
  assert.match(raw, /REVERSAL/i, 'the reversal must be documented in the file')
})

// ── Paid / expired / canceled ───────────────────────────────────────────────

test('a link that cannot take money is refused BEFORE any Stripe call', () => {
  const src = code(CHECKOUT)
  const refusalIdx = src.indexOf('payableOrReason(row)')
  const claimIdx = src.indexOf('claimCheckoutSession(')
  const createIdx = src.indexOf('createDepositCheckout(')
  assert.ok(refusalIdx > -1 && createIdx > -1, 'both must exist')
  assert.ok(refusalIdx < claimIdx, 'the refusal precedes the session claim')
  assert.ok(refusalIdx < createIdx, 'the refusal precedes the Stripe call')
  // The refusal carries a CODE as well as a sentence, so the customer's page can
  // say it in Spanish instead of falling out of Spanish at the moment of refusal.
  assert.match(src, /if \(refusal\) return NextResponse\.json\(\{ error: refusal\.message, code: refusal\.code \}, \{ status: 409 \}\)/)
})

test('the session claim itself refuses a paid or inactive link', () => {
  const service = code(SERVICE)
  assert.match(service, /where: \{ id, checkoutAttempts: row\.checkoutAttempts, status: 'ACTIVE', paidAt: null \}/)
})

test('a paid deposit cannot be credited twice — the claim is on paid_at', () => {
  const service = code(SERVICE)
  assert.match(service, /updateMany\(\{\s*where: \{ id: input\.depositRequestId, paidAt: null \}/)
  assert.match(service, /if \(claim\.count === 0\)[\s\S]{0,200}?reason: 'already-paid'/)
  // The Payment row is written only INSIDE the winning branch.
  const claimIdx = service.indexOf("reason: 'already-paid'")
  const paymentIdx = service.indexOf('tx.payment.create')
  assert.ok(claimIdx < paymentIdx, 'the ledger write follows the claim')
})

test('cancelling is refused once paid — that would be a refund, not a cancel', () => {
  const service = code(SERVICE)
  const fn = service.slice(service.indexOf('export async function cancelDepositRequest'))
  assert.match(fn, /already paid/i)
  assert.match(fn, /status: 409/)
  assert.match(fn, /where: \{ id, paidAt: null, status: \{ not: 'CANCELED' \} \}/)
})

test('money that arrived on an expired or canceled link is still RECORDED', () => {
  // Refusing to record a real capture would lose money already in the account.
  const service = code(SERVICE)
  const fn = service.slice(service.indexOf('export async function markDepositPaid'))
  assert.match(fn, /where: \{ id: input\.depositRequestId, paidAt: null \}/, 'the claim is on paid_at only, not on status')
  assert.match(fn, /statusBefore: before\.status/, 'the prior status is audited so the anomaly is visible')
})

// ── The webhook is the source of truth ──────────────────────────────────────

test('a webhook with no signature is rejected without touching anything', () => {
  const r = verifyStripeSignature('{}', null)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 400)
    assert.deepEqual(r.body, { error: 'Missing signature' })
  }
})

test('an INVALID signature is rejected — a forged deposit cannot be credited', () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret'
  try {
    const forged = JSON.stringify({
      id: 'evt_forged',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', payment_status: 'paid', amount_total: 4900, metadata: { depositRequestId: 'dep_1' } } },
    })
    const r = verifyStripeSignature(forged, 't=1,v1=deadbeef')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.status, 400)
  } finally {
    if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
    else process.env.STRIPE_WEBHOOK_SECRET = saved
  }
})

test('the webhook verifies against the RAW body', () => {
  const route = code('app/api/stripe/webhook/route.ts')
  assert.match(route, /req\.text\(\)/, 're-serializing via req.json() would break the signature')
  assert.ok(!route.includes('req.json()'))
})

test('a deposit session is routed to the deposit handler BEFORE the booking one', () => {
  const src = code(EVENTS)
  const block = src.slice(src.indexOf("case 'checkout.session.completed'"), src.indexOf("case 'checkout.session.async_payment_succeeded'"))
  const depositIdx = block.indexOf('session.metadata?.depositRequestId')
  const bookingIdx = block.indexOf('session.metadata?.bookingId')
  const fulfillIdx = block.indexOf('fulfillPaidCheckout(')
  assert.ok(depositIdx > -1 && bookingIdx > -1 && fulfillIdx > -1)
  assert.ok(depositIdx < bookingIdx, 'the deposit branch is checked first')
  assert.ok(depositIdx < fulfillIdx, 'and it precedes booking fulfillment')
  // It must RETURN, not break: a deposit session also carries bookingId, and
  // falling through would flip an unpaid booking off an unrelated payment.
  assert.match(block, /depositRequestId\) \{\s*await handleDepositSession\(event, session\)\s*return\s*\}/)
})

test('delayed (async) payment events are handled', () => {
  const src = code(EVENTS)
  assert.match(src, /case 'checkout\.session\.async_payment_succeeded'/)
  assert.match(src, /case 'checkout\.session\.async_payment_failed'/)
  // The success twin runs the SAME confirmed-payment path.
  const asyncBlock = src.slice(src.indexOf("case 'checkout.session.async_payment_succeeded'"), src.indexOf("case 'checkout.session.async_payment_failed'"))
  assert.match(asyncBlock, /handleDepositSession\(event, session\)/)
})

test('a duplicate webhook delivery is dropped by the existing idempotency log', () => {
  const src = code(EVENTS)
  assert.match(src, /webhookLog\.findUnique\(\{ where: \{ eventId: event\.id \} \}\)/)
  assert.match(src, /existing\.status === 'processed'/)
  // And the queue hand-off dedupes on the event id too.
  assert.match(src, /jobId: event\.id/)
})

test('the success REDIRECT never marks anything paid', () => {
  const panel = code('app/deposit/[token]/DepositView.tsx')
  const page = code('app/deposit/[token]/page.tsx')
  const status = code(STATUS)

  // The return marker only starts a poll of the server's stored state.
  assert.match(page, /searchParams\.return === '1'/)
  assert.match(panel, /\/status`/)
  // Nothing in the client or the status route can write.
  assert.ok(!status.includes('update'), 'the status route must be read-only')
  assert.ok(!status.includes('create'), 'the status route must be read-only')
  assert.match(status, /findUnique/)
  assert.match(status, /export async function GET/)
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)/.test(status), 'the status route has no write verb')

  // And the honest holding state exists.
  // The copy lives in the i18n module now; assert it in BOTH languages so a
  // Spanish customer cannot be dropped into an English holding state.
  const copy = read('src/lib/deposit-copy.ts')
  assert.match(copy, /Confirming your payment/)
  assert.match(copy, /Confirmando su pago/)
})

test('the status poll leaks nothing but a status word', () => {
  const src = code(STATUS)
  assert.match(src, /select: \{ status: true, expiresAt: true, paidAt: true \}/)
  assert.match(src, /\{ status: effectiveStatus\(row\) \}/)
  for (const leak of ['amountCents', 'customerName', 'customerEmail', 'bookingId', 'quoteTotalCents']) {
    assert.ok(!src.includes(leak), `${leak} must not be in the status response`)
  }
})

// ── Standalone deposits ─────────────────────────────────────────────────────

test('a standalone deposit (no booking) is supported end to end', () => {
  const service = code(SERVICE)
  assert.match(service, /bookingId: input\.bookingId \?\? null/)
  assert.match(service, /standalone: !input\.bookingId/, 'the audit log records that it was standalone')
  // With no booking there is no Payment row to write — and the code says so
  // by writing one only inside `if (before.bookingId)`.
  assert.match(service, /if \(before\.bookingId\) \{[\s\S]*?tx\.payment\.create/)
  // A standalone link with a typed quote total still caps overpayment.
  assert.match(service, /Deposit cannot exceed the quote total/)
})

test('a booking-linked deposit lands in the ONE balance formula', () => {
  const service = code(SERVICE)
  // A COMPLETED Stripe payment row is exactly what customerBalance() nets off.
  assert.match(service, /status: 'COMPLETED'/)
  assert.match(service, /method: 'STRIPE'/)
  assert.match(service, /customerBalance\(booking as never\)/)
  // The cap uses the live balance, never a number from the request.
  assert.match(service, /unpaidBalanceCents: ctx\.unpaidBalanceCents/)
})

test('existing pricing is untouched — no quote is recalculated or overwritten', () => {
  const service = code(SERVICE)
  const stripeSrc = code(STRIPE)
  // The deposit path reads the balance and writes a Payment. It never writes a
  // price column back onto the booking.
  assert.ok(!/booking\.update/.test(service), 'the deposit path must not update a booking')
  assert.ok(!/totalEstimate:/.test(service), 'it must not write a quote total')
  assert.ok(!/baseRate/.test(service), 'it must not touch labor rates')
  assert.ok(!/travelFee:/.test(service), 'it must not touch travel fees')
  assert.ok(!/truckAddon/.test(service), 'it must not touch truck charges')
  assert.ok(!/BOOKING_FEE_CENTS/.test(stripeSrc.slice(stripeSrc.indexOf('createDepositCheckout'))), 'the deposit charge is independent of the $49 booking fee')
})

// ── Public route hygiene ────────────────────────────────────────────────────

test('the public routes shape-check the token before querying', () => {
  for (const p of [CHECKOUT, STATUS]) {
    const src = code(p)
    const validateIdx = src.indexOf('isValidPublicToken(token)')
    const queryIdx = src.indexOf('prisma.depositRequest')
    assert.ok(validateIdx > -1, `${p} must validate the token shape`)
    assert.ok(queryIdx === -1 || validateIdx < queryIdx, `${p} must validate before querying`)
  }
})

test('the public routes are rate limited', () => {
  assert.match(code(CHECKOUT), /rateLimit\(LIMITS\.depositCheckout/)
  assert.match(code(STATUS), /rateLimit\(LIMITS\.depositStatus/)
  // Per-token as well as per-IP: one link cannot be hammered into many sessions.
  assert.match(code(CHECKOUT), /`token:\$\{token\}`/)
})

test('the public checkout POST refuses a cross-site origin', () => {
  const src = code(CHECKOUT)
  // The RULE now lives in src/lib/deposit-origin.ts and is exercised for real in
  // deposit-origin.test.ts. This assertion used to be
  // `assert.match(src, /sec-fetch-site/)`, which passes whether the comparison
  // is right or wrong — and it was wrong: the guard compared the browser Origin
  // against the PROXIED host, so it 403'd the Pay button for every browser that
  // omits Sec-Fetch-Site. All that belongs here is that the route still consults
  // the guard and still answers 403.
  assert.match(src, /isSameOrigin\(req\.headers\)/, 'the route consults the origin guard')
  assert.match(src, /status: 403/)
  assert.ok(!/sec-fetch-site/.test(src), 'the header logic belongs in deposit-origin.ts, not inline here')
})

test('a Stripe error is never echoed to the customer', () => {
  const src = code(CHECKOUT)
  assert.match(src, /catch \(err\)[\s\S]{0,400}?log\.error/)
  assert.match(src, /We could not start the payment/)
  assert.ok(!/error: err/.test(src), 'the raw error must not be returned to the browser')
})
