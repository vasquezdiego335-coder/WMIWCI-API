// ════════════════════════════════════════════════════════════════════════════
//  checkout-expiry.test.ts — RELEASE BLOCKER B6, AND ITS REVERT (D1)
//
//  B6: `checkout.session.expired` was one `logger.info` line while the
//  PENDING_PAYMENT booking behind it held its truck (truck-conflicts.ts R2-2)
//  and nothing could transition out of PENDING_PAYMENT — so the ordinary "let
//  me ask my wife" customer left a stale truck hold the owner could not clear.
//
//  D1: the FIX B6 shipped was more dangerous than the bug, and it is GONE.
//  Reproduced against the shipped code before this file was rewritten:
//    • the hourly sweep applied NO mid-payment guard — it went straight from
//      `previousSessionVerdict === 'gone'` to the cancellation, so a booking
//      whose customer was being redirected into a fresh session was CANCELLED
//      while they paid (§3.1, which failed against the old module);
//    • no concurrency was needed: the resume route retires the recorded session
//      BEFORE minting its replacement, so a failed replacement leaves the
//      booking carrying a dead session id and the next sweep cancelled it
//      terminally (§3.2);
//    • CANCELLED has no exit in VALID_TRANSITIONS, so neither owner nor
//      customer could undo it (§3.3).
//
//  SO THIS FILE NOW PINS THE OPPOSITE PROPERTY. There is no assertion anywhere
//  in it that an automatic path may cancel a booking — that was deliberately
//  removed, because a suite that blesses automatic cancellation is how a future
//  pass resurrects it "with tests". What is asserted instead:
//    1. NO automatic path writes a booking status (§3, §7.3 — a source guard
//       over the module, the webhook case and the cron handler, so a dormant
//       cancellation cannot be re-added quietly).
//    2. The webhook RECORDS and returns (§2).
//    3. The report REPORTS and still raises the two money shapes (§4).
//    4. The OWNER's audited, permission-gated release is the only exit, and it
//       refuses when Stripe says money may exist (§5).
//    5. The Action Center is where a stale hold reaches the owner (§6).
//    6. §7 is the MUTATION PROOF: the removed automatic cancellation is rebuilt
//       here and shown to produce the catastrophe on the same input the shipped
//       code refuses, so this harness demonstrably still sees it.
//
//  HOW IT TESTS — the round-3 rules, unchanged:
//   • the booking row is what the SHIPPED WRITER persists (AdminBookingSchema →
//     resolveMoveSchedule → buildBookingCreateData on the DEFAULT owner path).
//   • the SHIPPED prisma-backed deps run against a fake `prisma` installed on
//     globalThis before src/lib/db.ts is first imported, so the WHERE CLAUSES
//     are what is under test.
//   • the truck claim is not asserted, it is MEASURED with the same
//     findTruckConflictsIn the admin create uses.
//
//  Offline: no database, no Stripe, no Redis, no network.
//    npx tsx --test src/lib/__tests__/checkout-expiry.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Stripe from 'stripe'

// ── Environment, BEFORE any app import ──────────────────────────────────────
process.env.STRIPE_SECRET_KEY = 'sk_test_checkout_expiry'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_checkout_expiry'
process.env.APP_URL = 'https://example.test'
delete process.env.DISCORD_BOT_TOKEN
delete process.env.EMAIL_JOURNEYS_ENABLED
delete process.env.EMAIL_JOURNEY_ABANDONED_DISABLED

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

const MONEY_CLAIM =
  /\b(?:was|were|is|are|has been|have been)\s+(?:not\s+)?(?:charged|captured|refunded|released|collected)\b/i

// ── The fake database ───────────────────────────────────────────────────────

type Row = Record<string, any>

type Ctl = {
  bookings: Row[]
  audits: Row[]
  webhookLogs: Map<string, Row>
  /** Every booking.updateMany `where` the shipped code emitted, in order. */
  updateWheres: Row[]
  /** Every booking.findMany `where` — how the report's query is inspected. */
  findWheres: Row[]
  /** Set to make a read fail (an unreadable booking must never become an action). */
  readError?: Error
  auditError?: Error
}

let ctl: Ctl = newCtl()

function newCtl(bookings: Row[] = []): Ctl {
  return { bookings, audits: [], webhookLogs: new Map(), updateWheres: [], findWheres: [] }
}

/** Postgres-ish WHERE: equality, Date-by-value, `{in}`, `{lt}`, `{gte}`,
 *  `{not: null}` and OR. Dates compare BY VALUE like Postgres does, so a guard
 *  can never pass merely because the fake holds the same object. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  for (const [key, val] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(val as Row[]).some((clause) => matches(row, clause))) return false
      continue
    }
    if (val instanceof Date) {
      const cur = row[key]
      if (!(cur instanceof Date) || cur.getTime() !== val.getTime()) return false
      continue
    }
    if (val && typeof val === 'object') {
      const cur = row[key]
      if ('in' in val) {
        if (!(val.in as unknown[]).includes(cur)) return false
        continue
      }
      if ('lt' in val) {
        if (!(cur instanceof Date) || !(cur.getTime() < (val.lt as Date).getTime())) return false
        continue
      }
      if ('gte' in val) {
        if (!(cur instanceof Date) || !(cur.getTime() >= (val.gte as Date).getTime())) return false
        continue
      }
      if ('not' in val) {
        if (val.not === null) {
          if (cur === null || cur === undefined) return false
          continue
        }
        if (cur === val.not) return false
        continue
      }
    }
    if (row[key] !== val) return false
  }
  return true
}

const project = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row }

const fakePrisma: Row = {
  booking: {
    async findUnique(args: { where: Row; select?: Row }): Promise<Row | null> {
      if (ctl.readError) throw ctl.readError
      const row = ctl.bookings.find((b) => matches(b, args.where))
      return row ? project(row, args.select) : null
    },
    async findMany(args: { where?: Row; select?: Row; take?: number; orderBy?: Row }): Promise<Row[]> {
      if (args.where) ctl.findWheres.push(args.where)
      const rows = ctl.bookings.filter((b) => matches(b, args.where))
      rows.sort((a, z) => (a.createdAt?.getTime() ?? 0) - (z.createdAt?.getTime() ?? 0))
      return rows.slice(0, args.take ?? rows.length).map((r) => project(r, args.select))
    },
    async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      if (args.where) ctl.updateWheres.push(args.where)
      let count = 0
      for (const b of ctl.bookings) {
        if (matches(b, args.where)) {
          Object.assign(b, args.data)
          b.updatedAt = new Date()
          count += 1
        }
      }
      return { count }
    },
  },
  auditLog: {
    async create(args: { data: Row; select?: Row }): Promise<Row> {
      if (ctl.auditError) throw ctl.auditError
      ctl.audits.push(args.data)
      return { id: `au_${ctl.audits.length}` }
    },
  },
  webhookLog: {
    async upsert(args: { where: { eventId: string }; update: Row; create: Row }): Promise<Row> {
      const existing = ctl.webhookLogs.get(args.where.eventId)
      if (existing) {
        Object.assign(existing, args.update)
        return existing
      }
      const created = { id: `wl_${ctl.webhookLogs.size + 1}`, processedAt: null, ...args.create }
      ctl.webhookLogs.set(args.where.eventId, created)
      return created
    },
    async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
      let count = 0
      for (const row of Array.from(ctl.webhookLogs.values())) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data)
          count += 1
        }
      }
      return { count }
    },
    async findUnique(args: { where: { eventId: string } }): Promise<Row | null> {
      return ctl.webhookLogs.get(args.where.eventId) ?? null
    },
  },
  /** ATOMIC BY CONSTRUCTION IN THE FAKE TOO: an interactive transaction that
   *  throws must leave nothing behind, or the "the state change and its
   *  explanation cannot come apart" claim would be untested. */
  async $transaction(arg: unknown): Promise<unknown> {
    if (Array.isArray(arg)) return Promise.all(arg)
    const snapshot = ctl.bookings.map((b) => ({ ...b }))
    const auditsBefore = ctl.audits.length
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(fakePrisma)
    } catch (err) {
      ctl.bookings.length = 0
      ctl.bookings.push(...snapshot)
      ctl.audits.length = auditsBefore
      throw err
    }
  },
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

// ── Modules under test (loaded only AFTER the fake is installed) ─────────────

type Mods = {
  expiry: typeof import('../checkout-expiry')
  events: typeof import('../stripe-events')
  truck: typeof import('../truck-conflicts')
  rules: typeof import('../reminder-rules')
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  assistant: typeof import('../estimate-assistant')
  scheduling: typeof import('../scheduling')
  journeys: typeof import('../journeys')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    expiry: await import('../checkout-expiry'),
    events: await import('../stripe-events'),
    truck: await import('../truck-conflicts'),
    rules: await import('../reminder-rules'),
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    assistant: await import('../estimate-assistant'),
    scheduling: await import('../scheduling'),
    journeys: await import('../journeys'),
  }
  const dbModule = await import('../db')
  assert.equal(
    dbModule.prisma as unknown,
    fakePrisma,
    'the fake prisma must be the client the shipped modules use — otherwise this file tests nothing',
  )
  assert.equal(process.env.DISCORD_BOT_TOKEN, undefined, 'a test must never be able to post to the live Discord')
  return mods
}

// ── The row the SHIPPED WRITER persists ─────────────────────────────────────

const TRUCK = 'truck_16ft'
const MOVE_DAY = '2027-09-19'
const NOW = Date.parse('2027-09-01T15:00:00.000Z')

/** buildBookingCreateData on the DEFAULT owner path (`stripe_link`), fed by the
 *  REAL zod schema and the REAL schedule resolver — the exact row that stamps a
 *  truck onto an unpaid booking. */
async function shippedHoldData(spec: { truckId?: string | null } = {}): Promise<Row> {
  const m = await load()
  const truckId = spec.truckId === undefined ? TRUCK : spec.truckId
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '4br',
      moveDate: MOVE_DAY,
      startTime: '18:00', // an evening job: its hold reaches into the next ET day
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    ...(truckId ? { truckId } : {}),
    deposit: { mode: 'stripe_link' }, // THE default owner path
    pricing: { ownerTotal: 900, overrideReason: 'phone quote' },
  })
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  const input = parsed.data
  const estimatedHours = m.assistant.recommendEstimate({ serviceType: '4br', inventory: [] }).estimatedHoursMax
  const schedule = m.adminBooking.resolveMoveSchedule(input.move, {
    estimatedHours,
    helpers: { toInstant: m.scheduling.etDateTimeToInstant, endTime: m.scheduling.calculateEndTime },
  })
  assert.ok(schedule.requestedDate)
  const data = m.adminBooking.buildBookingCreateData(
    input,
    {
      estimate: m.estimate.computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1042',
      tokenExpiry: new Date('2028-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours,
    },
    [],
  ) as Row
  assert.equal(data.status, 'PENDING_PAYMENT', 'precondition: the default path creates an UNPAID hold')
  assert.equal(data.depositPaid ?? false, false, 'precondition: an unpaid hold')
  assert.equal(data.truckId ?? null, truckId, 'precondition: the default path stamps a truck onto that unpaid row')
  return data
}

/** A stored booking row: the shipped writer's columns, plus the ones the route
 *  adds afterwards (id / session id / timestamps). */
async function holdRow(spec: {
  id?: string
  sessionId?: string | null
  paymentIntentId?: string | null
  ageMs?: number
  status?: string
  depositPaid?: boolean
  truckId?: string | null
  /** The clock the age is measured against. Most sections inject a fixed clock;
   *  §9 drives the SHIPPED webhook entry point, which uses the real one, so its
   *  fixtures must age against `Date.now()`. */
  nowMs?: number
} = {}): Promise<Row> {
  const data = await shippedHoldData({ truckId: spec.truckId })
  const createdAt = new Date((spec.nowMs ?? NOW) - (spec.ageMs ?? 3 * 3_600_000))
  return {
    id: spec.id ?? 'bk_b6',
    ...data,
    ...(spec.status ? { status: spec.status } : {}),
    ...(spec.depositPaid !== undefined ? { depositPaid: spec.depositPaid } : {}),
    stripeCheckoutId: spec.sessionId === undefined ? 'cs_A' : spec.sessionId,
    // NULL until a customer authorizes — the column that tells the release
    // action "this booking belongs to the money path, not to you".
    stripePaymentIntentId: spec.paymentIntentId ?? null,
    isInternalTest: data.isInternalTest ?? false,
    createdAt,
    updatedAt: createdAt,
  }
}

// ── Injected Stripe / alert edge ────────────────────────────────────────────

type SweepEdge = {
  sessions: Map<string, Row>
  retrieveError?: Error
  expireError?: Error
  expired: string[]
  alerts: Array<{ title: string; lines: Array<{ message: string; action?: string }> }>
  /** C4 — every call to the shared lifecycle half, and what it answered. */
  finished: Row[]
  aftermath?: Row
  finishError?: Error
}

function edge(): SweepEdge {
  return { sessions: new Map(), expired: [], alerts: [], finished: [] }
}

/** The SHIPPED prisma-backed deps, with ONLY the Stripe edge, the alert sink,
 *  the logger and the clock injected. Every WHERE clause under test is real. */
async function depsWith(e: SweepEdge, now: number = NOW) {
  const m = await load()
  return {
    ...m.expiry.defaultCheckoutExpiryDeps(),
    async retrieveSession(id: string) {
      if (e.retrieveError) throw e.retrieveError
      return (e.sessions.get(id) as never) ?? null
    },
    async expireSession(id: string) {
      if (e.expireError) throw e.expireError
      e.expired.push(id)
      const s = e.sessions.get(id)
      if (s) s.status = 'expired'
    },
    async alert(title: string, lines: Array<{ message: string; action?: string }>) {
      e.alerts.push({ title, lines })
      return { delivered: true }
    },
    // C4 — the lifecycle half is RECORDED here rather than executed: its real
    // implementation stops BullMQ journeys, and a queue with no Redis behind it
    // spends five seconds per job id failing to answer. §10 drives the SHIPPED
    // `finishCancellationViaLifecycle` against a fake database that really has
    // jobs and crew (lifecycle-release.test.ts), which is where that half is
    // actually proven.
    async finishCancellation(input: Row) {
      e.finished.push(input)
      if (e.finishError) throw e.finishError
      return (e.aftermath ?? { jobCancelled: false, crewCancelled: 0, journeys: 'ok' }) as never
    },
    log: { info() {}, warn() {}, error() {} },
    now: () => now,
  }
}

const SESSION_TTL_SEC = 30 * 60
const sec = (ms: number): number => Math.floor(ms / 1000)

/** A Stripe session as the SHIPPED creator makes it: 30 minutes of life. */
function session(id: string, createdMs: number, over: Partial<Row> = {}): Row {
  return {
    id,
    status: 'expired',
    payment_status: 'unpaid',
    created: sec(createdMs),
    expires_at: sec(createdMs) + SESSION_TTL_SEC,
    ...over,
  }
}

const OWNER = { userId: 'u_diego', name: 'Diego', role: 'OWNER' as const }

// ════════════════════════════════════════════════════════════════════════════
//  1. THE OWN-CLOCK CHECK — it decides what to RECORD, not what to cancel.
// ════════════════════════════════════════════════════════════════════════════

test('1.1 a session that lapsed on its own schedule is a genuine abandonment', async () => {
  const m = await load()
  const created = Date.parse('2027-09-01T10:00:00Z')
  const v = m.expiry.expiredOnItsOwnSchedule({
    sessionCreatedSec: sec(created),
    sessionExpiresAtSec: sec(created) + SESSION_TTL_SEC,
    eventCreatedSec: sec(created) + SESSION_TTL_SEC, // Stripe fires it at the deadline
  })
  assert.deepEqual(v, { natural: true, reason: 'expired-on-schedule' })
})

test('1.2 a session expired EARLY was expired by THIS codebase — never a genuine abandonment', async () => {
  const m = await load()
  const created = Date.parse('2027-09-01T10:00:00Z')
  // The resume route retiring a still-open session 20 minutes in.
  const v = m.expiry.expiredOnItsOwnSchedule({
    sessionCreatedSec: sec(created),
    sessionExpiresAtSec: sec(created) + SESSION_TTL_SEC,
    eventCreatedSec: sec(created) + 20 * 60,
  })
  assert.deepEqual(
    v,
    { natural: false, reason: 'expired-early' },
    'stripe.checkout.sessions.expire has exactly two call sites in this repo, both meaning "a replacement is being ' +
      'created right now" — recording that as an abandonment would be a false record',
  )
})

test('1.3 the verdict holds even if Stripe rewrites expires_at when a session is expired by API', async () => {
  const m = await load()
  const created = Date.parse('2027-09-01T10:00:00Z')
  const killedAt = sec(created) + 20 * 60
  const v = m.expiry.expiredOnItsOwnSchedule({
    sessionCreatedSec: sec(created),
    sessionExpiresAtSec: killedAt,
    eventCreatedSec: killedAt,
  })
  assert.equal(v.natural, false, 'the verdict must not depend on an undocumented Stripe behaviour')
  assert.equal(v.reason, 'expired-early')
})

test('1.4 a session with no usable clock concludes nothing', async () => {
  const m = await load()
  assert.deepEqual(m.expiry.expiredOnItsOwnSchedule({ eventCreatedSec: sec(NOW) }), {
    natural: false,
    reason: 'unknown-session-clock',
  })
  assert.deepEqual(m.expiry.expiredOnItsOwnSchedule({ sessionCreatedSec: sec(NOW), sessionExpiresAtSec: sec(NOW) }), {
    natural: false,
    reason: 'unknown-session-clock',
  })
})

test('1.5 a longer-lived session is judged by ITS OWN expires_at, not by the house TTL', async () => {
  const m = await load()
  const created = Date.parse('2027-09-01T10:00:00Z')
  const expiresAt = sec(created) + 4 * 3600
  assert.equal(
    m.expiry.expiredOnItsOwnSchedule({
      sessionCreatedSec: sec(created),
      sessionExpiresAtSec: expiresAt,
      eventCreatedSec: sec(created) + 2 * 3600,
    }).natural,
    false,
    'two hours into a four-hour session is early, whatever CHECKOUT_SESSION_TTL_MINUTES says',
  )
  assert.equal(
    m.expiry.expiredOnItsOwnSchedule({
      sessionCreatedSec: sec(created),
      sessionExpiresAtSec: expiresAt,
      eventCreatedSec: expiresAt,
    }).natural,
    true,
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE WEBHOOK HANDLER — it RECORDS. It writes nothing to the booking.
// ════════════════════════════════════════════════════════════════════════════

/** A `checkout.session.expired` that lapsed naturally, for the given booking. */
async function fireExpiry(
  e: SweepEdge,
  input: { bookingId?: string | null; sessionId: string; sessionCreatedMs: number },
  now: number = NOW,
) {
  const m = await load()
  const expiresAtSec = sec(input.sessionCreatedMs) + SESSION_TTL_SEC
  return m.expiry.handleCheckoutSessionExpired(
    {
      bookingId: input.bookingId === undefined ? 'bk_b6' : input.bookingId,
      sessionId: input.sessionId,
      sessionCreatedSec: sec(input.sessionCreatedMs),
      sessionExpiresAtSec: expiresAtSec,
      eventCreatedSec: expiresAtSec, // Stripe fires it at the deadline
    },
    await depsWith(e, now),
  )
}

test('2.1 an abandoned hold is RECORDED and left exactly as it was', async () => {
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])

  const out = await fireExpiry(edge(), { sessionId: 'cs_A', sessionCreatedMs: NOW - 40 * 60_000 })

  assert.deepEqual(out, { action: 'recorded', reason: 'abandoned-hold', cancelled: false })
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT', 'D1: no automatic path may end a booking')
  assert.equal(ctl.updateWheres.length, 0, 'and it must not write to the booking at all')
  assert.equal(ctl.audits.length, 0)
})

test('2.2 an expiry for a session the booking no longer carries is recorded as superseded', async () => {
  // The customer is paying through cs_B right now; cs_A is the retired one.
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_B' })])

  const out = await fireExpiry(edge(), { sessionId: 'cs_A', sessionCreatedMs: NOW - 40 * 60_000 })

  assert.equal(out.action, 'ignored')
  assert.equal(out.reason, 'session-superseded')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
})

test('2.3 an expiry this codebase caused is never recorded as an abandonment', async () => {
  // The double-clicked recovery email: the resume route retires cs_B (still
  // open) and mints cs_C. Stripe fires cs_B's expiry while the customer is
  // being redirected into cs_C.
  ctl = newCtl([await holdRow({ ageMs: 48 * 3_600_000, sessionId: 'cs_B' })])
  const m = await load()
  const createdMs = NOW - 20 * 60_000

  const out = await m.expiry.handleCheckoutSessionExpired(
    {
      bookingId: 'bk_b6',
      sessionId: 'cs_B',
      sessionCreatedSec: sec(createdMs),
      sessionExpiresAtSec: sec(createdMs) + SESSION_TTL_SEC,
      eventCreatedSec: sec(NOW), // expired 20 minutes into a 30-minute session
    },
    await depsWith(edge()),
  )

  assert.equal(out.action, 'ignored')
  assert.equal(out.reason, 'expired-early')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  assert.equal(ctl.updateWheres.length, 0)
})

test('2.4 a paid booking and a session that is not ours are both no-ops', async () => {
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A', status: 'PENDING_APPROVAL', depositPaid: true })])
  const paid = await fireExpiry(edge(), { sessionId: 'cs_A', sessionCreatedMs: NOW - 40 * 60_000 })
  assert.equal(paid.reason, 'deposit-paid')
  assert.equal(ctl.bookings[0].status, 'PENDING_APPROVAL')

  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000 })])
  const foreign = await fireExpiry(edge(), { bookingId: null, sessionId: 'cs_x', sessionCreatedMs: NOW - 40 * 60_000 })
  assert.equal(foreign.reason, 'no-booking-id')
  assert.equal(ctl.updateWheres.length, 0)
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
})

test('2.5 a replayed expiry event stays a no-op, however many times it lands', async () => {
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])

  const first = await fireExpiry(edge(), { sessionId: 'cs_A', sessionCreatedMs: NOW - 40 * 60_000 })
  const second = await fireExpiry(edge(), { sessionId: 'cs_A', sessionCreatedMs: NOW - 40 * 60_000 })

  assert.equal(first.action, 'recorded')
  assert.equal(second.action, 'recorded', 'recording is idempotent because it changes nothing')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  assert.equal(ctl.audits.length, 0)
})

test('2.6 a booking that cannot be READ throws, so Stripe re-delivers the event', async () => {
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])
  ctl.readError = new Error("Can't reach database server (test)")

  await assert.rejects(
    () => fireExpiry(edge(), { sessionId: 'cs_A', sessionCreatedMs: NOW - 40 * 60_000 }),
    /Can't reach database server/,
    'returning normally would record the event processed and retire the only retry that could still record it',
  )
  ctl.readError = undefined
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE D1 REPRODUCTIONS — these FAILED against the shipped B6 module.
//     They are the reason the automatic cancellation is gone.
// ════════════════════════════════════════════════════════════════════════════

test('3.1 the report does not cancel a booking whose customer is being redirected into a live checkout', async () => {
  // The reproduction, verbatim: `expiredOnItsOwnSchedule` was applied only in
  // the webhook handler, so the sweep went from `verdict === 'gone'` straight
  // to the cancellation. The resume route retired cs_B (still open, 20 minutes
  // into its 30-minute life) and is minting cs_C right now.
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 48 * 3_600_000, sessionId: 'cs_B' })])
  const e = edge()
  e.sessions.set('cs_B', session('cs_B', NOW - 20 * 60_000, { status: 'expired' }))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.cancelled, 0, 'no automatic path may cancel a booking')
  assert.equal(report.staleHolds, 1, 'it is REPORTED — that is the whole remaining job')
  assert.equal(
    ctl.bookings[0].status,
    'PENDING_PAYMENT',
    'the customer is being redirected into cs_C at this instant; B6 cancelled them here',
  )
  assert.equal(ctl.updateWheres.length, 0, 'the report writes to no booking, ever')
  assert.equal(ctl.audits.length, 0)
})

test('3.2 no concurrency needed: a failed session replacement leaves a dead id, and the report still cancels nothing', async () => {
  // The race-free variant. The resume route EXPIRES the recorded session before
  // creating its replacement; when the replacement fails (Stripe error, no
  // session url, a failed recordCheckoutSession) the booking keeps an id Stripe
  // now reports `expired`. Under B6 the next sweep cancelled it terminally —
  // the customer clicked "finish your booking", something hiccuped, and their
  // booking was gone.
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 25 * 60_000, { status: 'expired' }))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  assert.equal(report.cancelled, 0)
  assert.deepEqual(
    report.findings.map((f) => ({ bookingId: f.bookingId, sessionId: f.sessionId, truckId: f.truckId })),
    [{ bookingId: 'bk_b6', sessionId: 'cs_A', truckId: TRUCK }],
    'the owner is told about it instead',
  )
  // And the booking is still resumable, which is exactly what cancelling destroyed.
  const resume = readFileSync(resolve(process.cwd(), 'app/api/stripe/checkout/resume/route.ts'), 'utf8')
  assert.match(resume, /RESUMABLE_STATUSES/)
  assert.match(resume, /'PENDING_PAYMENT'/, 'the resume route can still hand this customer a working payment link')
})

test('3.3 CANCELLED is terminal — which is why only a human may put a booking there', () => {
  const routeSrc = readFileSync(resolve(process.cwd(), 'app/api/admin/bookings/[id]/status/route.ts'), 'utf8')
  const table = routeSrc.slice(routeSrc.indexOf('VALID_TRANSITIONS'), routeSrc.indexOf('const StatusSchema'))
  assert.ok(table.length > 0, 'the transition table must still exist')
  assert.equal(/CANCELLED:\s*\[/.test(table), false, 'nothing transitions OUT of CANCELLED')
  assert.equal(
    /PENDING_PAYMENT:\s*\[/.test(table),
    false,
    'and PENDING_PAYMENT deliberately has no generic transition either — the release is a NAMED, checked action',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE REPORT — the net under a missed webhook. It reports. It never cancels.
// ════════════════════════════════════════════════════════════════════════════

test('4.1 a MISSED expiry webhook produces a finding, not a cancellation', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 4 * 3_600_000))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.scanned, 1)
  assert.equal(report.staleHolds, 1)
  assert.equal(report.findings[0].ageHours, 5)
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  assert.equal(ctl.audits.length, 0)
})

test('4.2 a booking with no recorded session is never even offered to the loop', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 90 * 24 * 3_600_000, sessionId: null })])

  const report = await m.expiry.reportStaleCheckouts(await depsWith(edge()), { graceMs: 2 * 3_600_000 })

  assert.equal(report.staleHolds, 0)
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  const where = ctl.findWheres.at(-1)!
  assert.deepEqual(where.stripeCheckoutId, { not: null }, 'nothing can prove an un-sessioned booking is abandoned')
  assert.equal(where.depositPaid, false)
  assert.equal(where.isInternalTest, false)
})

test('4.3 a session Stripe still considers PAYABLE is not even listed', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.stillPayable, 1)
  assert.equal(report.staleHolds, 0, 'a customer may be on that checkout page right now')
})

test('4.4 a LOST checkout.session.completed is surfaced as money, never as an abandonment', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  // The money case: the customer DID authorize. A manual-capture session stays
  // `payment_status: unpaid`, so `status: complete` is the only signal.
  e.sessions.set('cs_A', session('cs_A', NOW - 4 * 3_600_000, { status: 'complete', payment_status: 'unpaid' }))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.authorized, 1)
  assert.equal(report.staleHolds, 0)
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  assert.equal(e.alerts.length, 1)
  assert.match(e.alerts[0].title, /Checkout completed at Stripe/)
})

test('4.5 Stripe unreachable ⇒ nothing concluded, nothing changed, nothing listed', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  e.retrieveError = new Error('Stripe API unavailable (503)')

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.unreadable, 1)
  assert.equal(report.staleHolds, 0, '"cannot tell" must never become "list it as abandoned"')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
})

test('4.6 only rows past the staleness threshold are asked about, and the batch is bounded', async () => {
  const m = await load()
  ctl = newCtl([
    await holdRow({ id: 'bk_fresh', ageMs: 30 * 60_000, sessionId: 'cs_fresh' }),
    await holdRow({ id: 'bk_old', ageMs: 30 * 3_600_000, sessionId: 'cs_old' }),
    await holdRow({ id: 'bk_older', ageMs: 40 * 3_600_000, sessionId: 'cs_older' }),
  ])
  const e = edge()
  e.sessions.set('cs_fresh', session('cs_fresh', NOW - 30 * 60_000))
  e.sessions.set('cs_old', session('cs_old', NOW - 30 * 3_600_000))
  e.sessions.set('cs_older', session('cs_older', NOW - 40 * 3_600_000))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000, limit: 1 })

  assert.equal(report.scanned, 1, 'the limit must reach the query')
  assert.equal(report.findings[0].bookingId, 'bk_older', 'oldest first')
  const where = ctl.findWheres.at(-1)!
  const staleClause = (where.OR as Row[]).find((c) => c.status === 'PENDING_PAYMENT')!
  assert.ok(staleClause.createdAt?.lt instanceof Date, 'the threshold is a predicate, not a filter in JS')
  assert.equal(ctl.bookings.find((b) => b.id === 'bk_fresh')!.status, 'PENDING_PAYMENT')
})

test('4.7 one unreadable row never costs the rest of the pass', async () => {
  const m = await load()
  const rows = await Promise.all(
    [0, 1, 2].map((i) => holdRow({ id: `bk_${i}`, ageMs: (10 + i) * 3_600_000, sessionId: `cs_${i}` })),
  )
  ctl = newCtl(rows)
  const e = edge()
  e.sessions.set('cs_0', session('cs_0', NOW - 9 * 3_600_000))
  // cs_1 is absent from Stripe entirely; cs_2 is a normal expiry.
  e.sessions.set('cs_2', session('cs_2', NOW - 9 * 3_600_000))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.scanned, 3)
  assert.equal(report.staleHolds, 2)
  assert.equal(report.stillPayable, 1, 'an unknown session is "not provably dead", not "abandoned"')
  assert.deepEqual(
    ctl.bookings.map((b) => b.status),
    ['PENDING_PAYMENT', 'PENDING_PAYMENT', 'PENDING_PAYMENT'],
  )
})

test('4.8 a CANCELLED booking that still carries a payable session has it expired, and the owner is told', async () => {
  const m = await load()
  const row = await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A', status: 'CANCELLED' })
  row.updatedAt = new Date(NOW - 60_000)
  ctl = newCtl([row])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.retired, 1)
  assert.deepEqual(
    e.expired,
    ['cs_A'],
    'the ONE Stripe mutation left: a booking a HUMAN already cancelled cannot consume a payment, so a live session on ' +
      'it is $49 nobody could capture or release',
  )
  assert.equal(report.cancelled, 0, 'and expiring a session is not cancelling a booking')
  assert.equal(e.alerts.length, 1)
  assert.match(e.alerts[0].title, /Cancelled booking still carries/)
  assert.ok(e.alerts[0].lines.some((l) => /Stripe accepted a request to expire/.test(l.message)))
})

test('4.9 an expiry Stripe did NOT confirm is reported as unknown, never as done', async () => {
  const m = await load()
  const row = await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A', status: 'CANCELLED' })
  row.updatedAt = new Date(NOW - 60_000)
  ctl = newCtl([row])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))
  e.expireError = new Error('Stripe API unavailable (503)')

  await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(e.alerts.length, 1)
  assert.ok(e.alerts[0].lines.some((l) => /NOT known whether that session is still payable/.test(l.message)))
  assert.equal(
    e.alerts[0].lines.some((l) => /accepted a request to expire/.test(l.message)),
    false,
    'a failed expire may never be reported as an expiry',
  )
})

test('4.10 a cancelled booking whose session was AUTHORIZED is surfaced, not silently stranded', async () => {
  const m = await load()
  const row = await holdRow({ ageMs: 30 * 3_600_000, sessionId: 'cs_B', status: 'CANCELLED' })
  row.updatedAt = new Date(NOW - 5 * 60_000)
  ctl = newCtl([row])
  const e = edge()
  e.sessions.set('cs_B', session('cs_B', NOW - 20 * 60_000, { status: 'complete', payment_status: 'unpaid' }))

  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })

  assert.equal(report.authorized, 1)
  assert.deepEqual(e.expired, [], 'a COMPLETED session cannot be expired, and pretending otherwise would be a false claim')
  const text = e.alerts[0].lines.map((l) => `${l.message} ${l.action ?? ''}`).join(' ')
  assert.match(text, /COMPLETE/, 'the alert must say what Stripe actually reported')
  assert.equal(MONEY_CLAIM.test(text), false, 'and must not decide, on its own, what happened to the money')
})

// ════════════════════════════════════════════════════════════════════════════
//  5. THE OWNER'S RELEASE — the only exit, and every refusal on the way.
// ════════════════════════════════════════════════════════════════════════════

test('5.1 THE EXIT: the owner releases a stale hold, the truck comes back, and the decision is audited', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 29 * 3_600_000))

  const shapes = () =>
    m.truck.toTruckBookingShapes([
      {
        id: ctl.bookings[0].id,
        displayId: ctl.bookings[0].displayId,
        truckId: ctl.bookings[0].truckId,
        scheduledStart: ctl.bookings[0].scheduledStart ?? null,
        scheduledEnd: ctl.bookings[0].scheduledEnd ?? null,
        confirmedDate: ctl.bookings[0].confirmedDate ?? null,
        requestedDate: ctl.bookings[0].requestedDate ?? null,
        status: ctl.bookings[0].status,
        estimatedHours: ctl.bookings[0].estimatedHours ?? null,
      },
    ])
  const query = {
    truckId: TRUCK,
    start: new Date(ctl.bookings[0].requestedDate as Date),
    estimatedHours: ctl.bookings[0].estimatedHours as number,
  }
  assert.equal(m.truck.findTruckConflictsIn(shapes(), query).length, 1, 'precondition: the unpaid hold DOES occupy the truck')

  const result = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(e))

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.outcome, 'released')
  assert.equal(result.ok && result.sessionVerdict, 'expired')
  assert.equal(ctl.bookings[0].status, 'CANCELLED')
  assert.equal(
    m.truck.findTruckConflictsIn(shapes(), query).length,
    0,
    'THE WHOLE POINT: leaving TRUCK_HOLD_STATUSES is what frees the truck',
  )
  assert.equal(ctl.bookings[0].truckId, TRUCK, "the owner's assignment intent is preserved — nothing writes truckId: null")

  assert.equal(ctl.audits.length, 1)
  const audit = ctl.audits[0]
  const details = audit.details as Row
  assert.equal(audit.action, 'BOOKING_STATE_CHANGED')
  assert.equal(audit.userId, 'u_diego', 'a human decision must name the human')
  assert.equal(details.reason, 'owner_released_truck_hold')
  assert.equal(details.releasedBy, 'Diego')
  assert.equal(details.sessionVerdict, 'expired', 'what Stripe said when the owner decided is part of the record')
  assert.equal(details.acknowledgedRisk, false)
  assert.equal(details.truckHoldReleased, true)
  assert.equal(details.depositCaptured, false, 'no record may imply money moved — nothing here captures anything')
})

test('5.2 the state change and its audit row are ONE transaction', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: 'cs_A' })])
  ctl.auditError = new Error('audit_logs unavailable (test)')
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 29 * 3_600_000))

  await assert.rejects(
    async () => m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(e)),
    /audit_logs unavailable/,
  )
  assert.equal(
    ctl.bookings[0].status,
    'PENDING_PAYMENT',
    'a cancelled booking can never exist without the row that explains who cancelled it',
  )
  assert.equal(ctl.audits.length, 0)
  ctl.auditError = undefined
})

test('5.3 REFUSED: Stripe says the checkout completed — money may exist, so the release is impossible', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: 'cs_A' })])
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 20 * 60_000, { status: 'complete', payment_status: 'unpaid' }))

  const first = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(e))
  // And it stays impossible even if the caller insists.
  const insisted = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_b6', actor: OWNER, acknowledgeRisk: true },
    await depsWith(e),
  )

  assert.equal(first.ok, false)
  assert.equal(!first.ok && first.code, 'session_authorized')
  assert.equal(!first.ok && first.needsAcknowledgement, false)
  assert.equal(insisted.ok, false, 'this one is not an acknowledgeable risk — it is a hard refusal')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  assert.equal(ctl.audits.length, 0)
})

test('5.4 GUARDED: a still-payable session, or a Stripe that cannot be asked, needs an explicit acknowledgement', async () => {
  const m = await load()
  const cases: Array<[string, (e: SweepEdge) => void]> = [
    ['still payable', (e) => { e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' })) }],
    ['unreadable', (e) => { e.retrieveError = new Error('Stripe API unavailable (503)') }],
  ]
  for (const [label, setup] of cases) {
    ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: 'cs_A' })])
    const e = edge()
    setup(e)

    const refused = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(e))
    assert.equal(refused.ok, false, `${label}: must not release on the first ask`)
    assert.equal(!refused.ok && refused.code, 'needs_acknowledgement')
    assert.equal(!refused.ok && refused.needsAcknowledgement, true)
    assert.match(
      (!refused.ok && refused.message) || '',
      /cannot be un-cancelled/,
      `${label}: the owner must be told what is irreversible about it`,
    )
    assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')

    const confirmed = await m.expiry.releaseTruckHoldByOwner(
      { bookingId: 'bk_b6', actor: OWNER, acknowledgeRisk: true },
      await depsWith(e),
    )
    assert.equal(confirmed.ok, true, `${label}: a person may still decide`)
    assert.equal(ctl.bookings[0].status, 'CANCELLED')
    assert.equal((ctl.audits[0].details as Row).acknowledgedRisk, true, 'and the record says they were warned')
  }
})

test('5.5 REFUSED: a booking that reached the money path belongs to decline/refund, not here', async () => {
  const m = await load()
  const e = edge()

  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null, paymentIntentId: 'pi_live' })])
  const intent = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_b6', actor: OWNER, acknowledgeRisk: true },
    await depsWith(e),
  )
  assert.equal(!intent.ok && intent.code, 'payment_authorized')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')

  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null, depositPaid: true })])
  const paid = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_b6', actor: OWNER, acknowledgeRisk: true },
    await depsWith(e),
  )
  assert.equal(!paid.ok && paid.code, 'deposit_paid')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')

  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null, status: 'CONFIRMED' })])
  const confirmed = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_b6', actor: OWNER, acknowledgeRisk: true },
    await depsWith(e),
  )
  assert.equal(!confirmed.ok && confirmed.code, 'not_an_unpaid_hold')
  assert.equal(ctl.bookings[0].status, 'CONFIRMED')
  assert.equal(ctl.audits.length, 0)
})

test('5.6 permission and identity: CREW cannot release, an unknown booking is not found, a replay is honest', async () => {
  const m = await load()
  const e = edge()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null })])

  const crew = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_b6', actor: { userId: 'u_crew', name: 'Sam', role: 'CREW' } },
    await depsWith(e),
  )
  assert.equal(!crew.ok && crew.code, 'forbidden')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')

  const missing = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_nope', actor: OWNER }, await depsWith(e))
  assert.equal(!missing.ok && missing.code, 'not_found')

  const manager = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_b6', actor: { userId: 'u_m', name: 'Ana', role: 'MANAGER' } },
    await depsWith(e),
  )
  assert.equal(manager.ok, true, 'booking.decline is the right that ends any pre-capture booking, and MANAGER holds it')

  const replay = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(e))
  assert.equal(replay.ok && replay.outcome, 'already_released')
  assert.equal(ctl.audits.length, 1, 'a replay writes nothing — one release, one audit row')
})

test('5.7 two owners clicking at once: the conditional statement decides, and the loser is told the truth', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null })])
  const deps = await depsWith(edge())

  const [a, b] = await Promise.all([
    m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, deps),
    m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: { userId: 'u_m', name: 'Ana', role: 'MANAGER' } }, deps),
  ])

  const outcomes = [a, b].map((r) => (r.ok ? r.outcome : r.code)).sort()
  assert.equal(outcomes.filter((o) => o === 'released').length, 1, 'exactly one release')
  assert.equal(
    outcomes.filter((o) => o === 'already_released' || o === 'raced').length,
    1,
    'and the other says so honestly instead of reporting a release nobody performed',
  )
  assert.equal(ctl.audits.length, 1)
  assert.equal(ctl.bookings[0].status, 'CANCELLED')
})

test('5.8 the release gate is a pure policy, testable without a database', async () => {
  const m = await load()
  assert.deepEqual(m.expiry.releaseGate('expired', false), { allow: true })
  assert.deepEqual(m.expiry.releaseGate('none', false), { allow: true })
  assert.equal(m.expiry.releaseGate('authorized', true).allow, false)
  assert.equal(m.expiry.releaseGate('payable', false).allow, false)
  assert.equal(m.expiry.releaseGate('payable', true).allow, true)
  assert.equal(m.expiry.releaseGate('unreadable', false).allow, false)
  assert.equal(m.expiry.releaseGate('unreadable', true).allow, true)
})

test('5.9 the owner action is reachable: a checked route, and a button on the booking', () => {
  const route = readFileSync(resolve(process.cwd(), 'app/api/admin/bookings/[id]/release-hold/route.ts'), 'utf8')
  assert.match(route, /releaseTruckHoldByOwner\(/, 'the route must call the checked service, not write a booking itself')
  assert.equal(/prisma\.booking\.update/.test(route), false, 'and it must never write to a booking directly')
  assert.match(route, /can\(session\.role as Role, 'booking\.decline'\)/, 'permission-gated at the route as well')
  assert.match(route, /needs_acknowledgement/, 'and it must give the UI a way to confirm the named risk')

  const ui = readFileSync(
    resolve(process.cwd(), 'app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx'),
    'utf8',
  )
  assert.match(ui, /PENDING_PAYMENT:\s*\[/, 'the owner needs the action where the booking is')
  assert.match(ui, /release-hold/)
  assert.match(ui, /X-CSRF-Token/, 'admin writes are CSRF-gated by the middleware')
  assert.match(ui, /428/, 'and the UI must handle the "confirm this specific risk" answer')
})

// ════════════════════════════════════════════════════════════════════════════
//  6. THE ACTION CENTER — where a stale hold actually reaches the owner.
// ════════════════════════════════════════════════════════════════════════════

/** The loader's mapping (reminder-sync.ts) for the fields this rule reads,
 *  over the row the SHIPPED WRITER persists. */
function ruleBookingFrom(row: Row): Row {
  return {
    id: row.id,
    displayId: row.displayId,
    status: row.status,
    customerName: 'Maria Lopez',
    customerPhone: '+19735550100',
    customerEmail: 'maria@example.com',
    originAddress: '12 Main St, Newark, NJ 07102',
    destAddress: '99 Oak Ave, Montclair, NJ 07042',
    originVerification: null,
    destVerification: null,
    manualReviewRequired: false,
    agreementAccepted: true,
    totalEstimate: 900,
    scheduledStart: row.scheduledStart ?? null,
    scheduledEnd: row.scheduledEnd ?? null,
    requestedDate: row.requestedDate ?? null,
    completedAt: null,
    truckAddonDueOnMoveDay: false,
    truckProvider: null,
    truckReservationStatus: null,
    truckReservationNumber: null,
    jobStartedAt: null,
    truckId: row.truckId ?? null,
    confirmedDate: row.confirmedDate ?? null,
    estimatedHours: row.estimatedHours ?? null,
    startTimeKnown: !!row.scheduledStart,
    createdAt: row.createdAt,
    crew: [],
    hasFailedPayment: false,
    hasWorkerPayExpense: false,
    outstandingBalanceCents: 0,
    netRevenueCents: 0,
    netProfitCents: 0,
  }
}

test('6.1 a stale unpaid hold reaches the owner as an Action Center reminder', async () => {
  const m = await load()
  const now = new Date(NOW)
  const rule = ruleBookingFrom(await holdRow({ ageMs: 30 * 3_600_000 }))

  const candidates = m.rules.evaluateBooking(rule as never, now)
  const stale = candidates.filter((c) => c.reminderType === 'checkout-hold-stale')

  assert.equal(stale.length, 1)
  assert.equal(stale[0].sourceEntityType, 'booking')
  assert.equal(stale[0].sourceEntityId, 'bk_b6', 'it must link to the booking the owner has to decide about')
  assert.equal(
    stale[0].sourceUrl,
    '/admin/jobs/bk_b6',
    'and that link must land on the page that carries the "Release truck hold" button — otherwise the report is a dead end',
  )
  assert.equal(stale[0].dedupeKey, 'checkout-hold-stale:booking:bk_b6', 'deduped — an hourly report must not spam')
  assert.match(stale[0].description, /Release truck hold/, 'and it must name the action that ends it')
  assert.match(stale[0].description, /cannot be undone/)
  assert.equal(
    MONEY_CLAIM.test(`${stale[0].title} ${stale[0].description}`),
    false,
    "it must not claim anything about the customer's card",
  )
})

test('6.2 it is silent on a fresh hold, on a hold with no truck, and on any age it cannot prove', async () => {
  const m = await load()
  const now = new Date(NOW)
  const typed = (r: Row) => m.rules.evaluateBooking(r as never, now).filter((c) => c.reminderType === 'checkout-hold-stale')

  assert.equal(typed(ruleBookingFrom(await holdRow({ ageMs: 3 * 3_600_000 }))).length, 0, 'fresh: the funnel is still working')
  assert.equal(typed(ruleBookingFrom(await holdRow({ ageMs: 30 * 3_600_000, truckId: null }))).length, 0, 'no truck, no truck harm')
  const ageless = { ...ruleBookingFrom(await holdRow({ ageMs: 30 * 3_600_000 })), createdAt: undefined }
  assert.equal(typed(ageless).length, 0, 'age nobody can prove is age this rule does not assert')
})

test('6.3 releasing the hold RESOLVES the reminder — the surface is self-clearing', async () => {
  const m = await load()
  const now = new Date(NOW)
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null })])
  const before = m.rules.evaluateBooking(ruleBookingFrom(ctl.bookings[0]) as never, now)
  assert.equal(before.filter((c) => c.reminderType === 'checkout-hold-stale').length, 1)

  await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(edge()))

  const after = m.rules.evaluateBooking(ruleBookingFrom(ctl.bookings[0]) as never, now)
  assert.equal(
    after.filter((c) => c.reminderType === 'checkout-hold-stale').length,
    0,
    'computeSyncActions auto-resolves a candidate that stops being produced',
  )
})

test('6.4 the report threshold and the reminder threshold are related, not two hand-typed numbers', async () => {
  const m = await load()
  assert.ok(
    m.rules.STALE_UNPAID_HOLD_MS >= m.expiry.STALE_CHECKOUT_MIN_AGE_MS,
    'the Action Center must never list a hold the report itself considers too fresh to ask about',
  )
  // And the loader really supplies the column the rule needs.
  const sync = readFileSync(resolve(process.cwd(), 'src/lib/reminder-sync.ts'), 'utf8')
  assert.match(sync, /createdAt: b\.createdAt/, 'without this the rule is silent in production and nobody would notice')
  const scanLock = readFileSync(resolve(process.cwd(), 'src/lib/scan-lock.ts'), 'utf8')
  assert.match(scanLock, /PENDING_PAYMENT/, 'and the scan must load PENDING_PAYMENT rows at all')
})

test('6.5 the reporting threshold outlives the recovery sequence when it is switched on', async () => {
  const m = await load()
  assert.equal(m.expiry.abandonedRecoveryActive({}), false)
  assert.equal(m.expiry.staleHoldGraceMs({ active: false }), m.expiry.STALE_CHECKOUT_MIN_AGE_MS)
  assert.equal(m.expiry.STALE_CHECKOUT_MIN_AGE_MS, 2 * 3_600_000)

  const last = m.journeys.ABANDONED_STAGES.reduce((n, s) => Math.max(n, s.delay), 0)
  const grace = m.expiry.staleHoldGraceMs({ active: true })
  assert.ok(grace > last, `a report that fires before the last recovery email nags the owner about a live funnel (${last}ms)`)
  assert.equal(grace, last + m.expiry.RECOVERY_MARGIN_MS)
  assert.equal(
    m.expiry.staleHoldGraceMs({ active: true, stages: [{ delay: 5 * 24 * 3_600_000 }] }),
    5 * 24 * 3_600_000 + m.expiry.RECOVERY_MARGIN_MS,
    'derived, not typed: change the stages and this moves with them',
  )

  const src = readFileSync(resolve(process.cwd(), 'src/lib/journeys.ts'), 'utf8')
  assert.ok(/EMAIL_JOURNEYS_ENABLED/.test(src), 'journeys.ts must still gate on EMAIL_JOURNEYS_ENABLED')
  assert.ok(/_DISABLED/.test(src), 'and still support the per-journey override this mirrors')
  assert.equal(m.expiry.abandonedRecoveryActive({ EMAIL_JOURNEYS_ENABLED: 'true' }), true)
  assert.equal(
    m.expiry.abandonedRecoveryActive({ EMAIL_JOURNEYS_ENABLED: 'true', EMAIL_JOURNEY_ABANDONED_DISABLED: 'true' }),
    false,
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  7. THE MUTATION PROOF — this harness can still see the removed defect, and
//     the defect cannot creep back in unnoticed.
// ════════════════════════════════════════════════════════════════════════════

test("7.1 MUTATION: rebuild B6's automatic cancellation and the mid-payment booking IS cancelled", async () => {
  const m = await load()
  // §3.1's exact input: a booking whose customer is being redirected into cs_C.
  ctl = newCtl([await holdRow({ ageMs: 48 * 3_600_000, sessionId: 'cs_B' })])
  const e = edge()
  e.sessions.set('cs_B', session('cs_B', NOW - 20 * 60_000, { status: 'expired' }))

  // The removed code, reconstructed: the report's rows, and B6's conditional
  // claim with its three guards — session identity, unpaid hold, and the grace
  // period. ALL THREE PASS HERE. That is the point: they were never the
  // question. The question is whether the booking has a LIVE session, which
  // nothing in this system can answer.
  const report = await m.expiry.reportStaleCheckouts(await depsWith(e), { graceMs: 2 * 3_600_000 })
  assert.equal(report.findings.length, 1, 'the report still finds the row — it just refuses to act on it')
  for (const finding of report.findings) {
    const claim = await fakePrisma.booking.updateMany({
      where: {
        id: finding.bookingId,
        status: 'PENDING_PAYMENT',
        depositPaid: false,
        stripeCheckoutId: finding.sessionId,
        createdAt: { lt: new Date(NOW - 2 * 3_600_000) },
      },
      data: { status: 'CANCELLED' },
    })
    assert.equal(claim.count, 1, 'every B6 guard passes on this input — this IS the reproduction')
  }

  assert.equal(
    ctl.bookings[0].status,
    'CANCELLED',
    'THIS is what was removed; §3.1 runs the same input through the shipped code and it survives',
  )
})

test('7.2 MUTATION: and it is irreversible — the customer completes cs_C into a booking nothing can claim', () => {
  // Continues 7.1: fulfilment's atomic claim matches PENDING_PAYMENT/DRAFT only.
  const fulfilment = readFileSync(resolve(process.cwd(), 'src/lib/fulfillment.ts'), 'utf8')
  assert.match(
    fulfilment,
    /PENDING_PAYMENT[\s\S]{0,120}DRAFT/,
    'the claim only matches a pre-payment booking, so a cancelled one strands the $49',
  )
  const routeSrc = readFileSync(resolve(process.cwd(), 'app/api/admin/bookings/[id]/status/route.ts'), 'utf8')
  assert.equal(
    /CANCELLED:\s*\[/.test(routeSrc.slice(routeSrc.indexOf('VALID_TRANSITIONS'), routeSrc.indexOf('const StatusSchema'))),
    false,
    'and nobody could put it back',
  )
})

test('7.3 SOURCE GUARD: no automatic path in this feature writes a booking status', () => {
  const expiry = readFileSync(resolve(process.cwd(), 'src/lib/checkout-expiry.ts'), 'utf8')

  // The ONLY booking write in the module is the owner action's writer.
  const writes = Array.from(expiry.matchAll(/booking\.updateMany|booking\.update\b/g))
  assert.equal(writes.length, 1, `exactly one booking write may exist in this module (found ${writes.length})`)
  const writerStart = expiry.indexOf('async releaseTruckHold(input)')
  assert.ok(writerStart > -1, 'and it must live inside releaseTruckHold — the human path')
  assert.ok(
    writes[0].index! > writerStart,
    'a booking write outside releaseTruckHold is an automatic cancellation by another name',
  )

  // The removed API must not come back under its old names — as an export, as a
  // dep, or as a call. (The header still NAMES them in prose, deliberately:
  // whoever reads this module next must know what was removed and why.)
  const code = expiry
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n')
  for (const gone of ['releaseExpiredCheckoutHold', 'cancelUnpaidHold', 'sweepStaleCheckouts']) {
    assert.equal(new RegExp(`${gone}\\s*[(:]`).test(code), false, `${gone} was removed by D1 — no dormant loaded gun`)
    assert.equal(code.includes(`function ${gone}`), false, `${gone} was removed by D1`)
  }

  // The webhook case records; it must not write, and it must not cancel.
  const events = readFileSync(resolve(process.cwd(), 'src/lib/stripe-events.ts'), 'utf8')
  const start = events.indexOf("case 'checkout.session.expired'")
  assert.ok(start > -1, 'the case must still exist')
  const block = events.slice(start, events.indexOf("case 'charge.refunded'", start))
  assert.match(block, /handleCheckoutSessionExpired\(/, 'the recording handler must be what runs')
  assert.match(block, /sessionId: session\.id/)
  assert.match(block, /eventCreatedSec: event\.created/)
  assert.equal(/prisma\.booking\.update/.test(block), false, 'the case must never write to a booking')
  assert.equal(/CANCELLED/.test(block), false, 'and must never put one in a terminal state')

  // The cron runs the REPORT.
  const worker = readFileSync(resolve(process.cwd(), 'src/workers/scheduled.worker.ts'), 'utf8')
  const caseStart = worker.indexOf("case 'stale-checkout-sweep'")
  assert.ok(caseStart > -1, 'a cron with no handler is a cron that does nothing')
  const caseBlock = worker.slice(caseStart, caseStart + 1400)
  assert.match(caseBlock, /reportStaleCheckouts\(/, 'the scheduled job must call the REPORT')
  assert.equal(/releaseExpiredCheckoutHold|cancelUnpaidHold|sweepStaleCheckouts\(/.test(caseBlock), false)
  assert.match(worker, /jobId: 'cron:stale-checkout-sweep'/, 'a stable repeat id stops every worker start re-scheduling it')
  const queues = readFileSync(resolve(process.cwd(), 'src/lib/queues/index.ts'), 'utf8')
  assert.match(queues, /'stale-checkout-sweep'/, "ScheduledJobData must admit the job type or the add() won't type")
})

test('7.4 the module explains what automatic cancellation would require before it could ever be safe', () => {
  const expiry = readFileSync(resolve(process.cwd(), 'src/lib/checkout-expiry.ts'), 'utf8')
  const header = expiry.slice(0, expiry.indexOf('import { prisma }'))
  assert.ok(header.length > 0, 'the header must still be there')
  assert.match(header, /DURABLE PER-BOOKING RECORD OF/i, 'the condition for ever doing this automatically')
  assert.match(header, /EVERY SESSION/i)
  assert.match(header, /mid-payment/i, 'and it must name the reproduction that removed it')
  assert.match(header, /TERMINAL|no key out of CANCELLED|cannot be un-cancelled/i)
})

// ════════════════════════════════════════════════════════════════════════════
//  8. HONESTY — no message or record may state that money moved.
// ════════════════════════════════════════════════════════════════════════════

test('8.1 neither owner alert claims a payment outcome', async () => {
  const m = await load()
  const drafts = [
    m.expiry.authorizedButUnpaidAlert({ bookingId: 'bk_1', displayId: 'WMIC-1042', sessionId: 'cs_A' }),
    m.expiry.cancelledWithLiveSessionAlert({ bookingId: 'bk_1', displayId: 'WMIC-1042', sessionId: 'cs_A', verdict: 'authorized', expired: 'not-attempted' }),
    m.expiry.cancelledWithLiveSessionAlert({ bookingId: 'bk_1', displayId: 'WMIC-1042', sessionId: 'cs_A', verdict: 'open', expired: 'yes' }),
    m.expiry.cancelledWithLiveSessionAlert({ bookingId: 'bk_1', displayId: 'WMIC-1042', sessionId: 'cs_A', verdict: 'open', expired: 'unknown' }),
  ]
  for (const d of drafts) {
    const text = [d.title, ...d.lines.map((l) => `${l.message} ${l.action ?? ''}`)].join(' ')
    assert.equal(MONEY_CLAIM.test(text), false, `an alert must not state a payment outcome: ${text}`)
    assert.ok(/WMIC-1042/.test(text), 'and it must name the booking a human has to open')
    assert.ok(/cs_A/.test(text), 'and the session')
  }
})

test('8.2 the release record and its message claim only what this code did', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 30 * 3_600_000, sessionId: null })])

  const result = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_b6', actor: OWNER }, await depsWith(edge()))

  assert.equal(result.ok, true)
  const message = result.ok ? result.message : ''
  assert.match(message, /cancelled/i, 'it may state the state change it performed')
  assert.equal(
    /your (?:card|deposit)|the customer'?s card|authorization (?:was|has been) (?:released|voided)|refund(?:ed)? in full/i.test(message),
    false,
    "it may NOT state what happened to the customer's authorization — this code never asked Stripe to change one",
  )
  const details = ctl.audits[0].details as Row
  assert.equal(details.depositCaptured, false)
  assert.equal(MONEY_CLAIM.test(JSON.stringify(details)), false)
})

// ════════════════════════════════════════════════════════════════════════════
//  9. THE WIRING — through the SHIPPED webhook entry point, real signature.
// ════════════════════════════════════════════════════════════════════════════

const signer = new Stripe('sk_test_checkout_expiry', { apiVersion: '2024-06-20' })

function signed(event: Record<string, unknown>): { body: string; signature: string } {
  const body = JSON.stringify(event)
  return { body, signature: signer.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET }) }
}

function expiredEvent(id: string, sessionId: string, createdMs: number, bookingId: string | null): Record<string, unknown> {
  const created = sec(createdMs)
  return {
    id,
    type: 'checkout.session.expired',
    created: created + SESSION_TTL_SEC,
    data: {
      object: {
        id: sessionId,
        status: 'expired',
        payment_status: 'unpaid',
        created,
        expires_at: created + SESSION_TTL_SEC,
        metadata: bookingId ? { bookingId } : {},
      },
    },
  }
}

test('9.1 a signed expiry event is processed, recorded, and changes no booking', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A', nowMs: Date.now() })])
  const { body, signature } = signed(expiredEvent('evt_expired_1', 'cs_A', Date.now() - 40 * 60_000, 'bk_b6'))

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: m.events.processStripeEventJob,
  })

  assert.equal(res.status, 200)
  assert.equal(ctl.webhookLogs.get('evt_expired_1')?.status, 'processed', 'the webhook_logs row IS the durable record')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT', 'D1: the handler records, it does not cancel')
  assert.equal(ctl.audits.length, 0)
})

test('9.2 an infrastructure failure in the expiry handler reaches Stripe as a retryable 500', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_A', nowMs: Date.now() })])
  ctl.readError = new Error("Can't reach database server (test)")
  const { body, signature } = signed(expiredEvent('evt_expired_2', 'cs_A', Date.now() - 40 * 60_000, 'bk_b6'))

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: m.events.processStripeEventJob,
  })

  assert.equal(res.status, 500, 'returning normally would record the event processed and retire the only retry')
  assert.equal(ctl.webhookLogs.get('evt_expired_2')?.status, 'failed')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
  ctl.readError = undefined
})

test('9.3 an expiry for a session the booking no longer carries is FINISHED, not retried forever', async () => {
  const m = await load()
  ctl = newCtl([await holdRow({ ageMs: 5 * 3_600_000, sessionId: 'cs_B', nowMs: Date.now() })])
  const { body, signature } = signed(expiredEvent('evt_expired_3', 'cs_A', Date.now() - 40 * 60_000, 'bk_b6'))

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: m.events.processStripeEventJob,
  })

  assert.equal(res.status, 200)
  assert.equal(ctl.webhookLogs.get('evt_expired_3')?.status, 'processed')
  assert.equal(ctl.bookings[0].status, 'PENDING_PAYMENT')
})

test('9.4 TRUCK_HOLD_STATUSES is untouched — the hold was never the bug', async () => {
  const m = await load()
  assert.deepEqual(
    [...m.truck.TRUCK_HOLD_STATUSES],
    ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'PENDING_PAYMENT'],
    'R2-2: a truck the owner assigned to an unpaid booking IS held. B6 was the missing EXIT, not the hold.',
  )
  assert.equal(m.truck.holdsTruck('CANCELLED'), false, 'and leaving the list is what frees the truck')
})
