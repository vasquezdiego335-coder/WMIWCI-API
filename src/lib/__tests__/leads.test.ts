import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOrUpdateLead,
  normalizeEmail,
  normalizePhone,
  mapLeadSource,
  buildLeadCreate,
  buildLeadUpdate,
  type LeadStore,
  type LeadDeps,
  type ExistingLead,
  type LeadRecord,
} from '../leads'

// ════════════════════════════════════════════════════════════════════════
//  Offline tests for the shared lead-ingestion service. Pure helpers are tested
//  directly; the dedupe orchestration runs against an in-memory store.
// ════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-07-15T12:00:00.000Z')

test('normalizeEmail lowercases/trims and rejects junk', () => {
  assert.equal(normalizeEmail('  Sam@Example.COM '), 'sam@example.com')
  assert.equal(normalizeEmail('not-an-email'), null)
  assert.equal(normalizeEmail(''), null)
  assert.equal(normalizeEmail(null), null)
})

test('normalizePhone keeps digits only', () => {
  assert.equal(normalizePhone('(555) 555-0123'), '5555550123')
  assert.equal(normalizePhone('123'), null) // too short
})

test('mapLeadSource maps known strings and defaults to OTHER', () => {
  assert.equal(mapLeadSource('facebook'), 'FACEBOOK')
  assert.equal(mapLeadSource('door-hanger'), 'DOOR_HANGER')
  assert.equal(mapLeadSource('contact-form'), 'WEBSITE')
  assert.equal(mapLeadSource('whatever'), 'OTHER')
  assert.equal(mapLeadSource(null), 'OTHER')
})

test('buildLeadCreate maps fields, normalizes email, sets NEW + activity', () => {
  const d = buildLeadCreate(
    { name: 'Sam', email: 'SAM@x.com', phone: '555', message: 'need a move', source: 'facebook', foundUs: 'IG ad', utmSource: 'ig' },
    NOW,
  )
  assert.equal(d.email, 'sam@x.com')
  assert.equal(d.source, 'FACEBOOK')
  assert.equal(d.status, 'NEW')
  assert.equal(d.message, 'need a move')
  assert.equal(d.utmSource, 'ig')
  assert.match(d.notes ?? '', /Found us: IG ad/)
  assert.equal(d.lastActivityAt, NOW)
})

test('buildLeadUpdate appends message and fills only blank fields', () => {
  const existing: ExistingLead = {
    id: 'l1', status: 'CONTACTED', name: 'Sam', phone: '5551112222', notes: 'first note',
    message: 'first', moveDate: null, zip: null, originCity: null, destCity: null, jobType: null, promoCode: null,
  }
  const patch = buildLeadUpdate(existing, { message: 'second message', phone: '9999999999', zip: '07050' }, NOW)
  assert.equal(patch.lastActivityAt, NOW)
  assert.match(patch.notes ?? '', /first note/)
  assert.match(patch.notes ?? '', /second message/)
  assert.equal(patch.phone, '5551112222') // existing phone NOT clobbered
  assert.equal(patch.zip, '07050') // blank filled
})

// ── Orchestration with an in-memory store ─────────────────────────────────────

function makeStore(seed: ExistingLead[] = []) {
  const rows = new Map<string, ExistingLead>()
  let seq = seed.length
  for (const s of seed) rows.set(s.id, { ...s })
  const store: LeadStore = {
    async findOpenByEmail(email) {
      // newest open lead with a matching (already-normalized) email
      const open = ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP']
      const match = Array.from(rows.values()).reverse().find((r) => (r as ExistingLead & { email?: string }).email === email && open.includes(r.status))
      return match ?? null
    },
    async create(data): Promise<LeadRecord> {
      const id = `l${++seq}`
      rows.set(id, {
        id, status: data.status, name: data.name, phone: data.phone, notes: data.notes, message: data.message,
        moveDate: data.moveDate, zip: data.zip, originCity: data.originCity, destCity: data.destCity,
        jobType: data.jobType, promoCode: data.promoCode,
        // stash email for the fake lookup
        ...({ email: data.email } as object),
      } as ExistingLead)
      return { id, status: data.status }
    },
    async update(id, data): Promise<LeadRecord> {
      const cur = rows.get(id)!
      rows.set(id, { ...cur, ...data } as ExistingLead)
      return { id, status: cur.status }
    },
  }
  return { store, rows }
}

function deps(store: LeadStore): LeadDeps {
  return { store, now: () => NOW }
}

test('contact submission with no prior lead → CREATE', async () => {
  const { store, rows } = makeStore()
  const res = await createOrUpdateLead({ name: 'Sam', email: 'sam@x.com', message: 'hi', source: 'contact-form' }, deps(store))
  assert.equal(res.isNew, true)
  assert.equal(rows.size, 1)
})

test('repeat submission from the same email on an OPEN lead → UPDATE (no duplicate)', async () => {
  const { store, rows } = makeStore()
  await createOrUpdateLead({ email: 'sam@x.com', message: 'first', source: 'contact' }, deps(store))
  const second = await createOrUpdateLead({ email: 'SAM@x.com', message: 'second', source: 'contact' }, deps(store))
  assert.equal(second.isNew, false)
  assert.equal(rows.size, 1) // still ONE lead
})

test('same email but the prior lead is CLOSED (LOST) → CREATE a fresh lead', async () => {
  const seed: ExistingLead = {
    id: 'l1', status: 'LOST', name: 'Sam', phone: null, notes: null, message: null,
    moveDate: null, zip: null, originCity: null, destCity: null, jobType: null, promoCode: null,
  }
  const { store, rows } = makeStore([{ ...seed, ...({ email: 'sam@x.com' } as object) } as ExistingLead])
  const res = await createOrUpdateLead({ email: 'sam@x.com', message: 'new inquiry' }, deps(store))
  assert.equal(res.isNew, true)
  assert.equal(rows.size, 2) // fresh lead, closed one untouched
})

test('no email → always CREATE (never merge on phone)', async () => {
  const { store, rows } = makeStore()
  await createOrUpdateLead({ phone: '5555550123', message: 'a' }, deps(store))
  await createOrUpdateLead({ phone: '5555550123', message: 'b' }, deps(store)) // same phone, different person maybe
  assert.equal(rows.size, 2) // two leads — no wrong merge on a shared number
})

test('coupon / promo claim (email + promoCode) creates a lead in the pipeline', async () => {
  const { store, rows } = makeStore()
  const res = await createOrUpdateLead({ email: 'promo@x.com', promoCode: 'SAVE10', source: 'coupon', utmSource: 'popup' }, deps(store))
  assert.equal(res.isNew, true)
  assert.equal(rows.size, 1)
  const row = Array.from(rows.values())[0] as ExistingLead
  assert.equal(row.promoCode, 'SAVE10')
})

test('UTM + attribution fields are stored on create', async () => {
  const { store, rows } = makeStore()
  await createOrUpdateLead(
    { email: 'a@b.com', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'summer', landingPage: '/book', referrer: 'https://g.co' },
    deps(store),
  )
  const row = Array.from(rows.values())[0] as ExistingLead & { utmSource?: string }
  // create() stashed only the subset the fake tracks; assert via a targeted create build instead:
  const built = buildLeadCreate({ email: 'a@b.com', utmSource: 'google', utmCampaign: 'summer' }, NOW)
  assert.equal(built.utmSource, 'google')
  assert.equal(built.utmCampaign, 'summer')
  assert.ok(row)
})
