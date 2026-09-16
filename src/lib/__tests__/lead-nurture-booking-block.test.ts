// ════════════════════════════════════════════════════════════════════════
//  lead-nurture-booking-block.test.ts — the lead nurture's booking check
//  (email consent release 2026-09-16). Offline; the Prisma client is an
//  in-memory stand-in installed before leads.ts is loaded.
//
//  Every form now enters the nurture, so "has this person booked?" had to grow
//  a second half: a booking still waiting for payment or for the owner's
//  approval keeps the person out too — but only a RECENT one.
//
//    1. blocksLeadNurture (PURE) and its two constants: internal tests never
//       block; a taken booking (deposit, or a confirmed-and-later status)
//       always blocks; PENDING_PAYMENT / PENDING_APPROVAL block only inside
//       NURTURE_OPEN_BOOKING_DAYS; DRAFT / CANCELLED / ARCHIVED do not.
//    2. hasBookingOnRecord, driven through the stubbed client: the query it
//       makes, the answer it gives, and that a read error answers TRUE.
//    3. Structure: the scheduled worker's lead-nurture stage and the production
//       journey deps ask hasBookingOnRecord, not the narrower hasEverBooked.
// ════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BookingStatus } from '@prisma/client'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'

assertNoProductionCredentials()

type Row = Record<string, any>
const t = {
  bookings: [] as Row[],
  queries: [] as Row[],
  failRead: false,
}

;(globalThis as unknown as { prisma: unknown }).prisma = {
  booking: {
    async findMany(args: Row) {
      t.queries.push(args)
      if (t.failRead) throw new Error('simulated database outage')
      const email = args?.where?.customer?.email
      let rows = t.bookings.filter((b) => b.customerEmail === email)
      if (args?.orderBy?.createdAt === 'desc') {
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      }
      if (typeof args?.take === 'number') rows = rows.slice(0, args.take)
      //  Honour the select, so a field the query forgets is MISSING here too.
      const select: Row | undefined = args?.select
      return rows.map((r) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]])) : r))
    },
  },
}

let leads: typeof import('../leads')
before(async () => {
  leads = await import('../leads')
})

beforeEach(() => {
  t.bookings.length = 0
  t.queries.length = 0
  t.failRead = false
})

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-16T15:00:00Z')
const ago = (ms: number, from: Date = NOW) => new Date(from.getTime() - ms)

const ALL_STATUSES = Object.values(BookingStatus) as string[]
const TAKEN_STATUSES = ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']
const OPEN_STATUSES = ['PENDING_PAYMENT', 'PENDING_APPROVAL']
const NEVER_BLOCKING = ['DRAFT', 'CANCELLED', 'ARCHIVED']

function booking(over: Partial<{ status: string; depositPaid: boolean; isInternalTest: boolean; createdAt: Date }> = {}) {
  return { status: 'PENDING_PAYMENT', depositPaid: false, isInternalTest: false, createdAt: NOW, ...over }
}

const PERSON = 'pat.mover@example.com'
const OTHER = 'someone.else@example.com'
assertTestRecipient(PERSON)
assertTestRecipient(OTHER)

function stored(email: string, over: Parameters<typeof booking>[0] = {}): Row {
  const b = booking({ createdAt: new Date(), ...over })
  const row = { id: `bk_${t.bookings.length + 1}`, customerEmail: email, ...b }
  t.bookings.push(row)
  return row
}

// ── 1. THE PURE RULE ────────────────────────────────────────────────────

test('the constants: exactly PENDING_PAYMENT and PENDING_APPROVAL, for 90 days, and both are real booking statuses', () => {
  assert.deepEqual([...leads.NURTURE_BLOCKING_OPEN_STATUSES], OPEN_STATUSES)
  assert.equal(leads.NURTURE_OPEN_BOOKING_DAYS, 90)
  for (const s of leads.NURTURE_BLOCKING_OPEN_STATUSES) {
    assert.ok(ALL_STATUSES.includes(s), `${s} is a BookingStatus (a typo here would silently never match)`)
    //  The open statuses are the ADDITION; they are not already a taken booking.
    assert.equal(leads.countsAsPriorBooking({ status: s, depositPaid: false, isInternalTest: false }), false, s)
  }
})

test('an internal test booking never blocks the nurture, whatever its status, deposit or age', () => {
  for (const status of ALL_STATUSES) {
    for (const depositPaid of [false, true]) {
      for (const createdAt of [NOW, ago(DAY), ago(400 * DAY)]) {
        const b = booking({ status, depositPaid, isInternalTest: true, createdAt })
        assert.equal(leads.blocksLeadNurture(b, NOW), false, `${status} deposit=${depositPaid} created=${createdAt.toISOString()}`)
      }
    }
  }
})

test('a paid deposit always blocks, for every status and at any age — and agrees with countsAsPriorBooking', () => {
  for (const status of ALL_STATUSES) {
    for (const createdAt of [NOW, ago(91 * DAY), ago(3 * 365 * DAY)]) {
      const b = booking({ status, depositPaid: true, createdAt })
      assert.equal(leads.countsAsPriorBooking(b), true, status)
      assert.equal(leads.blocksLeadNurture(b, NOW), true, `${status} created=${createdAt.toISOString()}`)
    }
  }
})

test('CONFIRMED, SCHEDULED, IN_PROGRESS and COMPLETED block without a deposit, however long ago', () => {
  for (const status of TAKEN_STATUSES) {
    for (const createdAt of [NOW, ago(90 * DAY), ago(91 * DAY), ago(3 * 365 * DAY)]) {
      const b = booking({ status, depositPaid: false, createdAt })
      assert.equal(leads.countsAsPriorBooking(b), true, status)
      assert.equal(leads.blocksLeadNurture(b, NOW), true, `${status} created=${createdAt.toISOString()}`)
    }
  }
})

test('PENDING_PAYMENT and PENDING_APPROVAL block only within NURTURE_OPEN_BOOKING_DAYS of createdAt (both sides of the boundary)', () => {
  const windowMs = leads.NURTURE_OPEN_BOOKING_DAYS * DAY
  for (const status of OPEN_STATUSES) {
    const at = (createdAt: Date) => leads.blocksLeadNurture(booking({ status, createdAt }), NOW)
    assert.equal(at(NOW), true, `${status}: created this instant`)
    assert.equal(at(ago(DAY)), true, `${status}: yesterday`)
    assert.equal(at(ago(windowMs - 1)), true, `${status}: 1 ms inside the window`)
    assert.equal(at(ago(windowMs)), true, `${status}: exactly ${leads.NURTURE_OPEN_BOOKING_DAYS} days is still inside`)
    assert.equal(at(ago(windowMs + 1)), false, `${status}: 1 ms past the window is somebody starting over`)
    assert.equal(at(ago(windowMs + DAY)), false, `${status}: a day past the window`)
    assert.equal(at(ago(400 * DAY)), false, `${status}: last season`)
    //  A row stamped slightly AHEAD of this clock (skew between hosts) errs
    //  toward keeping the person out, never toward the nurture.
    assert.equal(at(new Date(NOW.getTime() + 60_000)), true, `${status}: createdAt a minute in the future`)
  }
})

test('DRAFT, CANCELLED and ARCHIVED without a deposit do not block, even created this instant', () => {
  for (const status of NEVER_BLOCKING) {
    for (const createdAt of [NOW, ago(DAY), ago(400 * DAY)]) {
      const b = booking({ status, depositPaid: false, createdAt })
      assert.equal(leads.blocksLeadNurture(b, NOW), false, `${status} created=${createdAt.toISOString()}`)
    }
  }
})

test('every BookingStatus is classified: a new status must be decided for the nurture, not inherited by accident', () => {
  const expectedRecent = new Set([...TAKEN_STATUSES, ...OPEN_STATUSES])
  const expectedOld = new Set(TAKEN_STATUSES)
  assert.deepEqual(
    [...ALL_STATUSES].sort(),
    [...TAKEN_STATUSES, ...OPEN_STATUSES, ...NEVER_BLOCKING].sort(),
    'the BookingStatus enum changed — classify the new status in this test and in leads.blocksLeadNurture',
  )
  for (const status of ALL_STATUSES) {
    assert.equal(leads.blocksLeadNurture(booking({ status, createdAt: ago(DAY) }), NOW), expectedRecent.has(status), `${status} (recent)`)
    assert.equal(leads.blocksLeadNurture(booking({ status, createdAt: ago(120 * DAY) }), NOW), expectedOld.has(status), `${status} (120 days old)`)
  }
})

test('without an explicit `now` the rule reads the current clock', () => {
  const real = new Date()
  assert.equal(leads.blocksLeadNurture(booking({ status: 'PENDING_PAYMENT', createdAt: ago(DAY, real) })), true)
  assert.equal(leads.blocksLeadNurture(booking({ status: 'PENDING_APPROVAL', createdAt: ago(91 * DAY, real) })), false)
})

// ── 2. hasBookingOnRecord THROUGH THE CLIENT ────────────────────────────

test('hasBookingOnRecord: no usable address answers false without touching the database', async () => {
  for (const email of [undefined, null, '', '   ', 'not-an-email', 'a@b']) {
    assert.equal(await leads.hasBookingOnRecord(email), false, String(email))
  }
  assert.equal(t.queries.length, 0)
})

test('hasBookingOnRecord: the query filters by the customer email (normalized) and selects everything the rule reads, including createdAt', async () => {
  stored(PERSON, { status: 'COMPLETED' })
  assert.equal(await leads.hasBookingOnRecord('  Pat.Mover@EXAMPLE.com '), true)
  assert.equal(t.queries.length, 1)
  const q = t.queries[0]
  assert.deepEqual(q.where, { customer: { email: PERSON } })
  for (const field of ['status', 'depositPaid', 'isInternalTest', 'createdAt']) {
    assert.equal(q.select?.[field], true, `select.${field}`)
  }
  assert.deepEqual(q.orderBy, { createdAt: 'desc' }, 'newest first, so a recent open booking is never cut off by the take')
  assert.ok(typeof q.take === 'number' && q.take > 0 && q.take <= 100, 'the read is bounded')
})

test('hasBookingOnRecord: a recent booking waiting for payment or approval keeps the person out — the case hasEverBooked misses', async () => {
  for (const status of OPEN_STATUSES) {
    t.bookings.length = 0
    stored(PERSON, { status, createdAt: ago(10 * DAY, new Date()) })
    assert.equal(await leads.hasBookingOnRecord(PERSON), true, `${status}: nurture blocked`)
    assert.equal(await leads.hasEverBooked(PERSON), false, `${status}: still not a previous customer`)
  }
})

test('hasBookingOnRecord: an open booking older than the window does not block', async () => {
  stored(PERSON, { status: 'PENDING_PAYMENT', createdAt: ago((leads.NURTURE_OPEN_BOOKING_DAYS + 1) * DAY, new Date()) })
  stored(PERSON, { status: 'PENDING_APPROVAL', createdAt: ago(200 * DAY, new Date()) })
  assert.equal(await leads.hasBookingOnRecord(PERSON), false)
})

test('hasBookingOnRecord: a taken booking from years ago still blocks (previous customer)', async () => {
  stored(PERSON, { status: 'DRAFT' })
  stored(PERSON, { status: 'COMPLETED', createdAt: ago(3 * 365 * DAY, new Date()) })
  assert.equal(await leads.hasBookingOnRecord(PERSON), true)
})

test('hasBookingOnRecord: drafts, cancellations, unpaid archives and internal tests are not a booking on record', async () => {
  stored(PERSON, { status: 'DRAFT' })
  stored(PERSON, { status: 'CANCELLED' })
  stored(PERSON, { status: 'ARCHIVED' })
  stored(PERSON, { status: 'COMPLETED', depositPaid: true, isInternalTest: true })
  stored(PERSON, { status: 'PENDING_PAYMENT', isInternalTest: true })
  assert.equal(await leads.hasBookingOnRecord(PERSON), false)
})

test('hasBookingOnRecord: only this person\'s bookings count', async () => {
  stored(OTHER, { status: 'COMPLETED', depositPaid: true })
  stored(OTHER, { status: 'PENDING_PAYMENT' })
  assert.equal(await leads.hasBookingOnRecord(PERSON), false)
  assert.equal(await leads.hasBookingOnRecord(OTHER), true)
})

test('hasBookingOnRecord: a read error FAILS CLOSED (true), exactly like hasEverBooked', async () => {
  t.failRead = true
  assert.equal(await leads.hasBookingOnRecord(PERSON), true, 'an outage suppresses the nurture rather than sending it to a booked customer')
  assert.equal(await leads.hasEverBooked(PERSON), true)
})

// ── 3. WIRING ───────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '../../..')

/** File contents with comment lines removed (a scan must not read its own prose). */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const s = l.trim()
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
    })
    .join('\n')
}

/** From `start` up to (not including) the first `end` that follows it. */
function slice(src: string, start: string, end: RegExp): string {
  const from = src.indexOf(start)
  assert.ok(from > -1, `found ${start}`)
  const rest = src.slice(from + start.length)
  const m = end.exec(rest)
  return src.slice(from, m ? from + start.length + m.index : undefined)
}

test('scheduled.worker: the lead-nurture stage derives previousCustomer from hasBookingOnRecord, never hasEverBooked', () => {
  const src = code('src/workers/scheduled.worker.ts')
  assert.match(src, /import\s*\{[^}]*\bhasBookingOnRecord\b[^}]*\}\s*from\s*'\.\.\/lib\/leads'/, 'imported from leads')
  assert.doesNotMatch(src, /\bhasEverBooked\b/, 'the narrower check is gone from the worker')

  const nurture = slice(src, "case 'lead-nurture-1':", /\n\s*case '(?!lead-nurture)/)
  assert.match(nurture, /case 'lead-nurture-2':/)
  assert.match(nurture, /case 'lead-nurture-final':/)
  assert.match(nurture, /previousCustomer\s*=\s*lead\s*\?\s*await hasBookingOnRecord\(lead\.email\)/)
  assert.match(nurture, /leadNurtureBlockReason\([^;]*previousCustomer/, 'and the answer reaches the stop-rule check')
})

test('journeys: the production JourneyDeps and StageDeps both wire hasEverBooked to leads.hasBookingOnRecord', () => {
  const src = code('src/lib/journeys.ts')
  assert.match(src, /import\s*\{[^}]*\bhasBookingOnRecord\b[^}]*\}\s*from\s*'\.\/leads'/)
  assert.doesNotMatch(src, /import\s*\{[^}]*\bhasEverBooked\b[^}]*\}\s*from\s*'\.\/leads'/, 'leads.hasEverBooked is not imported')

  for (const fn of ['export function defaultJourneyDeps()', 'export function defaultStageDeps()']) {
    const body = slice(src, fn, /\nexport /)
    assert.match(body, /\bhasEverBooked:\s*hasBookingOnRecord\s*,/, fn)
  }
})
