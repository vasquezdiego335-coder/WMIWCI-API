// ════════════════════════════════════════════════════════════════════════
//  quote-snapshot-notifications.test.ts
//
//  TWO THINGS THE PREVIOUS ROUND GOT WRONG.
//
//  1. The plain-Discord test built an ideal object by hand and asserted the
//     FORMATTER. The formatter was already correct. What was missing was the
//     WIRING: `notifyOwnerOfNewLead`'s Prisma projection did not select a
//     single `quote_*` column, and `postLeadNoticeDirect` hand-listed fifteen
//     fields and none of the snapshot ones. So in production the notice had no
//     snapshot to render and printed a bare total that read as final — and no
//     test could tell, because no test used the production mapping.
//
//     Everything below goes through `toLeadAlertInput()`, which is the mapping
//     BOTH production callers now use, starting from a row shaped exactly like
//     the Prisma projection.
//
//  2. `mileageStatus: 'calculated'` was allowed with null cents and null miles
//     — a total claiming to contain a drive with nothing to show for it. The
//     snapshot constructors now refuse that, and the negative cases are here.
//
//  Offline: no database, no Discord, no email.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  pendingSnapshot,
  calculatedSnapshot,
  snapshotColumns,
  reviewOnlyColumns,
  notificationQuoteOf,
  quotedCentsOf,
  QUOTE_SNAPSHOT_SELECT,
} from '../quote-snapshot'
import { toLeadAlertInput, formatLeadAlert } from '../lead-alert'
import { buildLeadCard } from '../booking-display'
import { PRICE_BOOK_VERSION } from '../pricing-config'

/** A row exactly as the Prisma projection returns it. Overridable per test. */
function leadRow(over: Record<string, unknown> = {}): any {
  return {
    id: 'lead_1',
    name: 'Sam Rivera',
    email: 'customer@example.com',
    phone: '8625550142',
    source: 'QUICK_QUOTE_FORM',
    moveSize: '2br',
    moveDate: new Date('2026-09-14T00:00:00.000Z'),
    originZip: '08817',
    destinationZip: '07030',
    emailMarketingConsent: true,
    landingPage: null,
    utmSource: null,
    utmCampaign: null,
    formStep: 'quote',
    // The frozen snapshot as stored.
    estimatedValue: 77_900,
    quoteBaseCents: 77_900,
    quoteTruckCents: 0,
    quoteTotalCents: 77_900,
    quoteIncludedTruck: '15ft',
    quoteMileageStatus: 'pending',
    quotePriceBookVersion: PRICE_BOOK_VERSION,
    quoteMileageCents: null,
    quoteBillableMiles: null,
    quoteRequiresReview: false,
    quoteReviewReasons: null,
    ...over,
  }
}

const plainText = (row: any): string =>
  formatLeadAlert(toLeadAlertInput(row)).lines.map((l) => l.message).join('\n')

// ══════════════════════════════════════════════════════════════════════
//  1. THE PRODUCTION MAPPING CARRIES THE WHOLE SNAPSHOT
// ══════════════════════════════════════════════════════════════════════
test('the production mapping carries every snapshot field to the notice', () => {
  const input = toLeadAlertInput(leadRow())
  // Not "some of them". A single dropped field silently removes a disclosure.
  assert.equal(input.quoteTotalCents, 77_900)
  assert.equal(input.quoteBaseCents, 77_900)
  assert.equal(input.quoteTruckCents, 0)
  assert.equal(input.quoteIncludedTruck, '15ft')
  assert.equal(input.quoteMileageStatus, 'pending')
  assert.equal(input.quotePriceBookVersion, PRICE_BOOK_VERSION)
  assert.equal(input.quoteMileageCents, null)
  assert.equal(input.quoteBillableMiles, null)
  assert.equal(input.quoteRequiresReview, false)
  assert.deepEqual(input.reviewReasons, [])
})

test('the Prisma projection selects everything the mapping reads', () => {
  // A projection that omits a column makes the mapping return null for it and
  // the disclosure disappears — which is exactly what happened.
  for (const col of [
    'estimatedValue', 'quoteBaseCents', 'quoteTruckCents', 'quoteTotalCents',
    'quoteIncludedTruck', 'quoteMileageStatus', 'quotePriceBookVersion',
    'quoteMileageCents', 'quoteBillableMiles', 'quoteRequiresReview', 'quoteReviewReasons',
  ]) {
    assert.equal((QUOTE_SNAPSHOT_SELECT as Record<string, boolean>)[col], true, `${col} must be selected`)
  }
})

test('both production notice paths go through the shared mapping', () => {
  // A WIRING check, and labelled as one: the behaviour is covered above and
  // below. What this catches is a future caller quietly hand-rolling the
  // mapping again, which is the failure that produced this whole section.
  const leads = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  const capture = readFileSync(resolve(__dirname, '../quote-capture.ts'), 'utf8')
  assert.match(leads, /notifyNewLead\(toLeadAlertInput\(lead\)\)/, 'notifyOwnerOfNewLead must use the mapping')
  assert.match(leads, /\.\.\.QUOTE_SNAPSHOT_SELECT/, 'and select the snapshot columns')
  assert.match(capture, /notifyNewLead\(\s*toLeadAlertInput\(/, 'postLeadNoticeDirect must use the mapping')
})

// ══════════════════════════════════════════════════════════════════════
//  2. THE SNAPSHOT BEATS THE MUTABLE COLUMN — THROUGH THE REAL MAPPING
// ══════════════════════════════════════════════════════════════════════
test('a conflicting estimatedValue loses to the frozen snapshot everywhere', () => {
  // The live CRM column has drifted (an admin edit, a later capture) away from
  // what was actually quoted and emailed.
  const row = leadRow({ estimatedValue: 87_900, quoteTotalCents: 77_900 })

  // (a) the shared resolver, which the EMAIL formats through
  assert.equal(quotedCentsOf(row), 77_900)

  // (b) the plain Discord fallback, via the production mapping
  const plain = plainText(row)
  assert.match(plain, /\$779/, 'the fallback must show the quoted figure')
  assert.ok(!/\$879/.test(plain), 'and must not show the drifted one')
  assert.match(plain, /package subtotal/i)
  assert.match(plain, /Transportation pending/i)
  assert.match(plain, /\$3 per routed mile/i)
  assert.match(plain, /fuel included/i)

  // (c) the rich Discord card, from the same derived quote
  const q = notificationQuoteOf(row)
  // ── READ THE ESTIMATE FIELD, NOT THE WHOLE CARD ────────────────────
  //  This used to JSON.stringify the entire card and assert
  //  `!rich.includes('879')`. The card carries
  //  `timestamp: new Date().toISOString()` (booking-display.ts:497), so the
  //  serialised blob contains a fresh timestamp on every run — and an ISO
  //  timestamp's millisecond field is three digits, which lands on "879"
  //  roughly once in a thousand runs. The assertion was therefore structurally
  //  flaky: it could fail with nothing wrong, and the failure looked like a
  //  pricing regression.
  //
  //  It is also weaker than it appears. Searching a whole card for a bare
  //  three-character substring would pass if "$879" appeared under a different
  //  label, and would fail on any unrelated field that happened to contain
  //  those digits. Naming the field fixes both problems at once.
  const card = buildLeadCard({
    leadId: row.id,
    name: row.name,
    estimateDollars: q.quotedCents! / 100,
    quoteMileageStatus: q.mileageStatus,
    quoteBaseDollars: q.baseCents! / 100,
    quoteTruckDollars: q.truckCents! / 100,
    quoteIncludedTruck: q.includedTruck,
    adminUrl: 'https://example.com/admin',
  } as never)

  const fields = (card.embeds?.[0] as { fields?: Array<{ name: string; value: string }> })?.fields ?? []
  const estimateField = fields.find((f) => /Estimate/i.test(f.name))
  assert.ok(estimateField, `the card must have an Estimate field; got: ${fields.map((f) => f.name).join(', ')}`)

  const value = estimateField!.value
  assert.match(value, /\$779/, `the Estimate field must show the quoted figure: ${value}`)
  assert.doesNotMatch(value, /\$879/, `the Estimate field must not show the drifted value: ${value}`)
  assert.match(value, /package subtotal/i, 'and must caption it as a subtotal')
  assert.match(value, /Transportation pending/i, 'and say the drive is not in that number yet')

  // The timestamp is a real field and it is allowed to contain any digits it
  // likes. Pinned so nobody "fixes" the flake by deleting the timestamp.
  const stamped = JSON.stringify(card)
  assert.match(stamped, /"timestamp":"\d{4}-\d{2}-\d{2}T/, 'the card still carries its timestamp')
})

test('a HISTORICAL lead with no snapshot keeps its original wording', () => {
  const row = leadRow({
    estimatedValue: 37_900,
    quoteTotalCents: null, quoteBaseCents: null, quoteTruckCents: null,
    quoteIncludedTruck: null, quoteMileageStatus: null, quotePriceBookVersion: null,
  })
  const plain = plainText(row)
  assert.match(plain, /\$379/, 'history renders its original amount')
  assert.ok(!/package subtotal/i.test(plain), 'and is not retro-labelled with language it never had')
  assert.ok(!/Transportation pending/i.test(plain))
})

test('a snapshot with an unreadable mileage state SUPPRESSES the amount', () => {
  // Neither "final" nor "subtotal" would be honest, so no figure is shown.
  const row = leadRow({ quoteMileageStatus: 'something_else' })
  const plain = plainText(row)
  assert.ok(!/\$779/.test(plain), 'an uninterpretable snapshot must not present a figure')
  assert.ok(!/package subtotal/i.test(plain))
})

test('review reasons reach the plain notice through the mapping', () => {
  const row = leadRow({
    quoteRequiresReview: true,
    quoteReviewReasons: '3BR is a starting price — confirm inventory, access and the truck plan.\nA larger truck was requested.',
  })
  const plain = plainText(row)
  assert.match(plain, /Manual review/i)
  assert.match(plain, /starting price/i)
  assert.match(plain, /larger truck/i)
})

// ══════════════════════════════════════════════════════════════════════
//  3. CALCULATED MILEAGE IS A REAL INVARIANT
// ══════════════════════════════════════════════════════════════════════
const CORE = {
  baseCents: 77_900,
  truckCents: 0,
  includedTruck: '15ft',
  priceBookVersion: PRICE_BOOK_VERSION,
  requiresReview: false,
  reviewReasons: [] as string[],
}

test('a pending snapshot carries NO calculated-mileage values', () => {
  const built = pendingSnapshot({ ...CORE, totalCents: 77_900 })
  assert.ok(built.ok)
  if (!built.ok) return
  assert.equal(built.snapshot.mileageStatus, 'pending')
  assert.equal(built.snapshot.mileageCents, undefined)
  assert.equal(built.snapshot.billableMiles, undefined)
  const cols = snapshotColumns(built.snapshot)
  assert.equal(cols.quoteMileageCents, null, 'and the columns must be NULL, not 0')
  assert.equal(cols.quoteBillableMiles, null)
})

test('a calculated snapshot REQUIRES the money and the miles, and they must agree', () => {
  // 24 routed miles at $3 = $72, on top of a $779 package.
  const ok = calculatedSnapshot({ ...CORE, mileageCents: 7_200, billableMiles: 24 })
  assert.ok(ok.ok, ok.ok ? '' : ok.reason)
  if (!ok.ok) return
  assert.equal(ok.snapshot.mileageStatus, 'calculated')
  assert.equal(ok.snapshot.totalCents, 77_900 + 7_200, 'the total must CONTAIN the drive')
  assert.equal(ok.snapshot.mileageCents, 7_200)
  assert.equal(ok.snapshot.billableMiles, 24)
  const cols = snapshotColumns(ok.snapshot)
  assert.equal(cols.quoteMileageCents, 7_200, 'and both are persisted')
  assert.equal(cols.quoteBillableMiles, 24)
})

test('invalid calculated combinations are REFUSED, not stored', () => {
  const cases: Array<[string, Parameters<typeof calculatedSnapshot>[0]]> = [
    ['zero miles', { ...CORE, mileageCents: 0, billableMiles: 0 }],
    ['negative miles', { ...CORE, mileageCents: 300, billableMiles: -1 }],
    ['fractional miles', { ...CORE, mileageCents: 750, billableMiles: 2.5 }],
    ['negative money', { ...CORE, mileageCents: -300, billableMiles: 1 }],
    ['money that does not match the miles', { ...CORE, mileageCents: 9_999, billableMiles: 24 }],
  ]
  for (const [label, input] of cases) {
    const r = calculatedSnapshot(input)
    assert.equal(r.ok, false, `${label}: must be refused`)
  }
})

test('a snapshot cannot claim review with no reason, or reasons with no review', () => {
  assert.equal(pendingSnapshot({ ...CORE, totalCents: 77_900, requiresReview: true }).ok, false)
  assert.equal(
    pendingSnapshot({ ...CORE, totalCents: 77_900, reviewReasons: ['because'] }).ok,
    false,
    'reasons without the flag would never be displayed',
  )
})

test('a pending total that is not base + truck is refused', () => {
  assert.equal(pendingSnapshot({ ...CORE, totalCents: 99_999 }).ok, false)
})

test('review-only columns exist for a lead with no numeric quote', () => {
  // 5BR and in-person: a human is needed and there is deliberately no total.
  const cols = reviewOnlyColumns(['This move may need more than one truck.'])
  assert.equal(cols.quoteRequiresReview, true)
  assert.match(String(cols.quoteReviewReasons), /more than one truck/)
  assert.equal(reviewOnlyColumns([]).quoteRequiresReview, false)
  assert.equal(reviewOnlyColumns([]).quoteReviewReasons, null)
})

test('the rich card explains a calculated mileage line', () => {
  const rich = JSON.stringify(
    buildLeadCard({
      leadId: 'lead_2',
      name: 'Sam',
      estimateDollars: 851,
      quoteMileageStatus: 'calculated',
      quoteBaseDollars: 779,
      quoteTruckDollars: 0,
      quoteIncludedTruck: '15ft',
      quoteBillableMiles: 24,
      quoteMileageDollars: 72,
      adminUrl: 'https://example.com/admin',
    } as never),
  )
  assert.match(rich, /24 routed miles/i, 'a total containing a drive must explain it')
  assert.match(rich, /\$72/)
  assert.ok(!/Transportation pending/i.test(rich), 'a priced drive is not pending')
})
