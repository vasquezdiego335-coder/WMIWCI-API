// ════════════════════════════════════════════════════════════════════════
//  lead-provenance-persistence.test.ts — what actually reaches the ROW, and
//  what a later ping is allowed to do to it.
//
//  THE INCIDENT (2026-08-25) was not only a rendering bug. The row itself was
//  wrong: a customer who had been shown the marketing checkbox and left it
//  unchecked was stored as `email_marketing_consent = NULL` with no consent
//  provenance at all, and `source = OTHER` — the column default — because the
//  browser sent neither fact.
//
//  So these tests assert the OBJECT HANDED TO PERSISTENCE, including through
//  the REAL /api/leads/partial handler and the REAL Zod schema, using the
//  deps seam the repo already uses for exactly this. No database, no network.
//
//  All data is SYNTHETIC.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LeadSource } from '@prisma/client'
import {
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  capturePartialLead,
  questionProvenancePatch,
  sourceUpgradePatch,
  type ExistingPartialLead,
  type PartialLeadInput,
  type PartialLeadStore,
} from '../leads'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { __setQuoteCaptureRouteDeps } from '../quote-capture-deps'

const NOW = new Date('2026-08-25T12:00:00.000Z')

const existing = (over: Partial<ExistingPartialLead> = {}): ExistingPartialLead => ({
  id: 'lead_test',
  status: 'NEW' as ExistingPartialLead['status'],
  name: 'Test Customer',
  phone: null,
  email: 'test.customer@example.com',
  bookingSessionId: 'sess-test',
  lifecycle: 'PARTIAL',
  emailMarketingConsent: null,
  formStep: 'card1',
  estimatedValue: null,
  quoteConfirmationQueuedAt: null,
  utmSource: null,
  utmCampaign: null,
  landingPage: null,
  referrer: null,
  promoCode: null,
  attributionId: null,
  notes: null,
  source: null,
  marketingConsentPrompted: null,
  foundUs: null,
  foundUsPrompted: null,
  originZip: null,
  destinationZip: null,
  ...over,
})

// ── THE ROW A CONTACT-STEP CAPTURE CREATES ──────────────────────────────

test('an unchecked-but-displayed box is STORED as false, with its provenance', () => {
  const row = buildPartialLeadCreate(
    {
      email: 'test.customer@example.com',
      bookingSessionId: 'sess-test',
      formStep: 'card1',
      marketingConsent: false,
      marketingConsentPrompted: true,
      consentSource: 'BOOKING_FORM',
      consentVersion: '2026-07-v1',
    },
    NOW,
  ) as Record<string, unknown>

  //  The customer's answer, not a null.
  assert.equal(row.emailMarketingConsent, false)
  //  And the evidence behind it — a bare boolean proves nothing later.
  assert.equal(row.marketingConsentPrompted, true)
  assert.equal(row.marketingConsentAt, NOW)
  assert.equal(row.marketingConsentSource, 'BOOKING_FORM')
  assert.equal(row.marketingConsentVersion, '2026-07-v1')
})

test('an explicit answer proves the question was asked, without the client saying so twice', () => {
  const row = buildPartialLeadCreate(
    { email: 'a@example.com', bookingSessionId: 's', marketingConsent: true },
    NOW,
  ) as Record<string, unknown>
  assert.equal(row.marketingConsentPrompted, true)
})

test('a form with no checkbox stores that fact, and it is NOT the same as unknown', () => {
  const noBox = buildPartialLeadCreate(
    { email: 'a@example.com', bookingSessionId: 's', marketingConsentPrompted: false },
    NOW,
  ) as Record<string, unknown>
  assert.equal(noBox.marketingConsentPrompted, false)
  assert.equal(noBox.emailMarketingConsent, null)

  //  An old client that says nothing must stay UNKNOWN, not become "not asked".
  const silent = buildPartialLeadCreate({ email: 'a@example.com', bookingSessionId: 's' }, NOW) as Record<
    string,
    unknown
  >
  assert.equal(silent.marketingConsentPrompted, null)
  assert.notEqual(silent.marketingConsentPrompted, noBox.marketingConsentPrompted)
})

test("the customer's own source answer gets its own column, not just the notes log", () => {
  const row = buildPartialLeadCreate(
    { email: 'a@example.com', bookingSessionId: 's', foundUs: 'Google', foundUsPrompted: true },
    NOW,
  ) as Record<string, unknown>
  assert.equal(row.foundUs, 'Google')
  assert.equal(row.foundUsPrompted, true)
})

test('not having reached the source question is recorded as such', () => {
  const row = buildPartialLeadCreate(
    { email: 'a@example.com', bookingSessionId: 's', formStep: 'card1', foundUsPrompted: false },
    NOW,
  ) as Record<string, unknown>
  assert.equal(row.foundUsPrompted, false)
  assert.equal(row.foundUs, null)
})

// ── WHAT A LATER PING MAY CHANGE ────────────────────────────────────────

test('"we asked" only ever moves forward — a late partial cannot un-ask it', () => {
  //  The booking form fires from FIVE triggers (debounce, blur, nav, consent
  //  toggle, exit beacon). A beacon that fires after a back-navigation must not
  //  be able to erase the fact that the question was shown.
  const patch = questionProvenancePatch({ marketingConsentPrompted: true, foundUs: null, foundUsPrompted: true }, {
    marketingConsentPrompted: false,
    foundUsPrompted: false,
  })
  assert.equal('marketingConsentPrompted' in patch, false, 'true must not be lowered to false')
  assert.equal('foundUsPrompted' in patch, false)
})

test('a payload that omits the source answer erases nothing', () => {
  const patch = questionProvenancePatch(
    { marketingConsentPrompted: true, foundUs: 'Google', foundUsPrompted: true },
    { formStep: 'card2' },
  )
  assert.equal('foundUs' in patch, false, 'an absent property must never clear a stored answer')
})

test('a later answer to the source question does land', () => {
  const patch = questionProvenancePatch(
    { marketingConsentPrompted: true, foundUs: null, foundUsPrompted: false },
    { foundUs: 'Door hanger', foundUsPrompted: true },
  )
  assert.equal(patch.foundUs, 'Door hanger')
  assert.equal(patch.foundUsPrompted, true)
})

test('an explicit false consent SURVIVES a repeat submission that carries no opinion', () => {
  //  "Silence changes nothing" — the rule decideConsent has always had. What is
  //  new is that the false got there at all.
  const patch = buildPartialLeadUpdate(
    existing({ emailMarketingConsent: false, marketingConsentPrompted: true }),
    { email: 'test.customer@example.com', formStep: 'card2' },
    NOW,
    'session',
  )
  assert.equal('emailMarketingConsent' in patch, false, 'a silent ping must not touch a recorded decision')
})

test('an unchecked box on a LATER step never revokes an earlier opt-in', () => {
  //  This is what made it safe for the browser to start sending `false` at all.
  const patch = buildPartialLeadUpdate(
    existing({ emailMarketingConsent: true, marketingConsentPrompted: true }),
    { email: 'test.customer@example.com', marketingConsent: false, marketingConsentPrompted: true },
    NOW,
    'session',
  )
  assert.equal(patch.emailMarketingConsent, undefined, 'consent must be left exactly as it was')
})

test('a lifecycle can advance but never regress', () => {
  const patch = buildPartialLeadUpdate(
    existing({ lifecycle: 'SUBMITTED' }),
    { email: 'test.customer@example.com', formStep: 'card1' },
    NOW,
    'session',
  )
  assert.equal(patch.lifecycle, 'SUBMITTED', 'a late contact-step ping cannot downgrade a submitted lead')
})

// ── THE CHANNEL PLACEHOLDER ─────────────────────────────────────────────

test('a lead stored as the OTHER placeholder can be UPGRADED by a later ping', () => {
  //  `source` was written on CREATE only, so a first ping with no detectable
  //  channel pinned the lead to OTHER forever — even when the campaign arrived
  //  moments later in the same session.
  assert.deepEqual(sourceUpgradePatch({ source: LeadSource.OTHER }, { source: 'door_hanger_5000_batch' }), {
    source: LeadSource.DOOR_HANGER,
  })
  assert.deepEqual(sourceUpgradePatch({ source: null }, { source: 'google' }), { source: LeadSource.GOOGLE })
})

test('a REAL channel is never overwritten — first touch stands', () => {
  //  A second value later in the same session is a second touch, not a
  //  correction, and the campaign report joins on the first.
  assert.deepEqual(sourceUpgradePatch({ source: LeadSource.DOOR_HANGER }, { source: 'google' }), {})
  //  And an upgrade that would only produce another placeholder is not one.
  assert.deepEqual(sourceUpgradePatch({ source: LeadSource.OTHER }, { source: 'nothing-recognisable' }), {})
  assert.deepEqual(sourceUpgradePatch({ source: LeadSource.OTHER }, {}), {})
})

// ── ONE LEAD THROUGH ITS WHOLE LIFECYCLE ────────────────────────────────

function memoryStore(): { store: PartialLeadStore; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>()
  let n = 0
  const store: PartialLeadStore = {
    async findBySessionId(sessionId) {
      for (const [id, r] of Array.from(rows.entries())) if (r.bookingSessionId === sessionId) return { ...(r as object), id } as never
      return null
    },
    async findOpenPartialByEmail(email) {
      for (const [id, r] of Array.from(rows.entries())) if (r.email === email) return { ...(r as object), id } as never
      return null
    },
    async create(data) {
      const id = `lead_${++n}`
      rows.set(id, { ...(data as object) } as Record<string, unknown>)
      return { id, status: 'NEW' } as never
    },
    async update(id, data) {
      rows.set(id, { ...(rows.get(id) ?? {}), ...(data as object) })
      return { id, status: 'NEW' } as never
    },
  }
  return { store, rows }
}

const capture = (store: PartialLeadStore, input: PartialLeadInput) =>
  capturePartialLead(input, { store, now: () => NOW })

test('ONE lead, contact step to completed — no duplicate, nothing erased', async () => {
  const { store, rows } = memoryStore()
  const session = 'sess-lifecycle'

  // 1. Contact step: the box is on screen and left unchecked; addresses and the
  //    source question are still ahead of them.
  const first = await capture(store, {
    email: 'test.customer@example.com',
    firstName: 'Test',
    lastName: 'Customer',
    phone: '8625550100',
    bookingSessionId: session,
    formStep: 'card1',
    marketingConsent: false,
    marketingConsentPrompted: true,
    foundUsPrompted: false,
    consentSource: 'BOOKING_FORM',
  })
  assert.ok(first)
  assert.equal(first.isNew, true)
  const id = first.lead.id

  // 2. A refresh mid-form. Same session, nothing new to say.
  const second = await capture(store, { email: 'test.customer@example.com', bookingSessionId: session, formStep: 'card2' })
  assert.equal(second?.isNew, false, 'a refresh must merge, never create a second lead')
  assert.equal(second?.lead.id, id)

  // 3. They reach the addresses+access step and answer the optional question.
  await capture(store, {
    email: 'test.customer@example.com',
    bookingSessionId: session,
    formStep: 'card4',
    foundUs: 'Door hanger',
    foundUsPrompted: true,
  })

  // 4. Submitted.
  await capture(store, { email: 'test.customer@example.com', bookingSessionId: session, formStep: 'submitted' })

  assert.equal(rows.size, 1, 'one customer, one lead row')
  const row = rows.get(id)!
  assert.equal(row.emailMarketingConsent, false, 'the decline survived every later ping')
  assert.equal(row.marketingConsentPrompted, true)
  assert.equal(row.foundUs, 'Door hanger')
  assert.equal(row.foundUsPrompted, true)
  assert.equal(row.lifecycle, 'SUBMITTED')
})

test('an OUT-OF-ORDER late partial cannot downgrade the completed lead', async () => {
  const { store, rows } = memoryStore()
  const session = 'sess-late'

  await capture(store, {
    email: 'test.customer@example.com',
    bookingSessionId: session,
    formStep: 'card4',
    marketingConsent: true,
    marketingConsentPrompted: true,
    foundUs: 'Google',
    foundUsPrompted: true,
  })
  const [id] = Array.from(rows.keys())

  //  The exit beacon from an earlier step, arriving after everything else —
  //  no consent claim, no answer, an earlier step.
  await capture(store, { email: 'test.customer@example.com', bookingSessionId: session, formStep: 'card1' })

  const row = rows.get(id)!
  assert.equal(rows.size, 1)
  assert.equal(row.emailMarketingConsent, true, 'the opt-in stands')
  assert.equal(row.foundUs, 'Google', 'the answer stands')
  assert.equal(row.foundUsPrompted, true, 'and we still know we asked')
  assert.notEqual(row.lifecycle, 'PARTIAL', 'the lifecycle did not regress')
})

test('the same event twice is idempotent', async () => {
  const { store, rows } = memoryStore()
  const body: PartialLeadInput = {
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-dupe',
    formStep: 'card1',
    marketingConsent: false,
    marketingConsentPrompted: true,
  }
  const a = await capture(store, body)
  const b = await capture(store, body)
  assert.equal(a?.isNew, true)
  assert.equal(b?.isNew, false, 'only the FIRST capture is new — the owner notice fires on isNew alone')
  assert.equal(rows.size, 1)
})

// ── THE REAL ROUTE, THE REAL SCHEMA ─────────────────────────────────────

type RouteModule = { POST: (req: Request) => Promise<Response> }
let POST: RouteModule['POST']
let restore: (() => void) | null = null
const captured: PartialLeadInput[] = []

before(async () => {
  ;({ POST } = (await import('../../../app/api/leads/partial/route')) as unknown as RouteModule)
})

beforeEach(() => {
  process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED = 'true'
  captured.length = 0
  restore = __setQuoteCaptureRouteDeps({
    async partialCapture(input) {
      captured.push(input)
      return { lead: { id: 'lead_route', status: 'NEW' as never }, isNew: true }
    },
  })
})

afterEach(() => {
  restore?.()
  restore = null
  delete process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED
})

const post = (body: unknown) =>
  POST(
    new Request('https://api.example.com/api/leads/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
      body: JSON.stringify(body),
    }) as never,
  )

test('ROUTE: an explicit false survives the schema — it is not "absent"', async () => {
  await post({
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-route',
    formStep: 'card1',
    marketingConsent: false,
    marketingConsentPresented: true,
    foundUsPresented: false,
  })
  assert.equal(captured.length, 1)
  const input = captured[0]
  assert.equal(input.marketingConsent, false, 'false must not be coerced to undefined')
  assert.equal(input.marketingConsentPrompted, true)
  assert.equal(input.foundUsPrompted, false)
})

test('ROUTE: absent stays absent — nothing is invented from silence', async () => {
  await post({ email: 'test.customer@example.com', bookingSessionId: 'sess-route-2', formStep: 'card1' })
  const input = captured[0]
  assert.equal(input.marketingConsent, undefined)
  assert.equal(input.marketingConsentPrompted, undefined)
  assert.equal(input.foundUsPrompted, undefined)
  assert.equal(input.foundUs, undefined)
})

test('ROUTE: a LEGACY payload from a cached browser is still accepted', async () => {
  //  A browser cached before this change sends none of the new keys. It must
  //  capture exactly as it always did — never 422, never a guessed answer.
  const res = await post({
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-legacy',
    formStep: 'card1',
    marketingConsent: true,
    consentSource: 'BOOKING_FORM',
    source: 'door_hanger_5000_batch',
  })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(await res.text()).captured, true)
  assert.equal(captured[0].marketingConsent, true)
  assert.equal(captured[0].marketingConsentPrompted, undefined)
})

test('ROUTE: an explicit null is treated as "no value", never as an answer', async () => {
  const res = await post({
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-null',
    formStep: 'card1',
    foundUs: null,
    source: null,
  })
  assert.equal(res.status, 200, 'a null optional must not 422 the whole capture')
  assert.equal(captured[0].foundUs, undefined)
})

test('ROUTE: an unknown source is never rewritten into a customer answer', async () => {
  await post({
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-src',
    formStep: 'card1',
    source: 'some-affiliate-nobody-configured',
  })
  //  It reaches persistence verbatim; mapLeadSource decides, and the RENDERER
  //  is what refuses to print the placeholder as provenance.
  assert.equal(captured[0].source, 'some-affiliate-nobody-configured')
  assert.equal(captured[0].foundUs, undefined, 'a tracking value must never become a self-report')
})

test('ROUTE: validation never echoes the customer back', async () => {
  const res = await post({ email: 'x'.repeat(500), bookingSessionId: 'sess-bad' })
  const text = await res.text()
  assert.equal(res.status, 200, 'a shape problem is a client bug, not a customer error')
  assert.doesNotMatch(text, /xxxx/, 'the submitted value must not be echoed')
})

// ══════════════════════════════════════════════════════════════════════
//  THE MIGRATION — additive, on the right table, guessing nothing
//
//  Pure text analysis: no database, no Prisma engine, no network. Mirrors the
//  gate door-hanger-attribution.test.ts applies to its own migration.
// ══════════════════════════════════════════════════════════════════════

test('the provenance migration targets crm_leads and is additive only', () => {
  const dir = resolve(__dirname, '../../../prisma/migrations/20260825120000_lead_question_provenance')
  const sql = readFileSync(resolve(dir, 'migration.sql'), 'utf8')

  //  THE TABLE. Production carries a SEPARATE legacy "leads" table belonging to
  //  the marketing tracker; two migrations in an earlier release targeted it by
  //  mistake, applied cleanly, reported success, and left the real table
  //  without the columns. Prisma's Lead model is @@map("crm_leads").
  assert.match(sql, /ALTER TABLE "crm_leads"/)
  assert.doesNotMatch(sql, /ALTER TABLE "leads"/, 'the obsolete tracker table must never be touched')
  assert.doesNotMatch(sql, /CREATE TABLE/i, 'this release adds no tables')

  //  ADDITIVE AND RE-RUNNABLE.
  const statements = sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
  assert.ok(statements.length > 0)
  for (const s of statements) {
    assert.match(s, /^ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS/, `not additive: ${s}`)
  }

  //  NOTHING DESTRUCTIVE, AND NO BACKFILL. Writing FALSE across the table would
  //  claim we never asked those customers; writing TRUE would claim they
  //  declined. Both are guesses about real people, so existing rows stay NULL
  //  and render as unknown.
  //  Checked against the STATEMENTS, not the prose — the header documents the
  //  rollback ("drop the three columns"), and a comment is not a statement.
  //  This is the same split the repo's own tablesWrittenBy() makes.
  const executable = statements.join('\n')
  for (const forbidden of [/DROP\s/i, /NOT NULL/i, /\bUPDATE\b/i, /\bDELETE\b/i, /DEFAULT/i, /ALTER COLUMN/i]) {
    assert.doesNotMatch(executable, forbidden, `migration must not execute ${forbidden}`)
  }

  //  EVERY NEW COLUMN IS IN BOTH THE SQL AND THE DATAMODEL. A field in one and
  //  not the other reaches production as a missing column and fails silently.
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8')
  for (const col of ['marketing_consent_prompted', 'found_us', 'found_us_prompted']) {
    assert.match(sql, new RegExp(`"${col}"`), `${col} missing from the migration`)
    assert.ok(schema.includes(`@map("${col}")`), `${col} missing from the datamodel`)
  }

  //  AND THE MODEL THEY LAND ON IS THE LEAD. found_us also exists on Booking,
  //  so a bare column-name grep would pass even if these were added elsewhere.
  const leadModel = /model Lead \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? ''
  assert.match(leadModel, /@@map\("crm_leads"\)/)
  for (const field of ['marketingConsentPrompted', 'foundUs', 'foundUsPrompted']) {
    assert.match(leadModel, new RegExp(`\\b${field}\\b`), `${field} must be on model Lead`)
  }
})

test('the migration does not touch price snapshots or any accepted quote', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260825120000_lead_question_provenance/migration.sql'),
    'utf8',
  )
  //  A lead's accepted price is auditable evidence. This release adds columns
  //  beside it and must not read, rewrite or re-derive a single one.
  for (const col of ['quote_total_cents', 'quote_base_cents', 'quote_mileage_cents', 'estimated_value', 'price_book']) {
    assert.doesNotMatch(sql, new RegExp(col), `${col} must not appear in a provenance migration`)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  LATER ENRICHMENT — found by driving the REAL route against a REAL
//  PostgreSQL, not by any unit test.
//
//  The booking form captures its lead at card1 (Contact) and does not collect
//  addresses or the QR scan id until later. Both were written on the CREATE
//  path only, so every booking-form lead was created without them and could
//  never gain them — the columns stayed null for the lead's whole life.
//  Every existing test exercised CREATE, which is exactly why this survived.
// ══════════════════════════════════════════════════════════════════════

test('a contact-step lead can gain the move\'s two ends later', () => {
  const patch = buildPartialLeadUpdate(
    existing({ originZip: null, destinationZip: null }),
    { email: 'test.customer@example.com', formStep: 'card4', pickupZip: '07052', destinationZip: '07030' },
    NOW,
    'session',
  )
  assert.equal(patch.originZip, '07052', 'the pickup end must land on the UPDATE path')
  assert.equal(patch.destinationZip, '07030', 'and so must the destination')
})

test('a payload without zips never blanks the ones already stored', () => {
  const patch = buildPartialLeadUpdate(
    existing({ originZip: '07052', destinationZip: '07030' }),
    { email: 'test.customer@example.com', formStep: 'card2' },
    NOW,
    'session',
  )
  assert.equal('originZip' in patch, false, 'an absent value must not clear a stored one')
  assert.equal('destinationZip' in patch, false)
})

test('an email-matched lead only FILLS BLANK zips — a shared address cannot move somebody', () => {
  const patch = buildPartialLeadUpdate(
    existing({ originZip: '07052', destinationZip: '07030' }),
    { email: 'test.customer@example.com', pickupZip: '99999', destinationZip: '88888' },
    NOW,
    'email',
  )
  assert.equal(patch.originZip, '07052', 'a loose email match must not rewrite a stored address')
  assert.equal(patch.destinationZip, '07030')
})

test('the partial route ACCEPTS the QR scan id and forwards it', async () => {
  //  All 2,500 printed door hangers share ONE code, so `source` can say "a door
  //  hanger" and never "which scan". This route accepted no attributionId at
  //  all, so every booking-form lead arrived unattributable however it entered.
  const aid = 'a'.repeat(32)
  await post({
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-aid',
    formStep: 'card1',
    attributionId: aid,
  })
  assert.equal(captured[0].attributionId, aid, 'the scan id must reach persistence')
})

test('a malformed scan id drops the attribution but never the lead', async () => {
  const res = await post({
    email: 'test.customer@example.com',
    bookingSessionId: 'sess-aid-bad',
    formStep: 'card1',
    attributionId: 'not-hex-at-all',
  })
  assert.equal(res.status, 200, 'a tracking value the customer never saw must not cost them their lead')
  //  It reaches persistence verbatim; cleanAttributionId is the shape gate.
  assert.equal(captured.length, 1)
})
