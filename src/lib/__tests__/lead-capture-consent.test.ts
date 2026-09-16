// ════════════════════════════════════════════════════════════════════════
//  lead-capture-consent.test.ts — the lead writer's consent rules that the
//  email consent release (2026-09-16) tightened. Offline; the Prisma client is
//  an in-memory stand-in installed before leads.ts is loaded.
//
//    1. A session-corrected address never inherits the old address's consent
//       or notice basis.
//    2. The partial capture path checks suppression before it stores a
//       consent claim — the lookup ingestLeadSafe always made, this path skipped.
//    3. Booking conversion carries a lead's consent and basis ONLY to the
//       identical address, and keeps the original provenance.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials } from './_disposable-test-env'

assertNoProductionCredentials()

type Row = Record<string, any>
const t = { leads: [] as Row[], customers: [] as Row[], bookings: [] as Row[], suppressions: [] as Row[], customerWrites: [] as Row[] }

;(globalThis as unknown as { prisma: unknown }).prisma = {
  lead: {
    async findFirst({ where }: Row) {
      return (
        t.leads.find(
          (l) =>
            (where.bookingSessionId === undefined || l.bookingSessionId === where.bookingSessionId) &&
            (where.email === undefined || l.email === where.email) &&
            (!where.status?.in || where.status.in.includes(l.status)),
        ) ?? null
      )
    },
    async update({ where, data }: Row) {
      const lead = t.leads.find((l) => l.id === where.id)
      Object.assign(lead as Row, data)
      return lead
    },
  },
  emailSuppression: {
    async findUnique({ where }: Row) {
      return t.suppressions.find((s) => s.email === where.email) ?? null
    },
  },
  customer: {
    async findFirst({ where }: Row) {
      return t.customers.find((c) => c.email === where.email) ?? null
    },
    async updateMany({ where, data }: Row) {
      t.customerWrites.push(data)
      const hits = t.customers.filter((c) => c.email === where.email)
      for (const c of hits) Object.assign(c, data)
      return { count: hits.length }
    },
  },
  booking: {
    async updateMany({ where, data }: Row) {
      const hits = t.bookings.filter((b) => b.id === where.id && (where.basisEventId !== null || b.basisEventId == null))
      for (const b of hits) Object.assign(b, data)
      return { count: hits.length }
    },
  },
}

let leads: typeof import('../leads')
before(async () => {
  leads = await import('../leads')
})

beforeEach(() => {
  for (const k of Object.keys(t) as Array<keyof typeof t>) t[k].length = 0
})

const NOW = new Date('2026-09-20T15:00:00Z')
const LAST_WEEK = new Date('2026-09-13T15:00:00Z')

function existing(over: Partial<import('../leads').ExistingPartialLead> = {}): import('../leads').ExistingPartialLead {
  return {
    id: 'lead_1', status: 'NEW' as never, name: 'Pat', phone: null, email: 'first.address@example.com',
    bookingSessionId: 'sess-1', lifecycle: null, emailMarketingConsent: true, formStep: 'card1',
    estimatedValue: null, quoteConfirmationQueuedAt: null, utmSource: null, utmCampaign: null,
    landingPage: null, referrer: null, promoCode: null, attributionId: null, originZip: null,
    destinationZip: null, notes: null, source: null, marketingConsentPrompted: true, foundUs: null,
    foundUsPrompted: null,
    ...over,
  }
}

// ── 1. SESSION ADDRESS CORRECTION ───────────────────────────────────────

test('a session-corrected address clears the consent AND the notice basis that belonged to the old address', () => {
  const patch = leads.buildPartialLeadUpdate(existing(), { email: 'second.address@example.com', bookingSessionId: 'sess-1' }, NOW, 'session')
  assert.equal(patch.email, 'second.address@example.com', 'the correction itself still lands')
  assert.equal(patch.emailMarketingConsent, null)
  assert.equal(patch.marketingConsentAt, null)
  assert.equal(patch.marketingConsentSource, null)
  assert.equal(patch.marketingConsentVersion, null)
  assert.equal(patch.basisEventId, null)
})

test('a claim in the SAME payload as the correction is judged afresh for the new address (an unchecked box is a decline, not the old opt-in)', () => {
  const declined = leads.buildPartialLeadUpdate(
    existing(),
    { email: 'second.address@example.com', bookingSessionId: 'sess-1', marketingConsent: false, consentSource: 'BOOKING_FORM' },
    NOW,
    'session',
  )
  assert.equal(declined.emailMarketingConsent, false, 'the old true no longer shields the new address from its own decline')
  const optedIn = leads.buildPartialLeadUpdate(
    existing({ emailMarketingConsent: null }),
    { email: 'second.address@example.com', bookingSessionId: 'sess-1', marketingConsent: true, consentSource: 'BOOKING_FORM' },
    NOW,
    'session',
  )
  assert.equal(optedIn.emailMarketingConsent, true)
  assert.equal(optedIn.marketingConsentAt, NOW)
})

test('no correction → consent untouched exactly as before (same address, retyped case, or an email-basis match)', () => {
  for (const [email, basis] of [['first.address@example.com', 'session'], ['FIRST.Address@example.com', 'session'], ['other@example.com', 'email']] as const) {
    const patch = leads.buildPartialLeadUpdate(existing(), { email, bookingSessionId: 'sess-1' }, NOW, basis)
    assert.equal('basisEventId' in patch, false, `${email}/${basis}`)
    assert.equal('emailMarketingConsent' in patch, false, `${email}/${basis}`)
  }
  //  And the standing rule still holds on an unchanged address: an unchecked box never revokes.
  const kept = leads.buildPartialLeadUpdate(existing(), { email: 'first.address@example.com', marketingConsent: false }, NOW, 'session')
  assert.equal('emailMarketingConsent' in kept, false)
})

// ── 2. SUPPRESSION ON THE PARTIAL PATH ──────────────────────────────────

function memoryStore() {
  const created: Row[] = []
  const updated: Row[] = []
  return {
    created,
    updated,
    store: {
      async findBySessionId() {
        return null
      },
      async findOpenPartialByEmail() {
        return null
      },
      async create(data: Row) {
        created.push(data)
        return { id: 'lead_new', status: 'NEW' as never }
      },
      async update(id: string, data: Row) {
        updated.push(data)
        return { id, status: 'NEW' as never }
      },
    },
  }
}

test('partial capture: a SUPPRESSED address that ticks an old page’s box is not stored as consenting (but "we asked" is kept)', async () => {
  const m = memoryStore()
  const lookups: string[] = []
  await leads.capturePartialLead(
    { email: 'Unsubscribed@example.com', bookingSessionId: 's', marketingConsent: true },
    { store: m.store as never, now: () => NOW, isSuppressed: async (e) => (lookups.push(e), true) },
  )
  assert.deepEqual(lookups, ['unsubscribed@example.com'])
  assert.equal(m.created[0].emailMarketingConsent, null)
  assert.equal(m.created[0].marketingConsentAt, null)
  assert.equal(m.created[0].marketingConsentPrompted, true)
})

test('partial capture: no consent claim → no suppression lookup; an unsuppressed claim is stored exactly as today', async () => {
  const m = memoryStore()
  let calls = 0
  const isSuppressed = async () => (calls++, false)
  await leads.capturePartialLead({ email: 'plain@example.com', bookingSessionId: 's' }, { store: m.store as never, now: () => NOW, isSuppressed })
  assert.equal(calls, 0)
  await leads.capturePartialLead({ email: 'yes@example.com', bookingSessionId: 's2', marketingConsent: true }, { store: m.store as never, now: () => NOW, isSuppressed })
  assert.equal(calls, 1)
  assert.equal(m.created[1].emailMarketingConsent, true)
  assert.equal(m.created[1].marketingConsentSource, 'BOOKING_FORM')
  //  An injected store without a lookup keeps its exact historical behaviour.
  await leads.capturePartialLead({ email: 'legacy@example.com', bookingSessionId: 's3', marketingConsent: true }, { store: m.store as never, now: () => NOW })
  assert.equal(m.created[2].emailMarketingConsent, true)
})

test('the production partial deps carry the fail-closed suppression lookup', () => {
  const deps = leads.defaultPartialLeadDeps()
  assert.equal(typeof deps.isSuppressed, 'function')
})

// ── 3. BOOKING CONVERSION ───────────────────────────────────────────────

test('conversionConsentPlan: a lead for a DIFFERENT address carries nothing to the booking address', () => {
  const plan = leads.conversionConsentPlan({
    bookingEmail: 'booker@example.com',
    lead: { email: 'someone.else@example.com', emailMarketingConsent: true, marketingConsentAt: LAST_WEEK, marketingConsentSource: 'QUICK_QUOTE_FORM', marketingConsentVersion: '2026-07-v1', basisEventId: 'evt_notice' },
    explicit: undefined,
    consentSource: 'BOOKING_FORM',
  })
  assert.equal(plan.sameAddress, false)
  assert.equal(plan.customerConsent, undefined)
  assert.equal(plan.leadConsent, undefined)
  assert.equal(plan.copyBasisEventId, null)
})

test('conversionConsentPlan: the identical address inherits the decision WITH its original at/source/version, and the basis', () => {
  const plan = leads.conversionConsentPlan({
    bookingEmail: 'Booker@Example.com',
    lead: { email: 'booker@example.com', emailMarketingConsent: true, marketingConsentAt: LAST_WEEK, marketingConsentSource: 'QUICK_QUOTE_FORM', marketingConsentVersion: '2026-07-v0', basisEventId: 'evt_notice' },
    explicit: undefined,
    consentSource: 'BOOKING_FORM',
  })
  assert.equal(plan.sameAddress, true)
  assert.equal(plan.customerConsent, true)
  assert.deepEqual(plan.provenance, { source: 'QUICK_QUOTE_FORM', version: '2026-07-v0', at: LAST_WEEK })
  assert.equal(plan.copyBasisEventId, 'evt_notice')

  //  The booking's OWN checkbox is a booking-form decision made now.
  const own = leads.conversionConsentPlan({
    bookingEmail: 'booker@example.com',
    lead: { email: 'booker@example.com', emailMarketingConsent: null, marketingConsentSource: null, marketingConsentVersion: null },
    explicit: true,
    consentSource: 'BOOKING_FORM',
  })
  assert.deepEqual(own.provenance, { source: 'BOOKING_FORM', version: '2026-07-v1', at: null })
  assert.equal(own.customerConsent, true)
})

test('markLeadConverted: a session-matched lead with another address converts, but its opt-in never reaches the booking address', async () => {
  t.leads.push({ id: 'lead_s', email: 'typo.address@example.com', bookingSessionId: 'sess-9', status: 'NEW', emailMarketingConsent: true, marketingConsentAt: LAST_WEEK, marketingConsentSource: 'BOOKING_FORM', marketingConsentVersion: '2026-07-v1', basisEventId: 'evt_typo' })
  t.customers.push({ email: 'real.address@example.com', emailMarketingConsent: null })
  t.bookings.push({ id: 'bk_1', basisEventId: null })
  const id = await leads.markLeadConverted('real.address@example.com', 'bk_1', { now: NOW, bookingSessionId: 'sess-9', consentSource: 'BOOKING_FORM' })
  assert.equal(id, 'lead_s')
  assert.equal(t.leads[0].status, 'BOOKED')
  assert.equal(t.customerWrites.length, 0, 'no consent written for the booking address')
  assert.equal(t.bookings[0].basisEventId, null, 'the other address’s notice is not copied')
})

test('markLeadConverted: the same address inherits with ORIGINAL provenance; the basis fills only a booking that has none', async () => {
  t.leads.push({ id: 'lead_q', email: 'same.person@example.com', bookingSessionId: null, status: 'QUOTE_SENT', emailMarketingConsent: true, marketingConsentAt: LAST_WEEK, marketingConsentSource: 'QUICK_QUOTE_FORM', marketingConsentVersion: '2026-07-v1', basisEventId: 'evt_quote' })
  t.customers.push({ email: 'same.person@example.com', emailMarketingConsent: null })
  t.bookings.push({ id: 'bk_2', basisEventId: null }, { id: 'bk_3', basisEventId: 'evt_own_booking_notice' })
  await leads.markLeadConverted('same.person@example.com', 'bk_2', { now: NOW, consentSource: 'BOOKING_FORM' })
  assert.equal(t.customerWrites.length, 1)
  assert.equal(t.customerWrites[0].emailMarketingConsent, true)
  assert.equal(t.customerWrites[0].marketingConsentSource, 'QUICK_QUOTE_FORM', 'not re-labelled as a booking-form opt-in')
  assert.equal(t.customerWrites[0].marketingConsentAt.getTime(), LAST_WEEK.getTime(), 'not re-stamped with today')
  assert.equal(t.bookings[0].basisEventId, 'evt_quote')

  t.leads[0].status = 'NEW'
  await leads.markLeadConverted('same.person@example.com', 'bk_3', { now: NOW, consentSource: 'BOOKING_FORM' })
  assert.equal(t.bookings[1].basisEventId, 'evt_own_booking_notice', 'the booking submit’s own notice is never replaced')
})

test('markLeadConverted: a suppressed address still gets no consent write (unchanged rule)', async () => {
  t.leads.push({ id: 'lead_x', email: 'suppressed.booker@example.com', status: 'NEW', emailMarketingConsent: null, marketingConsentSource: null, marketingConsentVersion: null, basisEventId: null })
  t.customers.push({ email: 'suppressed.booker@example.com', emailMarketingConsent: null })
  t.suppressions.push({ email: 'suppressed.booker@example.com' })
  await leads.markLeadConverted('suppressed.booker@example.com', 'bk_4', { now: NOW, marketingConsent: true, consentSource: 'BOOKING_FORM' })
  assert.equal(t.customerWrites.length, 0)
  assert.equal(t.leads[0].emailMarketingConsent, null)
})
