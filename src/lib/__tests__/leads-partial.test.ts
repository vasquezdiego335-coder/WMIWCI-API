import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capturePartialLead,
  capturePartialLeadSafe,
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  lifecycleForStep,
  hasPromotionalConsent,
  partialLeadBlockedFromPromo,
  isAbandonable,
  purgeAbandonedLeads,
  ABANDON_AFTER_DAYS,
  PURGE_ABANDONED_AFTER_DAYS,
  type PartialLeadStore,
  type PartialLeadDeps,
  type ExistingPartialLead,
  type LeadRecord,
} from '../leads'

// ════════════════════════════════════════════════════════════════════════
//  Offline tests for PARTIAL booking-lead capture (owner spec 2026-07-24).
//  Pure helpers directly; dedup orchestration against an in-memory store.
// ════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-07-24T12:00:00.000Z')

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('lifecycleForStep: card1/empty = PARTIAL, later steps = IN_PROGRESS, submitted = SUBMITTED', () => {
  assert.equal(lifecycleForStep(undefined), 'PARTIAL')
  assert.equal(lifecycleForStep('card1'), 'PARTIAL')
  assert.equal(lifecycleForStep('card2'), 'IN_PROGRESS')
  assert.equal(lifecycleForStep('card4'), 'IN_PROGRESS')
  assert.equal(lifecycleForStep('submitted'), 'SUBMITTED')
})

test('buildPartialLeadCreate: normalizes email, sets NEW + PARTIAL, session, source, activity', () => {
  const d = buildPartialLeadCreate(
    { email: 'SAM@X.com', firstName: 'Sam', lastName: 'Rivera', phone: '555', bookingSessionId: 'sess-1', formStep: 'card1', source: 'door_hanger', utmCampaign: 'west_orange_july_2026' },
    NOW,
  )
  assert.equal(d.email, 'sam@x.com')
  assert.equal(d.name, 'Sam Rivera')
  assert.equal(d.status, 'NEW')
  assert.equal(d.lifecycle, 'PARTIAL')
  assert.equal(d.bookingSessionId, 'sess-1')
  assert.equal(d.source, 'DOOR_HANGER')
  assert.equal(d.utmCampaign, 'west_orange_july_2026')
  assert.equal(d.lastActivityAt, NOW)
})

test('buildPartialLeadCreate: referral source maps to REFERRAL', () => {
  assert.equal(buildPartialLeadCreate({ email: 'a@b.com', source: 'referral', bookingSessionId: 's' }, NOW).source, 'REFERRAL')
})

test('buildPartialLeadCreate: TRI-STATE consent — true sets true+at+source; undefined sets null', () => {
  const optedIn = buildPartialLeadCreate({ email: 'a@b.com', bookingSessionId: 's', marketingConsent: true }, NOW)
  assert.equal(optedIn.emailMarketingConsent, true)
  assert.equal(optedIn.marketingConsentAt, NOW)
  // Was the ad-hoc `booking_step_1`. Now the controlled-vocabulary value
  // (owner spec 2026-07-28) so consent source is queryable and cannot drift
  // into a free-form string per caller. The MEANING is unchanged: a partial
  // capture with no explicit surface still came from the booking form.
  assert.equal(optedIn.marketingConsentSource, 'BOOKING_FORM')

  // An explicitly supplied surface is honoured.
  const fromQuote = buildPartialLeadCreate(
    { email: 'a@b.com', bookingSessionId: 's', marketingConsent: true, consentSource: 'QUICK_QUOTE_FORM' },
    NOW
  )
  assert.equal(fromQuote.marketingConsentSource, 'QUICK_QUOTE_FORM')

  // An unrecognised string falls back to the safe default rather than being
  // stored raw — storing whatever a caller sends is what filled the lead
  // table with `OTHER` and made attribution unanswerable.
  const junk = buildPartialLeadCreate(
    { email: 'a@b.com', bookingSessionId: 's', marketingConsent: true, consentSource: 'whatever-i-felt-like' },
    NOW
  )
  assert.equal(junk.marketingConsentSource, 'BOOKING_FORM')

  const untouched = buildPartialLeadCreate({ email: 'a@b.com', bookingSessionId: 's' }, NOW)
  assert.equal(untouched.emailMarketingConsent, null)
  assert.equal(untouched.marketingConsentAt, null)

  const withdrew = buildPartialLeadCreate({ email: 'a@b.com', bookingSessionId: 's', marketingConsent: false }, NOW)
  assert.equal(withdrew.emailMarketingConsent, false)
})

function existing(overrides: Partial<ExistingPartialLead> = {}): ExistingPartialLead {
  return {
    id: 'l1', status: 'NEW', name: 'Booking lead', phone: null, email: 'sam@x.com',
    bookingSessionId: 'sess-1', lifecycle: 'PARTIAL', emailMarketingConsent: null, formStep: 'card1',
    quoteConfirmationQueuedAt: null,
    estimatedValue: null, utmSource: null, utmCampaign: null, landingPage: null, referrer: null, promoCode: null,
    notes: null,
    ...overrides,
  }
}

test('buildPartialLeadUpdate: advances lifecycle (never regresses), tracks latest step', () => {
  const forward = buildPartialLeadUpdate(existing({ lifecycle: 'PARTIAL' }), { formStep: 'card3' }, NOW)
  assert.equal(forward.lifecycle, 'IN_PROGRESS')
  assert.equal(forward.formStep, 'card3')

  // A later call that reports an EARLIER step must not drag the lifecycle back.
  const noRegress = buildPartialLeadUpdate(existing({ lifecycle: 'IN_PROGRESS' }), { formStep: 'card1' }, NOW)
  assert.equal(noRegress.lifecycle, 'IN_PROGRESS')
})

test('buildPartialLeadUpdate: fills blanks only, never clobbers curated name/phone', () => {
  const patch = buildPartialLeadUpdate(
    existing({ name: 'Maria Real', phone: '5551112222' }),
    { firstName: 'X', lastName: 'Y', phone: '9999999999' },
    NOW,
  )
  assert.equal(patch.name, 'Maria Real') // real name not clobbered
  assert.equal(patch.phone, '5551112222') // existing phone not clobbered
})

test('buildPartialLeadUpdate: consent untouched when checkbox not interacted (undefined)', () => {
  const patch = buildPartialLeadUpdate(existing({ emailMarketingConsent: true }), { formStep: 'card2' }, NOW)
  assert.equal('emailMarketingConsent' in patch, false) // no consent key at all → DB value preserved
})

test('buildPartialLeadUpdate: explicit false records a withdrawal', () => {
  const patch = buildPartialLeadUpdate(existing({ emailMarketingConsent: true }), { marketingConsent: false }, NOW)
  assert.equal(patch.emailMarketingConsent, false)
})

// ── hasPromotionalConsent + audience exclusion rule ──────────────────────────

test('hasPromotionalConsent: only explicit true + not suppressed passes', () => {
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: true }), true)
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: false }), false)
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: null }), false)
  assert.equal(hasPromotionalConsent({}), false)
  // Suppression always wins, even with consent.
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: true, suppressed: { reason: 'UNSUBSCRIBED' } }), false)
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: true, suppressed: true }), false)
})

test('partialLeadBlockedFromPromo: partial-without-consent excluded; consent/converted/CRM allowed', () => {
  assert.equal(partialLeadBlockedFromPromo({ lifecycle: 'PARTIAL', emailMarketingConsent: null }), true)
  assert.equal(partialLeadBlockedFromPromo({ lifecycle: 'IN_PROGRESS', emailMarketingConsent: false }), true)
  assert.equal(partialLeadBlockedFromPromo({ lifecycle: 'ABANDONED', emailMarketingConsent: null }), true)
  // Opted-in partial lead is promotable.
  assert.equal(partialLeadBlockedFromPromo({ lifecycle: 'PARTIAL', emailMarketingConsent: true }), false)
  // CONVERTED + ordinary CRM leads (lifecycle null) are never blocked by this rule.
  assert.equal(partialLeadBlockedFromPromo({ lifecycle: 'CONVERTED', emailMarketingConsent: null }), false)
  assert.equal(partialLeadBlockedFromPromo({ lifecycle: null, emailMarketingConsent: null }), false)
})

// ── Orchestration with an in-memory store ─────────────────────────────────────

type Row = ExistingPartialLead
function makeStore(seed: Row[] = []) {
  const rows = new Map<string, Row>()
  let seq = seed.length
  for (const s of seed) rows.set(s.id, { ...s })
  const OPEN = ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP']
  const store: PartialLeadStore = {
    async findBySessionId(sessionId) {
      return Array.from(rows.values()).reverse().find((r) => r.bookingSessionId === sessionId && OPEN.includes(r.status)) ?? null
    },
    async findOpenPartialByEmail(email) {
      return Array.from(rows.values()).reverse().find((r) => r.email === email && OPEN.includes(r.status)) ?? null
    },
    async create(data): Promise<LeadRecord> {
      const id = `l${++seq}`
      rows.set(id, {
        id, status: data.status, name: data.name, phone: data.phone, email: data.email,
        bookingSessionId: data.bookingSessionId, lifecycle: data.lifecycle, emailMarketingConsent: data.emailMarketingConsent,
        formStep: data.formStep, estimatedValue: data.estimatedValue, utmSource: data.utmSource, utmCampaign: data.utmCampaign,
        landingPage: data.landingPage, referrer: data.referrer, promoCode: data.promoCode,
      } as Row)
      return { id, status: data.status }
    },
    async update(id, data): Promise<LeadRecord> {
      const cur = rows.get(id)!
      rows.set(id, { ...cur, ...(data as object) } as Row)
      return { id, status: cur.status }
    },
  }
  return { store, rows }
}
const deps = (store: PartialLeadStore): PartialLeadDeps => ({ store, now: () => NOW })

test('incomplete email + no session → NO lead created', async () => {
  const { store, rows } = makeStore()
  const res = await capturePartialLead({ email: 'not-an-email' }, deps(store))
  assert.equal(res, null)
  assert.equal(rows.size, 0)
})

test('valid email → exactly ONE partial lead', async () => {
  const { store, rows } = makeStore()
  const res = await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1', formStep: 'card1' }, deps(store))
  assert.equal(res?.isNew, true)
  assert.equal(rows.size, 1)
})

test('editing the email under the same session → UPDATE the same lead (no duplicate)', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead({ email: 'typo@x.com', bookingSessionId: 'sess-1' }, deps(store))
  const second = await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1' }, deps(store))
  assert.equal(second?.isNew, false)
  assert.equal(rows.size, 1)
})

test('adding name + phone later → UPDATE the same lead', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1' }, deps(store))
  await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1', firstName: 'Sam', lastName: 'Rivera', phone: '5551112222', formStep: 'card2' }, deps(store))
  assert.equal(rows.size, 1)
  const row = Array.from(rows.values())[0]
  assert.equal(row.name, 'Sam Rivera')
  assert.equal(row.phone, '5551112222')
  assert.equal(row.lifecycle, 'IN_PROGRESS')
})

test('refresh (same session, same input) → NO duplicate', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1' }, deps(store))
  await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1' }, deps(store)) // page reloaded, same id
  assert.equal(rows.size, 1)
})

test('email fallback: no session id but same email on an OPEN partial → UPDATE (no dup)', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead({ email: 'sam@x.com', bookingSessionId: 'sess-1' }, deps(store))
  const again = await capturePartialLead({ email: 'sam@x.com' }, deps(store)) // session id lost (cleared storage)
  assert.equal(again?.isNew, false)
  assert.equal(rows.size, 1)
})

test('door-hanger attribution is preserved on the created lead', async () => {
  const { store, rows } = makeStore()
  await capturePartialLead(
    { email: 'sam@x.com', bookingSessionId: 'sess-1', source: 'door_hanger', utmCampaign: 'west_orange_july_2026', landingPage: '/booking-form.html?src=doorhanger_en_v1' },
    deps(store),
  )
  const row = Array.from(rows.values())[0]
  assert.equal(row.utmCampaign, 'west_orange_july_2026')
  assert.match(row.landingPage ?? '', /doorhanger_en_v1/)
})

test('RACE: two concurrent captures for one session produce ONE lead, not two', async () => {
  const { store, rows } = makeStore()
  // Simulate the real race: the create fails (sibling request won), and the
  // sibling's row is now visible. The loser must UPDATE, never duplicate.
  let firstCreate = true
  const racing: PartialLeadStore = {
    ...store,
    async create(data) {
      if (firstCreate) {
        firstCreate = false
        // the "winner" commits its row, then our create loses
        await store.create(data)
        throw new Error('unique constraint violation')
      }
      return store.create(data)
    },
  }
  const res = await capturePartialLead({ email: 'race@x.com', bookingSessionId: 'sess-race' }, deps(racing))
  assert.equal(res?.isNew, false, 'the losing request must fall back to an update')
  assert.equal(rows.size, 1, 'exactly ONE lead may exist for the session')
})

test('RACE: a genuine store failure still surfaces (not silently swallowed here)', async () => {
  const { store } = makeStore()
  const broken: PartialLeadStore = {
    ...store,
    async create() { throw new Error('db down') },
    async findBySessionId() { return null },
    async findOpenPartialByEmail() { return null },
  }
  await assert.rejects(
    () => capturePartialLead({ email: 'x@y.com', bookingSessionId: 's' }, deps(broken)),
    /db down/
  )
})

// ── Abandonment + retention ──────────────────────────────────────────────────

test('isAbandonable: only inactive, unquoted, unconverted partial captures', () => {
  const old = new Date(NOW.getTime() - 30 * 24 * 3600_000)
  const base = { lifecycle: 'PARTIAL', status: 'NEW', quotedAt: null, convertedBookingId: null, lastActivityAt: old }
  assert.equal(isAbandonable(base, NOW), true)
  // recent activity → not abandoned
  assert.equal(isAbandonable({ ...base, lastActivityAt: NOW }, NOW), false)
  // a real quote is not abandonment
  assert.equal(isAbandonable({ ...base, quotedAt: old }, NOW), false)
  // converted / booked / lost are never abandoned
  assert.equal(isAbandonable({ ...base, convertedBookingId: 'b1' }, NOW), false)
  assert.equal(isAbandonable({ ...base, status: 'BOOKED' }, NOW), false)
  assert.equal(isAbandonable({ ...base, status: 'LOST' }, NOW), false)
  // ordinary CRM leads (no partial lifecycle) are out of scope
  assert.equal(isAbandonable({ ...base, lifecycle: null }, NOW), false)
  assert.equal(isAbandonable({ ...base, lifecycle: 'CONVERTED' }, NOW), false)
})

test('retention constants are sane and purge can be disabled', async () => {
  assert.ok(ABANDON_AFTER_DAYS >= 1)
  assert.ok(PURGE_ABANDONED_AFTER_DAYS >= 0)
  // 0 disables purging entirely — proven by the guard in purgeAbandonedLeads
  assert.equal(await purgeAbandonedLeads(NOW, 0), 0)
})

test('capturePartialLeadSafe never throws — a store failure returns null', async () => {
  const throwing: PartialLeadStore = {
    async findBySessionId() { throw new Error('db down') },
    async findOpenPartialByEmail() { throw new Error('db down') },
    async create() { throw new Error('db down') },
    async update() { throw new Error('db down') },
  }
  const res = await capturePartialLeadSafe({ email: 'sam@x.com', bookingSessionId: 'sess-1' }, 'test', deps(throwing))
  assert.equal(res, null)
})
