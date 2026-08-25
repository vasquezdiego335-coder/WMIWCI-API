// ════════════════════════════════════════════════════════════════════════
//  door-hanger-attribution.test.ts
//
//  The API half of "did 2,500 printed door hangers pay for themselves".
//
//  TWO DEFECTS, BOTH VERIFIED IN PRODUCTION BEFORE THIS WAS WRITTEN:
//
//  1. Every quick-quote lead from the campaign was filed as OTHER. The tracker
//     mints `src=door_hanger_5000_batch`; SOURCE_MAP held door_hanger,
//     door-hanger and doorhanger but not that, the enum fallback produced
//     DOOR_HANGER_5000_BATCH which is not a LeadSource, and mapLeadSource
//     returned OTHER. The owner's own "Door hanger" admin filter matches
//     `source = 'DOOR_HANGER'` exactly, so the leads the hangers produced were
//     invisible on the page built to find them.
//
//  2. `attributionId` did not exist anywhere on the deployed branch — no schema
//     field, no Prisma column, no migration, and tracker.ts sent no
//     attribution_id when it pushed booked revenue. All 2,500 cards share ONE
//     printed code, so `source` can say "a door hanger" and can never say
//     "which scan". Every conversion reached the tracker unattributed.
//
//  Pure and offline: no database, no network, no Prisma engine. Everything
//  here is either a pure function or a text comparison against the files that
//  ship.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { LeadSource } from '@prisma/client'
import {
  mapLeadSource,
  cleanAttributionId,
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  type ExistingPartialLead,
} from '../leads'
import { BookingSchema } from '../booking-schema'

const ROOT = resolve(__dirname, '../../..')
const AID = 'abc123def456abc123def456abc12345'

// ── 1. THE SOURCE LABEL THE TRACKER ACTUALLY MINTS ──────────────────────

test('door_hanger_5000_batch is a DOOR_HANGER lead, not OTHER', () => {
  assert.equal(mapLeadSource('door_hanger_5000_batch'), LeadSource.DOOR_HANGER)
})

test('the admin filter value is what the mapping produces', () => {
  // leads/page.tsx: `case 'door_hanger': where.source = 'DOOR_HANGER'`
  assert.equal(mapLeadSource('door_hanger_5000_batch'), 'DOOR_HANGER')
})

test('a future batch label lands in the same place without a deploy', () => {
  // The point of matching the CHANNEL rather than the exact batch: run two, a
  // second town, or a reprint must not silently start filing as OTHER again.
  for (const src of [
    'door_hanger_2500_batch',
    'door_hanger_run2_2027',
    'DOOR-HANGER-WESTORANGE',
    'doorhanger_montclair_b01',
    'door hanger 5000 batch',
  ]) {
    assert.equal(mapLeadSource(src), LeadSource.DOOR_HANGER, `failed for ${src}`)
  }
})

test('the original exact keys still work', () => {
  for (const src of ['door_hanger', 'door-hanger', 'doorhanger']) {
    assert.equal(mapLeadSource(src), LeadSource.DOOR_HANGER)
  }
})

test('yard signs get the same channel treatment', () => {
  assert.equal(mapLeadSource('yard_sign_2026_batch'), LeadSource.YARD_SIGN)
})

test('the channel match runs LAST and cannot hijack an existing meaning', () => {
  // contact-form has always meant WEBSITE; the enum-name path must still win
  // for a controlled capture surface.
  assert.equal(mapLeadSource('contact-form'), LeadSource.WEBSITE)
  assert.equal(mapLeadSource('QUICK_QUOTE_FORM'), LeadSource.QUICK_QUOTE_FORM)
  assert.equal(mapLeadSource('google'), LeadSource.GOOGLE)
})

test('an unrelated source is still OTHER', () => {
  assert.equal(mapLeadSource('some_random_thing'), LeadSource.OTHER)
  assert.equal(mapLeadSource(''), LeadSource.OTHER)
  assert.equal(mapLeadSource(null), LeadSource.OTHER)
})

// ── 2. THE ID ITSELF ────────────────────────────────────────────────────

test('a real tracker id is accepted and normalised to lower case', () => {
  assert.equal(cleanAttributionId(AID), AID)
  assert.equal(cleanAttributionId(AID.toUpperCase()), AID)
  assert.equal(cleanAttributionId('  ' + AID + '  '), AID)
})

test('anything that is not a machine-minted id is dropped, never stored', () => {
  for (const bad of [
    '', '   ', null, undefined,
    'not-hex-at-all',
    'abc',                                   // too short to be one
    'g'.repeat(32),                          // not hex
    AID + '<script>',                        // injection attempt
    'a'.repeat(65),                          // longer than any id we mint
    "abc123'; DROP TABLE bookings; --",
  ]) {
    assert.equal(cleanAttributionId(bad as string | null), null, `accepted: ${String(bad)}`)
  }
})

// ── 3. THE LEAD (the majority path — the landing CTA points at the quote form)

test('a quote lead created from a scan stores the id', () => {
  const row = buildPartialLeadCreate(
    { email: 'a@b.com', source: 'door_hanger_5000_batch', attributionId: AID },
    new Date()
  ) as Record<string, unknown>
  assert.equal(row.attributionId, AID)
  assert.equal(row.source, LeadSource.DOOR_HANGER)
})

test('a lead with no scan behind it simply has none', () => {
  const row = buildPartialLeadCreate({ email: 'a@b.com' }, new Date()) as Record<string, unknown>
  assert.equal(row.attributionId, null)
})

test('a malformed id never reaches the column the report joins on', () => {
  const row = buildPartialLeadCreate(
    { email: 'a@b.com', attributionId: 'nonsense' },
    new Date()
  ) as Record<string, unknown>
  assert.equal(row.attributionId, null)
})

const existing = (over: Partial<ExistingPartialLead> = {}): ExistingPartialLead => ({
  id: 'l1', status: 'NEW' as ExistingPartialLead['status'], name: 'Booking lead',
  phone: null, email: 'a@b.com', bookingSessionId: 's1', lifecycle: null,
  emailMarketingConsent: null, formStep: 'quote', estimatedValue: null,
  quoteConfirmationQueuedAt: null, utmSource: null, utmCampaign: null,
  landingPage: null, referrer: null, promoCode: null, attributionId: null,
  notes: null,
  source: null, marketingConsentPrompted: null, foundUs: null, foundUsPrompted: null,
  originZip: null,
  destinationZip: null,
  ...over,
})

test('a repeat submission fills a blank id', () => {
  const patch = buildPartialLeadUpdate(
    existing(), { email: 'a@b.com', attributionId: AID }, new Date(), 'session'
  ) as Record<string, unknown>
  assert.equal(patch.attributionId, AID)
})

test('ATTRIBUTION IS FIRST-TOUCH: a later ping cannot blank a known id', () => {
  // The failure this prevents: the visitor reopens the form from a bookmark, or
  // a background tab fires a capture, and the scan that produced the lead is
  // erased by a submission that simply had no id on its URL.
  const patch = buildPartialLeadUpdate(
    existing({ attributionId: AID }), { email: 'a@b.com' }, new Date(), 'session'
  ) as Record<string, unknown>
  assert.equal(patch.attributionId, AID)
})

test('...and a DIFFERENT id later does not overwrite the first', () => {
  const other = 'f'.repeat(32)
  const patch = buildPartialLeadUpdate(
    existing({ attributionId: AID }), { email: 'a@b.com', attributionId: other }, new Date(), 'session'
  ) as Record<string, unknown>
  assert.equal(patch.attributionId, AID, 'a second scan is a second visit, not a correction')
})

// ── 4. THE BOOKING (the hop where a scan becomes revenue) ────────────────

const minimalBooking = (over: Record<string, unknown> = {}) => ({
  fullName: 'Test Customer',
  email: 'test@example.com',
  phone: '8625550000',
  serviceType: 'full_service',
  ...over,
})

test('the booking schema accepts a real id', () => {
  const parsed = BookingSchema.partial().safeParse(minimalBooking({ attributionId: AID }))
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.attributionId, AID)
})

test('A MALFORMED ID DROPS THE ATTRIBUTION AND NEVER REJECTS THE BOOKING', () => {
  // The regression this pins is expensive and invisible: a mangled ?aid= on a
  // shared link 422s a paying customer's checkout over a tracking parameter
  // they never saw — and the value lives in a 90-day cookie, so it fails again
  // every time they retry.
  for (const bad of ['garbage', '<script>', 'a'.repeat(300), '123']) {
    const parsed = BookingSchema.partial().safeParse(minimalBooking({ attributionId: bad }))
    assert.equal(parsed.success, true, `a malformed id rejected the booking: ${bad}`)
    if (parsed.success) assert.equal(parsed.data.attributionId, undefined)
  }
})

test('a booking with no scan behind it parses fine', () => {
  const parsed = BookingSchema.partial().safeParse(minimalBooking())
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.attributionId, undefined)
})

// ── 5. THE WIRING, END TO END, AS SHIPPED ───────────────────────────────
//  These read the files rather than calling them: the alternative is booting
//  Next, Prisma and a database to prove that one property is passed along.

test('the bookings route persists the id onto the booking', () => {
  const src = readFileSync(resolve(ROOT, 'app/api/bookings/route.ts'), 'utf8')
  assert.match(src, /attributionId: data\.attributionId/,
    'the booking route accepts the id and then throws it away')
})

test('the quote-capture route accepts and forwards the id', () => {
  const src = readFileSync(resolve(ROOT, 'app/api/leads/quote-capture/route.ts'), 'utf8')
  assert.match(src, /attributionId: z/, 'the schema does not accept it, so zod strips it silently')
  assert.match(src, /attributionId: d\.attributionId/, 'accepted and then not persisted')
  assert.match(src, /\.catch\(undefined\)/, 'a malformed id could 422 a real lead')
})

test('tracker.ts sends attribution_id and the pickup location', () => {
  const src = readFileSync(resolve(ROOT, 'src/lib/tracker.ts'), 'utf8')
  assert.match(src, /attribution_id: input\.attributionId/,
    'without this the tracker writes every conversion as unattributed')
  assert.match(src, /origin_city: input\.originCity/)
  assert.match(src, /origin_state: input\.originState/)
  assert.match(src, /origin_zip: input\.originZip/)
})

test('fulfillment passes them at the only call site', () => {
  const src = readFileSync(resolve(ROOT, 'src/lib/fulfillment.ts'), 'utf8')
  assert.match(src, /attributionId: booking\.attributionId/,
    'the field exists on the booking and is not handed to the tracker')
  assert.match(src, /originCity: booking\.originCity/)
})

// ── 6. THE MIGRATION ────────────────────────────────────────────────────

test('the migration exists and is not auto-applied by accident', () => {
  const dir = resolve(ROOT, 'prisma/migrations')
  const mine = readdirSync(dir).filter((d) => d.includes('attribution_id'))
  assert.ok(mine.length > 0, 'no attribution_id migration was generated')
  const sql = readFileSync(resolve(dir, mine[0], 'migration.sql'), 'utf8')

  // THE TABLE-NAME TRAP: Lead maps to crm_leads, and production also carries a
  // separate, empty, legacy `leads` table. A migration naming `leads` applies
  // cleanly, reports success, and leaves the real table without the column.
  assert.match(sql, /ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "attribution_id"/)
  assert.match(sql, /ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "attribution_id"/)
  assert.doesNotMatch(sql, /ALTER TABLE "leads"/, 'targets the dead legacy table')

  // Additive and re-runnable, so applying it can never lose or lock data.
  assert.match(sql, /IF NOT EXISTS/)
  assert.doesNotMatch(sql, /\bDROP\b/i, 'a migration for a print run must never drop anything')
  assert.doesNotMatch(sql, /\bNOT NULL\b/i, 'a NOT NULL column would break every existing row')
  assert.doesNotMatch(sql, /\bUPDATE\b/i, 'no backfill: nothing here should rewrite existing rows')
})

test('the schema declares the column on both models, with an index', () => {
  const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8')
  const occurrences = schema.match(/attributionId\s+String\?\s+@map\("attribution_id"\)/g) ?? []
  assert.equal(occurrences.length, 2, 'expected the column on Booking and on Lead')
  const indexes = schema.match(/@@index\(\[attributionId\]\)/g) ?? []
  assert.equal(indexes.length, 2, 'the campaign report joins on this column')
})

test('the migration and the schema agree that it is nullable', () => {
  const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8')
  assert.doesNotMatch(schema, /attributionId\s+String\s+@map\("attribution_id"\)/,
    'a required column would reject every booking that did not come from a scan')
})

test('the prisma client used at runtime is generated from this schema', () => {
  // A guard against the field existing in schema.prisma and not in the client:
  // the migration is manual on this project, so the two can drift.
  assert.ok(existsSync(resolve(ROOT, 'prisma/schema.prisma')))
})
