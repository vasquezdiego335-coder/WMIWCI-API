// ════════════════════════════════════════════════════════════════════════
//  partial-route-persistence.test.ts — the REAL /api/leads/partial handler,
//  the REAL Zod schema, and the EXACT row it writes on CREATE and on UPDATE.
//
//  Two failures this exists to catch, both of which passed the previous round:
//
//   • `buildPartialLeadUpdate()` never wrote `moveSize`. A visitor who changed
//     their move size — or whose first ping arrived before they picked one —
//     kept the original value forever, so the CRM disagreed with the quote
//     beside it. Only the CREATE path was covered, so nothing noticed.
//
//   • review state travelled BESIDE the snapshot rather than inside it, and
//     the route passed only the snapshot, so a 3BR/4BR partial capture lost
//     its review metadata entirely.
//
//  Offline: the store is in-memory, so there is no database, no queue and no
//  notification. What is asserted is the row, not a helper's return value.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PRICE_BOOK_VERSION } from '../pricing-config'
import { __setQuoteCaptureRouteDeps } from '../quote-capture-deps'
import { capturePartialLead, type PartialLeadStore, type ExistingPartialLead } from '../leads'

type RouteModule = { POST: (req: Request) => Promise<Response> }
let POST: RouteModule['POST']

before(async () => {
  ;({ POST } = (await import('../../../app/api/leads/partial/route')) as unknown as RouteModule)
})

/** An in-memory Lead table. `rows` holds exactly what was written. */
function makeStore(seed?: Partial<ExistingPartialLead>) {
  const created: Record<string, unknown>[] = []
  const updated: Record<string, unknown>[] = []
  const existing: ExistingPartialLead | null = seed
    ? ({
        id: 'lead_existing',
        status: 'NEW',
        lifecycle: null,
        bookingSessionId: 'sess-1',
        formStep: null,
        name: null,
        phone: null,
        email: 'fixture@example.com',
        estimatedValue: null,
        quotedAt: null,
        quoteConfirmationQueuedAt: null,
        utmSource: null,
        utmCampaign: null,
        landingPage: null,
        referrer: null,
        promoCode: null,
        notes: null,
        emailMarketingConsent: null,
        marketingConsentAt: null,
        marketingConsentSource: null,
        marketingConsentVersion: null,
        contactPreference: null,
        bestTimeToCall: null,
        ...seed,
      } as ExistingPartialLead)
    : null

  const store: PartialLeadStore = {
    async findBySessionId(id) {
      return existing && existing.bookingSessionId === id ? existing : null
    },
    async findOpenPartialByEmail(email) {
      return existing && existing.email === email ? existing : null
    },
    async create(data) {
      created.push(data as Record<string, unknown>)
      return { id: 'lead_new', status: 'NEW' as never }
    },
    async update(id, data) {
      updated.push(data as Record<string, unknown>)
      return { id, status: 'NEW' as never }
    },
  }
  return { store, created, updated }
}

let harness: ReturnType<typeof makeStore>
let restore: () => void

/** Install a store and route the REAL handler's persistence into it. */
function install(seed?: Partial<ExistingPartialLead>): void {
  harness = makeStore(seed)
  restore = __setQuoteCaptureRouteDeps({
    async partialCapture(input) {
      // The REAL capture logic, against the in-memory store — so create-vs-update
      // and every column mapping is the production one.
      return capturePartialLead(input, { store: harness.store, now: () => new Date('2026-08-22T12:00:00Z') })
    },
  })
}

beforeEach(() => {
  process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED = 'true'
})
afterEach(() => {
  restore?.()
})

async function postPartial(body: Record<string, unknown>): Promise<any> {
  const res = await POST(
    new Request('https://api.example.com/api/leads/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
      body: JSON.stringify(body),
    }) as never,
  )
  return res.json()
}

const base = { email: 'fixture@example.com', bookingSessionId: 'sess-1' }

// ══════════════════════════════════════════════════════════════════════
//  LABOR-ONLY NEVER BANKS A FULL-SERVICE PACKAGE PRICE
// ══════════════════════════════════════════════════════════════════════
test('partial CREATE: labor-only + 1br stores no $550 and no snapshot', async () => {
  install()
  const body = await postPartial({ ...base, moveSize: '1br', serviceInterest: 'loading_only', estimateTotal: 550 })
  assert.equal(body.serviceType, 'labor_only')

  assert.equal(harness.created.length, 1)
  const row = harness.created[0]
  assert.notEqual(row.estimatedValue, 55_000, 'a package price must never attach to an hourly job')
  assert.equal(row.estimatedValue, null)
  assert.equal(row.quoteTotalCents, undefined, 'and no full-service snapshot may be written')
})

test('partial UPDATE: labor-only + 1br stores no $550 on an existing lead either', async () => {
  install({ estimatedValue: null })
  await postPartial({ ...base, moveSize: '1br', serviceTypeKey: 'labor_only', estimateTotal: 550 })

  assert.equal(harness.updated.length, 1, 'the existing lead must be UPDATED, not duplicated')
  const row = harness.updated[0]
  assert.notEqual(row.estimatedValue, 55_000)
  assert.equal(row.quoteTotalCents, undefined)
})

test('partial: the serviceTypeKey alias is honoured, not silently ignored', async () => {
  // The booking form already sends `serviceTypeKey` to /api/bookings. A field
  // the server quietly ignores is a field that reopens the labor-only hole.
  install()
  const body = await postPartial({ ...base, moveSize: '1br', serviceTypeKey: 'labor_only', estimateTotal: 550 })
  assert.equal(body.serviceType, 'labor_only')
  assert.equal(harness.created[0].estimatedValue, null)
})

// ══════════════════════════════════════════════════════════════════════
//  CANONICAL IDENTIFIERS, ON BOTH PATHS
// ══════════════════════════════════════════════════════════════════════
test('partial CREATE: a mixed-case, padded key is stored canonically', async () => {
  install()
  await postPartial({ ...base, moveSize: '  2BR ', serviceType: 'full_service', estimateTotal: 1 })
  const row = harness.created[0]
  assert.equal(row.moveSize, '2br', 'the CANONICAL key the price book returned')
  assert.equal(row.estimatedValue, 77_900, 'and the SERVER price, not the forged $1')
})

test('partial UPDATE: moveSize is written on the update path too', async () => {
  // buildPartialLeadUpdate() never wrote moveSize at all, so an existing lead
  // kept whatever it was first created with.
  install({ estimatedValue: null })
  await postPartial({ ...base, moveSize: '2Br', serviceType: 'full_service' })
  const row = harness.updated[0]
  assert.equal(row.moveSize, '2br', 'an existing lead must record the CURRENT selection')
})

test('partial: a retired key becomes neither the service nor a price, on both paths', async () => {
  for (const [label, seed] of [['create', undefined], ['update', { estimatedValue: null }]] as const) {
    install(seed as never)
    const body = await postPartial({ ...base, moveSize: 'little-studio', serviceType: 'full_service', estimateTotal: 379 })
    assert.equal(body.packageRefused, true, label)
    const row = (seed ? harness.updated : harness.created)[0]
    // undefined on the UPDATE path (the column is simply not written), null on
    // CREATE. Either way: no number, and certainly not the retired one.
    assert.ok(row.estimatedValue == null, `${label}: no retired price, got ${row.estimatedValue}`)
    assert.equal(row.moveSize, undefined, `${label}: and no retired service on a NEW lead`)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  REVIEW STATE SURVIVES INTO THE ROW
// ══════════════════════════════════════════════════════════════════════
test('partial CREATE: a 3BR stores its snapshot AND its review reasons', async () => {
  install()
  const body = await postPartial({ ...base, moveSize: '3br', serviceType: 'full_service' })
  assert.equal(body.requiresReview, true)

  const row = harness.created[0]
  assert.equal(row.quoteTotalCents, 104_900)
  assert.equal(row.quoteMileageStatus, 'pending')
  assert.equal(row.quotePriceBookVersion, PRICE_BOOK_VERSION)
  assert.equal(row.quoteRequiresReview, true, 'review state used to be lost on this path entirely')
  assert.ok(String(row.quoteReviewReasons ?? '').length > 0, 'and the reasons with it')
  assert.equal(row.quoteMileageCents, null, 'a PENDING snapshot carries no calculated mileage')
  assert.equal(row.quoteBillableMiles, null)
})

test('partial CREATE: a 2BR is stored with review OFF', async () => {
  install()
  await postPartial({ ...base, moveSize: '2br', serviceType: 'full_service' })
  const row = harness.created[0]
  assert.equal(row.quoteTotalCents, 77_900)
  assert.equal(row.quoteTruckCents, 0, 'the included 15ft truck adds nothing')
  assert.equal(row.quoteIncludedTruck, '15ft')
  assert.equal(row.quoteRequiresReview, false)
  assert.equal(row.quoteReviewReasons, null)
})

test('partial: the response carries the price book it priced with', async () => {
  install()
  const body = await postPartial({ ...base, moveSize: '2br', serviceType: 'full_service' })
  assert.equal(body.priceBookVersion, PRICE_BOOK_VERSION)
})

test('partial: an unknown service type stores no package price', async () => {
  install()
  const body = await postPartial({ ...base, moveSize: '1br', estimateTotal: 550 })
  assert.equal(body.serviceType, 'unknown', 'no product was declared')
  const row = harness.created[0]
  assert.equal(row.estimatedValue, null, 'guessing full service is how $550 lands on an hourly job')
  assert.equal(row.moveSize, '1br', 'but the size they picked is still recorded, canonically')
})

// ══════════════════════════════════════════════════════════════════════
//  A UTM CAMPAIGN IS NOT A PROMO CODE
// ══════════════════════════════════════════════════════════════════════
test('partial: a utm campaign does NOT become the promo code', async () => {
  // The route wrote `promoCode: d.utmCampaign`, so every door-hanger and QR
  // visit stamped its campaign slug into the DISCOUNT column — a campaign name
  // arriving as an entitlement nobody granted.
  install()
  await postPartial({ ...base, utmCampaign: 'door_hanger_aug', utmSource: 'qr' })
  const row = harness.created[0]
  assert.notEqual(row.promoCode, 'door_hanger_aug', 'a campaign slug must not land in the discount column')
  assert.equal(row.promoCode, null, 'no promo code was offered, so none is recorded')
  // Attribution still lands, in its OWN columns.
  assert.equal(row.utmCampaign, 'door_hanger_aug')
  assert.equal(row.utmSource, 'qr')
})

test('partial: an EXPLICIT promo code is still recorded', async () => {
  install()
  await postPartial({ ...base, promoCode: 'SAVE10', utmCampaign: 'door_hanger_aug' })
  const row = harness.created[0]
  assert.equal(row.promoCode, 'SAVE10', 'a real promo code is a real promo code')
  assert.equal(row.utmCampaign, 'door_hanger_aug', 'and the campaign keeps its own column')
})

// ══════════════════════════════════════════════════════════════════════
//  THE REAL BOOKING-FORM PAYLOAD PRICES
// ══════════════════════════════════════════════════════════════════════
test('partial: the payload booking-form.html actually sends produces a real snapshot', async () => {
  // Built from the fields booking-form.html now sends — not an idealised body.
  // Before this, the form sent only `estimateTotal`, which the API correctly
  // ignores, so every real partial lead stored no estimate at all.
  install()
  const body = await postPartial({
    ...base,
    formStep: 'card2',
    estimateTotal: 879,               // the browser's figure — must be ignored
    serviceTypeKey: 'full_service',   // what the form now sends
    moveSize: '2br',
  })
  assert.equal(body.serviceType, 'full_service')
  const row = harness.created[0]
  assert.equal(row.estimatedValue, 77_900, 'the SERVER price, not the browser $879')
  assert.equal(row.quoteTotalCents, 77_900, 'and a real snapshot, which never used to be written')
  assert.equal(row.quoteMileageStatus, 'pending')
  assert.equal(row.moveSize, '2br')
})

test('partial: the labor-only payload booking-form.html sends prices hourly', async () => {
  // The form sends laborMinutes and NO crew size — it does not ask, and the
  // server defaults to the included two-worker crew.
  install()
  const body = await postPartial({
    ...base,
    serviceTypeKey: 'labor_only',
    serviceInterest: 'loading_and_unloading',
    laborMinutes: 180,               // 3 hours, as the form's hours field × 60
    estimateTotal: 999,              // ignored
  })
  assert.equal(body.serviceType, 'labor_only')
  const row = harness.created[0]
  assert.equal(row.estimatedValue, 45_000, '3h × $150 for the included two-worker crew')
  assert.notEqual(row.estimatedValue, 99_900, 'the browser figure is never stored')
  assert.equal(row.quoteTotalCents, undefined, 'labor-only writes no full-service snapshot')
})

test('partial: labor-only with no hours yet stores nothing rather than guessing', async () => {
  install()
  await postPartial({ ...base, serviceTypeKey: 'labor_only', serviceInterest: 'loading_only', estimateTotal: 450 })
  assert.equal(harness.created[0].estimatedValue, null)
})
