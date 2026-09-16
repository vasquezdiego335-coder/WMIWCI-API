// ════════════════════════════════════════════════════════════════════════
//  capture-routes-consent.test.ts — EVERY public capture path, driven through
//  its REAL handler and REAL Zod schema (email consent release 2026-09-16).
//  ---------------------------------------------------------------------
//  What each route must do with the notice contract (DESIGN-v2 §1, §4):
//    • save the lead BEFORE any consent event, email, queue or sequence;
//    • start the most relevant EXISTING sequence for every genuine submission
//      (owner direction 2026-09-16, release): Sequence A on a real quote;
//      abandoned checkout on a booking submit; the general lead nurture for
//      everything else — a no-price quote, the booking form's Continue click,
//      every contact topic, a tracker forward — and never before the reply the
//      person actually asked for (confirmation email, team alert);
//    • never let a newer notice replace a lead's basis that permits MORE lead
//      sequences (a contact message merged into a quote lead starts nothing);
//    • record a notice only for a registered version on the route's own
//      surface and trigger — anything else is withheld or ignored;
//    • honour the opt-out box, never grant beside it;
//    • answer the visitor IDENTICALLY whatever happened to the basis;
//    • with the flags off, grant nothing and change nothing else.
//
//  OFFLINE. Persistence and side effects go through the existing test seams
//  (quote-capture-deps, contact-route-deps) and the new capture-basis seam; the
//  grant safeguards and event writer are the REAL modules over the in-memory
//  consent database. The tracker route, which has no persistence seam, runs
//  against a minimal in-memory Prisma installed before anything imports db.ts.
//  No Postgres, no Redis, no provider, no network. Addresses are @example.com.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach, afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'

assertNoProductionCredentials()

// ── A minimal Prisma for the tracker route (ingestLeadSafe → createOrUpdateLead) ──
//  Installed BEFORE any module imports db.ts. An EXISTING open lead is returned
//  so the merge path runs and no new-lead notice or automation trigger fires.
type Row = Record<string, any>
const trackerDb = { leads: [] as Row[], updates: [] as Row[], creates: [] as Row[] }
;(globalThis as unknown as { prisma: unknown }).prisma = {
  lead: {
    async findFirst({ where }: Row) {
      return trackerDb.leads.find((l) => l.email === where.email) ?? null
    },
    async update({ where, data }: Row) {
      trackerDb.updates.push({ id: where.id, data })
      return { id: where.id, status: 'NEW' }
    },
    async create({ data }: Row) {
      trackerDb.creates.push(data)
      return { id: 'lead_tracker_new', status: 'NEW' }
    },
    async findUnique() {
      return null
    },
  },
  emailSuppression: {
    async findUnique() {
      return null
    },
  },
}
process.env.CUSTOMER_AUTOREPLY_ENABLED = 'false'
delete process.env.OWNER_EMAIL
delete process.env.EMAIL_JOURNEYS_ENABLED
process.env.INTERNAL_NOTIFY_TOKEN = 'tracker-test-token-0123456789'

//  ES imports are hoisted above the assignment, so every module that reaches
//  db.ts is loaded DYNAMICALLY in before() — after the fake is in place.
import type { CaptureBasisDeps } from '../capture-basis'
import type { FetchLike } from '../consent/grant-safeguards'
import type { ConsentEventsDb } from '../consent/consent-events'
import type { NoticeSubmissionInput } from '../journeys'
import type { PartialLeadInput } from '../leads'

let __setQuoteCaptureRouteDeps: typeof import('../quote-capture-deps').__setQuoteCaptureRouteDeps
let __setContactRouteDeps: typeof import('../contact-route-deps').__setContactRouteDeps
let __setCaptureBasisDeps: typeof import('../capture-basis').__setCaptureBasisDeps
let captureRequestId: typeof import('../capture-basis').captureRequestId
let evaluateGrantSafeguards: typeof import('../consent/grant-safeguards').evaluateGrantSafeguards
let recordConsentEvent: typeof import('../consent/consent-events').recordConsentEvent
let leadBasisReplaceableBy: typeof import('../consent/notice-registry').leadBasisReplaceableBy

type RouteModule = { POST: (req: Request) => Promise<Response> }
let PARTIAL: RouteModule['POST']
let LEADS_ALIAS: RouteModule['POST']
let QUOTE: RouteModule['POST']
let CONTACT: RouteModule['POST']
let TRACKER: RouteModule['POST']
/** The root pino destination every child logger (notify's included) writes through. */
let rootLogStream: { write(line: string): unknown }

before(async () => {
  const { logger } = await import('../logger')
  const { symbols } = (await import('pino')).default
  rootLogStream = (logger as unknown as Record<symbol, typeof rootLogStream>)[symbols.streamSym]
  ;({ __setQuoteCaptureRouteDeps } = await import('../quote-capture-deps'))
  ;({ __setContactRouteDeps } = await import('../contact-route-deps'))
  ;({ __setCaptureBasisDeps, captureRequestId } = await import('../capture-basis'))
  ;({ evaluateGrantSafeguards } = await import('../consent/grant-safeguards'))
  ;({ recordConsentEvent } = await import('../consent/consent-events'))
  ;({ leadBasisReplaceableBy } = await import('../consent/notice-registry'))
  ;({ POST: PARTIAL } = (await import('../../../app/api/leads/partial/route')) as unknown as RouteModule)
  ;({ POST: LEADS_ALIAS } = (await import('../../../app/api/leads/route')) as unknown as RouteModule)
  ;({ POST: QUOTE } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as RouteModule)
  ;({ POST: CONTACT } = (await import('../../../app/api/contact/route')) as unknown as RouteModule)
  ;({ POST: TRACKER } = (await import('../../../app/api/notify/lead/route')) as unknown as RouteModule)
})

const ENV_ON = { EMAIL_NOTICE_BASIS_ENABLED: 'true', CONSENT_IP_HMAC_SECRET: 'capture-routes-secret-0123456789' }
const poisonedFetch: FetchLike = async () => {
  throw new Error('network is forbidden in this suite')
}

/** One ordered log of every effect, across all seams. */
let log: string[]
let db: ReturnType<typeof createFakeConsentDb>
let scenarios: NoticeSubmissionInput[]
let optedOut: string[]
let restores: Array<() => void>
let flags: Record<string, string | undefined>
let identityIsReal: boolean

function installBasis(over: Partial<CaptureBasisDeps> = {}) {
  restores.push(
    __setCaptureBasisDeps({
      async evaluate(input) {
        log.push('basis:evaluate')
        return evaluateGrantSafeguards(input, {
          db: db as never,
          env: flags,
          fetch: poisonedFetch,
          alert: async () => undefined,
          ...(identityIsReal ? {} : { testIdentity: async () => null }),
        })
      },
      async record(input) {
        log.push(`basis:record:${input.kind}`)
        return recordConsentEvent(input, db as unknown as ConsentEventsDb)
      },
      //  Mirrors the production write: a lead's current basis is KEPT when the
      //  newer notice permits fewer lead sequences (leadBasisReplaceableBy).
      //  The route seams hand back leads the fake has never seen, so the first
      //  store creates the row.
      async storeLeadBasis(leadId, eventId, { surface }) {
        log.push('basis:store-lead')
        const lead = db.tables.leads.find((l: any) => l.id === leadId)
        if (!lead) {
          db.tables.leads.push({ id: leadId, basisEventId: eventId })
          return true
        }
        if (lead.basisEventId === eventId) return true
        const current = db.tables.events.find((e: any) => e.id === lead.basisEventId)
        if (current && !leadBasisReplaceableBy(current.surface, surface)) {
          log.push('basis:kept')
          return false
        }
        lead.basisEventId = eventId
        return true
      },
      async storeBookingBasis(bookingId, eventId) {
        log.push('basis:store-booking')
        db.tables.bookings.push({ id: bookingId, basisEventId: eventId })
      },
      async startScenario(input) {
        log.push(`scenario:${input.scenario}`)
        scenarios.push(input)
        return { scheduled: true, stages: 3 }
      },
      async personOptedOut(email) {
        log.push('opted-out:cancel-jobs')
        optedOut.push(email)
      },
      async submissionSeen(requestId) {
        return db.tables.events.some((e: any) => e.requestId === requestId)
      },
      now: () => new Date(),
      ...over,
    }),
  )
}

/** Persistence and side-effect seams, recording into the same log. */
let captured: PartialLeadInput[]
function installLeadSeams() {
  restores.push(
    __setQuoteCaptureRouteDeps({
      async capture(input) {
        log.push('lead:saved')
        captured.push(input)
        return { lead: { id: 'lead_quote', status: 'NEW' as never }, isNew: true }
      },
      async partialCapture(input) {
        log.push('lead:saved')
        captured.push(input)
        return { lead: { id: 'lead_partial', status: 'NEW' as never }, isNew: false }
      },
      async onCaptured(leadId, opts) {
        log.push(`transactional:quote-request-received:${opts?.locale ?? 'none'}`)
        return { emailStatus: 'queued', notificationStatus: 'queued' }
      },
    }),
  )
  restores.push(
    __setContactRouteDeps({
      async capture(input) {
        log.push('lead:saved')
        captured.push(input as PartialLeadInput)
        return { lead: { id: 'lead_contact', status: 'NEW' }, isNew: true } as never
      },
      async enqueue() {
        log.push('queue:discord')
        return { id: 'job' }
      },
      async alert() {
        return { ok: true }
      },
      async nurture() {
        log.push('legacy:nurture')
        return null
      },
    }),
  )
}

beforeEach(() => {
  log = []
  scenarios = []
  optedOut = []
  captured = []
  restores = []
  identityIsReal = false
  flags = { ...ENV_ON }
  db = createFakeConsentDb()
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
  process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED = 'true'
  installBasis()
  installLeadSeams()
})

afterEach(() => {
  for (const r of restores.reverse()) r()
  delete process.env.QUOTE_LEAD_CAPTURE_ENABLED
  delete process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED
})

let ipSeq = 10
/** Each request comes from its own client IP unless a test says otherwise. */
function post(handler: RouteModule['POST'], path: string, body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new Request(`https://api.example.com${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://www.moveitclearit.com',
        'x-real-ip': `203.0.113.${++ipSeq}`,
        referer: 'https://www.moveitclearit.com/quote.html?email=leak@example.com',
        ...headers,
      },
      body: JSON.stringify(body),
    }) as never,
  )
}

const soon = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
const quoteBody = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Test',
  lastName: 'Fixture',
  phone: '8625550100',
  email: 'quote.person@example.com',
  moveDate: soon(),
  pickupZip: '08817',
  destinationZip: '07030',
  moveSize: '1br',
  bookingSessionId: 'sess-quote-1',
  locale: 'en',
  ...extra,
})
const QUOTE_NOTICE = { marketingNotice: { version: 'quote-2026-09-16-r2', trigger: 'submit' } }

const kinds = () => db.tables.events.map((e: any) => e.kind)

// ══════════════════════════════════════════════════════════════════════
//  P1 — QUICK QUOTE
// ══════════════════════════════════════════════════════════════════════

test('P1 quote: saved → notice recorded → confirmation email → scenario, in that order', async () => {
  const res = await post(QUOTE, '/api/leads/quote-capture', quoteBody(QUOTE_NOTICE))
  assert.equal(res.status, 200)
  assert.deepEqual(log, [
    'lead:saved',
    'basis:evaluate',
    'basis:record:notice_accepted',
    'basis:store-lead',
    'transactional:quote-request-received:en',
    'scenario:quote_followup',
  ])
  assert.equal(scenarios[0].surface, 'quote')
  assert.equal(scenarios[0].leadId, 'lead_quote')
  assert.equal(scenarios[0].basisEventId, db.tables.events[0].id)
})

test('P1 quote: an in-person request (no price) → saved → notice recorded → confirmation email → the general lead nurture, in that order', async () => {
  const res = await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, email: 'visit@example.com', bookingSessionId: 'sess-visit', quoteMode: 'in_person' }))
  assert.equal(res.status, 200)
  assert.deepEqual(log, [
    'lead:saved',
    'basis:evaluate',
    'basis:record:notice_accepted',
    'basis:store-lead',
    'transactional:quote-request-received:en',
    'scenario:lead_nurture',
  ])
  assert.deepEqual(scenarios, [
    {
      surface: 'quote',
      scenario: 'lead_nurture',
      leadId: 'lead_quote',
      bookingId: null,
      basisEventId: db.tables.events[0].id,
      email: 'visit@example.com',
    },
  ])
})

test('P1 quote: a REAL server quote → Sequence A; no price (in-person visit, hand-planned move) → the lead nurture; the confirmation email always comes first', async () => {
  await post(QUOTE, '/api/leads/quote-capture', quoteBody(QUOTE_NOTICE))
  await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, email: 'visit@example.com', bookingSessionId: 'sess-visit', quoteMode: 'in_person' }))
  await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, email: 'plan@example.com', bookingSessionId: 'sess-plan', moveSize: '5br' }))
  assert.deepEqual(scenarios.map((s) => s.scenario), ['quote_followup', 'lead_nurture', 'lead_nurture'])
  assert.ok(scenarios.every((s) => s.surface === 'quote'), 'the surface is the route’s, whatever the sequence')
  assert.deepEqual(kinds(), ['notice_accepted', 'notice_accepted', 'notice_accepted'])
  //  Every submission's own confirmation is queued BEFORE its sequence is asked for.
  assert.deepEqual(
    log.filter((l) => l.startsWith('transactional:') || l.startsWith('scenario:')),
    [
      'transactional:quote-request-received:en',
      'scenario:quote_followup',
      'transactional:quote-request-received:en',
      'scenario:lead_nurture',
      'transactional:quote-request-received:en',
      'scenario:lead_nurture',
    ],
  )
})

test('P1 quote: the response is IDENTICAL whether the basis was granted, withheld, opted out or never asked', async () => {
  const bodies: string[] = []
  const strip = async (res: Response) => JSON.stringify(await res.json())
  bodies.push(await strip(await post(QUOTE, '/api/leads/quote-capture', quoteBody())))
  bodies.push(await strip(await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, bookingSessionId: 'a' }))))
  bodies.push(await strip(await post(QUOTE, '/api/leads/quote-capture', quoteBody({ marketingNotice: { version: 'forged-1', trigger: 'submit' }, bookingSessionId: 'b' }))))
  bodies.push(await strip(await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, emailMarketingOptOut: true, bookingSessionId: 'c' }))))
  assert.equal(new Set(bodies).size, 1, bodies.join('\n'))
  assert.ok(!bodies[0].includes('basis') && !bodies[0].includes('notice'))
})

test('P1 quote: flags OFF → the lead and the confirmation email are exactly as today, and no basis is granted', async () => {
  flags = { CONSENT_IP_HMAC_SECRET: ENV_ON.CONSENT_IP_HMAC_SECRET }
  const res = await post(QUOTE, '/api/leads/quote-capture', quoteBody(QUOTE_NOTICE))
  assert.equal(res.status, 200)
  assert.ok(log.includes('lead:saved') && log.includes('transactional:quote-request-received:en'))
  assert.deepEqual(kinds(), ['basis_withheld'])
  assert.equal(db.tables.events[0].withheldReason, 'notice_basis_disabled')
  assert.equal(scenarios.length, 0)
  assert.ok(!log.includes('basis:store-lead'))
})

test('P1 quote: a forged version or the booking notice on the quote route is withheld; the lead is still saved', async () => {
  for (const version of ['quote-2027-01-01', 'quote-2026-09-16', 'booking-2026-09-16-r2', 'contact-2026-09-16-r2']) {
    log = []
    db = createFakeConsentDb()
    const res = await post(QUOTE, '/api/leads/quote-capture', quoteBody({ marketingNotice: { version, trigger: 'submit' } }))
    assert.equal(res.status, 200)
    assert.equal(log[0], 'lead:saved', version)
    assert.deepEqual(kinds(), ['basis_withheld'], version)
    assert.equal(db.tables.events[0].withheldReason, 'unknown_notice_version', version)
  }
  assert.equal(scenarios.length, 0)
})

test('P1 quote: the opt-out box records the withdrawal, cancels the person’s jobs, drops an old-page opt-in, and starts nothing', async () => {
  const res = await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, emailMarketingOptOut: true, marketingConsent: true }))
  assert.equal(res.status, 200)
  assert.deepEqual(kinds(), ['opted_out_at_capture'])
  assert.deepEqual(optedOut, ['quote.person@example.com'])
  assert.equal(scenarios.length, 0)
  assert.equal(captured[0].marketingConsent, undefined, 'the contradicting legacy true never reaches the consent columns')
  assert.ok(log.includes('transactional:quote-request-received:en'), 'the transactional confirmation is unaffected')
})

test('P1 quote: five identical submissions → ONE notice event (never a second grant)', async () => {
  for (let i = 0; i < 5; i++) await post(QUOTE, '/api/leads/quote-capture', quoteBody(QUOTE_NOTICE))
  assert.deepEqual(kinds(), ['notice_accepted'])
})

test('P1 quote: a test/staff identity is never granted (real identity check on a reserved domain)', async () => {
  identityIsReal = true
  await post(QUOTE, '/api/leads/quote-capture', quoteBody(QUOTE_NOTICE))
  assert.deepEqual(kinds(), ['basis_withheld'])
  assert.equal(db.tables.events[0].withheldReason, 'reserved_address')
  assert.equal(scenarios.length, 0)
})

test('P1 quote: a staff/import consentSource in the body is never recorded', async () => {
  for (const forged of ['ADMIN_MANUAL', 'IMPORTED', 'EXISTING_CUSTOMER_OPT_IN', 'BOOKING_FORM']) {
    captured = []
    await post(QUOTE, '/api/leads/quote-capture', quoteBody({ consentSource: forged, marketingConsent: true }))
    assert.equal(captured[0].consentSource, 'QUICK_QUOTE_FORM', forged)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  P2 — BOOKING FORM STEP 1
// ══════════════════════════════════════════════════════════════════════

const partialBody = (extra: Record<string, unknown> = {}) => ({
  email: 'booking.step1@example.com',
  firstName: 'Test',
  bookingSessionId: 'sess-booking-1',
  formStep: 'card1',
  locale: 'en',
  ...extra,
})
const CONTINUE = { marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'continue' }, emailUserTyped: true }

test('P2 booking form: every background ping (typing pause, blur, nav, beacons, submitted, no trigger) records nothing and starts nothing', async () => {
  const pings = ['debounce', 'blur', 'toggle', 'nav', 'beacon', 'visibilitychange', 'pagehide', 'submitted', 'submit', undefined]
  for (const trigger of pings) {
    await post(
      PARTIAL,
      '/api/leads/partial',
      partialBody({ marketingNotice: { version: 'booking-2026-09-16-r2', ...(trigger ? { trigger } : {}) }, emailUserTyped: true, bookingSessionId: `sess-ping-${String(trigger)}` }),
    )
  }
  //  A draft saved at the submitted step still carries no Continue claim.
  await post(PARTIAL, '/api/leads/partial', partialBody({ marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'beacon' }, emailUserTyped: true, formStep: 'submitted' }))
  assert.equal(log.filter((l) => l === 'lead:saved').length, pings.length + 1, 'every ping still saves the lead')
  assert.equal(db.tables.events.length, 0, 'pings are not submissions')
  assert.ok(!log.includes('basis:evaluate') && !log.includes('basis:store-lead'))
  assert.equal(scenarios.length, 0, 'no ping starts a sequence')
})

test('P2 booking form: a prefilled or restored address on Continue is withheld — no notice, no basis, no sequence', async () => {
  await post(PARTIAL, '/api/leads/partial', partialBody({ ...CONTINUE, emailUserTyped: false, bookingSessionId: 'sess-prefilled' }))
  await post(PARTIAL, '/api/leads/partial', partialBody({ marketingNotice: CONTINUE.marketingNotice, bookingSessionId: 'sess-untold' }))
  assert.deepEqual(kinds(), ['basis_withheld', 'basis_withheld'])
  assert.deepEqual(
    db.tables.events.map((e: any) => e.withheldReason),
    ['email_not_user_typed', 'email_not_user_typed'],
    'a prefilled, restored or unreported address is not enough',
  )
  assert.ok(!log.includes('basis:store-lead'))
  assert.equal(scenarios.length, 0)
})

test('P2 booking form: ONLY the trusted Continue click with a typed address records the notice and starts the general lead nurture', async () => {
  await post(PARTIAL, '/api/leads/partial', partialBody(CONTINUE))
  //  The Continue click is the contact step's submission. The booking's own
  //  abandoned-checkout recovery still starts from the SUBMIT (/api/bookings).
  assert.deepEqual(log, ['lead:saved', 'basis:evaluate', 'basis:record:notice_accepted', 'basis:store-lead', 'scenario:lead_nurture'])
  assert.equal(db.tables.events[0].trigger, 'continue')
  assert.equal(db.tables.events[0].surface, 'booking')
  assert.equal(db.tables.events[0].emailUserTyped, true)
  assert.deepEqual(scenarios, [
    {
      surface: 'booking',
      scenario: 'lead_nurture',
      leadId: 'lead_partial',
      bookingId: null,
      basisEventId: db.tables.events[0].id,
      email: 'booking.step1@example.com',
    },
  ])

  //  The same Continue fired twice (double click, retried request) is ONE
  //  notice under the session key; the enrollment claim owns duplicate sends.
  await post(PARTIAL, '/api/leads/partial', partialBody(CONTINUE))
  assert.deepEqual(kinds(), ['notice_accepted'])
  assert.ok(scenarios.every((s) => s.basisEventId === db.tables.events[0].id), 'a repeat names the SAME basis, so the claim dedupes it')
})

test('P2 booking form: the /api/leads alias never records a notice, but honours the opt-out box', async () => {
  await post(LEADS_ALIAS, '/api/leads', partialBody(CONTINUE))
  assert.equal(db.tables.events.length, 0)
  assert.equal(scenarios.length, 0)
  await post(LEADS_ALIAS, '/api/leads', partialBody({ ...CONTINUE, emailMarketingOptOut: true }))
  assert.deepEqual(kinds(), ['opted_out_at_capture'])
  assert.equal(scenarios.length, 0)
})

test('P2 booking form: the opt-out box on the Continue click records the withdrawal, stores no basis and starts no sequence', async () => {
  await post(PARTIAL, '/api/leads/partial', partialBody({ ...CONTINUE, emailMarketingOptOut: true }))
  assert.deepEqual(kinds(), ['opted_out_at_capture'])
  assert.deepEqual(optedOut, ['booking.step1@example.com'])
  assert.ok(!log.includes('basis:evaluate') && !log.includes('basis:store-lead'), 'nothing is granted beside the box')
  assert.equal(scenarios.length, 0)
})

test('P2 booking form: flags off → nothing granted, and the response is the same as an old page’s', async () => {
  const oldPage = await (await post(PARTIAL, '/api/leads/partial', partialBody())).json()
  flags = { CONSENT_IP_HMAC_SECRET: ENV_ON.CONSENT_IP_HMAC_SECRET }
  const withNotice = await (await post(PARTIAL, '/api/leads/partial', partialBody(CONTINUE))).json()
  assert.deepEqual(withNotice, oldPage)
  assert.deepEqual(kinds(), ['basis_withheld'])
  assert.equal(scenarios.length, 0)
})

test('P2 booking form: a malformed notice field never loses the lead', async () => {
  const res = await post(PARTIAL, '/api/leads/partial', partialBody({ marketingNotice: 42, emailMarketingOptOut: 'yes', emailUserTyped: 'true' }))
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.captured, true)
  assert.equal(db.tables.events.length, 0)
})

// ══════════════════════════════════════════════════════════════════════
//  P4 — CONTACT FORM
// ══════════════════════════════════════════════════════════════════════

const contactBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Test Customer',
  email: 'contact.person@example.com',
  message: 'Planning a two bedroom move next month.',
  locale: 'en',
  ...extra,
})
const CONTACT_NOTICE = { marketingNotice: { version: 'contact-2026-09-16-r2', trigger: 'submit' } }

test('P4 contact: topic quote → saved, notice recorded, the Discord team alert FIRST, then the legacy (opt-in only) nurture, then the lead nurture on surface contact', async () => {
  const res = await post(CONTACT, '/api/contact', contactBody({ ...CONTACT_NOTICE, topic: 'quote' }))
  assert.equal(res.status, 200)
  assert.deepEqual(log, [
    'lead:saved',
    'basis:evaluate',
    'basis:record:notice_accepted',
    'basis:store-lead',
    'queue:discord',
    'legacy:nurture',
    'scenario:lead_nurture',
  ])
  assert.equal(db.tables.events[0].surface, 'contact')
  assert.deepEqual(scenarios, [
    {
      surface: 'contact',
      scenario: 'lead_nurture',
      leadId: 'lead_contact',
      bookingId: null,
      basisEventId: db.tables.events[0].id,
      email: 'contact.person@example.com',
    },
  ])
})

test('P4 contact: topics booking, other and absent are support requests — notice on contact_support, answered FIRST, then the lead nurture; the reply is identical', async () => {
  const replies = new Set<string>()
  const cases: Array<[string | undefined, 'contact' | 'contact_support']> = [
    ['booking', 'contact_support'],
    ['other', 'contact_support'],
    [undefined, 'contact_support'],
    ['nonsense', 'contact_support'],
    ['quote', 'contact'],
  ]
  for (const [topic, surface] of cases) {
    log = []
    const started = scenarios.length
    replies.add(JSON.stringify(await (await post(CONTACT, '/api/contact', contactBody({ ...CONTACT_NOTICE, topic }))).json()))
    const label = `topic ${String(topic)}`
    assert.deepEqual(scenarios.slice(started).map((s) => [s.surface, s.scenario]), [[surface, 'lead_nurture']], label)
    //  ANSWER FIRST: the team alert is queued before any promotional step.
    const alert = log.indexOf('queue:discord')
    const legacy = log.indexOf('legacy:nurture')
    const scenario = log.indexOf('scenario:lead_nurture')
    assert.ok(log.indexOf('basis:store-lead') < alert, `${label}: the basis is stored before the alert`)
    assert.ok(alert > -1 && scenario > alert, `${label}: the alert is queued before the lead nurture`)
    if (legacy > -1) assert.ok(alert < legacy && legacy < scenario, `${label}: alert → legacy nurture → lead nurture`)
  }
  assert.equal(replies.size, 1, [...replies].join('\n'))
  assert.equal(db.tables.events.filter((e: any) => e.kind === 'notice_accepted' && e.surface === 'contact_support').length, 4)
  assert.equal(db.tables.events.filter((e: any) => e.kind === 'notice_accepted' && e.surface === 'contact').length, 1)
  assert.equal(db.tables.events.filter((e: any) => e.kind !== 'notice_accepted').length, 0, 'a repeat submission is not withheld')
})

test('P4 contact: a contact message merged into a lead with a QUOTE basis keeps that basis and starts nothing new; the reverse replaces it', async () => {
  //  Forms merge into the person's newest open lead. A contact notice permits
  //  only the lead nurture, so it must not replace the quote notice that the
  //  running quote follow-ups are checked against at send time.
  restores.push(
    __setContactRouteDeps({
      async capture(input) {
        log.push('lead:saved')
        captured.push(input as PartialLeadInput)
        return { lead: { id: 'lead_quote', status: 'NEW' }, isNew: false } as never
      },
    }),
  )
  await post(QUOTE, '/api/leads/quote-capture', quoteBody(QUOTE_NOTICE))
  const quoteEvent = db.tables.events[0]
  log = []
  const res = await post(CONTACT, '/api/contact', contactBody({ ...CONTACT_NOTICE, email: 'quote.person@example.com', topic: 'booking' }))
  assert.equal(res.status, 200)
  assert.deepEqual(kinds(), ['notice_accepted', 'notice_accepted'], 'the contact notice is still recorded')
  assert.ok(log.includes('basis:kept') && log.includes('queue:discord'))
  assert.deepEqual(scenarios.map((s) => s.scenario), ['quote_followup'], 'the contact message starts nothing of its own')
  assert.equal(db.tables.leads.find((l: any) => l.id === 'lead_quote')?.basisEventId, quoteEvent.id)

  //  The reverse: a quote after a contact message is the more specific basis.
  db = createFakeConsentDb()
  scenarios = []
  await post(CONTACT, '/api/contact', contactBody({ ...CONTACT_NOTICE, email: 'quote.person@example.com', topic: 'quote' }))
  await post(QUOTE, '/api/leads/quote-capture', quoteBody({ ...QUOTE_NOTICE, bookingSessionId: 'sess-quote-after' }))
  assert.deepEqual(scenarios.map((s) => [s.surface, s.scenario]), [['contact', 'lead_nurture'], ['quote', 'quote_followup']])
  assert.equal(db.tables.leads.find((l: any) => l.id === 'lead_quote')?.basisEventId, db.tables.events[1].id)
})

test('P4 contact: every topic offers the legacy (opt-in only) nurture too — after the team alert — as the privacy page now says', async () => {
  //  Owner direction 2026-09-16: every topic follows up, answered first. The
  //  legacy call only ever acts on an explicit opt-in, and the nurture itself
  //  refuses anyone with a booking on record (leads.hasBookingOnRecord).
  for (const topic of ['quote', undefined, 'booking', 'other'] as const) {
    log = []
    await post(CONTACT, '/api/contact', contactBody({ ...CONTACT_NOTICE, topic }))
    assert.equal(log.filter((l) => l === 'legacy:nurture').length, 1, `topic ${String(topic)}`)
    assert.ok(log.indexOf('queue:discord') >= 0 && log.indexOf('queue:discord') < log.indexOf('legacy:nurture'), 'the team is alerted first, whatever the topic')
  }
})

test('P4 contact: a quote notice on the contact route is withheld; an old page records nothing and starts no sequence', async () => {
  await post(CONTACT, '/api/contact', contactBody({ ...QUOTE_NOTICE, topic: 'quote' }))
  assert.equal(db.tables.events[0].withheldReason, 'unknown_notice_version')
  assert.equal(scenarios.length, 0, 'a withheld notice starts nothing')
  db = createFakeConsentDb()
  log = []
  await post(CONTACT, '/api/contact', contactBody({ marketingConsent: true }))
  assert.equal(db.tables.events.length, 0)
  assert.equal(scenarios.length, 0, 'an old page (no notice) starts no scenario')
  assert.ok(!log.some((l) => l.startsWith('basis:')), 'not even a database call for the basis')
  assert.ok(log.includes('queue:discord') && log.includes('legacy:nurture'), 'the team alert and the legacy (opt-in only) nurture are today’s')
  assert.equal(captured[captured.length - 1].marketingConsent, true, 'an old-page opt-in keeps today’s semantics')
  assert.equal(captured[captured.length - 1].consentSource, 'CONTACT_FORM')
})

test('P4 contact: the opt-out box stops the person and grants nothing', async () => {
  await post(CONTACT, '/api/contact', contactBody({ ...CONTACT_NOTICE, topic: 'quote', emailMarketingOptOut: true }))
  assert.deepEqual(kinds(), ['opted_out_at_capture'])
  assert.deepEqual(optedOut, ['contact.person@example.com'])
  assert.equal(scenarios.length, 0)
})

// ══════════════════════════════════════════════════════════════════════
//  P6 — TRACKER FORWARD (/api/notify/lead)
// ══════════════════════════════════════════════════════════════════════

const trackerBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Tracker Visitor',
  email: 'tracker.visitor@example.com',
  phone: '8625550101',
  source: 'tracker',
  externalId: 'trk_42',
  noticeVersion: 'tracker-2026-09-16-r2',
  clientIp: '198.51.100.44',
  userAgent: 'Mozilla/5.0 (tracker visitor)',
  submittedAt: new Date(Date.now() - 60_000).toISOString(),
  locale: 'en',
  ...extra,
})
const TOKEN = { 'x-internal-token': 'tracker-test-token-0123456789' }

test('P6 tracker: token required; a forward is ingested, recorded under its externalId, and starts the general lead nurture', async () => {
  trackerDb.leads.length = 0
  trackerDb.leads.push({ id: 'lead_trk', status: 'NEW', name: 'Tracker Visitor', email: 'tracker.visitor@example.com' })
  const updatesBefore = trackerDb.updates.length
  assert.equal((await post(TRACKER, '/api/notify/lead', trackerBody())).status, 401)
  assert.equal((await post(TRACKER, '/api/notify/lead', trackerBody(), { 'x-internal-token': 'tracker-test-token-WRONG-WRONG' })).status, 401)
  assert.equal(trackerDb.updates.length, updatesBefore, 'an unauthenticated forward ingests nothing')
  assert.equal(db.tables.events.length, 0, 'records nothing')
  assert.equal(scenarios.length, 0, 'and starts nothing')

  const res = await post(TRACKER, '/api/notify/lead', trackerBody(), TOKEN)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(kinds(), ['notice_accepted'])
  const event = db.tables.events[0]
  assert.equal(event.surface, 'tracker')
  assert.equal(event.requestId, captureRequestId('tracker', 'submit', 'trk_42', 'tracker.visitor@example.com'))
  assert.equal(event.leadId, 'lead_trk')
  assert.ok(!JSON.stringify(event).includes('198.51.100.44'), 'the visitor IP is stored only as an HMAC')
  assert.deepEqual(log, ['basis:evaluate', 'basis:record:notice_accepted', 'basis:store-lead', 'scenario:lead_nurture'])
  assert.deepEqual(scenarios, [
    {
      surface: 'tracker',
      scenario: 'lead_nurture',
      leadId: 'lead_trk',
      bookingId: null,
      basisEventId: event.id,
      email: 'tracker.visitor@example.com',
    },
  ])
  assert.equal(trackerDb.updates[trackerDb.updates.length - 1].data.marketingConsentSource, undefined, 'no consent column is written from a notice')
})

test('P6 tracker: a replayed forward (same externalId) is recognised — re-ingests nothing, re-records nothing, starts nothing again', async () => {
  trackerDb.leads.length = 0
  trackerDb.leads.push({ id: 'lead_trk', status: 'NEW', name: 'Tracker Visitor', email: 'tracker.visitor@example.com' })
  await post(TRACKER, '/api/notify/lead', trackerBody(), TOKEN)
  assert.equal(scenarios.length, 1, 'the first delivery starts the lead nurture')
  const updates = trackerDb.updates.length
  const logged = log.length
  for (let i = 0; i < 3; i++) {
    const replay = await post(TRACKER, '/api/notify/lead', trackerBody({ submittedAt: new Date().toISOString() }), TOKEN)
    assert.deepEqual(await replay.json(), { ok: true, duplicate: true })
  }
  assert.equal(trackerDb.updates.length, updates, 'the lead is not merged again')
  assert.equal(db.tables.events.length, 1, 'no second event')
  assert.deepEqual(log.slice(logged), [], 'no evaluation, record, basis write or scenario on a replay')
  assert.equal(scenarios.length, 1, 'the sequence is not requested again')
})

test('P6 tracker: no notice → withheld no_notice (still replay-safe); opt-out → withdrawal; legacy callers unchanged', async () => {
  trackerDb.leads.length = 0
  trackerDb.leads.push({ id: 'lead_trk', status: 'NEW', name: 'Tracker Visitor', email: 'tracker.visitor@example.com' })
  await post(TRACKER, '/api/notify/lead', trackerBody({ noticeVersion: undefined, externalId: 'trk_no_notice' }), TOKEN)
  assert.deepEqual(kinds(), ['basis_withheld'])
  assert.equal(db.tables.events[0].withheldReason, 'no_notice')

  await post(TRACKER, '/api/notify/lead', trackerBody({ externalId: 'trk_opt', emailOptOut: true }), TOKEN)
  assert.deepEqual(kinds(), ['basis_withheld', 'opted_out_at_capture'])

  //  A legacy caller (no source 'tracker') records nothing new at all.
  await post(TRACKER, '/api/notify/lead', { name: 'Old Shape', email: 'tracker.visitor@example.com', source: 'marketing-tracker' }, TOKEN)
  assert.equal(db.tables.events.length, 2)
  assert.equal(scenarios.length, 0)
  //  A body that claims a staff source is still recorded as the tracker landing form.
  await post(TRACKER, '/api/notify/lead', { email: 'tracker.visitor@example.com', marketing_consent: true, consent_source: 'ADMIN_MANUAL' }, TOKEN)
  const lastUpdate = trackerDb.updates[trackerDb.updates.length - 1].data
  assert.notEqual(lastUpdate.marketingConsentSource, 'ADMIN_MANUAL')
})

/**
 * notifyLead (owner alert + customer acknowledgement) has NO seam. With
 * OWNER_EMAIL unset and the auto-reply off — both set at the top of this file,
 * before the route loaded — its one effect is a single warn line from the
 * notify module, so the step is observed on the root log stream as
 * `notify:<label>`. `fail` makes exactly that write throw: offline, the only way
 * notifyLead can reject (every real send inside it is individually guarded).
 * Nothing is sent; every other log line passes through untouched.
 */
function watchNotifyLead(t: TestContext, { fail = false } = {}) {
  const write = rootLogStream.write.bind(rootLogStream)
  t.mock.method(rootLogStream, 'write', (line: string) => {
    let entry: Record<string, unknown> | null = null
    try {
      entry = JSON.parse(line)
    } catch {
      entry = null
    }
    if (entry?.mod === 'notify') {
      log.push(`notify:${String(entry.label)}`)
      if (fail) throw new Error('owner alert transport down (test)')
    }
    return write(line)
  })
}

test('P6 tracker: ANSWER FIRST — the owner alert / acknowledgement (notifyLead) runs BEFORE the notice is recorded and before the lead nurture is asked for', async (t) => {
  trackerDb.leads.length = 0
  trackerDb.leads.push({ id: 'lead_trk', status: 'NEW', name: 'Tracker Visitor', email: 'tracker.visitor@example.com' })
  watchNotifyLead(t)
  const res = await post(TRACKER, '/api/notify/lead', trackerBody({ externalId: 'trk_answer_first' }), TOKEN)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(log, [
    'notify:owner-lead-alert',
    'basis:evaluate',
    'basis:record:notice_accepted',
    'basis:store-lead',
    'scenario:lead_nurture',
  ])
  assert.deepEqual(scenarios.map((s) => [s.surface, s.scenario, s.leadId]), [['tracker', 'lead_nurture', 'lead_trk']])

  //  A forward that carries no notice still gets its requested reply, and starts nothing.
  log = []
  await post(TRACKER, '/api/notify/lead', trackerBody({ externalId: 'trk_answer_no_notice', noticeVersion: undefined }), TOKEN)
  assert.deepEqual(log, ['notify:owner-lead-alert', 'basis:record:basis_withheld'])
  assert.equal(scenarios.length, 1)
})

test('P6 tracker: a notifyLead failure answers 500, records NOTHING and starts no sequence — so the tracker retry runs in full (reply, then notice, then nurture)', async (t) => {
  trackerDb.leads.length = 0
  trackerDb.leads.push({ id: 'lead_trk', status: 'NEW', name: 'Tracker Visitor', email: 'tracker.visitor@example.com' })
  watchNotifyLead(t, { fail: true })
  const res = await post(TRACKER, '/api/notify/lead', trackerBody({ externalId: 'trk_notify_down' }), TOKEN)
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { ok: false, error: 'notify failed' })
  assert.ok(log.includes('notify:owner-lead-alert'), 'the failure really came from notifyLead')
  assert.deepEqual(
    log.slice(log.indexOf('notify:owner-lead-alert')),
    ['notify:owner-lead-alert'],
    'nothing promotional happens after the failed reply',
  )
  assert.equal(scenarios.length, 0, 'a failed reply starts no lead nurture')
  assert.deepEqual(kinds(), [], 'no event: the forward is not marked as seen, so its retry is not answered "duplicate"')
  //  The legacy (opt-in only) trigger has no seam; give a stray fire-and-forget
  //  a turn to show up anyway. Its source position is pinned below.
  await new Promise((r) => setImmediate(r))
  assert.equal(scenarios.length, 0)

  //  The tracker retries a forward it saw fail: this time the reply works, and
  //  the retry does everything the first attempt could not, exactly once.
  t.mock.restoreAll()
  watchNotifyLead(t)
  log = []
  const retry = await post(TRACKER, '/api/notify/lead', trackerBody({ externalId: 'trk_notify_down' }), TOKEN)
  assert.equal(retry.status, 200)
  assert.deepEqual(await retry.json(), { ok: true })
  assert.deepEqual(log, ['notify:owner-lead-alert', 'basis:evaluate', 'basis:record:notice_accepted', 'basis:store-lead', 'scenario:lead_nurture'])
  assert.equal(kinds().filter((k: string) => k === 'notice_accepted').length, 1, 'one grant per externalId')
  assert.equal(scenarios.length, 1)
  //  …and a third delivery of the same forward is now a recognised duplicate.
  log = []
  const third = await post(TRACKER, '/api/notify/lead', trackerBody({ externalId: 'trk_notify_down' }), TOKEN)
  assert.deepEqual(await third.json(), { ok: true, duplicate: true })
  assert.deepEqual(log, [])
})

test('P6 tracker (source order): lead saved → notifyLead (500 on failure) → basis → legacy nurture trigger → startCaptureScenario → 200', () => {
  //  The legacy trigger is a fire-and-forget dynamic import with no seam, so its
  //  position AFTER the reply (and after the 500 return) is pinned on the source.
  const src = code('app/api/notify/lead/route.ts')
  const saved = src.indexOf('ingestLeadSafe(')
  const basis = src.indexOf('await applyCaptureBasis({')
  const notify = src.indexOf('await notifyLead({')
  const failed = src.indexOf("return NextResponse.json({ ok: false, error: 'notify failed' }, { status: 500 })")
  const legacy = src.indexOf('m.onLeadCaptured(lead.lead.id)')
  const scenario = src.indexOf("await startCaptureScenario(basis, { surface: 'tracker'")
  const ok = src.indexOf('return NextResponse.json({ ok: true })')
  assert.ok(saved > -1 && notify > saved, 'lead saved → notifyLead')
  assert.ok(failed > notify && basis > failed, 'a notifyLead failure returns BEFORE the notice is recorded')
  assert.ok(legacy > basis, 'basis → legacy nurture trigger')
  assert.ok(scenario > legacy && ok > scenario, 'legacy trigger → startCaptureScenario → 200')
  //  The 500 is returned unconditionally from the notifyLead catch itself.
  const handler = src.slice(notify, failed)
  const catchAt = handler.search(/\}\s*catch\s*\(err\)\s*\{/)
  assert.ok(catchAt > -1, 'notifyLead is awaited inside a try whose catch answers 500')
  assert.ok(!/\bif\s*\(|\breturn\b/.test(handler.slice(catchAt)), 'no condition or earlier return inside that catch')
  //  Exactly one call of each promotional step, so no earlier copy survives.
  assert.equal(src.split('onLeadCaptured(').length - 1, 1, 'onLeadCaptured is called once')
  assert.equal(src.split('startCaptureScenario(').length - 1, 1, 'startCaptureScenario is called once')
  assert.equal(src.split('notifyLead(').length - 1, 1, 'notifyLead is called once')
})

// ══════════════════════════════════════════════════════════════════════
//  P3 — BOOKING SUBMIT (no request seam: pinned on the shipped source)
// ══════════════════════════════════════════════════════════════════════

/** Source with comments blanked, LENGTH-PRESERVING, so offsets still order. */
function code(rel: string): string {
  return readFileSync(resolve(__dirname, '../../..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

test('P3 booking submit: the basis is recorded after the booking and its checkout exist, before the hand-over, and its scenario is abandoned checkout', () => {
  const src = code('app/api/bookings/route.ts')
  const created = src.indexOf('prisma.booking.create(')
  const checkout = src.indexOf("status: 'PENDING_PAYMENT'")
  const basis = src.indexOf('await applyCaptureBasis(')
  const handover = src.indexOf('await onBookingCreated(')
  const scenario = src.indexOf('await startCaptureScenario(bookingBasis')
  assert.ok(created > -1 && checkout > created && basis > checkout && handover > basis && scenario > handover, 'create → checkout → basis → hand-over → scenario')
  const call = src.slice(basis, src.indexOf('})', basis))
  assert.match(call, /surface: 'booking'/)
  assert.match(call, /scenario: 'abandoned_checkout'/)
  assert.match(call, /bookingId: booking\.id/)
  assert.match(call, /acceptTrigger: 'submit'/)
  //  BookingSchema strips unknown keys, so the contract must be read from the RAW body.
  assert.match(src, /const contract = parseCaptureContract\(body\)/)
  assert.match(src, /marketingConsent: legacyConsentGivenOptOut\(data\.marketingConsent, contract\)/)
})

test('P2 booking form: a NEW page is offered the legacy nurture only on the Continue click, never from a background ping', () => {
  //  The privacy policy promises no reminders or offers about an unfinished
  //  booking unless the visitor typed the address and pressed Continue. The
  //  first debounce ping used to offer Sequence B, which runs for anyone who
  //  opted in to offers elsewhere. Old pages (no emailUserTyped) keep isNew.
  const src = code('app/api/leads/partial/route.ts')
  assert.match(src, /const newContractPage = typeof contract\.emailUserTyped === 'boolean'/)
  assert.match(src, /const nurtureMoment = newContractPage\s*\? onBookingForm && contract\.marketingNotice\?\.trigger === 'continue'\s*: result\?\.isNew === true \|\| d\.marketingConsent === true/)
  const gate = src.indexOf('if (result && nurtureMoment) {')
  assert.ok(gate > -1, 'the legacy nurture is behind the moment check')
  assert.ok(src.indexOf('m.onLeadCaptured(result.lead.id)', gate) > gate, 'onLeadCaptured is inside it')
  assert.equal(src.split('onLeadCaptured(').length - 1, 1, 'and nowhere else in the route')
})

test('P3 booking submit: the booking payload round-trips the contract fields the schema would drop', async () => {
  const { parseCaptureContract } = await import('../capture-basis')
  const { BookingSchema } = await import('../booking-schema')
  const payload = {
    email: 'booker@example.com',
    marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'submit' },
    emailMarketingOptOut: false,
    emailUserTyped: true,
    turnstileToken: 'tok',
  }
  const parsed = BookingSchema.partial().safeParse(payload)
  if (parsed.success) assert.equal((parsed.data as Record<string, unknown>).marketingNotice, undefined, 'the schema drops it — hence the raw read')
  assert.deepEqual(parseCaptureContract(payload), {
    marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'submit' },
    emailMarketingOptOut: false,
    emailUserTyped: true,
    turnstileToken: 'tok',
  })
})

test('P3 booking submit: a booking stops EVERY open sequence for the address through the ONE hand-over, and the stale comment is gone', () => {
  const route = code('app/api/bookings/route.ts')
  assert.match(route, /await onBookingCreated\(\{\s*bookingId: booking\.id,\s*email: customer\.email/)
  const journeys = code('src/lib/journeys.ts')
  const fn = journeys.slice(journeys.indexOf('export async function onBookingCreated'), journeys.indexOf('export async function onBookingPaid'))
  assert.match(fn, /await onPersonBooked\(input\.email, deps\)/)
  //  The comment that claimed abandoned-checkout recovery had been removed.
  const raw = readFileSync(resolve(__dirname, '../../../app/api/bookings/route.ts'), 'utf8')
  assert.ok(!/\(and the abandoned-checkout recovery\s*(\r?\n\s*\/\/\s*)?email\) were both removed/.test(raw))
  assert.match(raw, /THE ABANDONED-CHECKOUT RECOVERY SEQUENCE WAS NOT REMOVED/)
})

test('every capture route saves the lead before it records any basis', () => {
  const pairs: Array<[string, string]> = [
    ['app/api/leads/partial/route.ts', 'partialCapture('],
    ['app/api/leads/quote-capture/route.ts', '.capture('],
    ['app/api/contact/route.ts', 'deps.capture('],
    ['app/api/notify/lead/route.ts', 'ingestLeadSafe('],
  ]
  for (const [file, save] of pairs) {
    const src = code(file)
    assert.ok(src.indexOf(save) > -1 && src.indexOf(save) < src.indexOf('applyCaptureBasis({'), file)
  }
})
