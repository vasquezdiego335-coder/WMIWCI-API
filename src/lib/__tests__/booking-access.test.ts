// Offline unit tests for the structured-access formatter + the sensitive/
// non-sensitive boundary. Run: npm test (tsx --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSections, hasAccessCodes, type AccessBookingInput } from '../booking-access'

const FULL: AccessBookingInput = {
  originUnit: '4B',
  originFloor: 3,
  originHasElevator: false,
  originStairCount: 2,
  originAccessNotes: 'Park in the rear lot, buzz #4 for the building door',
  originAccessCode: '1988#',
  destUnit: 'Suite 200',
  destFloor: 2,
  destHasElevator: true,
  destStairCount: 0,
  destAccessNotes: 'Loading dock on the north side',
  destAccessCode: 'gate-4321',
  truckProvider: 'U-Haul',
  truckSize: '20ft',
  truckReservationStatus: 'reserved',
  truckPickupLocation: 'U-Haul Bloomfield Ave',
  truckReturnResponsibility: 'customer returns',
  equipmentNeeds: 'Piano board + 4 straps',
  crewInstructions: 'Call 10 minutes before arrival',
}

test('access: non-sensitive projection NEVER contains gate/access codes', () => {
  const sections = accessSections(FULL, { includeSensitive: false })
  const blob = JSON.stringify(sections)
  assert.ok(!blob.includes('1988#'), 'pickup code leaked into non-sensitive projection')
  assert.ok(!blob.includes('gate-4321'), 'drop-off code leaked into non-sensitive projection')
  assert.ok(!sections.some((s) => s.sensitive), 'a sensitive section slipped into the non-sensitive projection')
  assert.ok(!sections.some((s) => /Access Codes/i.test(s.title)))
})

test('access: owner projection DOES include the codes in a flagged sensitive section', () => {
  const sections = accessSections(FULL, { includeSensitive: true })
  const codeSection = sections.find((s) => s.sensitive)
  assert.ok(codeSection, 'no sensitive code section in the owner projection')
  assert.match(codeSection!.lines.join('\n'), /1988#/)
  assert.match(codeSection!.lines.join('\n'), /gate-4321/)
})

test('access: pickup and drop-off are always separate sections', () => {
  const sections = accessSections(FULL, { includeSensitive: false })
  const pickup = sections.find((s) => /Pickup Access/i.test(s.title))
  const dropoff = sections.find((s) => /Drop-off Access/i.test(s.title))
  assert.ok(pickup && dropoff)
  assert.match(pickup!.lines.join('\n'), /Unit\/Apt: 4B/)
  assert.match(pickup!.lines.join('\n'), /Floor: 3/)
  assert.match(pickup!.lines.join('\n'), /Elevator: No/)
  assert.match(pickup!.lines.join('\n'), /Stairs: 2 flights/)
  assert.match(dropoff!.lines.join('\n'), /Suite 200/)
  assert.match(dropoff!.lines.join('\n'), /Elevator: Yes/)
  assert.ok(!/Stairs:/.test(dropoff!.lines.join('\n')), 'zero stairs should not render a stairs line')
})

test('access: truck + equipment/crew sections render (non-sensitive)', () => {
  const sections = accessSections(FULL, { includeSensitive: false })
  const truck = sections.find((s) => /Truck/i.test(s.title))
  const crew = sections.find((s) => /Equipment & Crew/i.test(s.title))
  assert.match(truck!.lines.join('\n'), /U-Haul/)
  assert.match(truck!.lines.join('\n'), /20ft/)
  assert.match(crew!.lines.join('\n'), /Piano board/)
  assert.match(crew!.lines.join('\n'), /Call 10 minutes/)
})

test('access: a booking with no structured access yields no sections', () => {
  assert.equal(accessSections({}, { includeSensitive: true }).length, 0)
  assert.equal(hasAccessCodes({}), false)
  assert.equal(hasAccessCodes(FULL), true)
})
