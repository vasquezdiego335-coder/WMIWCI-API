// Offline unit tests for the shared booking-completeness validator.
// Run: npm test (tsx --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingCompleteness, hasBlockingGaps, completenessLines } from '../booking-completeness'

const codes = (b: Parameters<typeof bookingCompleteness>[0]) => bookingCompleteness(b).map((w) => w.code)

test('completeness: a fully specified booking has no warnings', () => {
  const w = bookingCompleteness({
    originAddress: '123 Main St, Newark, NJ 07102',
    destAddress: '45 Oak Ave, Montclair, NJ 07042',
    manualReviewRequired: false,
    truckAddonDueOnMoveDay: false,
  })
  assert.deepEqual(w, [])
  assert.equal(hasBlockingGaps({ originAddress: '123 Main St, Newark, NJ 07102', destAddress: '45 Oak Ave, Montclair, NJ 07042' }), false)
})

test('completeness: the real "Myrtle Ave boonton nj" pickup flags no-street-number + no-ZIP', () => {
  const w = codes({
    originAddress: 'Myrtle Ave boonton nj', // the exact reported partial address
    destAddress: '32 Broadway suite 2 Denville NJ', // has a number, no ZIP
  })
  assert.ok(w.includes('pickup_street_number'), 'pickup missing street number not flagged')
  assert.ok(w.includes('pickup_zip'), 'pickup missing ZIP not flagged')
  // The drop-off HAS a street number (32) but no ZIP → only the ZIP warning.
  assert.ok(!w.includes('dropoff_street_number'))
  assert.ok(w.includes('dropoff_zip'))
})

test('completeness: a missing/unconfirmed address is a BLOCK', () => {
  const w = bookingCompleteness({ originAddress: 'Provided at confirmation', destAddress: '45 Oak Ave, NJ 07042' })
  const block = w.find((x) => x.code === 'pickup_address_missing')
  assert.ok(block)
  assert.equal(block!.severity, 'block')
  assert.equal(hasBlockingGaps({ originAddress: null, destAddress: null }), true)
  // Block-severity sorts to the front.
  assert.equal(bookingCompleteness({ originAddress: null, destAddress: '45 Oak Ave 07042' })[0].severity, 'block')
})

test('completeness: truck pickup & return without reservation data flags each gap', () => {
  const w = codes({
    originAddress: '1 A St, Newark NJ 07102',
    destAddress: '2 B St, Newark NJ 07102',
    truckAddonDueOnMoveDay: true,
  })
  assert.ok(w.includes('truck_provider'))
  assert.ok(w.includes('truck_pickup_location'))
  assert.ok(w.includes('truck_reservation'))
})

test('completeness: a fully specified truck pickup produces no truck warnings', () => {
  const w = codes({
    originAddress: '1 A St, Newark NJ 07102',
    destAddress: '2 B St, Newark NJ 07102',
    truckAddonDueOnMoveDay: true,
    truckProvider: 'U-Haul',
    truckPickupLocation: 'U-Haul Bloomfield Ave',
    truckReservationStatus: 'reserved',
  })
  assert.ok(!w.some((c) => c.startsWith('truck_')))
})

test('completeness: manual review is a (non-blocking) warning', () => {
  const w = bookingCompleteness({ originAddress: '1 A St 07102', destAddress: '2 B St 07102', manualReviewRequired: true })
  const mr = w.find((x) => x.code === 'manual_review')
  assert.ok(mr && mr.severity === 'warn')
})

test('completeness: display lines are emoji-prefixed and safe', () => {
  const lines = completenessLines({ originAddress: 'Myrtle Ave boonton nj', destAddress: '2 B St 07102' })
  assert.ok(lines.every((l) => l.startsWith('⛔') || l.startsWith('⚠️')))
})

const NEAT = { originAddress: '1 A St, Newark NJ 07102', destAddress: '2 B St, Newark NJ 07102' }

test('completeness: flags a bare "street only" line as possibly missing city/state', () => {
  assert.ok(bookingCompleteness({ originAddress: 'Myrtle Ave', destAddress: NEAT.destAddress }).some((w) => w.code === 'pickup_city_state'))
})

test('completeness: stairs in the legacy blob without a structured count is INFO', () => {
  const w = bookingCompleteness({ ...NEAT, itemsDescription: 'Stairs: flights to carry' })
  const s = w.find((x) => x.code === 'stairs_no_count')
  assert.ok(s && s.severity === 'info')
})

test('completeness: heavy items indicated without item details is INFO', () => {
  const w = bookingCompleteness({ ...NEAT, itemsDescription: 'Heavy items: piano and safe' })
  const h = w.find((x) => x.code === 'heavy_no_details')
  assert.ok(h && h.severity === 'info')
  // ...but not when equipment details ARE recorded.
  assert.ok(!bookingCompleteness({ ...NEAT, itemsDescription: 'Heavy items: piano', equipmentNeeds: 'piano board + straps' }).some((x) => x.code === 'heavy_no_details'))
})

test('completeness: internal pricing inconsistency surfaces as a warning', () => {
  const w = bookingCompleteness({ ...NEAT, baseRate: 699, travelFee: 5000, totalEstimate: 999 })
  assert.ok(w.some((x) => x.code === 'pricing_inconsistent'))
  // consistent pricing → no pricing warning
  assert.ok(!bookingCompleteness({ ...NEAT, baseRate: 699, travelFee: 5000, totalEstimate: 749 }).some((x) => x.code === 'pricing_inconsistent'))
})

test('completeness: severities rank block > warn > info', () => {
  const w = bookingCompleteness({ originAddress: null, destAddress: NEAT.destAddress, itemsDescription: 'Stairs: x' })
  assert.equal(w[0].severity, 'block')
  assert.equal(w[w.length - 1].severity, 'info')
})
