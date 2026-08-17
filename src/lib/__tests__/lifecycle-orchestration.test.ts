// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE ORCHESTRATION — the behaviour, not the helpers.
//  (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  WHY THIS FILE EXISTS. Every lifecycle bug that reached production was in the
//  ORCHESTRATION, and the orchestration had no tests — it needed a live
//  Postgres and a live Redis to run, so the only things covered were the pure
//  block-reason predicates, which were never wrong.
//
//    • the quote journey got exactly ONE scheduling attempt, ever, so a lead
//      refused for a temporary reason stayed stranded forever;
//    • /api/bookings asked for the customer's consent one step BEFORE the code
//      that writes it, so no new customer could ever enter the recovery
//      sequence;
//    • Step 1 of the booking form stored an explicit opt-in and scheduled
//      nothing at all.
//
//  All three are questions about what happens in what order — "does a booking
//  cancel the nurture?", "does calling this twice duplicate the stages?", "does
//  a recovered sequence arrive all at once?" — and journeys.JourneyDeps now
//  makes them askable offline. The fake below models the real edges honestly:
//  the queue DEDUPLICATES on job id (so a repeat call cannot silently pass a
//  duplication test), and `convertLead` is the only thing that grants a new
//  customer consent (so the ordering bug is detectable, not assumed away).
// ════════════════════════════════════════════════════════════════════════
import './_journeys-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABANDONED_STAGES,
  LEAD_NURTURE_STAGES,
  QUOTE_JOURNEY_MAX_AGE_MS,
  QUOTE_STAGES,
  RECOVERY_STAGE_SPACING_MS,
  ensureQuoteJourney,
  jobIdFor,
  leadNurtureBlockReason,
  onBookingCancelled,
  onBookingCreated,
  onBookingPaid,
  onCheckoutStarted,
  onLeadCaptured,
  onLeadClosed,
  onQuoteCreated,
  planStageTimes,
  quoteFollowupBlockReason,
  repairStrandedQuoteJourneys,
  type JourneyDeps,
  type JourneyLead,
} from '../journeys'
import { CAPS, classifyBlock, inQuietHours, nextAllowedTime } from '../email-guard'
import { bookingBlockReason } from '../email-eligibility'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 11:00 America/New_York — comfortably outside quiet hours. */
const NOW = new Date('2026-08-07T15:00:00.000Z')

const LEAD_ID = 'lead_1'
const EMAIL = 'sam@example.com'

function makeLead(over: Partial<JourneyLead> = {}): JourneyLead {
  return {
    id: LEAD_ID,
    email: EMAIL,
    status: 'NEW',
    quotedAt: null,
    bookedAt: null,
    lostAt: null,
    moveDate: null,
    convertedBookingId: null,
    emailMarketingConsent: true,
    ...over,
  }
}

type Recorded = { stage: string; data: Record<string, unknown>; fireAt: Date }

type Harness = {
  deps: JourneyDeps
  /** The queue. Keyed by job id, exactly like BullMQ — a duplicate add is a
   *  no-op, which is what makes the "called twice" tests meaningful. */
  jobs: Map<string, Recorded>
  cancelled: string[]
  leadTriggers: Array<{ trigger: string; leadId: string }>
  bookingTriggers: Array<{ trigger: string; bookingId: string }>
  stops: Array<{ scope: Record<string, unknown>; reason: string }>
  /** Ordered log of the outward calls, for ordering assertions. */
  calls: string[]
  leads: Map<string, JourneyLead>
  /** email -> tri-state consent on the durable Customer record. */
  customerConsent: Map<string, boolean | null>
  /** Emails with a real prior booking (leads.hasEverBooked). */
  priorCustomers: Set<string>
  /** bookingId -> the customer email it belongs to. */
  bookingCustomer: Map<string, string>
  /** bookingId -> an EARLIER unpaid booking, when one exists. */
  siblings: Map<string, string>
  /** bookingId -> recovery stage emails the send ledger has recorded for it.
   *  The queue side of the evidence is read from `jobs` below, so a sibling
   *  "owns a sequence" here only when one was really scheduled or really sent. */
  ledgerSends: Map<string, number>
  /** Bookings whose recovery evidence cannot be read at all (Redis + Postgres
   *  both down) — the dep returns null, never a zero it cannot support. */
  evidenceUnreadable: Set<string>
  /** Leads the send ledger has already seen a quote stage for. */
  alreadyAttempted: Set<string>
  repairPool: JourneyLead[]
  ledgerThrows: boolean
}

function harness(over: Partial<Pick<Harness, 'leads' | 'customerConsent' | 'priorCustomers' | 'bookingCustomer' | 'siblings' | 'ledgerSends' | 'evidenceUnreadable' | 'alreadyAttempted' | 'repairPool' | 'ledgerThrows'>> = {}): Harness {
  const h: Harness = {
    deps: null as unknown as JourneyDeps,
    jobs: new Map(),
    cancelled: [],
    leadTriggers: [],
    bookingTriggers: [],
    stops: [],
    calls: [],
    leads: over.leads ?? new Map([[LEAD_ID, makeLead()]]),
    customerConsent: over.customerConsent ?? new Map(),
    priorCustomers: over.priorCustomers ?? new Set(),
    bookingCustomer: over.bookingCustomer ?? new Map([['bk_1', EMAIL]]),
    siblings: over.siblings ?? new Map(),
    ledgerSends: over.ledgerSends ?? new Map(),
    evidenceUnreadable: over.evidenceUnreadable ?? new Set(),
    alreadyAttempted: over.alreadyAttempted ?? new Set(),
    repairPool: over.repairPool ?? [],
    ledgerThrows: over.ledgerThrows ?? false,
  }

  h.deps = {
    now: () => NOW,
    async enqueue(stage, data, fireAt, jobId) {
      h.calls.push(`enqueue:${jobId}`)
      // BullMQ ignores an add for a job id that already exists.
      if (!h.jobs.has(jobId)) h.jobs.set(jobId, { stage, data, fireAt })
    },
    async cancel(jobId) {
      h.calls.push(`cancel:${jobId}`)
      h.cancelled.push(jobId)
      h.jobs.delete(jobId)
    },
    async loadLead(leadId) {
      return h.leads.get(leadId) ?? null
    },
    async hasEverBooked(email) {
      return !!email && h.priorCustomers.has(email)
    },
    async bookingMarketingBlock(bookingId) {
      h.calls.push(`consentCheck:${bookingId}`)
      const email = h.bookingCustomer.get(bookingId)
      if (!email) return 'booking_deleted'
      // THE REAL RULE: tri-state, and both false and null refuse.
      return h.customerConsent.get(email) === true ? null : 'no_marketing_consent'
    },
    async siblingUnpaidBooking(bookingId) {
      return h.siblings.get(bookingId) ?? null
    },
    // The REAL edge: the queue is asked for this booking's stage jobs and the
    // send ledger for its stage emails. Modelled off `jobs` so a sibling can
    // only "own a sequence" here if one was actually scheduled (or actually
    // sent) — a status is not evidence, which is the whole of R5.
    async recoverySequenceFor(bookingId) {
      h.calls.push(`recoveryEvidence:${bookingId}`)
      if (h.evidenceUnreadable.has(bookingId)) return null
      return {
        queuedStages: ABANDONED_STAGES.filter((s) => h.jobs.has(jobIdFor('abandoned', s.type, bookingId))).length,
        sentStages: h.ledgerSends.get(bookingId) ?? 0,
      }
    },
    async convertLead(email, bookingId, opts) {
      h.calls.push(`convertLead:${bookingId}`)
      // The canonical consent propagation: an explicit booking-payload value
      // wins, otherwise whatever the matched lead already recorded.
      const lead = Array.from(h.leads.values()).find(
        (l) => (opts.bookingSessionId && l.id === opts.bookingSessionId) || l.email === email
      )
      const effective =
        typeof opts.marketingConsent === 'boolean' ? opts.marketingConsent : lead?.emailMarketingConsent ?? undefined
      if (effective !== undefined && email) h.customerConsent.set(email, effective)
      if (!lead) return null
      lead.bookedAt = NOW
      lead.convertedBookingId = bookingId
      lead.status = 'BOOKED'
      return lead.id
    },
    async loadBookingDates() {
      return null
    },
    async repairCandidates({ quotedSince, limit }) {
      return h.repairPool
        .filter((l) => l.quotedAt && l.quotedAt >= quotedSince)
        .slice(0, limit)
        .map((l) => ({ id: l.id }))
    },
    async leadsAlreadyAttempted(ids) {
      if (h.ledgerThrows) throw new Error('ledger unavailable')
      return new Set(ids.filter((id) => h.alreadyAttempted.has(id)))
    },
    fireLeadTrigger(trigger, leadId) {
      h.leadTriggers.push({ trigger, leadId })
    },
    fireBookingTrigger(trigger, bookingId) {
      h.bookingTriggers.push({ trigger, bookingId })
    },
    stopEnrollments(scope, reason) {
      h.stops.push({ scope: scope as Record<string, unknown>, reason })
    },
  }
  return h
}

const quoteJobIds = (leadId = LEAD_ID) => QUOTE_STAGES.map((s) => jobIdFor('quote', s.type, leadId))
const nurtureJobIds = (leadId = LEAD_ID) => LEAD_NURTURE_STAGES.map((s) => jobIdFor('lead-nurture', s.type, leadId))
const abandonedJobIds = (bookingId = 'bk_1') => ABANDONED_STAGES.map((s) => jobIdFor('abandoned', s.type, bookingId))
const has = (h: Harness, ids: string[]) => ids.every((id) => h.jobs.has(id))
const none = (h: Harness, ids: string[]) => ids.every((id) => !h.jobs.has(id))

// ════════════════════════════════════════════════════════════════════════
//  1-8. QUOTE LIFECYCLE (Sequence A)
// ════════════════════════════════════════════════════════════════════════

test('1. quote + consent → the three quote stages are scheduled', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  const out = await ensureQuoteJourney(LEAD_ID, h.deps)

  assert.deepEqual(out, { scheduled: true, stages: 3 })
  assert.ok(has(h, quoteJobIds()), 'all three stages queued')
  // Anchored on quotedAt, not on "now at each step".
  assert.equal(h.jobs.get(quoteJobIds()[0])!.fireAt.getTime(), NOW.getTime() + 24 * HOUR)
  assert.equal(h.jobs.get(quoteJobIds()[2])!.fireAt.getTime(), NOW.getTime() + 7 * DAY)
})

test('2. quote + NO consent → nothing is scheduled', async () => {
  for (const consent of [null, false] as const) {
    const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW, emailMarketingConsent: consent })]]) })
    const out = await ensureQuoteJourney(LEAD_ID, h.deps)
    assert.deepEqual(out, { scheduled: false, reason: 'no_marketing_consent' }, String(consent))
    assert.equal(h.jobs.size, 0)
  }
})

test('3. THE STRANDED-LEAD BUG: a rollout-gate refusal is retryable, not permanent', async () => {
  // This is the production failure. The lead is quoted while the canary
  // allowlist is narrow; the old code called the scheduler exactly once, on
  // the first stamp, and never looked again.
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })

  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = 'someone-else@moveitclearit.com'
  try {
    const blocked = await ensureQuoteJourney(LEAD_ID, h.deps)
    assert.deepEqual(blocked, { scheduled: false, reason: 'not_in_rollout_allowlist' })
    assert.equal(h.jobs.size, 0, 'nothing queued during the canary')
  } finally {
    delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST
  }

  // The owner widens the rollout. The SAME call now succeeds — no new capture
  // event, no manual intervention, no data change on the lead.
  const recovered = await ensureQuoteJourney(LEAD_ID, h.deps)
  assert.deepEqual(recovered, { scheduled: true, stages: 3 })
  assert.ok(has(h, quoteJobIds()))
})

test('4. calling the quote scheduler twice creates no duplicate stages', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  await ensureQuoteJourney(LEAD_ID, h.deps)
  const first = new Map(h.jobs)
  await ensureQuoteJourney(LEAD_ID, h.deps)
  await ensureQuoteJourney(LEAD_ID, h.deps)

  assert.equal(h.jobs.size, 3, 'still exactly three jobs')
  for (const [id, job] of Array.from(h.jobs.entries())) {
    assert.equal(job.fireAt.getTime(), first.get(id)!.fireAt.getTime(), `${id} kept its original fire time`)
  }
})

test('4b. the quote_created trigger fires ONCE per event, even though scheduling repeats', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  await onQuoteCreated(LEAD_ID, h.deps) // the real transition
  await ensureQuoteJourney(LEAD_ID, h.deps) // a later form save
  await ensureQuoteJourney(LEAD_ID, h.deps) // and another

  assert.deepEqual(h.leadTriggers, [{ trigger: 'quote_created', leadId: LEAD_ID }])
})

test('5. a quote arriving mid-nurture cancels Sequence B and starts Sequence A', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead()]]) })
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.ok(has(h, nurtureJobIds()), 'nurture is running')

  // Now a real quote lands.
  h.leads.get(LEAD_ID)!.quotedAt = NOW
  await ensureQuoteJourney(LEAD_ID, h.deps)

  assert.ok(none(h, nurtureJobIds()), 'the obsolete nurture jobs are gone')
  assert.ok(has(h, quoteJobIds()), 'the quote sequence owns the lead now')
  // And the send-time gate agrees, so a job we failed to remove still dies.
  assert.equal(
    leadNurtureBlockReason({ ...makeLead({ quotedAt: NOW }), previousCustomer: false }, NOW),
    'has_quote'
  )
})

test('6. a booking while Sequence A is queued cancels every stage', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  await ensureQuoteJourney(LEAD_ID, h.deps)
  assert.equal(h.jobs.size, 3)

  await onLeadClosed(LEAD_ID, h.deps)

  assert.ok(none(h, quoteJobIds()), 'quote stages cancelled')
  assert.ok(none(h, nurtureJobIds()), 'nurture stages cancelled too')
  assert.deepEqual(h.stops, [{ scope: { leadId: LEAD_ID }, reason: 'lead_closed' }])
  // ...and the send gate would refuse them anyway.
  assert.equal(quoteFollowupBlockReason(makeLead({ quotedAt: NOW, bookedAt: NOW }), NOW), 'lead_converted')
})

test('7. a withdrawn opt-in blocks a queued Sequence A at send time', async () => {
  // The queue may still hold the job; the send gate is the guarantee.
  assert.equal(
    quoteFollowupBlockReason(makeLead({ quotedAt: NOW, emailMarketingConsent: false }), NOW),
    'no_marketing_consent'
  )
  // A real unsubscribe is a SUPPRESSION, and suppression is terminal.
  assert.equal(classifyBlock('unsubscribed'), 'terminal')
  assert.equal(classifyBlock('marketing_opted_out'), 'terminal')
  // Never having been asked is NOT terminal — a later opt-in must rescue it.
  assert.equal(classifyBlock('no_marketing_consent'), 'retryable')
})

test('8. a PREVIOUS CUSTOMER who asks for a new quote still gets Sequence A — but never Sequence B', async () => {
  // The owner rule, stated as a test so nobody "tidies" it away: a repeat
  // customer must not get the first-time welcome drip, but somebody who
  // deliberately requests a NEW estimate for a NEW move is the most valuable
  // lead the business has and must not be dropped from the follow-up.
  const h = harness({
    leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]),
    priorCustomers: new Set([EMAIL]),
  })

  const a = await ensureQuoteJourney(LEAD_ID, h.deps)
  assert.deepEqual(a, { scheduled: true, stages: 3 }, 'Sequence A runs for a repeat customer')

  h.jobs.clear()
  h.leads.get(LEAD_ID)!.quotedAt = null
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.equal(h.jobs.size, 0, 'Sequence B does not')
  assert.equal(
    leadNurtureBlockReason({ ...makeLead(), previousCustomer: true }, NOW),
    'previous_customer'
  )
})

// ════════════════════════════════════════════════════════════════════════
//  9-13. CONTACT / GENERAL NURTURE (Sequence B)
// ════════════════════════════════════════════════════════════════════════

test('9. a consented non-quote lead enters Sequence B', async () => {
  const h = harness()
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.ok(has(h, nurtureJobIds()))
  assert.equal(h.jobs.get(nurtureJobIds()[0])!.fireAt.getTime(), NOW.getTime() + 4 * HOUR)
})

test('10. a lead with no explicit opt-in gets no Sequence B', async () => {
  for (const consent of [null, false] as const) {
    const h = harness({ leads: new Map([[LEAD_ID, makeLead({ emailMarketingConsent: consent })]]) })
    await onLeadCaptured(LEAD_ID, h.deps)
    assert.equal(h.jobs.size, 0, String(consent))
  }
})

test('11. contact → quick quote: B stops and A takes over (no overlapping copy)', async () => {
  const h = harness()
  await onLeadCaptured(LEAD_ID, h.deps)
  h.leads.get(LEAD_ID)!.quotedAt = NOW
  await onQuoteCreated(LEAD_ID, h.deps)

  const ids = Array.from(h.jobs.keys())
  assert.ok(ids.every((id) => id.includes('__quote__')), `only quote stages remain: ${ids.join(',')}`)
  assert.equal(ids.length, 3)
})

test('12. a lead that already has a real quote can never start Sequence B', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.equal(h.jobs.size, 0)
})

test('13. a previous customer never starts the first-time nurture', async () => {
  const h = harness({ priorCustomers: new Set([EMAIL]) })
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.equal(h.jobs.size, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  14-18. BOOKING STEP 1 (the partial lead)
// ════════════════════════════════════════════════════════════════════════

test('14. Booking Step 1 + consent → the nurture is scheduled (it used to be a dead end)', async () => {
  const h = harness()
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.ok(has(h, nurtureJobIds()), 'a consented Step-1 capture now hears from us')
})

test('15. Booking Step 1 without consent stays completely silent', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ emailMarketingConsent: null })]]) })
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.equal(h.jobs.size, 0)
  assert.equal(h.leadTriggers.length, 0)
})

test('16. Step-1 nurture → booking created → the nurture is cancelled and the booking journey starts', async () => {
  const h = harness()
  await onLeadCaptured(LEAD_ID, h.deps)
  assert.ok(has(h, nurtureJobIds()))

  await onBookingCreated(
    { bookingId: 'bk_1', email: EMAIL, bookingSessionId: LEAD_ID, marketingConsent: true },
    h.deps
  )

  assert.ok(none(h, nurtureJobIds()), '"still thinking about moving?" is gone')
  assert.ok(has(h, abandonedJobIds()), '...and the checkout journey owns them now')
})

test('17. Step-1 nurture → a real quote instead → Sequence A wins', async () => {
  const h = harness()
  await onLeadCaptured(LEAD_ID, h.deps)
  h.leads.get(LEAD_ID)!.quotedAt = NOW
  await ensureQuoteJourney(LEAD_ID, h.deps)

  assert.ok(none(h, nurtureJobIds()))
  assert.ok(has(h, quoteJobIds()))
})

test('18. repeated Step-1 autosaves produce ONE nurture sequence', async () => {
  const h = harness()
  // The booking form fires capture from five triggers.
  for (let i = 0; i < 5; i++) await onLeadCaptured(LEAD_ID, h.deps)
  assert.equal(h.jobs.size, LEAD_NURTURE_STAGES.length)
})

// ════════════════════════════════════════════════════════════════════════
//  19-25. BOOKING / CHECKOUT
// ════════════════════════════════════════════════════════════════════════

test('19. THE ORDERING BUG: a NEW customer who opts in DOES get the abandoned-checkout sequence', async () => {
  // Before the fix, /api/bookings asked for Customer.emailMarketingConsent one
  // step BEFORE markLeadConverted wrote it, so this read `null` for every new
  // customer and the sequence was unreachable for exactly the people it was
  // built for. The harness models that honestly: `bookingMarketingBlock` reads
  // customerConsent, and only `convertLead` writes it.
  const h = harness({ customerConsent: new Map() }) // brand-new customer: nothing stored

  await onBookingCreated(
    { bookingId: 'bk_1', email: EMAIL, bookingSessionId: LEAD_ID, marketingConsent: true },
    h.deps
  )

  assert.ok(has(h, abandonedJobIds()), 'all three recovery stages queued')
  // ...and the order is the reason it worked.
  const convert = h.calls.indexOf('convertLead:bk_1')
  const check = h.calls.indexOf('consentCheck:bk_1')
  assert.ok(convert > -1 && check > convert, `consent is written before it is read: ${h.calls.join(' → ')}`)
})

test('19b. calling onCheckoutStarted on its own, BEFORE propagation, still refuses — the gate is intact', async () => {
  const h = harness({ customerConsent: new Map() })
  await onCheckoutStarted('bk_1', h.deps)
  assert.equal(h.jobs.size, 0, 'no consent on the Customer row means no promotional sequence')
})

test('20. a NEW customer who does not opt in gets no abandoned-checkout sequence', async () => {
  // Explicitly declined...
  const declined = harness({ customerConsent: new Map(), leads: new Map() })
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL, marketingConsent: false }, declined.deps)
  assert.equal(declined.jobs.size, 0, 'explicit decline')

  // ...and never asked at all. Absence of a decision is not permission.
  const silent = harness({ customerConsent: new Map(), leads: new Map() })
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL }, silent.deps)
  assert.equal(silent.jobs.size, 0, 'never asked')
})

test('20b. a form that omits the checkbox does NOT revoke the opt-in given at Step 1', async () => {
  // Deliberate, and worth pinning: consent is EVIDENCE. Somebody who ticked the
  // box on Step 1 and then completed a page that never showed it again has not
  // changed their mind — silence changes nothing (src/lib/consent.ts rule 3).
  const h = harness({ customerConsent: new Map() }) // lead_1 has consent = true
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL, bookingSessionId: LEAD_ID }, h.deps)
  assert.equal(h.customerConsent.get(EMAIL), true, 'the Step-1 opt-in propagates')
  assert.ok(has(h, abandonedJobIds()))
})

test('21. an EXISTING consented customer is eligible without re-ticking anything', async () => {
  const h = harness({
    customerConsent: new Map([[EMAIL, true]]),
    leads: new Map(), // no open lead — most bookings are not from a tracked lead
  })
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL }, h.deps)
  assert.ok(has(h, abandonedJobIds()))
})

test('21b. an existing customer who opted OUT stays blocked, whatever the form omits', async () => {
  const h = harness({ customerConsent: new Map([[EMAIL, false]]), leads: new Map() })
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL }, h.deps)
  assert.equal(h.jobs.size, 0)
})

test('22. paying before the first recovery email cancels all three stages', async () => {
  const h = harness({ customerConsent: new Map([[EMAIL, true]]), leads: new Map() })
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL }, h.deps)
  assert.equal(h.jobs.size, 3)

  await onBookingPaid('bk_1', h.deps)

  assert.equal(h.jobs.size, 0)
  assert.deepEqual(h.stops, [{ scope: { bookingId: 'bk_1' }, reason: 'deposit_paid' }])
})

test('23. paying BETWEEN stages cancels the remainder — and the send gate agrees', async () => {
  const h = harness({ customerConsent: new Map([[EMAIL, true]]), leads: new Map() })
  await onBookingCreated({ bookingId: 'bk_1', email: EMAIL }, h.deps)
  // Stage 1 has already fired and left the queue.
  h.jobs.delete(abandonedJobIds()[0])

  await onBookingPaid('bk_1', h.deps)
  assert.equal(h.jobs.size, 0, 'stages 2 and 3 are gone')

  for (const t of ['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3']) {
    assert.equal(
      bookingBlockReason(t, {
        status: 'PENDING_PAYMENT',
        isInternalTest: false,
        depositPaid: true,
        completedAt: null,
        requestedDate: null,
        confirmedDate: null,
        scheduledStart: null,
        customerMarketingConsent: true,
        customerMarketingOptOut: false,
      }, NOW),
      'deposit_already_paid',
      t
    )
  }
})

test('24. after a booking, no prospect sequence can coexist with the checkout sequence', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  await ensureQuoteJourney(LEAD_ID, h.deps)
  h.leads.get(LEAD_ID)!.quotedAt = null
  await onLeadCaptured(LEAD_ID, h.deps) // (refused — but assert the end state)
  h.leads.get(LEAD_ID)!.quotedAt = NOW

  await onBookingCreated(
    { bookingId: 'bk_1', email: EMAIL, bookingSessionId: LEAD_ID, marketingConsent: true },
    h.deps
  )

  const remaining = Array.from(h.jobs.keys())
  assert.ok(
    remaining.every((id) => id.includes('__abandoned__')),
    `only the checkout journey survives: ${remaining.join(',')}`
  )
})

test('25. a double-submitted booking form does not produce a second recovery sequence', async () => {
  const h = harness({
    customerConsent: new Map([[EMAIL, true]]),
    leads: new Map(),
    bookingCustomer: new Map([['bk_1', EMAIL], ['bk_2', EMAIL]]),
    siblings: new Map([['bk_2', 'bk_1']]), // bk_2 was created moments after bk_1
  })

  await onCheckoutStarted('bk_1', h.deps)
  await onCheckoutStarted('bk_2', h.deps)

  assert.equal(h.jobs.size, 3, 'one sequence, not two')
  assert.ok(has(h, abandonedJobIds('bk_1')))
  assert.ok(none(h, abandonedJobIds('bk_2')))
  // The booking_started automation trigger still fires for BOTH — the booking
  // is real, and stopping the trigger would hide it from the owner.
  assert.equal(h.bookingTriggers.filter((t) => t.trigger === 'booking_started').length, 2)
})

test('25b. two genuinely separate moves each keep their own sequence', async () => {
  const h = harness({
    customerConsent: new Map([[EMAIL, true]]),
    leads: new Map(),
    bookingCustomer: new Map([['bk_1', EMAIL], ['bk_2', EMAIL]]),
    siblings: new Map(), // no sibling inside the window
  })
  await onCheckoutStarted('bk_1', h.deps)
  await onCheckoutStarted('bk_2', h.deps)
  assert.equal(h.jobs.size, 6)
})

// ════════════════════════════════════════════════════════════════════════
//  26-32. SUPPRESSION, CAPS, QUIET HOURS
// ════════════════════════════════════════════════════════════════════════

test('26-28. suppression reasons are TERMINAL — a queued job can never resurrect them', () => {
  for (const reason of ['unsubscribed', 'hard_bounce', 'spam_complaint', 'invalid_address', 'invalid_email']) {
    assert.equal(classifyBlock(reason), 'terminal', reason)
  }
})

test('29. a declined or lost lead is blocked in BOTH sequences', () => {
  assert.equal(quoteFollowupBlockReason(makeLead({ quotedAt: NOW, lostAt: NOW }), NOW), 'lead_lost')
  assert.equal(leadNurtureBlockReason({ ...makeLead({ lostAt: NOW }), previousCustomer: false }, NOW), 'lead_lost')
  for (const status of ['WON', 'LOST', 'BOOKED', 'CONVERTED']) {
    assert.equal(quoteFollowupBlockReason(makeLead({ quotedAt: NOW, status }), NOW), `lead_status:${status}`)
  }
})

test('30. a passed move date blocks the send AND drops the stage at schedule time', async () => {
  const past = new Date(NOW.getTime() - 3 * DAY)
  assert.equal(quoteFollowupBlockReason(makeLead({ quotedAt: NOW, moveDate: past }), NOW), 'move_date_passed')

  // ...and a stage that would land after the move is never queued at all.
  // Move in 36h ⇒ the cutoff (move + 1 day) is 60h out: the +24h stage lands
  // before it, the +3d and +7d stages do not.
  const soon = new Date(NOW.getTime() + 36 * HOUR)
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW, moveDate: soon })]]) })
  const out = await ensureQuoteJourney(LEAD_ID, h.deps)
  assert.deepEqual(out, { scheduled: true, stages: 1 }, 'only the +24h stage lands before the move')
  assert.ok(h.jobs.has(quoteJobIds()[0]))
  assert.ok(!h.jobs.has(quoteJobIds()[1]))
  assert.ok(!h.jobs.has(quoteJobIds()[2]))
})

test('31. frequency caps are configured and classified as deferrals, never losses', () => {
  assert.equal(CAPS.perDay, 1)
  assert.equal(CAPS.perWeek, 3)
  assert.equal(CAPS.perMonth, 6)
  for (const r of ['cap_daily', 'cap_weekly', 'cap_monthly']) assert.equal(classifyBlock(r), 'deferred')
})

test('32. quiet hours defer rather than drop, and scheduling walks forward out of them', () => {
  assert.equal(classifyBlock('quiet_hours'), 'deferred')
  const threeAmEt = new Date('2026-08-07T07:00:00.000Z')
  assert.ok(inQuietHours(threeAmEt))
  assert.ok(!inQuietHours(NOW))
  assert.ok(!inQuietHours(nextAllowedTime(threeAmEt)), 'nextAllowedTime lands outside the quiet window')
})

// ════════════════════════════════════════════════════════════════════════
//  RECOVERY MECHANICS — staggering, staleness, and the repair sweep
// ════════════════════════════════════════════════════════════════════════

test('a recovered sequence is still a SEQUENCE — overdue stages do not arrive at once', () => {
  const anchor = NOW.getTime() - 5 * DAY // stages 1 and 2 are long overdue
  const plan = planStageTimes(QUOTE_STAGES, anchor, { now: NOW.getTime() })

  assert.equal(plan[0].fireAt, NOW.getTime(), 'the first overdue stage goes now')
  assert.equal(plan[1].fireAt, NOW.getTime() + RECOVERY_STAGE_SPACING_MS, 'the second waits a day')
  assert.equal(plan[2].fireAt, anchor + 7 * DAY, 'a stage still in the future keeps its own time')
  assert.deepEqual(plan.map((p) => p.overdue), [true, true, false])
})

test('an on-time enrolment never touches the recovery stagger', () => {
  const plan = planStageTimes(QUOTE_STAGES, NOW.getTime(), { now: NOW.getTime() })
  assert.deepEqual(
    plan.map((p) => p.fireAt),
    QUOTE_STAGES.map((s) => NOW.getTime() + s.delay)
  )
  assert.ok(plan.every((p) => !p.overdue))
  // Sequence B's designed 4h→24h gap is under the recovery spacing; an
  // on-time plan must keep it exactly (the min-gap rule is recovery-only).
  const nurture = planStageTimes(LEAD_NURTURE_STAGES, NOW.getTime(), { now: NOW.getTime() })
  assert.deepEqual(
    nurture.map((p) => p.fireAt),
    LEAD_NURTURE_STAGES.map((s) => NOW.getTime() + s.delay)
  )
})

test('a recovered plan can NEVER compress into a burst — every gap keeps the full spacing', () => {
  // The owner's hard rule: it is fine for a repair sweep to CREATE all three
  // jobs in one pass; it is not fine for the customer to RECEIVE overdue
  // emails bunched together. The nasty case is a sweep on day 6: stage 2 is
  // staggered to now+24h, and stage 3's own natural time is only hours after
  // that. Without the min-gap rule they land ~7h apart.
  const anchor = NOW.getTime() - 6 * DAY
  const plan = planStageTimes(QUOTE_STAGES, anchor, { now: NOW.getTime() })
  assert.equal(plan[0].fireAt, NOW.getTime())
  assert.equal(plan[1].fireAt, NOW.getTime() + RECOVERY_STAGE_SPACING_MS)
  for (let i = 1; i < plan.length; i++) {
    assert.ok(
      plan[i].fireAt - plan[i - 1].fireAt >= RECOVERY_STAGE_SPACING_MS,
      `gap ${i} is ${(plan[i].fireAt - plan[i - 1].fireAt) / HOUR}h — must be >= 24h`
    )
  }
})

test('a stale quote is refused rather than drip-fed weeks late', async () => {
  const ancient = new Date(NOW.getTime() - QUOTE_JOURNEY_MAX_AGE_MS - DAY)
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: ancient })]]) })
  const out = await ensureQuoteJourney(LEAD_ID, h.deps)
  assert.deepEqual(out, { scheduled: false, reason: 'quote_too_old' })
  assert.equal(h.jobs.size, 0)
})

test('the repair sweep rescues a stranded lead and reports what it did', async () => {
  const stranded = makeLead({ id: 'lead_stranded', quotedAt: new Date(NOW.getTime() - 2 * DAY) })
  const h = harness({
    leads: new Map([['lead_stranded', stranded]]),
    repairPool: [stranded],
  })

  const report = await repairStrandedQuoteJourneys({}, h.deps)

  assert.equal(report.candidates, 1)
  assert.equal(report.scheduled, 1)
  assert.equal(report.alreadyAttempted, 0)
  assert.ok(has(h, quoteJobIds('lead_stranded')))
})

test('the repair sweep leaves a journey the send layer has already seen alone', async () => {
  const done = makeLead({ id: 'lead_done', quotedAt: new Date(NOW.getTime() - 2 * DAY) })
  const h = harness({
    leads: new Map([['lead_done', done]]),
    repairPool: [done],
    alreadyAttempted: new Set(['lead_done']),
  })

  const report = await repairStrandedQuoteJourneys({}, h.deps)

  assert.equal(report.alreadyAttempted, 1)
  assert.equal(report.scheduled, 0)
  assert.equal(h.jobs.size, 0, 'a finished journey is not re-enrolled every hour')
})

test('the repair sweep FAILS CLOSED when it cannot read the send ledger', async () => {
  const stranded = makeLead({ id: 'lead_x', quotedAt: new Date(NOW.getTime() - 2 * DAY) })
  const h = harness({ leads: new Map([['lead_x', stranded]]), repairPool: [stranded], ledgerThrows: true })

  const report = await repairStrandedQuoteJourneys({}, h.deps)

  assert.equal(report.scheduled, 0)
  assert.equal(h.jobs.size, 0, 'without the ledger we cannot tell stranded from finished — so we do nothing')
})

test('the repair sweep still applies the full eligibility matrix to every candidate', async () => {
  // A candidate that has since booked must not be re-enrolled even if the
  // candidate query is stale by a few milliseconds.
  const booked = makeLead({ id: 'lead_b', quotedAt: NOW, bookedAt: NOW })
  const h = harness({ leads: new Map([['lead_b', booked]]), repairPool: [booked] })

  const report = await repairStrandedQuoteJourneys({}, h.deps)

  assert.equal(report.scheduled, 0)
  assert.deepEqual(report.refused, { lead_converted: 1 })
})

// ════════════════════════════════════════════════════════════════════════
//  CANCELLATION SAFETY — could a stop ever kill a legitimate newer journey?
// ════════════════════════════════════════════════════════════════════════

test('cancelling a booking removes only that booking\'s jobs, never another journey', async () => {
  const h = harness({
    customerConsent: new Map([[EMAIL, true]]),
    leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]),
    bookingCustomer: new Map([['bk_1', EMAIL], ['bk_2', EMAIL]]),
  })
  await onCheckoutStarted('bk_1', h.deps)
  await onCheckoutStarted('bk_2', h.deps)

  await onBookingCancelled('bk_1', h.deps)

  assert.ok(none(h, abandonedJobIds('bk_1')))
  assert.ok(has(h, abandonedJobIds('bk_2')), 'the other booking is untouched')
})

test('the nurture supersede only ever removes lead-nurture ids, never quote ids', async () => {
  const h = harness({ leads: new Map([[LEAD_ID, makeLead({ quotedAt: NOW })]]) })
  await ensureQuoteJourney(LEAD_ID, h.deps)
  const beforeCancels = h.cancelled.length
  await ensureQuoteJourney(LEAD_ID, h.deps)

  const newCancels = h.cancelled.slice(beforeCancels)
  assert.ok(newCancels.every((id) => id.includes('__lead-nurture__')), newCancels.join(','))
  assert.equal(h.jobs.size, 3, 'the quote stages survived the second pass')
})
