// ════════════════════════════════════════════════════════════════════════
//  offer-signup.test.ts — the 10%-off popup as an ORDINARY FORM
//  (owner direction 2026-09-16: no separate opt-in or confirmation step;
//  every genuine submission enters the most appropriate EXISTING sequence,
//  which for the popup is the general lead nurture).
//  ---------------------------------------------------------------------
//  Drives the REAL route POST/GET/OPTIONS /api/leads/offer-signup, the REAL
//  processOfferSignup, applyCaptureBasis (with its production storeLeadBasis),
//  grant safeguards and consent event writer, against an in-memory Prisma (the
//  consent fake, plus Lead.update and an EmailSend ledger that records any
//  access) and a MOCKED Resend SDK whose calls are counted. Offline: no
//  Postgres, no Redis, no network, no email.
//
//  The lead save is a spy (captureLead) so the ORDER can be proven: the lead
//  first, then the notice, then the sequence request. The journeys' scenario
//  start (onNoticeSubmission — it pulls in the queues) is replaced by a
//  stand-in that records its input and asks the SAME real gate the lead
//  nurture asks before it schedules (promotionalEligibility, scenario_flow,
//  the lead, lead_nurture) against the fake database: it answers three stages
//  scheduled (+4h/+24h/+72h) when the gate permits, and the gate's refusal
//  otherwise. The journeys' own refusals (has_quote, previous_customer, the
//  enrollment claim) are pinned in the journeys suites.
//
//  Every address is @example.com, a reserved test domain, so the grant
//  safeguards run with "not a test identity" injected (one case keeps the real
//  check to prove a test identity changes nothing the visitor can see).
//
//  The bounded wait for scheduling (START_SCENARIO_WAIT_MS) runs on node:test
//  MOCKED setTimeout, so no case really waits for it. A concurrent form on the
//  same lead is simulated inside the fake Lead compare-and-set
//  (concurrentBasisWrite), between the production storeLeadBasis read and its
//  write.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { render } from '@react-email/render'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'

assertNoProductionCredentials()

//  An .invalid host (RFC 6761): it can never resolve.
process.env.APP_URL = 'https://api.offline-suite.invalid'
process.env.EMAIL_TOKEN_SECRET = 'offer-signup-test-secret-0123456789abcdef'
process.env.CONSENT_IP_HMAC_SECRET = 'offer-signup-ip-secret-0123456789'
for (const k of [
  'EMAIL_SENDING_ENABLED',
  'EMAIL_PROMOTIONAL_ALLOWLIST',
  'TURNSTILE_SECRET_KEY',
  'TURNSTILE_ENABLED',
  'EMAIL_REQUIRE_TURNSTILE',
  //  The route's per-IP limiter would call Upstash over the network.
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'CORS_ALLOWED_ORIGINS',
  'OFFER_SIGNUP_ENABLED',
  'EMAIL_NOTICE_BASIS_ENABLED',
]) {
  delete process.env[k]
}

// ── The in-memory Prisma, installed BEFORE anything imports db.ts ─────────
type Row = Record<string, any>
let consentDb = createFakeConsentDb()

/** Every EmailSend call. Nothing on this path may even touch the send ledger. */
const ledger: string[] = []
const emailSend = new Proxy(
  {},
  {
    get(_t, method) {
      if (typeof method !== 'string' || method === 'then') return undefined
      return async () => {
        ledger.push(method)
        return null
      }
    },
  },
)

/**
 * The consent fake's Lead model (findMany, findUnique) plus the one write the
 * production storeLeadBasis makes: it reads the lead's current basis
 * (lead.findUnique), that event's surface (emailConsentEvent.findUnique, on
 * the fake), and only then points the lead at the new notice (lead.update).
 */
/** Every Lead compare-and-set the production storeLeadBasis made, in order. */
const leadBasisWrites: Array<{ where: Row; data: Row }> = []
/**
 * Another form's basis write on the same lead, landing AFTER storeLeadBasis
 * read the lead and BEFORE its compare-and-set is evaluated. Called with the
 * 1-based write number and that write's arguments. Null: no concurrent form.
 */
let concurrentBasisWrite: ((call: number, where: Row, data: Row) => void) | null = null

const leadModel = () => ({
  ...(consentDb as Row).lead,
  //  The production basis write is a compare-and-set on the value it read.
  async updateMany({ where, data }: Row) {
    leadBasisWrites.push({ where: { ...where }, data: { ...data } })
    concurrentBasisWrite?.(leadBasisWrites.length, where, data)
    const hits = consentDb.tables.leads.filter(
      (l: Row) => l.id === where.id && (!('basisEventId' in where) || (l.basisEventId ?? null) === where.basisEventId),
    )
    for (const h of hits) Object.assign(h, data)
    return { count: hits.length }
  },
  async update({ where, data, select }: Row) {
    const row = consentDb.tables.leads.find((l: Row) => l.id === where.id)
    if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
    Object.assign(row, data)
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row }
  },
})

;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy(
  {},
  {
    get(_t, prop: string) {
      if (prop === 'emailSend') return emailSend
      if (prop === 'lead') return leadModel()
      return (consentDb as Row)[prop]
    },
  },
)

import type { FetchLike } from '../consent/grant-safeguards'
import type { SequenceKind } from '../consent/notice-registry'
import type { OfferSignupDeps, OfferSignupAttribution } from '../offer-signup'
import type { CaptureBasisInput, CaptureBasisOutcome } from '../capture-basis'
import type { EnrolmentOutcome, NoticeSubmissionInput } from '../journeys'

type Handler = (req: Request) => Promise<Response>
let SIGNUP: { POST: Handler; GET: Handler; OPTIONS: Handler }
let mod: typeof import('../offer-signup')
let basis: typeof import('../capture-basis')
let grant: typeof import('../consent/grant-safeguards')
let events: typeof import('../consent/consent-events')
let registry: typeof import('../consent/notice-registry')
let eligibility: typeof import('../consent/marketing-eligibility')
let resend: typeof import('../resend')['resend']
let PRODUCTION_SIGNUP: OfferSignupDeps

before(async () => {
  SIGNUP = (await import('../../../app/api/leads/offer-signup/route')) as never
  mod = await import('../offer-signup')
  basis = await import('../capture-basis')
  grant = await import('../consent/grant-safeguards')
  events = await import('../consent/consent-events')
  registry = await import('../consent/notice-registry')
  eligibility = await import('../consent/marketing-eligibility')
  ;({ resend } = await import('../resend'))
  //  Captured before any test replaces it.
  PRODUCTION_SIGNUP = mod.offerSignupDeps()
})

const poisonedFetch: FetchLike = async () => {
  throw new Error('network is forbidden in this suite')
}

// ── Per-test spies ──────────────────────────────────────────────────────────
let restores: Array<() => void>
let realIdentity: boolean
let failLeadSave: 'null' | 'throw' | null
/** The order the three popup steps ran in. */
let order: string[]
let captured: Array<{ email: string; attribution: OfferSignupAttribution }>
let applyInputs: CaptureBasisInput[]
let outcomes: CaptureBasisOutcome[]
let started: Array<EnrolmentOutcome | null>
let evaluated: Array<{ surface?: string; grant: string; sequenceKind: unknown }>
/** journeys.onNoticeSubmission — what the popup asked the journeys to start. */
let journeyCalls: NoticeSubmissionInput[]
/** …and what the stand-in answered, index for index. */
let journeyAnswers: EnrolmentOutcome[]

beforeEach(() => {
  consentDb = createFakeConsentDb()
  ledger.length = 0
  leadBasisWrites.length = 0
  concurrentBasisWrite = null
  realIdentity = false
  failLeadSave = null
  order = []
  captured = []
  applyInputs = []
  outcomes = []
  started = []
  evaluated = []
  journeyCalls = []
  journeyAnswers = []
  restores = []
  process.env.OFFER_SIGNUP_ENABLED = 'true'
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'

  restores.push(
    mod.__setOfferSignupDeps({
      async captureLead(email, attribution) {
        order.push('captureLead')
        captured.push({ email, attribution })
        if (failLeadSave === 'throw') throw new Error('simulated lead table outage')
        if (failLeadSave === 'null') return null
        //  A repeat submission merges into the address's open lead, as
        //  ingestLeadSafe does; a new address gets a new lead.
        const existing = consentDb.tables.leads.find((l: Row) => l.email === email)
        if (existing) return existing.id as string
        const id = `lead_${consentDb.tables.leads.length + 1}`
        consentDb.tables.leads.push({ id, email, basisEventId: null })
        return id
      },
      async applyBasis(input) {
        order.push('applyBasis')
        applyInputs.push(input)
        const out = await PRODUCTION_SIGNUP.applyBasis(input)
        outcomes.push(out)
        return out
      },
      async startScenario(outcome, subject) {
        order.push('startScenario')
        const r = await PRODUCTION_SIGNUP.startScenario(outcome, subject)
        started.push(r)
        return r
      },
    }),
    basis.__setCaptureBasisDeps({
      evaluate(input) {
        evaluated.push({ surface: input.surface, grant: input.grant, sequenceKind: input.sequenceKind })
        return grant.evaluateGrantSafeguards(input, {
          fetch: poisonedFetch,
          alert: async () => undefined,
          ...(realIdentity ? {} : { testIdentity: async () => null }),
        })
      },
      async startScenario(input): Promise<EnrolmentOutcome> {
        journeyCalls.push(input)
        //  The gate reads the lead's STORED basis: a "scheduled" answer proves
        //  the notice was stored on the lead before the journey was asked.
        const decision = await flowEligibility(input.email, input.leadId, input.scenario)
        const answer: EnrolmentOutcome = decision.eligible ? { scheduled: true, stages: 3 } : { scheduled: false, reason: decision.reason }
        journeyAnswers.push(answer)
        return answer
      },
      async personOptedOut() {
        return undefined
      },
    }),
  )
})

afterEach(() => {
  for (const r of restores.reverse()) r()
  delete process.env.OFFER_SIGNUP_ENABLED
  delete process.env.EMAIL_NOTICE_BASIS_ENABLED
})

const ORIGIN = 'https://www.moveitclearit.com'
const ENDPOINT = 'https://api.example.com/api/leads/offer-signup'
const EXPECTED_BODY = { ok: true, code: 'MOVE10' }
const POPUP_VERSION = 'popup-2026-09-16-r2'
const QUOTE_VERSION = 'quote-2026-09-16-r2'
/** What the stand-in journey answers when the gate permits the lead nurture. */
const NURTURE_SCHEDULED: EnrolmentOutcome = { scheduled: true, stages: 3 }

let ipSeq = 0
function signup(body: unknown, ip = `198.51.100.${++ipSeq % 250}`): Promise<Response> {
  return SIGNUP.POST(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-real-ip': ip,
        'user-agent': 'Mozilla/5.0 (offline test)',
        referer: 'https://www.moveitclearit.com/pricing.html?email=leak%40example.com#top',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const POPUP = { marketingNotice: { version: POPUP_VERSION, trigger: 'submit' }, emailUserTyped: true, locale: 'en' }
const body = (email: string, extra: Record<string, unknown> = {}) => {
  assertTestRecipient(email)
  return { email, ...POPUP, ...extra }
}

const ok = async () => ({ data: { id: `prov_${Math.random().toString(36).slice(2)}` }, error: null })
const kinds = () => consentDb.tables.events.map((e: Row) => e.kind)
const leadOf = (email: string): Row | undefined => consentDb.tables.leads.find((l: Row) => l.email === email)
const eligibilityDeps = () => ({ db: consentDb as never, env: { EMAIL_NOTICE_BASIS_ENABLED: 'true' }, testIdentity: async () => null })
const campaignEligibility = (email: string) => eligibility.promotionalEligibility({ context: 'campaign', email }, eligibilityDeps())
/** The question the lead-nurture journey and the send gate ask for a lead. */
const flowEligibility = (email: string, leadId: string | null | undefined, sequenceKind: SequenceKind) =>
  eligibility.promotionalEligibility(
    { context: 'scenario_flow', email, subject: { type: 'lead', id: leadId ?? null, sequenceKind } },
    eligibilityDeps(),
  )

// ══════════════════════════════════════════════════════════════════════
//  THE FLAG AND THE WIRE
// ══════════════════════════════════════════════════════════════════════

test('flag OFF (the default): POST, GET and OPTIONS are all 404, and nothing is written, started or sent', async (t) => {
  delete process.env.OFFER_SIGNUP_ENABLED
  const send = t.mock.method(resend.emails, 'send', ok)

  const post = await signup(body('flag.off@example.com'))
  assert.equal(post.status, 404)
  assert.deepEqual(await post.json(), { ok: false, error: 'not_found' })
  assert.equal((await signup('{not json')).status, 404, 'dark means dark: not even a 400 for junk')

  const dark = await SIGNUP.GET(new Request(ENDPOINT, { headers: { origin: ORIGIN } }))
  assert.equal(dark.status, 404, 'the popup asks GET before opening: dark means it stays closed')
  assert.equal(dark.headers.get('access-control-allow-origin'), null, 'no CORS while dark, so the browser reports a failed request')

  const preflight = await SIGNUP.OPTIONS(new Request(ENDPOINT, { method: 'OPTIONS', headers: { origin: ORIGIN } }))
  assert.equal(preflight.status, 404)
  assert.equal(preflight.headers.get('access-control-allow-origin'), null)

  assert.deepEqual(order, [], 'no lead saved')
  assert.equal(consentDb.tables.leads.length, 0)
  assert.equal(consentDb.tables.events.length, 0)
  assert.equal(consentDb.tables.status.length, 0)
  assert.deepEqual(journeyCalls, [], 'no sequence is requested while dark')
  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)
})

test('flag ON: GET answers the popup availability question with CORS and no-store, and touches nothing', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const res = await SIGNUP.GET(new Request(ENDPOINT, { headers: { origin: ORIGIN } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, available: true }, 'nothing but the flag')
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN, 'readable by the popup on the site')
  assert.equal(res.headers.get('cache-control'), 'no-store', 'turning the flag off must take effect at once')
  assert.equal(res.headers.get('vary'), 'Origin')

  const preflight = await SIGNUP.OPTIONS(new Request(ENDPOINT, { method: 'OPTIONS', headers: { origin: ORIGIN } }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN)
  assert.match(String(preflight.headers.get('access-control-allow-methods')), /\bPOST\b/)

  const foreign = await SIGNUP.GET(new Request(ENDPOINT, { headers: { origin: 'https://evil.example.com' } }))
  assert.notEqual(foreign.headers.get('access-control-allow-origin'), 'https://evil.example.com', 'an unlisted origin is never echoed')

  assert.deepEqual(order, [])
  assert.equal(consentDb.tables.events.length, 0)
  assert.deepEqual(journeyCalls, [])
  assert.equal(send.mock.callCount(), 0)
})

test('malformed input is the ONLY 400; lenient optional fields never turn a real address into an error', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  for (const bad of ['{not json', { locale: 'en' }, { email: 'not-an-email' }, { email: 42 }, { email: '' }]) {
    const res = await signup(bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
    assert.deepEqual(await res.json(), { ok: false, error: 'invalid_request' }, 'names no field value')
  }
  assert.deepEqual(order, [], 'a malformed request saves nothing')
  assert.equal(consentDb.tables.events.length, 0)

  const junk = await signup({
    email: 'junk.fields@example.com',
    marketingNotice: 'garbage',
    emailUserTyped: 'yes',
    locale: { nope: true },
    utmSource: 12345,
    company: 7,
    turnstileToken: ['x'],
  })
  assert.equal(junk.status, 200)
  assert.deepEqual(await junk.json(), EXPECTED_BODY)
  assert.deepEqual(order, ['captureLead', 'applyBasis', 'startScenario'], 'the lead is still saved')
  assert.deepEqual(journeyCalls, [], 'a dropped (junk) notice starts no sequence')
  assert.equal(send.mock.callCount(), 0)
})

test('the response is IDENTICAL for a new, repeat, suppressed, unsubscribed, opted-out, test-identity, forged, noticeless, honeypot or throttled signup', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  assert.deepEqual(mod.offerSignupResponseBody(), EXPECTED_BODY)
  assert.deepEqual(Object.keys(mod.offerSignupResponseBody()).sort(), ['code', 'ok'], 'no terms, no confirmationRequired, nothing else')

  const seen: string[] = []
  const grab = async (label: string, res: Response) => {
    assert.equal(res.status, 200, label)
    const headers = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b))
    seen.push(JSON.stringify({ body: await res.json(), headers }))
  }
  await grab('new', await signup(body('fresh@example.com')))
  await grab('repeat', await signup(body('fresh@example.com')))
  await grab('case and spaces', await signup(body('fresh@example.com', { email: '  FRESH@Example.com ' })))
  consentDb.tables.suppressions.push({ email: 'gone@example.com', reason: 'HARD_BOUNCE', scope: 'all' })
  await grab('hard-bounced', await signup(body('gone@example.com')))
  consentDb.tables.suppressions.push({ email: 'left@example.com', reason: 'UNSUBSCRIBED', scope: 'promotional' })
  await grab('unsubscribed', await signup(body('left@example.com')))
  const boxed = await events.recordConsentEvent({
    email: 'boxed@example.com',
    kind: 'opted_out_at_capture',
    surface: 'quote',
    requestId: 'quote:submit:offline-boxed:0',
    optOutBox: true,
    occurredAt: new Date(Date.now() - 60 * 60 * 1000),
  })
  assert.ok(boxed.ok)
  await grab('opted out on an earlier form', await signup(body('boxed@example.com')))
  await grab('forged notice', await signup(body('forged@example.com', { marketingNotice: { version: QUOTE_VERSION, trigger: 'submit' } })))
  await grab('no notice', await signup({ email: 'old.popup@example.com' }))
  await grab('honeypot', await signup(body('bot@example.com', { company: 'Acme Bots' })))
  //  One more distinct address from ONE client IP than the limit allows: the last grant is throttled.
  for (let i = 0; i <= grant.GRANT_LIMITS.perIpDistinctEmails24h; i++) await grab(`ip throttle ${i}`, await signup(body(`throttle${i}@example.com`), '203.0.113.200'))
  realIdentity = true
  await grab('test identity', await signup(body('staff.like@example.com')))

  assert.equal(new Set(seen).size, 1, seen.join('\n'))
  assert.deepEqual(JSON.parse(seen[0]).body, EXPECTED_BODY)

  //  …while what happened behind it did differ.
  const reasons = consentDb.tables.events.filter((e: Row) => e.kind === 'basis_withheld').map((e: Row) => e.withheldReason)
  assert.ok(reasons.includes('ip_throttle'), `throttled behind the identical answer: ${reasons}`)
  assert.ok(reasons.includes('reserved_address'), `test identity refused behind the identical answer: ${reasons}`)
  assert.ok(reasons.includes('unknown_notice_version'))
  assert.ok(!reasons.includes('already_enrolled'), 'a repeat is recorded like any other submission, never withheld per address')

  //  Only a granted notice asks for a sequence, and only the lead nurture.
  assert.ok(journeyCalls.every((c) => c.surface === 'popup' && c.scenario === 'lead_nurture'))
  assert.deepEqual(
    [...new Set(journeyCalls.map((c) => c.email))].sort(),
    ['boxed@example.com', 'fresh@example.com', 'gone@example.com', 'left@example.com', ...Array.from({ length: grant.GRANT_LIMITS.perIpDistinctEmails24h }, (_, i) => `throttle${i}@example.com`)].sort(),
    'no sequence for a forged, noticeless, honeypot, throttled or test-identity signup',
  )
  //  A prohibited address is asked about and REFUSED by the gate.
  const answerFor = (email: string) => journeyAnswers[journeyCalls.findIndex((c) => c.email === email)]
  assert.deepEqual(answerFor('gone@example.com'), { scheduled: false, reason: 'suppressed' })
  assert.deepEqual(answerFor('left@example.com'), { scheduled: false, reason: 'suppressed' })
  assert.deepEqual(answerFor('boxed@example.com'), { scheduled: false, reason: 'opted_out' })
  assert.deepEqual(answerFor('fresh@example.com'), NURTURE_SCHEDULED)

  assert.equal(send.mock.callCount(), 0, 'no signup, of any kind, sends an email from the request')
  assert.equal(ledger.length, 0)
  //  The per-IP REQUEST limiter (LIMITS.coupon) is fail-open without Upstash,
  //  so its "rate limited" branch cannot be reached offline; it returns the
  //  same offerSignupResponseBody() by construction.
})

// ══════════════════════════════════════════════════════════════════════
//  WHAT HAPPENS BEHIND THE RESPONSE
// ══════════════════════════════════════════════════════════════════════

test('honeypot or unusable address: processOfferSignup discards — nothing saved, nothing evaluated, no event, nothing started', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const res = await signup(body('bot.route@example.com', { company: 'Acme Bots' }))
  assert.deepEqual(await res.json(), EXPECTED_BODY)
  assert.deepEqual(order, [], 'the route discards a bot before the lead is saved')

  const calls: string[] = []
  const deps: OfferSignupDeps = {
    captureLead: async () => {
      calls.push('captureLead')
      return 'lead_x'
    },
    applyBasis: async () => {
      calls.push('applyBasis')
      return { status: 'none', reason: 'no_notice' }
    },
    startScenario: async () => {
      calls.push('startScenario')
      return null
    },
  }
  const client = { ip: '198.51.100.9', userAgent: null, pageUrl: null }
  assert.deepEqual(
    await mod.processOfferSignup({ email: 'bot@example.com', honeypot: 'Acme Bots', marketingNotice: POPUP.marketingNotice, client }, deps),
    { status: 'discarded', reason: 'honeypot' },
  )
  for (const email of ['two@@example.com', 'has space@example.com', '@example.com', 'nobody@', '']) {
    assert.deepEqual(await mod.processOfferSignup({ email, client }, deps), { status: 'discarded', reason: 'invalid_email' }, JSON.stringify(email))
  }
  assert.deepEqual(calls, [], 'a discarded submission reaches no dependency')

  //  A whitespace-only honeypot is an autofill quirk, not a bot.
  const spaced = await mod.processOfferSignup({ email: 'real.person@example.com', honeypot: '   ', client }, deps)
  assert.equal(spaced.status, 'saved')

  assert.equal(consentDb.tables.leads.length, 0)
  assert.equal(consentDb.tables.events.length, 0)
  assert.deepEqual(evaluated, [])
  assert.deepEqual(journeyCalls, [], 'a bot starts no sequence')
  assert.equal(send.mock.callCount(), 0)
})

test('granted: the lead is saved FIRST, a popup notice_accepted (never an opt-in) is stored on the lead, then the lead enters lead_nurture; no email from the request', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const email = 'granted.person@example.com'
  const res = await signup(body(email))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), EXPECTED_BODY)

  // 1. Order: lead → notice → sequence request.
  assert.deepEqual(order, ['captureLead', 'applyBasis', 'startScenario'])
  assert.equal(captured[0].email, email)
  const input = applyInputs[0]
  assert.equal(input.surface, 'popup', 'the surface is the route’s, never the body’s')
  assert.equal(input.scenario, 'lead_nurture', 'the popup names the existing general lead nurture')
  assert.equal(input.acceptTrigger, 'submit')
  assert.equal(input.leadId, 'lead_1', 'the notice names the lead that was already saved')
  assert.deepEqual(input.contract, { marketingNotice: POPUP.marketingNotice, emailUserTyped: true, turnstileToken: undefined })

  // 2. The safeguards ran for a popup notice naming the lead nurture.
  assert.deepEqual(evaluated, [{ surface: 'popup', grant: 'notice', sequenceKind: 'lead_nurture' }])

  // 3. The event: a notice, registered copy, never an opt-in.
  assert.deepEqual(kinds(), ['notice_accepted'])
  const event = consentDb.tables.events[0]
  assert.equal(event.surface, 'popup')
  assert.equal(event.noticeVersion, POPUP_VERSION)
  assert.equal(event.noticeCopySha256, registry.NOTICE_VERSIONS[POPUP_VERSION].copySha256.en)
  assert.equal(event.locale, 'en')
  assert.equal(event.leadId, 'lead_1')
  assert.equal(event.trigger, 'submit')
  assert.equal(event.emailUserTyped, true)
  assert.equal(event.optOutBox, false)
  assert.match(String(event.ipHmac), /^[0-9a-f]{64}$/, 'the IP is stored keyed-hashed')
  assert.equal(event.pageUrl, 'https://www.moveitclearit.com/pricing.html', 'no query string or fragment is stored')
  assert.ok(!kinds().includes('express_opt_in'), 'a form submission is never an opt-in')

  // 4. The status and the lead point at it.
  const status = consentDb.tables.status[0]
  assert.equal(status.expressOptInAt, null)
  assert.ok(status.lastNoticeAt instanceof Date)
  assert.equal(status.lastNoticeEventId, event.id)
  assert.equal(consentDb.tables.leads[0].basisEventId, event.id)
  assert.equal(consentDb.tables.leads[0].emailMarketingConsent, undefined, 'no consent column is written')
  assert.deepEqual(outcomes[0], { status: 'granted', eventId: event.id, created: true, stored: true, scenario: 'lead_nurture' })

  // 5. The journey is asked for the lead nurture, naming the stored notice.
  assert.deepEqual(journeyCalls, [
    { surface: 'popup', scenario: 'lead_nurture', leadId: 'lead_1', bookingId: null, basisEventId: event.id, email },
  ])
  assert.deepEqual(started, [NURTURE_SCHEDULED], 'the gate read the STORED basis: stored before the journey was asked')

  // 6. The request itself sends nothing: the stages are queued jobs, each
  //    rechecked at send time.
  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)

  // 7. What the notice permits: owner-approved offers (campaigns), and the
  //    lead nurture — never a quote follow-up or an abandoned-checkout flow.
  const campaign = await campaignEligibility(email)
  assert.deepEqual(campaign, { eligible: true, basis: 'notice', basisEventId: event.id })
  for (const sequenceKind of registry.SEQUENCE_KINDS) {
    const flow = await flowEligibility(email, 'lead_1', sequenceKind)
    if (sequenceKind === 'lead_nurture') {
      assert.deepEqual(flow, { eligible: true, basis: 'notice', basisEventId: event.id }, 'a popup notice permits the lead nurture')
    } else {
      assert.equal(flow.eligible, false, `a popup notice never permits ${sequenceKind}`)
      assert.equal((flow as { detail?: string }).detail, 'sequence_not_in_scenario')
    }
  }
})

test('granted in Spanish: the Spanish copy hash is recorded, and the lead still enters lead_nurture', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  await signup(body('persona@example.com', { locale: 'es-US' }))
  const event = consentDb.tables.events[0]
  assert.equal(event.kind, 'notice_accepted')
  assert.equal(event.locale, 'es', 'the basis locale the nurture stages are rendered in')
  assert.equal(event.noticeCopySha256, registry.NOTICE_VERSIONS[POPUP_VERSION].copySha256.es)
  assert.equal(outcomes[0].status, 'granted')
  assert.equal((outcomes[0] as { scenario: unknown }).scenario, 'lead_nurture')
  assert.deepEqual(started, [NURTURE_SCHEDULED])

  const direct = await mod.processOfferSignup({
    email: 'Directo@Example.com',
    locale: 'es',
    marketingNotice: POPUP.marketingNotice,
    emailUserTyped: true,
    client: { ip: '198.51.100.251', userAgent: null, pageUrl: null },
  })
  assert.deepEqual(direct, { status: 'saved', leadId: 'lead_2', basis: 'granted:lead_nurture', scheduled: true })
  assert.equal(captured[1].email, 'directo@example.com', 'the address is normalized before it is saved')
  assert.deepEqual(
    journeyCalls.map((c) => [c.scenario, c.leadId, c.email]),
    [
      ['lead_nurture', 'lead_1', 'persona@example.com'],
      ['lead_nurture', 'lead_2', 'directo@example.com'],
    ],
  )
  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)
})

test('a repeat popup signup records another notice (no per-address withhold) on the SAME lead and asks the journey again', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const email = 'again@example.com'
  await signup(body(email))
  await signup(body(email))

  assert.deepEqual(kinds(), ['notice_accepted', 'notice_accepted'], 'the latest submission is on the record too')
  assert.deepEqual(evaluated.map((e) => e.sequenceKind), ['lead_nurture', 'lead_nurture'])
  assert.equal(consentDb.tables.leads.length, 1, 'the repeat merges into the open lead')
  const [first, second] = consentDb.tables.events
  assert.equal(leadOf(email)?.basisEventId, second.id, 'a popup notice replaces an earlier popup notice on the lead')
  //  (No status assertion: both submissions can land in the same millisecond,
  //  and the forward-only status write correctly ignores a tie.)
  assert.deepEqual(
    journeyCalls.map((c) => [c.leadId, c.basisEventId]),
    [
      ['lead_1', first.id],
      ['lead_1', second.id],
    ],
  )
  //  One lead nurture per person is the journey's enrollment claim (pinned in
  //  the journeys suites), not something the popup withholds.
  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)
})

test('a popup signup on a lead that runs a quote follow-up: the notice is recorded, the quote basis is KEPT, and nothing new starts', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const email = 'quoted.person@example.com'
  const quoteNotice = await events.recordConsentEvent({
    email,
    kind: 'notice_accepted',
    surface: 'quote',
    requestId: 'quote:submit:offline-quote:0',
    leadId: 'lead_1',
    noticeVersion: QUOTE_VERSION,
    noticeCopySha256: registry.NOTICE_VERSIONS[QUOTE_VERSION].copySha256.en,
    locale: 'en',
    regionSignal: 'unknown',
    trigger: 'submit',
    emailUserTyped: true,
    optOutBox: false,
    occurredAt: new Date(Date.now() - 60 * 1000),
  })
  if (!quoteNotice.ok) return assert.fail(`quote notice not recorded: ${quoteNotice.reason}`)
  const quoteEventId = quoteNotice.event.id
  consentDb.tables.leads.push({ id: 'lead_1', email, basisEventId: quoteEventId })

  assert.deepEqual(await (await signup(body(email))).json(), EXPECTED_BODY)
  assert.deepEqual(order, ['captureLead', 'applyBasis', 'startScenario'])
  assert.equal(consentDb.tables.leads.length, 1, 'merged into the quote lead')
  assert.deepEqual(kinds(), ['notice_accepted', 'notice_accepted'])
  const popupEvent = consentDb.tables.events[1]
  assert.equal(popupEvent.surface, 'popup')
  assert.deepEqual(outcomes[0], { status: 'granted', eventId: popupEvent.id, created: true, stored: false, scenario: 'lead_nurture' })
  assert.equal(leadOf(email)?.basisEventId, quoteEventId, 'replacing it would end the running quote follow-ups at send time')
  assert.equal(consentDb.tables.status[0].lastNoticeEventId, popupEvent.id, 'the latest submission still counts for offers')
  assert.deepEqual(started, [null])
  assert.deepEqual(journeyCalls, [], 'the lead already runs the more specific sequence')
  assert.deepEqual(await flowEligibility(email, 'lead_1', 'quote_followup'), { eligible: true, basis: 'notice', basisEventId: quoteEventId })

  const direct = await mod.processOfferSignup({
    email,
    locale: 'en',
    marketingNotice: POPUP.marketingNotice,
    emailUserTyped: true,
    client: { ip: '198.51.100.252', userAgent: null, pageUrl: null },
  })
  assert.deepEqual(direct, { status: 'saved', leadId: 'lead_1', basis: 'granted:lead_nurture:not_stored', scheduled: null })
  assert.equal(leadOf(email)?.basisEventId, quoteEventId)
  assert.deepEqual(journeyCalls, [])
  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)
})

test('the lead could not be saved: nothing is recorded or started, and the visitor still gets the identical body', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  for (const mode of ['null', 'throw'] as const) {
    failLeadSave = mode
    order = []
    const res = await signup(body(`lead.${mode}@example.com`))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), EXPECTED_BODY)
    assert.deepEqual(order, ['captureLead'], `${mode}: no notice without a lead to name`)
  }
  failLeadSave = 'null'
  assert.deepEqual(
    await mod.processOfferSignup({ email: 'lead.null@example.com', client: { ip: null, userAgent: null, pageUrl: null } }),
    { status: 'error', reason: 'lead_not_saved' },
  )
  assert.equal(consentDb.tables.events.length, 0)
  assert.deepEqual(journeyCalls, [])
  assert.equal(send.mock.callCount(), 0)
})

// ══════════════════════════════════════════════════════════════════════
//  SCHEDULING IS BOUNDED: A SLOW QUEUE NEVER HOLDS UP THE CODE
// ══════════════════════════════════════════════════════════════════════

/** One macrotask turn: every promise callback queued so far has run. setImmediate is never mocked here. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
/** Flush until `cond` holds, for a bounded number of turns (never a wall-clock wait). */
async function until(cond: () => boolean, turns = 200): Promise<boolean> {
  for (let i = 0; i < turns && !cond(); i++) await flush()
  return cond()
}
type Watched<T> = { settled: boolean; value: T | undefined; error: unknown }
/** Observe a promise without awaiting it, so the test can tick the mocked clock meanwhile. */
function watch<T>(p: Promise<T>): Watched<T> {
  const w: Watched<T> = { settled: false, value: undefined, error: undefined }
  void p.then(
    (value) => {
      w.value = value
      w.settled = true
    },
    (err) => {
      w.error = err
      w.settled = true
    },
  )
  return w
}

const BOUNDED_CLIENT = { ip: '198.51.100.61', userAgent: null, pageUrl: null }
const GRANTED_OUTCOME: CaptureBasisOutcome = { status: 'granted', eventId: 'evt_bounded', created: true, stored: true, scenario: 'lead_nurture' }
/** processOfferSignup deps with the lead and the notice already done; only scheduling varies. */
const boundedDeps = (startScenario: OfferSignupDeps['startScenario']): OfferSignupDeps => ({
  captureLead: async () => 'lead_bounded',
  applyBasis: async () => GRANTED_OUTCOME,
  startScenario,
})

test('scheduling that never answers, or answers after the bound: processOfferSignup returns saved with scheduled null at exactly START_SCENARIO_WAIT_MS (mocked clock)', async (t) => {
  assert.ok(Number.isFinite(mod.START_SCENARIO_WAIT_MS) && mod.START_SCENARIO_WAIT_MS > 0, 'a real, finite bound')
  t.mock.timers.enable({ apis: ['setTimeout'] })

  for (const mode of ['never', 'after the bound'] as const) {
    const asked: Array<[CaptureBasisOutcome, unknown]> = []
    let lateAnswer = false
    const deps = boundedDeps(async (outcome, subject) => {
      asked.push([outcome, subject])
      if (mode === 'never') return await new Promise<EnrolmentOutcome | null>(() => undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, mod.START_SCENARIO_WAIT_MS + 1000))
      lateAnswer = true
      return NURTURE_SCHEDULED
    })
    const wallStart = performance.now()
    const result = watch(mod.processOfferSignup({ email: 'Slow.Queue@Example.com', marketingNotice: POPUP.marketingNotice, client: BOUNDED_CLIENT }, deps))

    assert.ok(await until(() => asked.length === 1), `${mode}: the nurture was requested`)
    await flush()
    assert.equal(result.settled, false, `${mode}: inside the bound the popup is still waiting on scheduling`)
    t.mock.timers.tick(mod.START_SCENARIO_WAIT_MS - 1)
    await flush()
    assert.equal(result.settled, false, `${mode}: one millisecond short of the bound, still waiting`)
    t.mock.timers.tick(1)
    assert.ok(await until(() => result.settled), `${mode}: the bound released the popup`)

    assert.equal(result.error, undefined, `${mode}: never throws`)
    assert.deepEqual(result.value, { status: 'saved', leadId: 'lead_bounded', basis: 'granted:lead_nurture', scheduled: null }, `${mode}: saved, scheduling unknown`)
    assert.ok(performance.now() - wallStart < mod.START_SCENARIO_WAIT_MS, `${mode}: the mocked clock, so nothing really waited`)
    assert.deepEqual(asked, [[GRANTED_OUTCOME, { surface: 'popup', email: 'slow.queue@example.com', leadId: 'lead_bounded' }]])
    assert.equal(lateAnswer, false, `${mode}: the popup did not wait for the answer`)

    if (mode === 'after the bound') {
      //  The scheduling carries on behind the answer; the reported outcome is final.
      const reported = structuredClone(result.value)
      t.mock.timers.tick(1000)
      assert.ok(await until(() => lateAnswer), 'the late scheduling still finished in the background')
      assert.deepEqual(result.value, reported, 'a late answer never rewrites the outcome already returned')
    }
  }
})

test('scheduling that answers inside the bound: its scheduled value is reported (true, false or null), without waiting for the bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cases: Array<[string, EnrolmentOutcome | null, boolean | null]> = [
    ['scheduled', NURTURE_SCHEDULED, true],
    ['refused by the journey', { scheduled: false, reason: 'already_enrolled' }, false],
    ['nothing to start', null, null],
  ]
  for (const [label, answer, scheduled] of cases) {
    const result = watch(mod.processOfferSignup({ email: 'quick.queue@example.com', client: BOUNDED_CLIENT }, boundedDeps(async () => answer)))
    const settled = await until(() => result.settled)
    if (!settled) t.mock.timers.tick(mod.START_SCENARIO_WAIT_MS) // release it, so a failure cannot hang the suite
    assert.ok(settled, `${label}: answered without the clock moving at all`)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.value, { status: 'saved', leadId: 'lead_bounded', basis: 'granted:lead_nurture', scheduled }, label)
  }

  //  An answer one millisecond inside the bound still counts.
  const result = watch(
    mod.processOfferSignup(
      { email: 'just.in.time@example.com', client: BOUNDED_CLIENT },
      boundedDeps(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, mod.START_SCENARIO_WAIT_MS - 1))
        return NURTURE_SCHEDULED
      }),
    ),
  )
  await flush()
  assert.equal(result.settled, false)
  t.mock.timers.tick(mod.START_SCENARIO_WAIT_MS - 1)
  assert.ok(await until(() => result.settled))
  assert.deepEqual(result.value, { status: 'saved', leadId: 'lead_bounded', basis: 'granted:lead_nurture', scheduled: true })
})

test('the route answers the IDENTICAL status, body and headers when scheduling is slower than the bound, and the nurture still starts behind it', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const snapshot = async (res: Response) => ({
    status: res.status,
    body: await res.json(),
    headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  })

  //  Scheduling that answers at once.
  const fast = await snapshot(await signup(body('fast.queue@example.com')))
  assert.deepEqual(started, [NURTURE_SCHEDULED])

  //  Scheduling that takes twice the bound (on the mocked clock).
  let asked = false
  let finished = false
  restores.push(
    mod.__setOfferSignupDeps({
      async startScenario(outcome, subject) {
        order.push('startScenario')
        asked = true
        await new Promise<void>((resolve) => setTimeout(resolve, mod.START_SCENARIO_WAIT_MS * 2))
        const r = await PRODUCTION_SIGNUP.startScenario(outcome, subject)
        started.push(r)
        finished = true
        return r
      },
    }),
  )
  order = []
  const wallStart = performance.now()
  const response = watch(signup(body('slow.queue@example.com')))
  assert.ok(await until(() => asked), 'the sequence was requested')
  await flush()
  assert.equal(response.settled, false, 'inside the bound the route is still waiting on scheduling')
  t.mock.timers.tick(mod.START_SCENARIO_WAIT_MS)
  assert.ok(await until(() => response.settled), 'the bound released the response')
  assert.equal(response.error, undefined)
  const slow = await snapshot(response.value!)
  assert.ok(performance.now() - wallStart < mod.START_SCENARIO_WAIT_MS, 'the mocked clock, so nothing really waited')

  assert.deepEqual(slow, fast, 'a slow queue changes nothing the visitor can see')
  assert.deepEqual(slow.body, EXPECTED_BODY)
  assert.equal(slow.status, 200)
  assert.deepEqual(order, ['captureLead', 'applyBasis', 'startScenario'])
  assert.equal(finished, false, 'answered before the scheduling finished')
  assert.deepEqual(journeyCalls.map((c) => c.email), ['fast.queue@example.com'], 'the slow signup has not reached the journey yet')

  //  …and the scheduling carries on after the answer.
  t.mock.timers.tick(mod.START_SCENARIO_WAIT_MS)
  assert.ok(await until(() => finished), 'the scheduling finished in the background')
  assert.deepEqual(
    journeyCalls.map((c) => [c.email, c.surface, c.scenario, c.leadId]),
    [
      ['fast.queue@example.com', 'popup', 'lead_nurture', 'lead_1'],
      ['slow.queue@example.com', 'popup', 'lead_nurture', 'lead_2'],
    ],
  )
  assert.deepEqual(started, [NURTURE_SCHEDULED, NURTURE_SCHEDULED])
  assert.equal(send.mock.callCount(), 0, 'the request itself sends nothing, slow or fast')
  assert.equal(ledger.length, 0)
})

// ══════════════════════════════════════════════════════════════════════
//  A CONCURRENT FORM ON THE SAME LEAD (production storeLeadBasis)
// ══════════════════════════════════════════════════════════════════════

/** A notice_accepted another form on this lead recorded, through the real consent event writer. */
async function noticeOnLead(email: string, leadId: string, surface: 'quote' | 'popup', key: string): Promise<string> {
  const version = surface === 'quote' ? QUOTE_VERSION : POPUP_VERSION
  const res = await events.recordConsentEvent({
    email,
    kind: 'notice_accepted',
    surface,
    requestId: `${surface}:submit:${key}:0`,
    leadId,
    noticeVersion: version,
    noticeCopySha256: registry.NOTICE_VERSIONS[version].copySha256.en,
    locale: 'en',
    regionSignal: 'unknown',
    trigger: 'submit',
    emailUserTyped: true,
    optOutBox: false,
    occurredAt: new Date(Date.now() - 60 * 1000),
  })
  if (!res.ok) throw new Error(`${surface} notice not recorded: ${res.reason}`)
  return res.event.id
}

/** A concurrent writer that points the lead at `eventId` just before storeLeadBasis's FIRST compare-and-set. */
const concurrentFormWrites = (eventId: string) => (call: number, where: Row) => {
  if (call !== 1) return
  const lead = consentDb.tables.leads.find((l: Row) => l.id === where.id)
  assert.ok(lead, 'the concurrent form writes an existing lead')
  lead.basisEventId = eventId
}

test('compare-and-set: a QUOTE notice another form writes between the read and the write is re-read and KEPT (stored false, nothing starts)', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const email = 'race.quote@example.com'
  const earlierPopup = await noticeOnLead(email, 'lead_1', 'popup', 'offline-race-earlier-popup')
  const quoteEventId = await noticeOnLead(email, 'lead_1', 'quote', 'offline-race-quote')
  //  The lead's basis when storeLeadBasis reads it: an earlier popup notice, which this popup may replace.
  consentDb.tables.leads.push({ id: 'lead_1', email, basisEventId: earlierPopup })
  concurrentBasisWrite = concurrentFormWrites(quoteEventId)

  assert.deepEqual(await (await signup(body(email))).json(), EXPECTED_BODY, 'the race changes nothing on screen')
  assert.equal(consentDb.tables.leads.length, 1, 'merged into the same lead')
  const popupEvent = consentDb.tables.events.at(-1) as Row
  assert.equal(popupEvent.kind, 'notice_accepted')
  assert.equal(popupEvent.surface, 'popup', 'the popup notice is recorded either way')

  assert.deepEqual(
    leadBasisWrites,
    [{ where: { id: 'lead_1', basisEventId: earlierPopup }, data: { basisEventId: popupEvent.id } }],
    'one compare-and-set on the value it read; it lost, and the re-read quote basis was not replaceable, so nothing more was written',
  )
  assert.deepEqual(outcomes, [{ status: 'granted', eventId: popupEvent.id, created: true, stored: false, scenario: 'lead_nurture' }])
  assert.equal(leadOf(email)?.basisEventId, quoteEventId, 'the concurrent quote basis is kept: its follow-ups keep running')
  assert.deepEqual(started, [null], 'not stored, so nothing starts')
  assert.deepEqual(journeyCalls, [], 'the lead runs the more specific sequence the quote form started')
  assert.deepEqual(await flowEligibility(email, 'lead_1', 'quote_followup'), { eligible: true, basis: 'notice', basisEventId: quoteEventId })

  //  The same rule directly on the production write, from an empty basis.
  consentDb.tables.leads.push({ id: 'lead_direct', email: 'race.direct@example.com', basisEventId: null })
  leadBasisWrites.length = 0
  concurrentBasisWrite = concurrentFormWrites(quoteEventId)
  assert.equal(await basis.captureBasisDeps().storeLeadBasis('lead_direct', 'evt_popup_direct', { surface: 'popup' }), false)
  assert.deepEqual(leadBasisWrites.map((w) => w.where), [{ id: 'lead_direct', basisEventId: null }])
  assert.equal(consentDb.tables.leads.find((l: Row) => l.id === 'lead_direct')?.basisEventId, quoteEventId)

  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)
})

test('compare-and-set: a POPUP notice another form writes between the read and the write is re-read and REPLACED (stored true, the nurture starts on this notice)', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const email = 'race.popup@example.com'
  consentDb.tables.leads.push({ id: 'lead_1', email, basisEventId: null })
  const otherTab = await noticeOnLead(email, 'lead_1', 'popup', 'offline-race-other-tab')
  concurrentBasisWrite = concurrentFormWrites(otherTab)

  assert.deepEqual(await (await signup(body(email))).json(), EXPECTED_BODY)
  const popupEvent = consentDb.tables.events.at(-1) as Row
  assert.equal(popupEvent.surface, 'popup')
  assert.notEqual(popupEvent.id, otherTab)

  assert.deepEqual(
    leadBasisWrites,
    [
      { where: { id: 'lead_1', basisEventId: null }, data: { basisEventId: popupEvent.id } },
      { where: { id: 'lead_1', basisEventId: otherTab }, data: { basisEventId: popupEvent.id } },
    ],
    'the first compare-and-set lost; the re-read popup basis was replaceable, so it was compared against THAT value and won',
  )
  assert.deepEqual(outcomes, [{ status: 'granted', eventId: popupEvent.id, created: true, stored: true, scenario: 'lead_nurture' }])
  assert.equal(leadOf(email)?.basisEventId, popupEvent.id, 'the lead now points at this submission')
  assert.deepEqual(journeyCalls, [
    { surface: 'popup', scenario: 'lead_nurture', leadId: 'lead_1', bookingId: null, basisEventId: popupEvent.id, email },
  ])
  assert.deepEqual(started, [NURTURE_SCHEDULED], 'the gate read the replaced basis')

  //  A concurrent retry that already pointed the lead at THIS event: re-read, and nothing more to write.
  consentDb.tables.leads.push({ id: 'lead_same', email: 'race.same@example.com', basisEventId: null })
  leadBasisWrites.length = 0
  concurrentBasisWrite = concurrentFormWrites('evt_same')
  assert.equal(await basis.captureBasisDeps().storeLeadBasis('lead_same', 'evt_same', { surface: 'popup' }), true)
  assert.equal(leadBasisWrites.length, 1)
  assert.equal(consentDb.tables.leads.find((l: Row) => l.id === 'lead_same')?.basisEventId, 'evt_same')

  assert.equal(send.mock.callCount(), 0)
  assert.equal(ledger.length, 0)
})

// ══════════════════════════════════════════════════════════════════════
//  FLAGS AND FORGERIES
// ══════════════════════════════════════════════════════════════════════

test('EMAIL_NOTICE_BASIS_ENABLED off: basis_withheld notice_basis_disabled, the lead is still saved, nothing started or sent', async (t) => {
  delete process.env.EMAIL_NOTICE_BASIS_ENABLED
  const send = t.mock.method(resend.emails, 'send', ok)
  const res = await signup(body('flag.basis.off@example.com'))
  assert.deepEqual(await res.json(), EXPECTED_BODY)
  assert.deepEqual(order, ['captureLead', 'applyBasis', 'startScenario'])
  assert.deepEqual(kinds(), ['basis_withheld'])
  assert.equal(consentDb.tables.events[0].withheldReason, 'notice_basis_disabled')
  assert.equal(consentDb.tables.events[0].noticeVersion, POPUP_VERSION)
  assert.equal(consentDb.tables.leads.length, 1, 'the lead is saved as normal')
  assert.equal(consentDb.tables.leads[0].basisEventId, null, 'no basis stored')
  assert.equal(consentDb.tables.status.length, 0, 'a withheld basis moves no status')
  assert.deepEqual(started, [null])
  assert.deepEqual(journeyCalls, [])
  assert.equal(send.mock.callCount(), 0)
})

test('OFFER_SIGNUP_ENABLED is required for every popup grant, even if the capture layer were reached while dark', async () => {
  const env = { EMAIL_NOTICE_BASIS_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: 'offer-signup-ip-secret-0123456789' }
  const deps = { env, fetch: poisonedFetch, alert: async () => undefined, testIdentity: async () => null }
  const input = {
    grant: 'notice' as const,
    surface: 'popup' as const,
    email: 'dark.popup@example.com',
    sequenceKind: 'lead_nurture' as const,
    ip: '198.51.100.40',
  }

  const dark = await grant.evaluateGrantSafeguards(input, deps)
  assert.equal(dark.grant, false)
  assert.equal((dark as { reason: string }).reason, 'offer_signup_disabled')

  const lit = await grant.evaluateGrantSafeguards(input, { ...deps, env: { ...env, OFFER_SIGNUP_ENABLED: 'true' } })
  assert.equal(lit.grant, true)

  const quote = await grant.evaluateGrantSafeguards({ ...input, surface: 'quote', email: 'quote.form@example.com' }, deps)
  assert.equal(quote.grant, true, 'the popup flag gates only the popup surface')

  const noBasisFlag = await grant.evaluateGrantSafeguards(input, { ...deps, env: { OFFER_SIGNUP_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: env.CONSENT_IP_HMAC_SECRET } })
  assert.equal((noBasisFlag as { reason: string }).reason, 'notice_basis_disabled', 'the notice flag is checked first, for every grant')

  //  Through the real capture layer, with the route’s flag off.
  delete process.env.OFFER_SIGNUP_ENABLED
  const out = await basis.applyCaptureBasis({
    surface: 'popup',
    scenario: 'lead_nurture',
    email: 'dark.popup@example.com',
    leadId: null,
    contract: { marketingNotice: POPUP.marketingNotice, emailUserTyped: true },
    acceptTrigger: 'submit',
    locale: 'en',
    client: { ip: '198.51.100.41', userAgent: null, pageUrl: null },
  })
  assert.equal(out.status, 'withheld')
  assert.equal((out as { reason: string }).reason, 'offer_signup_disabled')
  assert.deepEqual(kinds(), ['basis_withheld'])
  assert.equal(await basis.startCaptureScenario(out, { surface: 'popup', email: 'dark.popup@example.com', leadId: null }), null)
  assert.deepEqual(journeyCalls, [], 'a withheld popup notice starts nothing')
})

test('a forged, retired or other-surface notice version is withheld unknown_notice_version; the lead is still saved', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  const cases: Array<[string, Record<string, unknown>]> = [
    ['future@example.com', { marketingNotice: { version: 'popup-2099-01-01', trigger: 'submit' } }],
    ['quote.copy@example.com', { marketingNotice: { version: QUOTE_VERSION, trigger: 'submit' } }],
    ['contact.copy@example.com', { marketingNotice: { version: 'contact-2026-09-16-r2', trigger: 'submit' } }],
    ['first.release@example.com', { marketingNotice: { version: 'popup-2026-09-16', trigger: 'submit' } }],
    ['wrong.locale@example.com', { locale: 'de' }],
  ]
  for (const [email, extra] of cases) {
    assert.deepEqual(await (await signup(body(email, extra))).json(), EXPECTED_BODY)
  }
  assert.equal(captured.length, cases.length, 'every lead is saved')
  assert.deepEqual(kinds(), cases.map(() => 'basis_withheld'))
  assert.ok(consentDb.tables.events.every((e: Row) => e.withheldReason === 'unknown_notice_version'))
  assert.equal(consentDb.tables.events[1].noticeVersion, QUOTE_VERSION, 'the CLAIMED version is kept as evidence')
  assert.ok(consentDb.tables.leads.every((l: Row) => l.basisEventId === null), 'no lead carries a basis')
  assert.deepEqual(evaluated, [], 'an unregistered notice never reaches the safeguards')
  assert.equal(consentDb.tables.status.length, 0)
  assert.deepEqual(journeyCalls, [], 'no sequence without a registered notice')
  assert.equal(send.mock.callCount(), 0)
})

test('a notice without the submit trigger, or no notice at all, records nothing (old popup); the lead is still saved', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)
  await signup(body('no.trigger@example.com', { marketingNotice: { version: POPUP_VERSION } }))
  await signup(body('beacon@example.com', { marketingNotice: { version: POPUP_VERSION, trigger: 'blur' } }))
  await signup({ email: 'old.page@example.com' })
  assert.equal(captured.length, 3)
  assert.deepEqual(
    outcomes.map((o) => (o as { reason?: string }).reason),
    ['trigger_not_accepted', 'trigger_not_accepted', 'no_notice'],
  )
  assert.equal(consentDb.tables.events.length, 0)
  assert.deepEqual(journeyCalls, [], 'an old page keeps today’s behaviour: no sequence')
  assert.equal(send.mock.callCount(), 0)
})

// ══════════════════════════════════════════════════════════════════════
//  PROHIBITIONS STAY ABSOLUTE
// ══════════════════════════════════════════════════════════════════════

test('a suppressed, unsubscribed or opted-out address: identical response, the gate refuses the nurture, no email, and nothing the popup does lifts it', async (t) => {
  const send = t.mock.method(resend.emails, 'send', ok)

  //  Hard bounce.
  const bounced = 'bounced@example.com'
  const bounceRow = { email: bounced, reason: 'HARD_BOUNCE', scope: 'all' }
  consentDb.tables.suppressions.push({ ...bounceRow })
  assert.deepEqual(await (await signup(body(bounced))).json(), EXPECTED_BODY)
  assert.deepEqual(consentDb.tables.suppressions, [bounceRow], 'the suppression row is untouched')
  assert.deepEqual(started.at(-1), { scheduled: false, reason: 'suppressed' }, 'the lead nurture is refused')
  assert.equal((await campaignEligibility(bounced)).eligible, false)
  assert.equal(((await campaignEligibility(bounced)) as { reason: string }).reason, 'suppressed')
  assert.equal(((await flowEligibility(bounced, leadOf(bounced)?.id, 'lead_nurture')) as { reason: string }).reason, 'suppressed')

  //  Unsubscribed an hour ago (suppression row + the withdrawal on record).
  const leaver = 'unsubscribed.person@example.com'
  const unsubRow = { email: leaver, reason: 'UNSUBSCRIBED', scope: 'promotional' }
  consentDb.tables.suppressions.push({ ...unsubRow })
  const withdrawal = await events.recordConsentEvent({
    email: leaver,
    kind: 'unsubscribed',
    surface: 'unsubscribe_link',
    requestId: 'unsubscribe:offline-test',
    occurredAt: new Date(Date.now() - 60 * 60 * 1000),
  })
  assert.ok(withdrawal.ok)
  const res = await signup(body(leaver))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), EXPECTED_BODY, 'nothing on screen reveals the unsubscribe')
  assert.deepEqual(consentDb.tables.suppressions.at(-1), unsubRow, 'still suppressed')
  assert.ok(!kinds().includes('express_opt_in') && !kinds().includes('resubscribed'), 'a form never resubscribes')
  assert.deepEqual(started.at(-1), { scheduled: false, reason: 'suppressed' })
  assert.equal(((await campaignEligibility(leaver)) as { reason: string }).reason, 'suppressed')
  assert.equal(((await flowEligibility(leaver, leadOf(leaver)?.id, 'lead_nurture')) as { reason: string }).reason, 'suppressed')

  //  Even if the suppression row were removed out of band, the earlier
  //  withdrawal still outranks the popup's later notice — for offers AND for
  //  the lead nurture the popup notice now names.
  consentDb.tables.suppressions = consentDb.tables.suppressions.filter((s: Row) => s.email !== leaver)
  const after = await campaignEligibility(leaver)
  assert.equal(after.eligible, false)
  assert.equal((after as { reason: string }).reason, 'opted_out')
  const afterFlow = await flowEligibility(leaver, leadOf(leaver)?.id, 'lead_nurture')
  assert.equal(afterFlow.eligible, false)
  assert.equal((afterFlow as { reason: string }).reason, 'opted_out')

  //  Ticked the opt-out box on an earlier form (no suppression row at all).
  const boxed = 'opted.out@example.com'
  const boxedAt = new Date(Date.now() - 60 * 60 * 1000)
  const optOut = await events.recordConsentEvent({
    email: boxed,
    kind: 'opted_out_at_capture',
    surface: 'quote',
    requestId: 'quote:submit:offline-opt-out:0',
    optOutBox: true,
    occurredAt: boxedAt,
  })
  assert.ok(optOut.ok)
  assert.deepEqual(await (await signup(body(boxed))).json(), EXPECTED_BODY, 'nothing on screen reveals the opt-out')
  assert.deepEqual(started.at(-1), { scheduled: false, reason: 'opted_out' })
  const boxedStatus = consentDb.tables.status.find((s: Row) => s.emailNormalized === boxed)
  assert.equal(boxedStatus?.optedOutAt?.getTime(), boxedAt.getTime(), 'the popup’s later notice never moves the opt-out')
  assert.equal(boxedStatus?.expressOptInAt, null)
  assert.equal(((await campaignEligibility(boxed)) as { reason: string }).reason, 'opted_out')
  assert.equal(((await flowEligibility(boxed, leadOf(boxed)?.id, 'lead_nurture')) as { reason: string }).reason, 'opted_out')
  assert.ok(!kinds().includes('express_opt_in') && !kinds().includes('resubscribed'), 'a form never resubscribes')

  assert.ok(journeyAnswers.every((a) => a.scheduled === false), 'no prohibited address is ever scheduled')
  assert.equal(send.mock.callCount(), 0, 'no email to a suppressed, unsubscribed or opted-out address')
  assert.equal(ledger.length, 0)
})

// ══════════════════════════════════════════════════════════════════════
//  ATTRIBUTION
// ══════════════════════════════════════════════════════════════════════

test('attribution (utm*, referrer, landingPage) is passed to captureLead, sanitized; nothing else in the body steers the save', async (t) => {
  t.mock.method(resend.emails, 'send', ok)
  await signup(
    body('attributed@example.com', {
      utmSource: 'facebook',
      utmMedium: 'paid  \n social',
      utmCampaign: 'fall-2026',
      utmContent: 'popup-a',
      utmTerm: 'movers newark',
      referrer: 'https://www.google.com/',
      landingPage: 'https://www.moveitclearit.com/pricing.html?utm_source=facebook',
      surface: 'quote',
      leadId: 'lead_forged',
      source: 'admin',
    }),
  )
  assert.deepEqual(captured[0], {
    email: 'attributed@example.com',
    attribution: {
      utmSource: 'facebook',
      utmMedium: 'paid social',
      utmCampaign: 'fall-2026',
      utmContent: 'popup-a',
      utmTerm: 'movers newark',
      referrer: 'https://www.google.com/',
      landingPage: 'https://www.moveitclearit.com/pricing.html?utm_source=facebook',
    },
  })
  assert.equal(applyInputs[0].surface, 'popup', 'a body "surface" is ignored')
  assert.equal(applyInputs[0].leadId, 'lead_1', 'a body "leadId" is ignored')
  assert.equal(applyInputs[0].scenario, 'lead_nurture', 'the body cannot name a sequence either')

  //  No attribution, or an over-long value: dropped, never an error.
  await signup(body('plain@example.com', { utmSource: 'x'.repeat(81) }))
  assert.deepEqual(captured[1].attribution, {
    utmSource: undefined,
    utmMedium: undefined,
    utmCampaign: undefined,
    utmContent: undefined,
    utmTerm: undefined,
    referrer: undefined,
    landingPage: undefined,
  })
  assert.equal(mod.OFFER_LEAD_SOURCE, 'popup-offer')
})

// ══════════════════════════════════════════════════════════════════════
//  EXISTING CODE AND TEMPLATES THE POPUP RELIES ON
// ══════════════════════════════════════════════════════════════════════

test('the code on screen is the coupon book’s MOVE10, within the public discount cap', async () => {
  const { PROMO_CODES } = await import('../discount-rules')
  const { DISCOUNT_POLICY } = await import('../pricing-config')
  assert.equal(mod.offerSignupResponseBody().code, PROMO_CODES.MOVE10.code)
  assert.ok(PROMO_CODES.MOVE10.percent <= DISCOUNT_POLICY.maxPublicPercent)
})

test('the popup’s sequence is the EXISTING lead nurture, and its footer is truthful: no "opted in" claim, in either language', async () => {
  const { default: LeadNurtureEmail } = await import('../../emails/lead-nurture')
  const guard = await import('../email-guard')
  assert.deepEqual(registry.SURFACE_SEQUENCE_KINDS.popup, ['lead_nurture'], 'the popup may start the general lead nurture, and nothing else')

  const renderStage = async (stage: number, locale: string) =>
    await render(
      React.createElement(LeadNurtureEmail, {
        stage,
        locale,
        customerName: 'Sam',
        quoteUrl: 'https://www.moveitclearit.com/quote.html',
        unsubscribeUrl: 'https://moveitclearit.com/api/email/unsubscribe?token=SAMPLE',
        postalAddress: '123 Sample Street, Newark NJ 07103',
      }),
    )
  for (const stage of [1, 2, 3]) {
    const en = await renderStage(stage, 'en')
    assert.match(en, /receiving this because you gave us your email about a move on moveitclearit\.com\./, `EN stage ${stage}: the corrected footer`)
    assert.doesNotMatch(en, /opted in/i, `EN stage ${stage}: never claims an opt-in`)
    assert.match(en, /https:\/\/moveitclearit\.com\/api\/email\/unsubscribe\?token=SAMPLE/, `EN stage ${stage}: the unsubscribe link stays`)
    assert.match(en, /123 Sample Street, Newark NJ 07103/, `EN stage ${stage}: the postal address stays`)

    const es = await renderStage(stage, 'es')
    assert.match(es, /Te escribimos porque nos diste tu correo sobre una mudanza en moveitclearit\.com\./, `ES stage ${stage}: the corrected footer`)
    assert.doesNotMatch(es, /aceptaste recibir|opted in/i, `ES stage ${stage}: never claims an opt-in`)
    assert.match(es, /https:\/\/moveitclearit\.com\/api\/email\/unsubscribe\?token=SAMPLE/, `ES stage ${stage}: the unsubscribe link stays`)
  }
  assert.match(await renderStage(1, 'en'), /To give you a real number, we need a few things\./, 'the production stage-1 copy is unchanged')

  //  The send gate no longer refuses the (now truthful) footer on a notice
  //  basis, and it checks a lead-nurture send as the lead's lead_nurture flow.
  assert.ok(!('TEMPLATES_CLAIMING_OPT_IN' in guard), 'the opt-in-claim refusal is gone')
  for (const template of ['lead-nurture-1', 'lead-nurture-2', 'lead-nurture-final']) {
    assert.equal(guard.classifyTemplate(template), 'promotional', `${template} stays promotional: unsubscribe, caps, eligibility`)
  }
  assert.deepEqual(guard.derivedEligibilityRequest({ journey: 'lead-nurture', leadId: 'lead_1' }), {
    context: 'scenario_flow',
    subject: { type: 'lead', id: 'lead_1', sequenceKind: 'lead_nurture' },
  })
})
