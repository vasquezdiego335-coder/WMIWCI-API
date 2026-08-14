// ════════════════════════════════════════════════════════════════════════════
//  migration-window.test.ts — ITEM P0-E
//
//  THE PREMISE: migrations here are applied BY HAND, so "code deployed, SQL not
//  yet run" is a NORMAL state that lasts hours. Prisma expands `$scalars` FROM
//  THE GENERATED SCHEMA, so a query that names no new column still breaks.
//
//  THE TWO GUARANTEES THIS FILE EXISTS FOR:
//   1. Approval must NEVER capture money and then silently skip staffing
//      because a migration is missing — either both, or an honest failure
//      BEFORE the capture.
//   2. The paid-checkout fulfillment must not CONSUME its idempotency claim
//      when it cannot do the work: a customer who pays during the window must
//      still get their Discord card / email / SMS once the SQL lands.
//
//  HOW IT TESTS THEM (round-3 rules):
//   • the booking row is what the SHIPPED WRITER persists — AdminBookingSchema
//     → resolveMoveSchedule → buildBookingCreateData on the DEFAULT owner path
//     (deposit `stripe_link`, no crew start time). Nothing is hand-shaped.
//   • the SHIPPED store runs against a fake `prisma` installed on `globalThis`
//     before `src/lib/db.ts` is first imported. Only Stripe / notifications /
//     logging are faked.
//   • the fake behaves like Postgres in the window: a select naming a column
//     the database lacks raises P2022, and a relation to a table it lacks
//     raises P2021. Test 1 PINS that the fake really reproduces the outage.
//
//  Offline: no database, no Stripe, no Redis needed for the assertions.
//    npx tsx --test src/lib/__tests__/migration-window.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

// ── The fake database ───────────────────────────────────────────────────────
// Installed on globalThis FIRST: `src/lib/db.ts` does
// `globalForPrisma.prisma ?? new PrismaClient(...)`, so this must be in place
// before ANY module that imports db.ts is loaded. Every app import below is
// therefore dynamic, and nothing above this line imports from '../'.

type Row = Record<string, unknown>

/** Booking RELATION field → the table it reads. A relation to a table the
 *  database does not have yet is a P2021, not a P2022. */
const RELATION_TABLE: Record<string, string> = {
  truck: 'trucks',
  inventoryItems: 'booking_inventory_items',
  customer: 'customers',
  payments: 'payments',
}

type FakeDb = {
  /** Booking COLUMNS the database does not have (Prisma field names). */
  missingColumns: readonly string[]
  /** TABLES the database does not have. */
  missingTables: readonly string[]
  booking: Row
  bookingSelects: Array<Record<string, unknown> | undefined>
  bookingWrites: Row[]
  /** Every prisma operation, in order — the evidence for read-before-claim. */
  ops: string[]
  payments: Row[]
  audits: Row[]
  jobs: Map<string, string>
  requirements: Map<string, Row>
  /** Make the claim UPDATE explode, so a test can stop exactly there. */
  claimSentinel?: Error
  readError?: Error
}

function newDb(booking: Row, opts: { columns?: readonly string[]; tables?: readonly string[] } = {}): FakeDb {
  const row = { ...booking }
  const missingColumns = opts.columns ?? []
  const missingTables = opts.tables ?? []
  // A column the database does not have cannot be ON the row either.
  missingColumns.forEach((col) => delete row[col])
  for (const [field, table] of Object.entries(RELATION_TABLE)) {
    if (missingTables.includes(table)) delete row[field]
  }
  return {
    missingColumns,
    missingTables,
    booking: row,
    bookingSelects: [],
    bookingWrites: [],
    ops: [],
    payments: [],
    audits: [],
    jobs: new Map(),
    requirements: new Map(),
  }
}

let db: FakeDb = newDb({ id: 'bk_none' })

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

function p2022(column: string): Error {
  return Object.assign(
    new Error(`The column \`bookings.${snake(column)}\` does not exist in the current database.`),
    { code: 'P2022' },
  )
}
function p2021(table: string): Error {
  return Object.assign(
    new Error(`The table \`public.${table}\` does not exist in the current database.`),
    { code: 'P2021' },
  )
}

/** Postgres-ish projection. An omitted `select` (or an `include`) is what
 *  Prisma turns into "$scalars from the generated schema" — every column,
 *  including the ones this database has never heard of. */
function project(row: Row, select: Record<string, unknown> | undefined, d: FakeDb): Row {
  if (!select) {
    if (d.missingColumns.length > 0) throw p2022(d.missingColumns[0])
    if (d.missingTables.length > 0) {
      // Only a relation actually attached to the row can break an include.
      const hit = Object.entries(RELATION_TABLE).find(([f, t]) => d.missingTables.includes(t) && f in row)
      if (hit) throw p2021(hit[1])
    }
    return { ...row }
  }
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) {
    if (d.missingColumns.indexOf(key) > -1) throw p2022(key)
    const table = RELATION_TABLE[key]
    if (table && d.missingTables.indexOf(table) > -1) throw p2021(table)
    if (!val) continue
    out[key] = row[key] ?? null
  }
  return out
}

function assertWritable(data: Row, d: FakeDb): void {
  for (const key of Object.keys(data)) if (d.missingColumns.indexOf(key) > -1) throw p2022(key)
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

type ReadArgs = { where?: Row; select?: Record<string, unknown>; include?: Record<string, unknown> }

function readBooking(args: ReadArgs): Row | null {
  db.ops.push('booking.read')
  db.bookingSelects.push(args.select)
  if (db.readError) throw db.readError
  // An `include` is the $scalars case: it must break exactly like no select.
  const projection = args.select ?? undefined
  if (!matchesWhere(db.booking, args.where)) {
    // Still validate the projection — Postgres plans the statement first.
    project(db.booking, projection, db)
    return null
  }
  const row = project(db.booking, projection, db)
  if (!args.select && args.include) {
    for (const key of Object.keys(args.include)) row[key] = db.booking[key] ?? null
  }
  return row
}

const fakePrisma = {
  booking: {
    async findFirst(args: ReadArgs): Promise<Row | null> {
      return readBooking(args)
    },
    async findUnique(args: ReadArgs): Promise<Row | null> {
      return readBooking(args)
    },
    async findMany(args: ReadArgs): Promise<Row[]> {
      const row = readBooking(args)
      return row ? [row] : []
    },
    async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      db.ops.push('booking.updateMany')
      if (db.claimSentinel) throw db.claimSentinel
      assertWritable(args.data, db)
      if (!matchesWhere(db.booking, args.where)) return { count: 0 }
      db.bookingWrites.push({ ...args.data })
      Object.assign(db.booking, args.data)
      return { count: 1 }
    },
    async update(args: { where?: Row; data: Row; select?: Record<string, unknown> }): Promise<Row> {
      db.ops.push('booking.update')
      assertWritable(args.data, db)
      const returned = project(db.booking, args.select, db)
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
    async findUnique(args: { where: { bookingId?: string } }): Promise<Row | null> {
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
      db.ops.push('auditLog.create')
      db.audits.push(args.data)
      return args.data
    },
  },
  jobStaffingRequirement: {
    async findFirst(): Promise<Row | null> {
      db.ops.push('requirement.findFirst')
      if (db.missingTables.includes('job_staffing_requirements')) throw p2021('job_staffing_requirements')
      return null
    },
    async findUnique(args: { where: { jobId: string } }): Promise<Row | null> {
      if (db.missingTables.includes('job_staffing_requirements')) throw p2021('job_staffing_requirements')
      return db.requirements.get(args.where.jobId) ?? null
    },
    async create(args: { data: Row & { jobId: string } }): Promise<Row> {
      if (db.missingTables.includes('job_staffing_requirements')) throw p2021('job_staffing_requirements')
      db.requirements.set(args.data.jobId, { ...args.data })
      return args.data
    },
    async update(args: { where: { jobId: string }; data: Row }): Promise<Row> {
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
  window: typeof import('../migration-window')
  fulfillment: typeof import('../fulfillment')
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  scheduling: typeof import('../scheduling')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    approval: await import('../booking-approval'),
    window: await import('../migration-window'),
    fulfillment: await import('../fulfillment'),
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

// ── The row the SHIPPED WRITER persists ─────────────────────────────────────

const MOVE_DAY = '2027-07-15' // EDT, so the day anchor is 04:00Z

async function createdRow(): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: MOVE_DAY, // no startTime — the DEFAULT day-level booking
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
  const estimatedHours = 6
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
      reference: 'WMIC-1001',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours,
    },
    [],
  )
  assert.equal(data.status, 'PENDING_PAYMENT', 'precondition: the default path creates an unpaid hold')
  return {
    id: 'bk_mw',
    customerToken: 'tok_mw',
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: null,
    truck: null,
    inventoryItems: [],
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...(data as Row),
  }
}

/** The same row AFTER the $49 hold is authorized — what approval starts from. */
async function authorizedRow(): Promise<Row> {
  return {
    ...(await createdRow()),
    status: 'PENDING_APPROVAL',
    depositPaid: false,
    stripePaymentIntentId: 'pi_mw',
  }
}

/** Columns/tables each pending migration adds — the three deploy windows. */
const PHASE1_COLUMNS = ['truckId', 'serviceMode', 'originPropertyType', 'destPropertyType', 'coiRequired', 'priceOverrideReason']
const PHASE1_TABLES = ['trucks', 'booking_inventory_items', 'inventory_catalog_items']
const ROUND23_COLUMNS = ['staffingPlan', 'startTimeKnown']
const ALL_MISSING_COLUMNS = [...PHASE1_COLUMNS, ...ROUND23_COLUMNS]

// ── The shipped approval deps, with only Stripe/notify/log faked ────────────

type Recorder = {
  captures: Array<{ pi: string; key: string }>
  warns: unknown[]
  errors: unknown[]
  infos: unknown[]
}

async function shippedDeps(): Promise<Recorder> {
  const m = await load()
  const rec: Recorder = { captures: [], warns: [], errors: [], infos: [] }
  const deps = m.approval.defaultApprovalDeps() // the REAL prismaApprovalStore
  deps.stripe = {
    async capture(pi, key) {
      rec.captures.push({ pi, key })
      return { id: pi, amount_received: 4900, latest_charge: 'ch_mw', metadata: {} }
    },
    async retrieveCharge() {
      return { id: 'ch_mw', receipt_url: 'https://receipt.example/ch_mw', payment_method_details: { type: 'card' } }
    },
    async releaseHold() {},
  }
  deps.notifier = { async sendApproved() {}, async sendDeclined() {} }
  deps.logger = {
    info: (o) => rec.infos.push(o),
    warn: (o) => rec.warns.push(o),
    error: (o) => rec.errors.push(o),
  }
  return rec
}

async function approve(): Promise<Awaited<ReturnType<typeof import('../booking-approval').approveBooking>>> {
  const m = await load()
  return m.approval.approveBooking({
    bookingId: 'bk_mw',
    actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' },
    source: 'admin',
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  1. The fake really is the outage (without this, nothing below means anything)
// ════════════════════════════════════════════════════════════════════════════

test('P0-E precondition: the fake reproduces BOTH window failures (P2022 column, P2021 table)', async () => {
  const m = await load()
  db = newDb(await authorizedRow(), { columns: ALL_MISSING_COLUMNS, tables: PHASE1_TABLES })

  // What an `include:` does — ask for every generated column.
  await assert.rejects(
    () => fakePrisma.booking.findUnique({ where: { id: 'bk_mw' }, include: { customer: true } }),
    (e: unknown) => (e as { code?: string }).code === 'P2022',
    'an include must break like $scalars, or the fulfillment tests prove nothing',
  )
  // A select naming a Phase 1 column.
  await assert.rejects(
    () => fakePrisma.booking.findUnique({ where: { id: 'bk_mw' }, select: { id: true, truckId: true } }),
    (e: unknown) => m.approval.isMigrationMissing(e),
  )
  // A select naming a relation whose TABLE does not exist.
  await assert.rejects(
    () => fakePrisma.booking.findUnique({ where: { id: 'bk_mw' }, select: { id: true, truck: { select: { source: true } } } }),
    (e: unknown) => (e as { code?: string }).code === 'P2021',
  )
  // And a column that predates everything still reads.
  const ok = await fakePrisma.booking.findUnique({ where: { id: 'bk_mw' }, select: { id: true, requestedDate: true } })
  assert.ok(ok?.requestedDate, 'the base columns must still be readable in the window')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. The shared constants match the MIGRATION SQL — not a comment about it
// ════════════════════════════════════════════════════════════════════════════

const MIGRATIONS_DIR = join(ROOT, 'prisma', 'migrations')

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

test('P0-E: PENDING_MIGRATIONS really are the newest migrations on disk', async () => {
  const m = await load()
  const dirs = migrationDirs()
  const newest = dirs.slice(-m.window.PENDING_MIGRATIONS.length)
  assert.deepEqual(
    newest,
    [...m.window.PENDING_MIGRATIONS],
    'a NEWER migration exists that nobody classified. Add it to PENDING_MIGRATIONS (and its columns to ' +
      'MIGRATION_BOOKING_COLUMNS) in src/lib/migration-window.ts, or the degraded reads will ask for a column ' +
      'the database does not have yet — which is the whole defect P0-E exists to close.',
  )
})

test('P0-E: MIGRATION_BOOKING_COLUMNS is exactly what those migrations ADD to bookings', async () => {
  const m = await load()
  const sql = m.window.PENDING_MIGRATIONS.map((d) => readFileSync(join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8')).join('\n')
  const added = new Set<string>()
  const re = /ALTER TABLE\s+"bookings"\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"([a-z0-9_]+)"/gi
  let hit: RegExpExecArray | null
  while ((hit = re.exec(sql)) !== null) added.add(hit[1])
  assert.ok(added.size > 0, 'the migration SQL must actually add booking columns (parser check)')

  const declared = new Set(Array.from(m.window.MIGRATION_BOOKING_COLUMNS).map((c) => snake(c)))
  assert.deepEqual(
    Array.from(declared).sort(),
    Array.from(added).sort(),
    'MIGRATION_BOOKING_COLUMNS has drifted from the migration SQL. A column listed here but not added by the ' +
      'SQL is dropped from every degraded read for no reason; a column added by the SQL but missing here is ' +
      'asked for during the window and re-breaks the read.',
  )
})

test('P0-E: MIGRATION_TABLES is exactly what those migrations CREATE', async () => {
  const m = await load()
  const sql = m.window.PENDING_MIGRATIONS.map((d) => readFileSync(join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8')).join('\n')
  const created = new Set<string>()
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"([a-z0-9_]+)"/gi
  let hit: RegExpExecArray | null
  while ((hit = re.exec(sql)) !== null) created.add(hit[1])
  assert.deepEqual(Array.from(m.window.MIGRATION_TABLES).sort(), Array.from(created).sort())
})

test('P0-E: bookingScalarSelect names the surviving columns and NONE of the pending ones', async () => {
  const m = await load()
  const select = m.window.bookingScalarSelect()
  for (const col of m.window.MIGRATION_BOOKING_COLUMNS) {
    assert.equal(select[col], undefined, `${col} is added by a pending migration — a degraded read must not ask for it`)
  }
  // Columns every consumer of a degraded row still needs.
  for (const col of ['id', 'status', 'requestedDate', 'confirmedDate', 'scheduledStart', 'depositPaid', 'customerToken', 'displayId', 'totalEstimate']) {
    assert.equal(select[col], true, `${col} predates the pending migrations and must survive the degrade`)
  }
  assert.ok(Object.keys(select).length > 50, 'the derived select must be the real column set, not a stub')
})

test('P0-E: only a MIGRATION-shaped error degrades — an outage never does', async () => {
  const m = await load()
  assert.equal(m.window.isMigrationMissing(Object.assign(new Error('x'), { code: 'P2022' })), true)
  assert.equal(m.window.isMigrationMissing(Object.assign(new Error('x'), { code: 'P2021' })), true)
  assert.equal(m.window.isMigrationMissing(new Error('relation "trucks" does not exist')), true)
  assert.equal(m.window.isMigrationMissing(new Error('connection terminated unexpectedly')), false)
  assert.equal(m.window.isMigrationMissing(new Error('canceling statement due to statement timeout')), false)
  // The one detector, shared: booking-approval re-exports it rather than keeping
  // a second copy that can drift.
  assert.equal(m.approval.isMigrationMissing, m.window.isMigrationMissing)
})

// ════════════════════════════════════════════════════════════════════════════
//  3. FULFILLMENT — the claim must not be consumed by work that cannot run
// ════════════════════════════════════════════════════════════════════════════

// SCOPE NOTE, so these assertions are not read as more than they are: the
// fan-out itself (BullMQ enqueues) needs Redis and is NOT exercised offline.
// Every test below stops at the atomic CLAIM — which is precisely the line the
// defect was about. A `claimSentinel` makes the claim throw, so "the claim was
// reached" and "the claim was never reached" are both observable, and no test
// opens a Redis connection.

async function fulfill(): Promise<{ processed: boolean; reason?: string }> {
  const m = await load()
  return m.fulfillment.fulfillPaidCheckout({
    bookingId: 'bk_mw',
    paymentIntentId: 'pi_mw',
    amountTotalCents: 4900,
    source: 'webhook',
  })
}

test('P0-E: during the normal migration window a paid checkout STILL fulfills (degraded, not deferred)', async () => {
  db = newDb(await createdRow(), { columns: ALL_MISSING_COLUMNS, tables: PHASE1_TABLES })
  assert.equal(db.booking.status, 'PENDING_PAYMENT', 'precondition: $49 authorized, nothing fulfilled yet')
  db.claimSentinel = Object.assign(new Error('CLAIM REACHED'), { code: 'TEST_SENTINEL' })

  await assert.rejects(
    () => fulfill(),
    /CLAIM REACHED/,
    'the include fails on $scalars, the fallback reads every column that exists, and the fan-out proceeds — ' +
      'the customer is contacted during the window instead of after it',
  )
  // Read, read (the degraded retry), THEN claim. The order is the fix: the
  // claim used to be FIRST, so a read that died left the booking already
  // PENDING_APPROVAL — and since the claim IS the idempotency guard, every
  // retry short-circuited to "already fulfilled" and the customer was never
  // contacted again. Ever.
  assert.deepEqual(db.ops, ['booking.read', 'booking.read', 'booking.updateMany'])
  assert.equal(db.bookingSelects[0], undefined, 'rung 1 is the natural include (no select)')
  assert.ok(db.bookingSelects[1], 'rung 2 names its columns')
  assert.equal((db.bookingSelects[1] as Row).startTimeKnown, undefined, 'and does not ask for a pending column')
  assert.equal((db.bookingSelects[1] as Row).requestedDate, true, 'while still asking for what the fan-out reads')
})

test('P0-E: when the row CANNOT be read at all, the claim is not consumed', async () => {
  const m = await load()
  // A deeper gap than the three known migrations — e.g. a fourth migration
  // landed and nobody updated MIGRATION_BOOKING_COLUMNS (the drift the
  // constants test above guards). Both rungs fail. This is the case where the
  // old code destroyed the event: it had already claimed the booking.
  db = newDb(await createdRow(), { columns: [...ALL_MISSING_COLUMNS, 'arrivalWindow'] })
  db.claimSentinel = Object.assign(new Error('CLAIM REACHED'), { code: 'TEST_SENTINEL' })

  const res = await fulfill()

  assert.equal(res.processed, false)
  assert.equal(
    res.reason,
    m.fulfillment.MIGRATION_NOT_APPLIED,
    'the caller must be able to tell "nothing to do" from "cannot do it YET" — src/lib/stripe-events.ts ' +
      'refuses to record the webhook as processed on this reason, so the retry survives',
  )
  assert.equal(db.booking.status, 'PENDING_PAYMENT', 'the claim must NOT have been consumed')
  assert.equal(db.bookingWrites.length, 0, 'nothing written to the booking')
  assert.equal(db.audits.length, 0, 'no PAYMENT_RECEIVED audit — nothing happened, so nothing is recorded')
  assert.ok(!db.ops.includes('booking.updateMany'), 'the claim UPDATE must never even be attempted')
})

test('P0-E: a healthy database reads once, then claims', async () => {
  db = newDb(await createdRow())
  db.claimSentinel = Object.assign(new Error('CLAIM REACHED'), { code: 'TEST_SENTINEL' })

  await assert.rejects(() => fulfill(), /CLAIM REACHED/)
  assert.deepEqual(db.ops, ['booking.read', 'booking.updateMany'], 'no degraded retry when nothing is missing')
})

test('P0-E: a real outage throws BEFORE the claim (retryable, nothing consumed)', async () => {
  db = newDb(await createdRow())
  db.readError = new Error('connection terminated unexpectedly')

  await assert.rejects(() => fulfill(), /connection terminated/)
  assert.equal(db.booking.status, 'PENDING_PAYMENT')
  assert.ok(!db.ops.includes('booking.updateMany'), 'an outage must not consume the claim either')
})

test('P0-E: a booking that does not exist is reported, not claimed', async () => {
  db = newDb(await createdRow())
  db.booking.id = 'someone_else'

  const res = await fulfill()
  assert.equal(res.processed, false)
  assert.equal(res.reason, 'booking-not-found')
  assert.ok(!db.ops.includes('booking.updateMany'))
})

// ════════════════════════════════════════════════════════════════════════════
//  4. APPROVAL — either the money AND the crew plan, or an honest refusal
// ════════════════════════════════════════════════════════════════════════════

test('P0-E: with ALL three migrations pending, approval still captures AND staffs', async () => {
  // This is the window the round-2/3 ladder did NOT cover: its "safe" rung
  // named truckId / serviceMode / truck / inventoryItems, all created by
  // 20260811000000_moving_os_phase1. BOTH rungs raised P2022/P2021, the throw
  // escaped ensureStaffingForBooking, and repairStaffing swallowed it — AFTER
  // the $49 was captured. Money taken, job unstaffed, nothing said.
  db = newDb(await authorizedRow(), { columns: ALL_MISSING_COLUMNS, tables: PHASE1_TABLES })
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `approval must not fail in the window: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'captured')
  assert.equal(rec.captures.length, 1, 'the deposit is captured exactly once')
  assert.equal(db.booking.status, 'CONFIRMED')
  assert.equal(db.jobs.size, 1, 'the Job must exist')

  // BOTH halves of the owner's rule — this is the assertion that fails if the
  // third rung is removed.
  assert.equal(
    db.requirements.size,
    1,
    'the captured job MUST have a staffing requirement — capturing $49 and silently skipping the crew plan ' +
      'is the exact outcome P0-E forbids',
  )
  const req = db.requirements.get('job_1')!
  assert.ok((req.requiredWorkers as number) >= 2, 'the derived plan still staffs real people')
  // Honest about WHY it is derived rather than the owner's captured plan.
  assert.ok(
    rec.infos.some((i) => (i as { planSource?: string }).planSource === 'derived'),
    'the plan could not be read, so it must be reported as DERIVED — never claimed as the owner\'s',
  )
  assert.ok(
    rec.infos.some((i) => /moving_os_phase1/.test(String((i as { reason?: string }).reason ?? ''))),
    'the degrade reason must name the migration that caused it',
  )
})

test('P0-E: when the crew requirement CANNOT be written, approval refuses BEFORE the capture', async () => {
  // The residual case the ladder cannot rescue: the requirement table itself is
  // unreadable. The old code captured first and discovered this afterwards, in
  // a fail-soft catch whose log line said "non-fatal — booking IS confirmed and
  // captured". Now the probe runs first.
  db = newDb(await authorizedRow(), { tables: ['job_staffing_requirements'] })
  const rec = await shippedDeps()

  const res = await approve()

  assert.equal(res.ok, false, 'approving would have captured money for a job nothing can staff')
  assert.equal(!res.ok && res.code, 'migration_missing')
  assert.match(!res.ok ? res.message : '', /NOTHING was captured/i, 'the owner is told plainly that no money moved')
  assert.match(!res.ok ? res.message : '', /apply the migration/i, 'and what to do about it')

  assert.equal(rec.captures.length, 0, 'NO capture')
  assert.equal(db.booking.status, 'PENDING_APPROVAL', 'no claim: the booking is still approvable afterwards')
  assert.equal(db.payments.length, 0, 'no Payment row')
  assert.equal(db.requirements.size, 0)
})

test('P0-E: a healthy database is unaffected — capture, confirm, staff, no warnings', async () => {
  db = newDb(await authorizedRow())
  const rec = await shippedDeps()

  const res = await approve()
  assert.ok(res.ok && res.outcome === 'captured')
  assert.equal(rec.captures.length, 1)
  assert.equal(db.requirements.size, 1)
  assert.equal(db.booking.status, 'CONFIRMED')
  assert.equal(rec.warns.length, 0, 'a healthy database must not log a degraded read')
  assert.ok(
    rec.infos.every((i) => (i as { degraded?: boolean }).degraded !== true),
    'nothing may be reported as degraded when nothing degraded',
  )
  // The readiness probe is real: it touched the requirement table before the
  // capture, not after.
  const probeAt = db.ops.indexOf('requirement.findFirst')
  assert.ok(probeAt > -1, 'the pre-capture readiness probe must actually run')
})

test('P0-E: a flaky probe does NOT block an approval (only a migration does)', async () => {
  const m = await load()
  // checkStaffingReadiness is the pure decision: a real outage is inconclusive,
  // never a refusal — the owner is on the phone, and commitApproval's
  // transaction surfaces a genuine outage loudly anyway.
  const outage = await m.approval.checkStaffingReadiness({
    readBooking: async () => {
      throw new Error('connection terminated unexpectedly')
    },
    probeRequirements: async () => {},
  })
  assert.equal(outage.ready, true)

  const missing = await m.approval.checkStaffingReadiness({
    readBooking: async () => ({ id: 'bk_mw' }),
    probeRequirements: async () => {
      throw Object.assign(new Error('table does not exist'), { code: 'P2021' })
    },
  })
  assert.equal(missing.ready, false)
  assert.match(String(missing.reason), /crew-requirement table/)
})

test('P0-E: the staffing ladder degrades one rung at a time, and only for migrations', async () => {
  const m = await load()
  const seen: Array<Record<string, unknown>> = []
  const readFailing = (missing: readonly string[]) => async (select: Record<string, unknown>) => {
    seen.push(select)
    for (const key of Object.keys(select)) {
      if (missing.includes(key)) throw Object.assign(new Error(`column ${key} does not exist`), { code: 'P2022' })
    }
    return { id: 'bk_mw', bedrooms: 2 }
  }

  // Rung 1 works on a healthy database — exactly one call.
  seen.length = 0
  const healthy = await m.approval.loadStaffingBookingRow(readFailing([]))
  assert.equal(seen.length, 1)
  assert.equal(healthy.degraded, false)

  // Round-2/3 window: rung 2.
  seen.length = 0
  const round23 = await m.approval.loadStaffingBookingRow(readFailing(ROUND23_COLUMNS))
  assert.equal(seen.length, 2)
  assert.equal(round23.degraded, true)
  assert.match(String(round23.reason), /staffingPlan/)

  // Phase 1 pending too: rung 3, and it must SUCCEED (this is the round-4 fix).
  seen.length = 0
  const phase1 = await m.approval.loadStaffingBookingRow(readFailing([...ROUND23_COLUMNS, ...PHASE1_COLUMNS, 'truck', 'inventoryItems']))
  assert.equal(seen.length, 3)
  assert.equal(phase1.degraded, true)
  assert.ok(phase1.booking, 'the base rung must still return the row')
  assert.match(String(phase1.reason), /moving_os_phase1/)

  // The base rung names ONLY columns that predate the whole Moving OS set.
  const base = Object.keys(m.approval.STAFFING_BOOKING_SELECT_BASE)
  for (const col of [...PHASE1_COLUMNS, ...ROUND23_COLUMNS, 'truck', 'inventoryItems']) {
    assert.ok(!base.includes(col), `${col} comes from a pending migration and must not be on the base rung`)
  }

  // And a real outage on ANY rung propagates.
  await assert.rejects(
    () => m.approval.loadStaffingBookingRow(async () => { throw new Error('connection terminated unexpectedly') }),
    /connection terminated/,
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  5. Source guard — no unguarded full-row booking read on a critical path
// ════════════════════════════════════════════════════════════════════════════

/** Comments stripped, so a regression cannot hide behind prose that mentions
 *  the right words (and prose about the fix cannot fake a pass). */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CRITICAL_READ_FILES = [
  'src/lib/fulfillment.ts',
  'src/lib/booking-approval.ts',
  'app/api/admin/bookings/[id]/status/route.ts',
  'app/api/admin/bookings/route.ts',
  // H1: the PUBLIC create — every customer booking — was never on this list.
  'app/api/bookings/route.ts',
  'app/my-booking/[token]/page.tsx',
  'app/(admin)/admin/(dashboard)/jobs/page.tsx',
  'src/outbox/services/premiumEmails.tsx',
]

test('P0-E: the comment stripper actually works (the round-3 lesson)', () => {
  const src = code('src/lib/fulfillment.ts')
  assert.ok(
    !/READ FIRST, CLAIM SECOND/.test(src),
    'a known COMMENT sentence survived the stripper — every negative guard below would then be satisfiable ' +
      'by prose alone, which is exactly how round 3 shipped a broken guard',
  )
  assert.ok(/fulfillPaidCheckout/.test(src), 'and real code must survive it')
})

test('P0-E: every booking read on a critical path names its columns or has a fallback', () => {
  for (const file of CRITICAL_READ_FILES) {
    const src = code(file)
    // Only operations that RETURN columns can be broken by a column the
    // database does not have; `updateMany`/`count` cannot.
    const pattern = /prisma\.booking\.(?:findFirst|findUnique|findMany|update|upsert)\(/g
    let found = 0
    let call: RegExpExecArray | null
    while ((call = pattern.exec(src)) !== null) {
      found++
      // The guard must accept BOTH shapes the repo uses: an explicit `select`
      // (after the call) and a read handed to the fallback helper / wrapped in
      // an isMigrationMissing catch (which reads BEFORE the call). Hence a
      // window on both sides.
      const window = src.slice(Math.max(0, call.index - 260), call.index + 320)
      assert.ok(
        /\bselect\b/.test(window) || /isMigrationMissing/.test(window) || /MigrationFallback/.test(window),
        `${file}: ${call[0]} asks Postgres for every generated column with no degraded fallback — this is the ` +
          'statement class that 500\'d the customer portal, the Jobs page and the admin list, and that made a ' +
          'paid checkout a permanent no-op',
      )
    }
    assert.ok(found > 0, `${file} must still contain the reads under test`)
  }
})

test('P0-E: no critical path is back on include-everything', () => {
  for (const file of CRITICAL_READ_FILES) {
    const src = code(file)
    // `include: { customer: true }` as a DIRECT argument to a booking read is
    // the shape that expands to $scalars. Declaring it as a named constant that
    // is fed to the fallback helper is fine — that is the fix.
    const bad = /prisma\.booking\.(?:findFirst|findUnique|findMany)\(\{[^}]*include:\s*\{/.test(src)
    assert.ok(!bad, `${file}: an inline include-everything booking read is back`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  6. THE CREATE PREFLIGHT (H1) — the guard, and the ORDER that makes it one
//
//  WHAT WAS WRONG. The admin create's preflight had NO test: the verifier
//  deleted the entire block (leaving `nextBookingReference()` first) and the
//  whole gate stayed green — 17 files, 337 tests, 0 fail. And the guarantee it
//  claims ("booking create fails BEFORE writing anything when a required
//  migration column is absent") was simply FALSE on the public path, which is
//  every customer booking: `prisma.customer.upsert` → `nextBookingReference()`
//  (a `SELECT nextval`, which Postgres never rolls back) → `booking.create`.
//  In the window that wrote a CRM row and burned a WMIC-#### number before it
//  discovered the missing column.
//
//  WHAT THESE TESTS PIN, in two halves:
//   A. BEHAVIOUR — `checkBookingCreateReady` against the fake database above:
//      it refuses on a migration, rethrows a real outage, and reads only.
//   B. ORDER — the half a behaviour test cannot reach without importing a Next
//      route (which would drag Stripe/Redis/Discord into an offline gate). The
//      guard reads the two route sources with comments STRIPPED and fails if
//      the preflight is deleted, moved after the reference, or moved after any
//      prisma write. Scope, stated plainly: this proves the call is present and
//      first, not that Next returns 503 — that is the residual recorded in
//      docs/moving-os-p0-review.md § E.
// ════════════════════════════════════════════════════════════════════════════

/** A probe that reads through the fake client, like the routes read through
 *  the real one. */
const probeBooking = (select: Record<string, true>): Promise<unknown> =>
  fakePrisma.booking.findFirst({ select })

test('H1: the probe select is DERIVED — exactly `id` + every pending column', async () => {
  const m = await load()
  const select = m.window.bookingCreateProbeSelect()
  assert.deepEqual(
    Object.keys(select).sort(),
    ['id', ...m.window.MIGRATION_BOOKING_COLUMNS].sort(),
    'the probe must name exactly the at-risk columns: a column it forgets is one the create discovers ' +
      'the hard way, and a column that has always existed makes the probe prove nothing',
  )
  assert.ok(Object.values(select).every((v) => v === true))
})

test('H1: in the migration window the preflight REFUSES — and it only ever read', async () => {
  const m = await load()
  db = newDb(await createdRow(), { columns: ALL_MISSING_COLUMNS, tables: PHASE1_TABLES })

  const res = await m.window.checkBookingCreateReady({ booking: probeBooking })

  assert.equal(res.ready, false)
  assert.equal(res.ready === false && res.reason, m.window.MIGRATION_MISSING_MESSAGE)
  assert.deepEqual(db.ops, ['booking.read'], 'a preflight is a READ — it must consume nothing')
  assert.equal(db.bookingWrites.length, 0, 'nothing written')
  assert.equal(db.audits.length, 0, 'nothing audited — nothing happened')
})

test('H1: a healthy database is ready (the create proceeds normally)', async () => {
  const m = await load()
  db = newDb(await createdRow())

  const res = await m.window.checkBookingCreateReady({ booking: probeBooking })

  assert.equal(res.ready, true)
  assert.deepEqual(db.ops, ['booking.read'], 'exactly one extra read on the happy path')
})

test('H1: a real outage is RETHROWN, never reported as a missing migration', async () => {
  const m = await load()
  db = newDb(await createdRow())
  db.readError = new Error('connection terminated unexpectedly')

  await assert.rejects(
    () => m.window.checkBookingCreateReady({ booking: probeBooking }),
    /connection terminated/,
    'a transient blip answered with "apply the migrations" sends the owner to run SQL that is already ' +
      'applied — and a caller that treats every failure as not-ready stops taking bookings for good',
  )
})

test('H1: the optional probes run only for the tables that create would write', async () => {
  const m = await load()
  db = newDb(await createdRow())
  let inventory = 0
  let staffing = 0

  // A create with no inventory and no CONFIRMED job passes null for both — it
  // must not be refused for a table it never touches.
  const skipped = await m.window.checkBookingCreateReady({
    booking: probeBooking,
    inventoryItems: null,
    staffingRequirement: null,
  })
  assert.equal(skipped.ready, true)
  assert.equal(inventory + staffing, 0)

  // A create that DOES write inventory is refused when that table is missing,
  // and stops at the first migration-shaped failure.
  const refused = await m.window.checkBookingCreateReady({
    booking: probeBooking,
    inventoryItems: async () => {
      inventory++
      throw Object.assign(new Error('The table `public.booking_inventory_items` does not exist in the current database.'), {
        code: 'P2021',
      })
    },
    staffingRequirement: async () => {
      staffing++
    },
  })
  assert.equal(refused.ready, false)
  assert.equal(inventory, 1)
  assert.equal(staffing, 0, 'the preflight stops at the first refusal')
})

// ── B. The ORDER, read off the two route sources ────────────────────────────

const CREATE_ROUTES = [
  { file: 'app/api/admin/bookings/route.ts', who: 'the ADMIN create (Book Move)' },
  { file: 'app/api/bookings/route.ts', who: 'the PUBLIC create (every customer booking)' },
]

/** Every prisma/tx statement that WRITES, with its offset. `$transaction` counts:
 *  a preflight moved inside or after it is no longer a preflight. */
function writeCalls(src: string): Array<{ text: string; index: number }> {
  const re = /\b(?:prisma|tx)\.(?:\$transaction|[A-Za-z]\w*\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany))\s*\(/g
  return Array.from(src.matchAll(re), (m) => ({ text: m[0], index: m.index ?? -1 }))
}

test('H1 (guard the guard): the write scanner really sees the writes it orders', () => {
  const admin = writeCalls(code('app/api/admin/bookings/route.ts')).map((w) => w.text)
  assert.ok(admin.some((t) => t.includes('$transaction')), 'the admin create transaction must be seen')
  assert.ok(admin.some((t) => t.includes('booking.create')), 'the admin booking write must be seen')
  const pub = writeCalls(code('app/api/bookings/route.ts')).map((w) => w.text)
  assert.ok(pub.some((t) => t.includes('customer.upsert')), 'the public customer upsert must be seen')
  assert.ok(pub.some((t) => t.includes('booking.create')), 'the public booking write must be seen')
})

test('H1: BOTH creates preflight BEFORE the reference and BEFORE every write', () => {
  for (const { file, who } of CREATE_ROUTES) {
    const src = code(file)

    const preflightAt = src.indexOf('checkBookingCreateReady(')
    assert.ok(
      preflightAt > -1,
      `${file}: ${who} no longer calls checkBookingCreateReady(). Deleting this block is the mutation that ` +
        'left the entire gate green while the guarantee was gone.',
    )

    const referenceAt = src.indexOf('nextBookingReference(')
    assert.ok(referenceAt > -1, `${file}: ${who} must still draw a public reference (guard precondition)`)
    assert.ok(
      preflightAt < referenceAt,
      `${file}: the preflight runs AFTER nextBookingReference(). That call is a SELECT nextval(...), which ` +
        'Postgres does not roll back, so every refused create in the migration window permanently burns a ' +
        'WMIC-#### number.',
    )

    const writes = writeCalls(src)
    assert.ok(writes.length > 0, `${file}: no prisma writes found — the scanner drifted, so this proves nothing`)
    const beforeProbe = writes.filter((w) => w.index < preflightAt).map((w) => w.text)
    assert.deepEqual(
      beforeProbe,
      [],
      `${file}: ${who} writes ${beforeProbe.join(', ')} BEFORE the preflight. The whole point of the probe is ` +
        'that a refusal leaves nothing behind.',
    )
  }
})

test('H1: a not-ready preflight actually REFUSES — never computed and ignored', () => {
  for (const { file, who } of CREATE_ROUTES) {
    const src = code(file)
    const at = src.indexOf('checkBookingCreateReady(')
    assert.ok(at > -1, `${file}: the preflight call is gone`)
    const window = src.slice(at, at + 900)
    assert.match(
      window,
      /if\s*\(\s*!\s*\w+\.ready\s*\)/,
      `${file}: ${who} does not branch on the preflight result — a probe whose answer is discarded is decoration`,
    )
    assert.match(window, /return NextResponse\.json\(/, `${file}: the refusal must be returned to the caller`)
    assert.match(window, /status:\s*503/, `${file}: an unapplied migration is a 503 (retryable), never a 500 or a 200`)
  }
})

test('H1: the owner is told WHICH migration; the customer is told nothing about the schema', async () => {
  const m = await load()

  // Owner surface: the actionable sentence, migration names included.
  assert.match(
    code('app/api/admin/bookings/route.ts'),
    /MIGRATION_MISSING_MESSAGE/,
    'the owner refusal must name the migrations — the fix is the next thing they read',
  )

  // Customer surface: the honest one, and NOT the owner one.
  const pub = code('app/api/bookings/route.ts')
  assert.match(pub, /MIGRATION_CUSTOMER_MESSAGE/, 'the public route must answer with the customer sentence')
  assert.ok(
    !/MIGRATION_MISSING_MESSAGE/.test(pub),
    'the public route must never hand a customer the migration names — that is the owner\'s sentence, and ' +
      'spelling the schema out to the open internet is a leak',
  )

  const msg = m.window.MIGRATION_CUSTOMER_MESSAGE
  for (const migration of m.window.PENDING_MIGRATIONS) {
    assert.ok(!msg.includes(migration), `the customer sentence names migration ${migration}`)
  }
  for (const column of m.window.MIGRATION_BOOKING_COLUMNS) {
    assert.ok(!msg.includes(column), `the customer sentence names column ${column}`)
  }
  assert.ok(
    !/migration|column|table|schema|prisma|postgres|sql|database/i.test(msg),
    `the customer sentence leaks internals: "${msg}"`,
  )
  // And it still says the two things that make a retry safe.
  assert.match(msg, /nothing was submitted/i, 'a customer must be told their booking did not go through')
  assert.match(msg, /not been charged/i, 'and that no money moved')
})

test('H1: the PUBLIC create burns no reference and writes no Customer before the probe', () => {
  const src = code('app/api/bookings/route.ts')
  const at = src.indexOf('checkBookingCreateReady(')
  assert.ok(at > -1, 'the public create must run the preflight')
  // Named, so this still fails loudly if the generic scanner above ever drifts.
  for (const marker of ['prisma.customer.upsert(', 'nextBookingReference(', 'prisma.booking.create(']) {
    const idx = src.indexOf(marker)
    assert.ok(idx > -1, `${marker} vanished from the public create — re-point this guard`)
    assert.ok(
      at < idx,
      `app/api/bookings/route.ts: ${marker} runs before the preflight. In the migration window that is a real ` +
        'CRM row / a permanently burned WMIC-#### number for a booking that then fails.',
    )
  }
})
