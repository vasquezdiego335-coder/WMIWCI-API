// ════════════════════════════════════════════════════════════════════════
//  SCENARIO JOURNEYS — routing, gates, person-level stop, send-time checks
//  (email consent release 2026-09-16, owner direction "every genuine form
//  submission enters the most appropriate EXISTING sequence")
//  ---------------------------------------------------------------------
//  What this file pins:
//    • every genuine submission enters an EXISTING sequence, bounded by
//      SURFACE_SEQUENCE_KINDS: quote.html with a real quote → quote_followup
//      (Sequence A), a submitted-but-unpaid booking → abandoned_checkout, and
//      lead_nurture (Sequence B) from EVERY surface (quote without a price,
//      booking contact step, contact, contact_support, tracker, popup). A kind
//      the surface does not list is refused 'scenario_not_on_surface' before
//      anything is read;
//    • the existing flags (EMAIL_JOURNEY_<X>_DISABLED), the promotions kill
//      switch and EMAIL_NOTICE_BASIS_ENABLED;
//    • one sequence per person (per kind), the staff/repair/legacy capture
//      paths staying express-only, person-level stop on booking and on opt-out;
//    • the send-time gate (scenarioSendDecision / leadSendEligibility) for
//      quote_followup AND lead_nurture on a notice: the lead's own active
//      enrollment, person_booked_since, every prohibition;
//    • the quick-quote delivery gate (quote_followup on a notice only — lead
//      nurture has none);
//    • the legacy Sequence A / B scheduling for express opt-ins, unchanged;
//    • the pure helpers the workers use (sequenceKindForTemplate,
//      stageLocaleFromBasis, greetingName);
//    • the review fixes: a booking on record (leads.hasBookingOnRecord) refuses
//      the nurture, an ACTIVE row that outlived its stages counts as ended for
//      an express person only, the subject-level stop on payment /
//      cancellation / lead close, and "already sent" never re-enrolls a lead.
//
//  OFFLINE. The journeys run against:
//    • the REAL consent modules (promotionalEligibility, enrollSequence,
//      recordConsentEvent) over the in-memory consent database, so the unique
//      enrollment row, the stored basis and the prohibitions are the production
//      code, not a restatement of it;
//    • a fake queue that DEDUPLICATES on job id, exactly like BullMQ;
//    • a fixed clock.
//  No Postgres, no Redis, no provider. Every address is @example.com, which is
//  a reserved (test) domain — so the test-identity check is injected as "not a
//  test identity" wherever a path must be eligible.
// ════════════════════════════════════════════════════════════════════════
import './_journeys-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'
import { memoryRetryStore } from './_lifecycle-retry-memory-db'
import {
  ABANDONED_STAGES,
  BOOKING_STOPS_KINDS,
  CONFIRMATION_WAIT_MAX_MS,
  CONFIRMATION_WAIT_STEP_MS,
  LEAD_NURTURE_STAGES,
  QUOTE_STAGES,
  applyConfirmationGate,
  confirmationGateDecision,
  defaultJourneyDeps,
  defaultStageDeps,
  enrollmentOutlivedItsStages,
  ensureQuoteJourney,
  greetingName,
  jobIdFor,
  journeyKeyFor,
  journeyQueueEdge,
  leadSendEligibility,
  marketingConsentBlock,
  needsConfirmationGate,
  onBookingCancelled,
  onBookingCreated,
  onBookingPaid,
  onCheckoutStarted,
  onLeadCaptured,
  onLeadClosed,
  onNoticeSubmission,
  onPersonBooked,
  onPersonOptedOut,
  scenarioSendDecision,
  sequenceKindEnabled,
  sequenceKindForTemplate,
  stageJobIdsForKind,
  stageLocaleFromBasis,
  stagesForKind,
  type ConfirmationState,
  type JourneyDeps,
  type JourneyLead,
  type StageDeps,
  type StageLead,
} from '../journeys'
import { hasBookingOnRecord } from '../leads'
import { retryWindowFor, type QueueLike } from '../lifecycle-enqueue'
import { runLifecycleRetrySweep, sweepShiftFor } from '../lifecycle-retry-sweep'
import { promotionalEligibility, type EligibilityDb } from '../consent/marketing-eligibility'
import { activeEnrollment, enrollSequence, personBookedSince } from '../consent/sequence-enrollment'
import { recordConsentEvent, type ConsentEventsDb } from '../consent/consent-events'
import {
  NOTICE_SURFACES,
  NOTICE_VERSIONS,
  SEQUENCE_KINDS,
  SURFACE_SEQUENCE_KINDS,
  type NoticeSurface,
  type SequenceKind,
} from '../consent/notice-registry'

assertNoProductionCredentials()

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 11:00 America/New_York, four days after the notice policy started. */
const NOW = new Date('2026-09-20T15:00:00.000Z')
const EMAIL = 'sam@example.com'

/** Run `fn` with these env values set (undefined = unset), then restore. */
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {}
  for (const k of Object.keys(values)) {
    before[k] = process.env[k]
    if (values[k] === undefined) delete process.env[k]
    else process.env[k] = values[k]
  }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(before)) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
  }
}

const NOTICE_ENV = { EMAIL_NOTICE_BASIS_ENABLED: 'true' }
const notTest = async () => null

/** The registered r2 notice version rendered on each surface. */
const VERSION_FOR: Record<NoticeSurface, string> = {
  quote: 'quote-2026-09-16-r2',
  booking: 'booking-2026-09-16-r2',
  contact: 'contact-2026-09-16-r2',
  contact_support: 'contact-2026-09-16-r2',
  tracker: 'tracker-2026-09-16-r2',
  popup: 'popup-2026-09-16-r2',
}

/** The surfaces whose submission can only ever start lead nurture (Sequence B). */
const NURTURE_ONLY_SURFACES = ['contact', 'contact_support', 'tracker', 'popup'] as const

// ════════════════════════════════════════════════════════════════════════
//  THE WORLD
// ════════════════════════════════════════════════════════════════════════

type World = ReturnType<typeof world>

function world(opts: { eligibilityEnv?: Record<string, string | undefined>; now?: Date } = {}) {
  let now = opts.now ?? NOW
  const db = createFakeConsentDb({ now: () => now })
  const jobs = new Map<string, { stage: string; data: Record<string, unknown>; fireAt: Date }>()
  const cancelled: string[] = []
  const eligibilityEnv = opts.eligibilityEnv ?? NOTICE_ENV
  const bookingBlocks = new Map<string, string | null>()
  let enqueueSeq = 0

  const leadRow = (id: string) => db.tables.leads.find((l: Record<string, unknown>) => l.id === id)

  const deps: JourneyDeps = {
    now: () => now,
    async enqueue(stage, data, fireAt, jobId) {
      enqueueSeq++
      if (!jobs.has(jobId)) jobs.set(jobId, { stage, data, fireAt })
    },
    async cancel(jobId) {
      cancelled.push(jobId)
      jobs.delete(jobId)
    },
    async loadLead(leadId) {
      const r = leadRow(leadId)
      if (!r) return null
      return {
        id: r.id,
        email: r.email ?? null,
        status: r.status ?? 'NEW',
        quotedAt: r.quotedAt ?? null,
        bookedAt: r.bookedAt ?? null,
        lostAt: r.lostAt ?? null,
        moveDate: r.moveDate ?? null,
        convertedBookingId: r.convertedBookingId ?? null,
        emailMarketingConsent: r.emailMarketingConsent ?? null,
        basisEventId: r.basisEventId ?? null,
      } as JourneyLead
    },
    async hasEverBooked() {
      return false
    },
    async bookingMarketingBlock(bookingId) {
      return bookingBlocks.has(bookingId) ? bookingBlocks.get(bookingId)! : 'no_marketing_consent'
    },
    async siblingUnpaidBooking() {
      return null
    },
    async convertLead() {
      return null
    },
    async loadBookingDates() {
      return null
    },
    async repairCandidates() {
      return []
    },
    async leadsAlreadyAttempted() {
      return new Set()
    },
    fireLeadTrigger() {},
    fireBookingTrigger() {},
    stopEnrollments() {},
    eligibility: (req) => promotionalEligibility(req, { db: db as unknown as EligibilityDb, env: eligibilityEnv, testIdentity: notTest }),
    enrollSequence: (input) => enrollSequence(input, db as never),
    async stopPersonEnrollments(email, reason, kinds) {
      const active = db.tables.enrollments.filter(
        (e: Record<string, unknown>) => e.emailNormalized === email.toLowerCase() && e.status === 'active' && kinds.includes(e.sequenceKind as SequenceKind)
      )
      for (const e of active) Object.assign(e, { status: 'stopped', stopReason: reason })
      return active.map((e: Record<string, unknown>) => ({ id: e.id, sequenceKind: e.sequenceKind, subjectType: e.subjectType, subjectId: e.subjectId })) as never
    },
    async openLeadIdsForEmail(email) {
      return db.tables.leads
        .filter((l: Record<string, unknown>) => String(l.email ?? '').toLowerCase() === email.toLowerCase() && !l.bookedAt && !l.convertedBookingId)
        .map((l: Record<string, unknown>) => l.id as string)
    },
    async loadBookingBasis(bookingId) {
      const b = db.tables.bookings.find((x: Record<string, unknown>) => x.id === bookingId)
      if (!b) return null
      const c = db.tables.customers.find((x: Record<string, unknown>) => x.id === b.customerId)
      return { email: (c?.email as string) ?? null, basisEventId: (b.basisEventId as string) ?? null }
    },
  }

  const confirmation = new Map<string, ConfirmationState>()
  const stoppedByGate: string[] = []
  const stage: StageDeps = {
    now: () => now,
    env: process.env,
    async loadStageLead(leadId) {
      const r = leadRow(leadId)
      if (!r) return null
      return {
        id: r.id,
        name: r.name ?? 'Sam',
        email: r.email ?? null,
        status: r.status ?? 'NEW',
        quotedAt: r.quotedAt ?? null,
        bookedAt: r.bookedAt ?? null,
        lostAt: r.lostAt ?? null,
        moveDate: r.moveDate ?? null,
        convertedBookingId: r.convertedBookingId ?? null,
        jobType: null,
        createdAt: r.createdAt ?? new Date(NOW.getTime() - HOUR),
        basisEventId: r.basisEventId ?? null,
        emailMarketingConsent: r.emailMarketingConsent ?? null,
      } as StageLead
    },
    eligibility: (req) => promotionalEligibility(req, { db: db as unknown as EligibilityDb, env: eligibilityEnv, testIdentity: notTest }),
    async hasEverBooked() {
      return false
    },
    activeEnrollment: (email, kind) => activeEnrollment(email, kind, db as never),
    personBookedSince: (email, since) => personBookedSince(email, since, db as never),
    async quoteConfirmationState(leadId) {
      return confirmation.get(leadId) ?? 'pending'
    },
    async stopEnrollment(id, reason) {
      stoppedByGate.push(id)
      const e = db.tables.enrollments.find((x: Record<string, unknown>) => x.id === id && x.status === 'active')
      if (e) Object.assign(e, { status: 'stopped', stopReason: reason })
    },
  }

  return {
    db,
    deps,
    stage,
    jobs,
    cancelled,
    confirmation,
    stoppedByGate,
    bookingBlocks,
    enqueues: () => enqueueSeq,
    setNow(d: Date) {
      now = d
    },
    addLead(id: string, over: Record<string, unknown> = {}) {
      const row = { id, name: 'Sam', email: EMAIL, status: 'NEW', emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null, createdAt: new Date(now.getTime() - HOUR), ...over }
      db.tables.leads.push(row)
      return row
    },
    addBooking(id: string, over: Record<string, unknown> = {}) {
      if (!db.tables.customers.some((c: Record<string, unknown>) => c.id === 'cus_1')) {
        db.tables.customers.push({ id: 'cus_1', email: EMAIL, emailMarketingConsent: null, marketingOptOut: false })
      }
      const row = { id, customerId: 'cus_1', createdAt: now, isInternalTest: false, basisEventId: null, ...over }
      db.tables.bookings.push(row)
      return row
    },
    /** A notice_accepted event through the REAL writer, then stored on the subject like the route does. */
    async notice(surface: NoticeSurface, subject: { leadId?: string; bookingId?: string }, over: { email?: string; locale?: 'en' | 'es'; occurredAt?: Date; requestId?: string } = {}) {
      const version = VERSION_FOR[surface]
      const locale = over.locale ?? 'en'
      const r = await recordConsentEvent(
        {
          email: over.email ?? EMAIL,
          kind: 'notice_accepted',
          surface,
          requestId: over.requestId ?? `req_${surface}_${subject.leadId ?? subject.bookingId}`,
          leadId: subject.leadId,
          bookingId: subject.bookingId,
          noticeVersion: version,
          noticeCopySha256: NOTICE_VERSIONS[version].copySha256[locale],
          locale,
          regionSignal: 'nanp',
          emailUserTyped: true,
          occurredAt: over.occurredAt ?? now,
        },
        db as unknown as ConsentEventsDb
      )
      assert.ok(r.ok, `notice event recorded: ${JSON.stringify(r)}`)
      const id = (r as { event: { id: string } }).event.id
      if (subject.leadId) leadRow(subject.leadId)!.basisEventId = id
      if (subject.bookingId) db.tables.bookings.find((b: Record<string, unknown>) => b.id === subject.bookingId)!.basisEventId = id
      return id
    },
    enrollmentsFor(kind?: SequenceKind) {
      return db.tables.enrollments.filter((e: Record<string, unknown>) => !kind || e.sequenceKind === kind)
    },
  }
}

const ids = (kind: SequenceKind, subjectId: string) => stageJobIdsForKind(kind, subjectId)
const nurtureIds = (leadId: string) => LEAD_NURTURE_STAGES.map((s) => jobIdFor('lead-nurture', s.type, leadId))
const hasAll = (w: World, list: string[]) => list.every((id) => w.jobs.has(id))
const hasNone = (w: World, list: string[]) => list.every((id) => !w.jobs.has(id))

/** A quote-page lead with a REAL quote, its quote notice, enrolled in Sequence A through its own submission. */
async function enrolledQuoteLead(w: World, over: Record<string, unknown> = {}) {
  w.addLead('lead_q', { quotedAt: NOW, ...over })
  const basis = await w.notice('quote', { leadId: 'lead_q' })
  const out = await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: basis, email: EMAIL }, w.deps)
  assert.deepEqual(out, { scheduled: true, stages: 3 }, 'precondition: the quote notice enrolled Sequence A')
  return basis
}

/** What the email worker passes for a Sequence A stage. */
const QUOTE_SEND = { context: 'scenario_flow' as const, sequenceKind: 'quote_followup', recipient: EMAIL }

/**
 * A lead with NO quote, a notice from `surface`, enrolled in lead nurture
 * (Sequence B) through its own submission.
 */
async function enrolledNurtureLead(
  w: World,
  surface: NoticeSurface = 'contact',
  leadId = 'lead_n',
  notice: { locale?: 'en' | 'es'; requestId?: string } = {}
) {
  w.addLead(leadId)
  const basis = await w.notice(surface, { leadId }, notice)
  const out = await onNoticeSubmission({ surface, scenario: 'lead_nurture', leadId, basisEventId: basis, email: EMAIL }, w.deps)
  assert.deepEqual(out, { scheduled: true, stages: 3 }, `precondition: the ${surface} notice enrolled lead nurture`)
  return basis
}

/** What the email worker passes for a lead-nurture stage: the template names the kind. */
const NURTURE_SEND = { context: 'scenario_flow' as const, recipient: EMAIL }

/** An address that opted in on its own lead row (the legacy express basis). */
const OPTED_IN = { emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) }

// ════════════════════════════════════════════════════════════════════════
//  1. FLAGS
// ════════════════════════════════════════════════════════════════════════

test('flags: every scenario kind keeps its EXISTING journey flag, plus the promotions switch', () => {
  const on = { EMAIL_PROMOTIONS_ENABLED: 'true' }
  assert.equal(sequenceKindEnabled('quote_followup', on), true)
  assert.equal(sequenceKindEnabled('quote_followup', { ...on, EMAIL_JOURNEY_QUOTE_DISABLED: 'true' }), false)
  assert.equal(sequenceKindEnabled('quote_followup', { ...on, EMAIL_JOURNEY_ABANDONED_DISABLED: 'true' }), true, 'each kind has its own flag')
  assert.equal(sequenceKindEnabled('quote_followup', { ...on, EMAIL_JOURNEY_LEAD_NURTURE_DISABLED: 'true' }), true)
  assert.equal(sequenceKindEnabled('abandoned_checkout', on), true)
  assert.equal(sequenceKindEnabled('abandoned_checkout', { ...on, EMAIL_JOURNEY_ABANDONED_DISABLED: 'true' }), false)
  assert.equal(sequenceKindEnabled('abandoned_checkout', { ...on, EMAIL_JOURNEY_QUOTE_DISABLED: 'true' }), true)
  assert.equal(sequenceKindEnabled('abandoned_checkout', { ...on, EMAIL_JOURNEY_LEAD_NURTURE_DISABLED: 'true' }), true)
  // Lead nurture honours the flag it has always had.
  assert.equal(sequenceKindEnabled('lead_nurture', on), true)
  assert.equal(sequenceKindEnabled('lead_nurture', { ...on, EMAIL_JOURNEY_LEAD_NURTURE_DISABLED: 'true' }), false)
  assert.equal(sequenceKindEnabled('lead_nurture', { ...on, EMAIL_JOURNEY_QUOTE_DISABLED: 'true', EMAIL_JOURNEY_ABANDONED_DISABLED: 'true' }), true)
  // The promotions switch must be exactly "true".
  assert.equal(sequenceKindEnabled('abandoned_checkout', {}), false)
  assert.equal(sequenceKindEnabled('quote_followup', { EMAIL_PROMOTIONS_ENABLED: '1' }), false)
  assert.equal(sequenceKindEnabled('lead_nurture', {}), false)
  assert.equal(sequenceKindEnabled('lead_nurture', { EMAIL_PROMOTIONS_ENABLED: 'TRUE' }), false)
  // A kind the registry does not know (a stale job's kind) is never enabled.
  assert.equal(sequenceKindEnabled('lead_nurture_contact' as SequenceKind, on), false)
})

test('flags off: EMAIL_JOURNEY_QUOTE_DISABLED / EMAIL_JOURNEY_ABANDONED_DISABLED stop a valid notice submission — nothing enrolls or queues', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const quoteBasis = await w.notice('quote', { leadId: 'lead_q' })
  w.addBooking('bk_1')
  const bookingBasis = await w.notice('booking', { bookingId: 'bk_1' })
  await withEnv({ EMAIL_JOURNEY_QUOTE_DISABLED: 'true' }, async () => {
    const out = await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: quoteBasis, email: EMAIL }, w.deps)
    assert.deepEqual(out, { scheduled: false, reason: 'journey_disabled' })
  })
  await withEnv({ EMAIL_JOURNEY_ABANDONED_DISABLED: 'true' }, async () => {
    const out = await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: bookingBasis, email: EMAIL }, w.deps)
    assert.deepEqual(out, { scheduled: false, reason: 'not_scheduled' })
  })
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0, 'no enrollment row either')
})

test('flags off: the promotions kill switch stops the notice paths AND the legacy journeys', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const quoteBasis = await w.notice('quote', { leadId: 'lead_q' })
  w.addBooking('bk_1')
  const bookingBasis = await w.notice('booking', { bookingId: 'bk_1' })
  w.addLead('lead_x', { email: 'pat@example.com', emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY), quotedAt: NOW })
  w.addLead('lead_b', { email: 'lee@example.com', emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  await withEnv({ EMAIL_PROMOTIONS_ENABLED: undefined }, async () => {
    assert.deepEqual(
      await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: quoteBasis, email: EMAIL }, w.deps),
      { scheduled: false, reason: 'promotions_disabled' }
    )
    assert.equal((await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: bookingBasis, email: EMAIL }, w.deps)).scheduled, false)
    assert.deepEqual(await ensureQuoteJourney('lead_x', w.deps), { scheduled: false, reason: 'promotions_disabled' })
    assert.equal(await onLeadCaptured('lead_b', w.deps), null)
  })
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0)
})

test('flags off: without EMAIL_NOTICE_BASIS_ENABLED a notice is not a basis — nothing enrolls', async () => {
  const w = world({ eligibilityEnv: {} })
  w.addLead('lead_q', { quotedAt: NOW })
  const quoteBasis = await w.notice('quote', { leadId: 'lead_q' })
  w.addBooking('bk_1')
  const bookingBasis = await w.notice('booking', { bookingId: 'bk_1' })
  const quote = await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: quoteBasis, email: EMAIL }, w.deps)
  assert.deepEqual(quote, { scheduled: false, reason: 'notice_basis_disabled' })
  const booking = await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: bookingBasis, email: EMAIL }, w.deps)
  assert.deepEqual(booking, { scheduled: false, reason: 'not_scheduled' })
  w.addLead('lead_n')
  const nurtureBasis = await w.notice('contact', { leadId: 'lead_n' })
  const nurture = await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: nurtureBasis, email: EMAIL }, w.deps)
  assert.deepEqual(nurture, { scheduled: false, reason: 'notice_basis_disabled' })
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0)
})

test('flags off: EMAIL_JOURNEY_LEAD_NURTURE_DISABLED or the promotions switch stops a lead-nurture submission on every surface; flags back on, the same submission enrolls', async () => {
  for (const surface of NOTICE_SURFACES) {
    const w = world()
    w.addLead('lead_n')
    const basis = await w.notice(surface, { leadId: 'lead_n' })
    const input = { surface, scenario: 'lead_nurture' as const, leadId: 'lead_n', basisEventId: basis, email: EMAIL }
    await withEnv({ EMAIL_JOURNEY_LEAD_NURTURE_DISABLED: 'true' }, async () => {
      assert.deepEqual(await onNoticeSubmission(input, w.deps), { scheduled: false, reason: 'journey_disabled' }, `${surface}: nurture flag`)
      // The other kinds' flags are untouched by it.
      assert.equal(sequenceKindEnabled('quote_followup'), true)
    })
    //  The promotions switch is part of the lead-nurture journey's own enabled()
    //  check, so the nurture names it journey_disabled (ensureQuoteJourney
    //  reports promotions_disabled separately).
    await withEnv({ EMAIL_PROMOTIONS_ENABLED: undefined }, async () => {
      assert.deepEqual(await onNoticeSubmission(input, w.deps), { scheduled: false, reason: 'journey_disabled' }, `${surface}: promotions off`)
    })
    assert.equal(w.jobs.size, 0, surface)
    assert.equal(w.enrollmentsFor().length, 0, `${surface}: a flag refusal never takes the person’s slot`)
    // The refusal was the flag and nothing else.
    assert.deepEqual(await onNoticeSubmission(input, w.deps), { scheduled: true, stages: 3 }, surface)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  2. ROUTING PER SCENARIO
// ════════════════════════════════════════════════════════════════════════

test('routing: SEQUENCE_KINDS is exactly the three existing-template kinds; every surface may start lead nurture, only quote Sequence A, only booking abandoned checkout', () => {
  assert.deepEqual([...SEQUENCE_KINDS], ['quote_followup', 'abandoned_checkout', 'lead_nurture'])
  assert.deepEqual(
    Object.fromEntries(NOTICE_SURFACES.map((s) => [s, [...SURFACE_SEQUENCE_KINDS[s]]])),
    {
      quote: ['quote_followup', 'lead_nurture'],
      booking: ['abandoned_checkout', 'lead_nurture'],
      // Every genuine submission enters the general follow-up (Sequence B).
      contact: ['lead_nurture'],
      contact_support: ['lead_nurture'],
      tracker: ['lead_nurture'],
      popup: ['lead_nurture'],
    }
  )
  for (const s of NOTICE_SURFACES) {
    assert.ok(SURFACE_SEQUENCE_KINDS[s].includes('lead_nurture'), `${s} may start lead nurture`)
    assert.equal(SURFACE_SEQUENCE_KINDS[s].includes('quote_followup'), s === 'quote', `${s}: Sequence A only from the quote page`)
    assert.equal(SURFACE_SEQUENCE_KINDS[s].includes('abandoned_checkout'), s === 'booking', `${s}: abandoned checkout only from the booking form`)
  }
  for (const s of NURTURE_ONLY_SURFACES) assert.deepEqual(SURFACE_SEQUENCE_KINDS[s], ['lead_nurture'], `${s} starts lead nurture and nothing else`)
  // The world above records a registered notice for every surface.
  for (const s of NOTICE_SURFACES) assert.ok(NOTICE_VERSIONS[VERSION_FOR[s]].surfaces.includes(s), `${VERSION_FOR[s]} is rendered on ${s}`)
})

test('routing: a kind the surface cannot start is refused as scenario_not_on_surface before anything is read, and schedules nothing', async () => {
  const w = world()
  const reads: string[] = []
  const spy: JourneyDeps = {
    ...w.deps,
    loadLead: async (id) => (reads.push(`lead:${id}`), w.deps.loadLead(id)),
    loadBookingBasis: async (id) => (reads.push(`booking:${id}`), w.deps.loadBookingBasis!(id)),
    eligibility: async (req) => (reads.push(`eligibility:${req.email}`), w.deps.eligibility!(req)),
    enrollSequence: async (input) => (reads.push(`enroll:${input.subjectId}`), w.deps.enrollSequence!(input)),
  }
  const refusedPairs: string[] = []
  for (const surface of NOTICE_SURFACES) {
    // A REAL quoted lead and booking with a real notice from this surface, so
    // the refusal cannot be a missing quote, subject or basis.
    const leadId = `lead_${surface}`
    const bookingId = `bk_${surface}`
    w.addLead(leadId, { quotedAt: NOW })
    w.addBooking(bookingId)
    const leadBasis = await w.notice(surface, { leadId })
    const bookingBasis = await w.notice(surface, { bookingId })
    for (const scenario of SEQUENCE_KINDS) {
      if (SURFACE_SEQUENCE_KINDS[surface].includes(scenario)) continue
      refusedPairs.push(`${scenario}@${surface}`)
      const out = await onNoticeSubmission(
        scenario === 'abandoned_checkout'
          ? { surface, scenario, bookingId, basisEventId: bookingBasis, email: EMAIL }
          : { surface, scenario, leadId, basisEventId: leadBasis, email: EMAIL },
        spy
      )
      assert.deepEqual(out, { scheduled: false, reason: 'scenario_not_on_surface' }, `${scenario} on ${surface}`)
    }
  }
  for (const pair of [
    'quote_followup@contact',
    'quote_followup@contact_support',
    'quote_followup@tracker',
    'quote_followup@popup',
    'quote_followup@booking',
    'abandoned_checkout@quote',
    'abandoned_checkout@contact',
    'abandoned_checkout@contact_support',
    'abandoned_checkout@tracker',
    'abandoned_checkout@popup',
  ]) {
    assert.ok(refusedPairs.includes(pair), `${pair} is refused`)
  }
  for (const s of NOTICE_SURFACES) assert.ok(!refusedPairs.includes(`lead_nurture@${s}`), `lead_nurture is never refused on ${s}`)
  // An unknown surface is refused as such.
  const base = { leadId: 'lead_quote', basisEventId: null, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission({ ...base, surface: 'nope' as NoticeSurface, scenario: 'quote_followup' }, spy), { scheduled: false, reason: 'unknown_surface' })
  // A kind that is not in the registry (a removed scenario name) never passes either.
  assert.deepEqual(
    await onNoticeSubmission({ ...base, surface: 'contact', scenario: 'lead_nurture_contact' as SequenceKind }, spy),
    { scheduled: false, reason: 'scenario_not_on_surface' }
  )
  assert.deepEqual(reads, [], 'refused before any lead, booking, eligibility or enrollment read')
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0)
})

test('routing: quote page WITH a real quote → Sequence A (quote_followup), not a nurture; without one → no_quote', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_q' })
  const out = await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: basis, email: EMAIL }, w.deps)
  assert.deepEqual(out, { scheduled: true, stages: 3 })
  assert.ok(hasAll(w, QUOTE_STAGES.map((s) => jobIdFor('quote', s.type, 'lead_q'))))
  assert.deepEqual([...w.jobs.keys()].sort(), ids('quote_followup', 'lead_q').sort())
  assert.ok(hasNone(w, nurtureIds('lead_q')), 'no lead-nurture stage is ever queued for it')
  const rows = w.enrollmentsFor('quote_followup')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].basisEventId, basis, 'the enrollment names the notice it runs under')

  // A quote-page lead with no REAL quote gets no quote sequence.
  const w2 = world()
  w2.addLead('lead_n')
  const b2 = await w2.notice('quote', { leadId: 'lead_n' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_n', basisEventId: b2, email: EMAIL }, w2.deps),
    { scheduled: false, reason: 'no_quote' }
  )
  assert.equal(w2.jobs.size, 0)
  assert.equal(w2.enrollmentsFor().length, 0)
})

test('routing: a STAFF "mark quoted" or the repair sweep never enrolls a notice-only lead; only the submission path may', async () => {
  //  The admin route and the repair sweep call ensureQuoteJourney / onQuoteCreated
  //  without options. A staff edit is not the submission the notice was shown
  //  for, so for them the lead's notice is not a basis — express only.
  const w = world()
  w.addLead('lead_staff', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_staff' })
  const staff = await ensureQuoteJourney('lead_staff', w.deps)
  assert.equal(staff.scheduled, false, 'mark-quoted on a notice-only lead schedules nothing')
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor('quote_followup').length, 0, 'and never occupies the person’s slot')
  //  The customer's own submission (onNoticeSubmission) still may.
  const own = await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_staff', basisEventId: basis, email: EMAIL }, w.deps)
  assert.deepEqual(own, { scheduled: true, stages: 3 })
  //  An EXPRESS opt-in is unaffected: the admin path schedules it as before.
  const w2 = world()
  w2.addLead('lead_express', { quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  assert.deepEqual(await ensureQuoteJourney('lead_express', w2.deps), { scheduled: true, stages: 3 })
})

test('routing: the basis is scoped to its surface in ELIGIBILITY too — only a quote-page notice can permit Sequence A, even when asked directly', async () => {
  // Bypassing the entry point's surface check (ensureQuoteJourney with the
  // submission option) still refuses: the eligibility gate only accepts a
  // notice whose surface lists the sequence kind. Lead nurture being on every
  // surface widens nothing for Sequence A.
  for (const surface of NOTICE_SURFACES.filter((s) => s !== 'quote')) {
    const w = world()
    w.addLead('lead_1', { quotedAt: NOW })
    await w.notice(surface, { leadId: 'lead_1' })
    const out = await ensureQuoteJourney('lead_1', w.deps, { allowNoticeBasis: true })
    assert.deepEqual(out, { scheduled: false, reason: 'no_marketing_consent' }, surface)
    assert.equal(w.jobs.size, 0)
    assert.equal(w.enrollmentsFor().length, 0)
  }
})

test('routing: booking submit → abandoned checkout for the BOOKING, on its stored booking-surface notice', async () => {
  const w = world()
  w.addBooking('bk_1')
  const basis = await w.notice('booking', { bookingId: 'bk_1' })
  const out = await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: basis, email: EMAIL }, w.deps)
  assert.deepEqual(out, { scheduled: true, stages: 3 })
  assert.ok(hasAll(w, ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, 'bk_1'))))
  assert.equal(w.enrollmentsFor('abandoned_checkout')[0].subjectId, 'bk_1')
  assert.equal(w.enrollmentsFor('abandoned_checkout')[0].basisEventId, basis)
})

test('routing: a legacy refusal other than "no consent column" is never overridden by a notice', async () => {
  const w = world()
  w.addBooking('bk_1')
  const basis = await w.notice('booking', { bookingId: 'bk_1' })
  w.bookingBlocks.set('bk_1', 'not_in_rollout_allowlist')
  const out = await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: basis, email: EMAIL }, w.deps)
  assert.equal(out.scheduled, false)
  assert.equal(w.jobs.size, 0)
})

test('routing: the address and the basis must be the ones STORED on the subject', async () => {
  const w = world()
  w.addLead('lead_1', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_1' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_1', basisEventId: basis, email: 'someone-else@example.com' }, w.deps),
    { scheduled: false, reason: 'basis_email_mismatch' }
  )
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_1', basisEventId: 'evt_forged', email: EMAIL }, w.deps),
    { scheduled: false, reason: 'basis_not_stored' }
  )
  w.addBooking('bk_1')
  const bookingBasis = await w.notice('booking', { bookingId: 'bk_1' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: bookingBasis, email: 'someone-else@example.com' }, w.deps),
    { scheduled: false, reason: 'basis_email_mismatch' }
  )
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: 'evt_forged', email: EMAIL }, w.deps),
    { scheduled: false, reason: 'basis_not_stored' }
  )
  assert.equal(w.jobs.size, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  3. LEAD NURTURE — EVERY GENUINE SUBMISSION (Sequence B on a form notice)
// ════════════════════════════════════════════════════════════════════════

test('lead nurture: a genuine submission on EVERY surface enters Sequence B — three stages at +4h/+24h/+72h, the existing job ids, ONE enrollment on the stored notice', async () => {
  for (const surface of NOTICE_SURFACES) {
    const w = world()
    // No quotedAt: on the quote page this is the "no price" (manual plan / in person) path.
    w.addLead('lead_n')
    const basis = await w.notice(surface, { leadId: 'lead_n' })
    const out = await onNoticeSubmission({ surface, scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, w.deps)
    assert.deepEqual(out, { scheduled: true, stages: 3 }, surface)

    // Exactly the ids the legacy Sequence B scheduler has always used, so every
    // existing cancel (onLeadClosed, ensureQuoteJourney, stopPerson) finds them.
    assert.deepEqual(
      [...w.jobs.keys()].sort(),
      ['journey__lead-nurture__lead-nurture-1__lead_n', 'journey__lead-nurture__lead-nurture-2__lead_n', 'journey__lead-nurture__lead-nurture-final__lead_n'],
      surface
    )
    assert.deepEqual([...w.jobs.keys()].sort(), nurtureIds('lead_n').sort())
    assert.deepEqual([...w.jobs.keys()].sort(), ids('lead_nurture', 'lead_n').sort())
    // Anchored on the submission: never overdue, the designed cadence.
    assert.deepEqual(
      LEAD_NURTURE_STAGES.map((s) => w.jobs.get(jobIdFor('lead-nurture', s.type, 'lead_n'))!.fireAt.getTime() - NOW.getTime()),
      [4 * HOUR, 24 * HOUR, 72 * HOUR],
      surface
    )
    for (const s of LEAD_NURTURE_STAGES) {
      const job = w.jobs.get(jobIdFor('lead-nurture', s.type, 'lead_n'))!
      assert.equal(job.stage, s.type)
      assert.deepEqual(job.data, { leadId: 'lead_n' })
    }
    assert.ok(hasNone(w, ids('quote_followup', 'lead_n')), `${surface}: no quote follow-up without a real quote`)

    const rows = w.enrollmentsFor()
    assert.equal(rows.length, 1, `${surface}: one enrollment`)
    assert.equal(rows[0].sequenceKind, 'lead_nurture')
    assert.equal(rows[0].subjectType, 'lead')
    assert.equal(rows[0].subjectId, 'lead_n')
    assert.equal(rows[0].emailNormalized, EMAIL)
    assert.equal(rows[0].status, 'active')
    assert.equal(rows[0].basisEventId, basis, `${surface}: the enrollment names the notice it runs under`)
  }
})

test('lead nurture: the quote page names ONE sequence — a real quote refuses nurture as has_quote (Sequence A owns it); no price refuses Sequence A as no_quote', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_q' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'lead_nurture', leadId: 'lead_q', basisEventId: basis, email: EMAIL }, w.deps),
    { scheduled: false, reason: 'has_quote' }
  )
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0, 'a refused lead never takes the person’s slot')
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: basis, email: EMAIL }, w.deps),
    { scheduled: true, stages: 3 }
  )
  assert.ok(hasNone(w, nurtureIds('lead_q')), 'the two sequences are mutually exclusive on one lead')

  const w2 = world()
  w2.addLead('lead_n')
  const b2 = await w2.notice('quote', { leadId: 'lead_n' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_n', basisEventId: b2, email: EMAIL }, w2.deps),
    { scheduled: false, reason: 'no_quote' }
  )
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: b2, email: EMAIL }, w2.deps),
    { scheduled: true, stages: 3 }
  )
  assert.deepEqual([...w2.jobs.keys()].sort(), nurtureIds('lead_n').sort())
  assert.deepEqual(w2.enrollmentsFor().map((e) => e.sequenceKind), ['lead_nurture'])
})

test('lead nurture: the lead’s state refuses it — previous customer, converted, booked, lost, closed status, move date passed', async () => {
  const cases: Array<{ name: string; lead?: Record<string, unknown>; everBooked?: boolean; reason: string }> = [
    { name: 'previous customer', everBooked: true, reason: 'previous_customer' },
    { name: 'converted', lead: { convertedBookingId: 'bk_old' }, reason: 'lead_converted' },
    { name: 'booked', lead: { bookedAt: new Date(NOW.getTime() - HOUR) }, reason: 'lead_converted' },
    { name: 'lost', lead: { lostAt: new Date(NOW.getTime() - HOUR) }, reason: 'lead_lost' },
    { name: 'status LOST', lead: { status: 'LOST' }, reason: 'lead_status:LOST' },
    { name: 'status WON', lead: { status: 'WON' }, reason: 'lead_status:WON' },
    { name: 'move date passed', lead: { moveDate: new Date(NOW.getTime() - 3 * DAY) }, reason: 'move_date_passed' },
  ]
  for (const c of cases) {
    const w = world()
    w.addLead('lead_n', c.lead ?? {})
    const basis = await w.notice('contact', { leadId: 'lead_n' })
    const deps: JourneyDeps = c.everBooked ? { ...w.deps, hasEverBooked: async () => true } : w.deps
    assert.deepEqual(
      await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, deps),
      { scheduled: false, reason: c.reason },
      c.name
    )
    assert.equal(w.jobs.size, 0, c.name)
    assert.equal(w.enrollmentsFor().length, 0, `${c.name}: never occupies the person’s slot`)
  }
})

test('lead nurture: a per-person prohibition always wins — opted out, unsubscribed, customer opt-out, any suppression, a test identity; a form submission never re-subscribes anyone', async () => {
  const cases: Array<{ name: string; setup: (w: World) => Promise<void> | void; testIdentity?: boolean; reason: string }> = [
    {
      name: 'opt-out box on an earlier form',
      reason: 'opted_out',
      async setup(w) {
        const r = await recordConsentEvent(
          { email: EMAIL, kind: 'opted_out_at_capture', surface: 'contact', requestId: 'req_optout_earlier', occurredAt: new Date(NOW.getTime() - DAY) },
          w.db as unknown as ConsentEventsDb
        )
        assert.ok(r.ok)
      },
    },
    {
      name: 'unsubscribed earlier',
      reason: 'opted_out',
      async setup(w) {
        const r = await recordConsentEvent(
          { email: EMAIL, kind: 'unsubscribed', surface: 'unsubscribe', requestId: 'req_unsub_earlier', occurredAt: new Date(NOW.getTime() - DAY) },
          w.db as unknown as ConsentEventsDb
        )
        assert.ok(r.ok)
      },
    },
    {
      name: 'customer marketingOptOut',
      reason: 'opted_out',
      setup(w) {
        w.db.tables.customers.push({ id: 'cus_opt', email: EMAIL, emailMarketingConsent: null, marketingOptOut: true })
      },
    },
    ...['HARD_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBED', 'MANUAL'].map((reason) => ({
      name: `suppression ${reason}`,
      reason: 'suppressed',
      setup(w: World) {
        w.db.tables.suppressions.push({ email: EMAIL, reason, scope: reason === 'UNSUBSCRIBED' ? 'promotional' : 'all' })
      },
    })),
    { name: 'test identity', reason: 'test_identity', testIdentity: true, setup() {} },
  ]
  for (const c of cases) {
    const w = world()
    await c.setup(w)
    w.addLead('lead_n')
    const basis = await w.notice('popup', { leadId: 'lead_n' })
    const deps: JourneyDeps = c.testIdentity
      ? {
          ...w.deps,
          eligibility: (req) =>
            promotionalEligibility(req, { db: w.db as unknown as EligibilityDb, env: NOTICE_ENV, testIdentity: async () => 'reserved_domain' as const }),
        }
      : w.deps
    assert.deepEqual(
      await onNoticeSubmission({ surface: 'popup', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, deps),
      { scheduled: false, reason: c.reason },
      c.name
    )
    assert.equal(w.jobs.size, 0, c.name)
    assert.equal(w.enrollmentsFor().length, 0, c.name)
  }

  //  The opt-out box ticked on THIS submission: no notice is ever recorded, so
  //  there is no basis and nothing starts.
  const w = world()
  w.addLead('lead_box')
  const ticked = await recordConsentEvent(
    {
      email: EMAIL,
      kind: 'notice_accepted',
      surface: 'contact',
      requestId: 'req_box',
      leadId: 'lead_box',
      noticeVersion: VERSION_FOR.contact,
      noticeCopySha256: NOTICE_VERSIONS[VERSION_FOR.contact].copySha256.en,
      locale: 'en',
      regionSignal: 'nanp',
      optOutBox: true,
    },
    w.db as unknown as ConsentEventsDb
  )
  assert.deepEqual(ticked, { ok: false, reason: 'opt_out_box_ticked' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_box', basisEventId: null, email: EMAIL }, w.deps),
    { scheduled: false, reason: 'no_marketing_consent' }
  )
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0)
})

test('lead nurture: the address and the basis must be the ones STORED on the lead — including a newer notice the lead did NOT adopt', async () => {
  const w = world()
  w.addLead('lead_n')
  const basis = await w.notice('tracker', { leadId: 'lead_n' })
  const input = { surface: 'tracker' as const, scenario: 'lead_nurture' as const, leadId: 'lead_n', basisEventId: basis, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission({ ...input, email: 'someone-else@example.com' }, w.deps), { scheduled: false, reason: 'basis_email_mismatch' })
  assert.deepEqual(await onNoticeSubmission({ ...input, basisEventId: 'evt_forged' }, w.deps), { scheduled: false, reason: 'basis_not_stored' })
  assert.deepEqual(await onNoticeSubmission({ ...input, leadId: 'lead_gone' }, w.deps), { scheduled: false, reason: 'lead_deleted' })
  assert.deepEqual(await onNoticeSubmission({ ...input, leadId: '  ' }, w.deps), { scheduled: false, reason: 'no_lead' })
  assert.deepEqual(await onNoticeSubmission({ ...input, email: '' }, w.deps), { scheduled: false, reason: 'no_email' })

  //  A lead with a quote-page notice later merges a contact message. The newer
  //  notice permits fewer lead sequences, so storeLeadBasis KEEPS the quote
  //  notice; the contact event id is then not the stored basis.
  w.addLead('lead_k')
  const kept = await w.notice('quote', { leadId: 'lead_k' })
  const newer = await w.notice('contact', { leadId: 'lead_k' })
  w.db.tables.leads.find((l: Record<string, unknown>) => l.id === 'lead_k')!.basisEventId = kept
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_k', basisEventId: newer, email: EMAIL }, w.deps),
    { scheduled: false, reason: 'basis_not_stored' }
  )

  //  A lead with no stored notice and no opt-in has no basis at all.
  w.addLead('lead_none', { email: 'pat@example.com' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_none', basisEventId: null, email: 'pat@example.com' }, w.deps),
    { scheduled: false, reason: 'no_marketing_consent' }
  )
  assert.equal(w.jobs.size, 0)
  assert.equal(w.enrollmentsFor().length, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  4. DUPLICATES NEVER DOUBLE-ENROLL
// ════════════════════════════════════════════════════════════════════════

test('duplicates: the same submission twice → one enrollment, one set of jobs', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_q' })
  const input = { surface: 'quote' as const, scenario: 'quote_followup' as const, leadId: 'lead_q', basisEventId: basis, email: EMAIL }
  assert.equal((await onNoticeSubmission(input, w.deps)).scheduled, true)
  assert.equal((await onNoticeSubmission(input, w.deps)).scheduled, true, 'the same subject re-asking stays retryable')
  assert.equal((await onNoticeSubmission({ ...input, email: EMAIL.toUpperCase() }, w.deps)).scheduled, true)
  assert.equal(w.enrollmentsFor().length, 1)
  assert.equal(w.jobs.size, 3)
})

test('duplicates: a SECOND quote-page lead for the same person is refused — one sequence per person', async () => {
  const w = world()
  w.addLead('lead_1', { quotedAt: NOW })
  w.addLead('lead_2', { quotedAt: NOW })
  const b1 = await w.notice('quote', { leadId: 'lead_1' })
  const b2 = await w.notice('quote', { leadId: 'lead_2' })
  assert.equal((await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_1', basisEventId: b1, email: EMAIL }, w.deps)).scheduled, true)
  const second = await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_2', basisEventId: b2, email: EMAIL }, w.deps)
  assert.deepEqual(second, { scheduled: false, reason: 'already_enrolled' })
  assert.equal(w.enrollmentsFor().length, 1)
  assert.ok(hasNone(w, ids('quote_followup', 'lead_2')))
})

test('duplicates: two leads for one person never both get Sequence A', async () => {
  const w = world()
  for (const id of ['lead_a', 'lead_b']) w.addLead(id, { quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  assert.equal((await ensureQuoteJourney('lead_a', w.deps)).scheduled, true)
  assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: false, reason: 'already_enrolled' })
  // The same lead asking again is still retryable (a lost enqueue must be re-addable).
  assert.equal((await ensureQuoteJourney('lead_a', w.deps)).scheduled, true)
  assert.equal(w.enrollmentsFor('quote_followup').length, 1)
  assert.equal(w.jobs.size, 3)
})

test('duplicates: an opted-in customer\'s NEXT quote gets its follow-up once the earlier sequence has ended (today\'s per-flow behaviour)', async () => {
  const w = world()
  const opted = { quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) }
  w.addLead('lead_a', opted)
  assert.equal((await ensureQuoteJourney('lead_a', w.deps)).scheduled, true)
  //  The first sequence ends (booked, completed, stopped) inside the window.
  w.enrollmentsFor('quote_followup')[0].status = 'stopped'
  w.addLead('lead_b', opted)
  assert.equal((await ensureQuoteJourney('lead_b', w.deps)).scheduled, true, 'express / legacy: no new 30-day person limit')
  assert.ok(hasAll(w, ids('quote_followup', 'lead_b')))
  assert.equal(w.enrollmentsFor('quote_followup').length, 1, 'scheduled without a second row, exactly as before this release')
})

test('duplicates: a FORM-NOTICE person gets one quote sequence per 30-day window, even after the first ended', async () => {
  const w = world()
  w.addLead('lead_1', { quotedAt: NOW })
  const b1 = await w.notice('quote', { leadId: 'lead_1' })
  assert.equal((await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_1', basisEventId: b1, email: EMAIL }, w.deps)).scheduled, true)
  w.enrollmentsFor('quote_followup')[0].status = 'stopped'
  w.addLead('lead_2', { quotedAt: NOW })
  const b2 = await w.notice('quote', { leadId: 'lead_2' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_2', basisEventId: b2, email: EMAIL }, w.deps),
    { scheduled: false, reason: 'already_enrolled' }
  )
  assert.ok(hasNone(w, ids('quote_followup', 'lead_2')))
})

test('duplicates: a stopped sequence for the SAME subject is never restarted, whatever the basis', async () => {
  const w = world()
  w.addLead('lead_a', { quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  assert.equal((await ensureQuoteJourney('lead_a', w.deps)).scheduled, true)
  w.enrollmentsFor('quote_followup')[0].status = 'stopped'
  for (const id of ids('quote_followup', 'lead_a')) w.jobs.delete(id)
  assert.deepEqual(await ensureQuoteJourney('lead_a', w.deps), { scheduled: false, reason: 'already_enrolled' })
  assert.ok(hasNone(w, ids('quote_followup', 'lead_a')))
})

test('duplicates: the same lead-nurture submission twice → one enrollment, one set of jobs', async () => {
  const w = world()
  w.addLead('lead_n')
  const basis = await w.notice('contact', { leadId: 'lead_n' })
  const input = { surface: 'contact' as const, scenario: 'lead_nurture' as const, leadId: 'lead_n', basisEventId: basis, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission(input, w.deps), { scheduled: true, stages: 3 })
  const firstFireTimes = [...w.jobs.values()].map((j) => j.fireAt.getTime())
  w.setNow(new Date(NOW.getTime() + 10 * 60_000))
  assert.deepEqual(await onNoticeSubmission(input, w.deps), { scheduled: true, stages: 3 }, 'the same subject re-asking stays retryable')
  assert.equal((await onNoticeSubmission({ ...input, email: EMAIL.toUpperCase() }, w.deps)).scheduled, true)
  assert.equal(w.enrollmentsFor().length, 1)
  assert.equal(w.jobs.size, 3)
  assert.deepEqual([...w.jobs.keys()].sort(), nurtureIds('lead_n').sort())
  assert.deepEqual([...w.jobs.values()].map((j) => j.fireAt.getTime()), firstFireTimes, 'the queue kept the original jobs')
})

test('duplicates: the contact route’s legacy hook and then its submission for one lead → still one enrollment, one set of jobs', async () => {
  //  contact route order: lead saved → basis → team alert → legacy nurture
  //  (express-only) → startCaptureScenario. For an opted-in lead both enroll
  //  the SAME subject; for a notice-only lead only the second does.
  const w = world()
  w.addLead('lead_x', OPTED_IN)
  const basis = await w.notice('contact', { leadId: 'lead_x' })
  assert.equal((await onLeadCaptured('lead_x', w.deps))?.scheduled, 3)
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_x', basisEventId: basis, email: EMAIL }, w.deps),
    { scheduled: true, stages: 3 }
  )
  assert.equal(w.enrollmentsFor('lead_nurture').length, 1)
  assert.deepEqual([...w.jobs.keys()].sort(), nurtureIds('lead_x').sort())

  const n = world()
  n.addLead('lead_n')
  const nb = await n.notice('contact', { leadId: 'lead_n' })
  assert.equal(await onLeadCaptured('lead_n', n.deps), null, 'the legacy hook is express-only')
  assert.equal(n.enrollmentsFor().length, 0, 'and takes no slot')
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: nb, email: EMAIL }, n.deps),
    { scheduled: true, stages: 3 }
  )
  assert.equal(n.enrollmentsFor('lead_nurture').length, 1)
  assert.equal(n.jobs.size, 3)
})

test('duplicates: a SECOND lead for the same NOTICE person is refused already_enrolled — while the first runs AND after it ended inside 30 days; a new window enrolls again', async () => {
  const w = world()
  await enrolledNurtureLead(w, 'contact', 'lead_1')
  w.addLead('lead_2')
  const b2 = await w.notice('popup', { leadId: 'lead_2' })
  const second = { surface: 'popup' as const, scenario: 'lead_nurture' as const, leadId: 'lead_2', basisEventId: b2, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission(second, w.deps), { scheduled: false, reason: 'already_enrolled' }, 'never two nurtures at once')

  //  The first ends (stopped by the gate, say) inside the window.
  w.enrollmentsFor('lead_nurture')[0].status = 'stopped'
  w.setNow(new Date(NOW.getTime() + 20 * DAY))
  assert.deepEqual(await onNoticeSubmission(second, w.deps), { scheduled: false, reason: 'already_enrolled' }, 'one nurture per notice person per 30-day window')
  assert.ok(hasNone(w, nurtureIds('lead_2')))
  assert.equal(w.enrollmentsFor().length, 1)

  //  Past the window a genuine new submission enrolls again.
  w.setNow(new Date(NOW.getTime() + 31 * DAY))
  w.addLead('lead_3')
  const b3 = await w.notice('tracker', { leadId: 'lead_3' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'tracker', scenario: 'lead_nurture', leadId: 'lead_3', basisEventId: b3, email: EMAIL }, w.deps),
    { scheduled: true, stages: 3 }
  )
  assert.equal(w.enrollmentsFor('lead_nurture').length, 2)
  assert.ok(hasAll(w, nurtureIds('lead_3')))
  assert.ok(hasNone(w, nurtureIds('lead_2')))
})

test('duplicates: an EXPRESS person’s second lead is refused while the first nurture runs, and scheduled once it ended (today’s per-flow behaviour)', async () => {
  //  The legacy capture hook.
  const w = world()
  w.addLead('lead_a', OPTED_IN)
  assert.equal((await onLeadCaptured('lead_a', w.deps))?.scheduled, 3)
  w.addLead('lead_b', OPTED_IN)
  assert.equal(await onLeadCaptured('lead_b', w.deps), null, 'never two nurtures at once')
  assert.ok(hasNone(w, nurtureIds('lead_b')))
  w.enrollmentsFor('lead_nurture')[0].status = 'stopped'
  assert.equal((await onLeadCaptured('lead_b', w.deps))?.scheduled, 3, 'express / legacy: no 30-day person limit')
  assert.ok(hasAll(w, nurtureIds('lead_b')))
  assert.equal(w.enrollmentsFor('lead_nurture').length, 1, 'scheduled without a second row, exactly as before this release')

  //  The submission path for an opted-in person: the express basis wins over
  //  the notice, so the same per-flow rule applies.
  const s = world()
  s.addLead('lead_a', OPTED_IN)
  const ba = await s.notice('contact', { leadId: 'lead_a' })
  assert.deepEqual(await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_a', basisEventId: ba, email: EMAIL }, s.deps), { scheduled: true, stages: 3 })
  s.addLead('lead_b', OPTED_IN)
  const bb = await s.notice('popup', { leadId: 'lead_b' })
  const second = { surface: 'popup' as const, scenario: 'lead_nurture' as const, leadId: 'lead_b', basisEventId: bb, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission(second, s.deps), { scheduled: false, reason: 'already_enrolled' })
  s.enrollmentsFor('lead_nurture')[0].status = 'stopped'
  assert.deepEqual(await onNoticeSubmission(second, s.deps), { scheduled: true, stages: 3 })
  assert.ok(hasAll(s, nurtureIds('lead_b')))
})

test('duplicates: a stopped nurture for the SAME lead is never restarted by a re-submission', async () => {
  const w = world()
  const basis = await enrolledNurtureLead(w)
  w.enrollmentsFor('lead_nurture')[0].status = 'stopped'
  for (const id of nurtureIds('lead_n')) w.jobs.delete(id)
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, w.deps),
    { scheduled: false, reason: 'already_enrolled' }
  )
  assert.equal(await onLeadCaptured('lead_n', w.deps), null, 'nor by the legacy hook')
  assert.ok(hasNone(w, nurtureIds('lead_n')))
  assert.equal(w.enrollmentsFor().length, 1)
})

test('campaign recheck: a quick-quote form notice permits the relevant-offer campaign templates; the default context stays express-only', async () => {
  const w = world()
  const basis = await enrolledQuoteLead(w)
  //  What email-campaign-dispatch now passes for a lead recipient.
  const campaign = await leadSendEligibility('lead_q', 'quote-followup-final', { context: 'campaign' }, w.stage)
  assert.deepEqual(campaign, { reason: null, marketingBasis: 'notice', basisEventId: basis })
  //  Before the fix the re-check had no context: the automation default.
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-final', {}, w.stage)).reason, 'no_marketing_consent')
})

// ════════════════════════════════════════════════════════════════════════
//  5. STOP ON BOOKING — PERSON-LEVEL
// ════════════════════════════════════════════════════════════════════════

test('booking: onBookingCreated stops every lead sequence for the ADDRESS, including a different open lead', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  // A legacy-scheduled Sequence A on another lead, WITHOUT an enrollment row …
  w.addLead('lead_quoted', { quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  for (const s of QUOTE_STAGES) await w.deps.enqueue(s.type, { leadId: 'lead_quoted' }, NOW, jobIdFor('quote', s.type, 'lead_quoted'))
  // … and a legacy Sequence B on a third.
  w.addLead('lead_nurtured', { emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  for (const s of LEAD_NURTURE_STAGES) await w.deps.enqueue(s.type, { leadId: 'lead_nurtured' }, NOW, jobIdFor('lead-nurture', s.type, 'lead_nurtured'))
  assert.equal(w.jobs.size, 9)

  await onBookingCreated({ bookingId: 'bk_new', email: EMAIL }, w.deps)

  assert.ok(hasNone(w, ids('quote_followup', 'lead_q')), 'the notice Sequence A is cancelled')
  assert.ok(hasNone(w, ids('quote_followup', 'lead_quoted')), 'the OTHER lead’s quote sequence is cancelled too')
  assert.ok(hasNone(w, nurtureIds('lead_nurtured')), 'and a legacy nurture on a third open lead')
  assert.equal(w.jobs.size, 0)
  const row = w.enrollmentsFor('quote_followup')[0]
  assert.equal(row.status, 'stopped')
  assert.equal(row.stopReason, 'person_booked')
})

test('booking: the stop is enforced at SEND time even when job removal failed', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  // The person books; nothing cancelled anything (Redis down, say).
  w.addBooking('bk_1', { createdAt: new Date(NOW.getTime() + HOUR) })
  w.setNow(new Date(NOW.getTime() + 24 * HOUR))
  const r = await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage)
  assert.deepEqual(r, { reason: 'person_booked_since', marketingBasis: null, basisEventId: null })
})

test('booking: an internal TEST booking does not stop anyone’s sequence', async () => {
  const w = world()
  const basis = await enrolledQuoteLead(w)
  w.addBooking('bk_t', { createdAt: new Date(NOW.getTime() + HOUR), isInternalTest: true })
  w.setNow(new Date(NOW.getTime() + 24 * HOUR))
  const r = await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage)
  assert.deepEqual(r, { reason: null, marketingBasis: 'notice', basisEventId: basis })
})

test('booking: the person’s own abandoned-checkout enrollment survives onPersonBooked', async () => {
  const w = world()
  w.db.tables.enrollments.push({ id: 'enr_ab', emailNormalized: EMAIL, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: 'bk_1', status: 'active', windowStart: NOW, createdAt: NOW })
  await onPersonBooked(EMAIL, w.deps)
  assert.equal(w.enrollmentsFor('abandoned_checkout')[0].status, 'active')
})

test('booking: a new booking ends lead nurture too — BOOKING_STOPS_KINDS is every kind but abandoned checkout', () => {
  assert.deepEqual([...BOOKING_STOPS_KINDS], ['quote_followup', 'lead_nurture'])
  assert.ok(!BOOKING_STOPS_KINDS.includes('abandoned_checkout'), 'the booking’s own recovery sequence is not ended by the booking')
})

test('booking: onBookingCreated cancels every lead-nurture job for the ADDRESS and stops the lead_nurture enrollment', async () => {
  const w = world()
  await enrolledNurtureLead(w, 'popup', 'lead_n')
  // A legacy-scheduled Sequence B on another open lead, WITHOUT an enrollment row.
  w.addLead('lead_old', OPTED_IN)
  for (const s of LEAD_NURTURE_STAGES) await w.deps.enqueue(s.type, { leadId: 'lead_old' }, NOW, jobIdFor('lead-nurture', s.type, 'lead_old'))
  assert.equal(w.jobs.size, 6)

  await onBookingCreated({ bookingId: 'bk_new', email: EMAIL }, w.deps)

  assert.ok(hasNone(w, nurtureIds('lead_n')), 'the notice nurture is cancelled')
  assert.ok(hasNone(w, nurtureIds('lead_old')), 'and the other open lead’s legacy nurture')
  for (const id of [...nurtureIds('lead_n'), ...nurtureIds('lead_old')]) assert.ok(w.cancelled.includes(id), `cancel(${id})`)
  assert.equal(w.jobs.size, 0)
  const row = w.enrollmentsFor('lead_nurture')[0]
  assert.equal(row.status, 'stopped')
  assert.equal(row.stopReason, 'person_booked')
})

test('booking: onPersonBooked ends BOTH lead-scoped sequences for the person and leaves their abandoned checkout running', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  await enrolledNurtureLead(w, 'contact', 'lead_n')
  w.db.tables.enrollments.push({ id: 'enr_ab', emailNormalized: EMAIL, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: 'bk_1', status: 'active', windowStart: NOW, createdAt: NOW })
  for (const s of ABANDONED_STAGES) await w.deps.enqueue(s.type, { bookingId: 'bk_1' }, NOW, jobIdFor('abandoned', s.type, 'bk_1'))

  const report = await onPersonBooked(EMAIL.toUpperCase(), w.deps)

  assert.equal(report.stopped, 2)
  assert.equal(report.errors, 0)
  assert.equal(w.enrollmentsFor('quote_followup')[0].status, 'stopped')
  assert.equal(w.enrollmentsFor('lead_nurture')[0].status, 'stopped')
  assert.equal(w.enrollmentsFor('lead_nurture')[0].stopReason, 'person_booked')
  assert.equal(w.enrollmentsFor('abandoned_checkout')[0].status, 'active')
  assert.ok(hasNone(w, ids('quote_followup', 'lead_q')))
  assert.ok(hasNone(w, nurtureIds('lead_n')))
  assert.ok(hasAll(w, ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, 'bk_1'))), 'recovery jobs untouched')
})

// ════════════════════════════════════════════════════════════════════════
//  6. OPT-OUT / UNSUBSCRIBE CANCELS
// ════════════════════════════════════════════════════════════════════════

test('opt-out: the withdrawal event stops the enrollment, onPersonOptedOut removes the jobs, and the send gate refuses', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  w.setNow(new Date(NOW.getTime() + HOUR))
  const withdrawal = await recordConsentEvent({ email: EMAIL, kind: 'unsubscribed', surface: 'unsubscribe', requestId: 'req_unsub_1' }, w.db as unknown as ConsentEventsDb)
  assert.ok(withdrawal.ok)
  const stopped = withdrawal.ok ? withdrawal.stoppedEnrollments : []
  assert.equal(stopped.length, 1, 'recordConsentEvent stopped the enrollment in its transaction')
  const report = await onPersonOptedOut(EMAIL, { stopped, reason: 'unsubscribed' }, w.deps)
  assert.equal(report.stopped, 1)
  assert.ok(hasNone(w, ids('quote_followup', 'lead_q')), 'queued stages removed')

  w.setNow(new Date(NOW.getTime() + 24 * HOUR))
  const r = await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage)
  assert.equal(r.reason, 'opted_out')
})

test('opt-out: a legacy abandoned-checkout sequence for the person is cancelled too', async () => {
  const w = world()
  w.db.tables.enrollments.push({ id: 'enr_ab', emailNormalized: EMAIL, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: 'bk_1', status: 'active', windowStart: NOW, createdAt: NOW })
  for (const s of ABANDONED_STAGES) await w.deps.enqueue(s.type, { bookingId: 'bk_1' }, NOW, jobIdFor('abandoned', s.type, 'bk_1'))
  await onPersonOptedOut(EMAIL, {}, w.deps)
  assert.ok(hasNone(w, ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, 'bk_1'))))
  assert.equal(w.enrollmentsFor('abandoned_checkout')[0].status, 'stopped')
})

test('opt-out: an unsubscribe stops a running lead nurture — the enrollment, the jobs, every later stage at send time — and a later form never restarts it', async () => {
  const w = world()
  await enrolledNurtureLead(w, 'tracker')
  w.setNow(new Date(NOW.getTime() + HOUR))
  const withdrawal = await recordConsentEvent(
    { email: EMAIL, kind: 'unsubscribed', surface: 'unsubscribe', requestId: 'req_unsub_n', occurredAt: new Date(NOW.getTime() + HOUR) },
    w.db as unknown as ConsentEventsDb
  )
  assert.ok(withdrawal.ok)
  const stopped = withdrawal.ok ? withdrawal.stoppedEnrollments : []
  assert.deepEqual(stopped.map((s) => [s.sequenceKind, s.subjectId]), [['lead_nurture', 'lead_n']], 'recordConsentEvent stopped the nurture in its transaction')
  const report = await onPersonOptedOut(EMAIL, { stopped, reason: 'unsubscribed' }, w.deps)
  assert.equal(report.stopped, 1)
  assert.ok(hasNone(w, nurtureIds('lead_n')), 'queued stages removed')
  assert.equal(w.enrollmentsFor('lead_nurture')[0].status, 'stopped')

  w.setNow(new Date(NOW.getTime() + 24 * HOUR))
  for (const s of LEAD_NURTURE_STAGES) {
    assert.equal((await leadSendEligibility('lead_n', s.type, NURTURE_SEND, w.stage)).reason, 'opted_out', s.type)
  }

  //  A later genuine submission is recorded, but never re-subscribes the person.
  w.addLead('lead_again')
  const again = await w.notice('popup', { leadId: 'lead_again' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'popup', scenario: 'lead_nurture', leadId: 'lead_again', basisEventId: again, email: EMAIL }, w.deps),
    { scheduled: false, reason: 'opted_out' }
  )
  assert.ok(hasNone(w, nurtureIds('lead_again')))
  assert.equal(w.enrollmentsFor('lead_nurture').length, 1)
})

test('opt-out: onPersonOptedOut on its own (no refs from a transaction) stops the lead_nurture enrollment and removes its jobs', async () => {
  const w = world()
  await enrolledNurtureLead(w, 'contact_support')
  const report = await onPersonOptedOut(EMAIL, {}, w.deps)
  assert.equal(report.stopped, 1)
  assert.equal(report.errors, 0)
  const row = w.enrollmentsFor('lead_nurture')[0]
  assert.equal(row.status, 'stopped')
  assert.equal(row.stopReason, 'opted_out')
  assert.ok(hasNone(w, nurtureIds('lead_n')))
  assert.equal(w.jobs.size, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  7. SEND-TIME ENFORCEMENT (Sequence A and lead nurture on a notice)
// ════════════════════════════════════════════════════════════════════════

test('send: a valid Sequence A stage passes under the NOTICE basis, naming the stored event and its enrollment', async () => {
  const w = world()
  const basis = await enrolledQuoteLead(w)
  w.setNow(new Date(NOW.getTime() + 24 * HOUR))
  assert.deepEqual(await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis })
  // Legacy quote jobs carry no kind; the template names it.
  assert.deepEqual(
    await leadSendEligibility('lead_q', 'quote-followup-2', { context: 'scenario_flow', recipient: EMAIL }, w.stage),
    { reason: null, marketingBasis: 'notice', basisEventId: basis }
  )
  const lead = await w.stage.loadStageLead('lead_q')
  const d = await scenarioSendDecision({ leadId: 'lead_q', lead, template: 'quote-followup-1', kind: 'quote_followup', context: 'scenario_flow', recipient: EMAIL }, w.stage)
  assert.equal(d.reason, null)
  assert.deepEqual(d.decision, { eligible: true, basis: 'notice', basisEventId: basis })
  assert.equal(d.enrollment?.subjectId, 'lead_q')
})

test('send: a Spanish quote notice is an equally valid basis', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_q' }, { locale: 'es' })
  assert.equal((await onNoticeSubmission({ surface: 'quote', scenario: 'quote_followup', leadId: 'lead_q', basisEventId: basis, email: EMAIL }, w.deps)).scheduled, true)
  assert.deepEqual(await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis })
})

test('send: a suppression added after enrollment blocks the stage', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  w.db.tables.suppressions.push({ email: EMAIL, reason: 'HARD_BOUNCE', scope: 'all' })
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage)).reason, 'suppressed')
})

test('send: the notice expires after 183 days', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  w.setNow(new Date(NOW.getTime() + 182 * DAY))
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-final', QUOTE_SEND, w.stage)).reason, null)
  w.setNow(new Date(NOW.getTime() + 184 * DAY))
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-final', QUOTE_SEND, w.stage)).reason, 'notice_expired')
})

test('send: a lead whose address changed after the notice is refused (basis email match)', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  w.db.tables.leads[0].email = 'typo-fixed@example.com'
  // The stored notice was given for the OLD address.
  const noRecipient = await leadSendEligibility('lead_q', 'quote-followup-1', { context: 'scenario_flow', sequenceKind: 'quote_followup' }, w.stage)
  assert.equal(noRecipient.reason, 'basis_email_mismatch')
  // And the email worker's own recheck refuses a job whose recipient is not the lead's address.
  const r = await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage)
  assert.equal(r.reason, 'basis_email_mismatch')
})

test('send: the promotions kill switch refuses queued stages of notice AND legacy lead sequences', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  w.addLead('lead_x', { email: 'pat@example.com', quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  await withEnv({ EMAIL_PROMOTIONS_ENABLED: undefined }, async () => {
    assert.equal((await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, w.stage)).reason, 'promotions_disabled')
    for (const template of ['quote-followup-1', 'lead-nurture-2']) {
      const r = await leadSendEligibility('lead_x', template, { context: 'scenario_flow' }, w.stage)
      assert.equal(r.reason, 'promotions_disabled', template)
    }
    // A transactional reply is never held by the promotional switch.
    assert.equal((await leadSendEligibility('lead_x', 'quote-request-received', {}, w.stage)).reason, null)
  })
})

test('send: a stopped enrollment refuses the remaining stages', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  w.db.tables.enrollments[0].status = 'stopped'
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-2', QUOTE_SEND, w.stage)).reason, 'enrollment_not_active')
})

test('send: a notice never permits an automation recheck — the default context is express-only', async () => {
  const w = world()
  const basis = await enrolledQuoteLead(w)
  const r = await leadSendEligibility('lead_q', 'quote-followup-final', {}, w.stage)
  assert.equal(r.reason, 'no_marketing_consent')
  const ok = await leadSendEligibility('lead_q', 'quote-followup-final', QUOTE_SEND, w.stage)
  assert.deepEqual(ok, { reason: null, marketingBasis: 'notice', basisEventId: basis })
})

test('send: a lead-nurture stage on a notice needs the lead’s OWN active enrollment — a notice alone, a kind-less decision, the automation default or a forged kind never sends it', async () => {
  //  src/emails/lead-nurture.tsx's footer no longer claims an opt-in ("you gave
  //  us your email about a move"), so a form notice is a truthful basis for it —
  //  but only for the lead_nurture kind (the template names it:
  //  sequenceKindForTemplate), only in a scenario flow, and only through the
  //  enrollment the person's own submission created. A notice-only lead that
  //  nothing enrolled (the express-only legacy hook, a staff edit) is refused.
  for (const surface of NOTICE_SURFACES) {
    const w = world()
    w.addLead('lead_n')
    const basis = await w.notice(surface, { leadId: 'lead_n' })
    const lead = await w.stage.loadStageLead('lead_n')
    for (const t of LEAD_NURTURE_STAGES) {
      assert.deepEqual(
        await leadSendEligibility('lead_n', t.type, NURTURE_SEND, w.stage),
        { reason: 'enrollment_not_active', marketingBasis: null, basisEventId: null },
        `${t.type} on a ${surface} notice with no enrollment`
      )
      //  A decision that names no kind can only be an express permission.
      const d = await scenarioSendDecision({ leadId: 'lead_n', lead, template: t.type, kind: null, context: 'scenario_flow', recipient: EMAIL }, w.stage)
      assert.equal(d.reason, 'no_marketing_consent', `${t.type} kind-less on a ${surface} notice`)
      assert.deepEqual(d.decision, { eligible: false, reason: 'no_marketing_basis', terminal: true, detail: 'sequence_not_in_scenario' })
      //  The automation default context is express-only.
      assert.equal((await leadSendEligibility('lead_n', t.type, {}, w.stage)).reason, 'no_marketing_consent')
    }

    //  The person's own submission enrolls it: now every stage passes on the notice.
    assert.deepEqual(await onNoticeSubmission({ surface, scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, w.deps), { scheduled: true, stages: 3 })
    for (const t of LEAD_NURTURE_STAGES) {
      assert.deepEqual(
        await leadSendEligibility('lead_n', t.type, NURTURE_SEND, w.stage),
        { reason: null, marketingBasis: 'notice', basisEventId: basis },
        `${t.type} on an enrolled ${surface} notice`
      )
      //  Still never through the automation default.
      assert.equal((await leadSendEligibility('lead_n', t.type, {}, w.stage)).reason, 'no_marketing_consent')
    }
  }

  //  A FORGED kind on the job does not widen a contact notice.
  const w = world()
  await enrolledNurtureLead(w, 'contact', 'lead_c')
  const forged = await leadSendEligibility('lead_c', 'lead-nurture-1', { context: 'scenario_flow', sequenceKind: 'quote_followup', recipient: EMAIL }, w.stage)
  assert.equal(forged.reason, 'no_marketing_consent')

  //  An EXPRESS opt-in keeps receiving Sequence B exactly as before.
  const e = world()
  e.addLead('lead_e', OPTED_IN)
  assert.deepEqual(
    await leadSendEligibility('lead_e', 'lead-nurture-1', { context: 'scenario_flow', recipient: EMAIL }, e.stage),
    { reason: null, marketingBasis: 'express', basisEventId: null }
  )
})

test('send: a valid lead-nurture stage passes under the NOTICE basis, naming the stored event and its enrollment, with no delivery gate', async () => {
  const w = world()
  const basis = await enrolledNurtureLead(w, 'popup')
  w.setNow(new Date(NOW.getTime() + 4 * HOUR))
  for (const s of LEAD_NURTURE_STAGES) {
    assert.deepEqual(await leadSendEligibility('lead_n', s.type, NURTURE_SEND, w.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis }, s.type)
  }
  //  The scheduled worker names the kind explicitly.
  assert.deepEqual(
    await leadSendEligibility('lead_n', 'lead-nurture-2', { ...NURTURE_SEND, sequenceKind: 'lead_nurture' }, w.stage),
    { reason: null, marketingBasis: 'notice', basisEventId: basis }
  )
  const lead = await w.stage.loadStageLead('lead_n')
  const d = await scenarioSendDecision({ leadId: 'lead_n', lead, template: 'lead-nurture-1', kind: 'lead_nurture', context: 'scenario_flow', recipient: EMAIL }, w.stage)
  assert.equal(d.reason, null)
  assert.deepEqual(d.decision, { eligible: true, basis: 'notice', basisEventId: basis })
  assert.equal(d.enrollment?.subjectId, 'lead_n')
  assert.equal(d.enrollment?.sequenceKind, 'lead_nurture')

  //  Lead nurture never waits for a quick-quote confirmation: the state is never read.
  const unread: Pick<StageDeps, 'now' | 'quoteConfirmationState' | 'stopEnrollment'> = {
    now: () => NOW,
    quoteConfirmationState: async () => {
      throw new Error('must not be read')
    },
    stopEnrollment: async () => {
      throw new Error('must not be called')
    },
  }
  assert.equal(
    await applyConfirmationGate({ kind: 'lead_nurture', decision: d.decision, enrollment: d.enrollment, stageType: 'lead-nurture-1', leadId: 'lead_n', jobData: { leadId: 'lead_n' } }, unread),
    null
  )
})

test('send: a Spanish notice is an equally valid nurture basis, and its stages render in Spanish', async () => {
  const w = world()
  const basis = await enrolledNurtureLead(w, 'contact', 'lead_n', { locale: 'es' })
  assert.deepEqual(await leadSendEligibility('lead_n', 'lead-nurture-1', NURTURE_SEND, w.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis })
  //  What the scheduled worker does with the basis event's locale.
  const event = w.db.tables.events.find((e: Record<string, unknown>) => e.id === basis)!
  assert.equal(event.locale, 'es')
  assert.equal(stageLocaleFromBasis(event.locale as string), 'es')
})

test('send: a stopped lead-nurture enrollment refuses the remaining stages (enrollment_not_active)', async () => {
  const w = world()
  await enrolledNurtureLead(w)
  w.enrollmentsFor('lead_nurture')[0].status = 'stopped'
  for (const s of LEAD_NURTURE_STAGES) {
    assert.deepEqual(
      await leadSendEligibility('lead_n', s.type, NURTURE_SEND, w.stage),
      { reason: 'enrollment_not_active', marketingBasis: null, basisEventId: null },
      s.type
    )
  }
})

test('send: a booking after enrollment stops the nurture at SEND time even when job removal failed (person_booked_since); a test booking does not', async () => {
  const booked = world()
  await enrolledNurtureLead(booked)
  // The person books; nothing cancelled anything (Redis down, say).
  booked.addBooking('bk_1', { createdAt: new Date(NOW.getTime() + HOUR) })
  booked.setNow(new Date(NOW.getTime() + 24 * HOUR))
  for (const s of LEAD_NURTURE_STAGES) {
    assert.deepEqual(
      await leadSendEligibility('lead_n', s.type, NURTURE_SEND, booked.stage),
      { reason: 'person_booked_since', marketingBasis: null, basisEventId: null },
      s.type
    )
  }

  const internal = world()
  const basis = await enrolledNurtureLead(internal)
  internal.addBooking('bk_t', { createdAt: new Date(NOW.getTime() + HOUR), isInternalTest: true })
  internal.setNow(new Date(NOW.getTime() + 24 * HOUR))
  assert.deepEqual(await leadSendEligibility('lead_n', 'lead-nurture-2', NURTURE_SEND, internal.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis })
})

test('send: another lead’s ACTIVE nurture refuses this lead’s stage (already_enrolled), whatever this lead’s basis', async () => {
  const w = world()
  await enrolledNurtureLead(w, 'contact', 'lead_1')
  //  A second lead for the same person with its own stored popup notice.
  w.addLead('lead_2')
  await w.notice('popup', { leadId: 'lead_2' })
  assert.deepEqual(
    await leadSendEligibility('lead_2', 'lead-nurture-1', NURTURE_SEND, w.stage),
    { reason: 'already_enrolled', marketingBasis: null, basisEventId: null }
  )
  //  … or an express opt-in on the second lead.
  w.addLead('lead_3', OPTED_IN)
  assert.equal((await leadSendEligibility('lead_3', 'lead-nurture-final', NURTURE_SEND, w.stage)).reason, 'already_enrolled')
  //  The enrolled lead itself still sends.
  assert.equal((await leadSendEligibility('lead_1', 'lead-nurture-1', NURTURE_SEND, w.stage)).reason, null)
})

test('send: an express / legacy nurture lead with NO enrollment row still sends on its opt-in; a booking since its capture still stops it', async () => {
  //  Sequence B jobs queued before enrollment rows existed carry no row.
  const w = world()
  w.addLead('lead_e', OPTED_IN)
  for (const s of LEAD_NURTURE_STAGES) {
    assert.deepEqual(
      await leadSendEligibility('lead_e', s.type, NURTURE_SEND, w.stage),
      { reason: null, marketingBasis: 'express', basisEventId: null },
      s.type
    )
  }
  assert.equal(w.enrollmentsFor().length, 0)
  w.addBooking('bk_1', { createdAt: NOW })
  assert.equal((await leadSendEligibility('lead_e', 'lead-nurture-2', NURTURE_SEND, w.stage)).reason, 'person_booked_since')
})

test('send: the nurture gate keeps the state matrix and every prohibition at send time', async () => {
  const cases: Array<{ name: string; reason: string; change: (w: World) => Promise<void> | void; stage?: (w: World) => StageDeps }> = [
    { name: 'suppression after enrollment', reason: 'suppressed', change: (w) => void w.db.tables.suppressions.push({ email: EMAIL, reason: 'COMPLAINT', scope: 'all' }) },
    {
      name: 'opt-out box on a later form',
      reason: 'opted_out',
      async change(w) {
        const r = await recordConsentEvent(
          { email: EMAIL, kind: 'opted_out_at_capture', surface: 'booking', requestId: 'req_box_later', occurredAt: new Date(NOW.getTime() + HOUR) },
          w.db as unknown as ConsentEventsDb
        )
        assert.ok(r.ok)
      },
    },
    { name: 'quoted since', reason: 'has_quote', change: (w) => void (w.db.tables.leads[0].quotedAt = new Date(NOW.getTime() + HOUR)) },
    { name: 'previous customer', reason: 'previous_customer', change() {}, stage: (w) => ({ ...w.stage, hasEverBooked: async () => true }) },
    { name: 'lead lost', reason: 'lead_lost', change: (w) => void (w.db.tables.leads[0].lostAt = new Date(NOW.getTime() + HOUR)) },
    { name: 'converted', reason: 'lead_converted', change: (w) => void (w.db.tables.leads[0].convertedBookingId = 'bk_9') },
    { name: 'address changed', reason: 'basis_email_mismatch', change: (w) => void (w.db.tables.leads[0].email = 'typo-fixed@example.com') },
    { name: 'notice expired', reason: 'notice_expired', change: (w) => w.setNow(new Date(NOW.getTime() + 184 * DAY)) },
  ]
  for (const c of cases) {
    const w = world()
    await enrolledNurtureLead(w, 'tracker')
    await c.change(w)
    const stage = c.stage ? c.stage(w) : w.stage
    assert.equal((await leadSendEligibility('lead_n', 'lead-nurture-2', NURTURE_SEND, stage)).reason, c.reason, c.name)
  }

  //  The promotions kill switch refuses queued nurture stages too.
  const w = world()
  await enrolledNurtureLead(w)
  await withEnv({ EMAIL_PROMOTIONS_ENABLED: undefined }, async () => {
    assert.equal((await leadSendEligibility('lead_n', 'lead-nurture-1', NURTURE_SEND, w.stage)).reason, 'promotions_disabled')
  })
})

test('send: a database outage THROWS from the decision so BullMQ retries; the worker recheck fails CLOSED and retryable', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  const lead = await w.stage.loadStageLead('lead_q')
  const input = { leadId: 'lead_q', lead, template: 'quote-followup-1', kind: 'quote_followup' as const, context: 'scenario_flow' as const, recipient: EMAIL }

  const broken: StageDeps = { ...w.stage, activeEnrollment: async () => { throw new Error('db down') } }
  await assert.rejects(() => scenarioSendDecision(input, broken))
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, broken)).reason, 'eligibility_read_failed')

  const noLead: StageDeps = { ...w.stage, loadStageLead: async () => { throw new Error('db down') } }
  assert.deepEqual(await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, noLead), { reason: 'eligibility_read_failed', marketingBasis: null, basisEventId: null })

  // The eligibility gate never throws: its read failure is a RETRYABLE refusal.
  const flaky: StageDeps = { ...w.stage, eligibility: async () => ({ eligible: false, reason: 'eligibility_read_failed', terminal: false }) }
  const d = await scenarioSendDecision(input, flaky)
  assert.equal(d.reason, 'eligibility_read_failed')
  assert.deepEqual(d.decision, { eligible: false, reason: 'eligibility_read_failed', terminal: false })
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, flaky)).reason, 'eligibility_read_failed')
})

// ════════════════════════════════════════════════════════════════════════
//  8. SEQUENCE A ON A NOTICE WAITS FOR A DELIVERED QUICK-QUOTE CONFIRMATION
// ════════════════════════════════════════════════════════════════════════

async function gateInput(w: World, jobData: Record<string, unknown> = { leadId: 'lead_q', type: 'quote-followup-1' }) {
  const lead = await w.stage.loadStageLead('lead_q')
  const d = await scenarioSendDecision({ leadId: 'lead_q', lead, template: 'quote-followup-1', kind: 'quote_followup', context: 'scenario_flow', recipient: EMAIL }, w.stage)
  assert.equal(d.reason, null, 'precondition: the send gate passes')
  return { kind: 'quote_followup' as const, decision: d.decision, enrollment: d.enrollment, stageType: 'quote-followup-1', leadId: 'lead_q', jobData }
}

test('quote path: not yet delivered → the stage waits in bounded, deterministic, colon-free steps, then stops the sequence', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  const first = await applyConfirmationGate(await gateInput(w), w.stage)
  assert.ok(first && first.action === 'defer')
  assert.equal(first.jobId, `${jobIdFor('quote', 'quote-followup-1', 'lead_q')}__wait1`)
  assert.ok(!first.jobId.includes(':'))
  assert.equal(first.fireAt.getTime(), NOW.getTime() + CONFIRMATION_WAIT_STEP_MS)
  assert.equal(first.data.confirmationWaitAttempt, 1)
  assert.equal(first.data.type, undefined, 'the queue edge adds the type back')
  assert.deepEqual(await applyConfirmationGate(await gateInput(w), w.stage), first, 'a stalled re-run plans the same hop')

  w.setNow(first.fireAt)
  const second = await applyConfirmationGate(await gateInput(w, { ...first.data, type: 'quote-followup-1' }), w.stage)
  assert.ok(second && second.action === 'defer')
  assert.ok(second.jobId.endsWith('__wait2'))

  w.setNow(new Date(NOW.getTime() + CONFIRMATION_WAIT_MAX_MS))
  const stop = await applyConfirmationGate(await gateInput(w, { ...first.data, type: 'quote-followup-1' }), w.stage)
  assert.deepEqual(stop, { action: 'stop', reason: 'quote_confirmation_not_delivered' })
  assert.equal(w.enrollmentsFor()[0].status, 'stopped', 'the whole sequence stops, not just this stage')
  assert.equal(w.stoppedByGate.length, 1)
  assert.equal((await leadSendEligibility('lead_q', 'quote-followup-2', QUOTE_SEND, w.stage)).reason, 'enrollment_not_active', 'the later stages refuse')
})

test('quote path: a bounce or complaint on the confirmation stops the sequence; delivered proceeds', async () => {
  const bounced = world()
  await enrolledQuoteLead(bounced)
  bounced.confirmation.set('lead_q', 'failed')
  assert.deepEqual(await applyConfirmationGate(await gateInput(bounced), bounced.stage), { action: 'stop', reason: 'quote_confirmation_failed' })
  assert.equal(bounced.enrollmentsFor()[0].status, 'stopped')

  const delivered = world()
  await enrolledQuoteLead(delivered)
  delivered.confirmation.set('lead_q', 'delivered')
  assert.equal(await applyConfirmationGate(await gateInput(delivered), delivered.stage), null)
  assert.equal(delivered.enrollmentsFor()[0].status, 'active')
})

test('quote path: only Sequence A on a NOTICE waits; legacy opt-ins, abandoned checkout and lead nurture are unchanged', async () => {
  const notice = { eligible: true as const, basis: 'notice' as const, basisEventId: 'evt_1' }
  const express = { eligible: true as const, basis: 'express' as const, basisEventId: null }
  assert.equal(needsConfirmationGate('quote_followup', notice), true)
  assert.equal(needsConfirmationGate('quote_followup', express), false)
  assert.equal(needsConfirmationGate('abandoned_checkout', notice), false)
  assert.equal(needsConfirmationGate('lead_nurture', notice), false, 'lead nurture has no delivery gate')
  assert.equal(needsConfirmationGate('lead_nurture', express), false)
  assert.equal(needsConfirmationGate(null, notice), false)
  assert.equal(needsConfirmationGate('quote_followup', null), false)
  assert.equal(needsConfirmationGate('quote_followup', { eligible: false, reason: 'no_marketing_basis', terminal: true }), false)

  // Not gated → the delivery state is never even read.
  const unread: Pick<StageDeps, 'now' | 'quoteConfirmationState' | 'stopEnrollment'> = {
    now: () => NOW,
    quoteConfirmationState: async () => {
      throw new Error('must not be read')
    },
    stopEnrollment: async () => {
      throw new Error('must not be called')
    },
  }
  const base = { enrollment: null, stageType: 'quote-followup-1', leadId: 'l1', jobData: { leadId: 'l1' } }
  assert.equal(await applyConfirmationGate({ ...base, kind: 'quote_followup', decision: express }, unread), null)
  assert.equal(await applyConfirmationGate({ ...base, kind: 'abandoned_checkout', decision: notice }, unread), null)
  assert.equal(await applyConfirmationGate({ ...base, stageType: 'lead-nurture-1', kind: 'lead_nurture', decision: notice }, unread), null)

  // Pure and bounded.
  const pure = { now: NOW, stageType: 'quote-followup-1', journeyKey: 'quote', leadId: 'l1', jobData: { leadId: 'l1', type: 'quote-followup-1' } }
  assert.deepEqual(confirmationGateDecision({ ...pure, state: 'delivered' }), { action: 'proceed' })
  const d = confirmationGateDecision({ ...pure, state: 'pending' })
  assert.equal(d.action, 'defer')
  assert.equal((d as { jobId: string }).jobId, 'journey__quote__quote-followup-1__l1__wait1')
  const late = confirmationGateDecision({
    ...pure,
    state: 'pending',
    jobData: { leadId: 'l1', confirmationWaitStartedAt: new Date(NOW.getTime() - CONFIRMATION_WAIT_MAX_MS).toISOString(), confirmationWaitAttempt: 24 },
  })
  assert.deepEqual(late, { action: 'stop', reason: 'quote_confirmation_not_delivered' })
})

// ════════════════════════════════════════════════════════════════════════
//  9. EXISTING (LEGACY) FLOWS UNCHANGED
// ════════════════════════════════════════════════════════════════════════

test('existing: a legacy opted-in quote lead gets the same Sequence A jobs, at the same times', async () => {
  const quotedAt = new Date(NOW.getTime() - HOUR)
  const legacy = world()
  legacy.addLead('lead_x', { quotedAt, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  // An OLDER injected world: no consent deps at all.
  const bare: JourneyDeps = { ...legacy.deps, eligibility: undefined, enrollSequence: undefined, stopPersonEnrollments: undefined, openLeadIdsForEmail: undefined, loadBookingBasis: undefined }
  const current = world()
  current.addLead('lead_x', { quotedAt, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })

  assert.deepEqual(await ensureQuoteJourney('lead_x', bare), { scheduled: true, stages: 3 })
  assert.deepEqual(await ensureQuoteJourney('lead_x', current.deps), { scheduled: true, stages: 3 })
  const shape = (w: World) => [...w.jobs.entries()].map(([id, j]) => [id, j.stage, j.fireAt.toISOString(), JSON.stringify(j.data)]).sort()
  assert.deepEqual(shape(current), shape(legacy), 'identical ids, stages, fire times and data')
  assert.deepEqual(
    [...current.jobs.keys()].sort(),
    QUOTE_STAGES.map((s) => jobIdFor('quote', s.type, 'lead_x')).sort()
  )
})

test('existing: legacy Sequence B for an opted-in lead is scheduled exactly as before (the legacy hook, no options)', async () => {
  const w = world()
  w.addLead('lead_b', { emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  const summary = await onLeadCaptured('lead_b', w.deps)
  assert.equal(summary?.scheduled, 3)
  assert.deepEqual([...w.jobs.keys()].sort(), nurtureIds('lead_b').sort())
  assert.deepEqual(
    LEAD_NURTURE_STAGES.map((s) => w.jobs.get(jobIdFor('lead-nurture', s.type, 'lead_b'))!.fireAt.getTime() - NOW.getTime()),
    [4 * HOUR, 24 * HOUR, 72 * HOUR]
  )
  //  It now claims the person's lead_nurture slot, on the express basis (no event).
  const rows = w.enrollmentsFor('lead_nurture')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].subjectId, 'lead_b')
  assert.equal(rows[0].basisEventId, null)
  //  Explicit empty options are the same express-only legacy call.
  const w2 = world()
  w2.addLead('lead_b', { emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  assert.equal((await onLeadCaptured('lead_b', w2.deps, {}))?.scheduled, 3)
})

test('existing: an OPTED-IN lead keeps legacy Sequence B when a newer form notice merges into it — on its express basis, never the notice', async () => {
  const w = world()
  w.addLead('lead_c', { emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  await w.notice('contact', { leadId: 'lead_c' })
  const summary = await onLeadCaptured('lead_c', w.deps)
  assert.equal(summary?.scheduled, 3, 'production behaviour for a historical opt-in is preserved')
  assert.deepEqual([...w.jobs.keys()].sort(), nurtureIds('lead_c').sort())
  for (const s of LEAD_NURTURE_STAGES) {
    const r = await leadSendEligibility('lead_c', s.type, { context: 'scenario_flow', recipient: EMAIL }, w.stage)
    assert.equal(r.reason, null, s.type)
    assert.equal(r.marketingBasis, 'express', `${s.type} goes out on the opt-in: express wins over the notice`)
    assert.equal(r.basisEventId, null)
  }
})

test('existing: the legacy capture hook onLeadCaptured(leadId) stays EXPRESS-ONLY — it never schedules a notice-only lead, on any surface; only that lead’s own submission does', async () => {
  for (const surface of NOTICE_SURFACES) {
    const w = world()
    w.addLead('lead_n')
    const basis = await w.notice(surface, { leadId: 'lead_n' })
    assert.equal(await onLeadCaptured('lead_n', w.deps), null, `${surface} notice → the legacy hook schedules nothing`)
    // A sibling lead for the same address with NO stored basis is refused as
    // well: another submission's notice is never a basis for Sequence B.
    w.addLead('lead_sibling')
    assert.equal(await onLeadCaptured('lead_sibling', w.deps), null, `${surface} sibling → no Sequence B`)
    assert.equal(w.jobs.size, 0, surface)
    assert.equal(w.enrollmentsFor().length, 0, surface)

    // The submission path (onNoticeSubmission → allowNoticeBasis) enrolls the lead itself …
    assert.deepEqual(
      await onNoticeSubmission({ surface, scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, w.deps),
      { scheduled: true, stages: 3 },
      surface
    )
    // … and never the sibling, which has no notice of its own.
    assert.deepEqual(
      await onNoticeSubmission({ surface, scenario: 'lead_nurture', leadId: 'lead_sibling', basisEventId: basis, email: EMAIL }, w.deps),
      { scheduled: false, reason: 'basis_not_stored' },
      surface
    )
    assert.ok(hasNone(w, nurtureIds('lead_sibling')), surface)
    assert.equal(w.enrollmentsFor().length, 1, surface)
  }
  // And a lead with no consent column and no notice gets no nurture either.
  const w = world()
  w.addLead('lead_m', { email: 'pat@example.com' })
  assert.equal(await onLeadCaptured('lead_m', w.deps), null)
  assert.equal(w.jobs.size, 0)
})

test('existing: a per-person prohibition now refuses a legacy opt-in (an unsubscribe on another row)', async () => {
  const w = world()
  w.addLead('lead_x', { quotedAt: NOW, emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  w.db.tables.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  assert.deepEqual(await ensureQuoteJourney('lead_x', w.deps), { scheduled: false, reason: 'suppressed' })
  assert.equal(w.jobs.size, 0)
})

test('existing: marketingConsentBlock keeps the legacy answer when no decision is supplied', () => {
  assert.equal(marketingConsentBlock(true), null)
  assert.equal(marketingConsentBlock(false), 'no_marketing_consent')
  assert.equal(marketingConsentBlock(false, { eligible: false, reason: 'no_marketing_basis', terminal: true }), 'no_marketing_consent')
  assert.equal(marketingConsentBlock(true, { eligible: false, reason: 'opted_out', terminal: true }), 'opted_out', 'a prohibition beats the column')
  assert.equal(marketingConsentBlock(false, { eligible: true, basis: 'notice', basisEventId: 'e' }), null)
})

// ════════════════════════════════════════════════════════════════════════
//  9. RETRIES: a failed enqueue is recorded and re-added once, never twice
// ════════════════════════════════════════════════════════════════════════

type AddCall = { jobId: string; name: string; data: Record<string, unknown> }

function fakeQueue(mode: 'ok' | 'throw'): QueueLike & { getJob(id: string): Promise<null>; calls: AddCall[]; live: Map<string, AddCall> } {
  const q = {
    name: 'scheduled',
    mode,
    calls: [] as AddCall[],
    live: new Map<string, AddCall>(),
    async add(name: string, data: unknown, opts?: { jobId?: string }) {
      const call = { jobId: String(opts?.jobId), name, data: data as Record<string, unknown> }
      q.calls.push(call)
      if (q.mode === 'throw') throw new Error('Connection is closed.')
      if (!q.live.has(call.jobId)) q.live.set(call.jobId, call)
      return call
    },
    async getJob() {
      return null
    },
  }
  return q
}

test('retries: a Redis failure records each stage for the sweep, which re-adds the same ids exactly once', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_q' })
  const { store, db } = memoryRetryStore()
  const down = fakeQueue('throw')
  const failing: JourneyDeps = { ...w.deps, ...journeyQueueEdge({ queue: down, store, now: () => NOW }) }
  const input = { surface: 'quote' as const, scenario: 'quote_followup' as const, leadId: 'lead_q', basisEventId: basis, email: EMAIL }

  const out = await onNoticeSubmission(input, failing)
  assert.deepEqual(out, { scheduled: false, reason: 'recorded_for_retry', recordedForRetry: 3, lost: 0 })
  assert.equal(db.rows.length, 3)
  for (const row of db.rows) {
    assert.equal(row.path, 'quote-journey')
    assert.equal(row.subjectType, 'lead')
    assert.equal(row.subjectId, 'lead_q')
    assert.equal(row.data.leadId, 'lead_q')
  }

  const up = fakeQueue('ok')
  const sweepDeps = { store, queueFor: (n: string) => (n === 'scheduled' ? up : null), shiftFor: sweepShiftFor }
  const first = await runLifecycleRetrySweep({ now: NOW, deps: sweepDeps })
  const second = await runLifecycleRetrySweep({ now: NOW, deps: sweepDeps })
  assert.equal(first.enqueued, 3)
  assert.equal(second.enqueued, 0, 'a re-added row is never re-added again')
  assert.deepEqual([...up.live.keys()].sort(), ids('quote_followup', 'lead_q').sort())

  // The person re-submits after the outage: the enrollment is theirs, the ids are the same — no duplicate.
  const healthy: JourneyDeps = { ...w.deps, ...journeyQueueEdge({ queue: up, store, now: () => NOW }) }
  await onNoticeSubmission(input, healthy)
  assert.equal(up.live.size, 3)
  assert.equal(w.enrollmentsFor().length, 1)
})

test('retries: a Redis failure on a lead-nurture submission records its three stages on the lead-nurture path; the sweep re-adds the same ids once', async () => {
  const w = world()
  w.addLead('lead_n')
  const basis = await w.notice('popup', { leadId: 'lead_n' })
  const { store, db } = memoryRetryStore()
  const down = fakeQueue('throw')
  const failing: JourneyDeps = { ...w.deps, ...journeyQueueEdge({ queue: down, store, now: () => NOW }) }
  const input = { surface: 'popup' as const, scenario: 'lead_nurture' as const, leadId: 'lead_n', basisEventId: basis, email: EMAIL }

  assert.deepEqual(await onNoticeSubmission(input, failing), { scheduled: false, reason: 'recorded_for_retry', recordedForRetry: 3, lost: 0 })
  assert.equal(db.rows.length, 3)
  for (const row of db.rows) {
    assert.equal(row.path, 'lead-nurture')
    assert.equal(row.subjectType, 'lead')
    assert.equal(row.subjectId, 'lead_n')
    assert.equal(row.data.leadId, 'lead_n')
  }
  assert.equal(w.enrollmentsFor('lead_nurture').length, 1, 'the enrollment is claimed before the enqueue, so a stop rule can find it')

  const up = fakeQueue('ok')
  const sweepDeps = { store, queueFor: (n: string) => (n === 'scheduled' ? up : null), shiftFor: sweepShiftFor }
  assert.equal((await runLifecycleRetrySweep({ now: NOW, deps: sweepDeps })).enqueued, 3)
  assert.equal((await runLifecycleRetrySweep({ now: NOW, deps: sweepDeps })).enqueued, 0)
  assert.deepEqual([...up.live.keys()].sort(), ids('lead_nurture', 'lead_n').sort())

  const healthy: JourneyDeps = { ...w.deps, ...journeyQueueEdge({ queue: up, store, now: () => NOW }) }
  assert.deepEqual(await onNoticeSubmission(input, healthy), { scheduled: true, stages: 3 })
  assert.equal(up.live.size, 3)
  assert.equal(w.enrollmentsFor().length, 1)
})

// ════════════════════════════════════════════════════════════════════════
//  11. JOB IDS AND PURE HELPERS — colon-free, deterministic, cancel = create
// ════════════════════════════════════════════════════════════════════════

test('job ids: every scenario id is BullMQ-safe, deterministic, and distinct per kind and subject', () => {
  const all = new Set<string>()
  for (const kind of SEQUENCE_KINDS) {
    for (const id of stageJobIdsForKind(kind, 'cmabc123')) {
      assert.ok(!id.includes(':'), `BullMQ rejects ":" — ${id}`)
      assert.equal(stageJobIdsForKind(kind, 'cmabc123').includes(id), true)
      assert.ok(!all.has(id), `ids never collide across kinds — ${id}`)
      all.add(id)
    }
    assert.notDeepEqual(stageJobIdsForKind(kind, 'a'), stageJobIdsForKind(kind, 'b'))
  }
  // A cancel built from an enrollment row finds the jobs the existing schedulers created.
  assert.deepEqual(stageJobIdsForKind('quote_followup', 'l1'), QUOTE_STAGES.map((s) => jobIdFor('quote', s.type, 'l1')))
  assert.deepEqual(stageJobIdsForKind('abandoned_checkout', 'b1'), ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, 'b1')))
  assert.deepEqual(stageJobIdsForKind('lead_nurture', 'l1'), LEAD_NURTURE_STAGES.map((s) => jobIdFor('lead-nurture', s.type, 'l1')))
  assert.deepEqual(stageJobIdsForKind('lead_nurture', 'l1'), [
    'journey__lead-nurture__lead-nurture-1__l1',
    'journey__lead-nurture__lead-nurture-2__l1',
    'journey__lead-nurture__lead-nurture-final__l1',
  ])
})

test('job ids: every stage of every scenario kind has a lifecycle retry policy', () => {
  const expectedPath: Record<SequenceKind, string> = {
    quote_followup: 'quote-journey',
    abandoned_checkout: 'abandoned-checkout',
    lead_nurture: 'lead-nurture',
  }
  for (const kind of SEQUENCE_KINDS) {
    for (const s of stagesForKind(kind)) {
      const w = retryWindowFor(s.type, NOW)
      assert.ok(w, `${s.type} has a retry policy (a failed enqueue would otherwise be LOST)`)
      assert.equal(w!.path, expectedPath[kind])
    }
  }
})

test('helpers: journeyKeyFor, stagesForKind and sequenceKindForTemplate know lead nurture', () => {
  const key: Record<SequenceKind, string> = { quote_followup: 'quote', abandoned_checkout: 'abandoned', lead_nurture: 'lead-nurture' }
  for (const kind of SEQUENCE_KINDS) assert.equal(journeyKeyFor(kind), key[kind], kind)
  assert.equal(journeyKeyFor('lead_nurture_contact' as SequenceKind), 'unknown')

  assert.equal(stagesForKind('lead_nurture'), LEAD_NURTURE_STAGES)
  assert.equal(stagesForKind('quote_followup'), QUOTE_STAGES)
  assert.equal(stagesForKind('abandoned_checkout'), ABANDONED_STAGES)
  assert.deepEqual(LEAD_NURTURE_STAGES, [
    { type: 'lead-nurture-1', delay: 4 * HOUR },
    { type: 'lead-nurture-2', delay: 24 * HOUR },
    { type: 'lead-nurture-final', delay: 72 * HOUR },
  ])

  for (const t of ['lead-nurture-1', 'lead-nurture-2', 'lead-nurture-final']) assert.equal(sequenceKindForTemplate(t), 'lead_nurture', t)
  for (const t of ['quote-followup-1', 'quote-followup-2', 'quote-followup-final']) assert.equal(sequenceKindForTemplate(t), 'quote_followup', t)
  //  Anything else names no kind — so the eligibility gate can only answer express for it.
  for (const t of [undefined, '', 'lead-nurture', 'lead-nurture-x', 'xlead-nurture-1', 'quote-request-received', 'abandoned-checkout-recovery', 'offer-welcome']) {
    assert.equal(sequenceKindForTemplate(t), null, String(t))
  }
})

test('helpers: stageLocaleFromBasis renders Spanish only for a Spanish basis; greetingName never greets a placeholder', () => {
  for (const locale of ['es', 'es-MX', 'ES', 'es_US']) assert.equal(stageLocaleFromBasis(locale), 'es', locale)
  for (const locale of [null, undefined, '', 'en', 'en-US', 'fr', 'pt-BR']) assert.equal(stageLocaleFromBasis(locale), 'en', String(locale))

  //  The popup and the tracker landing page ask for no name: their placeholders
  //  must never reach "Hi Website lead".
  for (const name of ['Website lead', 'booking lead', 'BOOKING LEAD', ' Website Lead ', '  ', '', null, undefined]) {
    assert.equal(greetingName(name), undefined, JSON.stringify(name))
  }
  assert.equal(greetingName(' Ana '), 'Ana')
  assert.equal(greetingName('Sam'), 'Sam')
  assert.equal(greetingName('Website leader'), 'Website leader', 'only the exact placeholder is dropped')
})

// ════════════════════════════════════════════════════════════════════════
//  12. REVIEW FIXES — booking on record, outlived rows, subject stops, already sent
// ════════════════════════════════════════════════════════════════════════

/** The surfaces a returning customer most often writes in from while a booking is open. */
const SUPPORT_SURFACES = ['contact_support', 'popup', 'tracker'] as const

/** How old an ACTIVE row of each kind must be before it counts as ended. */
const OUTLIVED_AFTER: Record<SequenceKind, number> = {
  quote_followup: 7 * DAY + CONFIRMATION_WAIT_MAX_MS + DAY,
  abandoned_checkout: 72 * HOUR + CONFIRMATION_WAIT_MAX_MS + DAY,
  lead_nurture: 72 * HOUR + CONFIRMATION_WAIT_MAX_MS + DAY,
}

/** Backdate an enrollment row, leaving its status alone. */
const createdAgo = (row: Record<string, unknown>, age: number) => void (row.createdAt = new Date(NOW.getTime() - age))

/** The world's deps plus a spy on the enrollment claim. */
function claimSpy(w: World, over: Partial<JourneyDeps> = {}) {
  const claims: string[] = []
  const deps: JourneyDeps = {
    ...w.deps,
    enrollSequence: async (input) => (claims.push(`${input.sequenceKind}:${input.subjectId}`), w.deps.enrollSequence!(input)),
    ...over,
  }
  return { deps, claims }
}

/**
 * A RECORDING stopSubjectEnrollments that behaves like production's: only the
 * ACTIVE rows whose subject is exactly this lead or booking are stopped. Wired
 * for these tests only — the shared world has none.
 */
function withSubjectStops(w: World) {
  const calls: Array<[string, string, string]> = []
  const deps: JourneyDeps = {
    ...w.deps,
    async stopSubjectEnrollments(subjectType, subjectId, reason) {
      calls.push([subjectType, subjectId, reason])
      for (const e of w.db.tables.enrollments) {
        if (e.subjectType === subjectType && e.subjectId === subjectId && e.status === 'active') Object.assign(e, { status: 'stopped', stopReason: reason })
      }
    },
  }
  return { deps, calls }
}

/** A recording sequenceAlreadySent with a fixed answer (or a DB error). */
function withAlreadySent(w: World, answer: boolean | 'throw') {
  const asked: Array<[string, SequenceKind]> = []
  const claims: string[] = []
  const deps: JourneyDeps = {
    ...w.deps,
    enrollSequence: async (input) => (claims.push(`${input.sequenceKind}:${input.subjectId}`), w.deps.enrollSequence!(input)),
    async sequenceAlreadySent(leadId, kind) {
      asked.push([leadId, kind])
      if (answer === 'throw') throw new Error('db down')
      return answer
    },
  }
  return { deps, asked, claims }
}

/** An express (legacy column) opt-in on the shared customer, so a booking's recovery runs on it. */
function optInCustomer(w: World, ...bookingIds: string[]) {
  Object.assign(w.db.tables.customers.find((c: Record<string, unknown>) => c.id === 'cus_1')!, { emailMarketingConsent: true, marketingConsentAt: new Date(NOW.getTime() - DAY) })
  for (const id of bookingIds) w.bookingBlocks.set(id, null)
}

// ── 12a. A booking on record refuses the nurture ─────────────────────────

test('booking on record: production binds BOTH the scheduling and the send-time hasEverBooked to leads.hasBookingOnRecord', () => {
  //  Building the defaults opens nothing: the queue edge and every read are lazy.
  assert.equal(defaultJourneyDeps().hasEverBooked, hasBookingOnRecord, 'JourneyDeps.hasEverBooked')
  assert.equal(defaultStageDeps().hasEverBooked, hasBookingOnRecord, 'StageDeps.hasEverBooked')
  //  Both edges also get the new optional subject-level deps.
  assert.equal(typeof defaultJourneyDeps().stopSubjectEnrollments, 'function')
  assert.equal(typeof defaultJourneyDeps().sequenceAlreadySent, 'function')
})

test('booking on record: a contact_support, popup or tracker submission is refused previous_customer — no enrollment claim, no row, no jobs; the same submission enrolls once nothing is on record', async () => {
  for (const surface of SUPPORT_SURFACES) {
    const w = world()
    w.addLead('lead_n')
    const basis = await w.notice(surface, { leadId: 'lead_n' })
    const asked: Array<string | null> = []
    const { deps, claims } = claimSpy(w, { hasEverBooked: async (email) => (asked.push(email), true) })
    const input = { surface, scenario: 'lead_nurture' as const, leadId: 'lead_n', basisEventId: basis, email: EMAIL }

    assert.deepEqual(await onNoticeSubmission(input, deps), { scheduled: false, reason: 'previous_customer' }, surface)
    assert.deepEqual(asked, [EMAIL], `${surface}: asked about the lead's own address`)
    assert.deepEqual(claims, [], `${surface}: refused before the person-level claim`)
    assert.equal(w.jobs.size, 0, surface)
    assert.ok(hasNone(w, nurtureIds('lead_n')), surface)
    assert.equal(w.enrollmentsFor().length, 0, `${surface}: the person’s slot stays free`)
    //  Retrying the same submission while the booking is on record changes nothing.
    assert.deepEqual(await onNoticeSubmission(input, deps), { scheduled: false, reason: 'previous_customer' }, `${surface}: retry`)
    assert.equal(w.enrollmentsFor().length, 0, surface)

    //  The refusal was the booking and nothing else.
    assert.deepEqual(await onNoticeSubmission(input, w.deps), { scheduled: true, stages: 3 }, `${surface}: nothing on record`)
  }

  //  The legacy express hook asks the same question.
  const e = world()
  e.addLead('lead_e', OPTED_IN)
  assert.equal(await onLeadCaptured('lead_e', { ...e.deps, hasEverBooked: async () => true }), null)
  assert.equal(e.jobs.size, 0)
  assert.equal(e.enrollmentsFor().length, 0)
})

test('booking on record: at SEND time lead-nurture-1 in scenario_flow is refused previous_customer — for an enrolled lead and a notice-only lead alike; quote templates never ask', async () => {
  for (const surface of SUPPORT_SURFACES) {
    const w = world()
    const basis = await enrolledNurtureLead(w, surface)
    //  Precondition: the stage sends while nothing is on record.
    assert.deepEqual(await leadSendEligibility('lead_n', 'lead-nurture-1', NURTURE_SEND, w.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis }, surface)

    //  A booking waiting for payment or approval appears after enrollment.
    const asked: Array<string | null> = []
    const booked: StageDeps = { ...w.stage, hasEverBooked: async (email) => (asked.push(email), true) }
    assert.deepEqual(
      await leadSendEligibility('lead_n', 'lead-nurture-1', NURTURE_SEND, booked),
      { reason: 'previous_customer', marketingBasis: null, basisEventId: null },
      surface
    )
    assert.ok(asked.length > 0 && asked.every((a) => a === EMAIL), `${surface}: asked about the lead's address`)
    //  The scheduled worker names the kind explicitly: the same answer.
    assert.equal((await leadSendEligibility('lead_n', 'lead-nurture-1', { ...NURTURE_SEND, sequenceKind: 'lead_nurture' }, booked)).reason, 'previous_customer', surface)
    const lead = await booked.loadStageLead('lead_n')
    const d = await scenarioSendDecision({ leadId: 'lead_n', lead, template: 'lead-nurture-1', kind: 'lead_nurture', context: 'scenario_flow', recipient: EMAIL }, booked)
    assert.equal(d.reason, 'previous_customer')
    assert.equal(d.enrollment, null, 'refused before the enrollment is read')

    //  A notice-only lead nothing enrolled: the booking is the reason named.
    w.addLead('lead_other', { email: 'pat@example.com' })
    await w.notice(surface, { leadId: 'lead_other' }, { email: 'pat@example.com' })
    assert.equal(
      (await leadSendEligibility('lead_other', 'lead-nurture-1', { context: 'scenario_flow', recipient: 'pat@example.com' }, booked)).reason,
      'previous_customer',
      `${surface}: notice-only lead`
    )
  }

  //  The booking-history question belongs to the nurture only: Sequence A is not refused by it.
  const q = world()
  const basis = await enrolledQuoteLead(q)
  const booked: StageDeps = {
    ...q.stage,
    hasEverBooked: async () => {
      throw new Error('a quote stage must not ask')
    },
  }
  assert.deepEqual(await leadSendEligibility('lead_q', 'quote-followup-1', QUOTE_SEND, booked), { reason: null, marketingBasis: 'notice', basisEventId: basis })
})

// ── 12b. An ACTIVE row that outlived its stages ───────────────────────────

test('outlived: enrollmentOutlivedItsStages — over only STRICTLY after the kind’s last stage delay + CONFIRMATION_WAIT_MAX_MS + one day', () => {
  assert.equal(OUTLIVED_AFTER.quote_followup, 10 * DAY)
  assert.equal(OUTLIVED_AFTER.abandoned_checkout, 6 * DAY)
  assert.equal(OUTLIVED_AFTER.lead_nurture, 6 * DAY)
  for (const kind of SEQUENCE_KINDS) {
    const last = Math.max(...stagesForKind(kind).map((s) => s.delay))
    assert.equal(OUTLIVED_AFTER[kind], last + CONFIRMATION_WAIT_MAX_MS + DAY, `${kind}: the bound is derived from its own stages`)
    const over = (age: number, now: Date = NOW) => enrollmentOutlivedItsStages({ sequenceKind: kind, createdAt: new Date(now.getTime() - age) }, now)
    assert.equal(over(0), false, `${kind}: just created`)
    assert.equal(over(last), false, `${kind}: its last stage is only now due`)
    assert.equal(over(OUTLIVED_AFTER[kind] - 1), false, `${kind}: 1 ms before the bound`)
    assert.equal(over(OUTLIVED_AFTER[kind]), false, `${kind}: exactly at the bound it still counts as running`)
    assert.equal(over(OUTLIVED_AFTER[kind] + 1), true, `${kind}: 1 ms past the bound`)
    assert.equal(over(29 * DAY), true, `${kind}: still inside the 30-day window`)
    assert.equal(over(OUTLIVED_AFTER[kind] + 1, new Date('2027-01-01T00:00:00.000Z')), true, `${kind}: relative to the clock passed in`)
  }
  //  Status plays no part: the helper only answers "has its time passed".
  //  A kind the registry does not know never counts as over, however old.
  assert.equal(enrollmentOutlivedItsStages({ sequenceKind: 'lead_nurture_contact', createdAt: new Date(NOW.getTime() - 365 * DAY) }, NOW), false)
  assert.equal(enrollmentOutlivedItsStages({ sequenceKind: '', createdAt: new Date(NOW.getTime() - 365 * DAY) }, NOW), false)
  //  A row stamped in the future (clock skew) is not over.
  assert.equal(enrollmentOutlivedItsStages({ sequenceKind: 'quote_followup', createdAt: new Date(NOW.getTime() + DAY) }, NOW), false)
})

test('outlived: an ACTIVE quote follow-up for ANOTHER lead — fresh or at the bound it refuses the express person’s next quote; past the bound that quote is scheduled with no new row', async () => {
  const w = world()
  w.addLead('lead_a', { ...OPTED_IN, quotedAt: NOW })
  assert.deepEqual(await ensureQuoteJourney('lead_a', w.deps), { scheduled: true, stages: 3 })
  const row = w.enrollmentsFor('quote_followup')[0]
  w.addLead('lead_b', { ...OPTED_IN, quotedAt: NOW })

  assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: false, reason: 'already_enrolled' }, 'fresh active row')
  createdAgo(row, OUTLIVED_AFTER.quote_followup)
  assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: false, reason: 'already_enrolled' }, 'exactly at the bound')
  assert.ok(hasNone(w, ids('quote_followup', 'lead_b')))

  createdAgo(row, OUTLIVED_AFTER.quote_followup + 1)
  assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: true, stages: 3 }, 'outlived: express / legacy per-flow behaviour')
  assert.ok(hasAll(w, ids('quote_followup', 'lead_b')))
  assert.equal(w.enrollmentsFor('quote_followup').length, 1, 'scheduled without a second row')
  assert.equal(row.subjectId, 'lead_a')
  assert.equal(row.status, 'active', 'the old row is not rewritten')

  //  An outlived row for the SAME lead that was STOPPED is still never restarted.
  const s = world()
  s.addLead('lead_a', { ...OPTED_IN, quotedAt: NOW })
  assert.equal((await ensureQuoteJourney('lead_a', s.deps)).scheduled, true)
  Object.assign(s.enrollmentsFor('quote_followup')[0], { status: 'stopped' })
  createdAgo(s.enrollmentsFor('quote_followup')[0], OUTLIVED_AFTER.quote_followup + DAY)
  for (const id of ids('quote_followup', 'lead_a')) s.jobs.delete(id)
  assert.deepEqual(await ensureQuoteJourney('lead_a', s.deps), { scheduled: false, reason: 'already_enrolled' })
  assert.ok(hasNone(s, ids('quote_followup', 'lead_a')))
})

test('outlived: a NOTICE person is refused already_enrolled inside the 30-day window even when the other lead’s ACTIVE quote row outlived its stages', async () => {
  const w = world()
  await enrolledQuoteLead(w)
  const row = w.enrollmentsFor('quote_followup')[0]
  w.addLead('lead_2', { quotedAt: NOW })
  const b2 = await w.notice('quote', { leadId: 'lead_2' })
  const second = { surface: 'quote' as const, scenario: 'quote_followup' as const, leadId: 'lead_2', basisEventId: b2, email: EMAIL }

  assert.deepEqual(await onNoticeSubmission(second, w.deps), { scheduled: false, reason: 'already_enrolled' }, 'fresh active row')
  for (const age of [OUTLIVED_AFTER.quote_followup + 1, 20 * DAY, 30 * DAY - 1]) {
    createdAgo(row, age)
    assert.deepEqual(await onNoticeSubmission(second, w.deps), { scheduled: false, reason: 'already_enrolled' }, `outlived by ${age} ms`)
  }
  assert.ok(hasNone(w, ids('quote_followup', 'lead_2')))
  assert.equal(w.enrollmentsFor().length, 1)
  assert.equal(row.status, 'active')
})

test('outlived: abandoned checkout — an express customer’s next booking is scheduled once the earlier booking’s ACTIVE row outlived its stages (no new row); a notice booking is still refused; a fresh row refuses both', async () => {
  //  EXPRESS (the Customer consent column).
  const e = world()
  e.addBooking('bk_1')
  e.addBooking('bk_2')
  optInCustomer(e, 'bk_1', 'bk_2')
  assert.equal((await onCheckoutStarted('bk_1', e.deps))?.scheduled, 3)
  const row = e.enrollmentsFor('abandoned_checkout')[0]
  assert.equal(row.subjectId, 'bk_1')
  assert.equal(row.basisEventId, null, 'precondition: an express basis')

  assert.equal(await onCheckoutStarted('bk_2', e.deps), null, 'fresh active row')
  createdAgo(row, OUTLIVED_AFTER.abandoned_checkout)
  assert.equal(await onCheckoutStarted('bk_2', e.deps), null, 'exactly at the bound')
  assert.ok(hasNone(e, ids('abandoned_checkout', 'bk_2')))
  createdAgo(row, OUTLIVED_AFTER.abandoned_checkout + 1)
  assert.equal((await onCheckoutStarted('bk_2', e.deps))?.scheduled, 3, 'outlived')
  assert.ok(hasAll(e, ids('abandoned_checkout', 'bk_2')))
  assert.equal(e.enrollmentsFor('abandoned_checkout').length, 1, 'no second row')

  //  NOTICE (a booking-surface notice on each booking).
  const n = world()
  n.addBooking('bk_1')
  const b1 = await n.notice('booking', { bookingId: 'bk_1' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: b1, email: EMAIL }, n.deps),
    { scheduled: true, stages: 3 }
  )
  n.addBooking('bk_2')
  const b2 = await n.notice('booking', { bookingId: 'bk_2' })
  const second = { surface: 'booking' as const, scenario: 'abandoned_checkout' as const, bookingId: 'bk_2', basisEventId: b2, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission(second, n.deps), { scheduled: false, reason: 'not_scheduled' }, 'fresh active row')
  createdAgo(n.enrollmentsFor('abandoned_checkout')[0], OUTLIVED_AFTER.abandoned_checkout + 1)
  assert.deepEqual(await onNoticeSubmission(second, n.deps), { scheduled: false, reason: 'not_scheduled' }, 'outlived, still inside 30 days')
  assert.ok(hasNone(n, ids('abandoned_checkout', 'bk_2')))
  assert.equal(n.enrollmentsFor().length, 1)
})

test('outlived: lead nurture — an express person’s next lead is scheduled once the other lead’s ACTIVE nurture outlived its stages; a notice person is still refused; a fresh row refuses both', async () => {
  //  EXPRESS, through the legacy capture hook.
  const e = world()
  e.addLead('lead_a', OPTED_IN)
  assert.equal((await onLeadCaptured('lead_a', e.deps))?.scheduled, 3)
  const row = e.enrollmentsFor('lead_nurture')[0]
  e.addLead('lead_b', OPTED_IN)
  assert.equal(await onLeadCaptured('lead_b', e.deps), null, 'fresh active row')
  createdAgo(row, OUTLIVED_AFTER.lead_nurture)
  assert.equal(await onLeadCaptured('lead_b', e.deps), null, 'exactly at the bound')
  assert.ok(hasNone(e, nurtureIds('lead_b')))
  createdAgo(row, OUTLIVED_AFTER.lead_nurture + 1)
  assert.equal((await onLeadCaptured('lead_b', e.deps))?.scheduled, 3, 'outlived')
  assert.ok(hasAll(e, nurtureIds('lead_b')))
  assert.equal(e.enrollmentsFor('lead_nurture').length, 1, 'no second row')
  assert.equal(row.status, 'active')

  //  EXPRESS, through the submission path (the opt-in wins over the notice).
  const s = world()
  s.addLead('lead_a', OPTED_IN)
  const ba = await s.notice('contact', { leadId: 'lead_a' })
  assert.deepEqual(await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_a', basisEventId: ba, email: EMAIL }, s.deps), { scheduled: true, stages: 3 })
  s.addLead('lead_b', OPTED_IN)
  const bb = await s.notice('popup', { leadId: 'lead_b' })
  const expressSecond = { surface: 'popup' as const, scenario: 'lead_nurture' as const, leadId: 'lead_b', basisEventId: bb, email: EMAIL }
  assert.deepEqual(await onNoticeSubmission(expressSecond, s.deps), { scheduled: false, reason: 'already_enrolled' })
  createdAgo(s.enrollmentsFor('lead_nurture')[0], OUTLIVED_AFTER.lead_nurture + 1)
  assert.deepEqual(await onNoticeSubmission(expressSecond, s.deps), { scheduled: true, stages: 3 })

  //  NOTICE: one nurture per person per 30-day window, outlived or not.
  for (const surface of SUPPORT_SURFACES) {
    const n = world()
    await enrolledNurtureLead(n, 'contact', 'lead_1')
    n.addLead('lead_2')
    const b2 = await n.notice(surface, { leadId: 'lead_2' })
    const second = { surface, scenario: 'lead_nurture' as const, leadId: 'lead_2', basisEventId: b2, email: EMAIL }
    assert.deepEqual(await onNoticeSubmission(second, n.deps), { scheduled: false, reason: 'already_enrolled' }, `${surface}: fresh`)
    createdAgo(n.enrollmentsFor('lead_nurture')[0], OUTLIVED_AFTER.lead_nurture + 1)
    assert.deepEqual(await onNoticeSubmission(second, n.deps), { scheduled: false, reason: 'already_enrolled' }, `${surface}: outlived`)
    assert.ok(hasNone(n, nurtureIds('lead_2')), surface)
    assert.equal(n.enrollmentsFor().length, 1, surface)
  }
})

// ── 12c. The subject-level stop ───────────────────────────────────────────

test('subject stop: onBookingPaid calls stopSubjectEnrollments("booking", id, "deposit_paid") — the paid booking’s recovery row ends, so the express customer’s next booking gets its own', async () => {
  const w = world()
  w.addBooking('bk_1')
  w.addBooking('bk_2')
  optInCustomer(w, 'bk_1', 'bk_2')
  //  A running nurture on a lead for the same person must not be touched.
  w.addLead('lead_n', OPTED_IN)
  assert.equal((await onLeadCaptured('lead_n', w.deps))?.scheduled, 3)
  assert.equal((await onCheckoutStarted('bk_1', w.deps))?.scheduled, 3)
  assert.equal(await onCheckoutStarted('bk_2', w.deps), null, 'precondition: the unpaid first booking holds the slot')

  const { deps, calls } = withSubjectStops(w)
  await onBookingPaid('bk_1', deps)

  assert.deepEqual(calls, [['booking', 'bk_1', 'deposit_paid']])
  const recovery = w.enrollmentsFor('abandoned_checkout')[0]
  assert.equal(recovery.status, 'stopped')
  assert.equal(recovery.stopReason, 'deposit_paid')
  assert.ok(hasNone(w, ids('abandoned_checkout', 'bk_1')), 'the recovery stages are cancelled')
  assert.equal(w.enrollmentsFor('lead_nurture')[0].status, 'active', 'another subject’s row is untouched')
  assert.ok(hasAll(w, nurtureIds('lead_n')))

  assert.equal((await onCheckoutStarted('bk_2', deps))?.scheduled, 3, 'the paid booking no longer counts as a running sequence')
  assert.ok(hasAll(w, ids('abandoned_checkout', 'bk_2')))
})

test('subject stop: onBookingCancelled calls stopSubjectEnrollments("booking", id, "booking_cancelled") and onLeadClosed calls it with ("lead", id, "lead_closed")', async () => {
  //  A cancelled booking.
  const b = world()
  b.addBooking('bk_1')
  const basis = await b.notice('booking', { bookingId: 'bk_1' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: basis, email: EMAIL }, b.deps),
    { scheduled: true, stages: 3 }
  )
  const bs = withSubjectStops(b)
  await onBookingCancelled('bk_1', bs.deps)
  assert.deepEqual(bs.calls, [['booking', 'bk_1', 'booking_cancelled']])
  assert.equal(b.enrollmentsFor('abandoned_checkout')[0].status, 'stopped')
  assert.equal(b.enrollmentsFor('abandoned_checkout')[0].stopReason, 'booking_cancelled')
  assert.ok(hasNone(b, ids('abandoned_checkout', 'bk_1')))

  //  A closed lead: its own nurture ends, the person's quote follow-up on ANOTHER lead does not.
  const l = world()
  await enrolledQuoteLead(l)
  await enrolledNurtureLead(l, 'tracker', 'lead_n')
  const ls = withSubjectStops(l)
  await onLeadClosed('lead_n', ls.deps)
  assert.deepEqual(ls.calls, [['lead', 'lead_n', 'lead_closed']])
  const nurture = l.enrollmentsFor('lead_nurture')[0]
  assert.equal(nurture.status, 'stopped')
  assert.equal(nurture.stopReason, 'lead_closed')
  assert.ok(hasNone(l, nurtureIds('lead_n')))
  assert.equal(l.enrollmentsFor('quote_followup')[0].status, 'active', 'lead_q is a different subject')
  assert.ok(hasAll(l, ids('quote_followup', 'lead_q')))
  //  The remaining stages refuse at send time too.
  assert.equal((await leadSendEligibility('lead_n', 'lead-nurture-2', NURTURE_SEND, l.stage)).reason, 'enrollment_not_active')

  //  Closing the quote lead names that lead.
  await onLeadClosed('lead_q', ls.deps)
  assert.deepEqual(ls.calls, [['lead', 'lead_n', 'lead_closed'], ['lead', 'lead_q', 'lead_closed']])
  assert.equal(l.enrollmentsFor('quote_followup')[0].stopReason, 'lead_closed')

  //  Paying and cancelling name exactly the booking passed in.
  const p = world()
  const ps = withSubjectStops(p)
  await onBookingPaid('bk_9', ps.deps)
  await onBookingCancelled('bk_8', ps.deps)
  assert.deepEqual(ps.calls, [['booking', 'bk_9', 'deposit_paid'], ['booking', 'bk_8', 'booking_cancelled']])
})

test('subject stop: a world WITHOUT stopSubjectEnrollments still pays, cancels and closes — the jobs go, nothing throws (optional chaining)', async () => {
  const w = world()
  assert.equal(w.deps.stopSubjectEnrollments, undefined, 'the shared world has none')
  w.addBooking('bk_1')
  const basis = await w.notice('booking', { bookingId: 'bk_1' })
  assert.equal((await onNoticeSubmission({ surface: 'booking', scenario: 'abandoned_checkout', bookingId: 'bk_1', basisEventId: basis, email: EMAIL }, w.deps)).scheduled, true)
  await assert.doesNotReject(() => onBookingPaid('bk_1', w.deps))
  assert.ok(hasNone(w, ids('abandoned_checkout', 'bk_1')))
  await assert.doesNotReject(() => onBookingCancelled('bk_1', w.deps))

  await enrolledNurtureLead(w, 'popup', 'lead_n')
  await assert.doesNotReject(() => onLeadClosed('lead_n', w.deps))
  assert.ok(hasNone(w, nurtureIds('lead_n')))
  for (const id of nurtureIds('lead_n')) assert.ok(w.cancelled.includes(id), `cancel(${id})`)
  //  Nothing stopped the rows in this world; the send-time gate is the enforcement.
  assert.equal(w.enrollmentsFor('lead_nurture')[0].status, 'active')
  assert.equal(w.enrollmentsFor('abandoned_checkout')[0].status, 'active')

  //  An older world with none of the consent deps at all.
  const bare: JourneyDeps = { ...w.deps, eligibility: undefined, enrollSequence: undefined, stopPersonEnrollments: undefined, openLeadIdsForEmail: undefined, loadBookingBasis: undefined }
  await assert.doesNotReject(() => onBookingPaid('bk_x', bare))
  await assert.doesNotReject(() => onBookingCancelled('bk_x', bare))
  await assert.doesNotReject(() => onLeadClosed('lead_x', bare))
})

// ── 12d. A lead that was already SENT a sequence is never re-enrolled ─────

test('already sent: ensureQuoteJourney answers already_sent BEFORE any enrollment claim — express, the submission path, and a re-submission that keeps its running jobs', async () => {
  //  Express (the admin / repair path).
  const e = world()
  e.addLead('lead_x', { ...OPTED_IN, quotedAt: NOW })
  const es = withAlreadySent(e, true)
  assert.deepEqual(await ensureQuoteJourney('lead_x', es.deps), { scheduled: false, reason: 'already_sent' })
  assert.deepEqual(es.asked, [['lead_x', 'quote_followup']])
  assert.deepEqual(es.claims, [], 'no enrollment claim')
  assert.equal(e.enrollmentsFor().length, 0, 'no row')
  assert.equal(e.jobs.size, 0, 'no jobs')

  //  The quote-page submission.
  const n = world()
  n.addLead('lead_q', { quotedAt: NOW })
  const basis = await n.notice('quote', { leadId: 'lead_q' })
  const input = { surface: 'quote' as const, scenario: 'quote_followup' as const, leadId: 'lead_q', basisEventId: basis, email: EMAIL }
  const ns = withAlreadySent(n, true)
  assert.deepEqual(await onNoticeSubmission(input, ns.deps), { scheduled: false, reason: 'already_sent' })
  assert.deepEqual(ns.asked, [['lead_q', 'quote_followup']])
  assert.deepEqual(ns.claims, [])
  assert.equal(n.enrollmentsFor().length, 0)
  assert.equal(n.jobs.size, 0)

  //  Answer false: scheduling proceeds exactly as before.
  const ok = withAlreadySent(n, false)
  assert.deepEqual(await onNoticeSubmission(input, ok.deps), { scheduled: true, stages: 3 })
  assert.deepEqual(ok.asked, [['lead_q', 'quote_followup']])
  assert.deepEqual(ok.claims, ['quote_followup:lead_q'])
  assert.equal(n.enrollmentsFor('quote_followup').length, 1)
  assert.ok(hasAll(n, ids('quote_followup', 'lead_q')))
  const ex = withAlreadySent(e, false)
  assert.deepEqual(await ensureQuoteJourney('lead_x', ex.deps), { scheduled: true, stages: 3 })

  //  The lead received stage 1 and re-submits: refused, and the running jobs and row stay.
  const again = withAlreadySent(n, true)
  assert.deepEqual(await onNoticeSubmission(input, again.deps), { scheduled: false, reason: 'already_sent' })
  assert.ok(hasAll(n, ids('quote_followup', 'lead_q')), 'nothing cancelled the quote stages')
  assert.equal(n.enrollmentsFor('quote_followup').length, 1)
  assert.equal(n.enrollmentsFor('quote_followup')[0].status, 'active')

  //  A real refusal keeps its own name: no quote, a prohibition.
  const r = world()
  r.addLead('lead_nq', OPTED_IN)
  assert.deepEqual(await ensureQuoteJourney('lead_nq', withAlreadySent(r, true).deps), { scheduled: false, reason: 'no_quote' })
  r.addLead('lead_sup', { ...OPTED_IN, quotedAt: NOW, email: 'pat@example.com' })
  r.db.tables.suppressions.push({ email: 'pat@example.com', reason: 'HARD_BOUNCE', scope: 'all' })
  assert.deepEqual(await ensureQuoteJourney('lead_sup', withAlreadySent(r, true).deps), { scheduled: false, reason: 'suppressed' })
})

test('already sent: a lead-nurture submission on every surface answers already_sent BEFORE any enrollment claim; answer false and it enrolls as before', async () => {
  for (const surface of NOTICE_SURFACES) {
    const w = world()
    w.addLead('lead_n')
    const basis = await w.notice(surface, { leadId: 'lead_n' })
    const input = { surface, scenario: 'lead_nurture' as const, leadId: 'lead_n', basisEventId: basis, email: EMAIL }

    const sent = withAlreadySent(w, true)
    assert.deepEqual(await onNoticeSubmission(input, sent.deps), { scheduled: false, reason: 'already_sent' }, surface)
    assert.deepEqual(sent.asked, [['lead_n', 'lead_nurture']], surface)
    assert.deepEqual(sent.claims, [], `${surface}: no enrollment claim`)
    assert.equal(w.enrollmentsFor().length, 0, `${surface}: no row, so the person’s other leads are not blocked for 30 days`)
    assert.equal(w.jobs.size, 0, surface)

    const fresh = withAlreadySent(w, false)
    assert.deepEqual(await onNoticeSubmission(input, fresh.deps), { scheduled: true, stages: 3 }, surface)
    assert.deepEqual(fresh.asked, [['lead_n', 'lead_nurture']], surface)
    assert.deepEqual(fresh.claims, ['lead_nurture:lead_n'], surface)
    assert.equal(w.enrollmentsFor('lead_nurture').length, 1, surface)
    assert.deepEqual([...w.jobs.keys()].sort(), nurtureIds('lead_n').sort(), surface)
  }

  //  A returning person whose new form merged into their old open lead: the
  //  running sequence keeps its jobs and its row.
  const m = world()
  const basis = await enrolledNurtureLead(m, 'popup', 'lead_n')
  const merged = withAlreadySent(m, true)
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'popup', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, merged.deps),
    { scheduled: false, reason: 'already_sent' }
  )
  assert.deepEqual([...m.jobs.keys()].sort(), nurtureIds('lead_n').sort())
  assert.equal(m.enrollmentsFor('lead_nurture')[0].status, 'active')

  //  The legacy express hook asks too, and schedules nothing.
  const e = world()
  e.addLead('lead_e', OPTED_IN)
  const es = withAlreadySent(e, true)
  assert.equal(await onLeadCaptured('lead_e', es.deps), null)
  assert.deepEqual(es.asked, [['lead_e', 'lead_nurture']])
  assert.equal(e.enrollmentsFor().length, 0)
  assert.equal(e.jobs.size, 0)

  //  A real refusal keeps its own name: a quote exists, a booking on record.
  const q = world()
  q.addLead('lead_q', { quotedAt: NOW })
  const qb = await q.notice('quote', { leadId: 'lead_q' })
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'quote', scenario: 'lead_nurture', leadId: 'lead_q', basisEventId: qb, email: EMAIL }, withAlreadySent(q, true).deps),
    { scheduled: false, reason: 'has_quote' }
  )
  const p = world()
  p.addLead('lead_p')
  const pb = await p.notice('contact_support', { leadId: 'lead_p' })
  assert.deepEqual(
    await onNoticeSubmission(
      { surface: 'contact_support', scenario: 'lead_nurture', leadId: 'lead_p', basisEventId: pb, email: EMAIL },
      { ...withAlreadySent(p, true).deps, hasEverBooked: async () => true }
    ),
    { scheduled: false, reason: 'previous_customer' }
  )
})

test('already sent: a DB error in sequenceAlreadySent schedules nothing — the nurture submission is refused scheduling_failed with no row and no jobs', async () => {
  const w = world()
  w.addLead('lead_n')
  const basis = await w.notice('contact', { leadId: 'lead_n' })
  const broken = withAlreadySent(w, 'throw')
  assert.deepEqual(
    await onNoticeSubmission({ surface: 'contact', scenario: 'lead_nurture', leadId: 'lead_n', basisEventId: basis, email: EMAIL }, broken.deps),
    { scheduled: false, reason: 'scheduling_failed' }
  )
  assert.deepEqual(broken.claims, [])
  assert.equal(w.enrollmentsFor().length, 0)
  assert.equal(w.jobs.size, 0)
})

test('already sent: a DB error in sequenceAlreadySent on a QUOTE submission is caught inside onNoticeSubmission — it resolves scheduling_failed (never rejects), with no claim, no row and no jobs', async () => {
  const w = world()
  w.addLead('lead_q', { quotedAt: NOW })
  const basis = await w.notice('quote', { leadId: 'lead_q' })
  const input = { surface: 'quote' as const, scenario: 'quote_followup' as const, leadId: 'lead_q', basisEventId: basis, email: EMAIL }
  const broken = withAlreadySent(w, 'throw')

  //  Premise: ensureQuoteJourney itself lets the read error out, so only
  //  onNoticeSubmission's own try can turn it into a refusal.
  await assert.rejects(() => ensureQuoteJourney('lead_q', broken.deps, { allowNoticeBasis: true }), /db down/)
  assert.deepEqual(broken.asked, [['lead_q', 'quote_followup']])
  broken.asked.length = 0

  const pending = onNoticeSubmission(input, broken.deps)
  await assert.doesNotReject(pending, 'the route must never see a rejection')
  assert.deepEqual(await pending, { scheduled: false, reason: 'scheduling_failed' })
  assert.deepEqual(broken.asked, [['lead_q', 'quote_followup']], 'the failure was the already-sent read')
  assert.deepEqual(broken.claims, [], 'no enrollment claim')
  assert.equal(w.enrollmentsFor().length, 0, 'no row')
  assert.equal(w.jobs.size, 0, 'no jobs')

  //  The same submission once the read recovers enrolls as normal.
  assert.deepEqual(await onNoticeSubmission(input, withAlreadySent(w, false).deps), { scheduled: true, stages: 3 })
  assert.ok(hasAll(w, ids('quote_followup', 'lead_q')))
  assert.equal(w.enrollmentsFor('quote_followup').length, 1)
})

// ── 12e. The send-time gate agrees with the claim about an outlived row ────

test('outlived at SEND time: an express lead scheduled past another lead’s outlived ACTIVE quote row is eligible under its opt-in; a fresh or at-the-bound row still refuses already_enrolled', async () => {
  const w = world()
  w.addLead('lead_a', { ...OPTED_IN, quotedAt: NOW })
  assert.deepEqual(await ensureQuoteJourney('lead_a', w.deps), { scheduled: true, stages: 3 })
  const row = w.enrollmentsFor('quote_followup')[0]
  assert.equal(row.subjectId, 'lead_a')
  w.addLead('lead_b', { ...OPTED_IN, quotedAt: NOW })
  const send = { context: 'scenario_flow' as const, recipient: EMAIL }
  const refusedSend = { reason: 'already_enrolled', marketingBasis: null, basisEventId: null }

  //  A fresh row, and a row exactly at the bound: the claim AND the send gate refuse.
  for (const [label, age] of [['fresh', 0], ['exactly at the bound', OUTLIVED_AFTER.quote_followup]] as const) {
    createdAgo(row, age)
    assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: false, reason: 'already_enrolled' }, `${label}: claim`)
    assert.deepEqual(await leadSendEligibility('lead_b', 'quote-followup-1', send, w.stage), refusedSend, `${label}: send`)
    assert.deepEqual(await leadSendEligibility('lead_b', 'quote-followup-1', QUOTE_SEND, w.stage), refusedSend, `${label}: send, kind named`)
  }

  //  Past the bound: scheduled with no row of its own, and every stage is eligible.
  createdAgo(row, OUTLIVED_AFTER.quote_followup + 1)
  assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: true, stages: 3 })
  assert.ok(hasAll(w, ids('quote_followup', 'lead_b')))
  assert.equal(w.enrollmentsFor('quote_followup').length, 1, 'no second row')
  assert.deepEqual(await leadSendEligibility('lead_b', 'quote-followup-1', send, w.stage), { reason: null, marketingBasis: 'express', basisEventId: null })
  for (const s of QUOTE_STAGES) {
    assert.deepEqual(await leadSendEligibility('lead_b', s.type, QUOTE_SEND, w.stage), { reason: null, marketingBasis: 'express', basisEventId: null }, s.type)
  }
  assert.equal(row.status, 'active', 'the send gate rewrites nothing')

  //  A NEW, fresh row for another lead of the same person refuses again.
  w.addLead('lead_c', { ...OPTED_IN, quotedAt: NOW })
  w.db.tables.enrollments.push({ ...row, id: 'enr_fresh_c', subjectId: 'lead_c', createdAt: new Date(NOW.getTime() - HOUR), status: 'active' })
  assert.deepEqual(await leadSendEligibility('lead_b', 'quote-followup-1', send, w.stage), refusedSend, 'a newer, running row for another lead')
})

test('outlived at SEND time: an express lead nurture scheduled past another lead’s outlived ACTIVE nurture row is eligible under its opt-in; a fresh or at-the-bound row still refuses already_enrolled', async () => {
  const w = world()
  w.addLead('lead_a', OPTED_IN)
  assert.equal((await onLeadCaptured('lead_a', w.deps))?.scheduled, 3)
  const row = w.enrollmentsFor('lead_nurture')[0]
  assert.equal(row.subjectId, 'lead_a')
  w.addLead('lead_b', OPTED_IN)
  const refusedSend = { reason: 'already_enrolled', marketingBasis: null, basisEventId: null }

  for (const [label, age] of [['fresh', 0], ['exactly at the bound', OUTLIVED_AFTER.lead_nurture]] as const) {
    createdAgo(row, age)
    assert.equal(await onLeadCaptured('lead_b', w.deps), null, `${label}: claim`)
    assert.deepEqual(await leadSendEligibility('lead_b', 'lead-nurture-1', NURTURE_SEND, w.stage), refusedSend, `${label}: send`)
  }
  assert.ok(hasNone(w, nurtureIds('lead_b')))

  createdAgo(row, OUTLIVED_AFTER.lead_nurture + 1)
  assert.equal((await onLeadCaptured('lead_b', w.deps))?.scheduled, 3)
  assert.ok(hasAll(w, nurtureIds('lead_b')))
  assert.equal(w.enrollmentsFor('lead_nurture').length, 1, 'no second row')
  assert.deepEqual(await leadSendEligibility('lead_b', 'lead-nurture-1', NURTURE_SEND, w.stage), { reason: null, marketingBasis: 'express', basisEventId: null })
  for (const s of LEAD_NURTURE_STAGES) {
    assert.deepEqual(
      await leadSendEligibility('lead_b', s.type, { ...NURTURE_SEND, sequenceKind: 'lead_nurture' }, w.stage),
      { reason: null, marketingBasis: 'express', basisEventId: null },
      s.type
    )
  }
  assert.equal(row.status, 'active')

  //  A NEW, fresh row for another lead of the same person refuses again.
  w.addLead('lead_c', OPTED_IN)
  w.db.tables.enrollments.push({ ...row, id: 'enr_fresh_c', subjectId: 'lead_c', createdAt: new Date(NOW.getTime() - HOUR), status: 'active' })
  assert.deepEqual(await leadSendEligibility('lead_b', 'lead-nurture-1', NURTURE_SEND, w.stage), refusedSend, 'a newer, running row for another lead')
})

// ── 12f. Only THIS lead's row is its enrollment ────────────────────────────
//  Review fix: once an outlived row of another lead stopped refusing, that row
//  also stood in for the lead's OWN enrollment — a notice-basis stage whose own
//  row was stopped (or never existed) passed the gate, the other row anchored
//  person_booked_since, and it was returned for the confirmation gate to stop.

const NOT_ACTIVE = { reason: 'enrollment_not_active', marketingBasis: null, basisEventId: null }

/** scenarioSendDecision for one lead-scoped stage, the way leadSendEligibility asks it. */
async function decide(w: World, leadId: string, template: string, kind: SequenceKind) {
  const lead = await w.stage.loadStageLead(leadId)
  return scenarioSendDecision({ leadId, lead, template, kind, context: 'scenario_flow', recipient: EMAIL }, w.stage)
}

test('own row: a NOTICE lead whose own nurture row was stopped is refused enrollment_not_active while another lead’s ACTIVE row (outlived, from outside the 30-day window) still exists', async () => {
  const w = world()
  //  lead_old: a nurture enrolled 40 days ago; nothing ever marked its row completed.
  w.setNow(new Date(NOW.getTime() - 40 * DAY))
  w.addLead('lead_old', OPTED_IN)
  assert.equal((await onLeadCaptured('lead_old', w.deps))?.scheduled, 3)
  w.setNow(NOW)
  const old = w.enrollmentsFor('lead_nurture')[0]
  assert.equal(old.subjectId, 'lead_old')
  assert.equal(old.status, 'active', 'premise: the old row is still active')
  assert.ok(enrollmentOutlivedItsStages(old as never, NOW), 'premise: and long outlived')

  //  lead_n: a contact-form notice today, outside that window, so it gets a row of its own.
  const basis = await enrolledNurtureLead(w, 'contact', 'lead_n')
  const own = w.enrollmentsFor('lead_nurture').find((e: Record<string, unknown>) => e.subjectId === 'lead_n')!
  assert.ok(own, 'premise: lead_n owns a row')
  assert.deepEqual(await leadSendEligibility('lead_n', 'lead-nurture-2', NURTURE_SEND, w.stage), { reason: null, marketingBasis: 'notice', basisEventId: basis }, 'precondition: its own row sends')
  assert.equal((await decide(w, 'lead_n', 'lead-nurture-2', 'lead_nurture')).enrollment?.id, own.id, 'precondition: the decision names its OWN row')

  //  A subject-level stop on lead_n alone (its job removal failed: the jobs remain).
  await withSubjectStops(w).deps.stopSubjectEnrollments!('lead', 'lead_n', 'lead_closed')
  assert.equal(own.status, 'stopped')
  assert.equal(old.status, 'active', 'premise: the other lead’s row is untouched')
  assert.ok(hasAll(w, nurtureIds('lead_n')), 'premise: the stages are still queued')

  assert.deepEqual(await leadSendEligibility('lead_n', 'lead-nurture-2', { context: 'scenario_flow', recipient: EMAIL }, w.stage), NOT_ACTIVE)
  for (const s of LEAD_NURTURE_STAGES) {
    assert.deepEqual(await leadSendEligibility('lead_n', s.type, NURTURE_SEND, w.stage), NOT_ACTIVE, s.type)
    assert.deepEqual(await leadSendEligibility('lead_n', s.type, { ...NURTURE_SEND, sequenceKind: 'lead_nurture' }, w.stage), NOT_ACTIVE, `${s.type}, kind named`)
  }
  const d = await decide(w, 'lead_n', 'lead-nurture-2', 'lead_nurture')
  assert.equal(d.reason, 'enrollment_not_active')
  assert.equal(d.enrollment, null, 'the other lead’s row is never returned')
  assert.equal(old.status, 'active')
})

test('own row: a POPUP-notice lead with no row of its own is refused enrollment_not_active while another lead’s row is outlived — and already_enrolled while that row is fresh or at the bound', async () => {
  const w = world()
  w.addLead('lead_a', OPTED_IN)
  assert.equal((await onLeadCaptured('lead_a', w.deps))?.scheduled, 3)
  const row = w.enrollmentsFor('lead_nurture')[0]
  w.addLead('lead_x')
  await w.notice('popup', { leadId: 'lead_x' })
  const alreadyEnrolled = { reason: 'already_enrolled', marketingBasis: null, basisEventId: null }

  for (const [label, age] of [['fresh', 0], ['exactly at the bound', OUTLIVED_AFTER.lead_nurture]] as const) {
    createdAgo(row, age)
    assert.deepEqual(await leadSendEligibility('lead_x', 'lead-nurture-1', NURTURE_SEND, w.stage), alreadyEnrolled, label)
  }
  for (const age of [OUTLIVED_AFTER.lead_nurture + 1, 20 * DAY, 45 * DAY]) {
    createdAgo(row, age)
    assert.deepEqual(await leadSendEligibility('lead_x', 'lead-nurture-1', { context: 'scenario_flow', recipient: EMAIL }, w.stage), NOT_ACTIVE, `outlived by ${age} ms`)
    for (const s of LEAD_NURTURE_STAGES) {
      assert.deepEqual(await leadSendEligibility('lead_x', s.type, NURTURE_SEND, w.stage), NOT_ACTIVE, `${s.type}, ${age} ms`)
    }
    const d = await decide(w, 'lead_x', 'lead-nurture-1', 'lead_nurture')
    assert.equal(d.decision?.eligible && d.decision.basis, 'notice', 'premise: the lead’s own basis is its popup notice')
    assert.equal(d.enrollment, null)
  }
  assert.equal(w.enrollmentsFor().length, 1, 'the send gate creates nothing')
  assert.equal(row.status, 'active')
})

test('own row: the decision’s enrollment is null whenever the only active row belongs to ANOTHER lead — so the confirmation gate can never stop it, and it never anchors person_booked_since', async () => {
  //  A quote-page NOTICE lead with no row of its own; another lead's quote row is outlived.
  const w = world()
  w.addLead('lead_a', { ...OPTED_IN, quotedAt: NOW })
  assert.deepEqual(await ensureQuoteJourney('lead_a', w.deps), { scheduled: true, stages: 3 })
  const row = w.enrollmentsFor('quote_followup')[0]
  createdAgo(row, OUTLIVED_AFTER.quote_followup + 1)
  w.addLead('lead_x', { quotedAt: NOW })
  await w.notice('quote', { leadId: 'lead_x' })

  const d = await decide(w, 'lead_x', 'quote-followup-1', 'quote_followup')
  assert.equal(d.reason, 'enrollment_not_active')
  assert.equal(d.decision?.eligible && d.decision.basis, 'notice', 'premise: a notice decision — the one the confirmation gate acts on')
  assert.equal(d.enrollment, null)
  assert.deepEqual(await leadSendEligibility('lead_x', 'quote-followup-1', QUOTE_SEND, w.stage), NOT_ACTIVE)

  //  Even if a caller ran the gate on that decision with a FAILED confirmation,
  //  there is no row to stop: lead_a's row stays active.
  w.confirmation.set('lead_x', 'failed')
  const gate = await applyConfirmationGate(
    { kind: 'quote_followup', decision: d.decision, enrollment: d.enrollment, stageType: 'quote-followup-1', leadId: 'lead_x', jobData: { leadId: 'lead_x' } },
    w.stage
  )
  assert.deepEqual(gate, { action: 'stop', reason: 'quote_confirmation_failed' })
  assert.deepEqual(w.stoppedByGate, [], 'stopEnrollment was never called')
  assert.equal(row.status, 'active', 'another lead’s row is never stopped by this lead’s gate')

  //  A fresh row for another lead: refused already_enrolled, still no enrollment returned.
  createdAgo(row, HOUR)
  const fresh = await decide(w, 'lead_x', 'quote-followup-1', 'quote_followup')
  assert.equal(fresh.reason, 'already_enrolled')
  assert.equal(fresh.enrollment, null)

  //  EXPRESS past the bound: eligible, with no enrollment and lead_b's OWN capture as the anchor.
  createdAgo(row, OUTLIVED_AFTER.quote_followup + 1)
  w.addLead('lead_b', { ...OPTED_IN, quotedAt: NOW })
  assert.deepEqual(await ensureQuoteJourney('lead_b', w.deps), { scheduled: true, stages: 3 })
  const express = await decide(w, 'lead_b', 'quote-followup-1', 'quote_followup')
  assert.deepEqual([express.reason, express.decision?.eligible && express.decision.basis, express.enrollment], [null, 'express', null])
  assert.equal(
    await applyConfirmationGate({ kind: 'quote_followup', decision: express.decision, enrollment: express.enrollment, stageType: 'quote-followup-1', leadId: 'lead_b', jobData: { leadId: 'lead_b' } }, w.stage),
    null,
    'an express stage never waits'
  )

  //  A booking AFTER lead_a's row but BEFORE lead_b was captured does not stop lead_b…
  const leadB = await w.stage.loadStageLead('lead_b')
  assert.ok(leadB!.createdAt.getTime() > row.createdAt.getTime() + DAY, 'premise: lead_b was captured well after lead_a’s row')
  w.addBooking('bk_between', { createdAt: new Date(leadB!.createdAt.getTime() - DAY) })
  assert.equal((await decide(w, 'lead_b', 'quote-followup-1', 'quote_followup')).reason, null, 'the other row is not the person_booked_since anchor')
  //  …a booking after lead_b's own capture does.
  w.addBooking('bk_after', { createdAt: new Date(leadB!.createdAt.getTime() + 60_000) })
  const booked = await decide(w, 'lead_b', 'quote-followup-1', 'quote_followup')
  assert.equal(booked.reason, 'person_booked_since')
  assert.equal(booked.enrollment, null)
  assert.equal(row.status, 'active')
})
