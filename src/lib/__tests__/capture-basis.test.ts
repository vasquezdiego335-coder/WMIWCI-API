// ════════════════════════════════════════════════════════════════════════
//  capture-basis.test.ts — what a PUBLIC capture route records about marketing
//  email (email consent release 2026-09-16, DESIGN-v2 §1, §3, §4, §6).
//  ---------------------------------------------------------------------
//  OFFLINE. applyCaptureBasis runs against the REAL consent modules —
//  resolveNotice, evaluateGrantSafeguards, recordConsentEvent and
//  promotionalEligibility — over the in-memory consent database, so the
//  registry match, the throttles, the append-only events and the per-person
//  status are the production code, not a restatement of it. Turnstile's fetch
//  is poisoned, the ops alert is a recorder, and the clock is fixed.
//  No Postgres, no Redis, no provider, no network. Every address is
//  @example.com — a reserved test domain — so "not a test identity" is injected
//  wherever a path must be eligible, and left real where it must refuse.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'
import {
  applyCaptureBasis,
  captureRequestId,
  describeCaptureBasis,
  legacyConsentGivenOptOut,
  parseCaptureContract,
  startCaptureScenario,
  MAX_SUBMISSION_AGE_MS,
  type CaptureBasisDeps,
  type CaptureBasisInput,
} from '../capture-basis'
import { routeConsentSource, NON_PUBLIC_CONSENT_SOURCES, PUBLIC_CONSENT_SOURCES } from '../consent'
import { evaluateGrantSafeguards, GRANT_LIMITS, type FetchLike, type GrantSafeguardInput } from '../consent/grant-safeguards'
import { recordConsentEvent, type ConsentEventsDb } from '../consent/consent-events'
import { promotionalEligibility, type EligibilityDb } from '../consent/marketing-eligibility'
import {
  leadBasisReplaceableBy,
  NOTICE_SURFACES,
  NOTICE_VERSIONS,
  SURFACE_SEQUENCE_KINDS,
  type NoticeSurface,
  type SequenceKind,
} from '../consent/notice-registry'
import type { EnrollmentRef } from '../consent/sequence-enrollment'
import type { NoticeSubmissionInput } from '../journeys'

assertNoProductionCredentials()

const NOW = new Date('2026-09-20T15:00:00Z')
const ENV_ON: Record<string, string | undefined> = {
  EMAIL_NOTICE_BASIS_ENABLED: 'true',
  CONSENT_IP_HMAC_SECRET: 'capture-basis-test-secret-0123456789',
}
/** The popup additionally needs OFFER_SIGNUP_ENABLED. */
const ENV_POPUP_ON = { ...ENV_ON, OFFER_SIGNUP_ENABLED: 'true' }

/** The registered r2 notice version rendered on a surface. */
const versionFor = (surface: NoticeSurface): string =>
  Object.keys(NOTICE_VERSIONS).find((v) => NOTICE_VERSIONS[v].surfaces.includes(surface)) as string

const poisonedFetch: FetchLike = async () => {
  throw new Error('network is forbidden in this suite')
}

type World = ReturnType<typeof world>

/** The real consent modules over one in-memory database. */
function world(opts: { env?: Record<string, string | undefined>; realIdentity?: boolean; storeThrows?: boolean } = {}) {
  const db = createFakeConsentDb({ now: () => NOW })
  const env = opts.env ?? ENV_ON
  const calls = { evaluate: 0, record: 0, scenario: [] as NoticeSubmissionInput[], optedOut: [] as { email: string; stopped: EnrollmentRef[] }[], alerts: 0 }
  const deps: CaptureBasisDeps = {
    async evaluate(input) {
      calls.evaluate++
      return evaluateGrantSafeguards(input, {
        db: db as never,
        env,
        fetch: poisonedFetch,
        alert: async () => {
          calls.alerts++
        },
        ...(opts.realIdentity ? {} : { testIdentity: async () => null }),
      })
    },
    async record(input) {
      calls.record++
      return recordConsentEvent(input, db as unknown as ConsentEventsDb)
    },
    async storeLeadBasis(leadId, eventId, storeOpts) {
      if (opts.storeThrows) throw new Error('simulated lead write failure')
      const lead = db.tables.leads.find((l: any) => l.id === leadId)
      if (!lead) throw new Error('no such lead')
      //  The production rule: read the lead's current basis, then that event's
      //  surface. A newer notice that permits FEWER lead sequences (a contact
      //  message on a quote lead) keeps the current basis and resolves false.
      if (lead.basisEventId === eventId) return true
      if (lead.basisEventId) {
        const current = db.tables.events.find((e: any) => e.id === lead.basisEventId)
        if (current && !leadBasisReplaceableBy(current.surface, storeOpts.surface)) return false
      }
      lead.basisEventId = eventId
      return true
    },
    async storeBookingBasis(bookingId, eventId) {
      const booking = db.tables.bookings.find((b: any) => b.id === bookingId)
      if (!booking) throw new Error('no such booking')
      booking.basisEventId = eventId
    },
    async startScenario(input) {
      calls.scenario.push(input)
      return { scheduled: true, stages: 3 }
    },
    async personOptedOut(email, stopped) {
      calls.optedOut.push({ email, stopped })
    },
    async submissionSeen(requestId) {
      return db.tables.events.some((e: any) => e.requestId === requestId)
    },
    now: () => NOW,
  }
  return { db, deps, calls, env }
}

let leadSeq = 0
function seedLead(w: World, email: string): string {
  assertTestRecipient(email)
  const id = `lead_${++leadSeq}`
  w.db.tables.leads.push({ id, email, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null, createdAt: NOW })
  return id
}

const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (test)', pageUrl: 'https://www.moveitclearit.com/quote.html?email=someone@example.com&name=Pat' }

/** The quote route with a real server quote: scenario 'quote_followup'. */
function quoteInput(w: World, email: string, extra: Partial<CaptureBasisInput> = {}): CaptureBasisInput {
  return {
    surface: 'quote',
    scenario: 'quote_followup',
    email,
    leadId: seedLead(w, email),
    contract: { marketingNotice: { version: 'quote-2026-09-16-r2', trigger: 'submit' } },
    acceptTrigger: 'submit',
    locale: 'en',
    region: { phone: '(862) 555-0100', postalCodes: ['07030'] },
    client: CLIENT,
    ...extra,
  }
}

/**
 * Any surface's own registered notice, on its own trigger, naming 'lead_nurture'
 * — the sequence every route names (2026-09-16) except a priced quote
 * (quote_followup) and a submitted booking (abandoned_checkout).
 */
function surfaceInput(w: World, surface: NoticeSurface, email: string, extra: Partial<CaptureBasisInput> = {}): CaptureBasisInput {
  const acceptTrigger = surface === 'booking' ? 'continue' : 'submit'
  return {
    surface,
    scenario: 'lead_nurture',
    email,
    leadId: seedLead(w, email),
    contract: { marketingNotice: { version: versionFor(surface), trigger: acceptTrigger }, emailUserTyped: true },
    acceptTrigger,
    requireEmailUserTyped: surface === 'booking',
    locale: 'en',
    region: { phone: '(862) 555-0100' },
    client: CLIENT,
    ...extra,
  }
}

/** promotionalEligibility over this world's database: the flag on, no test identity. */
const eligibilityDeps = (w: World) => ({ db: w.db as unknown as EligibilityDb, env: ENV_ON, testIdentity: async () => null })

/** A running enrollment for this person, written the way the journeys' claim writes one. */
function seedEnrollment(w: World, row: { id: string; email: string; sequenceKind: SequenceKind; subjectType: 'lead' | 'booking'; subjectId: string }) {
  w.db.tables.enrollments.push({
    id: row.id,
    emailNormalized: row.email,
    sequenceKind: row.sequenceKind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    basisEventId: null,
    windowStart: new Date('2026-09-16T00:00:00Z'),
    status: 'active',
    stopReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

// ── PURE HELPERS ────────────────────────────────────────────────────────

test('routeConsentSource: the ROUTE decides; a staff/import source from a body is never recorded', () => {
  for (const forged of NON_PUBLIC_CONSENT_SOURCES) {
    assert.equal(routeConsentSource('QUICK_QUOTE_FORM', forged), 'QUICK_QUOTE_FORM', `${forged} on the quote route`)
    assert.equal(routeConsentSource('CONTACT_FORM', forged, PUBLIC_CONSENT_SOURCES), 'CONTACT_FORM', `${forged} even when "accepted"`)
    assert.equal(routeConsentSource('BOOKING_FORM', forged, NON_PUBLIC_CONSENT_SOURCES), 'BOOKING_FORM', `${forged} cannot be allow-listed in`)
  }
  //  A public surface the route does not serve is only a claim.
  assert.equal(routeConsentSource('QUICK_QUOTE_FORM', 'BOOKING_FORM'), 'QUICK_QUOTE_FORM')
  assert.equal(routeConsentSource('TRACKER_LANDING', 'CONTACT_FORM'), 'TRACKER_LANDING')
  //  The shared /api/leads handler serves several public surfaces.
  assert.equal(routeConsentSource('BOOKING_FORM', 'HOMEPAGE_ESTIMATE', PUBLIC_CONSENT_SOURCES), 'HOMEPAGE_ESTIMATE')
  assert.equal(routeConsentSource('BOOKING_FORM', null, PUBLIC_CONSENT_SOURCES), 'BOOKING_FORM')
  assert.ok(!PUBLIC_CONSENT_SOURCES.some((s) => NON_PUBLIC_CONSENT_SOURCES.includes(s)))
})

test('parseCaptureContract: lenient — junk is dropped, never a failure', () => {
  assert.deepEqual(parseCaptureContract(null), {})
  assert.deepEqual(parseCaptureContract('nope'), {})
  const junk = parseCaptureContract({
    marketingNotice: 'quote-2026-09-16-r2',
    emailMarketingOptOut: 'yes',
    emailUserTyped: 1,
    turnstileToken: 'x'.repeat(5000),
  })
  assert.equal(junk.marketingNotice, undefined)
  assert.equal(junk.emailMarketingOptOut, undefined)
  assert.equal(junk.emailUserTyped, undefined)
  assert.equal(junk.turnstileToken, undefined)
  const good = parseCaptureContract({
    marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'continue' },
    emailMarketingOptOut: false,
    emailUserTyped: true,
    turnstileToken: 'tok',
    fullName: 'ignored',
  })
  assert.deepEqual(good, {
    marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'continue' },
    emailMarketingOptOut: false,
    emailUserTyped: true,
    turnstileToken: 'tok',
  })
})

test('legacyConsentGivenOptOut: an old-page true never survives a ticked opt-out box; nothing else changes', () => {
  assert.equal(legacyConsentGivenOptOut(true, { emailMarketingOptOut: true }), undefined)
  assert.equal(legacyConsentGivenOptOut(false, { emailMarketingOptOut: true }), false)
  assert.equal(legacyConsentGivenOptOut(undefined, { emailMarketingOptOut: true }), undefined)
  assert.equal(legacyConsentGivenOptOut(true, {}), true, 'old pages keep today’s semantics exactly')
  assert.equal(legacyConsentGivenOptOut(false, {}), false)
  assert.equal(legacyConsentGivenOptOut(true, { emailMarketingOptOut: false }), true)
})

test('captureRequestId: stable per submission key, distinct per address and trigger, and carries no PII', () => {
  const a = captureRequestId('booking', 'continue', 'sess-123', 'Pat@Example.com')
  assert.equal(a, captureRequestId('booking', 'continue', 'sess-123', 'pat@example.com'), 'same person, same submission')
  assert.notEqual(a, captureRequestId('booking', 'continue', 'sess-123', 'other@example.com'))
  assert.notEqual(a, captureRequestId('booking', 'submit', 'sess-123', 'pat@example.com'))
  assert.ok(!a.includes('pat') && !a.includes('example'), 'the address is hashed')
  assert.notEqual(captureRequestId('contact', 'submit', null, 'pat@example.com'), captureRequestId('contact', 'submit', null, 'pat@example.com'))
  assert.match(captureRequestId('tracker', 'submit', 'a b/c;d', 'pat@example.com'), /^tracker:submit:abcd:[0-9a-f]{16}$/)
})

test('leadBasisReplaceableBy: a newer notice replaces a LEAD basis only when it permits every lead sequence the current one does', () => {
  assert.equal(leadBasisReplaceableBy('quote', 'contact'), false, 'quote_followup would be lost')
  assert.equal(leadBasisReplaceableBy('quote', 'popup'), false)
  assert.equal(leadBasisReplaceableBy('quote', 'booking'), false, 'the booking permits abandoned_checkout, not quote_followup')
  assert.equal(leadBasisReplaceableBy('quote', 'quote'), true)
  assert.equal(leadBasisReplaceableBy('contact', 'quote'), true)
  assert.equal(leadBasisReplaceableBy('popup', 'contact'), true)
  assert.equal(leadBasisReplaceableBy('booking', 'contact'), true, 'abandoned_checkout is booking-scoped and ignored')
  assert.equal(leadBasisReplaceableBy('contact_support', 'popup'), true)
  //  No current basis, or one on a surface the registry does not know.
  assert.equal(leadBasisReplaceableBy(null, 'popup'), true)
  assert.equal(leadBasisReplaceableBy(undefined, 'tracker'), true)
  assert.equal(leadBasisReplaceableBy('not_a_surface', 'contact'), true)
})

// ── OLD PAGES ───────────────────────────────────────────────────────────

test('old page: no notice and no opt-out → none, and not a single database call', async () => {
  const w = world()
  const out = await applyCaptureBasis(quoteInput(w, 'old.page@example.com', { contract: {} }), w.deps)
  assert.deepEqual(out, { status: 'none', reason: 'no_notice' })
  assert.equal(w.calls.evaluate + w.calls.record, 0)
  assert.equal(w.db.tables.events.length, 0)
  assert.equal(await startCaptureScenario(out, { surface: 'quote', email: 'old.page@example.com', leadId: 'x' }, w.deps), null)
  assert.equal(w.calls.scenario.length, 0)
})

// ── A REGISTERED NOTICE ─────────────────────────────────────────────────

test('granted: the registered quote notice records notice_accepted, stores the basis, and is eligible for its OWN surface’s sequences only', async () => {
  const w = world()
  const seen: GrantSafeguardInput[] = []
  const realEvaluate = w.deps.evaluate
  w.deps.evaluate = async (i) => {
    seen.push(i)
    return realEvaluate(i)
  }
  const email = 'quote.visitor@example.com'
  const input = quoteInput(w, email)
  const out = await applyCaptureBasis(input, w.deps)
  assert.equal(out.status, 'granted', describeCaptureBasis(out))
  if (out.status !== 'granted') return
  assert.equal(out.stored, true)
  assert.equal(out.scenario, 'quote_followup')
  assert.equal(describeCaptureBasis(out), 'granted:quote_followup')
  assert.equal(seen.length, 1)
  assert.deepEqual(
    { grant: seen[0].grant, surface: seen[0].surface, sequenceKind: seen[0].sequenceKind },
    { grant: 'notice', surface: 'quote', sequenceKind: 'quote_followup' },
    'the safeguards receive the route surface and the scenario',
  )

  const [event] = w.db.tables.events
  assert.equal(w.db.tables.events.length, 1)
  assert.equal(event.kind, 'notice_accepted')
  assert.equal(event.surface, 'quote', 'surface derived by the route')
  assert.equal(event.noticeVersion, 'quote-2026-09-16-r2')
  assert.equal(event.noticeCopySha256, NOTICE_VERSIONS['quote-2026-09-16-r2'].copySha256.en)
  assert.equal(event.locale, 'en')
  assert.equal(event.trigger, 'submit')
  assert.equal(event.regionSignal, 'nanp')
  assert.equal(event.optOutBox, false)
  assert.equal(event.leadId, input.leadId)
  assert.match(event.ipHmac, /^[0-9a-f]{64}$/, 'the IP is stored only as a keyed hash')
  assert.ok(!JSON.stringify(event).includes('203.0.113.7'))
  assert.equal(event.pageUrl, 'https://www.moveitclearit.com/quote.html', 'no query string — it carried the address')
  const lead = w.db.tables.leads.find((l: any) => l.id === input.leadId)!
  assert.equal(lead.basisEventId, event.id)
  assert.equal(lead.emailMarketingConsent, null, 'a notice NEVER sets the consent column')

  const scen = await startCaptureScenario(out, { surface: 'quote', email, leadId: input.leadId }, w.deps)
  assert.deepEqual(scen, { scheduled: true, stages: 3 })
  assert.deepEqual(w.calls.scenario, [
    { surface: 'quote', scenario: 'quote_followup', leadId: input.leadId, bookingId: null, basisEventId: event.id, email },
  ])

  const eligDeps = { db: w.db as unknown as EligibilityDb, env: ENV_ON, testIdentity: async () => null }
  const own = await promotionalEligibility(
    { context: 'scenario_flow', email, subject: { type: 'lead', id: input.leadId as string, sequenceKind: 'quote_followup' }, now: NOW },
    eligDeps,
  )
  assert.deepEqual(own, { eligible: true, basis: 'notice', basisEventId: event.id })
  //  The quote surface also permits the general lead nurture (an unpriced quote names it).
  const nurture = await promotionalEligibility(
    { context: 'scenario_flow', email, subject: { type: 'lead', id: input.leadId as string, sequenceKind: 'lead_nurture' }, now: NOW },
    eligDeps,
  )
  assert.deepEqual(nurture, { eligible: true, basis: 'notice', basisEventId: event.id })
  const other = await promotionalEligibility(
    { context: 'scenario_flow', email, subject: { type: 'lead', id: input.leadId as string, sequenceKind: 'abandoned_checkout' }, now: NOW },
    eligDeps,
  )
  assert.equal(other.eligible, false, 'not a basis for a sequence this surface does not start')
  //  Owner direction 2026-09-16: a form submission may also lead to relevant
  //  offers — a campaign reads the person's LATEST notice (the status pointer).
  const campaign = await promotionalEligibility({ context: 'campaign', email, now: NOW }, eligDeps)
  assert.deepEqual(campaign, { eligible: true, basis: 'notice', basisEventId: event.id })
  //  Automations stay express-only.
  const automation = await promotionalEligibility({ context: 'automation', email, now: NOW }, eligDeps)
  assert.equal(automation.eligible, false)
})

test('Spanish page: the Spanish copy hash is recorded', async () => {
  const w = world()
  const out = await applyCaptureBasis(quoteInput(w, 'es.visitor@example.com', { locale: 'es-US' }), w.deps)
  assert.equal(out.status, 'granted')
  assert.equal(w.db.tables.events[0].locale, 'es')
  assert.equal(w.db.tables.events[0].noticeCopySha256, NOTICE_VERSIONS['quote-2026-09-16-r2'].copySha256.es)
})

test('flags off: EMAIL_NOTICE_BASIS_ENABLED unset → basis_withheld, nothing stored, nothing started', async () => {
  const w = world({ env: { CONSENT_IP_HMAC_SECRET: ENV_ON.CONSENT_IP_HMAC_SECRET } })
  const input = quoteInput(w, 'flag.off@example.com')
  const out = await applyCaptureBasis(input, w.deps)
  assert.deepEqual({ status: out.status, reason: (out as any).reason }, { status: 'withheld', reason: 'notice_basis_disabled' })
  assert.equal(w.db.tables.events.length, 1)
  assert.equal(w.db.tables.events[0].kind, 'basis_withheld')
  assert.equal(w.db.tables.leads.find((l: any) => l.id === input.leadId)!.basisEventId, null)
  assert.equal(await startCaptureScenario(out, { surface: 'quote', email: 'flag.off@example.com', leadId: input.leadId }, w.deps), null)
  assert.equal(w.db.tables.status.length, 0, 'a withheld grant moves no status')
})

test('forged or misused notice versions are ABSENT: unknown, wrong surface, wrong locale, missing locale', async () => {
  const cases: Array<[string, Partial<CaptureBasisInput>]> = [
    ['unknown version', { contract: { marketingNotice: { version: 'quote-2099-01-01', trigger: 'submit' } } }],
    ['removed first-release version', { contract: { marketingNotice: { version: 'quote-2026-09-16', trigger: 'submit' } } }],
    ['booking notice on the quote route', { contract: { marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'submit' } } }],
    ['popup notice on the quote route', { contract: { marketingNotice: { version: 'popup-2026-09-16-r2', trigger: 'submit' } } }],
    ['contact notice on the quote route', { contract: { marketingNotice: { version: 'contact-2026-09-16-r2', trigger: 'submit' } } }],
    ['unsupported locale', { locale: 'fr' }],
    ['missing locale', { locale: null }],
  ]
  for (const [label, extra] of cases) {
    const w = world()
    const out = await applyCaptureBasis(quoteInput(w, 'forged@example.com', extra), w.deps)
    assert.equal(out.status, 'withheld', label)
    assert.equal((out as any).reason, 'unknown_notice_version', label)
    assert.equal(w.db.tables.events.length, 1, label)
    assert.equal(w.db.tables.events[0].kind, 'basis_withheld', label)
    assert.equal(w.db.tables.events[0].noticeCopySha256, null, `${label}: no registered hash is claimed`)
    assert.equal(w.calls.evaluate, 0, `${label}: refused before any safeguard or throttle is consulted`)
  }
})

test('trigger: a notice on any trigger but the route’s own is ignored outright (no event)', async () => {
  for (const trigger of ['debounce', 'blur', 'pagehide', 'toggle', undefined]) {
    const w = world()
    const email = 'pinged@example.com'
    const leadId = seedLead(w, email)
    const out = await applyCaptureBasis(
      {
        surface: 'booking',
        //  What leads/partial names — only its Continue click may carry it.
        scenario: 'lead_nurture',
        email,
        leadId,
        contract: { marketingNotice: { version: 'booking-2026-09-16-r2', trigger }, emailUserTyped: true },
        acceptTrigger: 'continue',
        requireEmailUserTyped: true,
        locale: 'en',
        client: CLIENT,
        submissionKey: 'sess-1',
      },
      w.deps,
    )
    assert.deepEqual(out, { status: 'none', reason: 'trigger_not_accepted' }, String(trigger))
    assert.equal(w.db.tables.events.length, 0)
    assert.equal(w.calls.evaluate, 0, `${String(trigger)}: not even the safeguards run`)
    assert.equal(w.db.tables.leads.find((l: any) => l.id === leadId)!.basisEventId, null)
    assert.equal(await startCaptureScenario(out, { surface: 'booking', email, leadId }, w.deps), null)
    assert.equal(w.calls.scenario.length, 0, `${String(trigger)}: a ping never starts the lead nurture`)
  }
})

test('booking Continue: granted — and the lead nurture started — only when the address was typed on this page load', async () => {
  for (const [typed, expected] of [[true, 'granted'], [false, 'withheld'], [undefined, 'withheld']] as const) {
    const w = world()
    const email = 'continue.click@example.com'
    const leadId = seedLead(w, email)
    const out = await applyCaptureBasis(
      {
        surface: 'booking',
        scenario: 'lead_nurture',
        email,
        leadId,
        contract: { marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'continue' }, emailUserTyped: typed },
        acceptTrigger: 'continue',
        requireEmailUserTyped: true,
        locale: 'en',
        client: CLIENT,
        submissionKey: 'sess-typed',
      },
      w.deps,
    )
    assert.equal(out.status, expected, `emailUserTyped=${typed}`)
    if (out.status === 'withheld') assert.equal(out.reason, 'email_not_user_typed')
    const scen = await startCaptureScenario(out, { surface: 'booking', email, leadId }, w.deps)
    if (out.status === 'granted') {
      assert.deepEqual(scen, { scheduled: true, stages: 3 })
      assert.deepEqual(w.calls.scenario, [
        { surface: 'booking', scenario: 'lead_nurture', leadId, bookingId: null, basisEventId: out.eventId, email },
      ])
    } else {
      assert.equal(scen, null, `emailUserTyped=${typed}`)
      assert.equal(w.calls.scenario.length, 0, `emailUserTyped=${typed}: prefill or autofill never starts a sequence`)
      assert.equal(w.db.tables.leads.find((l: any) => l.id === leadId)!.basisEventId, null)
    }
  }
})

//  No route names a null scenario any more (2026-09-16: every genuine submission
//  enters an existing sequence), but the helper's contract for one still holds.
test('no scenario (null) on ANY surface: notice_accepted after the safeguards, basis stored, nothing started', async () => {
  for (const surface of NOTICE_SURFACES) {
    const w = world({ env: ENV_POPUP_ON })
    const seen: GrantSafeguardInput[] = []
    const realEvaluate = w.deps.evaluate
    w.deps.evaluate = async (i) => {
      seen.push(i)
      return realEvaluate(i)
    }
    const email = `no-sequence.${surface.replace('_', '-')}@example.com`
    const input = surfaceInput(w, surface, email, { scenario: null })
    const out = await applyCaptureBasis(input, w.deps)
    assert.equal(out.status, 'granted', `${surface}: ${describeCaptureBasis(out)}`)
    if (out.status !== 'granted') continue
    assert.equal(out.scenario, null, surface)
    assert.equal(out.stored, true, surface)
    assert.equal(out.created, true, surface)
    assert.equal(describeCaptureBasis(out), 'granted:no_sequence')

    //  The safeguards ran first, and were told the surface.
    assert.equal(seen.length, 1, surface)
    assert.deepEqual(
      { grant: seen[0].grant, surface: seen[0].surface, sequenceKind: seen[0].sequenceKind, requireEmailUserTyped: seen[0].requireEmailUserTyped },
      { grant: 'notice', surface, sequenceKind: null, requireEmailUserTyped: surface === 'booking' },
      surface,
    )

    assert.equal(w.db.tables.events.length, 1, surface)
    const [event] = w.db.tables.events
    assert.equal(event.kind, 'notice_accepted', surface)
    assert.equal(event.surface, surface)
    assert.equal(event.noticeVersion, versionFor(surface))
    assert.equal(event.noticeCopySha256, NOTICE_VERSIONS[versionFor(surface)].copySha256.en)
    assert.equal(out.eventId, event.id)
    const lead = w.db.tables.leads.find((l: any) => l.id === input.leadId)!
    assert.equal(lead.basisEventId, event.id, `${surface}: the basis is stored on a lead that had none`)
    assert.equal(lead.emailMarketingConsent, null, `${surface}: never an opt-in`)
    assert.equal(w.db.tables.status[0].lastNoticeEventId, event.id)
    assert.equal(w.db.tables.status[0].expressOptInAt, null)

    assert.equal(await startCaptureScenario(out, { surface, email, leadId: input.leadId }, w.deps), null, surface)
    assert.equal(w.calls.scenario.length, 0, `${surface}: startScenario is never called`)
    assert.equal(w.db.tables.enrollments.length, 0)
  }

  //  A booking subject stores the basis on the booking.
  const w = world()
  w.db.tables.bookings.push({ id: 'bk_null', basisEventId: null })
  const out = await applyCaptureBasis(surfaceInput(w, 'booking', 'no-sequence.booking-row@example.com', { scenario: null, leadId: null, bookingId: 'bk_null' }), w.deps)
  assert.ok(out.status === 'granted' && out.stored && out.scenario === null)
  assert.equal(w.db.tables.bookings[0].basisEventId, w.db.tables.events[0].id)
  assert.equal(await startCaptureScenario(out, { surface: 'booking', email: 'no-sequence.booking-row@example.com', bookingId: 'bk_null' }, w.deps), null)
  assert.equal(w.calls.scenario.length, 0)
})

// ── MERGED LEADS: whose notice is the lead's basis ──────────────────────

test('merged lead: a contact notice after a quote is RECORDED and is the latest notice, but the quote basis is kept — stored false, nothing starts', async () => {
  const w = world()
  const email = 'merged.quote-then-contact@example.com'
  const quote = quoteInput(w, email, { submissionKey: 'sess-quote' })
  const first = await applyCaptureBasis(quote, w.deps)
  assert.equal(first.status, 'granted', describeCaptureBasis(first))
  if (first.status !== 'granted') return
  assert.equal(first.stored, true)
  const lead = w.db.tables.leads.find((l: any) => l.id === quote.leadId)!
  const quoteEvent = first.eventId
  assert.equal(lead.basisEventId, quoteEvent)

  //  The contact form merges into the same open lead (ingestLead's rule) —
  //  same leadId — and names lead_nurture. Replacing the quote basis would end
  //  the running quote follow-ups at send time, so the lead keeps it.
  const later = new Date(NOW.getTime() + 60_000)
  w.deps.now = () => later
  const contact = await applyCaptureBasis(surfaceInput(w, 'contact', email, { leadId: quote.leadId, submissionKey: 'sess-contact' }), w.deps)
  assert.equal(contact.status, 'granted', describeCaptureBasis(contact))
  if (contact.status !== 'granted') return
  assert.equal(contact.scenario, 'lead_nurture')
  assert.equal(contact.stored, false, 'the lead keeps its quote basis')
  assert.equal(contact.created, true)
  assert.equal(describeCaptureBasis(contact), 'granted:lead_nurture:not_stored')

  //  The contact notice itself is recorded as the notice it is.
  const notices = w.db.tables.events.filter((e: any) => e.kind === 'notice_accepted')
  assert.equal(notices.length, 2)
  assert.equal(w.db.tables.events.filter((e: any) => e.kind === 'basis_withheld').length, 0, 'nothing is withheld')
  const contactEvent = notices.find((e: any) => e.id === contact.eventId)!
  assert.equal(contactEvent.surface, 'contact')
  assert.equal(contactEvent.leadId, quote.leadId)
  assert.equal(lead.basisEventId, quoteEvent, 'the quote basis survives')
  assert.equal(lead.emailMarketingConsent, null, 'never an opt-in')
  assert.equal(w.db.tables.status.length, 1)
  assert.equal(w.db.tables.status[0].lastNoticeEventId, contact.eventId, 'the person’s LATEST notice (for campaigns) is the contact one')

  //  Not stored → nothing starts: the lead already runs the more specific sequence.
  assert.equal(await startCaptureScenario(contact, { surface: 'contact', email, leadId: quote.leadId }, w.deps), null)
  assert.equal(w.calls.scenario.length, 0, 'startScenario is never called')
  assert.equal(w.db.tables.enrollments.length, 0)

  //  The running quote follow-up still reads its own quote basis.
  const followup = await promotionalEligibility(
    { context: 'scenario_flow', email, subject: { type: 'lead', id: quote.leadId as string, sequenceKind: 'quote_followup' }, now: later },
    eligibilityDeps(w),
  )
  assert.deepEqual(followup, { eligible: true, basis: 'notice', basisEventId: quoteEvent })
})

test('merged lead: a popup basis is replaced by a contact notice (stored, started), and a later real quote replaces the contact basis', async () => {
  const w = world({ env: ENV_POPUP_ON })
  const email = 'merged.popup-contact-quote@example.com'
  const popup = surfaceInput(w, 'popup', email, { submissionKey: 'sess-popup' })
  const leadId = popup.leadId as string
  const lead = w.db.tables.leads.find((l: any) => l.id === leadId)!
  const first = await applyCaptureBasis(popup, w.deps)
  assert.equal(first.status, 'granted', describeCaptureBasis(first))
  if (first.status !== 'granted') return
  assert.equal(first.stored, true)
  assert.equal(lead.basisEventId, first.eventId)

  //  popup → contact: the contact notice permits every lead sequence the popup did.
  w.deps.now = () => new Date(NOW.getTime() + 60_000)
  const contact = await applyCaptureBasis(surfaceInput(w, 'contact', email, { leadId, submissionKey: 'sess-contact' }), w.deps)
  assert.equal(contact.status, 'granted', describeCaptureBasis(contact))
  if (contact.status !== 'granted') return
  assert.equal(contact.stored, true, 'popup → contact replaces the basis')
  assert.equal(describeCaptureBasis(contact), 'granted:lead_nurture')
  assert.equal(lead.basisEventId, contact.eventId)
  assert.deepEqual(await startCaptureScenario(contact, { surface: 'contact', email, leadId }, w.deps), { scheduled: true, stages: 3 })

  //  contact → a real quote: the quote permits more, so it replaces the basis
  //  and its quote follow-up starts from the quote event.
  w.deps.now = () => new Date(NOW.getTime() + 120_000)
  const quote = await applyCaptureBasis(quoteInput(w, email, { leadId, submissionKey: 'sess-quote' }), w.deps)
  assert.equal(quote.status, 'granted', describeCaptureBasis(quote))
  if (quote.status !== 'granted') return
  assert.equal(quote.stored, true, 'contact → quote replaces the basis')
  assert.equal(lead.basisEventId, quote.eventId)
  assert.deepEqual(await startCaptureScenario(quote, { surface: 'quote', email, leadId }, w.deps), { scheduled: true, stages: 3 })

  assert.deepEqual(w.calls.scenario, [
    { surface: 'contact', scenario: 'lead_nurture', leadId, bookingId: null, basisEventId: contact.eventId, email },
    { surface: 'quote', scenario: 'quote_followup', leadId, bookingId: null, basisEventId: quote.eventId, email },
  ])
  assert.equal(w.db.tables.events.filter((e: any) => e.kind === 'notice_accepted').length, 3)
  assert.equal(w.db.tables.status[0].lastNoticeEventId, quote.eventId)
})

test('merged lead: every pair of surfaces — the basis moves only to a notice that permits every lead sequence the current one does', async () => {
  const cases: Array<[NoticeSurface, NoticeSurface, boolean]> = [
    ['quote', 'contact', false],
    ['quote', 'contact_support', false],
    ['quote', 'tracker', false],
    ['quote', 'popup', false],
    ['quote', 'booking', false],
    ['quote', 'quote', true],
    ['contact', 'quote', true],
    ['popup', 'contact', true],
    ['booking', 'contact', true],
    ['contact_support', 'popup', true],
    ['tracker', 'contact_support', true],
    ['contact', 'booking', true],
  ]
  const inputFor = (w: World, surface: NoticeSurface, email: string, extra: Partial<CaptureBasisInput>) =>
    surface === 'quote' ? quoteInput(w, email, extra) : surfaceInput(w, surface, email, extra)
  for (const [currentSurface, nextSurface, replaced] of cases) {
    const label = `${currentSurface} → ${nextSurface}`
    const w = world({ env: ENV_POPUP_ON })
    const email = `pair.${currentSurface.replace('_', '-')}.${nextSurface.replace('_', '-')}@example.com`
    const firstInput = inputFor(w, currentSurface, email, { submissionKey: 'sess-first' })
    const leadId = firstInput.leadId as string
    const first = await applyCaptureBasis(firstInput, w.deps)
    assert.equal(first.status, 'granted', `${label}: ${describeCaptureBasis(first)}`)
    if (first.status !== 'granted') continue

    w.deps.now = () => new Date(NOW.getTime() + 60_000)
    const next = await applyCaptureBasis(inputFor(w, nextSurface, email, { leadId, submissionKey: 'sess-next' }), w.deps)
    assert.equal(next.status, 'granted', `${label}: the newer notice is always recorded`)
    if (next.status !== 'granted') continue
    assert.equal(next.stored, replaced, label)
    const lead = w.db.tables.leads.find((l: any) => l.id === leadId)!
    assert.equal(lead.basisEventId, replaced ? next.eventId : first.eventId, label)
    assert.equal(w.db.tables.status[0].lastNoticeEventId, next.eventId, `${label}: the latest notice moves either way`)
    const scen = await startCaptureScenario(next, { surface: nextSurface, email, leadId }, w.deps)
    assert.equal(scen === null, !replaced, `${label}: started only when stored`)
    assert.equal(w.calls.scenario.length, replaced ? 1 : 0, label)
  }
})

test('lead_nurture on every surface: the safeguards still decide — popup flag, notice flag, honeypot, identity, throttle', async () => {
  const withheld = async (w: World, input: CaptureBasisInput, reason: string) => {
    const out = await applyCaptureBasis(input, w.deps)
    assert.deepEqual({ status: out.status, reason: (out as any).reason }, { status: 'withheld', reason }, `${input.surface}: ${reason}`)
    assert.equal(w.db.tables.events[w.db.tables.events.length - 1].kind, 'basis_withheld')
    assert.equal(w.db.tables.events[w.db.tables.events.length - 1].withheldReason, reason)
    assert.equal(w.db.tables.leads.find((l: any) => l.id === input.leadId)!.basisEventId, null)
    assert.equal(await startCaptureScenario(out, { surface: input.surface, email: input.email, leadId: input.leadId }, w.deps), null)
    assert.equal(w.calls.scenario.length, 0)
  }
  //  The popup without OFFER_SIGNUP_ENABLED.
  const popupOff = world()
  await withheld(popupOff, surfaceInput(popupOff, 'popup', 'popup.off@example.com'), 'offer_signup_disabled')
  //  Every surface without EMAIL_NOTICE_BASIS_ENABLED — the popup included.
  for (const surface of NOTICE_SURFACES) {
    const off = world({ env: { CONSENT_IP_HMAC_SECRET: ENV_ON.CONSENT_IP_HMAC_SECRET, OFFER_SIGNUP_ENABLED: 'true' } })
    await withheld(off, surfaceInput(off, surface, `flag.off.${surface.replace('_', '-')}@example.com`), 'notice_basis_disabled')
  }
  const bot = world()
  await withheld(bot, surfaceInput(bot, 'contact_support', 'bot@example.com', { honeypot: 'Acme Corp' }), 'honeypot')
  const reserved = world({ realIdentity: true })
  await withheld(reserved, surfaceInput(reserved, 'tracker', 'reserved@example.com'), 'reserved_address')
  const typed = world()
  await withheld(typed, surfaceInput(typed, 'booking', 'not.typed@example.com', { contract: { marketingNotice: { version: versionFor('booking'), trigger: 'continue' }, emailUserTyped: false } }), 'email_not_user_typed')

  //  The per-IP limit counts lead-nurture grants like any other.
  const busy = world({ env: ENV_POPUP_ON })
  const outs = []
  const perIp = GRANT_LIMITS.perIpDistinctEmails24h
  for (let i = 0; i < perIp + 2; i++) outs.push(await applyCaptureBasis(surfaceInput(busy, 'popup', `popup.bulk${i}@example.com`), busy.deps))
  assert.deepEqual(outs.map((o) => o.status), [...Array(perIp).fill('granted'), 'withheld', 'withheld'])
  assert.ok(outs.slice(perIp).every((o) => o.status === 'withheld' && o.reason === 'ip_throttle'))
})

test('a NAMED scenario the surface may not start is withheld as no_scenario, before any safeguard', async () => {
  const cases: Array<[NoticeSurface, string]> = [
    ['quote', 'abandoned_checkout'],
    ['booking', 'quote_followup'],
    ['contact', 'quote_followup'],
    ['contact', 'abandoned_checkout'],
    ['contact_support', 'quote_followup'],
    ['contact_support', 'abandoned_checkout'],
    ['tracker', 'quote_followup'],
    ['tracker', 'abandoned_checkout'],
    ['popup', 'quote_followup'],
    ['popup', 'abandoned_checkout'],
    //  The removed scenario kinds, on the surfaces that used to start them.
    ['quote', 'lead_nurture_quote_request'],
    ['booking', 'lead_nurture_booking_form'],
    ['contact', 'lead_nurture_contact'],
    ['tracker', 'lead_nurture_contact'],
    ['popup', 'offer'],
  ]
  for (const [surface, scenario] of cases) {
    const w = world({ env: ENV_POPUP_ON })
    const email = `wrong.scenario.${surface.replace('_', '-')}@example.com`
    const input = surfaceInput(w, surface, email, { scenario: scenario as SequenceKind })
    const out = await applyCaptureBasis(input, w.deps)
    const label = `${surface} → ${scenario}`
    assert.equal(out.status, 'withheld', label)
    assert.equal((out as any).reason, 'no_scenario', label)
    assert.equal(w.calls.evaluate, 0, `${label}: refused before the safeguards and throttles`)
    assert.equal(w.db.tables.events.length, 1, label)
    assert.equal(w.db.tables.events[0].kind, 'basis_withheld', label)
    assert.equal(w.db.tables.events[0].noticeCopySha256, NOTICE_VERSIONS[versionFor(surface)].copySha256.en, `${label}: the registered copy is kept as evidence`)
    assert.equal(w.db.tables.leads.find((l: any) => l.id === input.leadId)!.basisEventId, null, label)
    assert.equal(w.db.tables.status.length, 0, label)
    assert.equal(await startCaptureScenario(out, { surface, email, leadId: input.leadId }, w.deps), null)
    assert.equal(w.calls.scenario.length, 0, label)
  }
})

test('every surface’s OWN scenarios are granted, stored and started — quote: quote_followup | lead_nurture; booking: abandoned_checkout (booking) | lead_nurture (lead); contact, contact_support, tracker, popup: lead_nurture', async () => {
  //  The table every route relies on (owner direction 2026-09-16), pinned literally.
  assert.deepEqual(SURFACE_SEQUENCE_KINDS, {
    quote: ['quote_followup', 'lead_nurture'],
    booking: ['abandoned_checkout', 'lead_nurture'],
    contact: ['lead_nurture'],
    contact_support: ['lead_nurture'],
    tracker: ['lead_nurture'],
    popup: ['lead_nurture'],
  })

  const cases: Array<{ surface: NoticeSurface; scenario: SequenceKind; subject: 'lead' | 'booking' }> = [
    { surface: 'quote', scenario: 'quote_followup', subject: 'lead' },
    { surface: 'quote', scenario: 'lead_nurture', subject: 'lead' },
    { surface: 'booking', scenario: 'abandoned_checkout', subject: 'booking' },
    { surface: 'booking', scenario: 'lead_nurture', subject: 'lead' },
    { surface: 'contact', scenario: 'lead_nurture', subject: 'lead' },
    { surface: 'contact_support', scenario: 'lead_nurture', subject: 'lead' },
    { surface: 'tracker', scenario: 'lead_nurture', subject: 'lead' },
    { surface: 'popup', scenario: 'lead_nurture', subject: 'lead' },
  ]
  for (const c of cases) {
    const label = `${c.surface} → ${c.scenario}`
    const w = world({ env: ENV_POPUP_ON })
    const seen: GrantSafeguardInput[] = []
    const realEvaluate = w.deps.evaluate
    w.deps.evaluate = async (i) => {
      seen.push(i)
      return realEvaluate(i)
    }
    const email = `own.${c.surface.replace('_', '-')}.${c.scenario.replace(/_/g, '-')}@example.com`
    assertTestRecipient(email)

    let input: CaptureBasisInput
    if (c.subject === 'booking') {
      //  The booking SUBMIT (/api/bookings): the unpaid booking is the subject.
      w.db.tables.bookings.push({ id: 'bk_own', basisEventId: null })
      input = {
        surface: 'booking',
        scenario: c.scenario,
        email,
        bookingId: 'bk_own',
        contract: { marketingNotice: { version: 'booking-2026-09-16-r2', trigger: 'submit' }, emailUserTyped: true },
        acceptTrigger: 'submit',
        locale: 'es',
        client: CLIENT,
      }
    } else if (c.surface === 'quote') {
      input = quoteInput(w, email, { scenario: c.scenario })
    } else {
      input = surfaceInput(w, c.surface, email, { scenario: c.scenario })
    }

    const out = await applyCaptureBasis(input, w.deps)
    assert.equal(out.status, 'granted', `${label}: ${describeCaptureBasis(out)}`)
    if (out.status !== 'granted') continue
    assert.equal(out.scenario, c.scenario, label)
    assert.equal(out.stored, true, label)
    assert.equal(describeCaptureBasis(out), `granted:${c.scenario}`, label)
    assert.equal(seen.length, 1, label)
    assert.equal(seen[0].sequenceKind, c.scenario, `${label}: the safeguards are told the sequence`)

    assert.equal(w.db.tables.events.length, 1, label)
    const [event] = w.db.tables.events
    assert.equal(event.kind, 'notice_accepted', label)
    assert.equal(event.surface, c.surface, label)
    assert.equal(out.eventId, event.id, label)
    const row =
      c.subject === 'booking'
        ? w.db.tables.bookings.find((b: any) => b.id === input.bookingId)!
        : w.db.tables.leads.find((l: any) => l.id === input.leadId)!
    assert.equal(row.basisEventId, event.id, `${label}: the basis is stored on the ${c.subject}`)

    const scen = await startCaptureScenario(out, { surface: c.surface, email, leadId: input.leadId, bookingId: input.bookingId }, w.deps)
    assert.deepEqual(scen, { scheduled: true, stages: 3 }, label)
    assert.deepEqual(
      w.calls.scenario,
      [{ surface: c.surface, scenario: c.scenario, leadId: input.leadId ?? null, bookingId: input.bookingId ?? null, basisEventId: event.id, email }],
      `${label}: startScenario is called with the route's own scenario`,
    )
    assert.equal(w.db.tables.enrollments.length, 0, `${label}: capture writes no enrollment — the journeys' claim does`)

    //  The stored notice is a scenario_flow basis for exactly this sequence.
    const decision = await promotionalEligibility(
      {
        context: 'scenario_flow',
        email,
        subject: { type: c.subject, id: (c.subject === 'booking' ? input.bookingId : input.leadId) as string, sequenceKind: c.scenario },
        now: NOW,
      },
      eligibilityDeps(w),
    )
    assert.deepEqual(decision, { eligible: true, basis: 'notice', basisEventId: event.id }, label)
  }
})

// ── THE OPT-OUT BOX ─────────────────────────────────────────────────────

test('opt-out box: opted_out_at_capture, the person’s active enrollments stop, jobs are cancelled — and no grant even with a valid notice', async () => {
  const w = world()
  const email = 'opt.out@example.com'
  //  An existing active sequence for this person, from an earlier booking —
  //  another kind than the quote below: the opt-out stops every kind.
  seedEnrollment(w, { id: 'enr_old', email, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: 'bk_earlier' })
  const input = quoteInput(w, email, {
    contract: { marketingNotice: { version: 'quote-2026-09-16-r2', trigger: 'submit' }, emailMarketingOptOut: true },
  })
  const out = await applyCaptureBasis(input, w.deps)
  assert.equal(out.status, 'opted_out')
  assert.equal(w.calls.evaluate, 0, 'an opt-out is never evaluated as a grant')
  assert.deepEqual(
    w.db.tables.events.map((e: any) => e.kind),
    ['opted_out_at_capture'],
  )
  assert.equal(w.db.tables.events[0].optOutBox, true)
  assert.equal(w.db.tables.events[0].noticeVersion, 'quote-2026-09-16-r2', 'what they were shown is kept as evidence')
  assert.equal(w.db.tables.enrollments[0].status, 'stopped')
  assert.equal(w.calls.optedOut.length, 1)
  assert.deepEqual(w.calls.optedOut[0].stopped.map((r) => r.id), ['enr_old'])
  assert.ok(w.db.tables.status[0].optedOutAt instanceof Date)
  assert.equal(w.db.tables.leads.find((l: any) => l.id === input.leadId)!.basisEventId, null)
  assert.equal(await startCaptureScenario(out, { surface: 'quote', email, leadId: input.leadId }, w.deps), null)

  //  A LATER notice from the same person may be recorded as evidence, but it
  //  does not lift the opt-out: only a confirmed express opt-in can.
  const later = await applyCaptureBasis(quoteInput(w, email, { submissionKey: 'later' }), w.deps)
  assert.equal(later.status, 'granted')
  const decision = await promotionalEligibility(
    {
      context: 'scenario_flow',
      email,
      subject: { type: 'lead', id: w.db.tables.leads[w.db.tables.leads.length - 1].id, sequenceKind: 'quote_followup' },
      now: NOW,
    },
    { db: w.db as unknown as EligibilityDb, env: ENV_ON, testIdentity: async () => null },
  )
  assert.equal(decision.eligible, false)
  if (!decision.eligible) assert.equal(decision.reason, 'opted_out')
  //  Nor for a campaign, although that later notice is now the latest submission.
  assert.equal(w.db.tables.status[0].lastNoticeEventId, (later as { eventId: string }).eventId)
  const campaign = await promotionalEligibility(
    { context: 'campaign', email, now: NOW },
    { db: w.db as unknown as EligibilityDb, env: ENV_ON, testIdentity: async () => null },
  )
  assert.equal(campaign.eligible, false)
  if (!campaign.eligible) assert.equal(campaign.reason, 'opted_out')
})

test('opt-out box on EVERY surface, with the route’s lead_nurture named: opted_out_at_capture, a running lead nurture stops, nothing is granted or started', async () => {
  for (const surface of NOTICE_SURFACES) {
    const w = world({ env: ENV_POPUP_ON })
    const email = `opt.out.${surface.replace('_', '-')}@example.com`
    //  The person is already in the lead nurture from an earlier form.
    seedEnrollment(w, { id: 'enr_nurture', email, sequenceKind: 'lead_nurture', subjectType: 'lead', subjectId: 'lead_earlier' })
    const trigger = surface === 'booking' ? 'continue' : 'submit'
    const input = surfaceInput(w, surface, email, {
      contract: { marketingNotice: { version: versionFor(surface), trigger }, emailUserTyped: true, emailMarketingOptOut: true },
    })
    assert.equal(input.scenario, 'lead_nurture', surface)

    const out = await applyCaptureBasis(input, w.deps)
    assert.equal(out.status, 'opted_out', surface)
    assert.equal(w.calls.evaluate, 0, `${surface}: an opt-out is never evaluated as a grant`)
    assert.deepEqual(w.db.tables.events.map((e: any) => e.kind), ['opted_out_at_capture'], surface)
    const [event] = w.db.tables.events
    assert.equal(event.optOutBox, true, surface)
    assert.equal(event.surface, surface)
    assert.equal(event.noticeVersion, versionFor(surface), `${surface}: what they were shown is kept as evidence`)
    assert.equal(w.db.tables.enrollments[0].status, 'stopped', `${surface}: the running lead nurture stops`)
    assert.deepEqual(w.calls.optedOut.map((o) => o.stopped.map((r) => r.id)), [['enr_nurture']], `${surface}: its queued jobs are cancelled`)
    assert.ok(w.db.tables.status[0].optedOutAt instanceof Date, surface)
    assert.equal(w.db.tables.status[0].lastNoticeEventId, null, `${surface}: an opt-out is not a notice`)
    assert.equal(w.db.tables.leads.find((l: any) => l.id === input.leadId)!.basisEventId, null, surface)

    assert.equal(await startCaptureScenario(out, { surface, email, leadId: input.leadId }, w.deps), null, surface)
    assert.equal(w.calls.scenario.length, 0, `${surface}: startScenario is never called`)
    const decision = await promotionalEligibility(
      { context: 'scenario_flow', email, subject: { type: 'lead', id: input.leadId as string, sequenceKind: 'lead_nurture' }, now: NOW },
      eligibilityDeps(w),
    )
    assert.equal(decision.eligible, false, surface)
    if (!decision.eligible) assert.equal(decision.reason, 'opted_out', surface)
  }
})

test('opt-out box is honoured on ANY trigger (the safe direction), and a failed write still cancels jobs', async () => {
  const w = world()
  const email = 'beacon.optout@example.com'
  const out = await applyCaptureBasis(
    {
      surface: 'booking',
      scenario: 'lead_nurture',
      email,
      leadId: seedLead(w, email),
      contract: { emailMarketingOptOut: true },
      acceptTrigger: 'continue',
      client: CLIENT,
    },
    w.deps,
  )
  assert.equal(out.status, 'opted_out')

  const failing = world()
  failing.deps.record = async () => ({ ok: false, reason: 'db_error', detail: 'down' })
  const res = await applyCaptureBasis(
    { ...quoteInput(failing, email), contract: { emailMarketingOptOut: true } },
    failing.deps,
  )
  assert.deepEqual(res, { status: 'error', reason: 'db_error' })
  assert.equal(failing.calls.optedOut.length, 1, 'queued jobs are still cancelled')
})

// ── SAFEGUARDS THROUGH THE ROUTE HELPER ─────────────────────────────────

test('staff/test identities are never granted (a reserved @example.com address with the real identity check)', async () => {
  const w = world({ realIdentity: true })
  const out = await applyCaptureBasis(quoteInput(w, 'real.identity.check@example.com'), w.deps)
  assert.equal(out.status, 'withheld')
  assert.equal((out as any).reason, 'reserved_address')
})

test('duplicates: the same submission five times → ONE notice event; a NEW submission from an already-enrolled person is GRANTED as the notice it is, and still de-duplicates', async () => {
  const w = world()
  const email = 'double.click@example.com'
  const leadId = seedLead(w, email)
  const input: CaptureBasisInput = { ...quoteInput(w, email), leadId, submissionKey: 'sess-dup' }
  const outs = []
  for (let i = 0; i < 5; i++) outs.push(await applyCaptureBasis(input, w.deps))
  assert.ok(outs.every((o) => o.status === 'granted'))
  assert.equal(w.db.tables.events.filter((e: any) => e.kind === 'notice_accepted').length, 1)
  assert.equal(new Set(outs.map((o: any) => o.eventId)).size, 1)
  assert.deepEqual(outs.map((o: any) => o.created), [true, false, false, false, false])
  const firstEventId = (outs[0] as { eventId: string }).eventId

  //  Once the person is enrolled, a NEW submission (another lead, another
  //  session) is recorded as the notice it is — no per-address withholding.
  //  Whether it starts a SECOND copy is the enrollment claim's decision
  //  (journeys.claimEnrollment and the unique key), never capture's: capture
  //  writes, ends and replaces no enrollment.
  seedEnrollment(w, { id: 'enr_1', email, sequenceKind: 'quote_followup', subjectType: 'lead', subjectId: leadId })
  w.deps.now = () => new Date(NOW.getTime() + 60_000)
  const secondInput: CaptureBasisInput = { ...quoteInput(w, email), submissionKey: 'sess-new' }
  const again = await applyCaptureBasis(secondInput, w.deps)
  assert.equal(again.status, 'granted', describeCaptureBasis(again))
  if (again.status !== 'granted') return
  assert.equal(again.created, true)
  assert.equal(again.stored, true)
  assert.notEqual(again.eventId, firstEventId)
  assert.equal(w.db.tables.events.filter((e: any) => e.kind === 'notice_accepted').length, 2)
  assert.equal(w.db.tables.events.filter((e: any) => e.kind === 'basis_withheld').length, 0, 'no already_enrolled withholding')
  assert.equal(w.db.tables.leads.find((l: any) => l.id === secondInput.leadId)!.basisEventId, again.eventId)
  assert.equal(w.db.tables.leads.find((l: any) => l.id === leadId)!.basisEventId, firstEventId, 'the first lead keeps its own basis')
  assert.equal(w.db.tables.status[0].lastNoticeEventId, again.eventId)
  assert.deepEqual(
    w.db.tables.enrollments.map((e: any) => [e.id, e.status, e.subjectId]),
    [['enr_1', 'active', leadId]],
    'the running enrollment is untouched',
  )
  await startCaptureScenario(again, { surface: 'quote', email, leadId: secondInput.leadId }, w.deps)
  assert.deepEqual(w.calls.scenario, [
    { surface: 'quote', scenario: 'quote_followup', leadId: secondInput.leadId, bookingId: null, basisEventId: again.eventId, email },
  ])

  //  That new submission, repeated, is still ONE event.
  for (let i = 0; i < 3; i++) {
    const repeat = await applyCaptureBasis(secondInput, w.deps)
    assert.equal(repeat.status, 'granted')
    assert.equal((repeat as { eventId: string }).eventId, again.eventId)
    assert.equal((repeat as { created: boolean }).created, false)
  }
  assert.equal(w.db.tables.events.filter((e: any) => e.kind === 'notice_accepted').length, 2)

  //  The same for the lead nurture: a person already in it who sends the
  //  contact form is granted, not withheld.
  const n = world()
  const nurtureEmail = 'already.nurtured@example.com'
  seedEnrollment(n, { id: 'enr_nurture', email: nurtureEmail, sequenceKind: 'lead_nurture', subjectType: 'lead', subjectId: 'lead_earlier' })
  const contact = await applyCaptureBasis(surfaceInput(n, 'contact', nurtureEmail, { submissionKey: 'sess-contact' }), n.deps)
  assert.equal(contact.status, 'granted', describeCaptureBasis(contact))
  assert.equal(n.db.tables.events.map((e: any) => e.kind).join(), 'notice_accepted')
  assert.equal(n.db.tables.enrollments[0].status, 'active')
})

test('abuse: ten addresses from one IP → only the per-IP limit is granted; every lead is still saved by its route', async () => {
  const w = world()
  const outs = []
  const perIp = GRANT_LIMITS.perIpDistinctEmails24h
  assert.ok(perIp < 10, 'the scenario needs more addresses than the limit')
  for (let i = 0; i < 10; i++) outs.push(await applyCaptureBasis(quoteInput(w, `bulk${i}@example.com`), w.deps))
  assert.equal(outs.filter((o) => o.status === 'granted').length, perIp)
  assert.ok(outs.slice(perIp).every((o) => o.status === 'withheld' && o.reason === 'ip_throttle'))
  //  A granted person submitting AGAIN from the same IP is not a new address.
  const again = await applyCaptureBasis({ ...quoteInput(w, 'bulk0@example.com'), submissionKey: 'sess-bulk0-again' }, w.deps)
  assert.equal(again.status, 'granted')
})

test('abuse: one IPv6 /64 is one connection — rotating the interface id does not escape the per-IP limit', async () => {
  const w = world()
  const perIp = GRANT_LIMITS.perIpDistinctEmails24h
  const outs = []
  for (let i = 0; i < perIp + 2; i++) {
    const ip = `2001:db8:aa:bb:${(i + 1).toString(16)}:1:2:3`
    outs.push(await applyCaptureBasis({ ...quoteInput(w, `v6.bulk${i}@example.com`), client: { ...CLIENT, ip } }, w.deps))
  }
  assert.equal(outs.filter((o) => o.status === 'granted').length, perIp)
  assert.ok(outs.slice(perIp).every((o) => o.status === 'withheld' && o.reason === 'ip_throttle'))
})

test('a suppressed address may record a notice but can never be sent promotional mail', async () => {
  const w = world()
  const email = 'suppressed.person@example.com'
  w.db.tables.suppressions.push({ email, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  const input = quoteInput(w, email)
  const out = await applyCaptureBasis(input, w.deps)
  assert.equal(out.status, 'granted', 'the capture itself does not reveal or depend on suppression')
  for (const sequenceKind of ['quote_followup', 'lead_nurture'] as const) {
    const decision = await promotionalEligibility(
      { context: 'scenario_flow', email, subject: { type: 'lead', id: input.leadId as string, sequenceKind }, now: NOW },
      { db: w.db as unknown as EligibilityDb, env: ENV_ON, testIdentity: async () => null },
    )
    assert.equal(decision.eligible, false, sequenceKind)
    if (!decision.eligible) assert.equal(decision.reason, 'suppressed', sequenceKind)
  }
  const campaign = await promotionalEligibility(
    { context: 'campaign', email, now: NOW },
    { db: w.db as unknown as EligibilityDb, env: ENV_ON, testIdentity: async () => null },
  )
  assert.equal(campaign.eligible, false)
  if (!campaign.eligible) assert.equal(campaign.reason, 'suppressed', 'the latest notice never outranks a suppression')
  assert.equal(w.db.tables.suppressions.length, 1, 'capture never deletes or downgrades a suppression')
})

// ── FAILURES NEVER THROW ────────────────────────────────────────────────

test('a basis that could not be STORED starts nothing; a failed event write or a throwing safeguard is an outcome, not an exception', async () => {
  const w = world({ storeThrows: true })
  const input = quoteInput(w, 'store.fails@example.com')
  const out = await applyCaptureBasis(input, w.deps)
  assert.equal(out.status, 'granted')
  assert.equal((out as any).stored, false)
  assert.equal(await startCaptureScenario(out, { surface: 'quote', email: 'store.fails@example.com', leadId: input.leadId }, w.deps), null)
  assert.equal(w.calls.scenario.length, 0)

  const w2 = world()
  w2.deps.record = async () => ({ ok: false, reason: 'db_error', detail: 'relation does not exist' })
  assert.deepEqual(await applyCaptureBasis(quoteInput(w2, 'no.table@example.com'), w2.deps), { status: 'error', reason: 'db_error' })

  const w3 = world()
  w3.deps.evaluate = async () => {
    throw new Error('boom')
  }
  assert.deepEqual(await applyCaptureBasis(quoteInput(w3, 'boom@example.com'), w3.deps), { status: 'error', reason: 'exception' })

  const w4 = world()
  w4.deps.startScenario = async () => {
    throw new Error('redis down')
  }
  const granted = await applyCaptureBasis(quoteInput(w4, 'redis.down@example.com'), w4.deps)
  assert.equal(await startCaptureScenario(granted, { surface: 'quote', email: 'redis.down@example.com', leadId: 'x' }, w4.deps), null)
})

// ── TRACKER FORWARDS ────────────────────────────────────────────────────

test('tracker: a stale or future submittedAt is withheld; a forward with no notice leaves a no_notice event', async () => {
  const base = (w: World, email: string): CaptureBasisInput => ({
    surface: 'tracker',
    //  What notify/lead names for a forwarded tracker submission.
    scenario: 'lead_nurture',
    email,
    leadId: seedLead(w, email),
    contract: { marketingNotice: { version: 'tracker-2026-09-16-r2', trigger: 'submit' } },
    acceptTrigger: 'submit',
    locale: 'en',
    client: { ip: '198.51.100.20', userAgent: 'tracker-forward', pageUrl: null },
    submissionKey: 'trk_1001',
  })
  const stale = world()
  const oldInput = { ...base(stale, 'tracker.old@example.com'), submittedAt: new Date(NOW.getTime() - MAX_SUBMISSION_AGE_MS - 1000) }
  const old = await applyCaptureBasis(oldInput, stale.deps)
  assert.equal((old as any).reason, 'stale_submission')
  assert.equal(await startCaptureScenario(old, { surface: 'tracker', email: 'tracker.old@example.com', leadId: oldInput.leadId }, stale.deps), null)
  assert.equal(stale.calls.scenario.length, 0, 'a stale forward starts nothing')
  const future = world()
  const aheadInput = { ...base(future, 'tracker.future@example.com'), submittedAt: new Date(NOW.getTime() + 60 * 60 * 1000) }
  const ahead = await applyCaptureBasis(aheadInput, future.deps)
  assert.equal((ahead as any).reason, 'stale_submission')
  assert.equal(await startCaptureScenario(ahead, { surface: 'tracker', email: 'tracker.future@example.com', leadId: aheadInput.leadId }, future.deps), null)
  assert.equal(future.calls.scenario.length, 0)

  const fresh = world()
  const freshInput = { ...base(fresh, 'tracker.fresh@example.com'), submittedAt: new Date(NOW.getTime() - 60_000) }
  const ok = await applyCaptureBasis(freshInput, fresh.deps)
  assert.equal(ok.status, 'granted')
  if (ok.status !== 'granted') return
  assert.equal(ok.scenario, 'lead_nurture', 'the tracker forward enters the lead nurture')
  assert.equal(ok.stored, true)
  assert.deepEqual(
    await startCaptureScenario(ok, { surface: 'tracker', email: 'tracker.fresh@example.com', leadId: freshInput.leadId }, fresh.deps),
    { scheduled: true, stages: 3 },
  )
  assert.deepEqual(fresh.calls.scenario, [
    { surface: 'tracker', scenario: 'lead_nurture', leadId: freshInput.leadId, bookingId: null, basisEventId: ok.eventId, email: 'tracker.fresh@example.com' },
  ])
  assert.equal(fresh.db.tables.events[0].surface, 'tracker')
  assert.match(fresh.db.tables.events[0].requestId, /^tracker:submit:trk_1001:[0-9a-f]{16}$/)
  //  The replay check the route performs finds it.
  assert.equal(await fresh.deps.submissionSeen(captureRequestId('tracker', 'submit', 'trk_1001', 'tracker.fresh@example.com')), true)

  const none = world()
  const absent = await applyCaptureBasis({ ...base(none, 'tracker.nonotice@example.com'), contract: {}, recordAbsentNotice: true }, none.deps)
  assert.equal((absent as any).reason, 'no_notice')
  assert.equal(none.db.tables.events[0].kind, 'basis_withheld')
})

test('the global breaker withholds and alerts ONCE per trip', async () => {
  const w = world()
  //  The limit's worth of distinct granted addresses already today, from other IPs.
  for (let i = 0; i < GRANT_LIMITS.globalGrants24h; i++) {
    w.db.tables.events.push({
      id: `seed_${i}`, emailNormalized: `seed${i}@example.com`, kind: 'notice_accepted', surface: 'quote',
      requestId: `seed:${i}`, occurredAt: new Date(NOW.getTime() - 60_000), ipHmac: `ip${i}`,
    })
  }
  const a = await applyCaptureBasis(quoteInput(w, 'breaker.a@example.com'), w.deps)
  const b = await applyCaptureBasis({ ...quoteInput(w, 'breaker.b@example.com'), client: { ...CLIENT, ip: '203.0.113.99' } }, w.deps)
  assert.equal((a as any).reason, 'global_breaker')
  assert.equal((b as any).reason, 'global_breaker')
  assert.equal(w.calls.alerts, 1)
})
