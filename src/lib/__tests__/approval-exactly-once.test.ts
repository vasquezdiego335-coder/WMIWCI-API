// ════════════════════════════════════════════════════════════════════════════
//  approval-exactly-once.test.ts — REPAIR ITEMS R1 + R2
//
//  R1 — THE DEFECT (reproduced by verification against the shipped code):
//    `await Promise.all([approve(), approve()])` on an incident booking
//    (CONFIRMED, $49 captured at Stripe, no Payment row) produced
//        outcomes ['repaired','repaired'] · payments 1 · paymentAudits 2 · notified 2
//    The customer got two "your booking is approved" emails and two SMS, and the
//    ledger carried two PAYMENT_RECEIVED rows for one $49. `countApprovalAudits`
//    ran BEFORE `commitApprovalWithRetry` and gated both the audit and the
//    notification, so two callers both read 0. A guard two callers can both pass
//    is not a guard.
//
//  R1 — THE FIX UNDER TEST: the claim IS the audit row, inserted under a
//    DETERMINISTIC PRIMARY KEY (`approvalAuditId`). Postgres serialises the two
//    inserts; the loser's WHOLE transaction rolls back and it announces nothing.
//    Every assertion below therefore has a matching one about what the LOSER
//    gets — a skip that costs the caller a truthful answer is the adjacent-
//    assertion trap that let the last regression through.
//
//  R2 — THE DEFECT: `commitFailedMessage` told the owner "Click Approve again".
//    On the admin surface that was impossible — after the failure the booking is
//    CONFIRMED, `VALID_TRANSITIONS.CONFIRMED = ['SCHEDULED','CANCELLED']`, and
//    the 422 fires BEFORE the approval branch, so `approveBooking` was never
//    called. Only the Discord card could reach the cure, and that card is
//    delivered best-effort.
//
//  WHY THIS FILE IS NOT THEATRE
//    • the booking row is what the SHIPPED WRITER persists (`resolveMoveSchedule`
//      → `buildBookingCreateData`, DEFAULT owner path, deposit `stripe_link`);
//    • `defaultApprovalDeps()` — the REAL `prismaApprovalStore` — runs against a
//      fake `prisma` installed on globalThis before src/lib/db.ts is imported,
//      so `countApprovalAudits`, `findPaymentForIntent` and the Payment/Job/audit
//      transaction under test are the production ones;
//    • the fake `$transaction` is ALL-OR-NOTHING and executes its operations
//      SYNCHRONOUSLY, so two interleaved transactions cannot corrupt each other
//      — a fake that "rolled back" across an await would prove nothing;
//    • `auditLog.create` enforces the PRIMARY KEY, because that constraint IS
//      the fix. Test 1 turns the enforcement OFF and shows the original defect
//      reappearing, so the harness is demonstrably able to see it.
//
//  Offline: no database, no Stripe, no Redis, no network. Run:
//    npx tsx --test src/lib/__tests__/approval-exactly-once.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>

// ── The fake database ───────────────────────────────────────────────────────

/** A Prisma-like LAZY promise that can ALSO be run synchronously. Real
 *  `PrismaPromise`s do not touch the database until awaited, which is what
 *  makes `$transaction([...])` atomic. `__run` lets the fake transaction
 *  execute every operation inside ONE synchronous turn, so a rollback can never
 *  race a concurrent transaction's writes — the property this file depends on. */
type LazyOp<T> = Promise<T> & { __run: () => T }

function lazy<T>(run: () => T): Promise<T> {
  let p: Promise<T> | null = null
  const start = (): Promise<T> => (p ??= (async () => run())())
  return {
    then: (a: unknown, b: unknown) => start().then(a as never, b as never),
    catch: (b: unknown) => start().catch(b as never),
    finally: (f: () => void) => start().finally(f),
    __run: run,
  } as unknown as Promise<T>
}

/** Deterministically pin the race the verifier hit: every arriving caller waits
 *  until `size` of them have arrived, then all proceed. Without this the two
 *  approvals might serialise by luck and the test would pass for the wrong
 *  reason. */
function newBarrier(size: number): { arrive: () => Promise<void> } {
  let arrived = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  return {
    async arrive() {
      arrived += 1
      if (arrived >= size) release()
      await gate
    },
  }
}

type FakeDb = {
  booking: Row
  payments: Row[]
  audits: Row[]
  jobs: Map<string, string>
  requirements: Map<string, Row>
  /** How many more `$transaction([...])` array calls must fail. */
  commitFailures: number
  commitError: () => Error
  /** THE CONSTRAINT UNDER TEST. False = a database without it (and the round-1
   *  behaviour), used only to show this harness can see the defect. */
  enforceAuditPk: boolean
  /** ITEM T1 — THE MUTATION SWITCH for round 2's key. True = the world before
   *  this item: ONE PERMANENT claim per BOOKING (`pyrcv_<bookingId>`) and a
   *  booking-scoped audit count. Nothing in the shipped module changes; the fake
   *  rewrites the id it is handed and drops the intent clause from the count,
   *  which is EXACTLY the two things item T1 changed. Used only to show this
   *  harness still sees the original defect. */
  legacyBookingScopedClaim: boolean
  /** Held inside `auditLog.count` so both repairs read the pre-commit value. */
  countBarrier: { arrive: () => Promise<void> } | null
  transactionAttempts: number
  auditInsertAttempts: number
  /** ITEM M2 — STRIPE'S OWN STATE, per payment intent: whether the money has
   *  been taken, WHEN, and under which idempotency key. The old fake had none of
   *  this — its `capture()` returned `succeeded` unconditionally — so the round-3
   *  reschedule repair rested on a fake that could not express the failure it
   *  needed to survive. See `stripeCapture`. */
  stripeIntents: Map<string, { captured: boolean; capturedAt: number; key: string | null }>
  /** ITEM M2 — the clock the STRIPE fake reads (ms). A reschedule arrives days
   *  after the original capture, and that gap is the whole defect. */
  clockMs: number
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
    enforceAuditPk: true,
    legacyBookingScopedClaim: false,
    countBarrier: null,
    transactionAttempts: 0,
    auditInsertAttempts: 0,
    stripeIntents: new Map(),
    clockMs: Date.parse('2027-08-01T12:00:00.000Z'),
  }
}

// ── ITEM M2 — THE STRIPE CAPTURE FAKE, MODELLED ON THE REAL CONTRACT ────────
//
// Stripe idempotency keys are kept for 24 HOURS. Inside that window a repeated
// capture under the same key REPLAYS the original response; outside it the key
// is gone and the API answers about the intent itself — and `capture` is not a
// legal transition from `succeeded`, so it ERRORS.
//
// booking-approval.ts says exactly this in its own comment (the note on
// `retrieveIntent`), and `convergeConfirmed` refuses to blind-capture because of
// it — while `approveBooking` blind-captured on the one flow that re-approves an
// already-captured intent (a portal reschedule keeps the SAME $49 hold). A fake
// that always returns `succeeded` cannot express that, which is why the repair
// that depended on it could ship while the defect stood.
const STRIPE_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

/** The error Stripe raises for a capture of an already-captured intent. */
function stripeUnexpectedState(pi: string): Error {
  return Object.assign(
    new Error(`This PaymentIntent (${pi}) could not be captured because it has a status of succeeded.`),
    { type: 'StripeInvalidRequestError', code: 'payment_intent_unexpected_state', statusCode: 400 },
  )
}

const capturedIntentResponse = (pi: string): Row => ({
  id: pi,
  status: 'succeeded',
  amount_received: 4900,
  amount: 4900,
  latest_charge: 'ch_r1',
  metadata: {},
})

/** THE fake capture. Shared by every test in this file. */
function stripeCapture(pi: string, key: string): Row {
  const seen = db.stripeIntents.get(pi)
  if (seen?.captured) {
    const withinWindow = db.clockMs - seen.capturedAt < STRIPE_IDEMPOTENCY_WINDOW_MS
    if (withinWindow && seen.key === key) return capturedIntentResponse(pi)
    throw stripeUnexpectedState(pi)
  }
  db.stripeIntents.set(pi, { captured: true, capturedAt: db.clockMs, key })
  return capturedIntentResponse(pi)
}

/** Stripe took this money at some earlier point, with no local record of it —
 *  the shape a B1 incident (or a pre-ledger capture) leaves behind. */
function stripeAlreadyCaptured(pi: string, agoMs = 0): void {
  db.stripeIntents.set(pi, { captured: true, capturedAt: db.clockMs - agoMs, key: `capture:${pi}` })
}

/** Time passes between the original capture and the re-approval. */
function advanceHours(hours: number): void {
  db.clockMs += hours * 60 * 60 * 1000
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
  for (const [key, val] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(val as Row[]).some((clause) => matchesWhere(row, clause))) return false
      continue
    }
    // ITEM T1 — `countApprovalAudits` needs TWO JSON-path conditions (the event
    // AND the payment intent), which Prisma expresses as an AND array because
    // one object cannot carry the same `details` key twice.
    if (key === 'AND') {
      if (!(val as Row[]).every((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (val && typeof val === 'object' && 'in' in (val as Row)) {
      if (!((val as { in: unknown[] }).in ?? []).includes(row[key])) return false
      continue
    }
    // Prisma's JSON path filter — `countApprovalAudits` uses it to count ONLY
    // the PAYMENT_RECEIVED row this module writes.
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

type Snapshot = { payments: Row[]; audits: Row[]; jobs: Map<string, string> }
const snapshot = (): Snapshot => ({
  payments: db.payments.map((p) => ({ ...p })),
  audits: db.audits.map((a) => ({ ...a })),
  jobs: new Map(db.jobs),
})
function rollback(s: Snapshot): void {
  db.payments = s.payments
  db.audits = s.audits
  db.jobs = s.jobs
}

function uniqueViolation(field: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), {
    code: 'P2002',
    meta: { target: [field] },
  })
}

// ── ITEM T1 — THE MUTATION: put round 2's key back ──────────────────────────
// Both helpers are no-ops unless `db.legacyBookingScopedClaim` is set, and they
// reverse EXACTLY the two things item T1 changed:
//   1. the claim id `pyrcv__<booking>__<intent>` becomes `pyrcv_<booking>`, so
//      one booking has ONE permanent claim however many intents it carries;
//   2. the audit count stops asking about the intent, so a prior approval of a
//      DIFFERENT intent reads as "already recorded".
// The shipped module is untouched — that is the point: the tests below drive the
// real `approveBooking`/`prismaApprovalStore` in both worlds and the defect
// reappears in one of them.

/** Round 2's booking-scoped id, derived from round 3's. */
function legacyClaimId(id: unknown): unknown {
  if (!db.legacyBookingScopedClaim || typeof id !== 'string') return id
  const parts = id.split('__')
  return parts[0] === 'pyrcv' && parts.length >= 3 ? `pyrcv_${parts[1]}` : id
}

/** Round 2's booking-scoped count: the same where clause with the intent
 *  condition removed. */
function legacyCountWhere(where: Row | undefined): Row | undefined {
  if (!db.legacyBookingScopedClaim || !where) return where
  const and = where.AND as Row[] | undefined
  if (!and) return where
  const kept = and.filter((clause) => {
    const details = clause.details as { path?: string[] } | undefined
    return !(details?.path ?? []).includes('paymentIntentId')
  })
  return { ...where, AND: kept }
}

const fakePrisma = {
  booking: {
    async findFirst(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      return matchesWhere(db.booking, args.where) ? project(db.booking, args.select) : null
    },
    async findUnique(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      return matchesWhere(db.booking, args.where) ? project(db.booking, args.select) : null
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
        const created = { id: `pay_${db.payments.length + 1}`, ...args.create }
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
        db.auditInsertAttempts += 1
        const row = { ...args.data, id: legacyClaimId(args.data.id) }
        const id = row.id
        // THE PRIMARY KEY. This is the whole exactly-once guarantee: Postgres
        // refuses the second insert of the same id and aborts that transaction.
        if (db.enforceAuditPk && typeof id === 'string' && db.audits.some((a) => a.id === id)) {
          throw uniqueViolation('id')
        }
        db.audits.push(row)
        return row
      })
    },
    async count(args: { where?: Row }): Promise<number> {
      if (db.countBarrier) await db.countBarrier.arrive()
      return db.audits.filter((a) => matchesWhere(a, legacyCountWhere(args?.where))).length
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
      if (db.commitFailures > 0) {
        db.commitFailures--
        throw db.commitError()
      }
      // Postgres is all-or-nothing. Executed synchronously so a concurrent
      // transaction can neither observe a half-written state nor have its own
      // writes undone by this one's rollback.
      const before = snapshot()
      try {
        return arg.map((op) => (op as LazyOp<unknown>).__run())
      } catch (e) {
        rollback(before)
        throw e
      }
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

// ── The row the SHIPPED WRITER persists ─────────────────────────────────────

const MOVE_DAY = '2027-09-14'
const PI = 'pi_r1'
/** ITEM T1 — the SECOND authorization's intent. A booking that goes through
 *  checkout again carries a different PaymentIntent, and `fulfillment.ts` points
 *  the booking at it; the approval of that hold is different money. */
const PI2 = 'pi_r1_second'
const BOOKING_ID = 'bk_r1'

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

  return {
    id: BOOKING_ID,
    customerToken: 'tok_r1',
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
  /** ITEM T1 — `intent` is the 4th argument the notifier now receives: the money
   *  this confirmation is about, which is part of its deterministic queue id. */
  notified: Array<{ cents: number | null; by: string; intent: string | null }>
  alerts: Array<{ title: string; lines: Array<{ message: string; action?: string }> }>
  errors: unknown[]
  /** ITEM M2 — an OVERRIDE. Unset (the default), `retrieveIntent` answers from
   *  the fake Stripe's own capture state, so the read and the capture can never
   *  disagree by accident. */
  intentStatus?: string
  intentError?: string
}

async function shippedDeps(over: Partial<Recorder> = {}): Promise<Recorder> {
  const m = await load()
  const rec: Recorder = {
    captures: [],
    intentReads: [],
    notified: [],
    alerts: [],
    errors: [],
    ...over,
  }
  const deps = m.approval.defaultApprovalDeps() // the REAL prismaApprovalStore
  deps.stripe = {
    async capture(pi, key) {
      rec.captures.push({ pi, key })
      // ITEM M2 — this USED TO return `succeeded` unconditionally, with a comment
      // asserting that Stripe replays a repeated capture. It replays for 24
      // HOURS; after that the same call errors. `stripeCapture` models both.
      return stripeCapture(pi, key) as never
    },
    async retrieveCharge() {
      return { id: 'ch_r1', receipt_url: 'https://receipt.example/ch_r1', payment_method_details: { type: 'card' } }
    },
    async releaseHold() {},
    async retrieveIntent(pi) {
      rec.intentReads.push(pi)
      if (rec.intentError) throw new Error(rec.intentError)
      // The read answers about the SAME state the capture fake maintains — a
      // gateway whose two calls disagreed could hide the very mismatch this
      // item is about. An explicit `intentStatus` still overrides it.
      const status = rec.intentStatus ?? (db.stripeIntents.get(pi)?.captured ? 'succeeded' : 'requires_capture')
      return {
        id: pi,
        status,
        amount_received: status === 'succeeded' ? 4900 : 0,
        amount: 4900,
        latest_charge: status === 'succeeded' ? 'ch_r1' : null,
        metadata: {},
      }
    },
  }
  deps.notifier = {
    async sendApproved(_b, cents, by, intent) {
      rec.notified.push({ cents, by, intent: intent ?? null })
    },
    async sendDeclined() {},
  }
  deps.alerter = async (title, lines) => {
    rec.alerts.push({ title, lines })
  }
  deps.logger = { info() {}, warn() {}, error: (o) => rec.errors.push(o) }
  return rec
}

type ApprovalResult = Awaited<ReturnType<typeof import('../booking-approval').approveBooking>>

async function approve(source: 'admin' | 'discord' = 'admin'): Promise<ApprovalResult> {
  const m = await load()
  return m.approval.approveBooking({
    bookingId: BOOKING_ID,
    actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' },
    source,
  })
}

const paymentAudits = (): Row[] => db.audits.filter((a) => a.action === 'PAYMENT_RECEIVED' && (a.details as Row)?.event === 'approve_booking')

/** Drive the booking into the exact B1 incident state: $49 captured at Stripe,
 *  booking CONFIRMED, NO Payment row, NO audit, customer never told. */
async function driveIntoIncident(): Promise<void> {
  db = newDb(await createdRow())
  db.commitFailures = 99
  await shippedDeps()
  const first = await approve()
  assert.equal(first.ok, false, 'precondition: the incident must not report success')
  assert.equal(db.booking.status, 'CONFIRMED')
  assert.equal(db.payments.length, 0)
  assert.equal(paymentAudits().length, 0)
  db.commitFailures = 0
}

// ════════════════════════════════════════════════════════════════════════════
//  1. THE HARNESS CAN SEE THE DEFECT — without this, everything below is
//     theatre. Same concurrent run, primary key NOT enforced.
// ════════════════════════════════════════════════════════════════════════════

test('R1 harness check: with no database constraint, two concurrent repairs BOTH win', async () => {
  await driveIntoIncident()
  db.enforceAuditPk = false // a database without the constraint = the round-1 world
  db.countBarrier = newBarrier(2)
  const rec = await shippedDeps()

  const results = await Promise.all([approve(), approve()])

  assert.deepEqual(
    results.map((r) => (r.ok ? r.outcome : r.code)),
    ['repaired', 'repaired'],
    'both callers must genuinely reach the repair — otherwise the race below is not the race',
  )
  assert.equal(db.auditInsertAttempts, 2, 'both callers attempted the audit insert (both read the count as 0)')
  assert.equal(paymentAudits().length, 2, 'THE DEFECT: two PAYMENT_RECEIVED rows for one $49')
  assert.equal(rec.notified.length, 2, 'THE DEFECT: the customer is told twice')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. R1 — THE REPRODUCTION, against the constraint that ships
// ════════════════════════════════════════════════════════════════════════════

test('R1: two concurrent repairs — ONE payment, ONE audit, ONE notification', async () => {
  await driveIntoIncident()
  db.countBarrier = newBarrier(2) // both read the audit count BEFORE either commits
  const rec = await shippedDeps()

  const results = await Promise.all([approve(), approve()])

  // Both callers really did race through the repair path.
  assert.equal(db.auditInsertAttempts, 2, 'both callers attempted the insert — the DATABASE, not a read, decided')
  assert.equal(rec.intentReads.length, 2, 'both callers checked Stripe (neither found a Payment row)')

  // Exactly one of everything.
  assert.equal(db.payments.length, 1, 'one $49, one Payment row')
  assert.equal(db.payments[0].status, 'COMPLETED')
  assert.equal(db.payments[0].amount, 4900)
  assert.equal(paymentAudits().length, 1, 'the ledger carries ONE PAYMENT_RECEIVED for one $49')
  assert.equal(rec.notified.length, 1, 'the customer is told exactly once')
  assert.equal(rec.notified[0].cents, 4900)
  assert.equal(db.jobs.size, 1)
  assert.equal(db.requirements.size, 1, 'the confirmed job is staffed exactly once')

  // Nobody captured anything: the money was already at Stripe.
  assert.equal(rec.captures.length, 0)

  // WHAT THE SKIP COSTS THE CALLER — the half that was missing last time.
  // The loser must not be told the record failed, must not be handed a $49
  // figure it cannot prove, and must not be pushed toward charging again.
  assert.ok(results.every((r) => r.ok), `neither caller may report failure: ${results.map((r) => (r.ok ? 'ok' : r.message)).join(' | ')}`)
  const outcomes = results.map((r) => (r.ok ? r.outcome : 'ERROR')).sort()
  assert.deepEqual(outcomes, ['already_confirmed', 'repaired'], 'the winner repaired; the loser says the record already exists')
  for (const r of results) {
    assert.ok(r.ok)
    assert.equal(r.ok && r.capturedCents, 4900, 'both callers report the amount the DATABASE proves')
  }
  assert.equal(rec.alerts.length, 0, 'a race that resolved correctly is not a money incident')
})

test('R1: the verifier\'s exact reproduction — await Promise.all([approve(), approve()])', async () => {
  // No barrier, no staging: the literal call the verifier ran against the
  // shipped code, which produced payments 1, paymentAudits 2, notified 2.
  await driveIntoIncident()
  const rec = await shippedDeps()

  const outcomes = (await Promise.all([approve(), approve()])).map((r) => (r.ok ? r.outcome : r.code))

  assert.equal(db.payments.length, 1, 'payments')
  assert.equal(paymentAudits().length, 1, 'paymentAudits — was 2')
  assert.equal(rec.notified.length, 1, 'notified — was 2')
  assert.ok(!outcomes.includes('commit_failed'), `neither caller may report a failed record: ${outcomes.join(',')}`)
  assert.ok(outcomes.includes('repaired'), `one caller must do the repair: ${outcomes.join(',')}`)
})

test('R1: three simultaneous clicks are still one email and one ledger row', async () => {
  // The guarantee is not a two-caller special case: the primary key admits ONE
  // insert regardless of how many owners (or surfaces) fire at once.
  await driveIntoIncident()
  db.countBarrier = newBarrier(3)
  const rec = await shippedDeps()

  const results = await Promise.all([approve(), approve('discord'), approve()])

  assert.equal(db.auditInsertAttempts, 3, 'all three raced through to the insert')
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1)
  assert.ok(results.every((r) => r.ok), 'and none of the three is told the record failed')
})

test('R1: the audit row IS the claim — it carries the deterministic primary key', async () => {
  const m = await load()
  await driveIntoIncident()
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok)
  assert.equal(paymentAudits().length, 1)
  assert.equal(
    paymentAudits()[0].id,
    m.approval.approvalAuditId(BOOKING_ID, PI),
    'without the deterministic id the primary key cannot refuse a second insert, and the guard is gone',
  )
  assert.equal(rec.notified.length, 1)

  // And a second, sequential repair attempt on the same booking cannot insert
  // it — proven directly against the fake constraint.
  await assert.rejects(
    () => fakePrisma.auditLog.create({ data: { id: m.approval.approvalAuditId(BOOKING_ID, PI), action: 'PAYMENT_RECEIVED' } }),
    (e: unknown) => m.approval.isUniqueViolation(e),
    'the primary key must refuse a second PAYMENT_RECEIVED for this approval',
  )
})

test('R1: the loser writes NOTHING — its whole transaction rolls back', async () => {
  // Concurrency aside, this is the property the fix rests on: a conflicting
  // audit insert must take the Payment upsert down with it, or a "loser" could
  // still half-write the money record.
  const m = await load()
  db = newDb(await createdRow())
  db.audits.push({
    id: m.approval.approvalAuditId(BOOKING_ID, PI),
    action: 'PAYMENT_RECEIVED',
    bookingId: BOOKING_ID,
    details: { event: 'approve_booking', paymentIntentId: PI },
  })
  const before = db.payments.length

  await assert.rejects(
    () =>
      fakePrisma.$transaction([
        fakePrisma.payment.upsert({ where: { stripePaymentIntentId: PI }, update: {}, create: { stripePaymentIntentId: PI, status: 'COMPLETED' } }),
        fakePrisma.auditLog.create({ data: { id: m.approval.approvalAuditId(BOOKING_ID, PI), action: 'PAYMENT_RECEIVED' } }),
      ]),
    /Unique constraint/,
  )
  assert.equal(db.payments.length, before, 'the conflicting transaction must leave no Payment row behind')
  assert.equal(paymentAudits().length, 1, 'and no second audit row')
})

// ════════════════════════════════════════════════════════════════════════════
//  3. R1 — THE LOSER IS NEVER GIVEN A FALSE ANSWER IN EITHER DIRECTION
// ════════════════════════════════════════════════════════════════════════════

test('R1: a conflict with NO recorded payment is still reported as a failure, not a lost race', async () => {
  // A unique violation that is NOT "somebody else recorded it" (a stale index,
  // an unrelated constraint) must never be laundered into ok:true. The
  // convergence asks the database and, finding no COMPLETED Payment, keeps the
  // honest B1 report.
  await driveIntoIncident()
  const attemptsBefore = db.transactionAttempts
  db.commitFailures = 99
  db.commitError = () => uniqueViolation('id')
  const rec = await shippedDeps()

  const res = await approve()

  assert.equal(res.ok, false, 'no COMPLETED Payment exists — success would be a claim the database cannot support')
  assert.equal(!res.ok && res.code, 'commit_failed')
  assert.equal(db.payments.length, 0)
  assert.equal(rec.notified.length, 0, 'and the customer is not told about a record that does not exist')
  assert.equal(rec.alerts.length, 1, 'a real money incident still alerts a human')
  assert.equal(
    db.transactionAttempts - attemptsBefore,
    1,
    'a unique violation is deterministic — retrying it only delays the answer (a transient failure still gets its 3 attempts)',
  )
})

test('R1: fulfillment\'s own PAYMENT_RECEIVED audit must not silence the customer', async () => {
  // src/lib/fulfillment.ts writes a PAYMENT_RECEIVED row for the $49
  // AUTHORIZATION on EVERY paid checkout, and app/api/admin/payments/route.ts
  // writes one for a manual move-day payment. Round 1 counted every such row as
  // "this approval was already recorded", so on a real booking the repair
  // suppressed both its audit and the customer's confirmation — reintroducing
  // the exact silence B1 exists to close.
  await driveIntoIncident()
  db.audits.push({
    id: 'legacy_authorization_audit',
    action: 'PAYMENT_RECEIVED',
    bookingId: BOOKING_ID,
    details: { authorized: true, amount: 4900, paymentIntentId: PI, source: 'stripe_webhook' },
  })
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the repair must still run: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.equal(db.payments.length, 1, 'the missing Payment row IS written')
  assert.equal(paymentAudits().length, 1, 'and this approval gets its own audit row')
  assert.equal(rec.notified.length, 1, 'and the customer who paid $49 is finally told')
})

test('R1: this module\'s OWN prior audit still suppresses a second announcement', async () => {
  // The other half of the same rule: a row written by THIS module for THIS
  // approval means the customer already heard, so a later repair must stay
  // quiet. (Seeded without the deterministic id, as a pre-R1 row would be —
  // but WITH `details.paymentIntentId`, which every row this module has ever
  // written carries: see `auditDetails` in recordCapturedApproval. Item T1
  // scopes the count to that field, and a fixture that omitted what the shipped
  // writer always writes would be testing a row production cannot produce.)
  await driveIntoIncident()
  db.audits.push({
    action: 'PAYMENT_RECEIVED',
    bookingId: BOOKING_ID,
    userId: 'u_diego',
    details: { event: 'approve_booking', source: 'discord', paymentIntentId: PI },
  })
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the money must still be recorded: ${!res.ok ? res.message : ''}`)
  assert.equal(db.payments.length, 1, 'the missing Payment row IS written — that is the repair')
  assert.equal(paymentAudits().length, 1, 'but the audit is NOT duplicated')
  assert.equal(rec.notified.length, 0, 'and the customer is NOT told a second time')
})

// ════════════════════════════════════════════════════════════════════════════
//  3b. ITEM T1 — THE CLAIM IS KEYED TO THE MONEY, NOT THE BOOKING
//
//  Round 2's claim id was `pyrcv_<bookingId>`: keyed to the BOOKING, and
//  permanent. The money is keyed to the INTENT. Two failures fell out of that
//  one misalignment, and both are driven below against the SHIPPED
//  approveBooking + prismaApprovalStore:
//
//   (1) a customer reschedules through the portal — same $49 hold, new date,
//       booking back to PENDING_APPROVAL — and the owner's re-approval hits the
//       permanent key, is (correctly) non-retryable, and reports
//       `already_confirmed` while saying NOTHING. The customer never learns the
//       new date is confirmed.
//   (2) a booking approved against a DIFFERENT intent: the transaction rolls
//       back on the first intent's row, and `recordedByAnotherCaller` then asks
//       about the NEW intent and finds nothing — a `commit_failed` over $49 that
//       Stripe really took, with no Payment row and no confirmation.
//
//  Each pair below runs the SAME scenario twice: once with
//  `db.legacyBookingScopedClaim` (round 2's key, restored by the fake) to prove
//  this harness still SEES the defect, and once as shipped.
// ════════════════════════════════════════════════════════════════════════════

/** The SECOND authorization, exactly as `src/lib/fulfillment.ts` writes it: its
 *  atomic claim sets PENDING_APPROVAL + depositPaid:false and points the booking
 *  at the new intent. (Driven here rather than imported — fulfillment's fan-out
 *  needs Redis, and only the row it leaves behind matters to the approval.) */
function secondAuthorization(): void {
  Object.assign(db.booking, { status: 'PENDING_APPROVAL', depositPaid: false, stripePaymentIntentId: PI2 })
}

/** The customer reschedule, exactly as `app/api/customer/booking/[token]/route.ts`
 *  writes it: a new requestedDate and back to PENDING_APPROVAL. The $49 hold is
 *  NOT touched — "the customer never re-pays" — so the intent is unchanged and
 *  already captured. */
function rescheduleTo(newDate: Date): void {
  Object.assign(db.booking, {
    previousRequestedDate: db.booking.requestedDate,
    requestedDate: newDate,
    rescheduledAt: new Date('2027-08-20T15:00:00.000Z'),
    rescheduleCount: 1,
    status: 'PENDING_APPROVAL',
  })
}

const paymentsFor = (pi: string): Row[] => db.payments.filter((p) => p.stripePaymentIntentId === pi)

test('T1 harness check: with round 2\'s booking-scoped claim, a SECOND $49 is captured and never recorded', async () => {
  db = newDb(await createdRow())
  db.legacyBookingScopedClaim = true // the world before item T1
  await shippedDeps()
  assert.ok((await approve()).ok, 'precondition: the first approval is ordinary and healthy')
  assert.equal(paymentsFor(PI).length, 1)

  // The booking is authorized again (a second checkout), and the owner approves.
  secondAuthorization()
  const rec = await shippedDeps()
  const second = await approve()

  // THE DEFECT, as the verifier described it.
  assert.equal(rec.captures.length, 1, 'Stripe really did take the second $49')
  assert.equal(second.ok, false, 'THE DEFECT: the capture cannot be recorded')
  assert.equal(!second.ok && second.code, 'commit_failed')
  assert.equal(paymentsFor(PI2).length, 0, 'THE DEFECT: no Payment row for money Stripe is holding')
  assert.equal(paymentAudits().length, 1, 'THE DEFECT: one ledger row for two captures')
  assert.equal(rec.notified.length, 0, 'THE DEFECT: the customer who paid the second $49 is never told')
  assert.equal(rec.alerts.length, 1, 'and it is a money incident, correctly alerted')
})

test('T1: a SECOND payment intent gets its own claim, its own Payment row and its own confirmation', async () => {
  const m = await load()
  db = newDb(await createdRow())
  await shippedDeps()
  assert.ok((await approve()).ok)

  secondAuthorization()
  const rec = await shippedDeps()
  const second = await approve()

  assert.ok(second.ok, `the second capture must be recordable: ${!second.ok ? second.message : ''}`)
  assert.equal(second.ok && second.outcome, 'captured')
  assert.equal(second.ok && second.capturedCents, 4900)
  assert.equal(rec.captures.length, 1)
  assert.deepEqual(rec.captures[0], { pi: PI2, key: `capture:${PI2}` }, 'the idempotency key is still keyed to the intent')

  // One capture, one Payment row, one ledger row, one confirmation — EACH.
  assert.equal(paymentsFor(PI).length, 1, 'the first $49 is untouched')
  assert.equal(paymentsFor(PI2).length, 1, 'and the second $49 is recorded')
  assert.equal(paymentAudits().length, 2, 'two captures, two PAYMENT_RECEIVED rows')
  assert.deepEqual(
    paymentAudits().map((a) => a.id).sort(),
    [m.approval.approvalAuditId(BOOKING_ID, PI), m.approval.approvalAuditId(BOOKING_ID, PI2)].sort(),
    'each claim names its own money',
  )
  assert.equal(rec.notified.length, 1, 'the customer is told about the capture that just happened')
  assert.equal(rec.notified[0].intent, PI2, 'and the confirmation carries the intent it is about (its queue-id scope)')
  assert.equal(rec.alerts.length, 0, 'nothing here is a money incident any more')
})

test('T1: the repair path also recognises a second intent as unrecorded money', async () => {
  // The admin "Retry payment record" button and the Discord card both land in
  // convergeConfirmed. With the booking-scoped count it read "already recorded"
  // for a capture it had never seen, set skipAudit, and silenced the customer.
  db = newDb(await createdRow())
  await shippedDeps()
  await approve()

  // The second authorization's approval dies at the commit (the B1 incident,
  // now on the second intent): CONFIRMED, $49 at Stripe, nothing recorded.
  secondAuthorization()
  db.commitFailures = 99
  await shippedDeps()
  const failed = await approve()
  assert.equal(failed.ok, false)
  assert.equal(db.booking.status, 'CONFIRMED')

  db.commitFailures = 0
  const rec = await shippedDeps() // the owner presses "Retry payment record"
  const repaired = await approve()

  assert.ok(repaired.ok, `the repair must converge: ${!repaired.ok ? repaired.message : ''}`)
  assert.equal(repaired.ok && repaired.outcome, 'repaired')
  assert.equal(paymentsFor(PI2).length, 1, 'the missing Payment row IS written')
  assert.equal(paymentAudits().length, 2, 'and this capture gets its own ledger row')
  assert.equal(rec.notified.length, 1, 'and the customer finally hears about the $49 they paid')
  assert.equal(rec.captures.length, 0, 'nothing is captured twice')
})

test('T1 harness check: under round 2\'s RULE the same rescheduled booking gets total silence', async () => {
  // The reschedule regression has TWO halves and only one of them is the key.
  // `db.legacyBookingScopedClaim` restores the key; the OTHER half is round 2's
  // announcement RULE — "only the winner of the audit insert may speak" — which
  // lives in the shipped module and no fake can toggle. So this drives the same
  // rescheduled booking through a caller that holds NO status claim, which is
  // what EVERY caller was under that rule, and shows the harness observing the
  // silence the customer actually got. (The rule itself was mutation-tested by
  // deleting the `heldStatusClaim` announce and re-running the test below: it
  // goes red on `notified` 1 !== 0.)
  db = newDb(await createdRow())
  db.legacyBookingScopedClaim = true
  await shippedDeps()
  assert.ok((await approve()).ok, 'precondition: the move is approved for its original date')

  rescheduleTo(new Date('2027-10-05T13:00:00.000Z'))
  // No status claim to win: the row is already CONFIRMED when this caller
  // arrives, so it takes the repair path exactly as a losing racer does.
  db.booking.status = 'CONFIRMED'
  const rec = await shippedDeps()
  const again = await approve()

  assert.ok(again.ok, 'the owner sees a green result…')
  assert.equal(again.ok && again.outcome, 'already_confirmed')
  assert.equal(rec.notified.length, 0, 'THE DEFECT: …and the customer is never told the new date is confirmed')
  assert.equal(paymentAudits().length, 1, 'audits stay 1')
  assert.equal(db.payments.length, 1, 'and there is exactly one $49 to talk about')
})

test('T1: a rescheduled booking\'s re-approval tells the customer — without a second ledger row', async () => {
  // The portal reschedule keeps the SAME $49 hold, so the money claim MUST still
  // collide: one capture, one PAYMENT_RECEIVED row. What must not be swallowed
  // is the CONFIRMATION, and the caller that won the atomic PENDING_APPROVAL →
  // CONFIRMED update is the one caller entitled to send it.
  const newDate = new Date('2027-10-05T13:00:00.000Z')
  db = newDb(await createdRow())
  let rec = await shippedDeps()
  assert.ok((await approve()).ok)
  assert.equal(rec.notified.length, 1)
  const attemptsBefore = db.transactionAttempts

  rescheduleTo(newDate)
  rec = await shippedDeps()
  const again = await approve()

  assert.ok(again.ok, `the re-approval must not fail: ${!again.ok ? again.message : ''}`)
  assert.equal(db.booking.status, 'CONFIRMED', 'the new date is claimed')
  assert.equal(rec.notified.length, 1, 'THE FIX: the customer is told the new date is confirmed')
  assert.equal(rec.notified[0].cents, 4900, 'with the amount the DATABASE proves, not a default')
  assert.equal(rec.notified[0].intent, PI, 'about the hold that was actually captured')

  // …and the money is still recorded exactly once.
  assert.equal(db.payments.length, 1, 'one $49, one Payment row')
  assert.equal(paymentAudits().length, 1, 'one capture, one PAYMENT_RECEIVED row — a reschedule is not new money')
  assert.equal(again.ok && again.capturedCents, 4900)
  assert.equal(
    db.transactionAttempts - attemptsBefore,
    1,
    'the unique violation is still non-retryable — retrying it would only delay the answer',
  )
})

test('T1: the status claim, not the audit row, is what lets an ordinary approval speak', async () => {
  // The discriminator, from BOTH sides in one place. A caller holding the atomic
  // PENDING_APPROVAL → CONFIRMED claim announces even when the money was already
  // on the ledger (the reschedule above). A caller with NO status claim — the
  // repair path, where the row is already CONFIRMED — announces only if it won
  // the audit insert, which is the round-2 concurrency property.
  await driveIntoIncident()
  db.countBarrier = newBarrier(2)
  const rec = await shippedDeps()

  const results = await Promise.all([approve(), approve()])

  assert.equal(db.auditInsertAttempts, 2, 'both repairs raced to the insert — neither held a status claim')
  assert.equal(rec.notified.length, 1, 'and exactly one of them may speak')
  assert.ok(results.every((r) => r.ok))
})

test('T1: a prior approval of a DIFFERENT intent must not silence THIS one\'s repair', async () => {
  // The count-side twin of the key, exercised where the count actually runs —
  // the REPAIR path (the ordinary approval never consults it). Scoped to the
  // booking, `countApprovalAudits` answers "has this booking ever been
  // approved", so an older hold's row sets skipAudit and suppresses the
  // confirmation for a $49 that has no Payment row at all. Seeded WITHOUT the
  // deterministic id, so it is the COUNT being tested and not the primary key.
  await driveIntoIncident()
  db.audits.push({
    id: 'legacy_audit_from_an_earlier_hold',
    action: 'PAYMENT_RECEIVED',
    bookingId: BOOKING_ID,
    userId: 'u_diego',
    details: { event: 'approve_booking', source: 'discord', paymentIntentId: 'pi_from_a_previous_hold' },
  })
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the repair must record this booking's money: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.equal(paymentsFor(PI).length, 1, 'this capture has its own Payment row')
  assert.equal(paymentAudits().length, 2, 'and its own ledger row alongside the older hold\'s')
  assert.equal(rec.notified.length, 1, 'and the customer is told about the $49 that was actually taken')
})

// ════════════════════════════════════════════════════════════════════════════
//  3c. ITEM M2 — THE RESCHEDULE PATH ASKS STRIPE INSTEAD OF BLIND-CAPTURING
//
//  Round 3's reschedule repair (the T1 tests above) rested on a `capture()` fake
//  that returned `succeeded` unconditionally. Stripe's idempotency keys expire
//  after 24 HOURS, and this module's own comment says so: outside that window a
//  capture of an already-captured intent ERRORS instead of deduping. So a
//  reschedule approved MORE THAN A DAY after the original capture — the ordinary
//  case, since a reschedule is days of back-and-forth — threw, rolled the claim
//  back, and left the customer's new date unconfirmed over money Stripe already
//  had.
//
//  The fake now models the real contract (see `stripeCapture`), and the shipped
//  `approveBooking` asks `retrieveIntent` when the DATABASE proves this intent's
//  deposit was already captured.
// ════════════════════════════════════════════════════════════════════════════

test('M2 harness check: the capture fake ERRORS on an already-captured intent outside the 24h window', async () => {
  // Without this the tests below are theatre: a fake that cannot express the
  // failure cannot prove the fix. Both halves of Stripe's contract are pinned.
  db = newDb(await createdRow())
  const first = stripeCapture(PI, `capture:${PI}`)
  assert.equal((first as Row).status, 'succeeded')

  advanceHours(2)
  assert.deepEqual(
    stripeCapture(PI, `capture:${PI}`),
    first,
    'INSIDE the window the same key replays the original response — that half is real, and it is why this shipped',
  )

  advanceHours(23) // 25h after the capture: the key is gone
  assert.throws(
    () => stripeCapture(PI, `capture:${PI}`),
    /status of succeeded/,
    'OUTSIDE the window Stripe answers about the intent, and capture is not a legal transition from succeeded',
  )
})

test('M2: a reschedule approved DAYS later is confirmed — no blind capture, no lost customer', async () => {
  const newDate = new Date('2027-10-05T13:00:00.000Z')
  db = newDb(await createdRow())
  let rec = await shippedDeps()
  assert.ok((await approve()).ok, 'the original approval captures the $49')
  assert.equal(rec.captures.length, 1)
  assert.equal(paymentsFor(PI).length, 1)

  // Days of back-and-forth, then the customer moves their date and the owner
  // re-approves. Stripe's idempotency key for the original capture is long gone.
  advanceHours(72)
  rescheduleTo(newDate)
  rec = await shippedDeps()
  const again = await approve()

  assert.ok(again.ok, `THE M2 DEFECT: the re-approval threw a Stripe error and could never confirm — ${!again.ok ? again.message : ''}`)
  assert.equal(db.booking.status, 'CONFIRMED', 'the new date is claimed and STAYS claimed (the claim was rolled back before)')
  assert.equal(rec.captures.length, 0, 'nothing was captured a second time — the state was ASKED for, not assumed')
  assert.deepEqual(rec.intentReads, [PI], 'and asking Stripe is what replaced the blind capture')

  // The T1 guarantees, unchanged: one capture, one ledger row, and the customer
  // hears that the NEW date is confirmed.
  assert.equal(db.payments.length, 1, 'one $49, one Payment row')
  assert.equal(paymentAudits().length, 1, 'a reschedule is not new money')
  assert.equal(rec.notified.length, 1, 'the customer is told the new date is confirmed')
  assert.equal(rec.notified[0].cents, 4900, 'with the amount the DATABASE proves')
  assert.equal(rec.notified[0].intent, PI, 'about the hold that was actually captured')
  assert.equal(again.ok && again.capturedCents, 4900)
  assert.equal(rec.alerts.length, 0, 'and none of this is a money incident')
})

test('M2 (mutation): a caller that can only blind-capture reproduces the defect in full', async () => {
  // The pre-fix capability set, expressed through the deps the module actually
  // reads: no ledger lookup and no intent read, so the ONLY thing this caller
  // can do is capture. That is exactly what `approveBooking` did before this
  // item, and the fixed fake now shows what it costs.
  const m = await load()
  const newDate = new Date('2027-10-05T13:00:00.000Z')
  db = newDb(await createdRow())
  await shippedDeps()
  assert.ok((await approve()).ok)

  advanceHours(72)
  rescheduleTo(newDate)

  const rec = await shippedDeps()
  const blind = m.approval.defaultApprovalDeps()
  const store = { ...blind.store }
  delete (store as { findPaymentForIntent?: unknown }).findPaymentForIntent
  const res = await m.approval.approveBooking(
    { bookingId: BOOKING_ID, actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' }, source: 'admin' },
    { ...blind, store, stripe: { ...blind.stripe, retrieveIntent: undefined } },
  )

  assert.equal(res.ok, false, 'THE DEFECT: the re-approval fails outright')
  assert.equal(!res.ok && res.code, 'capture_failed')
  assert.match(!res.ok ? res.message : '', /status of succeeded/, 'and it fails on the capture Stripe refuses')
  assert.equal(rec.captures.length, 1, 'because it captured blind')
  assert.equal(db.booking.status, 'PENDING_APPROVAL', 'the claim is rolled back, so the new date is NOT confirmed')
  assert.equal(rec.notified.length, 0, 'and the customer who moved their move is never told')
})

test('M2: the ordinary first approval is untouched — no extra Stripe round-trip', async () => {
  db = newDb(await createdRow())
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'captured')
  assert.deepEqual(rec.captures, [{ pi: PI, key: `capture:${PI}` }], 'still exactly one capture, same idempotency key')
  assert.deepEqual(rec.intentReads, [], 'and no intent read: there is no recorded deposit to raise the question')
})

test('M2: a recorded deposit over an UNCAPTURED intent is still captured — Stripe is the authority', async () => {
  // The inverse mistake would be to trust the local row and skip a capture the
  // money needs. The ledger raises the QUESTION; Stripe answers it.
  const m = await load()
  db = newDb(await createdRow())
  db.payments.push({
    id: 'pay_stale',
    bookingId: BOOKING_ID,
    stripePaymentIntentId: PI,
    status: 'COMPLETED',
    amount: 4900,
    receiptUrl: null,
  })
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the deposit must still be taken: ${!res.ok ? res.message : ''}`)
  assert.deepEqual(rec.intentReads, [PI], 'the recorded row raised the question…')
  assert.deepEqual(rec.captures, [{ pi: PI, key: `capture:${PI}` }], '…and Stripe answering "not captured" is what took the money')
  assert.equal(db.stripeIntents.get(PI)?.captured, true)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1)
  assert.ok(m.approval.approvalAuditId(BOOKING_ID, PI))
})

test('M2: a capture Stripe refuses because it ALREADY has the money is recorded, not rolled back', async () => {
  // The B1-damaged reschedule: an earlier approval captured and its commit died,
  // so there is no Payment row to raise the question — the pre-capture check
  // cannot fire and the capture is refused. Rolling the claim back there would
  // hide a real capture behind a pending booking.
  db = newDb(await createdRow())
  stripeAlreadyCaptured(PI, 72 * 60 * 60 * 1000) // taken three days ago, nothing recorded
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok, `the money is at Stripe — this must converge, not fail: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.equal(rec.captures.length, 1, 'it did attempt the capture (no local evidence existed)')
  assert.equal(db.booking.status, 'CONFIRMED', 'and the claim was NOT rolled back over captured money')
  assert.equal(db.payments.length, 1, 'the missing Payment row is written')
  assert.equal(db.payments[0].amount, 4900, 'with the amount STRIPE reports')
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1, 'and the customer is told')
})

test('M2: a refused capture over a NON-COMPLETED payment record is never overwritten', async () => {
  // Stripe has the money and the local row says REFUNDED. Re-driving the commit
  // would stamp that row COMPLETED — a claim about money that would be false.
  db = newDb(await createdRow())
  stripeAlreadyCaptured(PI, 72 * 60 * 60 * 1000)
  db.payments.push({
    id: 'pay_refunded',
    bookingId: BOOKING_ID,
    stripePaymentIntentId: PI,
    status: 'REFUNDED',
    amount: 4900,
    receiptUrl: null,
  })
  const rec = await shippedDeps()

  const res = await approve()

  assert.equal(res.ok, false, 'a refunded deposit is not an approvable capture')
  assert.equal(!res.ok && res.code, 'capture_failed')
  assert.match(!res.ok ? res.message : '', /REFUNDED/, 'and the owner is told exactly what the record says')
  assert.equal(db.payments[0].status, 'REFUNDED', 'THE POINT: the refund record is untouched')
  assert.equal(paymentAudits().length, 0, 'no ledger row is written for money that came back')
  assert.equal(rec.notified.length, 0, 'and nobody is told a refunded booking is confirmed')
  assert.equal(db.booking.status, 'PENDING_APPROVAL', 'the booking goes back to pending for a human to decide')
})

// ════════════════════════════════════════════════════════════════════════════
//  4. R1 — DETERMINISTIC QUEUE IDS: a duplicated handoff collapses in the queue
// ════════════════════════════════════════════════════════════════════════════

test('R1: the approval fan-out uses deterministic, BullMQ-safe job ids', async () => {
  const { approvalEmailJobId, approvalSmsJobId } = (await load()).approval
  const day = new Date('2027-09-14T13:00:00.000Z')

  assert.equal(approvalEmailJobId('bk_1', PI, day), approvalEmailJobId('bk_1', PI, day), 'the id IS the dedupe key — it must be stable')
  assert.equal(approvalSmsJobId('bk_1', PI, day), approvalSmsJobId('bk_1', PI, day))
  assert.notEqual(approvalEmailJobId('bk_1', PI, day), approvalEmailJobId('bk_2', PI, day), 'two bookings must not share a job id')
  assert.notEqual(approvalSmsJobId('bk_1', PI, day), approvalSmsJobId('bk_2', PI, day))
  assert.notEqual(approvalEmailJobId('bk_1', PI, day), approvalSmsJobId('bk_1', PI, day), 'the email and the SMS are different jobs')
  for (const id of [approvalEmailJobId('bk_1', PI, day), approvalSmsJobId('bk_1', PI, day)]) {
    assert.ok(!id.includes(':'), `BullMQ rejects a custom id containing ":" — got ${id}`)
    assert.ok(id.includes('bk_1'), 'the booking id must be part of the key')
  }
})

test('T1: a job id names the ANNOUNCEMENT — booking, money and the date it states', async () => {
  // A booking-scoped id is a PERMANENT claim in Redis (`removeOnComplete:
  // {count: 500}` keeps a completed job for weeks at this volume), so it does
  // not merely dedupe a duplicate — it deletes every later confirmation for the
  // same booking. Both of the messages item T1 exists to deliver are "later
  // confirmations for the same booking".
  const { approvalEmailJobId, approvalSmsJobId } = (await load()).approval
  const day = new Date('2027-09-14T13:00:00.000Z')
  const newDay = new Date('2027-10-05T13:00:00.000Z')

  for (const build of [approvalEmailJobId, approvalSmsJobId]) {
    assert.notEqual(
      build('bk_1', 'pi_a', day),
      build('bk_1', 'pi_b', day),
      'a SECOND $49 capture is a different confirmation — it must not collide with the first',
    )
    assert.notEqual(
      build('bk_1', 'pi_a', day),
      build('bk_1', 'pi_a', newDay),
      'a rescheduled move date is a different confirmation — it must not collide with the original',
    )
    // …and everything the dedupe was built for still collapses.
    assert.equal(build('bk_1', 'pi_a', day), build('bk_1', 'pi_a', new Date(day)), 'a re-driven enqueue of the SAME message still collapses')
    assert.equal(build('bk_1', null, null), build('bk_1', null, null), 'the unknown-money/unknown-date key is still stable')
    for (const id of [build('bk_1', 'pi_a', day), build('bk_1', null, null)]) {
      assert.ok(!id.includes(':'), `BullMQ rejects a custom id containing ":" — got ${id}`)
    }
  }
})

test('R1: both approval enqueues actually PASS those ids', () => {
  // The builders are worthless if the call sites do not use them, and the
  // enqueue itself needs Redis, so this is checked against the source with
  // comments stripped (a comment must not satisfy a rule about code).
  const src = code('src/lib/booking-approval.ts')
  const email = src.indexOf("emailQueue.add('final-confirmation'")
  const sms = src.indexOf("smsQueue.add('pre-approval-sms'")
  assert.ok(email > -1, 'the approval confirmation enqueue is gone')
  assert.ok(sms > -1, 'the approval SMS enqueue is gone')
  // ITEM T1 — the id must carry the money and the date, not just the booking:
  // a call site that passed `booking.id` alone would rebuild the permanent key.
  assert.match(
    src.slice(email, sms),
    /jobId:\s*approvalEmailJobId\(booking\.id,\s*paymentIntentId,\s*when\)/,
    'the confirmation email needs a deterministic id keyed to booking + intent + date',
  )
  assert.match(
    src.slice(sms),
    /jobId:\s*approvalSmsJobId\(booking\.id,\s*paymentIntentId,\s*when\)/,
    'the confirmation SMS needs a deterministic id keyed to booking + intent + date',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  5. R1 — THE HAPPY PATH AND THE ORDINARY REPLAY ARE UNCHANGED
// ════════════════════════════════════════════════════════════════════════════

test('R1: the ordinary approval still captures once, records once and tells the customer once', async () => {
  db = newDb(await createdRow())
  const rec = await shippedDeps()

  const res = await approve()

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'captured')
  assert.equal(res.ok && res.capturedCents, 4900)
  assert.equal(rec.captures.length, 1)
  assert.deepEqual(rec.captures[0], { pi: PI, key: `capture:${PI}` }, 'the idempotency key is unchanged')
  assert.equal(db.transactionAttempts, 1)
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1)
  assert.equal(rec.alerts.length, 0)
})

test('R1: a healthy replay after a completed approval is silent and still truthful', async () => {
  db = newDb(await createdRow())
  await shippedDeps()
  await approve()

  const rec = await shippedDeps()
  const again = await approve()

  assert.ok(again.ok)
  assert.equal(again.ok && again.outcome, 'already_confirmed')
  assert.equal(again.ok && again.capturedCents, 4900, 'the amount comes from the Payment row, never a default')
  assert.equal(rec.captures.length, 0)
  assert.equal(rec.intentReads.length, 0, 'a recorded payment needs no Stripe round-trip')
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  6. R2 — THE RETRY THE OWNER IS TOLD TO PERFORM EXISTS WHERE THEY ARE
// ════════════════════════════════════════════════════════════════════════════

const ROOT = process.cwd()

/** Source with comments stripped — a rule about CODE must not be satisfied by
 *  prose that merely mentions the same identifier. */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('R2: the admin message names the button that exists on the admin surface', async () => {
  const m = await load()
  await driveIntoIncident()
  db.commitFailures = 99
  await shippedDeps()

  const res = await approve('admin')

  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.code, 'commit_failed')
  const message = !res.ok ? res.message : ''
  assert.match(message, /WAS captured/i, 'the owner is still told the money moved')
  assert.match(message, /do NOT charge the customer again/i)
  assert.match(message, new RegExp(m.approval.ADMIN_RETRY_ACTION_LABEL), 'it must name the admin action by its label')
  assert.ok(
    !/Click Approve again/i.test(message),
    'the admin has no "Approve" on a CONFIRMED booking — naming it is the R2 defect',
  )

  // …and that label is really rendered by the admin component the owner is
  // looking at. The client component cannot import the constant (Prisma/Stripe
  // must not reach the browser bundle), so the two copies are pinned here.
  const actions = code('app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx')
  assert.ok(
    actions.includes(m.approval.ADMIN_RETRY_ACTION_LABEL),
    `BookingActions.tsx must render a control labelled "${m.approval.ADMIN_RETRY_ACTION_LABEL}"`,
  )
  const confirmedBlock = /CONFIRMED:\s*\[([\s\S]*?)\n\s{2}\],/.exec(actions)
  assert.ok(confirmedBlock, 'BookingActions must still describe a CONFIRMED booking')
  assert.match(confirmedBlock![1], /retry_approval/, 'the retry action must be offered on a CONFIRMED booking — that is the incident state')
})

test('R2: the Discord message names Approve, not a button that is not there', async () => {
  const m = await load()
  await driveIntoIncident()
  db.commitFailures = 99
  await shippedDeps()

  const res = await approve('discord')

  assert.equal(res.ok, false)
  const message = !res.ok ? res.message : ''
  assert.match(message, /Approve/, 'the Discord card DOES have an Approve button')
  assert.ok(
    !message.includes(m.approval.ADMIN_RETRY_ACTION_LABEL),
    'a Discord reader cannot see the admin workspace button',
  )
})

test('R2: checkRetryApproval admits the incident state and nothing else', async () => {
  const { checkRetryApproval } = (await load()).approval

  assert.equal(checkRetryApproval('CONFIRMED').ok, true, 'CONFIRMED is the state a B1 incident leaves behind')

  const pending = checkRetryApproval('PENDING_APPROVAL')
  assert.equal(pending.ok, false, 'a button labelled "retry" must never be the thing that first captures $49')
  assert.match(!pending.ok ? pending.message : '', /Confirm booking/, 'and it must point at the action that does')

  for (const status of ['SCHEDULED', 'CANCELLED', 'COMPLETED', 'PENDING_PAYMENT', 'DRAFT']) {
    const g = checkRetryApproval(status)
    assert.equal(g.ok, false, `${status} has nothing for this action to finish`)
    assert.match(!g.ok ? g.message : '', new RegExp(status))
  }
})

test('R2: the admin route reaches the convergence path BEFORE the transition table', () => {
  const route = code('app/api/admin/bookings/[id]/status/route.ts')

  // The transition table is NOT weakened for ordinary status changes.
  const confirmedRow = /\bCONFIRMED:\s*\[([^\]]*)\]/.exec(route)
  assert.ok(confirmedRow, 'VALID_TRANSITIONS must still describe a confirmed booking')
  assert.match(confirmedRow![1], /'SCHEDULED'/)
  assert.match(confirmedRow![1], /'CANCELLED'/)
  assert.ok(!/'CONFIRMED'/.test(confirmedRow![1]), 'a CONFIRMED→CONFIRMED edge would weaken the table — the fix is a named action, not a transition')

  // The named action exists, is permission-gated, and runs the convergence.
  const branch = route.indexOf("'action' in parsed.data")
  assert.ok(branch > -1, 'the retry action branch is gone — the repair is unreachable again')
  assert.match(
    route,
    /\n\s*if \('action' in parsed\.data\) \{/,
    'the branch must be entered on the request shape alone — a constant folded into that condition disables the repair as surely as deleting it',
  )
  const body = route.slice(branch, branch + 1400)
  assert.match(body, /can\(\s*session\.role[^,]*,\s*'booking\.approve'\s*\)/, 'the repair must be permission-gated (booking.approve is OWNER-only)')
  assert.match(body, /checkRetryApproval\(booking\.status\)/, 'it must refuse a state the convergence cannot answer for')
  assert.match(body, /approveBooking\(/, 'and it must actually call the convergence path')

  // ORDERING IS THE WHOLE DEFECT: the 422 fired first and swallowed the repair.
  const table = route.indexOf('allowed.includes(newStatus)')
  assert.ok(table > -1, 'the transition guard must still exist')
  assert.ok(branch < table, 'the retry action must be handled BEFORE the VALID_TRANSITIONS 422 — that 422 is what made it unreachable')

  // …and nothing ELSE may refuse first either. Only the request-shape check may
  // precede the repair branch; a transition guard reintroduced above it (under
  // any name) is the R2 defect back again.
  const parseGuardEnd = route.indexOf('\n', route.indexOf('if (!parsed.success)'))
  assert.ok(parseGuardEnd > -1, 'the request-shape guard must still exist')
  const between = route.slice(parseGuardEnd, branch)
  assert.ok(!/VALID_TRANSITIONS/.test(between), 'the transition table must not be consulted before the repair branch')
  assert.ok(!/status:\s*422/.test(between), 'no 422 may fire between parsing the request and handling the repair action')

  // The action is a literal, so a typo'd verb is a 422, not a status change.
  assert.match(route, /z\.literal\('retry_approval'\)/)
})

test('R2: the admin component posts the named action, not a status change', () => {
  const actions = code('app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx')
  assert.match(actions, /action:\s*'retry_approval'/, 'the button must carry the named action')
  assert.match(
    actions,
    /a\.action\s*\?\s*\{\s*action:\s*a\.action\s*\}\s*:\s*\{\s*status:\s*a\.next\s*\}/,
    'the request body must be the ACTION for a repair and a STATUS for a transition',
  )
  assert.match(actions, /canApprove/, 'the repair button must be hidden from a user who cannot approve')
})

test('R2: the retry action routes to the SAME convergence that repairs the money', async () => {
  // The functional half of the ordering guard above: what the route calls, with
  // the booking in the state the button is offered on.
  await driveIntoIncident()
  assert.equal(db.booking.status, 'CONFIRMED', 'the button is offered on exactly this state')
  const rec = await shippedDeps()

  const res = await approve('admin') // what the route's retry branch invokes

  assert.ok(res.ok, `the repair must converge: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.equal(db.payments.length, 1)
  assert.equal(paymentAudits().length, 1)
  assert.equal(rec.notified.length, 1, 'the customer finally gets the confirmation they paid for')
  assert.equal(rec.captures.length, 0, 'nothing is captured twice')
})

test('R2: the owner message prints no amount the result cannot prove', async () => {
  const m = await load()
  const booking = { id: BOOKING_ID } as never

  assert.match(
    m.approval.retryApprovalMessage({ ok: true, outcome: 'repaired', booking, capturedCents: 4900, receiptUrl: null }),
    /\$49\.00/,
  )
  assert.match(
    m.approval.retryApprovalMessage({ ok: true, outcome: 'already_confirmed', booking, capturedCents: 4900, receiptUrl: null }),
    /Nothing to repair/,
  )
  for (const outcome of ['repaired', 'already_confirmed'] as const) {
    const text = m.approval.retryApprovalMessage({ ok: true, outcome, booking, capturedCents: null, receiptUrl: null })
    assert.ok(!/\$/.test(text), `an unproven amount must never be printed — got: ${text}`)
    assert.ok(!/captured/i.test(text), `and no capture may be claimed — got: ${text}`)
  }
})
