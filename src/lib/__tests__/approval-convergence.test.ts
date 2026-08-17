// ════════════════════════════════════════════════════════════════════════════
//  approval-convergence.test.ts — RELEASE BLOCKER B1
//
//  THE DEFECT: `approveBooking` claims CONFIRMED + depositPaid BEFORE it
//  captures, and records the money AFTER. `commitApproval` was the one
//  unprotected throw between "Stripe took the $49" and "anybody was told". One
//  failed Postgres transaction (Neon autosuspend, a dropped connection, a
//  serverless timeout) left:
//      $49 captured at Stripe · booking CONFIRMED · NO Payment / Job / audit row
//      · NO customer confirmation, ever · and `bookingPricing` then billed the
//      same $49 again because it derives the balance from COMPLETED Payments.
//  The only repair an owner has — clicking Approve again — returned
//  `already_confirmed` WITHOUT looking at the money, so it repaired nothing and
//  reported success. Verification proved the replay entirely inert.
//
//  WHY THIS FILE DRIVES THE SHIPPED PATH (the discipline that was missing
//  before): every earlier harness implemented `commitApproval` as a function
//  that always succeeds, so no test in the repo could ever reach this state.
//    • the booking row is what the SHIPPED WRITER persists — `resolveMoveSchedule`
//      → `buildBookingCreateData` on the DEFAULT owner path (deposit
//      `stripe_link`), then the $49-authorized shape. Nothing is hand-invented.
//    • `defaultApprovalDeps()` — the REAL `prismaApprovalStore` — runs against a
//      fake `prisma` installed on `globalThis` before `src/lib/db.ts` is first
//      imported. Only Stripe, the notifier, the logger and the alerter are
//      faked, so `findPaymentForIntent`, `countApprovalAudits` and the
//      Payment/Job/audit transaction under test are the production ones.
//    • the fake `$transaction` is ALL-OR-NOTHING like Postgres: the operations
//      are lazy thenables, so a transaction that fails writes NOTHING. Test 1
//      pins that, because without it every assertion below is theatre.
//
//  Offline: no database, no Stripe, no Redis, no network. Run:
//    npx tsx --test src/lib/__tests__/approval-convergence.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

type Row = Record<string, unknown>

// ── The fake database ───────────────────────────────────────────────────────
// Installed on globalThis FIRST: `src/lib/db.ts` does
// `globalForPrisma.prisma ?? new PrismaClient(...)`, so this must be in place
// before ANY module that imports db.ts loads. Hence every app import below is
// dynamic, and nothing above this line imports from '../'.

/** A Prisma-like LAZY promise. Real `PrismaPromise`s do not touch the database
 *  until they are awaited, which is what makes `$transaction([...])` atomic: a
 *  transaction that fails before awaiting them writes nothing. A fake built out
 *  of eager `async` methods would silently write all three rows and then
 *  "fail" — the exact opposite of the state under test. */
function lazy<T>(run: () => T): Promise<T> {
  let p: Promise<T> | null = null
  const start = (): Promise<T> => (p ??= (async () => run())())
  return {
    then: (a: unknown, b: unknown) => start().then(a as never, b as never),
    catch: (b: unknown) => start().catch(b as never),
    finally: (f: () => void) => start().finally(f),
  } as unknown as Promise<T>
}

type FakeDb = {
  booking: Row
  payments: Row[]
  audits: Row[]
  jobs: Map<string, string>
  requirements: Map<string, Row>
  /** How many more `$transaction([...])` array calls must fail. */
  commitFailures: number
  /** The error a failing commit raises. */
  commitError: () => Error
  /** Flip the booking to CONFIRMED after the FIRST booking read, to reproduce
   *  the lost-claim replay branch (a second owner won the claim mid-approval). */
  confirmAfterFirstRead: boolean
  reads: number
  transactionAttempts: number
}

function newDb(booking: Row): FakeDb {
  return {
    booking: { ...booking },
    payments: [],
    audits: [],
    jobs: new Map(),
    requirements: new Map(),
    commitFailures: 0,
    commitError: () => Object.assign(new Error("Can't reach database server at `ep-neon.aws.neon.tech`:`5432`"), { code: 'P1001' }),
    confirmAfterFirstRead: false,
    reads: 0,
    transactionAttempts: 0,
  }
}

let db: FakeDb = newDb({ id: 'bk_none' })

function project(row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row }
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) {
    if (!val) continue
    out[key] = row[key] ?? null
  }
  return out
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  const or = where.OR as Row[] | undefined
  if (or) return or.some((clause) => matchesWhere(row, clause))
  for (const [key, val] of Object.entries(where)) {
    if (key === 'OR') continue
    // ITEM T1 — `countApprovalAudits` carries TWO JSON-path conditions (the
    // event AND the payment intent), which Prisma expresses as an AND array
    // because one object cannot repeat the `details` key. A fake that ignored
    // the AND would answer a question production never asks.
    if (key === 'AND') {
      if (!(val as Row[]).every((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (val && typeof val === 'object' && 'in' in (val as Row)) {
      if (!((val as { in: unknown[] }).in ?? []).includes(row[key])) return false
      continue
    }
    // ITEM R1 — Prisma's JSON path filter, which `countApprovalAudits` now uses
    // to count ONLY this module's own PAYMENT_RECEIVED row. A fake that ignored
    // the filter would answer a question production never asks.
    if (val && typeof val === 'object' && 'path' in (val as Row) && 'equals' in (val as Row)) {
      const spec = val as { path: string[]; equals: unknown }
      let cursor: unknown = row[key]
      for (const segment of spec.path) {
        cursor = cursor && typeof cursor === 'object' ? (cursor as Row)[segment] : undefined
      }
      if (cursor !== spec.equals) return false
      continue
    }
    if (row[key] !== val) return false
  }
  return true
}

function afterRead(): void {
  db.reads++
  if (db.confirmAfterFirstRead && db.reads === 1) {
    db.booking.status = 'CONFIRMED'
    db.booking.depositPaid = true
  }
}

const fakePrisma = {
  booking: {
    async findFirst(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      const hit = matchesWhere(db.booking, args.where) ? project(db.booking, args.select) : null
      afterRead()
      return hit
    },
    async findUnique(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      const hit = matchesWhere(db.booking, args.where) ? project(db.booking, args.select) : null
      afterRead()
      return hit
    },
    async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      if (!matchesWhere(db.booking, args.where)) return { count: 0 }
      Object.assign(db.booking, args.data)
      return { count: 1 }
    },
  },
  payment: {
    async findUnique(args: { where: { stripePaymentIntentId?: string }; select?: Record<string, unknown> }): Promise<Row | null> {
      const row = db.payments.find((p) => p.stripePaymentIntentId === args.where.stripePaymentIntentId)
      return row ? project(row, args.select) : null
    },
    upsert(args: { where: { stripePaymentIntentId: string }; update: Row; create: Row }): Promise<Row> {
      return lazy(() => {
        const existing = db.payments.find((p) => p.stripePaymentIntentId === args.where.stripePaymentIntentId)
        if (existing) {
          Object.assign(existing, args.update)
          return existing
        }
        const created = { ...args.create }
        db.payments.push(created)
        return created
      })
    },
  },
  job: {
    async findUnique(args: { where: { bookingId?: string } }): Promise<Row | null> {
      const id = args.where.bookingId ? db.jobs.get(args.where.bookingId) : null
      return id ? { id } : null
    },
    upsert(args: { where: { bookingId: string }; create: Row }): Promise<Row> {
      return lazy(() => {
        const existing = db.jobs.get(args.where.bookingId)
        if (existing) return { id: existing }
        const id = `job_${db.jobs.size + 1}`
        db.jobs.set(args.where.bookingId, id)
        return { id, ...args.create }
      })
    },
  },
  auditLog: {
    create(args: { data: Row }): Promise<Row> {
      return lazy(() => {
        db.audits.push(args.data)
        return args.data
      })
    },
    async count(args: { where?: Row }): Promise<number> {
      return db.audits.filter((a) => matchesWhere(a, args?.where)).length
    },
  },
  jobStaffingRequirement: {
    async findUnique(args: { where: { jobId: string } }): Promise<Row | null> {
      return db.requirements.get(args.where.jobId) ?? null
    },
    async findFirst(): Promise<Row | null> {
      return null
    },
    async create(args: { data: Row & { jobId: string } }): Promise<Row> {
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
    if (Array.isArray(arg)) {
      db.transactionAttempts++
      // Postgres is all-or-nothing: fail BEFORE awaiting the lazy operations,
      // so a failed commit leaves no Payment, no Job and no AuditLog behind.
      if (db.commitFailures > 0) {
        db.commitFailures--
        throw db.commitError()
      }
      return Promise.all(arg)
    }
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
  reconciliation: typeof import('../reconciliation')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    approval: await import('../booking-approval'),
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    scheduling: await import('../scheduling'),
    reconciliation: await import('../reconciliation'),
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

const MOVE_DAY = '2027-09-14'
const PI = 'pi_b1'

async function createdRow(): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: MOVE_DAY,
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
      reference: 'WMIC-1042',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  assert.equal(data.status, 'PENDING_PAYMENT', 'precondition: the default path creates an unpaid hold')

  // …then the $49 authorization lands (fulfillment's claim shape).
  return {
    id: 'bk_b1',
    customerToken: 'tok_b1',
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: null,
    truck: null,
    inventoryItems: [],
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...(data as Row),
    status: 'PENDING_APPROVAL',
    depositPaid: false,
    stripePaymentIntentId: PI,
  }
}

// ── The shipped deps, with only Stripe / notifications / logging / alerts faked ─

type Recorder = {
  captures: Array<{ pi: string; key: string }>
  intentReads: string[]
  /** ITEM M1 — `cents` is `number | null`: null means Stripe reported no
   *  captured amount, and the confirmation must then carry no figure. */
  notified: Array<{ cents: number | null; by: string }>
  alerts: Array<{ title: string; lines: Array<{ message: string; action?: string }> }>
  errors: unknown[]
  /** What `retrieveIntent` reports about the money at Stripe. */
  intentStatus: string
  /** Make the intent read fail (Stripe unreachable). */
  intentError?: string
  /** Make the capture fail (e.g. the authorization expired). */
  captureError?: string
}

async function shippedDeps(over: Partial<Recorder> = {}): Promise<Recorder> {
  const m = await load()
  const rec: Recorder = {
    captures: [],
    intentReads: [],
    notified: [],
    alerts: [],
    errors: [],
    intentStatus: 'succeeded',
    ...over,
  }
  const deps = m.approval.defaultApprovalDeps() // the REAL prismaApprovalStore
  deps.stripe = {
    async capture(pi, key) {
      rec.captures.push({ pi, key })
      if (rec.captureError) throw new Error(rec.captureError)
      return { id: pi, status: 'succeeded', amount_received: 4900, latest_charge: 'ch_b1', metadata: {} }
    },
    async retrieveCharge() {
      return { id: 'ch_b1', receipt_url: 'https://receipt.example/ch_b1', payment_method_details: { type: 'card' } }
    },
    async releaseHold() {},
    async retrieveIntent(pi) {
      rec.intentReads.push(pi)
      if (rec.intentError) throw new Error(rec.intentError)
      return {
        id: pi,
        status: rec.intentStatus,
        amount_received: rec.intentStatus === 'succeeded' ? 4900 : 0,
        amount: 4900,
        latest_charge: rec.intentStatus === 'succeeded' ? 'ch_b1' : null,
        metadata: {},
      }
    },
  }
  deps.notifier = {
    async sendApproved(_b, cents, by) {
      rec.notified.push({ cents, by })
    },
    async sendDeclined() {},
  }
  deps.alerter = async (title, lines) => {
    rec.alerts.push({ title, lines })
  }
  deps.logger = { info() {}, warn() {}, error: (o) => rec.errors.push(o) }
  return rec
}

/** Approve through the SHIPPED default deps — `approveBooking` resolves the
 *  store itself, exactly as both production surfaces call it. */
async function approve(): Promise<Awaited<ReturnType<typeof import('../booking-approval').approveBooking>>> {
  const m = await load()
  return m.approval.approveBooking({
    bookingId: 'bk_b1',
    actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' },
    source: 'admin',
  })
}

const paymentAudits = (): Row[] => db.audits.filter((a) => a.action === 'PAYMENT_RECEIVED')

// ════════════════════════════════════════════════════════════════════════════
//  1. The harness really reproduces the failure (without this, nothing means
//     anything — every earlier harness made commitApproval always succeed)
// ════════════════════════════════════════════════════════════════════════════

test('B1 precondition: a failing $transaction writes NOTHING (all-or-nothing, like Postgres)', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 1
  await assert.rejects(
    () =>
      fakePrisma.$transaction([
        fakePrisma.payment.upsert({ where: { stripePaymentIntentId: PI }, update: {}, create: { stripePaymentIntentId: PI } }),
        fakePrisma.auditLog.create({ data: { action: 'PAYMENT_RECEIVED', bookingId: 'bk_b1' } }),
      ]),
    /Can't reach database server/,
  )
  assert.equal(db.payments.length, 0, 'a failed transaction must not leave a Payment row')
  assert.equal(db.audits.length, 0, 'a failed transaction must not leave an audit row')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE INCIDENT — capture succeeds, the commit dies for good
// ════════════════════════════════════════════════════════════════════════════

test('B1: when the commit fails after a successful capture, the owner is TOLD — not given a bare 500', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 99 // every attempt fails: the retry cannot save this one
  const rec = await shippedDeps()

  const res = await approve()

  // It does not throw, and it does not pretend.
  assert.equal(res.ok, false, 'a captured deposit with no record must never report success')
  assert.equal(!res.ok && res.code, 'commit_failed')
  assert.equal(rec.captures.length, 1, 'exactly one capture')
  assert.deepEqual(rec.captures[0], { pi: PI, key: `capture:${PI}` }, 'the idempotency key is unchanged')
  assert.equal(db.payments.length, 0)
  assert.equal(db.jobs.size, 0)
  assert.equal(paymentAudits().length, 0)

  // The message is owner-honest and provable: the capture DID return.
  const msg = !res.ok ? res.message : ''
  assert.match(msg, /WAS captured/i)
  assert.match(msg, /do NOT charge the customer again/i)
  assert.match(msg, new RegExp(PI))

  // It was retried, and it was alerted to a human.
  assert.equal(db.transactionAttempts, 3, 'bounded retry: three attempts, then stop')
  assert.equal(rec.alerts.length, 1, 'a silent money defect must not stay silent')
  assert.match(rec.alerts[0].title, /captured/i)
  assert.match(rec.alerts[0].lines[0].action ?? '', /do NOT charge the customer again/i)

  // The customer was NOT told the booking is confirmed — nothing is recorded.
  assert.equal(rec.notified.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE REPAIR — the retry converges instead of lying
// ════════════════════════════════════════════════════════════════════════════

test('B1: the retry after a dead commit produces exactly ONE payment, job, audit, staffing row and notification', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 99
  let rec = await shippedDeps()

  const first = await approve()
  assert.equal(first.ok, false)
  assert.equal(db.booking.status, 'CONFIRMED', 'the claim landed before the capture — this is the state to repair')
  assert.equal(db.booking.depositPaid, true)

  // Diego clicks Approve again. The database is healthy now.
  db.commitFailures = 0
  rec = await shippedDeps()
  const second = await approve()

  assert.ok(second.ok, `the retry must converge: ${!second.ok ? second.message : ''}`)
  assert.equal(second.ok && second.outcome, 'repaired')
  assert.equal(second.ok && second.capturedCents, 4900)

  // It checked Stripe rather than re-capturing blind.
  assert.deepEqual(rec.intentReads, [PI])
  assert.equal(rec.captures.length, 0, 'the money was already captured — the repair must not capture again')

  // EXACTLY ONE of everything.
  assert.equal(db.payments.length, 1)
  assert.equal(db.payments[0].status, 'COMPLETED')
  assert.equal(db.payments[0].amount, 4900)
  assert.equal(db.jobs.size, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(db.requirements.size, 1, 'the confirmed job is staffed')
  assert.equal(rec.notified.length, 1, 'the customer finally gets the confirmation they paid for')
  assert.equal(rec.notified[0].cents, 4900)
})

test('B1: a THIRD click does not double-record or double-send', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 99
  await shippedDeps()
  await approve()

  db.commitFailures = 0
  await shippedDeps()
  await approve() // the repair

  const rec = await shippedDeps()
  const third = await approve()

  assert.ok(third.ok)
  assert.equal(third.ok && third.outcome, 'already_confirmed')
  assert.equal(third.ok && third.capturedCents, 4900, 'the amount is read from the Payment row, not assumed')
  assert.equal(rec.captures.length, 0)
  assert.equal(rec.intentReads.length, 0, 'a recorded payment needs no Stripe round-trip')
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 0, 'the customer is never told twice')
})

test('B1: the repair reaches the LOST-CLAIM replay branch too', async () => {
  // The other CONFIRMED early-return: the booking read PENDING_APPROVAL, and by
  // the time the claim ran another actor (or a dead earlier run) had confirmed
  // it. Same convergence, or the branch is a second copy of the same lie.
  db = newDb(await createdRow())
  db.confirmAfterFirstRead = true
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the lost-claim branch must converge: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.deepEqual(rec.intentReads, [PI])
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1)
})

// ════════════════════════════════════════════════════════════════════════════
//  4. NEVER ok:true OVER MONEY IT CANNOT SEE
// ════════════════════════════════════════════════════════════════════════════

test('B1: a CONFIRMED booking with no Payment row and an unreachable Stripe is NOT reported as success', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 99
  await shippedDeps()
  await approve()

  const rec = await shippedDeps({ intentError: 'Stripe API is currently unavailable (503)' })
  db.commitFailures = 0
  const res = await approve()

  assert.equal(res.ok, false, 'silence about the money is not success')
  assert.equal(!res.ok && res.code, 'commit_failed')
  assert.match(!res.ok ? res.message : '', /could not be checked/i)
  assert.equal(rec.captures.length, 0, 'nothing may be captured on an unverified path')
  assert.equal(db.payments.length, 0)
  assert.equal(rec.notified.length, 0)
})

test('B1: an intent in a state this code cannot classify is refused, never guessed', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 99
  await shippedDeps()
  await approve()

  const rec = await shippedDeps({ intentStatus: 'some_future_stripe_status' })
  db.commitFailures = 0
  const res = await approve()

  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.code, 'commit_failed')
  assert.equal(rec.captures.length, 0)
  assert.equal(db.payments.length, 0)
})

test('B1: a repair NEVER writes a second PAYMENT_RECEIVED audit or a second confirmation', async () => {
  // The guard the fix plan names (the shape labor-service.ts uses for
  // JOB_CREATED): one PAYMENT_RECEIVED per booking gates BOTH the audit write
  // and the customer notification, so however a second repair is reached — a
  // concurrent Approve, a future webhook net re-driving the same commit — it can
  // neither stack a second "payment received" on one $49 nor tell the customer
  // twice. Seeded as commitApproval writes it — including
  // `details.paymentIntentId`, which every row this module writes carries and
  // which item T1 made the guard's scope: the question is "was THIS capture
  // recorded", not "has this booking ever been approved".
  db = newDb(await createdRow())
  db.commitFailures = 99
  await shippedDeps()
  await approve() // the incident: CONFIRMED, no Payment row
  db.audits.push({
    action: 'PAYMENT_RECEIVED',
    bookingId: 'bk_b1',
    userId: 'u_diego',
    details: { event: 'approve_booking', paymentIntentId: PI },
  })

  db.commitFailures = 0
  const rec = await shippedDeps()
  const res = await approve()

  assert.ok(res.ok, `the money must still be recorded: ${!res.ok ? res.message : ''}`)
  assert.equal(db.payments.length, 1, 'the missing Payment row IS written — that is the repair')
  assert.equal(paymentAudits().length, 1, 'but the audit is NOT duplicated')
  assert.equal(rec.notified.length, 0, 'and the customer is NOT told a second time')
})

test('B1: a REFUNDED deposit is never "repaired" back to COMPLETED', async () => {
  // A Payment row exists, so commitApproval demonstrably ran for this intent —
  // this is not the B1 defect. Re-driving the commit would overwrite a recorded
  // refund with COMPLETED, which is a claim about money that is false.
  const row = await createdRow()
  db = newDb({ ...row, status: 'CONFIRMED', depositPaid: true })
  db.payments.push({
    id: 'pay_1',
    bookingId: 'bk_b1',
    stripePaymentIntentId: PI,
    amount: 4900,
    status: 'REFUNDED',
    receiptUrl: null,
  })
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'already_confirmed')
  assert.equal(res.ok && res.capturedCents, null, 'no captured amount may be claimed for a refunded deposit')
  assert.equal(db.payments[0].status, 'REFUNDED', 'the refund record is left exactly as it was')
  assert.equal(paymentAudits().length, 0)
  assert.equal(rec.captures.length, 0)
  assert.equal(rec.notified.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  5. THE MIRROR CASE — the process died BETWEEN the claim and the capture
// ════════════════════════════════════════════════════════════════════════════

test('B1 mirror: a CONFIRMED booking whose authorization was never captured does not stay that way', async () => {
  // No capture ever happened, the compensating rollback never ran: the row reads
  // CONFIRMED + depositPaid over an authorization Stripe expires in ~7 days.
  const row = await createdRow()
  db = newDb({ ...row, status: 'CONFIRMED', depositPaid: true })
  const rec = await shippedDeps({ intentStatus: 'requires_capture' })

  const res = await approve()

  assert.ok(res.ok, `the mirror case must converge: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.equal(rec.captures.length, 1, 'the $49 that would have expired is captured')
  assert.equal(rec.captures[0].key, `capture:${PI}`, 'the SAME idempotency key — a race still collapses to one charge')
  assert.equal(db.payments.length, 1)
  assert.equal(db.payments[0].status, 'COMPLETED')
  assert.equal(paymentAudits().length, 1)
  assert.equal(db.booking.status, 'CONFIRMED')
  assert.equal(rec.notified.length, 1)
})

test('B1 mirror: when that capture fails, the booking stops claiming to be CONFIRMED', async () => {
  const row = await createdRow()
  db = newDb({ ...row, status: 'CONFIRMED', depositPaid: true })
  const rec = await shippedDeps({ intentStatus: 'requires_capture', captureError: 'the authorization has expired' })

  const res = await approve()

  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.code, 'capture_failed')
  assert.match(!res.ok ? res.message : '', /has NOT been charged/i)
  assert.equal(db.booking.status, 'PENDING_APPROVAL', 'the claim is rolled back — no CONFIRMED without capture')
  assert.equal(db.booking.depositPaid, false)
  assert.equal(db.payments.length, 0)
  assert.equal(rec.notified.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  6. THE BOUNDED RETRY — most real occurrences never become an incident
// ════════════════════════════════════════════════════════════════════════════

test('B1: a single transient commit failure heals inside one approval', async () => {
  db = newDb(await createdRow())
  db.commitFailures = 1 // heals on attempt 2
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the retry must absorb a Neon blip: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'captured')
  assert.equal(db.transactionAttempts, 2)
  assert.equal(rec.captures.length, 1)
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1)
  assert.equal(rec.alerts.length, 0, 'a healed blip is not an incident')
})

test('B1: a MIGRATION-shaped commit failure is not retried — it is deterministic', async () => {
  const m = await load()
  let attempts = 0
  const res = await m.approval.commitApprovalWithRetry(
    {
      async commitApproval() {
        attempts++
        throw Object.assign(new Error('The column `payments.foo` does not exist in the current database.'), { code: 'P2022' })
      },
    },
    { bookingId: 'bk_b1', paymentIntentId: PI } as never,
    { info() {}, warn() {}, error() {} },
  )
  assert.equal(res.ok, false)
  assert.equal(attempts, 1, 'retrying a missing migration only delays an honest answer')
})

test('B1: the happy path is unchanged — one capture, one of everything, no alert', async () => {
  db = newDb(await createdRow())
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'captured')
  assert.equal(res.ok && res.capturedCents, 4900)
  assert.equal(db.transactionAttempts, 1, 'a healthy commit is not retried')
  assert.equal(rec.captures.length, 1)
  assert.equal(rec.intentReads.length, 0, 'the ordinary approval makes no extra Stripe call')
  assert.equal(db.payments.length, 1)
  assert.equal(db.jobs.size, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(db.requirements.size, 1)
  assert.equal(rec.notified.length, 1)
  assert.equal(rec.alerts.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  7. THE PURE CLASSIFIER — what a PaymentIntent proves
// ════════════════════════════════════════════════════════════════════════════

test('B1: intentCaptureState never guesses', async () => {
  const { intentCaptureState } = (await load()).approval
  assert.equal(intentCaptureState({ id: PI, status: 'succeeded' }), 'captured')
  assert.equal(intentCaptureState({ id: PI, amount_received: 4900 }), 'captured')
  assert.equal(intentCaptureState({ id: PI, status: 'requires_capture', amount_received: 0 }), 'uncaptured')
  assert.equal(intentCaptureState({ id: PI, status: 'canceled' }), 'uncaptured')
  assert.equal(intentCaptureState({ id: PI, status: 'processing' }), 'uncaptured')
  assert.equal(intentCaptureState(null), 'unknown')
  assert.equal(intentCaptureState({ id: PI }), 'unknown')
  assert.equal(intentCaptureState({ id: PI, status: 'a_status_stripe_adds_next_year' }), 'unknown')
  // A captured intent whose status is missing is still captured — money first.
  assert.equal(intentCaptureState({ id: PI, amount_received: 4900, status: null }), 'captured')
})

// ════════════════════════════════════════════════════════════════════════════
//  8. THE DETECTOR NOBODY RAN — it sees this state, and now it can be scheduled
// ════════════════════════════════════════════════════════════════════════════

test('B1: reconcile() flags the exact post-failure state (both shapes)', async () => {
  const { reconcile, summarizeIssues } = (await load()).reconciliation
  const issues = reconcile({
    stripeCharges: [
      { paymentIntentId: PI, chargeId: 'ch_b1', amountCaptured: 4900, amountRefunded: 0, captured: true, disputed: false, status: 'succeeded' },
    ],
    payments: [], // the commit died
    bookings: [{ id: 'bk_b1', displayId: 'WMIC-1042', status: 'CONFIRMED', isInternalTest: false }],
  })
  assert.ok(issues.some((i) => i.type === 'captured_no_payment_row' && i.severity === 'critical'))
  assert.ok(issues.some((i) => i.type === 'confirmed_no_payment' && i.severity === 'high'))
  const summary = summarizeIssues(issues)
  assert.equal(summary.critical, 1)
  assert.equal(summary.high, 1)
  assert.equal(summary.needsAttention, true)
})

test('B1: a reconciliation run with money missing ALERTS, and a clean one does not', async () => {
  const { buildReconAlert } = (await load()).reconciliation
  const base = { ranAt: '2026-08-14T00:00:00.000Z', windowDays: 30, chargesChecked: 12, paymentsChecked: 11, bookingsChecked: 11 }

  assert.equal(buildReconAlert({ ...base, issues: [] }), null, 'a clean run must not ping the alerts channel')
  assert.equal(
    buildReconAlert({ ...base, issues: [{ type: 'amount_mismatch', severity: 'medium', ref: 'pay_1', detail: 'drift' }] }),
    null,
    'routine drift must not ping the alerts channel — a muted channel loses the critical alerts too',
  )

  const alert = buildReconAlert({
    ...base,
    issues: [
      { type: 'confirmed_no_payment', severity: 'high', ref: 'bk_b1', detail: 'Booking WMIC-1042 is CONFIRMED but has no COMPLETED payment recorded.' },
      { type: 'captured_no_payment_row', severity: 'critical', ref: 'ch_b1', detail: 'Stripe captured 49.00 on ch_b1 but there is no local Payment row.' },
    ],
  })
  assert.ok(alert)
  assert.match(alert!.lines[0].message, /CRITICAL/, 'the critical finding must survive the 8-line cap')
  assert.match(alert!.lines[0].action ?? '', /do NOT charge the customer again/i)
})

test('B1: the scheduled-run guard fails CLOSED', async () => {
  const { isScheduledRunAuthorized } = (await load()).reconciliation
  const secret = 'a-real-secret-value-32-chars-long'

  assert.equal(isScheduledRunAuthorized(`Bearer ${secret}`, secret), true)
  assert.equal(isScheduledRunAuthorized(secret, secret), true, 'a bare secret header is accepted too')
  assert.equal(isScheduledRunAuthorized(`Bearer ${secret}`, undefined), false, 'no secret configured ⇒ no scheduled access')
  assert.equal(isScheduledRunAuthorized(`Bearer ${secret}`, ''), false)
  assert.equal(isScheduledRunAuthorized('Bearer short', 'short'), false, 'a guessable secret is not a secret')
  assert.equal(isScheduledRunAuthorized('Bearer REPLACE_ME_WITH_A_SECRET', 'REPLACE_ME_WITH_A_SECRET'), false, 'a placeholder must look unconfigured')
  assert.equal(isScheduledRunAuthorized(null, secret), false)
  assert.equal(isScheduledRunAuthorized('Bearer wrong-secret-value-32-chars', secret), false)
})
