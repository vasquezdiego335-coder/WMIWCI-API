// ════════════════════════════════════════════════════════════════════════
//  consent-grant-safeguards.test.ts — a marketing basis is granted only when
//  every safeguard passes (DESIGN-v2 §6). Fail closed for marketing.
//
//  Pins: flags default OFF — every grant (a notice; the popup included) needs
//  EMAIL_NOTICE_BASIS_ENABLED and the popup also OFFER_SIGNUP_ENABLED;
//  honeypot, invalid, role, reserved and test addresses are withheld; the
//  booking form needs a user-typed address; Turnstile only when switched on
//  (TURNSTILE_ENABLED / EMAIL_REQUIRE_TURNSTILE), against a FAKE fetch
//  (verified, rejected, timeout, network error, malformed, missing
//  token/secret); the Postgres-backed throttles (per IP HMAC, global breaker
//  with exactly one alert) against an in-memory fake Prisma; NO per-email
//  sequence throttle (2026-09-16: a repeat submission is granted and recorded;
//  the enrollment claim, not this gate, prevents a second sequence); a read
//  failure in any remaining throttle query fails closed; the keyed IP hash;
//  region signals.
//
//  Offline: no network (fetch is injected and the real one is poisoned), no
//  database, no Discord. Every address is @example.com.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'
import {
  GRANT_LIMITS,
  TURNSTILE_SITEVERIFY_URL,
  consentClientIp,
  consentIpHmac,
  deriveRegionSignal,
  evaluateGrantSafeguards,
  hashUserAgent,
  noticeBasisEnabled,
  offerSignupEnabled,
  turnstileRequired,
  verifyTurnstile,
  type FetchLike,
  type GrantSafeguardDeps,
  type SafeguardDb,
} from '../consent/grant-safeguards'
import { NOTICE_SURFACES, SEQUENCE_KINDS, SURFACE_SEQUENCE_KINDS } from '../consent/notice-registry'
import { enrollSequence, type EnrollmentDb } from '../consent/sequence-enrollment'

assertNoProductionCredentials()

//  A real network call from this suite is a bug. Poison the global fetch.
const realFetch = globalThis.fetch
before(() => {
  globalThis.fetch = (async () => {
    throw new Error('network access is forbidden in consent-grant-safeguards.test.ts')
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

const NOW = new Date('2026-10-01T15:00:00Z')
const HOUR = 60 * 60 * 1000
const EMAIL = 'visitor@example.com'
const IP = '203.0.113.7'
const ENV = { EMAIL_NOTICE_BASIS_ENABLED: 'true', OFFER_SIGNUP_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: 'test-consent-hmac-secret' }

type Fake = ReturnType<typeof createFakeConsentDb>
const asDb = (db: Fake) => db as unknown as SafeguardDb

function deps(db: Fake, over: GrantSafeguardDeps = {}): GrantSafeguardDeps & { alerts: string[] } {
  const alerts: string[] = []
  return {
    db: asDb(db),
    env: ENV,
    //  @example.com is a RESERVED domain and is withheld by default; the throttle
    //  tests need an ordinary identity, so the identity check is stubbed here and
    //  exercised for real in its own test below.
    testIdentity: async () => null,
    alert: async (title) => {
      alerts.push(title)
    },
    alerts,
    ...over,
  }
}

const base = { grant: 'notice' as const, email: EMAIL, sequenceKind: 'quote_followup' as const, ip: IP, now: NOW }

//  Wraps the fake's two SafeguardDb models so a test can see every query the
//  gate makes and fail ONE of them (by "model.method" and call number) while
//  the rest keep answering from the in-memory tables.
function instrumentedDb(db: Fake, fail: (call: string, nth: number) => boolean = () => false) {
  const calls: string[] = []
  const wrapped: Record<string, Record<string, unknown>> = {}
  for (const model of ['emailConsentEvent', 'sequenceEnrollment'] as const) {
    const methods = db[model] as Record<string, unknown>
    wrapped[model] = {}
    for (const [name, fn] of Object.entries(methods)) {
      if (typeof fn !== 'function') continue
      wrapped[model][name] = async (...args: unknown[]) => {
        const call = `${model}.${name}`
        calls.push(call)
        if (fail(call, calls.filter((c) => c === call).length)) throw new Error(`simulated ${call} outage`)
        return (fn as (...a: unknown[]) => Promise<unknown>).apply(methods, args)
      }
    }
  }
  return { db: wrapped as unknown as SafeguardDb, calls }
}

function grantEvent(db: Fake, email: string, at: Date, over: Record<string, unknown> = {}) {
  db.tables.events.push({
    id: `evt_${db.tables.events.length + 1}`,
    emailNormalized: email,
    kind: 'notice_accepted',
    surface: 'quote',
    requestId: `req_${db.tables.events.length + 1}`,
    occurredAt: at,
    ipHmac: consentIpHmac(IP, ENV),
    withheldReason: null,
    ...over,
  })
}

// ── flags ──────────────────────────────────────────────────────────────────

test('every flag is OFF unless set to exactly "true"', () => {
  for (const v of [undefined, '', '1', 'TRUE', 'yes', 'on']) {
    const env = { EMAIL_NOTICE_BASIS_ENABLED: v, OFFER_SIGNUP_ENABLED: v, EMAIL_REQUIRE_TURNSTILE: v, TURNSTILE_ENABLED: v }
    assert.equal(noticeBasisEnabled(env), false, String(v))
    assert.equal(offerSignupEnabled(env), false, String(v))
    assert.equal(turnstileRequired(env), false, String(v))
  }
  assert.equal(noticeBasisEnabled({ EMAIL_NOTICE_BASIS_ENABLED: 'true' }), true)
  assert.equal(turnstileRequired({ TURNSTILE_ENABLED: 'true' }), true, 'the documented Turnstile switch requires it')
  assert.equal(turnstileRequired({ EMAIL_REQUIRE_TURNSTILE: 'true' }), true)
  // The repo's documented INACTIVE state is keys present with TURNSTILE_ENABLED=false.
  // No page renders a widget today, so treating a key as the switch would
  // withhold every grant the moment the notice flags went on.
  assert.equal(turnstileRequired({ TURNSTILE_SECRET_KEY: 'x', TURNSTILE_ENABLED: 'false' }), false, 'a key alone is not the switch')
  assert.equal(turnstileRequired({ TURNSTILE_SECRET_KEY: 'x' }), false)
})

test('flags off: nothing is granted and nothing is read', async () => {
  const db = createFakeConsentDb({ failModels: new Set(['emailConsentEvent', 'sequenceEnrollment']) })
  const d1 = await evaluateGrantSafeguards(base, deps(db, { env: {} }))
  assert.deepEqual(d1, { grant: false, reason: 'notice_basis_disabled', turnstileOk: null, ipHmac: null })
  //  EVERY grant needs EMAIL_NOTICE_BASIS_ENABLED — on every surface, the popup
  //  included, even with OFFER_SIGNUP_ENABLED on and a honeypot filled.
  const offerOnly = { OFFER_SIGNUP_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: ENV.CONSENT_IP_HMAC_SECRET }
  for (const surface of [undefined, ...NOTICE_SURFACES]) {
    const d = await evaluateGrantSafeguards({ ...base, surface, sequenceKind: null, honeypot: 'bot' }, deps(db, { env: offerOnly }))
    assert.deepEqual(d, { grant: false, reason: 'notice_basis_disabled', turnstileOk: null, ipHmac: null }, String(surface))
  }
  //  The popup ADDITIONALLY needs OFFER_SIGNUP_ENABLED, checked before anything is read.
  for (const offer of [undefined, 'false', '1', 'TRUE']) {
    const d2 = await evaluateGrantSafeguards(
      { ...base, surface: 'popup', sequenceKind: null },
      deps(db, { env: { EMAIL_NOTICE_BASIS_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: ENV.CONSENT_IP_HMAC_SECRET, OFFER_SIGNUP_ENABLED: offer } }),
    )
    assert.deepEqual(d2, { grant: false, reason: 'offer_signup_disabled', turnstileOk: null, ipHmac: null }, String(offer))
  }
})

test('OFFER_SIGNUP_ENABLED gates only the popup: every other surface grants without it', async () => {
  const noOffer = { EMAIL_NOTICE_BASIS_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: ENV.CONSENT_IP_HMAC_SECRET }
  for (const surface of [undefined, ...NOTICE_SURFACES.filter((s) => s !== 'popup')]) {
    const db = createFakeConsentDb()
    const d = await evaluateGrantSafeguards({ ...base, surface, sequenceKind: null }, deps(db, { env: noOffer }))
    assert.equal(d.grant, true, String(surface))
  }
  const db = createFakeConsentDb()
  const popup = await evaluateGrantSafeguards({ ...base, surface: 'popup', sequenceKind: null }, deps(db, { env: { ...noOffer, OFFER_SIGNUP_ENABLED: 'true' } }))
  assert.deepEqual(popup, { grant: true, turnstileOk: null, ipHmac: consentIpHmac(IP, ENV) })
})

// ── local checks ───────────────────────────────────────────────────────────

test('honeypot, invalid address, and the booking form typed-address rule', async () => {
  const db = createFakeConsentDb()
  const r = async (over: Record<string, unknown>) => {
    const d = await evaluateGrantSafeguards({ ...base, ...over }, deps(db))
    return d.grant ? 'granted' : d.reason
  }
  assert.equal(await r({ honeypot: 'Acme Corp' }), 'honeypot')
  assert.equal(await r({ honeypot: '   ' }), 'granted', 'whitespace is not a filled honeypot')
  assert.equal(await r({ email: 'not-an-address' }), 'invalid_email')
  assert.equal(await r({ email: 'a@b@example.com' }), 'invalid_email')
  assert.equal(await r({ requireEmailUserTyped: true, emailUserTyped: false }), 'email_not_user_typed')
  assert.equal(await r({ requireEmailUserTyped: true, emailUserTyped: undefined }), 'email_not_user_typed')
  assert.equal(await r({ requireEmailUserTyped: true, emailUserTyped: true }), 'granted')
})

test('role, reserved and test identities are withheld (the real identity check)', async () => {
  const db = createFakeConsentDb()
  const real: GrantSafeguardDeps = { db: asDb(db), env: ENV, alert: async () => undefined }
  const reasonFor = async (email: string) => {
    const d = await evaluateGrantSafeguards({ ...base, email }, real)
    return d.grant ? 'granted' : d.reason
  }
  assert.equal(await reasonFor('customer@example.com'), 'reserved_address')
  assert.equal(await reasonFor('INFO@example.com'), 'reserved_address', 'reserved wins over role for a reserved domain')
  assert.equal(await reasonFor('owner-test+99@moveitclearit.com'), 'test_identity')
  const role = await evaluateGrantSafeguards({ ...base, email: 'postmaster@example.com' }, deps(db, { testIdentity: async () => 'role_account' }))
  assert.equal(role.grant === false && role.reason, 'role_address')
  const staff = await evaluateGrantSafeguards(base, deps(db, { testIdentity: async () => 'staff_lookup_failed' }))
  assert.equal(staff.grant === false && staff.reason, 'test_identity', 'a failed staff lookup withholds')
})

// ── Turnstile ──────────────────────────────────────────────────────────────

function fakeFetch(respond: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>) {
  const calls: Array<{ url: string; body: string }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body })
    return respond()
  }
  return { fn, calls }
}
const jsonRes = (body: unknown, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body })

test('verifyTurnstile: verified, rejected, malformed, HTTP error', async () => {
  const good = fakeFetch(jsonRes({ success: true }))
  assert.deepEqual(await verifyTurnstile('tok', IP, { fetch: good.fn, secret: 's3cret' }), { ok: true, reason: 'verified' })
  assert.equal(good.calls.length, 1)
  assert.equal(good.calls[0].url, TURNSTILE_SITEVERIFY_URL)
  const params = new URLSearchParams(good.calls[0].body)
  assert.equal(params.get('secret'), 's3cret')
  assert.equal(params.get('response'), 'tok')
  assert.equal(params.get('remoteip'), IP)

  const bad = fakeFetch(jsonRes({ success: false, 'error-codes': ['invalid-input-response'] }))
  assert.deepEqual(await verifyTurnstile('tok', IP, { fetch: bad.fn, secret: 's' }), { ok: false, reason: 'rejected', errorCodes: ['invalid-input-response'] })
  assert.equal((await verifyTurnstile('tok', IP, { fetch: fakeFetch(jsonRes({ nope: 1 })).fn, secret: 's' })).reason, 'bad_response')
  assert.equal((await verifyTurnstile('tok', IP, { fetch: fakeFetch(jsonRes({ success: true }, false)).fn, secret: 's' })).reason, 'bad_response')
  assert.equal((await verifyTurnstile('tok', IP, { fetch: fakeFetch(jsonRes('success')).fn, secret: 's' })).reason, 'bad_response')
})

test('verifyTurnstile: missing token or secret fails WITHOUT a network call', async () => {
  const f = fakeFetch(jsonRes({ success: true }))
  assert.equal((await verifyTurnstile('', IP, { fetch: f.fn, secret: 's' })).reason, 'missing_token')
  assert.equal((await verifyTurnstile(null, IP, { fetch: f.fn, secret: 's' })).reason, 'missing_token')
  assert.equal((await verifyTurnstile('tok', IP, { fetch: f.fn, env: {} })).reason, 'missing_secret')
  assert.equal((await verifyTurnstile('x'.repeat(2049), IP, { fetch: f.fn, secret: 's' })).reason, 'rejected')
  assert.equal(f.calls.length, 0)
})

test('verifyTurnstile: a network error and a hung request are both failures, bounded by the timeout', async () => {
  const boom: FetchLike = async () => {
    throw new Error('ECONNRESET')
  }
  assert.equal((await verifyTurnstile('tok', IP, { fetch: boom, secret: 's' })).reason, 'network_error')

  //  A fetch that never resolves and ignores the abort signal still cannot hold the submit.
  const hang: FetchLike = () => new Promise(() => undefined)
  const started = Date.now()
  const r = await verifyTurnstile('tok', IP, { fetch: hang, secret: 's', timeoutMs: 50 })
  assert.deepEqual(r, { ok: false, reason: 'timeout' })
  assert.ok(Date.now() - started < 2000, 'bounded')
})

test('grant decision: Turnstile required and not verified withholds; verified grants and records the verdict', async () => {
  const db = createFakeConsentDb()
  const env = { ...ENV, TURNSTILE_ENABLED: 'true', TURNSTILE_SECRET_KEY: 'secret' }
  const failed = await evaluateGrantSafeguards({ ...base, turnstileToken: 'tok' }, deps(db, { env, fetch: fakeFetch(jsonRes({ success: false })).fn }))
  assert.deepEqual(failed, { grant: false, reason: 'turnstile_failed', turnstileOk: false, ipHmac: null })
  const missing = await evaluateGrantSafeguards(base, deps(db, { env: { ...ENV, EMAIL_REQUIRE_TURNSTILE: 'true' }, fetch: fakeFetch(jsonRes({ success: true })).fn }))
  assert.equal(missing.grant === false && missing.reason, 'turnstile_failed', 'required without a secret is a failure, not a pass')
  const ok = await evaluateGrantSafeguards({ ...base, turnstileToken: 'tok' }, deps(db, { env, fetch: fakeFetch(jsonRes({ success: true })).fn }))
  assert.equal(ok.grant, true)
  assert.equal(ok.turnstileOk, true)
  const notRequired = await evaluateGrantSafeguards(base, deps(db))
  assert.equal(notRequired.grant, true)
  assert.equal(notRequired.turnstileOk, null, 'not required = not checked, recorded as null')

  //  Keys present but the switch off (the documented inactive state): not
  //  checked at all. The global fetch is poisoned, so a verification attempt
  //  would have been a network_error → turnstile_failed.
  for (const off of [{ TURNSTILE_ENABLED: 'false' }, {}]) {
    const keysOnly = await evaluateGrantSafeguards(
      { ...base, email: 'keys.only@example.com' },
      deps(createFakeConsentDb(), { env: { ...ENV, TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_SITE_KEY: 'site', ...off } }),
    )
    assert.deepEqual(keysOnly, { grant: true, turnstileOk: null, ipHmac: consentIpHmac(IP, ENV) }, JSON.stringify(off))
  }
  //  Switched on, the popup is held to it like every other surface.
  const popup = await evaluateGrantSafeguards({ ...base, surface: 'popup', sequenceKind: null }, deps(createFakeConsentDb(), { env, fetch: fakeFetch(jsonRes({ success: false })).fn }))
  assert.equal(popup.grant === false && popup.reason, 'turnstile_failed')
})

// ── IP ─────────────────────────────────────────────────────────────────────

test('the IP is keyed-hashed, never stored raw; no IP or no secret withholds', async () => {
  const h = consentIpHmac(IP, ENV)
  assert.match(String(h), /^[0-9a-f]{64}$/)
  assert.ok(!String(h).includes('203'))
  assert.notEqual(consentIpHmac(IP, { CONSENT_IP_HMAC_SECRET: 'other' }), h, 'keyed: a different secret gives a different value')
  assert.equal(consentIpHmac(IP, { EMAIL_TOKEN_SECRET: 'test-consent-hmac-secret' }), h, 'falls back to EMAIL_TOKEN_SECRET')
  assert.equal(consentIpHmac(IP, {}), null)
  assert.equal(consentIpHmac('unknown', ENV), null)

  const db = createFakeConsentDb()
  const noIp = await evaluateGrantSafeguards({ ...base, ip: null }, deps(db))
  assert.equal(noIp.grant === false && noIp.reason, 'ip_unavailable')
  const noSecret = await evaluateGrantSafeguards(base, deps(db, { env: { EMAIL_NOTICE_BASIS_ENABLED: 'true' } }))
  assert.equal(noSecret.grant === false && noSecret.reason, 'ip_unavailable')
})

test('consentClientIp ignores the client-writable first X-Forwarded-For entry', () => {
  const h = (map: Record<string, string>) => ({ get: (n: string) => map[n.toLowerCase()] ?? null })
  assert.equal(consentClientIp(h({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' })), '198.51.100.4')
  assert.equal(consentClientIp(h({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '6.6.6.6' })), '198.51.100.9')
  assert.equal(consentClientIp(h({})), null)
})

test('hashUserAgent', () => {
  assert.match(String(hashUserAgent('Mozilla/5.0')), /^[0-9a-f]{32}$/)
  assert.equal(hashUserAgent(''), null)
  assert.equal(hashUserAgent(undefined), null)
})

// ── throttles ──────────────────────────────────────────────────────────────

test('per email: an address already enrolled in the kind within 30 days is GRANTED, and no enrollment is read', async () => {
  //  The per-email throttle is gone (2026-09-16). A repeat submission records
  //  notice_accepted like any other; whether it starts a SECOND sequence is the
  //  enrollment claim's decision (the sequence_enrollments unique key), not
  //  this gate's. Withholding here used to drop the latest submission too.
  const db = createFakeConsentDb()
  for (const kind of SEQUENCE_KINDS) {
    db.tables.enrollments.push({ id: `e_${kind}_active`, emailNormalized: EMAIL, sequenceKind: kind, createdAt: new Date(NOW.getTime() - HOUR), status: 'active' })
    db.tables.enrollments.push({ id: `e_${kind}_stopped`, emailNormalized: EMAIL, sequenceKind: kind, createdAt: new Date(NOW.getTime() - 29 * 24 * HOUR), status: 'stopped' })
  }
  //  …and the earlier submission's own grant, from the same IP.
  grantEvent(db, EMAIL, new Date(NOW.getTime() - HOUR))
  const enrollmentsBefore = db.tables.enrollments.length
  const eventsBefore = db.tables.events.length

  //  Every surface, with every sequence kind that surface may start, and none.
  for (const surface of NOTICE_SURFACES) {
    for (const sequenceKind of [...SURFACE_SEQUENCE_KINDS[surface], null]) {
      //  Any enrollment query throws: had the gate read one, this would be throttle_read_failed.
      const probe = instrumentedDb(db, (call) => call.startsWith('sequenceEnrollment.'))
      const d = await evaluateGrantSafeguards({ ...base, surface, sequenceKind }, deps(db, { db: probe.db }))
      const label = `${surface}/${sequenceKind}`
      assert.deepEqual(d, { grant: true, turnstileOk: null, ipHmac: consentIpHmac(IP, ENV) }, label)
      assert.equal(probe.calls.filter((c) => c.startsWith('sequenceEnrollment.')).length, 0, `${label}: no enrollment query`)
      assert.ok(probe.calls.length > 0, `${label}: the per-IP and breaker reads still run`)
      assert.ok(probe.calls.every((c) => c.endsWith('.findMany') || c.endsWith('.count')), `${label}: the gate only reads (${probe.calls})`)
    }
  }
  assert.equal(db.tables.enrollments.length, enrollmentsBefore, 'the gate starts nothing')
  assert.equal(db.tables.events.length, eventsBefore, 'the gate records nothing; the caller does')

  //  Duplicate prevention still holds — in the claim. The same kind for the
  //  same person inside 30 days is already_enrolled and never a second row.
  for (const kind of SEQUENCE_KINDS) {
    const claim = await enrollSequence(
      { email: EMAIL, sequenceKind: kind, subjectType: 'lead', subjectId: 'lead_repeat', basisEventId: 'evt_repeat', now: NOW },
      db as unknown as EnrollmentDb,
    )
    assert.equal(claim.outcome, 'already_enrolled', kind)
  }
  assert.equal(db.tables.enrollments.length, enrollmentsBefore, 'no second enrollment row')
})

test('per IP: more than 3 distinct addresses granted in 24h is withheld; the same address again is not', async () => {
  const db = createFakeConsentDb()
  const recent = new Date(NOW.getTime() - HOUR)
  for (let i = 1; i <= GRANT_LIMITS.perIpDistinctEmails24h; i++) {
    grantEvent(db, `someone${i}@example.com`, recent)
    grantEvent(db, `someone${i}@example.com`, recent) // duplicates count once
  }
  const fourth = await evaluateGrantSafeguards(base, deps(db))
  assert.equal(fourth.grant === false && fourth.reason, 'ip_throttle')
  assert.ok(fourth.ipHmac, 'the withheld event still carries the IP HMAC')

  const repeat = await evaluateGrantSafeguards({ ...base, email: 'someone2@example.com' }, deps(db))
  assert.equal(repeat.grant, true, 'an address already granted from this IP is not a new distinct address')

  const otherIp = await evaluateGrantSafeguards({ ...base, ip: '198.51.100.20' }, deps(db))
  assert.equal(otherIp.grant, true)

  //  Older than 24h and withheld events do not count.
  for (const e of db.tables.events) e.occurredAt = new Date(NOW.getTime() - 25 * HOUR)
  assert.equal((await evaluateGrantSafeguards(base, deps(db))).grant, true)
  db.tables.events.length = 0
  for (let i = 1; i <= 5; i++) grantEvent(db, `w${i}@example.com`, recent, { kind: 'basis_withheld', withheldReason: 'honeypot' })
  assert.equal((await evaluateGrantSafeguards(base, deps(db))).grant, true)
})

test('global breaker: the 21st grant in 24h is withheld and alerts ONCE per trip', async () => {
  const db = createFakeConsentDb()
  const recent = new Date(NOW.getTime() - 2 * HOUR)
  //  Only notice_accepted is a grant. Resubscribe opt-ins and withheld events
  //  (other than the breaker's own) do not count toward the limit.
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h - 1; i++) {
    grantEvent(db, `g${i}@example.com`, recent, { ipHmac: `ip_${i}`, surface: i % 2 ? 'popup' : 'quote' })
  }
  for (let i = 0; i < 5; i++) {
    grantEvent(db, `x${i}@example.com`, recent, { ipHmac: `ipx_${i}`, kind: 'express_opt_in', surface: 'resubscribe_page' })
    grantEvent(db, `w${i}@example.com`, recent, { ipHmac: `ipw_${i}`, kind: 'basis_withheld', withheldReason: 'ip_throttle' })
  }
  assert.equal((await evaluateGrantSafeguards(base, deps(db))).grant, true, `${GRANT_LIMITS.globalGrants24h - 1} grants: still open`)
  grantEvent(db, 'g-last@example.com', recent, { ipHmac: 'ip_last' })
  const d = deps(db)
  const first = await evaluateGrantSafeguards(base, d)
  assert.deepEqual(first, { grant: false, reason: 'global_breaker', turnstileOk: null, ipHmac: consentIpHmac(IP, ENV), alerted: true })
  assert.equal(d.alerts.length, 1)
  //  The route records the withheld event; the next one must not alert again.
  grantEvent(db, EMAIL, NOW, { kind: 'basis_withheld', withheldReason: 'global_breaker', requestId: 'r_w' })
  const second = await evaluateGrantSafeguards({ ...base, email: 'next@example.com' }, d)
  assert.equal(second.grant === false && second.reason, 'global_breaker')
  assert.equal(second.grant === false && second.alerted, false)
  assert.equal(d.alerts.length, 1)
})

test('global breaker: a failing alert hook never throws and never grants', async () => {
  const db = createFakeConsentDb()
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h; i++) grantEvent(db, `g${i}@example.com`, NOW, { ipHmac: `ip_${i}` })
  const d = await evaluateGrantSafeguards(base, deps(db, { alert: async () => { throw new Error('discord down') } }))
  assert.equal(d.grant === false && d.reason, 'global_breaker')
})

test('a throttle read failure withholds (fail closed) and never throws', async () => {
  const withheld = { grant: false, reason: 'throttle_read_failed', turnstileOk: null, ipHmac: consentIpHmac(IP, ENV) }

  //  The whole consent-event table down: the per-IP read is the first to fail.
  const down = createFakeConsentDb({ failModels: new Set(['emailConsentEvent']) })
  assert.deepEqual(await evaluateGrantSafeguards(base, deps(down)), withheld, 'emailConsentEvent outage')

  //  Each remaining query failing on its own, the others answering.
  //  1. per IP (distinct addresses from this IP HMAC)
  const quiet = createFakeConsentDb()
  const perIp = instrumentedDb(quiet, (call) => call === 'emailConsentEvent.findMany')
  assert.deepEqual(await evaluateGrantSafeguards(base, deps(quiet, { db: perIp.db })), withheld, 'per-IP read failure')
  assert.deepEqual(perIp.calls, ['emailConsentEvent.findMany'], 'nothing after the failed read decides the grant')

  //  2. the global breaker's distinct-address read
  const breaker = instrumentedDb(quiet, (call, nth) => call === 'emailConsentEvent.findMany' && nth === 2)
  assert.deepEqual(await evaluateGrantSafeguards(base, deps(quiet, { db: breaker.db })), withheld, 'breaker read failure')
  assert.deepEqual(breaker.calls, ['emailConsentEvent.findMany', 'emailConsentEvent.findMany'])

  //  3. the breaker's "already tripped?" read, with the breaker tripped: withheld
  //  as a read failure, and no alert is posted on a read it could not make.
  const busy = createFakeConsentDb()
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h; i++) grantEvent(busy, `g${i}@example.com`, NOW, { ipHmac: `ip_${i}` })
  const tripped = instrumentedDb(busy, (call, nth) => call === 'emailConsentEvent.count' && nth === 1)
  const trippedDeps = deps(busy, { db: tripped.db })
  assert.deepEqual(await evaluateGrantSafeguards(base, trippedDeps), withheld, 'breaker tripped-before read failure')
  assert.deepEqual(tripped.calls, ['emailConsentEvent.findMany', 'emailConsentEvent.findMany', 'emailConsentEvent.count'])
  assert.equal(trippedDeps.alerts.length, 0)

  //  The popup is held to the same fail-closed rule.
  const popupDown = createFakeConsentDb({ failModels: new Set(['emailConsentEvent']) })
  assert.deepEqual(await evaluateGrantSafeguards({ ...base, surface: 'popup', sequenceKind: 'lead_nurture' }, deps(popupDown)), withheld, 'popup')

  //  The enrollment table is no longer a safeguard read: its outage withholds nothing.
  const enrollDown = createFakeConsentDb({ failModels: new Set(['sequenceEnrollment']) })
  assert.deepEqual(await evaluateGrantSafeguards(base, deps(enrollDown)), { grant: true, turnstileOk: null, ipHmac: consentIpHmac(IP, ENV) })
})

test('the popup grant is a notice under the same safeguards and throttles', async () => {
  //  The popup's submission names the lead_nurture sequence (2026-09-16).
  const popup = { ...base, surface: 'popup' as const, sequenceKind: 'lead_nurture' as const }
  const db = createFakeConsentDb()
  const ok = await evaluateGrantSafeguards(popup, deps(db))
  assert.deepEqual(ok, { grant: true, turnstileOk: null, ipHmac: consentIpHmac(IP, ENV) })
  //  No per-email throttle: an existing enrollment (of this kind or another)
  //  never withholds the notice — the enrollment claim decides the sequence…
  db.tables.enrollments.push({ id: 'e1', emailNormalized: EMAIL, sequenceKind: 'quote_followup', createdAt: NOW, status: 'active' })
  db.tables.enrollments.push({ id: 'e2', emailNormalized: EMAIL, sequenceKind: 'lead_nurture', createdAt: NOW, status: 'active' })
  assert.equal((await evaluateGrantSafeguards(popup, deps(db))).grant, true)
  //  …but the local checks, the per-IP limit and the breaker all apply.
  assert.equal((await evaluateGrantSafeguards({ ...popup, honeypot: 'Acme' }, deps(db))).grant, false)
  assert.equal((await evaluateGrantSafeguards({ ...popup, ip: null }, deps(db))).grant, false)
  const recent = new Date(NOW.getTime() - HOUR)
  for (let i = 1; i <= GRANT_LIMITS.perIpDistinctEmails24h; i++) grantEvent(db, `popup${i}@example.com`, recent, { surface: 'popup' })
  const fourth = await evaluateGrantSafeguards(popup, deps(db))
  assert.equal(fourth.grant === false && fourth.reason, 'ip_throttle')

  const busy = createFakeConsentDb()
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h; i++) grantEvent(busy, `b${i}@example.com`, recent, { ipHmac: `ip_${i}` })
  const tripped = await evaluateGrantSafeguards(popup, deps(busy))
  assert.equal(tripped.grant === false && tripped.reason, 'global_breaker')
})

// ── region signal ──────────────────────────────────────────────────────────

test('region signal table', () => {
  const table: Array<[Parameters<typeof deriveRegionSignal>[0], string]> = [
    [{}, 'unknown'],
    [{ phone: '' }, 'unknown'],
    [{ phone: '(973) 555-0100' }, 'nanp'],
    [{ phone: '1-973-555-0100' }, 'nanp'],
    [{ phone: '+1 416 555 0100' }, 'nanp'],
    [{ phone: '+44 20 7946 0000' }, 'non_nanp'],
    [{ phone: '+52 55 5555 5555' }, 'non_nanp'],
    [{ phone: '0044 20 7946 0000' }, 'non_nanp'],
    [{ phone: '011 33 1 23 45 67 89' }, 'non_nanp'],
    [{ phone: '555-0100' }, 'unknown'],
    [{ postalCodes: ['07102'] }, 'nanp'],
    [{ postalCodes: ['07102-1234'] }, 'nanp'],
    [{ postalCodes: ['M5V 2T6'] }, 'nanp'],
    [{ postalCodes: ['SW1A 1AA'] }, 'non_nanp'],
    [{ postalCodes: ['1000-001'] }, 'non_nanp'],
    [{ postalCodes: ['7102'] }, 'unknown'],
    [{ postalCodes: ['110001'] }, 'unknown'],
    [{ postalCodes: [null, undefined, ''] }, 'unknown'],
    //  Any positive non-NANP signal wins over a NANP one.
    [{ phone: '+1 973 555 0100', postalCodes: ['SW1A 1AA'] }, 'non_nanp'],
    [{ phone: '+44 20 7946 0000', postalCodes: ['07102'] }, 'non_nanp'],
    [{ country: 'US' }, 'nanp'],
    [{ country: 'ca' }, 'nanp'],
    [{ country: 'MX', phone: '(973) 555-0100' }, 'non_nanp'],
  ]
  for (const [input, expected] of table) assert.equal(deriveRegionSignal(input), expected, JSON.stringify(input))
})

// ── limits sized for real customers (2026-09-16) ─────────────────────────────

test('grantLimits: defaults, an explicit override, and a blank, invalid, zero or negative value never means "withhold everyone"', async () => {
  const { grantLimits } = await import('../consent/grant-safeguards')
  assert.deepEqual(grantLimits({}), { perIpDistinctEmails24h: GRANT_LIMITS.perIpDistinctEmails24h, globalGrants24h: GRANT_LIMITS.globalGrants24h, popupGrants24h: GRANT_LIMITS.popupGrants24h })
  assert.ok(GRANT_LIMITS.perIpDistinctEmails24h >= 5, 'a household or office sharing one connection fits')
  assert.ok(GRANT_LIMITS.globalGrants24h >= 100)
  assert.deepEqual(
    grantLimits({ CONSENT_IP_DISTINCT_EMAILS_24H: '8', CONSENT_GLOBAL_GRANTS_24H: ' 250 ', CONSENT_POPUP_GRANTS_24H: '40' }),
    { perIpDistinctEmails24h: 8, globalGrants24h: 250, popupGrants24h: 40 },
  )
  for (const bad of ['', '   ', 'abc', '0', '-3', '2.5']) {
    assert.deepEqual(
      grantLimits({ CONSENT_IP_DISTINCT_EMAILS_24H: bad, CONSENT_GLOBAL_GRANTS_24H: bad, CONSENT_POPUP_GRANTS_24H: bad }),
      grantLimits({}),
      JSON.stringify(bad),
    )
  }
})

test('the global breaker counts DISTINCT addresses: one person submitting many forms never trips it', async () => {
  const db = createFakeConsentDb()
  //  The limit's worth of events, all from ONE other address.
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h + 5; i++) grantEvent(db, 'busy.customer@example.com', NOW, { ipHmac: `ip_one_${i % 3}` })
  const d = deps(db)
  assert.equal((await evaluateGrantSafeguards(base, d)).grant, true)
  assert.equal(d.alerts.length, 0)
})

test('the global breaker withholds only NEW addresses once the limit is reached; an already-granted address is not a new one', async () => {
  const db = createFakeConsentDb()
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h; i++) grantEvent(db, `g${i}@example.com`, NOW, { ipHmac: `ip_g${i}` })
  const d = deps(db)
  const tripped = await evaluateGrantSafeguards(base, d)
  assert.equal(tripped.grant === false ? tripped.reason : null, 'global_breaker')
  assert.equal(d.alerts.length, 1)
  //  g0 was granted earlier today: their next form is not counted against the breaker.
  assert.equal((await evaluateGrantSafeguards({ ...base, email: 'g0@example.com' }, deps(db))).grant, true)
})

test('the popup breaker keeps popup spam from using up the budget quote and booking customers need', async () => {
  const db = createFakeConsentDb()
  for (let i = 0; i < GRANT_LIMITS.popupGrants24h; i++) grantEvent(db, `p${i}@example.com`, NOW, { surface: 'popup', ipHmac: `ip_p${i}` })
  const d = deps(db)
  const popup = await evaluateGrantSafeguards({ ...base, surface: 'popup', sequenceKind: 'lead_nurture' }, d)
  assert.equal(popup.grant, false)
  assert.equal(popup.grant === false ? popup.reason : null, 'popup_breaker')
  assert.equal(d.alerts.length, 1)
  assert.match(d.alerts[0], /popup/)
  //  A quote customer is unaffected: the global breaker is far from its limit.
  assert.equal((await evaluateGrantSafeguards({ ...base, surface: 'quote' }, deps(db))).grant, true)
  //  And an env override raises the popup limit without a deploy.
  const raised = deps(db, { env: { ...ENV, CONSENT_POPUP_GRANTS_24H: String(GRANT_LIMITS.popupGrants24h + 10) } })
  assert.equal((await evaluateGrantSafeguards({ ...base, surface: 'popup', sequenceKind: 'lead_nurture' }, raised)).grant, true)
})

test('consentIpKey: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 grouped by its /64', async () => {
  const { consentIpKey } = await import('../consent/grant-safeguards')
  assert.equal(consentIpKey('203.0.113.7'), '203.0.113.7')
  assert.equal(consentIpKey('::ffff:198.51.100.4'), '198.51.100.4')
  assert.equal(consentIpKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), consentIpKey('2001:DB8:1:2::1'))
  assert.notEqual(consentIpKey('2001:db8:1:2::1'), consentIpKey('2001:db8:1:3::1'))
  assert.equal(consentIpKey('[2001:db8::1]'), consentIpKey('2001:db8:0:0:ffff::9'))
  assert.equal(consentIpKey('fe80::1%eth0'), consentIpKey('fe80::2'))
  for (const none of ['', '   ', 'unknown', null, undefined]) assert.equal(consentIpKey(none as string | null | undefined), null)
  assert.equal(consentIpHmac('2001:db8:1:2::1', ENV), consentIpHmac('2001:db8:1:2:ffff:1:2:3', ENV))
})
