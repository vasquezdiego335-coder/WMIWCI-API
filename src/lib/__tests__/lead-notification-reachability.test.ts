// ════════════════════════════════════════════════════════════════════════
//  lead-notification-reachability.test.ts — DECLARED IS NOT THE SAME AS
//  REACHABLE.
//
//  Two states in this system were fully built, fully rendered, fully tested —
//  and could never occur. A test suite that exercises a state by constructing
//  it directly proves the renderer works; it says nothing about whether any
//  production code path can ever put the system there. Both were found by
//  asking "who WRITES this?" rather than "who reads it?".
//
//   1. `LeadNotificationEvent` declared `'lead_enriched'`, and the Prisma
//      schema comment advertised it. No route, worker or script ever recorded
//      one. Anyone asking "does the owner hear when a partial lead fills in?"
//      would have read the type and concluded yes.
//
//   2. `TransportationState` has `ROUTED` and `ROUTING_FAILED`, with distinct
//      owner-facing labels and a `needsTravelReview` rule keyed on the second.
//      Neither can occur FOR A LEAD: nothing writes `quote_mileage_status` to
//      `'calculated'` or `'routing_failed'`. `calculatedSnapshot()` — the only
//      function that produces a routed snapshot — has no production caller.
//      `/api/route-estimate` really does measure the drive, and persists
//      nothing. So a lead card says "Pending — awaiting pickup and destination
//      addresses" for the whole life of the lead, and the incident that started
//      all of this ("Transportation pending — $3 per routed mile") was not a
//      rendering bug at all. It was the only state a lead can reach.
//
//  These tests PIN both facts. If someone adds a producer, the matching test
//  fails and points at the rest of the wiring that has to come with it. That is
//  the intent: not to forbid the feature, but to stop it being half-added, and
//  to stop the states being read as live while they are not.
//
//  Offline. Source analysis plus the pure state function — no database.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transportation, MILEAGE_STATUS, type TransportationState } from '../lead-state'

const API_ROOT = resolve(__dirname, '../../..')

/** Files git tracks under a path, excluding tests. Shipped code only. */
function shippedFiles(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...paths], { cwd: API_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'))
}

const SHIPPED = shippedFiles('app', 'src', 'scripts', 'prisma').map((f) => ({
  path: f,
  //  Comments blanked LENGTH-PRESERVINGLY so prose that MENTIONS an identifier
  //  can never be mistaken for code that produces it. Every finding below was
  //  originally obscured by exactly that: a comment naming the state read like
  //  a call site in a plain grep.
  code: readFileSync(resolve(API_ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/^\s*\/\/\/.*$/gm, (m) => ' '.repeat(m.length)),
}))

function producersOf(needle: RegExp): string[] {
  return SHIPPED.filter((f) => needle.test(f.code)).map((f) => f.path)
}

// ── 1. EVERY DECLARED NOTIFICATION EVENT HAS A PRODUCER ───────────────
test('every declared lead-notification event is actually produced by shipped code', () => {
  const src = readFileSync(resolve(API_ROOT, 'src/lib/lead-notification-outbox.ts'), 'utf8')
  const decl = src.match(/export type LeadNotificationEvent =([^\n]*(?:\n(?!\s*(?:export|\/\*))[^\n]*)*)/)
  assert.ok(decl, 'the event union must be findable')
  const declared = Array.from(decl[1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1])
  assert.ok(declared.length > 0, 'at least one event is declared')

  for (const event of declared) {
    //  A producer records the event. The declaration itself and this test are
    //  excluded: a type naming a string is not a call site.
    const hits = producersOf(new RegExp(`recordLeadNotification\\([^)]*'${event}'|eventType:\\s*'${event}'`)).filter(
      (f) => f !== 'src/lib/lead-notification-outbox.ts',
    )
    assert.ok(
      hits.length > 0,
      `'${event}' is declared but NOTHING PRODUCES IT. Either wire a producer or remove it ` +
        `from LeadNotificationEvent — a declared event the owner never receives reads as a ` +
        `feature that exists.`,
    )
  }
})

test("'lead_created' is produced inside the SAME transaction as the lead", () => {
  const leads = readFileSync(resolve(API_ROOT, 'src/lib/leads.ts'), 'utf8')
  const tx = leads.indexOf('prisma.$transaction')
  assert.ok(tx > -1, 'the capture path opens a transaction')
  const created = leads.indexOf("eventType: 'lead_created'")
  assert.ok(created > tx, 'the notification row is written inside that transaction')
  //  The close of the transaction callback is after the event write — asserted
  //  by the concurrency suite against real PostgreSQL. What is pinned HERE is
  //  only that the write has not drifted back out of the block.
  const publish = leads.indexOf('leadNotificationQueue', tx)
  if (publish > -1) {
    assert.ok(publish > created, 'publication follows the durable write, never precedes it')
  }
})

// ── 2. TRANSPORTATION: WHICH STATES A LEAD CAN ACTUALLY REACH ─────────
/** Every state the pure function can return, by construction. */
const ALL_STATES: TransportationState[] = [
  'WAITING_FOR_ADDRESSES',
  'READY_TO_ROUTE',
  'ROUTED',
  'ROUTING_FAILED',
  'NOT_APPLICABLE',
  'UNKNOWN_LEGACY',
]

test('the routed-snapshot builder has NO production caller — so ROUTED is unreachable for a lead', () => {
  const callers = producersOf(/calculatedSnapshot\s*\(/).filter((f) => f !== 'src/lib/quote-snapshot.ts')
  assert.deepEqual(
    callers,
    [],
    `calculatedSnapshot() now has a caller (${callers.join(', ')}). If a lead can finally be ` +
      `ROUTED, this test is the wrong shape — replace it with one that drives the real path, ` +
      `and check that the owner card, needsTravelReview and the customer-facing total all agree.`,
  )
})

test("nothing writes 'calculated' or 'routing_failed' onto a lead", () => {
  for (const status of [MILEAGE_STATUS.calculated, MILEAGE_STATUS.routingFailed]) {
    //  A WRITE is an assignment into the column, not a comparison against it.
    const writers = producersOf(new RegExp(`quoteMileageStatus\\s*:\\s*'${status}'`))
    assert.deepEqual(writers, [], `something now writes quoteMileageStatus='${status}' (${writers.join(', ')})`)
  }
})

test('/api/route-estimate measures the drive and persists nothing', () => {
  const route = SHIPPED.find((f) => f.path === 'app/api/route-estimate/route.ts')
  assert.ok(route, 'the routing endpoint exists')
  //  This is the whole gap in one assertion: the miles are computed and thrown
  //  away. It is not a bug in the endpoint — it is a display API — but it does
  //  mean the measurement never reaches the lead.
  assert.ok(route.code.includes('computeRouteDistance('), 'it really does route')
  assert.ok(!/prisma\./.test(route.code), 'and it writes nothing')
})

test('a lead can therefore only reach four of the six transportation states', () => {
  //  Driven through the PURE function using the only column values production
  //  can produce: 'pending' (written by the quote snapshot), null (legacy), and
  //  the labor-only product.
  const reached = new Set<TransportationState>()
  reached.add(transportation({ quoteMileageStatus: 'pending', pickupAddressComplete: false, destinationAddressComplete: false }).state)
  reached.add(transportation({ quoteMileageStatus: 'pending', pickupAddressComplete: true, destinationAddressComplete: true }).state)
  reached.add(transportation({ quoteMileageStatus: null }).state)
  reached.add(transportation({ quoteMileageStatus: 'pending', serviceType: 'labor_only' }).state)

  assert.deepEqual(
    Array.from(reached).sort(),
    ['NOT_APPLICABLE', 'READY_TO_ROUTE', 'UNKNOWN_LEGACY', 'WAITING_FOR_ADDRESSES'],
    'the reachable set',
  )
  const unreachable = ALL_STATES.filter((s) => !reached.has(s))
  assert.deepEqual(
    unreachable.sort(),
    ['ROUTED', 'ROUTING_FAILED'],
    'ROUTED and ROUTING_FAILED are BUILT AND CORRECT but cannot occur — see the header',
  )
})

test('the unreachable states still render honestly, so wiring them is safe when someone does', () => {
  //  Pinning the labels matters because the day a producer appears, these are
  //  what the owner will suddenly start reading. Both are already truthful:
  //  neither invents a number, and the failure state asks for a human.
  const { transportationLabel } = require('../lead-state') as typeof import('../lead-state')
  assert.match(
    transportationLabel({ state: 'ROUTED', billableMiles: 24, mileageCents: 7_200 }, 300),
    /24 routed miles · \$72 · fuel included/,
  )
  //  ROUTED WITHOUT ITS NUMBERS MUST NOT PRINT A FIGURE.
  assert.equal(transportationLabel({ state: 'ROUTED', billableMiles: null, mileageCents: null }, 300), 'Routed')
  assert.equal(
    transportationLabel({ state: 'ROUTING_FAILED', billableMiles: null, mileageCents: null }, 300),
    'Manual review — route calculation unavailable',
  )
})

test("the state a real lead DOES reach says 'pending', and never implies a measured drive", () => {
  const { transportationLabel } = require('../lead-state') as typeof import('../lead-state')
  const waiting = transportation({
    quoteMileageStatus: 'pending',
    pickupAddressComplete: false,
    destinationAddressComplete: false,
  })
  const label = transportationLabel(waiting, 300)
  //  The line from the original incident report. It is accurate: it quotes the
  //  RATE, not a total, and says what is being waited on.
  assert.match(label, /awaiting pickup and destination addresses/)
  assert.match(label, /\$3 per routed mile, fuel included/)
  assert.ok(!/routed miles ·/.test(label), 'no measured figure is implied')
  assert.equal(waiting.billableMiles, null)
  assert.equal(waiting.mileageCents, null)
})
