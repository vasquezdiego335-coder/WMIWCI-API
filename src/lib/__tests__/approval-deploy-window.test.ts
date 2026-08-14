// ════════════════════════════════════════════════════════════════════════════
//  approval-deploy-window.test.ts — ITEM R3-2
//
//  THE DEFECT: migrations here are applied BY HAND, so "code deployed, SQL not
//  yet run" is a NORMAL state that lasts hours. `approveBooking`'s first
//  statement is `store.loadBooking`, which in production was
//      prisma.booking.findFirst({ include: { customer: true } })
//  An `include` (like an omitted `select`) makes Prisma ask Postgres for
//  `$scalars` FROM THE GENERATED SCHEMA — which now declares `startTimeKnown`
//  and `staffingPlan`. In that window the read raises P2022 and approveBooking
//  throws before anything runs. Neither approval surface wraps it, so EVERY
//  approval 500'd and NO deposit was captured. The admin status route died one
//  step earlier on its own unqualified read.
//
//  WHY ROUND 2'S TEST DID NOT CATCH IT: it made an INJECTED read fail
//  (`loadStaffingBookingRow(read)` with a hand-thrown P2022) — a property
//  adjacent to the guarantee. The store the production flow actually uses was
//  never exercised.
//
//  SO THIS FILE DRIVES THE SHIPPED PATH:
//    • the booking row is what the SHIPPED WRITER persists — `resolveMoveSchedule`
//      → `buildBookingCreateData` on the DEFAULT owner path (deposit
//      `stripe_link`, no crew start time), then the exact `updateMany` payload
//      `fulfillment.ts` writes when the $49 hold is authorized. Nothing is
//      hand-shaped, and a column the database does not have is DELETED from the
//      row, because a row cannot carry a column that does not exist.
//    • `defaultApprovalDeps()` — the REAL `prismaApprovalStore` — runs against a
//      fake `prisma` installed on `globalThis` before `src/lib/db.ts` is first
//      imported (db.ts reads `globalThis.prisma` before constructing a client).
//      Only the Stripe gateway, the notifier and the logger are faked; every
//      read on the approval path is the shipped one.
//    • the fake behaves like Postgres during the window: a `select` (or an
//      unqualified read) naming a column the database lacks raises P2022. The
//      first test PINS that the fake really does reproduce the outage.
//
//  Offline: no database, no Stripe, no Redis. Run:
//    npx tsx --test src/lib/__tests__/approval-deploy-window.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── The fake database ───────────────────────────────────────────────────────
// Installed on globalThis FIRST: `src/lib/db.ts` does
// `globalForPrisma.prisma ?? new PrismaClient(...)`, so this must be in place
// before ANY module that imports db.ts is loaded. That is why every app import
// in this file is dynamic (see `load()`), and why nothing above this line
// imports from '../'.

type Row = Record<string, unknown>

/** Booking columns added by the round-2/3 migrations — the ones a
 *  code-before-SQL deploy does not have yet. */
const NEW_COLUMNS = ['staffingPlan', 'startTimeKnown'] as const

type FakeDb = {
  /** Booking columns the DATABASE does not have (empty = migrations applied). */
  missing: readonly string[]
  booking: Row
  /** Every select the code handed to a booking read, in order. */
  bookingSelects: Array<Record<string, unknown> | undefined>
  /** Every `data` payload written to the booking row, in order. */
  bookingWrites: Row[]
  payments: Row[]
  audits: Row[]
  jobs: Map<string, string>
  requirements: Map<string, Row>
  requirementCalls: { find: number; create: number; update: number }
  /** Force a NON-migration failure on booking reads (a real outage). */
  readError?: Error
}

function newDb(booking: Row, missing: readonly string[] = []): FakeDb {
  const row = { ...booking }
  // A column the database does not have cannot be ON the row either.
  missing.forEach((col) => delete row[col])
  return {
    missing,
    booking: row,
    bookingSelects: [],
    bookingWrites: [],
    payments: [],
    audits: [],
    jobs: new Map(),
    requirements: new Map(),
    requirementCalls: { find: 0, create: 0, update: 0 },
  }
}

let db: FakeDb = newDb({ id: 'bk_none' })

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** Prisma's unapplied-migration error, in the shape `isMigrationMissing` reads. */
function p2022(column: string): Error {
  return Object.assign(
    new Error(`The column \`bookings.${snake(column)}\` does not exist in the current database.`),
    { code: 'P2022' },
  )
}

/** Postgres-ish projection. An omitted `select` is what Prisma turns into
 *  "$scalars from the generated schema" — every column, including the ones this
 *  database has never heard of. */
function project(row: Row, select: Record<string, unknown> | undefined, missing: readonly string[]): Row {
  if (!select) {
    if (missing.length > 0) throw p2022(missing[0])
    return { ...row }
  }
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) {
    if (missing.indexOf(key) > -1) throw p2022(key)
    if (!val) continue
    out[key] = row[key] ?? null
  }
  return out
}

function assertWritable(data: Row, missing: readonly string[]): void {
  for (const key of Object.keys(data)) if (missing.indexOf(key) > -1) throw p2022(key)
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  const or = where.OR as Row[] | undefined
  if (or) return or.some((clause) => matchesWhere(row, clause))
  for (const [key, val] of Object.entries(where)) {
    if (key === 'OR') continue
    if (val && typeof val === 'object' && 'in' in (val as Row)) {
      if (!((val as { in: unknown[] }).in ?? []).includes(row[key])) return false
      continue
    }
    if (row[key] !== val) return false
  }
  return true
}

const fakePrisma = {
  booking: {
    async findFirst(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      db.bookingSelects.push(args.select)
      if (db.readError) throw db.readError
      if (!matchesWhere(db.booking, args.where)) return null
      return project(db.booking, args.select, db.missing)
    },
    async findUnique(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      db.bookingSelects.push(args.select)
      if (db.readError) throw db.readError
      if (!matchesWhere(db.booking, args.where)) return null
      return project(db.booking, args.select, db.missing)
    },
    async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      assertWritable(args.data, db.missing)
      if (!matchesWhere(db.booking, args.where)) return { count: 0 }
      db.bookingWrites.push({ ...args.data })
      Object.assign(db.booking, args.data)
      return { count: 1 }
    },
    async update(args: { where?: Row; data: Row; select?: Record<string, unknown> }): Promise<Row> {
      // Prisma's UPDATE ... RETURNING: the returned columns are checked too, so
      // the write fails as a unit when one of them does not exist.
      assertWritable(args.data, db.missing)
      const returned = project(db.booking, args.select, db.missing)
      db.bookingWrites.push({ ...args.data })
      Object.assign(db.booking, args.data)
      return { ...returned, ...args.data }
    },
  },
  payment: {
    async upsert(args: { where: { stripePaymentIntentId: string }; update: Row; create: Row }): Promise<Row> {
      const existing = db.payments.find((p) => p.stripePaymentIntentId === args.where.stripePaymentIntentId)
      if (existing) {
        Object.assign(existing, args.update)
        return existing
      }
      const created = { ...args.create }
      db.payments.push(created)
      return created
    },
  },
  job: {
    async findUnique(args: { where: { bookingId?: string }; select?: Record<string, unknown> }): Promise<Row | null> {
      const id = args.where.bookingId ? db.jobs.get(args.where.bookingId) : null
      return id ? { id } : null
    },
    async upsert(args: { where: { bookingId: string }; create: Row }): Promise<Row> {
      const existing = db.jobs.get(args.where.bookingId)
      if (existing) return { id: existing }
      const id = `job_${db.jobs.size + 1}`
      db.jobs.set(args.where.bookingId, id)
      return { id, ...args.create }
    },
  },
  auditLog: {
    async create(args: { data: Row }): Promise<Row> {
      db.audits.push(args.data)
      return args.data
    },
    async count(): Promise<number> {
      return db.audits.length
    },
  },
  jobStaffingRequirement: {
    async findUnique(args: { where: { jobId: string } }): Promise<Row | null> {
      db.requirementCalls.find++
      return db.requirements.get(args.where.jobId) ?? null
    },
    async create(args: { data: Row & { jobId: string } }): Promise<Row> {
      db.requirementCalls.create++
      db.requirements.set(args.data.jobId, { ...args.data })
      return args.data
    },
    async update(args: { where: { jobId: string }; data: Row }): Promise<Row> {
      db.requirementCalls.update++
      const row = db.requirements.get(args.where.jobId) ?? {}
      Object.assign(row, args.data)
      db.requirements.set(args.where.jobId, row)
      return row
    },
  },
  async $transaction(arg: unknown): Promise<unknown> {
    if (Array.isArray(arg)) return Promise.all(arg)
    return (arg as (tx: unknown) => Promise<unknown>)(fakePrisma)
  },
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

// ── Modules under test (loaded only AFTER the fake is installed) ─────────────

type Mods = {
  approval: typeof import('../booking-approval')
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  scheduling: typeof import('../scheduling')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    approval: await import('../booking-approval'),
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    scheduling: await import('../scheduling'),
  }
  const dbModule = await import('../db')
  assert.equal(
    dbModule.prisma as unknown,
    fakePrisma,
    'the fake prisma must be the client the shipped modules use — otherwise this file tests nothing',
  )
  return mods
}

// ── The row the SHIPPED WRITER persists (round-3 rule) ──────────────────────

const MOVE_DAY = '2027-07-15' // EDT, so the day anchor is 04:00Z

async function createdRow(over: { startTime?: string } = {}): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: MOVE_DAY,
      // The default: the owner takes the booking on the phone and commits to a
      // DATE, not an hour.
      ...(over.startTime ? { startTime: over.startTime } : {}),
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    deposit: { mode: 'stripe_link' }, // THE default owner path
    pricing: { ownerTotal: 700, overrideReason: 'phone quote' },
  })
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  const input = parsed.data
  const schedule = m.adminBooking.resolveMoveSchedule(input.move, {
    estimatedHours: 4,
    helpers: { toInstant: m.scheduling.etDateTimeToInstant, endTime: m.scheduling.calculateEndTime },
  })
  assert.ok(schedule.requestedDate)
  const data = m.adminBooking.buildBookingCreateData(
    input,
    {
      estimate: m.estimate.computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1001',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  assert.equal(data.status, 'PENDING_PAYMENT', 'precondition: the default path creates an unpaid hold')

  // The $49 authorization lands — byte-for-byte fulfillment.ts's claim.
  return {
    id: 'bk_dw',
    customerToken: 'tok_dw',
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: null,
    truck: null,
    inventoryItems: [],
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...(data as Row),
    status: 'PENDING_APPROVAL',
    depositPaid: false,
    stripePaymentIntentId: 'pi_dw',
  }
}

// ── The shipped deps, with only Stripe / notifications / logging faked ───────

type Recorder = {
  captures: Array<{ pi: string; key: string }>
  notified: Array<{ cents: number; by: string }>
  warns: unknown[]
  errors: unknown[]
  infos: unknown[]
}

async function shippedDeps(): Promise<Recorder> {
  const m = await load()
  const rec: Recorder = { captures: [], notified: [], warns: [], errors: [], infos: [] }
  const deps = m.approval.defaultApprovalDeps() // the REAL prismaApprovalStore
  deps.stripe = {
    async capture(pi, key) {
      rec.captures.push({ pi, key })
      return { id: pi, amount_received: 4900, latest_charge: 'ch_dw', metadata: {} }
    },
    async retrieveCharge() {
      return { id: 'ch_dw', receipt_url: 'https://receipt.example/ch_dw', payment_method_details: { type: 'card' } }
    },
    async releaseHold() {},
  }
  deps.notifier = {
    async sendApproved(_b, cents, by) {
      rec.notified.push({ cents, by })
    },
    async sendDeclined() {},
  }
  deps.logger = {
    info: (o) => rec.infos.push(o),
    warn: (o) => rec.warns.push(o),
    error: (o) => rec.errors.push(o),
  }
  return rec
}

/** Approve through the SHIPPED default deps — `approveBooking` resolves the
 *  store itself, exactly as both production surfaces call it. */
async function approve(): Promise<Awaited<ReturnType<typeof import('../booking-approval').approveBooking>>> {
  const m = await load()
  return m.approval.approveBooking({
    bookingId: 'bk_dw',
    actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' },
    source: 'admin',
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  1. The fake really is the outage (without this, nothing below means anything)
// ════════════════════════════════════════════════════════════════════════════

test('R3-2 precondition: an unqualified read of this row DOES raise P2022 in the window', async () => {
  const m = await load()
  db = newDb(await createdRow(), NEW_COLUMNS)

  // What production used to do: no select at all → Prisma asks for $scalars.
  await assert.rejects(
    () => fakePrisma.booking.findUnique({ where: { id: 'bk_dw' } }),
    (e: unknown) => (e as { code?: string }).code === 'P2022',
    'the fake must reproduce the deploy-window failure, or this file proves nothing',
  )
  // And an `include`-style read of the new columns fails the same way.
  await assert.rejects(
    () => fakePrisma.booking.findFirst({ where: { id: 'bk_dw' }, select: { id: true, startTimeKnown: true } }),
    (e: unknown) => m.approval.isMigrationMissing(e),
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE GUARANTEE — the money still moves, and the job is still staffed
// ════════════════════════════════════════════════════════════════════════════

test('R3-2: during the code-before-SQL window an approval still captures, confirms and staffs', async () => {
  db = newDb(await createdRow(), NEW_COLUMNS)
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `approval must not throw or fail in the deploy window: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'captured')
  assert.equal(res.ok && res.capturedCents, 4900)

  // The deposit was really captured, exactly once, with the idempotency key.
  assert.equal(rec.captures.length, 1)
  assert.deepEqual(rec.captures[0], { pi: 'pi_dw', key: 'capture:pi_dw' })

  // The booking is CONFIRMED and the money is recorded.
  assert.equal(db.booking.status, 'CONFIRMED')
  assert.equal(db.booking.depositPaid, true)
  assert.equal(db.payments.length, 1)
  assert.equal(db.payments[0].amount, 4900)
  assert.equal(db.payments[0].status, 'COMPLETED')
  assert.equal(db.jobs.size, 1, 'the Job must exist')

  // …and the job got its staffing requirement from a DERIVED plan — the whole
  // point of the ladder: only the new-column-dependent behaviour degrades.
  assert.equal(db.requirements.size, 1, 'the confirmed job must be staffed')
  const req = db.requirements.get('job_1')!
  assert.ok((req.requiredWorkers as number) >= 2)
  assert.equal(db.requirementCalls.create, 1)

  // The ladder really ran: one attempt WITH the new column, then a retry
  // without it (the store logs its own warning through apiLogger, which the
  // test run prints — the select trail is the deterministic evidence).
  const first = db.bookingSelects[0] as Row
  const second = db.bookingSelects[1] as Row
  assert.ok('startTimeKnown' in first, 'the first read must still ask for the newest column')
  assert.ok(!('startTimeKnown' in second) && 'status' in second, 'the retry must drop it and keep the rest')
  assert.ok(
    rec.infos.some((i) => (i as { planSource?: string }).planSource === 'derived'),
    'the staffing plan could not be read, so it must be DERIVED — never claimed as the owner\'s',
  )
  assert.equal(rec.notified.length, 1, 'the customer is still told')
  assert.equal(rec.notified[0].cents, 4900)
})

// ════════════════════════════════════════════════════════════════════════════
//  3. The "Also" clause — an UNREADABLE flag must not promote the day anchor
// ════════════════════════════════════════════════════════════════════════════

test('R3-2: a day-level booking stays day-level when startTimeKnown cannot be read', async () => {
  const row = await createdRow()
  assert.equal(row.startTimeKnown, false, 'precondition: the writer recorded a day-level booking')
  db = newDb(row, NEW_COLUMNS)
  assert.ok(!('startTimeKnown' in db.booking), 'precondition: the column is not in this database')
  await shippedDeps()

  const res = await approve()
  assert.ok(res.ok)

  // The 00:00 ET anchor is NOT promoted into scheduledStart: the whole ET day
  // stays held for truck conflicts, and no crew is told to report at midnight.
  assert.equal(db.booking.scheduledStart, null, 'no invented crew hour')
  assert.equal(db.booking.scheduledEnd, null)
  assert.equal(
    (db.booking.confirmedDate as Date).toISOString(),
    '2027-07-15T04:00:00.000Z',
    'the DATE is confirmed — 00:00 ET on the move day',
  )
  // The claim UPDATE itself wrote the null (this is the row production persists).
  const claim = db.bookingWrites.find((w) => w.status === 'CONFIRMED')
  assert.ok(claim, 'the atomic claim must have run')
  assert.equal(claim!.scheduledStart, null)

  // The staffing requirement inherits it — no 12:00 AM report time.
  assert.equal(db.requirements.get('job_1')!.estimatedStartAt, null)
})

test('R3-2: a TIMED booking still keeps its real hour when the flag cannot be read', async () => {
  const row = await createdRow({ startTime: '09:00' })
  assert.equal(row.startTimeKnown, true, 'precondition: the writer recorded a real hour')
  db = newDb(row, NEW_COLUMNS)
  await shippedDeps()

  const res = await approve()
  assert.ok(res.ok)
  assert.equal(
    (db.booking.scheduledStart as Date).toISOString(),
    '2027-07-15T13:00:00.000Z',
    '9:00 AM EDT — a real hour is never mistaken for a day anchor',
  )
  assert.ok(db.booking.scheduledEnd, 'a timed job gets an end too')
  assert.ok(db.requirements.get('job_1')!.estimatedStartAt, 'the crew reports at the real hour')
})

// ════════════════════════════════════════════════════════════════════════════
//  4. Nothing degrades once the SQL is applied
// ════════════════════════════════════════════════════════════════════════════

test('R3-2: with the migrations applied the approval takes the full select, once', async () => {
  db = newDb(await createdRow()) // healthy database — no missing columns
  const rec = await shippedDeps()

  const res = await approve()
  assert.ok(res.ok && res.outcome === 'captured')
  assert.equal(db.requirements.size, 1)

  // Every read asked for the new columns and none had to be retried.
  assert.ok(db.bookingSelects.length > 0)
  for (const select of db.bookingSelects) {
    assert.ok(select, 'no read on this path may omit its select')
  }
  assert.ok(
    db.bookingSelects.some((s) => s && 'startTimeKnown' in s),
    'the healthy path must still ask for the flag',
  )
  assert.equal(rec.warns.length, 0, 'a healthy database must not log a degraded read')
  assert.ok(rec.infos.every((i) => (i as { degraded?: boolean }).degraded !== true))
})

// ════════════════════════════════════════════════════════════════════════════
//  5. A real outage is NOT quietly treated as a missing column
// ════════════════════════════════════════════════════════════════════════════

test('R3-2: a genuine database outage still fails loudly — no half-approval', async () => {
  db = newDb(await createdRow(), NEW_COLUMNS)
  db.readError = new Error('connection terminated unexpectedly')
  const rec = await shippedDeps()

  await assert.rejects(() => approve(), /connection terminated/)
  assert.equal(rec.captures.length, 0, 'nothing may be captured when we cannot read the booking')
  assert.equal(db.booking.status, 'PENDING_APPROVAL')
})

// ════════════════════════════════════════════════════════════════════════════
//  6. The admin status route's OWN read — the step that died first
// ════════════════════════════════════════════════════════════════════════════

test('R3-2: the status route gate read survives the window and still sees depositPaid', async () => {
  const m = await load()
  db = newDb(await createdRow(), NEW_COLUMNS)

  // The exact expression app/api/admin/bookings/[id]/status/route.ts evaluates.
  const { booking, degraded, reason } = await m.approval.loadApprovableBooking<
    import('../booking-approval').StatusRouteBooking
  >(
    (select) => fakePrisma.booking.findUnique({ where: { id: 'bk_dw' }, select }),
    m.approval.STATUS_ROUTE_EXTRA_COLUMNS,
  )
  assert.ok(booking, 'the route must still find the booking')
  assert.equal(booking!.status, 'PENDING_APPROVAL')
  assert.equal(booking!.depositPaid, false, 'the declined-vs-cancelled copy still has its input')
  assert.equal(booking!.customer.email, 'maria@example.com')
  assert.equal(degraded, true)
  assert.match(String(reason), /startTimeKnown/)

  // Two attempts: with the new column, then without it.
  assert.equal(db.bookingSelects.length, 2)
  assert.ok('startTimeKnown' in (db.bookingSelects[0] as Row))
  assert.ok(!('startTimeKnown' in (db.bookingSelects[1] as Row)))

  // And the row it hands back is day-level by SHAPE, since the flag is gone.
  assert.equal(m.scheduling.moveIsDayLevel(booking!), true)
  assert.equal(m.scheduling.confirmationScheduleData(booking!)?.scheduledStart, null)
})

// ════════════════════════════════════════════════════════════════════════════
//  7. Source guard — no production read on this path may ask for every column
// ════════════════════════════════════════════════════════════════════════════

const ROOT = process.cwd()

/** Comments stripped, so a REGRESSION cannot hide behind prose that mentions
 *  the right words (and prose about the fix cannot fake a pass). */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const APPROVAL_PATH_FILES = ['src/lib/booking-approval.ts', 'app/api/admin/bookings/[id]/status/route.ts']

test('R3-2: every booking read on the approval path names its columns or has a fallback', () => {
  for (const file of APPROVAL_PATH_FILES) {
    const src = code(file)
    // Only the operations that RETURN columns can be broken by a column the
    // database does not have; `updateMany` returns a count.
    const pattern = /prisma\.booking\.(?:findFirst|findUnique|findMany|update|upsert)\(/g
    let found = 0
    let call: RegExpExecArray | null
    while ((call = pattern.exec(src)) !== null) {
      found++
      const window = src.slice(call.index, call.index + 300)
      assert.ok(
        /\bselect\b/.test(window) || /isMigrationMissing/.test(window),
        `${file}: ${call[0]} asks Postgres for every generated column with no degraded fallback — ` +
          'this is the exact statement that 500\'d every approval during the deploy window',
      )
    }
    assert.ok(found > 0, `${file} must still contain the reads under test`)
    assert.ok(
      !/include:\s*\{\s*customer:\s*true/.test(src),
      `${file}: include-everything is back — it expands to $scalars from the GENERATED schema`,
    )
  }
})
