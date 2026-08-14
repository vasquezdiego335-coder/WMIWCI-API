// ════════════════════════════════════════════════════════════════════════════
//  staffing-repair-triggers.test.ts — ITEM R3-5
//
//  THE DEFECT: `ensureStaffingRequirement` is create-if-missing, so re-running
//  it REPAIRS a job whose approval-time staffing write failed (a transient DB
//  error, or the code-before-SQL window of item R3-2). Round 2 wired that repair
//  to the already-confirmed approval REPLAY — and no production surface can
//  reach a replay:
//     • the admin status route's VALID_TRANSITIONS has no CONFIRMED→CONFIRMED,
//     • the admin UI offers only "Mark scheduled" and "Cancel" on a confirmed
//       booking,
//     • Discord's /approve refuses a non-PENDING_APPROVAL booking,
//     • the Approve button is removed after a successful approval.
//  So a job that lost its requirement stayed unstaffed FOREVER: dispatch could
//  never fire UNDERSTAFFED or MISSING_DRIVER on it.
//
//  THE FIX UNDER TEST: the repair rides two things the owner already does —
//  CONFIRMED → SCHEDULED (the admin status route) and the first crew assignment
//  (POST /api/admin/jobs/[id]/crew) — both of which call
//  `labor-service.ensureJobForBooking`, which now ensures the staffing
//  requirement as well as the Job.
//
//  HOW THIS FILE TESTS IT (round-3 rule: the row the SHIPPED WRITER persists):
//    • the booking row comes from `resolveMoveSchedule` → `buildBookingCreateData`
//      on the DEFAULT owner path (`stripe_link`, day-level), not from a fixture
//      that invents columns production never writes;
//    • the SHIPPED `ensureJobForBooking` runs against a fake `prisma` installed
//      on globalThis before src/lib/db.ts is first imported, so the whole spine
//      (booking read ladder → derived plan → create-if-missing ensure) is the
//      production one;
//    • a source guard pins the two owner surfaces that must reach it, because
//      "the code is correct but nothing calls it" is the defect itself.
//
//  Offline: no database, no Stripe, no Redis. Run:
//    npx tsx --test src/lib/__tests__/staffing-repair-triggers.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>

const NEW_COLUMNS = ['staffingPlan', 'startTimeKnown'] as const

type FakeDb = {
  /** Booking columns the DATABASE does not have yet. */
  missing: readonly string[]
  booking: Row
  bookingSelects: Array<Record<string, unknown> | undefined>
  /** bookingId → jobId. Empty = the booking was never approved. */
  jobs: Map<string, string>
  jobCreates: number
  requirements: Map<string, Row>
  calls: { find: number; create: number; update: number }
  audits: Row[]
  /** Make every JobStaffingRequirement access fail (unapplied table). */
  requirementError?: Error
}

function newDb(booking: Row, opts: { missing?: readonly string[]; job?: string } = {}): FakeDb {
  const missing = opts.missing ?? []
  const row = { ...booking }
  missing.forEach((col) => delete row[col])
  const jobs = new Map<string, string>()
  if (opts.job) jobs.set(row.id as string, opts.job)
  return {
    missing,
    booking: row,
    bookingSelects: [],
    jobs,
    jobCreates: 0,
    requirements: new Map(),
    calls: { find: 0, create: 0, update: 0 },
    audits: [],
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

function project(row: Row, select: Record<string, unknown> | undefined, missing: readonly string[]): Row {
  if (!select) {
    if (missing.length > 0) throw p2022(missing[0])
    return { ...row }
  }
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) {
    if (missing.indexOf(key) > -1) throw p2022(key)
    if (val) out[key] = row[key] ?? null
  }
  return out
}

const fakePrisma = {
  booking: {
    async findUnique(args: { where: { id?: string }; select?: Record<string, unknown> }): Promise<Row | null> {
      db.bookingSelects.push(args.select)
      if (args.where.id !== db.booking.id) return null
      return project(db.booking, args.select, db.missing)
    },
  },
  job: {
    async findUnique(args: { where: { bookingId?: string } }): Promise<Row | null> {
      const id = args.where.bookingId ? db.jobs.get(args.where.bookingId) : null
      return id ? { id } : null
    },
    async upsert(args: { where: { bookingId: string }; create: Row }): Promise<Row> {
      const existing = db.jobs.get(args.where.bookingId)
      if (existing) return { id: existing, createdAt: new Date() }
      const id = `job_${db.jobs.size + 1}`
      db.jobs.set(args.where.bookingId, id)
      db.jobCreates++
      return { id, createdAt: new Date(), ...args.create }
    },
  },
  auditLog: {
    async count(args: { where: { bookingId: string; action: string } }): Promise<number> {
      return db.audits.filter((a) => a.bookingId === args.where.bookingId && a.action === args.where.action).length
    },
    async create(args: { data: Row }): Promise<Row> {
      db.audits.push(args.data)
      return args.data
    },
  },
  jobStaffingRequirement: {
    async findUnique(args: { where: { jobId: string } }): Promise<Row | null> {
      if (db.requirementError) throw db.requirementError
      db.calls.find++
      return db.requirements.get(args.where.jobId) ?? null
    },
    async create(args: { data: Row & { jobId: string } }): Promise<Row> {
      if (db.requirementError) throw db.requirementError
      db.calls.create++
      db.requirements.set(args.data.jobId, { ...args.data })
      return args.data
    },
    async update(args: { where: { jobId: string }; data: Row }): Promise<Row> {
      if (db.requirementError) throw db.requirementError
      db.calls.update++
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

// ── Modules under test (dynamic — the fake must exist before db.ts loads) ────

type Mods = {
  labor: typeof import('../labor-service')
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  scheduling: typeof import('../scheduling')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    labor: await import('../labor-service'),
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    scheduling: await import('../scheduling'),
  }
  const dbModule = await import('../db')
  assert.equal(dbModule.prisma as unknown, fakePrisma, 'the shipped modules must be using the fake client')
  return mods
}

// ── The row the SHIPPED WRITER persists ─────────────────────────────────────

async function confirmedBookingRow(): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: '2027-07-15',
      // No crew start time: the DEFAULT day-level booking.
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
      originStairFlights: 2,
    },
    services: { serviceMode: 'full_service', needsPacking: true },
    inventory: [],
    deposit: { mode: 'stripe_link' },
    pricing: { ownerTotal: 700, overrideReason: 'phone quote' },
  })
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  const input = parsed.data
  const schedule = m.adminBooking.resolveMoveSchedule(input.move, {
    estimatedHours: 4,
    helpers: { toInstant: m.scheduling.etDateTimeToInstant, endTime: m.scheduling.calculateEndTime },
  })
  const data = m.adminBooking.buildBookingCreateData(
    input,
    {
      estimate: m.estimate.computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1001',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate!,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  // …then the $49 hold is captured and the booking confirmed for the DATE
  // (item R2-1: a day-level booking never acquires a start time).
  return {
    id: 'bk_repair',
    truck: null,
    inventoryItems: [],
    ...(data as Row),
    status: 'CONFIRMED',
    depositPaid: true,
    confirmedDate: schedule.requestedDate,
    scheduledStart: null,
    scheduledEnd: null,
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  1. THE GUARANTEE — the owner's normal actions repair an unstaffed job
// ════════════════════════════════════════════════════════════════════════════

test('R3-5: marking a confirmed move SCHEDULED staffs a job whose approval-time ensure failed', async () => {
  const m = await load()
  // The exact wreckage a failed ensure leaves: booking CONFIRMED, $49 captured,
  // Job row created by commitApproval — and NO staffing requirement.
  db = newDb(await confirmedBookingRow(), { job: 'job_1' })
  assert.equal(db.requirements.size, 0, 'precondition: the job is unstaffed')

  // What the admin status route does on CONFIRMED → SCHEDULED.
  const jobId = await m.labor.ensureJobForBooking('bk_repair', { source: 'status_scheduled', userId: 'u_diego' })

  assert.equal(jobId, 'job_1', 'the existing job is reused, never duplicated')
  assert.equal(db.requirements.size, 1, 'the repair must create the missing requirement')
  const req = db.requirements.get('job_1')!
  assert.ok((req.requiredWorkers as number) >= 2, 'a real crew size, derived from the booking')
  assert.equal(req.createdById, 'u_diego', 'the owner who triggered the repair is recorded')
  assert.equal(db.calls.create, 1)
  assert.equal(db.calls.update, 0)
  // A day-level booking still gets NO invented crew hour (item R2-1 holds here).
  assert.equal(req.estimatedStartAt, null)
  // The booking's own access columns reached the requirement — a derived plan,
  // not a placeholder.
  assert.equal(req.hasStairs, true)
  assert.equal(req.packing, true)
  // No second JOB_CREATED audit for a job that already existed.
  assert.equal(db.audits.length, 0)
})

test('R3-5: the FIRST crew assignment repairs it too (the other owner surface)', async () => {
  const m = await load()
  db = newDb(await confirmedBookingRow(), { job: 'job_1' })

  // POST /api/admin/jobs/[id]/crew calls this with no audit context.
  const jobId = await m.labor.ensureJobForBooking('bk_repair')

  assert.equal(jobId, 'job_1')
  assert.equal(db.requirements.size, 1, 'assigning a mover must not leave the job unstaffed')
  assert.equal(db.requirements.get('job_1')!.createdById, null)
})

test('R3-5: crew assigned BEFORE approval creates the job AND its requirement', async () => {
  const m = await load()
  db = newDb(await confirmedBookingRow()) // no Job row at all yet

  const jobId = await m.labor.ensureJobForBooking('bk_repair', { source: 'crew_assignment', userId: 'u_diego' })

  assert.equal(db.jobCreates, 1)
  assert.equal(db.requirements.size, 1)
  assert.equal(db.requirements.get(jobId)!.jobId, jobId)
  // The Job creation is still audited exactly once (Stage-4 behaviour intact).
  assert.equal(db.audits.filter((a) => a.action === 'JOB_CREATED').length, 1)
})

// ════════════════════════════════════════════════════════════════════════════
//  2. Idempotent + create-if-missing — the owner's judgement outranks the plan
// ════════════════════════════════════════════════════════════════════════════

test('R3-5: repeating the trigger changes nothing (exactly one row)', async () => {
  const m = await load()
  db = newDb(await confirmedBookingRow(), { job: 'job_1' })

  await m.labor.ensureJobForBooking('bk_repair', { source: 'status_scheduled' })
  const created = { ...db.requirements.get('job_1')! }
  await m.labor.ensureJobForBooking('bk_repair', { source: 'status_scheduled' })
  await m.labor.ensureJobForBooking('bk_repair', { source: 'crew_assignment' })

  assert.equal(db.requirements.size, 1)
  assert.equal(db.calls.create, 1, 'create-if-missing: never a second create')
  assert.equal(db.calls.update, 0, 'nothing is rewritten on a replay')
  assert.deepEqual(db.requirements.get('job_1'), created)
})

test('R3-5: an owner-tuned requirement is never overwritten by the repair', async () => {
  const m = await load()
  db = newDb(await confirmedBookingRow(), { job: 'job_1' })
  // The owner hand-tuned this through PATCH /api/admin/jobs/[id]/staffing.
  db.requirements.set('job_1', {
    jobId: 'job_1',
    requiredWorkers: 5,
    minWorkers: 4,
    requiredDrivers: 2,
    workerInstructions: 'Diego drives the box truck',
    estimatedStartAt: new Date('2027-07-15T13:00:00.000Z'),
    estimatedEndAt: new Date('2027-07-15T18:00:00.000Z'),
  })

  await m.labor.ensureJobForBooking('bk_repair', { source: 'status_scheduled', userId: 'u_diego' })

  const req = db.requirements.get('job_1')!
  assert.equal(req.requiredWorkers, 5, "the owner's crew size stands")
  assert.equal(req.requiredDrivers, 2)
  assert.equal(req.workerInstructions, 'Diego drives the box truck')
  assert.equal(db.calls.create, 0)
  assert.equal(db.calls.update, 0, 'nothing was null, so nothing was even filled')
})

// ════════════════════════════════════════════════════════════════════════════
//  3. Fail-soft — the owner's actual action always stands
// ════════════════════════════════════════════════════════════════════════════

test('R3-5: a staffing failure never breaks the status change or the assignment', async () => {
  const m = await load()
  db = newDb(await confirmedBookingRow(), { job: 'job_1' })
  db.requirementError = Object.assign(
    new Error('The table `public.job_staffing_requirements` does not exist in the current database.'),
    { code: 'P2021' },
  )

  const jobId = await m.labor.ensureJobForBooking('bk_repair', { source: 'status_scheduled', userId: 'u_diego' })
  assert.equal(jobId, 'job_1', 'the owner action must still succeed — a dispatch gap is not a 500')
  assert.equal(db.requirements.size, 0)
})

test('R3-5: the deploy window degrades the repair, it does not cancel it', async () => {
  const m = await load()
  // Same code-before-SQL state as item R3-2: the new booking columns are not in
  // the database yet, so the owner's captured plan cannot be read.
  db = newDb(await confirmedBookingRow(), { job: 'job_1', missing: NEW_COLUMNS })

  await m.labor.ensureJobForBooking('bk_repair', { source: 'status_scheduled' })

  assert.equal(db.requirements.size, 1, 'the DERIVED plan needs none of the new columns')
  assert.ok((db.requirements.get('job_1')!.requiredWorkers as number) >= 2)
  // The ladder ran: full select first, then the pre-migration one.
  const withNew = db.bookingSelects.filter((s) => s && 'staffingPlan' in s)
  const withoutNew = db.bookingSelects.filter((s) => s && !('staffingPlan' in s))
  assert.equal(withNew.length, 1)
  assert.equal(withoutNew.length, 1)
})

// ════════════════════════════════════════════════════════════════════════════
//  4. REACHABILITY — the whole point of item R3-5
// ════════════════════════════════════════════════════════════════════════════

const ROOT = process.cwd()

/** Comments stripped: a comment claiming the trigger exists must not pass. */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('R3-5: the repair is reachable from the surfaces the owner actually uses', () => {
  const statusRoute = code('app/api/admin/bookings/[id]/status/route.ts')
  const crewRoute = code('app/api/admin/jobs/[id]/crew/route.ts')

  // 1. CONFIRMED → SCHEDULED must be a legal transition at all (the round-2
  //    repair sat behind CONFIRMED → CONFIRMED, which is NOT in this table).
  const confirmedRow = /\bCONFIRMED:\s*\[([^\]]*)\]/.exec(statusRoute)
  assert.ok(confirmedRow, 'VALID_TRANSITIONS must still describe a confirmed booking')
  assert.match(confirmedRow![1], /'SCHEDULED'/)

  // 2. …and that branch must call the repair.
  const branch = statusRoute.indexOf("booking.status === 'CONFIRMED' && newStatus === 'SCHEDULED'")
  assert.ok(branch > -1, 'the CONFIRMED→SCHEDULED branch is gone — the repair has no trigger')
  assert.match(
    statusRoute.slice(branch, branch + 400),
    /ensureJobForBooking\(/,
    'marking a move scheduled must run the staffing ensure',
  )

  // 3. The crew route reaches it on assignment.
  assert.match(crewRoute, /ensureJobForBooking\(/, 'assigning crew must run through the ensure')

  // 4. Neither trigger may be fatal to the owner's action.
  assert.match(statusRoute.slice(branch, branch + 400), /\.catch\(/)
})
