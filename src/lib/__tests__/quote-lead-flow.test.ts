// ════════════════════════════════════════════════════════════════════════
//  quote-lead-flow.test.ts — the quick quote, end to end, offline.
//
//  WHY THIS FILE EXISTS. The quick-quote capture chain had NO tests. It also
//  had a bug that made the entire chain a no-op in production: CAPTURE_SELECT
//  asked Prisma for `pickupZip`, a column that does not exist (it is
//  `originZip`), so `findUnique` threw on every submission, the throw was
//  swallowed by onQuoteRequestCaptured's own catch, and the endpoint answered
//  `ok:true, captured:true, emailStatus:'unavailable'` while queueing nothing —
//  no confirmation email, no owner card, no tracking columns, for months.
//
//  Nothing here touches Postgres, Redis, Resend or Discord. The effectful edge
//  is QuoteCaptureDeps (a fake below), and the promotional runtime is
//  reproduced by a fake that calls the REAL consent rule (mayEnrollLeadSubject)
//  and the REAL dedupe key (enrollmentDedupeKey) — so the two properties that
//  actually protect people are tested, not mocked away.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  onQuoteRequestCaptured,
  resendQuoteConfirmation,
  quoteLeadTriggerSnapshot,
  type CaptureLead,
  type ConfirmationEmailJob,
  type QuoteCaptureDeps,
} from '../quote-capture'
import {
  mayEnrollLeadSubject,
  enrollmentDedupeKey,
  type LeadTriggerResult,
} from '../email-automation-runtime'
import {
  capturePartialLead,
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  type ExistingPartialLead,
  type LeadRecord,
  type PartialLeadDeps,
  type PartialLeadStore,
} from '../leads'
import type { LeadCardData } from '../booking-display'

const NOW = new Date('2026-08-05T17:28:00.000Z')

// ════════════════════════════════════════════════════════════════════════
//  Fakes
// ════════════════════════════════════════════════════════════════════════

/** The lead as the capture side effects see it. Overridable per test. */
function captureLead(over: Partial<CaptureLead> = {}): CaptureLead {
  return {
    id: 'lead_1',
    name: 'Sam Rivera',
    email: 'customer@example.com',
    phone: '5555550142',
    estimatedValue: 87900,
    moveDate: new Date('2026-08-28T00:00:00.000Z'),
    moveSize: '2br',
    zip: null,
    originZip: '07050',
    destinationZip: '07050',
    emailMarketingConsent: true,
    originCity: null,
    destCity: null,
    contactPreference: 'call_asap',
    bestTimeToCall: null,
    formStep: 'quote',
    source: 'QUICK_QUOTE_FORM',
    referrer: null,
    landingPage: null,
    utmSource: null,
    utmCampaign: null,
    quoteConfirmationQueuedAt: null,
    quoteConfirmationCount: 0,
    quoteConfirmationStatus: null,
    alertFingerprint: null,
    lastAlertedAt: null,
    ...over,
  }
}

type Recorder = {
  emails: ConfirmationEmailJob[]
  cards: LeadCardData[]
  directNotices: string[]
  triggers: Array<{ leadId: string; snapshot: Record<string, unknown> }>
  enrollments: Set<string>
  lead: CaptureLead
}

/**
 * A fake promotional runtime that behaves like fireLeadTrigger: it applies the
 * REAL consent rule and the REAL unique dedupe key. `AUTOMATION_ID`/`VERSION`
 * stand in for one ACTIVE automation on `lead_created`.
 */
const AUTOMATION_ID = 'auto_1'
const VERSION = 1

function makeDeps(
  lead: CaptureLead,
  over: Partial<QuoteCaptureDeps> = {}
): { deps: QuoteCaptureDeps; rec: Recorder } {
  const rec: Recorder = {
    emails: [],
    cards: [],
    directNotices: [],
    triggers: [],
    enrollments: new Set<string>(),
    lead,
  }

  const deps: QuoteCaptureDeps = {
    now: () => NOW,
    async loadLead(id) {
      return id === rec.lead.id ? rec.lead : null
    },
    async claimConfirmation({ force, claimedAt, nextCount }) {
      // The real predicate: claim only when nothing is queued yet (or forced).
      if (!force && rec.lead.quoteConfirmationQueuedAt !== null) return 0
      rec.lead = {
        ...rec.lead,
        quoteConfirmationQueuedAt: claimedAt,
        quoteConfirmationCount: nextCount,
        quoteConfirmationStatus: 'queued',
      }
      return 1
    },
    async releaseConfirmation({ claimedAt, nextCount, previousQueuedAt, previousCount }) {
      if (
        rec.lead.quoteConfirmationQueuedAt?.getTime() !== claimedAt.getTime() ||
        rec.lead.quoteConfirmationCount !== nextCount
      ) {
        return 0
      }
      rec.lead = {
        ...rec.lead,
        quoteConfirmationQueuedAt: previousQueuedAt,
        quoteConfirmationCount: previousCount,
        quoteConfirmationStatus: previousQueuedAt ? 'queued' : null,
      }
      return 1
    },
    async claimAlert({ fingerprint, claimedAt }) {
      if (rec.lead.alertFingerprint === fingerprint) return 0
      rec.lead = { ...rec.lead, alertFingerprint: fingerprint, lastAlertedAt: claimedAt }
      return 1
    },
    async releaseAlert({ fingerprint, claimedAt, previousFingerprint, previousAlertedAt }) {
      if (
        rec.lead.alertFingerprint !== fingerprint ||
        rec.lead.lastAlertedAt?.getTime() !== claimedAt.getTime()
      ) {
        return 0
      }
      rec.lead = { ...rec.lead, alertFingerprint: previousFingerprint, lastAlertedAt: previousAlertedAt }
      return 1
    },
    async enqueueConfirmationEmail(job) {
      rec.emails.push(job)
    },
    async enqueueLeadCard(payload) {
      rec.cards.push(payload)
    },
    async postLeadNoticeDirect(l) {
      rec.directNotices.push(l.id)
      return true
    },
    async fireLeadCreated(leadId, snapshot): Promise<LeadTriggerResult> {
      rec.triggers.push({ leadId, snapshot })
      // THE REAL RULE, not a stub: consent is required to enroll.
      const verdict = mayEnrollLeadSubject({
        email: rec.lead.email,
        emailMarketingConsent: rec.lead.emailMarketingConsent,
      })
      if (!verdict.allow) return { status: 'skipped', reason: verdict.reason }
      // THE REAL KEY: one enrollment per automation version per subject.
      const key = enrollmentDedupeKey(AUTOMATION_ID, VERSION, { email: rec.lead.email ?? '', leadId })
      if (rec.enrollments.has(key)) return { status: 'enrolled', count: 0 }
      rec.enrollments.add(key)
      return { status: 'enrolled', count: 1 }
    },
    ...over,
  }
  return { deps, rec }
}

/** In-memory PartialLeadStore — the same shape leads-partial.test.ts uses. */
function makeLeadStore(): { deps: PartialLeadDeps; rows: ExistingPartialLead[] } {
  const rows: ExistingPartialLead[] = []
  let n = 0
  const store: PartialLeadStore = {
    async findBySessionId(sessionId) {
      return rows.find((r) => r.bookingSessionId === sessionId) ?? null
    },
    async findOpenPartialByEmail(email) {
      return rows.find((r) => r.email === email) ?? null
    },
    async create(data): Promise<LeadRecord> {
      const row = { id: `lead_${++n}`, ...(data as unknown as Record<string, unknown>) } as unknown as ExistingPartialLead
      rows.push(row)
      return { id: row.id, status: row.status }
    },
    async update(id, data): Promise<LeadRecord> {
      const i = rows.findIndex((r) => r.id === id)
      rows[i] = { ...rows[i], ...(data as unknown as Record<string, unknown>) } as ExistingPartialLead
      return { id, status: rows[i].status }
    },
  }
  return { deps: { store, now: () => NOW }, rows }
}

const QUOTE_INPUT = {
  email: 'Customer@Example.com',
  firstName: 'Sam',
  lastName: 'Rivera',
  phone: '5555550142',
  bookingSessionId: 'sess-quote-1',
  formStep: 'quote',
  source: 'QUICK_QUOTE_FORM',
  consentSource: 'QUICK_QUOTE_FORM',
  consentVersion: '2026-07-v1',
  moveSize: '2br',
  pickupZip: '07050',
  destinationZip: '07050',
  estimatedValue: 87900,
}

// ════════════════════════════════════════════════════════════════════════
//  1-3. THE LEAD ITSELF
// ════════════════════════════════════════════════════════════════════════

test('1. a valid quick-quote submission saves the lead', async () => {
  const { deps, rows } = makeLeadStore()
  const res = await capturePartialLead({ ...QUOTE_INPUT, marketingConsent: true }, deps)
  assert.ok(res, 'the lead must be persisted')
  assert.equal(res.isNew, true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].email, 'customer@example.com', 'email is normalised on the way in')
  assert.equal((rows[0] as unknown as { name: string }).name, 'Sam Rivera')
})

test('2. the source is recorded as QUICK_QUOTE_FORM', () => {
  const row = buildPartialLeadCreate({ ...QUOTE_INPUT, marketingConsent: true }, NOW)
  assert.equal(row.source, 'QUICK_QUOTE_FORM')
  // The browser may send other casings; all resolve to the same enum value.
  assert.equal(buildPartialLeadCreate({ ...QUOTE_INPUT, source: 'quick_quote_form' }, NOW).source, 'QUICK_QUOTE_FORM')
  assert.equal(buildPartialLeadCreate({ ...QUOTE_INPUT, source: 'quick-quote-form' }, NOW).source, 'QUICK_QUOTE_FORM')
})

test('3. marketing consent is saved accurately, and TRI-STATE is preserved', () => {
  const optedIn = buildPartialLeadCreate({ ...QUOTE_INPUT, marketingConsent: true }, NOW)
  assert.equal(optedIn.emailMarketingConsent, true)
  assert.equal(optedIn.marketingConsentAt, NOW)
  assert.equal(optedIn.marketingConsentSource, 'QUICK_QUOTE_FORM', 'a quote opt-in must not be filed under BOOKING_FORM')
  assert.equal(optedIn.marketingConsentVersion, '2026-07-v1', 'consent evidence needs the disclosure version')

  const declined = buildPartialLeadCreate({ ...QUOTE_INPUT, marketingConsent: false }, NOW)
  assert.equal(declined.emailMarketingConsent, false)

  const neverAsked = buildPartialLeadCreate({ ...QUOTE_INPUT, marketingConsent: undefined }, NOW)
  assert.equal(neverAsked.emailMarketingConsent, null, 'never asked is null, never false')
  assert.equal(neverAsked.marketingConsentSource, null)

  // An untouched checkbox on a LATER submission leaves a stored decision alone.
  const existing = { id: 'l1', emailMarketingConsent: true } as unknown as ExistingPartialLead
  const patch = buildPartialLeadUpdate(existing, { ...QUOTE_INPUT, marketingConsent: undefined }, NOW, 'session')
  assert.ok(!('emailMarketingConsent' in patch), 'silence must not rewrite consent')
})

// ════════════════════════════════════════════════════════════════════════
//  4-6. THE SIDE EFFECTS
// ════════════════════════════════════════════════════════════════════════

test('4. the quote confirmation email is queued, with the customer-facing payload', async () => {
  const { deps, rec } = makeDeps(captureLead())
  const out = await onQuoteRequestCaptured('lead_1', { locale: 'en' }, deps)

  assert.equal(out.emailStatus, 'queued')
  assert.equal(rec.emails.length, 1)
  const job = rec.emails[0]
  assert.equal(job.template, 'quote-request-received')
  assert.equal(job.to, 'customer@example.com')
  assert.equal(job.leadId, 'lead_1')
  assert.equal(job.businessEventKey, 'lead:lead_1:quote-request-received:v1')
  assert.equal(job.payload.firstName, 'Sam')
  assert.equal(job.payload.estimatedPrice, '$879', 'the SERVER total, formatted for a human')
  assert.equal(job.payload.moveSize, '2 Bedrooms', 'the label, never the internal key')
})

test('5. the confirmation tracking fields are updated (claim + version)', async () => {
  const { deps, rec } = makeDeps(captureLead())
  await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.deepEqual(rec.lead.quoteConfirmationQueuedAt, NOW, 'quoteConfirmationQueuedAt must be stamped')
  assert.equal(rec.lead.quoteConfirmationCount, 1, 'quoteConfirmationCount must advance')
  assert.equal(rec.lead.quoteConfirmationStatus, 'queued')
})

test('6. the Discord lead card is still queued, with the lead facts on it', async () => {
  const { deps, rec } = makeDeps(captureLead())
  const out = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(out.notificationStatus, 'queued')
  assert.equal(rec.cards.length, 1)
  assert.equal(rec.cards[0].leadId, 'lead_1')
  assert.equal(rec.cards[0].estimateDollars, 879)
  assert.equal(rec.cards[0].moveSize, '2 Bedrooms')
  assert.equal(rec.cards[0].pickup, '07050', 'the pickup zip comes from originZip — the column that exists')
  assert.equal(rec.cards[0].isUpdate, false)
  assert.equal(rec.directNotices.length, 0, 'no plain notice when the queue accepted the card')
})

test('6b. a dead queue falls back to the direct notice, so the owner never loses the lead', async () => {
  const { deps, rec } = makeDeps(captureLead(), {
    async enqueueLeadCard() {
      throw new Error('ECONNREFUSED redis')
    },
  })
  const out = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(rec.directNotices.length, 1, 'the owner still gets told')
  assert.equal(out.notificationStatus, 'queued')
  assert.equal(out.notificationReason, 'direct_fallback')
  assert.equal(rec.lead.alertFingerprint, null, 'a released claim must leave no evidence of a card that never existed')
})

// ════════════════════════════════════════════════════════════════════════
//  7-9. MARKETING vs TRANSACTIONAL
// ════════════════════════════════════════════════════════════════════════

test('7. lead_created fires for a CONSENTED lead, carrying segmentation facts', async () => {
  const { deps, rec } = makeDeps(captureLead({ emailMarketingConsent: true }))
  const out = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(out.automation?.status, 'enrolled')
  assert.equal(rec.enrollments.size, 1)
  const snap = rec.triggers[0].snapshot
  assert.equal(snap.leadId, 'lead_1')
  assert.equal(snap.email, 'customer@example.com')
  assert.equal(snap.firstName, 'Sam')
  assert.equal(snap.source, 'QUICK_QUOTE_FORM')
  assert.equal(snap.estimatedValueCents, 87900)
  assert.equal(snap.estimatedValueDollars, 879)
  assert.equal(snap.moveDate, '2026-08-28T00:00:00.000Z')
  assert.equal(snap.pickupZip, '07050')
  assert.equal(snap.destinationZip, '07050')
  assert.equal(snap.marketingConsent, true)
})

test('8. a lead WITHOUT consent never enters promotional automation', async () => {
  for (const consent of [null, false] as const) {
    const { deps, rec } = makeDeps(captureLead({ emailMarketingConsent: consent }))
    const out = await onQuoteRequestCaptured('lead_1', {}, deps)
    assert.equal(out.automation?.status, 'skipped', `consent=${String(consent)} must not enroll`)
    assert.equal(rec.enrollments.size, 0)
  }
  // The rule itself, stated once and tested directly.
  assert.equal(mayEnrollLeadSubject({ email: 'a@b.co', emailMarketingConsent: true }).allow, true)
  assert.deepEqual(mayEnrollLeadSubject({ email: 'a@b.co', emailMarketingConsent: null }), {
    allow: false,
    reason: 'no_consent',
  })
  assert.deepEqual(mayEnrollLeadSubject({ email: 'a@b.co', emailMarketingConsent: false }), {
    allow: false,
    reason: 'no_consent',
  })
  assert.deepEqual(mayEnrollLeadSubject({ email: '', emailMarketingConsent: true }), {
    allow: false,
    reason: 'no_email',
  })
  assert.deepEqual(mayEnrollLeadSubject({ email: 'a@b.co', emailMarketingConsent: true, suppressed: true }), {
    allow: false,
    reason: 'suppressed',
  })
})

test('9. a lead without consent STILL gets the transactional confirmation email', async () => {
  const { deps, rec } = makeDeps(captureLead({ emailMarketingConsent: null }))
  const out = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(out.emailStatus, 'queued', 'asking for an estimate earns you the estimate')
  assert.equal(rec.emails.length, 1)
  assert.equal(out.automation?.status, 'skipped')
})

// ════════════════════════════════════════════════════════════════════════
//  10-12. REPEATS AND FAILURES
// ════════════════════════════════════════════════════════════════════════

test('10. duplicate submissions produce ONE email and ONE enrollment', async () => {
  const { deps, rec } = makeDeps(captureLead())

  const first = await onQuoteRequestCaptured('lead_1', {}, deps)
  const second = await onQuoteRequestCaptured('lead_1', {}, deps)
  const third = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(first.emailStatus, 'queued')
  assert.equal(second.emailStatus, 'already_queued')
  assert.equal(third.emailStatus, 'already_queued')
  assert.equal(rec.emails.length, 1, 'exactly one confirmation email')
  assert.equal(rec.lead.quoteConfirmationCount, 1, 'the version does not creep on repeats')

  assert.equal(rec.cards.length, 1, 'no owner card without a meaningful change')
  assert.equal(second.notificationStatus, 'already_queued')

  assert.equal(rec.triggers.length, 3, 'the trigger is re-fired — consent can arrive on a later edit')
  assert.equal(rec.enrollments.size, 1, 'and the unique dedupe key collapses it to one enrollment')

  // The owner's manual resend is the one path that deliberately sends again,
  // under a NEW version so the send guard lets it through.
  const resend = await resendQuoteConfirmation('lead_1', {}, deps)
  assert.equal(resend.ok, true)
  assert.equal(resend.version, 2)
  assert.equal(rec.emails.length, 2)
  assert.equal(rec.emails[1].businessEventKey, 'lead:lead_1:quote-request-received:v2')
})

test('10b. a repeat submission with CHANGED facts re-alerts the owner exactly once', async () => {
  const { deps, rec } = makeDeps(captureLead())
  await onQuoteRequestCaptured('lead_1', {}, deps)
  assert.equal(rec.cards.length, 1)

  // The customer moves their date — a fact that changes how the owner calls it.
  rec.lead = { ...rec.lead, moveDate: new Date('2026-09-04T00:00:00.000Z') }
  await onQuoteRequestCaptured('lead_1', {}, deps)
  assert.equal(rec.cards.length, 2)
  assert.equal(rec.cards[1].isUpdate, true)
  assert.equal(rec.emails.length, 1, 'a changed date is not a reason to re-email the customer')
})

test('11. an email-queue failure loses neither the lead nor the owner card', async () => {
  const { deps, rec } = makeDeps(captureLead(), {
    async enqueueConfirmationEmail() {
      throw new Error('provider unavailable')
    },
  })
  const out = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(out.emailStatus, 'unavailable')
  assert.equal(out.emailReason, 'enqueue_failed')
  // The claim is RELEASED, so a later retry can still send it.
  assert.equal(rec.lead.quoteConfirmationQueuedAt, null)
  assert.equal(rec.lead.quoteConfirmationCount, 0)
  assert.equal(rec.lead.quoteConfirmationStatus, null)
  // And the rest of the flow is untouched.
  assert.equal(rec.cards.length, 1, 'the owner is still told about the lead')
  assert.equal(out.automation?.status, 'enrolled')
})

test('12. an automation-trigger failure changes nothing else', async () => {
  const { deps, rec } = makeDeps(captureLead(), {
    async fireLeadCreated() {
      throw new Error('automation table on fire')
    },
  })
  const out = await onQuoteRequestCaptured('lead_1', {}, deps)

  assert.equal(out.emailStatus, 'queued', 'the customer still gets their estimate')
  assert.equal(out.notificationStatus, 'queued', 'the owner still gets the card')
  assert.equal(out.automation?.status, 'unavailable')
  assert.equal(rec.emails.length, 1)
  assert.equal(rec.cards.length, 1)
})

test('12b. a lead that vanished between capture and side effects fails soft', async () => {
  const { deps, rec } = makeDeps(captureLead())
  const out = await onQuoteRequestCaptured('lead_gone', {}, deps)
  assert.equal(out.emailStatus, 'unavailable')
  assert.equal(out.emailReason, 'lead_not_found')
  assert.equal(rec.emails.length, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  13. INVALID SUBMISSIONS
// ════════════════════════════════════════════════════════════════════════

const ROUTE = resolve(__dirname, '../../../app/api/leads/quote-capture/route.ts')
const routeSrc = () => readFileSync(ROUTE, 'utf8')

test('13. an incomplete submission creates NO record', async () => {
  const { deps, rows } = makeLeadStore()
  // No email and no session id: there is nothing to key a person on.
  assert.equal(await capturePartialLead({ firstName: 'Ghost' }, deps), null)
  // A session id alone is not a person either.
  assert.equal(await capturePartialLead({ bookingSessionId: 'sess-x' }, deps), null)
  assert.equal(rows.length, 0, 'no half-rows in the CRM')
})

test('13b. the route rejects invalid payloads with the right status and leaks nothing', () => {
  const s = routeSrc()
  assert.match(s, /error: 'validation_error' \}, 400\)/, 'unparseable JSON -> 400')
  assert.match(s, /error: 'validation_error', fields \}, 422\)/, 'schema failure -> 422 with field NAMES')
  assert.match(s, /error: 'rate_limited' \}, 429\)/, 'rate limited -> 429')
  assert.match(s, /firstName: z\.string\(\)/, 'contact block is required server-side')
  assert.match(s, /email: z\.string\(\)[\s\S]{0,120}\.email\(\)/, 'email is validated as an email')
  // Only our own field NAMES may be returned — never a submitted value.
  assert.match(s, /Object\.keys\(parsed\.error\.flatten\(\)\.fieldErrors\)/)
  assert.ok(!/error: (err|String\(err\)|errText)/.test(s), 'no raw error text in a response')
})

test('13c. the route hands the owner-notification to quote-capture (no double ping)', () => {
  const s = routeSrc()
  assert.match(s, /\{ notifyOwner: false \}/, 'capture must not also post the plain notice')
  assert.match(s, /onQuoteRequestCaptured\(result\.lead\.id/, 'the rich card comes from the side-effect module')
  assert.match(s, /normaliseConsentSource\(d\.consentSource\) \?\? 'QUICK_QUOTE_FORM'/)
  assert.match(s, /consentVersion: d\.consentVersion \|\| CONSENT_VERSION/)
  // The marketing outcome is logged, never returned.
  assert.match(s, /automationStatus:/)
  const responseBlock = s.slice(s.indexOf('return json({\n    ok: true,'))
  assert.ok(!/automation/.test(responseBlock), 'the browser is never told about marketing enrollment')
})

test('13d. CAPTURE_SELECT names only real Lead columns', () => {
  // The regression that made the whole flow a silent no-op. Checked against the
  // schema itself, so a future rename cannot reintroduce it quietly.
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8')
  const model = schema.slice(schema.indexOf('model Lead '), schema.indexOf('@@map("crm_leads")'))
  const fields = new Set(Array.from(model.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s+\S/gm), (m) => m[1]))

  const src = readFileSync(resolve(__dirname, '../quote-capture.ts'), 'utf8')
  const block = src.slice(src.indexOf('const CAPTURE_SELECT = {'), src.indexOf('} as const'))
  const selected = Array.from(block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*): true,/gm), (m) => m[1])

  assert.ok(selected.length > 10, 'the select block must have been found')
  assert.ok(selected.includes('originZip'), 'the pickup zip column is originZip')
  assert.ok(!selected.includes('pickupZip'), 'pickupZip is NOT a Lead column — selecting it throws at runtime')
  for (const f of selected) assert.ok(fields.has(f), `CAPTURE_SELECT names a non-existent Lead field: ${f}`)
})

// ════════════════════════════════════════════════════════════════════════
//  The snapshot, on its own
// ════════════════════════════════════════════════════════════════════════

test('the trigger snapshot never claims consent a lead does not have', () => {
  assert.equal(quoteLeadTriggerSnapshot(captureLead({ emailMarketingConsent: null })).marketingConsent, false)
  assert.equal(quoteLeadTriggerSnapshot(captureLead({ emailMarketingConsent: false })).marketingConsent, false)
  assert.equal(quoteLeadTriggerSnapshot(captureLead({ emailMarketingConsent: true })).marketingConsent, true)
  // No estimate is null, never 0 — a missing number and a free move are not the
  // same fact to a segment rule.
  assert.equal(quoteLeadTriggerSnapshot(captureLead({ estimatedValue: null })).estimatedValueDollars, null)
})
