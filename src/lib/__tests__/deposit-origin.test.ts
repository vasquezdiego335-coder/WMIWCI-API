// ════════════════════════════════════════════════════════════════════════════
//  deposit-origin.test.ts — the proxy rules, exercised rather than grepped.
//  ------------------------------------------------------------------------
//  The customer's deposit link is `https://www.moveitclearit.com/deposit/…`,
//  which WMIWCI-SITE's vercel.json REWRITES to the Railway host. A rewrite is
//  not a redirect: the browser still believes it is on the brand domain, so it
//  sends `Origin: https://www.moveitclearit.com` while this app sees a `Host`
//  of `…up.railway.app`.
//
//  Two live defects came out of that, and both are asserted here:
//    · the Pay button 403'd for any browser that omits `Sec-Fetch-Site`
//    · Stripe returned the customer to a raw railway.app URL after paying
//
//  The previous coverage searched the route's SOURCE for the string
//  'sec-fetch-site'. That passes whether the logic is right or wrong, which is
//  why the bug shipped. These call the functions.
// ════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSameOrigin, depositReturnBase, allowedHosts, firstForwarded, type OriginEnv } from '../deposit-origin'

const BRAND = 'www.moveitclearit.com'
const RAILWAY = 'wonderful-strength-production-a0f1.up.railway.app'

/** A minimal stand-in for a Headers object. */
const headers = (h: Record<string, string | undefined>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
})

const ENV: OriginEnv = { APP_URL: `https://${RAILWAY}` }
const ENV_BRANDED: OriginEnv = {
  APP_URL: `https://${RAILWAY}`,
  DEPOSIT_LINK_BASE_URL: `https://${BRAND}`,
}

// ── The 403 that stopped people paying ──────────────────────────────────────

test('THE BUG: a browser with no Sec-Fetch-Site is allowed through the rewrite', () => {
  // Safari shipped Sec-Fetch-* only in 16.4, and this link is opened inside
  // Messenger's in-app browser. Comparing Origin to the proxied Host refused it.
  const req = headers({
    origin: `https://${BRAND}`,
    host: RAILWAY,
    'x-forwarded-host': BRAND,
  })
  assert.equal(isSameOrigin(req, ENV), true, 'the brand-domain Origin must be accepted')
})

test('a genuinely cross-site POST is still refused', () => {
  const req = headers({
    origin: 'https://evil.example.com',
    host: RAILWAY,
    'x-forwarded-host': BRAND,
  })
  assert.equal(isSameOrigin(req, ENV), false)
})

test('Sec-Fetch-Site remains authoritative wherever the browser sends it', () => {
  const base = { origin: `https://${BRAND}`, host: RAILWAY, 'x-forwarded-host': BRAND }
  assert.equal(isSameOrigin(headers({ ...base, 'sec-fetch-site': 'same-origin' }), ENV), true)
  assert.equal(isSameOrigin(headers({ ...base, 'sec-fetch-site': 'none' }), ENV), true)
  assert.equal(isSameOrigin(headers({ ...base, 'sec-fetch-site': 'cross-site' }), ENV), false)
  assert.equal(isSameOrigin(headers({ ...base, 'sec-fetch-site': 'same-site' }), ENV), false)
})

test('a request with no Origin at all is a non-browser client and is allowed', () => {
  assert.equal(isSameOrigin(headers({ host: RAILWAY }), ENV), true)
})

test('a malformed Origin is refused rather than parsed generously', () => {
  assert.equal(isSameOrigin(headers({ origin: 'not a url', host: RAILWAY }), ENV), false)
  assert.equal(isSameOrigin(headers({ origin: '', host: RAILWAY }), ENV), true, 'empty is absent')
})

test('the direct host still works when nothing is proxying', () => {
  assert.equal(
    isSameOrigin(headers({ origin: `https://${RAILWAY}`, host: RAILWAY }), ENV),
    true
  )
})

test('the brand domain is allowed even if the proxy stops forwarding', () => {
  // The brand's own hostnames are built in, so the guard does not depend on a
  // header an attacker could set OR on an env var someone forgot to configure.
  const req = headers({ origin: `https://${BRAND}`, host: RAILWAY })
  assert.equal(isSameOrigin(req, ENV), true)
  assert.equal(isSameOrigin(req, ENV_BRANDED), true)
  assert.equal(isSameOrigin(headers({ origin: 'https://moveitclearit.com', host: RAILWAY }), ENV), true)
})

test('THE SELF-VOUCHING HOLE: x-forwarded-host may never justify itself', () => {
  // A trusted set that CONTAINS the candidate is not a check. If the forwarded
  // host were a member of `allowedHosts`, a forged header would both pass the
  // origin guard and become a Stripe redirect target.
  const forged = headers({ host: RAILWAY, 'x-forwarded-host': 'evil.example.com' })
  assert.ok(!allowedHosts(forged, ENV).has('evil.example.com'), 'the candidate is not in the trusted set')
  assert.equal(depositReturnBase(forged, `https://${RAILWAY}`, ENV), `https://${RAILWAY}`)
  assert.equal(
    isSameOrigin(headers({ origin: 'https://evil.example.com', host: RAILWAY, 'x-forwarded-host': 'evil.example.com' }), ENV),
    false,
    'and it cannot launder an Origin either'
  )
})

test('a staging host is trusted only by configuration', () => {
  const req = headers({ origin: 'https://staging.example', host: RAILWAY })
  assert.equal(isSameOrigin(req, ENV), false, 'unknown hosts are refused')
  assert.equal(
    isSameOrigin(req, { APP_URL: 'https://staging.example' }),
    true,
    'APP_URL vouches for it'
  )
})

test('a malformed env var neither opens nor closes the guard', () => {
  const req = headers({ origin: `https://${BRAND}`, host: RAILWAY, 'x-forwarded-host': BRAND })
  const broken = { APP_URL: 'not a url', DEPOSIT_LINK_BASE_URL: '://///' }
  assert.equal(isSameOrigin(req, broken), true, 'the built-in brand host still vouches')
  assert.equal(
    isSameOrigin(headers({ origin: 'https://evil.example.com', host: RAILWAY }), broken),
    false
  )
})

// ── The URL Stripe sends them back to ───────────────────────────────────────

test('THE BUG: a customer who paid on the brand domain comes back to it', () => {
  const req = headers({ host: RAILWAY, 'x-forwarded-host': BRAND, 'x-forwarded-proto': 'https' })
  assert.equal(
    depositReturnBase(req, `https://${RAILWAY}`, ENV),
    `https://${BRAND}`,
    'not the raw railway.app hostname they have never seen'
  )
})

test('an unvouched forwarded host falls back to the configured base', () => {
  // x-forwarded-host is attacker-controllable, and this value becomes a Stripe
  // redirect target. Only a host the app is otherwise known to serve is used.
  const req = headers({ host: RAILWAY, 'x-forwarded-host': 'evil.example.com' })
  assert.equal(depositReturnBase(req, `https://${RAILWAY}`, ENV), `https://${RAILWAY}`)
})

test('with no proxy header at all the configured base is used', () => {
  assert.equal(depositReturnBase(headers({ host: RAILWAY }), `https://${RAILWAY}`, ENV), `https://${RAILWAY}`)
})

test('http is honoured only for localhost, never for a public host', () => {
  const local = headers({ host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' })
  assert.equal(depositReturnBase(local, 'http://localhost:3000', ENV), 'http://localhost:3000')

  // A stripped-TLS proxy must not downgrade a payment return URL.
  const downgrade = headers({ host: BRAND, 'x-forwarded-host': BRAND, 'x-forwarded-proto': 'http' })
  assert.equal(depositReturnBase(downgrade, `https://${BRAND}`, ENV_BRANDED), `https://${BRAND}`)
})

test('a comma-joined proxy chain uses the first entry', () => {
  assert.equal(firstForwarded(`${BRAND}, ${RAILWAY}`), BRAND)
  assert.equal(firstForwarded('  WWW.MoveItClearIt.com  '), BRAND)
  assert.equal(firstForwarded(null), null)
  assert.equal(firstForwarded(''), null)

  const req = headers({ host: RAILWAY, 'x-forwarded-host': `${BRAND}, ${RAILWAY}` })
  assert.equal(depositReturnBase(req, `https://${RAILWAY}`, ENV), `https://${BRAND}`)
})

test('host matching is case-insensitive and ignores a scheme or path', () => {
  const hosts = allowedHosts(
    headers({ host: 'RAILWAY.EXAMPLE' }),
    { APP_URL: 'https://Brand.Example/some/path' }
  )
  assert.ok(hosts.has('railway.example'))
  assert.ok(hosts.has('brand.example'))
  // A forwarded host given in mixed case is still MATCHED case-insensitively,
  // even though it is not a member of the set.
  const req = headers({ host: RAILWAY, 'x-forwarded-host': 'WWW.MoveItClearIt.com' })
  assert.equal(depositReturnBase(req, `https://${RAILWAY}`, ENV), `https://${BRAND}`)
})

test('the returned base carries no path, query or trailing slash', () => {
  const req = headers({ host: RAILWAY, 'x-forwarded-host': BRAND })
  const base = depositReturnBase(req, `https://${RAILWAY}`, ENV)
  assert.ok(!base.endsWith('/'), 'the caller appends /deposit/<token>')
  assert.ok(!base.includes('?'))
  assert.equal(new URL(base).pathname, '/')
})
