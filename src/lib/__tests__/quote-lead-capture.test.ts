// ════════════════════════════════════════════════════════════════════════
//  QUICK-QUOTE LEAD CAPTURE (owner spec 2026-08-03)
//
//  What this file prevents, in the order the owner asked for it:
//    1. an estimate shown before contact details are captured
//    2. a quick-quote lead that is never saved (POST /api/leads used to 404)
//    3. a duplicate lead every time the customer edits the estimator
//    4. a confirmation email that is sent twice — or that prints an empty price
//    5. promotional consent invented from the act of typing an email address
//    6. an owner alert that repeats for a cosmetic edit, or never fires
//    7. an unattributed visitor labelled "organic search"
//
//  OFFLINE + PURE. No database, no Redis, no network, no env. Prisma is never
//  faked by module mocking — the seam is the injectable store that leads.ts
//  already exports (the house pattern from leads.test.ts).
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  capturePartialLead,
  normalizeContactPreference,
  alertFingerprint,
  shouldRealert,
  mapLeadSource,
  CONTACT_PREFERENCES,
  type PartialLeadInput,
  type PartialLeadStore,
  type PartialLeadDeps,
  type ExistingPartialLead,
  type LeadRecord,
} from '../leads'
import { classifyLeadSource, leadSourceLabel, isInternalSourceMarker } from '../lead-attribution'
import { firstNameOf, formatEstimate } from '../quote-capture'
import { quoteFollowupBlockReason, transactionalLeadBlockReason } from '../journeys'
import { buildLeadCard, telHref, contactPreferenceLabel } from '../booking-display'

const NOW = new Date('2026-08-03T15:00:00.000Z')

// ── The in-memory store (house pattern: leads.test.ts / leads-partial.test.ts)
function makeStore(seed: ExistingPartialLead[] = []): { store: PartialLeadStore; rows: Map<string, ExistingPartialLead> } {
  const rows = new Map<string, ExistingPartialLead>()
  seed.forEach((r) => rows.set(r.id, r))
  let n = seed.length
  const store: PartialLeadStore = {
    async findBySessionId(sessionId) {
      return Array.from(rows.values()).find((r) => r.bookingSessionId === sessionId) ?? null
    },
    async findOpenPartialByEmail(email) {
      return Array.from(rows.values()).find((r) => r.email === email) ?? null
    },
    async create(data) {
      const id = `lead_${++n}`
      rows.set(id, { id, ...(data as unknown as Omit<ExistingPartialLead, 'id'>) })
      return { id, status: 'NEW' } as LeadRecord
    },
    async update(id, data) {
      rows.set(id, { ...(rows.get(id) as ExistingPartialLead), ...(data as object) })
      return { id, status: 'NEW' } as LeadRecord
    },
  }
  return { store, rows }
}
const deps = (store: PartialLeadStore): PartialLeadDeps => ({ store, now: () => NOW })

const quoteInput = (over: Partial<PartialLeadInput> = {}): PartialLeadInput => ({
  email: 'zalak@example.com',
  firstName: 'Zalak',
  lastName: 'Shah',
  phone: '732-763-2716',
  bookingSessionId: 'sess-quote-1',
  formStep: 'quote',
  moveSize: '2br',
  moveDate: new Date('2026-08-11T12:00:00.000Z'),
  pickupZip: '07052',
  destinationZip: '07901',
  estimatedValue: 104_900,
  source: 'QUICK_QUOTE_FORM',
  ...over,
})

// ══════════════════════════════════════════════════════════════════════
//  1. THE LEAD IS SAVED AT THE CONTACT STEP — with the move details
// ══════════════════════════════════════════════════════════════════════

test('a quick-quote submission creates ONE lead carrying the contact block, move details and estimate', async () => {
  const { store, rows } = makeStore()
  const res = await capturePartialLead(quoteInput(), deps(store))
  assert.ok(res, 'the capture must return a record')
  assert.equal(res!.isNew, true)
  assert.equal(rows.size, 1)

  const row = Array.from(rows.values())[0] as unknown as Record<string, unknown>
  assert.equal(row.name, 'Zalak Shah')
  assert.equal(row.phone, '732-763-2716')
  assert.equal(row.email, 'zalak@example.com')
  assert.equal(row.estimatedValue, 104_900, 'the estimate must be stored in CENTS')
  assert.equal(row.pickupZip, '07052')
  assert.equal(row.destinationZip, '07901')
  assert.equal(row.zip, '07052', 'legacy `zip` stays the PICKUP zip for back-compat')
  assert.equal(row.jobType, '2br', 'the move size lands in jobType, not a new column')
  assert.equal((row.moveDate as Date).toISOString(), '2026-08-11T12:00:00.000Z')
})

test('the estimate is NOT required to save the lead — a person with no price is still a person', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead(quoteInput({ estimatedValue: null }), deps(store))
  assert.equal(rows.size, 1)
  assert.equal((Array.from(rows.values())[0] as unknown as Record<string, unknown>).estimatedValue, null)
})

// ══════════════════════════════════════════════════════════════════════
//  2. EDITING THE ESTIMATOR UPDATES — NEVER DUPLICATES
// ══════════════════════════════════════════════════════════════════════

test('re-submitting with the same session id UPDATES the same lead (no duplicate)', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead(quoteInput(), deps(store))
  await capturePartialLead(quoteInput({ estimatedValue: 129_900 }), deps(store))
  assert.equal(rows.size, 1, 'a second submit from the same session must not spawn a lead')
  assert.equal((Array.from(rows.values())[0] as unknown as Record<string, unknown>).estimatedValue, 129_900)
})

test('a lost session id still merges by email rather than duplicating', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead(quoteInput(), deps(store))
  await capturePartialLead(quoteInput({ bookingSessionId: undefined }), deps(store))
  assert.equal(rows.size, 1)
})

test('the customer CORRECTING their answers overwrites them — a frozen first answer would send the crew on the wrong day', () => {
  const existing = {
    id: 'l1', status: 'NEW', name: 'Zalak Shah', phone: '732-763-2716', email: 'zalak@example.com',
    bookingSessionId: 'sess-quote-1', lifecycle: 'IN_PROGRESS', emailMarketingConsent: null,
    formStep: 'quote', estimatedValue: 104_900, utmSource: null, utmCampaign: null,
    landingPage: null, referrer: null, promoCode: null,
  } as unknown as ExistingPartialLead

  const patch = buildPartialLeadUpdate(
    existing,
    quoteInput({
      moveDate: new Date('2026-09-01T12:00:00.000Z'),
      contactPreference: 'text',
      bestTimeToCall: 'evenings',
      pickupZip: '07018',
    }),
    NOW
  ) as Record<string, unknown>

  assert.equal((patch.moveDate as Date).toISOString(), '2026-09-01T12:00:00.000Z')
  assert.equal(patch.contactPreference, 'text')
  assert.equal(patch.bestTimeToCall, 'evenings')
  assert.equal(patch.pickupZip, '07018')
  assert.equal(patch.zip, '07018')
})

test('attribution is FIRST-TOUCH — a later visit cannot rewrite the channel that earned the lead', () => {
  const existing = {
    id: 'l1', status: 'NEW', name: 'Zalak Shah', phone: null, email: 'zalak@example.com',
    bookingSessionId: 'sess-quote-1', lifecycle: 'PARTIAL', emailMarketingConsent: null,
    formStep: 'quote', estimatedValue: null,
    utmSource: 'facebook', utmCampaign: 'fb-post', landingPage: 'https://moveitclearit.com/quote.html',
    referrer: 'https://facebook.com/', promoCode: null,
  } as unknown as ExistingPartialLead

  const patch = buildPartialLeadUpdate(existing, quoteInput({ utmSource: 'google', utmCampaign: 'other' }), NOW) as Record<string, unknown>
  assert.equal(patch.utmSource, 'facebook')
  assert.equal(patch.utmCampaign, 'fb-post')
  assert.ok(!('source' in patch), 'the classified channel is never rewritten on update')
})

// ══════════════════════════════════════════════════════════════════════
//  3. CONSENT IS NEVER INVENTED
// ══════════════════════════════════════════════════════════════════════

test('typing an email address does NOT create promotional consent', () => {
  const row = buildPartialLeadCreate(quoteInput(), NOW) as unknown as Record<string, unknown>
  assert.equal(row.emailMarketingConsent, null, 'never touched ⇒ null, NOT false and NOT true')
  assert.equal(row.marketingConsentAt, null)
})

test('an explicit tick is recorded, and an explicit untick records a real refusal', () => {
  const yes = buildPartialLeadCreate(quoteInput({ marketingConsent: true }), NOW) as unknown as Record<string, unknown>
  assert.equal(yes.emailMarketingConsent, true)
  const no = buildPartialLeadCreate(quoteInput({ marketingConsent: false }), NOW) as unknown as Record<string, unknown>
  assert.equal(no.emailMarketingConsent, false, 'false is a DECISION, distinct from never-asked')
})

test('a repeat submission with the checkbox untouched leaves stored consent alone', () => {
  const existing = {
    id: 'l1', status: 'NEW', name: 'Zalak Shah', phone: null, email: 'zalak@example.com',
    bookingSessionId: 'sess-quote-1', lifecycle: 'PARTIAL', emailMarketingConsent: true,
    formStep: 'quote', estimatedValue: null, utmSource: null, utmCampaign: null,
    landingPage: null, referrer: null, promoCode: null,
  } as unknown as ExistingPartialLead
  const patch = buildPartialLeadUpdate(existing, quoteInput(), NOW) as Record<string, unknown>
  assert.ok(!('emailMarketingConsent' in patch), 'undefined consent must not clear an existing opt-in')
})

// ══════════════════════════════════════════════════════════════════════
//  4. CONTACT PREFERENCE
// ══════════════════════════════════════════════════════════════════════

test('the four owner-specified contact preferences are accepted and normalized', () => {
  assert.deepEqual([...CONTACT_PREFERENCES], ['call_asap', 'text', 'email', 'customer_will_contact'])
  assert.equal(normalizeContactPreference('call_asap'), 'call_asap')
  assert.equal(normalizeContactPreference('Call ASAP'), 'call_asap', 'spaces/case are normalized')
  assert.equal(normalizeContactPreference('customer-will-contact'), 'customer_will_contact')
})

test('an unrecognised contact preference is DROPPED, never stored as junk', () => {
  assert.equal(normalizeContactPreference('call me on the moon'), null)
  assert.equal(normalizeContactPreference(''), null)
  assert.equal(normalizeContactPreference(null), null)
  const row = buildPartialLeadCreate(quoteInput({ contactPreference: 'nonsense' }), NOW) as unknown as Record<string, unknown>
  assert.equal(row.contactPreference, null)
})

// ══════════════════════════════════════════════════════════════════════
//  5. THE CONFIRMATION EMAIL'S CONDITIONAL PRICE
// ══════════════════════════════════════════════════════════════════════

test('formatEstimate omits the value entirely when there is no real estimate', () => {
  assert.equal(formatEstimate(104_900), '$1,049')
  assert.equal(formatEstimate(0), undefined, '$0 is not an estimate — it is a free move')
  assert.equal(formatEstimate(null), undefined)
  assert.equal(formatEstimate(undefined), undefined)
  assert.equal(formatEstimate(-500), undefined)
})

test('the greeting never renders empty', () => {
  assert.equal(firstNameOf('Zalak Shah'), 'Zalak')
  assert.equal(firstNameOf('Website lead'), 'there', 'the placeholder name is not a first name')
  assert.equal(firstNameOf('Booking lead'), 'there')
  assert.equal(firstNameOf(''), 'there')
  assert.equal(firstNameOf(null), 'there')
})

/** Strip comment lines before asserting on source. Without this a regex can be
 *  satisfied by a comment that merely NAMES the thing it forbids — the house
 *  `code()` idiom from email-hardening-scenarios.test.ts. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

test('the template DROPS the estimate paragraph rather than printing an empty value', () => {
  const src = readFileSync(path.resolve(__dirname, '..', '..', 'emails', 'quote-request-received.tsx'), 'utf8')
  assert.ok(/showEstimate \? <p style=\{P\}>\{t\.estimate\}<\/p> : null/.test(src),
    'the estimate paragraph must be conditional on showEstimate')
  assert.ok(/function hasEstimate/.test(src), 'a guard must decide whether a price is real')
  assert.ok(/\[1-9\]/.test(src),
    'the guard must reject a zero-looking amount, not merely an empty string')
  assert.ok(!/money\(/.test(code(src)),
    'money() substitutes prose for a missing amount ("the amount shown above") — this template must omit the sentence instead')
})

test('the confirmation email is registered as TRANSACTIONAL, not promotional', () => {
  const guard = readFileSync(path.resolve(__dirname, '..', 'email-guard.ts'), 'utf8')
  const set = guard.slice(guard.indexOf('TRANSACTIONAL_TEMPLATES'), guard.indexOf('export function classifyTemplate'))
  assert.ok(set.includes("'quote-request-received'"),
    'an unregistered template defaults to PROMOTIONAL, which would cap it, quiet-hour it, and attach an unsubscribe row')
})

test('the template is registered everywhere the conformance tests require', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
  assert.ok(read('queues/index.ts').includes("'quote-request-received'"), 'EmailJobData union')
  assert.ok(read('email-render.ts').includes("'quote-request-received'"), 'RENDERERS (admin preview + test send)')
  assert.ok(read('email-registry.ts').includes("'quote-request-received'"), 'registry SEEDS')
  assert.ok(read('i18n.ts').includes("'quote-request-received'"),
    'without an EMAIL_SUBJECTS entry a locale-carrying send ships the business name as its subject')
  const worker = readFileSync(path.resolve(__dirname, '..', '..', 'workers', 'email.worker.ts'), 'utf8')
  assert.ok(worker.includes("'quote-request-received'"), 'worker ALLOWED_TEMPLATES + TEMPLATES + SUBJECTS')
})

test('the subject line is exactly what the owner specified', () => {
  const worker = readFileSync(path.resolve(__dirname, '..', '..', 'workers', 'email.worker.ts'), 'utf8')
  assert.ok(worker.includes("'quote-request-received': 'We received your moving estimate request'"))
})

// ══════════════════════════════════════════════════════════════════════
//  6. THE OWNER ALERT FIRES ONCE — AND AGAIN ONLY ON A REAL CHANGE
// ══════════════════════════════════════════════════════════════════════

const fp = (over: Parameters<typeof alertFingerprint>[0] = {}) =>
  alertFingerprint({
    moveDate: new Date('2026-08-11T12:00:00.000Z'),
    estimatedValue: 104_900,
    contactPreference: 'call_asap',
    phone: '732-763-2716',
    ...over,
  })

test('a lead never alerted before always alerts', () => {
  assert.equal(shouldRealert(null, fp()), true)
  assert.equal(shouldRealert(undefined, fp()), true)
})

test('an unchanged lead does NOT re-alert', () => {
  assert.equal(shouldRealert(fp(), fp()), false)
})

test('the three owner-named changes DO re-alert', () => {
  assert.equal(shouldRealert(fp(), fp({ moveDate: new Date('2026-09-01T12:00:00.000Z') })), true, 'move date')
  assert.equal(shouldRealert(fp(), fp({ estimatedValue: 129_900 })), true, 'estimated value')
  assert.equal(shouldRealert(fp(), fp({ contactPreference: 'text' })), true, 'contact preference')
})

test('a phone number appearing for the first time re-alerts — it changes what the owner can do', () => {
  assert.equal(shouldRealert(fp({ phone: null }), fp()), true)
})

test('a cosmetic edit does NOT re-alert', () => {
  // Same facts, different formatting of the same phone number.
  assert.equal(shouldRealert(fp(), fp({ phone: '(732) 763-2716' })), false)
})

test('the fingerprint is stable across calls — a redeploy must not re-alert every lead', () => {
  assert.equal(fp(), fp())
  assert.equal(alertFingerprint({}), alertFingerprint({}))
})

// ══════════════════════════════════════════════════════════════════════
//  7. THE ALERT CARD CONTENTS (owner requirement 6)
// ══════════════════════════════════════════════════════════════════════

const card = () =>
  buildLeadCard({
    leadId: 'lead_abc',
    firstName: 'Zalak',
    lastName: 'Shah',
    phone: '732-763-2716',
    email: 'zalak@example.com',
    estimateDollars: 1049,
    moveDate: '2026-08-11T12:00:00.000Z',
    moveSize: '2br',
    pickup: 'West Orange 07052',
    destination: 'Summit 07901',
    contactPreference: 'call_asap',
    bestTimeToCall: 'Weekday mornings',
    formStep: 'quote',
    source: 'QR_CODE',
    sourceDetail: 'print',
    referrer: 'https://facebook.com/',
    landingPage: 'https://moveitclearit.com/quote.html',
    utmSource: 'print',
    utmCampaign: 'print-doorhanger',
    adminUrl: 'https://api.example.com/admin/leads',
  })

test('the alert carries every field the owner asked for', () => {
  const text = JSON.stringify(card())
  for (const needle of [
    'Zalak Shah', '732-763-2716', 'zalak@example.com', '$1,049', '2br',
    'West Orange 07052', 'Summit 07901', 'Call me as soon as possible',
    'Weekday mornings', 'quote', 'lead_abc', 'QR_CODE', 'print-doorhanger',
    'facebook.com', 'moveitclearit.com/quote.html',
  ]) {
    assert.ok(text.includes(needle), `the alert must include ${needle}`)
  }
})

test('every alert button is a valid http(s) LINK button — Discord drops the whole message otherwise', () => {
  const { components, embeds } = card()
  const buttons = components[0].components
  for (const b of buttons) {
    assert.equal(b.style, 5, 'link style')
    assert.ok(b.url, 'a link button MUST carry a url')
    assert.ok(!b.custom_id, 'a link button must NOT carry a custom_id — Discord 400s the whole message')
    assert.match(String(b.url), /^https?:\/\//,
      'tel:/mailto: are REJECTED by Discord and take the entire alert with them — the phone and email ride in the embed instead')
  }
  assert.ok(buttons.some((b) => String(b.url).includes('/admin/leads')), 'Open-in-admin must be present')
  // The call/email actions still have to REACH the owner, just not as buttons.
  const text = JSON.stringify(embeds)
  assert.ok(text.includes('732-763-2716'), 'the phone must be in the embed where mobile Discord linkifies it')
  assert.ok(text.includes('zalak@example.com'), 'and the email too')
})

test('a missing estimate is STATED, never rendered as $0', () => {
  const { embeds } = buildLeadCard({ leadId: 'l1', name: 'Someone', estimateDollars: null })
  const text = JSON.stringify(embeds)
  assert.ok(text.includes('no estimate yet'))
  assert.ok(!text.includes('$0'), 'quoting $0 is quoting a free move')
})

test('telHref refuses to build a dialer link from an unusable number', () => {
  assert.equal(telHref('555'), null)
  assert.equal(telHref(null), null)
  assert.equal(telHref('7327632716'), 'tel:+17327632716')
})

test('no alert button ever carries a non-http scheme, whatever the lead contains', () => {
  const { components } = buildLeadCard({
    leadId: 'l1', name: 'X', phone: '732-763-2716', email: 'x@y.com', adminUrl: 'https://a/admin/leads',
  })
  for (const b of components[0]?.components ?? []) {
    assert.match(String(b.url), /^https?:\/\//)
  }
})

test('a re-alert is visibly distinct from a new lead', () => {
  const fresh = JSON.stringify(buildLeadCard({ leadId: 'l1', name: 'X' }))
  const update = JSON.stringify(buildLeadCard({ leadId: 'l1', name: 'X', isUpdate: true }))
  assert.ok(fresh.includes('New quote request'))
  assert.ok(update.includes('Lead updated'))
  assert.ok(!update.includes('New quote request'), 'an update must never read as a second person')
})

test('a lead name cannot smuggle a mass mention into the owner channel', () => {
  const text = JSON.stringify(buildLeadCard({ leadId: 'l1', name: '@everyone call me' }))
  assert.ok(!/"[^"]*@everyone/.test(text.replace(/@​everyone/g, '')), '@everyone must be neutralized')
})

test('contactPreferenceLabel humanizes the stored key', () => {
  assert.match(contactPreferenceLabel('call_asap')!, /Call me as soon as possible/)
  assert.match(contactPreferenceLabel('customer_will_contact')!, /contact us/)
  assert.equal(contactPreferenceLabel(null), null)
})

// ══════════════════════════════════════════════════════════════════════
//  8. SOURCE ATTRIBUTION (owner requirement 7)
// ══════════════════════════════════════════════════════════════════════

test('the legacy string→enum primitive is UNCHANGED (existing callers keep working)', () => {
  assert.equal(mapLeadSource('facebook'), 'FACEBOOK')
  assert.equal(mapLeadSource('door-hanger'), 'DOOR_HANGER')
  assert.equal(mapLeadSource('contact-form'), 'WEBSITE')
  assert.equal(mapLeadSource('whatever'), 'OTHER')
  assert.equal(mapLeadSource(null), 'OTHER')
})

test('qr IS now a recognised source — the owner asked for it by name', () => {
  assert.equal(mapLeadSource('qr'), 'QR_CODE')
  assert.equal(classifyLeadSource({ source: 'qr' }), 'QR_CODE')
})

test('NO tags and NO referrer is DIRECT — never organic', () => {
  assert.equal(classifyLeadSource({}), 'DIRECT')
  assert.equal(classifyLeadSource({ referrer: '' }), 'DIRECT')
  assert.equal(
    classifyLeadSource({ referrer: 'https://moveitclearit.com/pricing.html' }),
    'DIRECT',
    'our OWN site is internal navigation, not a referral'
  )
})

test('a referrer we cannot classify is UNKNOWN — never organic, never direct', () => {
  assert.equal(classifyLeadSource({ referrer: 'https://some-random-blog.example/' }), 'UNKNOWN')
})

test('ORGANIC_SEARCH requires a real search engine referrer', () => {
  assert.equal(classifyLeadSource({ referrer: 'https://www.google.com/' }), 'ORGANIC_SEARCH')
  assert.equal(classifyLeadSource({ referrer: 'https://duckduckgo.com/' }), 'ORGANIC_SEARCH')
  assert.equal(classifyLeadSource({ referrer: 'https://www.bing.com/search?q=movers' }), 'ORGANIC_SEARCH')
})

test('a gclid alone proves Google Ads even with no utm at all', () => {
  assert.equal(classifyLeadSource({ gclid: 'Cj0KCQ' }), 'GOOGLE_ADS')
  assert.equal(classifyLeadSource({ gclid: 'Cj0KCQ', referrer: 'https://www.google.com/' }), 'GOOGLE_ADS',
    'a paid click must not be reported as organic search')
})

test('paid mediums resolve to the paying channel', () => {
  assert.equal(classifyLeadSource({ utmSource: 'google', utmMedium: 'cpc' }), 'GOOGLE_ADS')
  assert.equal(classifyLeadSource({ utmSource: 'facebook', utmMedium: 'paid' }), 'FACEBOOK')
})

test('tagged google traffic that is NOT paid stays Google Business, not Ads', () => {
  assert.equal(classifyLeadSource({ utmSource: 'google', utmMedium: 'organic' }), 'GOOGLE')
  assert.equal(classifyLeadSource({ utmSource: 'gbp' }), 'GOOGLE')
})

test('THE DOOR-HANGER REGRESSION: a /qr scan resolves to DOOR_HANGER, not OTHER', () => {
  // These are the exact values public/qr/index.html forwards.
  assert.equal(
    classifyLeadSource({ utmSource: 'print', utmMedium: 'doorhanger', utmCampaign: 'print-doorhanger' }),
    'DOOR_HANGER',
    'a door-hanger QR is the channel that costs money to print — it must not read as a generic QR or as OTHER'
  )
})

test('the short-link channels all resolve', () => {
  assert.equal(classifyLeadSource({ utmSource: 'facebook', utmMedium: 'messenger', utmCampaign: 'fb-messenger' }), 'FACEBOOK')
  assert.equal(classifyLeadSource({ utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'ig-bio' }), 'INSTAGRAM')
  assert.equal(classifyLeadSource({ utmSource: 'tiktok', utmMedium: 'bio', utmCampaign: 'tiktok-bio' }), 'TIKTOK')
})

test('social referrers resolve without any tagging', () => {
  assert.equal(classifyLeadSource({ referrer: 'https://l.facebook.com/' }), 'FACEBOOK')
  assert.equal(classifyLeadSource({ referrer: 'https://www.instagram.com/' }), 'INSTAGRAM')
  assert.equal(classifyLeadSource({ referrer: 'https://www.nextdoor.com/' }), 'MARKETPLACE')
})

test('an internal page marker is NOT a channel', () => {
  assert.ok(isInternalSourceMarker('QUICK_QUOTE_FORM'))
  assert.ok(isInternalSourceMarker('HOME_ESTIMATE_STARTER'))
  assert.equal(
    classifyLeadSource({ source: 'QUICK_QUOTE_FORM' }),
    'DIRECT',
    'attributing a lead to our own widget would bury the real answer'
  )
  assert.equal(
    classifyLeadSource({ source: 'QUICK_QUOTE_FORM', referrer: 'https://www.google.com/' }),
    'ORGANIC_SEARCH',
    'the page marker must not shadow real evidence'
  )
})

test('the raw source string is preserved beside the classified channel', () => {
  const row = buildPartialLeadCreate(quoteInput({ source: 'QUICK_QUOTE_FORM' }), NOW) as unknown as Record<string, unknown>
  assert.equal(row.source, 'DIRECT', 'the CHANNEL is classified from evidence')
  assert.equal(row.sourceDetail, 'QUICK_QUOTE_FORM', 'the RAW string is kept so a mapping fix can be applied later')
})

test('every LeadSource value has a human label', () => {
  for (const v of ['DIRECT', 'ORGANIC_SEARCH', 'GOOGLE_ADS', 'MARKETPLACE', 'QR_CODE', 'UNKNOWN', 'TIKTOK', 'OTHER']) {
    const label = leadSourceLabel(v)
    assert.ok(label && !label.includes('_'), `${v} must have a readable label, got ${label}`)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  9. THE PUBLIC ROUTE'S CONTRACT
// ══════════════════════════════════════════════════════════════════════

const routeSrc = () => readFileSync(path.resolve(__dirname, '..', '..', '..', 'app', 'api', 'leads', 'quote-capture', 'route.ts'), 'utf8')

test('POST /api/leads/quote-capture EXISTS — quote.html has been posting into a 404', () => {
  assert.ok(
    existsSync(path.resolve(__dirname, '..', '..', '..', 'app', 'api', 'leads', 'quote-capture', 'route.ts')),
    'public/quote.html POSTs to /api/leads/quote-capture; without this file every quick-quote lead is silently dropped'
  )
})

test('the route requires the full contact block', () => {
  const src = routeSrc()
  for (const field of ['firstName', 'lastName', 'phone', 'email']) {
    assert.ok(new RegExp(`${field}: z\\.string\\(\\)`).test(src), `${field} must be REQUIRED (no .optional())`)
  }
  assert.ok(/email\(\)/.test(src), 'the email must be format-validated server-side, not just in the browser')
})

test('the route never returns an internal lead id to the browser', () => {
  const src = routeSrc()
  const stripped = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.ok(!/leadId:\s*result/.test(stripped), 'owner requirement 8: no internal identifiers in the browser')
  // The response contract is a typed union that makes a leak a TYPE error.
  const contract = readFileSync(path.resolve(__dirname, '..', 'quote-capture.ts'), 'utf8')
  assert.ok(/leadId\?: never/.test(contract), 'the contract must forbid it at compile time')
})

test('a persistence failure is reported as NOT captured, distinctly from spam', () => {
  const src = routeSrc()
  // The old shape answered { ok:true, captured:false } for a DB failure, which
  // the browser could not tell from a honeypot discard — so it showed the same
  // message for "we lost your details" and "you are a bot". They are now
  // different branches of the typed union.
  assert.ok(/if \(!result\)/.test(src), 'the null-result branch must still exist')
  assert.ok(/error: 'server_error'/.test(src), 'a DB failure must be distinguishable')
  assert.ok(/reason: 'spam_discarded'/.test(src), 'and must not share the honeypot reason')
})

test('THE HONEYPOT IS REACHABLE — a filled trap must not 422 before the discard runs', () => {
  const src = routeSrc()
  // `.max(0)` made the discard branch dead code AND named the trap field back
  // to the bot in the 422 body. The field must PARSE, then be discarded.
  assert.ok(!/company: z\.string\(\)\.max\(0\)/.test(src),
    'a zero-length honeypot rejects at the schema, so the discard branch never runs')
  assert.ok(/company: z\.string\(\)\.trim\(\)\.max\(\d+\)/.test(src),
    'it has to accept a value in order to trap it')
  assert.ok(/LIMITS\.quoteLead/.test(src), 'rate limit')
})

test('the honeypot answers like a success, so a bot learns nothing', () => {
  const src = routeSrc()
  const idx = src.indexOf("reason: 'spam_discarded'")
  assert.ok(idx > 0, 'the discard branch must exist')
  const around = src.slice(Math.max(0, idx - 300), idx + 200)
  assert.ok(/ok: true/.test(around), 'a 4xx would tell the bot exactly which field to leave alone')
})

test('the browser estimate is NEVER what gets stored', () => {
  const src = routeSrc()
  const stripped = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.ok(!/estimatedValue:.*d\.estimateTotal/.test(stripped),
    'storing the client figure let a crafted POST set any price it liked')
  assert.ok(/quoteEstimate\(/.test(src), 'the server must price it')
  assert.ok(/serverCents/.test(src), 'and store its own number')
})

test('the partial route ACCEPTS the fields the booking form now sends', () => {
  // z.object() STRIPS unknown keys rather than rejecting them, so a field the
  // form sends but the schema omits vanishes silently — the exact defect that
  // lost the booking access answers in the 2026-07-28 review.
  const src = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'app', 'api', 'leads', 'partial', 'route.ts'),
    'utf8'
  )
  for (const field of ['contactPreference', 'bestTimeToCall', 'gclid', 'fbclid']) {
    assert.ok(new RegExp(`${field}: str\\(`).test(src), `${field} must be declared in PartialSchema`)
    assert.ok(new RegExp(`${field}: d\\.${field}`).test(src), `${field} must be passed through to the writer`)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  11. PAID-CLICK PRECEDENCE (adversarial-review regressions, 2026-08-03)
// ══════════════════════════════════════════════════════════════════════

test('a gclid OUTRANKS an explicit source string — paid traffic must never look free', () => {
  // booking-form.html derives `source` from utm_source, so a real Google Ads
  // click arrives as source='google' WITH a gclid. Answering GOOGLE (the free
  // Business Profile) would make paid spend invisible.
  assert.equal(
    classifyLeadSource({ source: 'google', utmSource: 'google', gclid: 'Cj0KCQ' }),
    'GOOGLE_ADS'
  )
})

test('a paid medium outranks an explicit source string too', () => {
  assert.equal(classifyLeadSource({ source: 'google', utmSource: 'google', utmMedium: 'cpc' }), 'GOOGLE_ADS')
  assert.equal(classifyLeadSource({ source: 'facebook', utmSource: 'facebook', utmMedium: 'cpc' }), 'FACEBOOK')
})

test('a paid click we cannot place is UNKNOWN, never credited to Google Ads', () => {
  assert.equal(classifyLeadSource({ utmSource: 'bing', utmMedium: 'cpc' }), 'UNKNOWN',
    'crediting Bing spend to Google Ads is worse than admitting we do not know')
  assert.equal(classifyLeadSource({ utmMedium: 'cpc' }), 'UNKNOWN')
})

test('the non-paid channels are unaffected by the precedence change', () => {
  assert.equal(classifyLeadSource({ source: 'facebook' }), 'FACEBOOK')
  assert.equal(classifyLeadSource({ source: 'door-hanger' }), 'DOOR_HANGER')
  assert.equal(classifyLeadSource({ source: 'contact-form' }), 'WEBSITE')
  assert.equal(classifyLeadSource({ utmSource: 'google', utmMedium: 'organic' }), 'GOOGLE')
})

// ══════════════════════════════════════════════════════════════════════
//  12. THE SEND GATE (the defect that made every confirmation silent)
// ══════════════════════════════════════════════════════════════════════

test('a transactional lead reply is NOT judged by the quote-followup journey matrix', () => {
  // quoteFollowupBlockReason refuses any lead without quotedAt ('no_quote').
  // A quick-quote lead NEVER has quotedAt — that column is stamped only by the
  // admin CRM action — so inheriting that rule refused 100% of confirmations,
  // silently, while the "sent" stamp was already written.
  const lead = { email: 'a@b.com', status: 'NEW', quotedAt: null, bookedAt: null, lostAt: null, moveDate: null, convertedBookingId: null }
  assert.equal(quoteFollowupBlockReason(lead as never), 'no_quote', 'the journey rule is unchanged')
  assert.equal(transactionalLeadBlockReason(lead as never), null, 'but an immediate reply must pass')
})

test('the transactional rule still blocks what it must', () => {
  assert.equal(transactionalLeadBlockReason(null), 'lead_deleted')
  assert.equal(transactionalLeadBlockReason({ email: null } as never), 'no_email')
})

test('the worker passes the template into the lead recheck', () => {
  const worker = readFileSync(path.resolve(__dirname, '..', '..', 'workers', 'email.worker.ts'), 'utf8')
  assert.ok(/leadEligibility\(leadId, template\)/.test(worker),
    'without the template every lead-scoped email inherits the quote-followup matrix')
})
