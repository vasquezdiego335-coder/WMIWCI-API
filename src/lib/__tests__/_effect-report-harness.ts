// ════════════════════════════════════════════════════════════════════════════
//  _effect-report-harness.ts — the fake database the D3 effect-report tests run
//  the SHIPPED lifecycle service, followups.ts and journeys.ts against.
//
//  NOT A TEST FILE (same class as `_journeys-env.ts`): it is imported by two
//  test files that must load `followups.ts` / `journeys.ts` under DIFFERENT
//  environments — the shipped default (both flags off) and the flags-on case —
//  and a module-level `const ENABLED = process.env...` can only be read once per
//  process, so those two cases cannot share a file.
//
//  WHAT THE FAKE MODELS HONESTLY (a fake that cannot express these cannot prove
//  anything about them):
//   • `$transaction` is ATOMIC — a throw inside restores the snapshot, which is
//     what makes "a P2002 on the audit id rolled the remediation back" a fact
//     this harness can SEE rather than a claim.
//   • `auditLog.create` enforces the PRIMARY KEY, so a deterministic id really
//     is a claim and a second insert really is P2002.
//   • `updateMany` evaluates its `where` against current rows, so a conditional
//     claim can really match zero.
//  Offline: no database, no Redis, no network.
// ════════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict'

export type Row = Record<string, unknown>

export type Db = {
  bookings: Map<string, Row>
  customers: Map<string, Row>
  /** keyed by Job.bookingId (@unique) */
  jobs: Map<string, Row>
  /** keyed by JobCrew.id */
  jobCrew: Map<string, Row>
  /** keyed by AuditLog.id — the PRIMARY KEY, enforced */
  audits: Map<string, Row>
  /** Ordered log of every write statement. */
  writes: string[]
  /** Throw the next time this statement runs. */
  failOn?: { op: string; error: Error }
  /** Run this immediately before the named statement (used to open a race). */
  before?: { op: string; run: () => void }
}

let db: Db = emptyDb()

function emptyDb(): Db {
  return {
    bookings: new Map(),
    customers: new Map(),
    jobs: new Map(),
    jobCrew: new Map(),
    audits: new Map(),
    writes: [],
  }
}

export const theDb = (): Db => db
export const resetDb = (): Db => (db = emptyDb())

const clone = (m: Map<string, Row>): Map<string, Row> => new Map(Array.from(m.entries()).map(([k, v]) => [k, { ...v }]))

type Tables = Pick<Db, 'bookings' | 'customers' | 'jobs' | 'jobCrew' | 'audits'>

function snapshot(): Tables {
  return {
    bookings: clone(db.bookings),
    customers: clone(db.customers),
    jobs: clone(db.jobs),
    jobCrew: clone(db.jobCrew),
    audits: clone(db.audits),
  }
}

function restore(s: Tables): void {
  db.bookings = s.bookings
  db.customers = s.customers
  db.jobs = s.jobs
  db.jobCrew = s.jobCrew
  db.audits = s.audits
}

function stmt(op: string): void {
  db.writes.push(op)
  if (db.before && db.before.op === op) {
    const run = db.before.run
    db.before = undefined
    run()
  }
  if (db.failOn && db.failOn.op === op) {
    const err = db.failOn.error
    db.failOn = undefined
    throw err
  }
}

/** Prisma-style `where`, limited to the operators this code actually uses. */
function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key] ?? null
    if (cond === null) {
      if (value !== null) return false
      continue
    }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row
      if ('in' in c && !(c.in as unknown[]).includes(value as never)) return false
      if ('notIn' in c && (c.notIn as unknown[]).includes(value as never)) return false
      continue
    }
    if (value instanceof Date && cond instanceof Date) {
      if (value.getTime() !== cond.getTime()) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

function pick(row: Row, select: Row): Row {
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) if (val) out[key] = row[key] ?? null
  return out
}

function projectBooking(row: Row, select?: Row): Row {
  if (!select) return { ...row }
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) {
    if (!val) continue
    if (key === 'customer' && typeof val === 'object') {
      const cust = db.customers.get(String(row.customerId)) ?? null
      const sub = (val as Row).select as Row | undefined
      out.customer = cust ? (sub ? pick(cust, sub) : { ...cust }) : null
      continue
    }
    if (key === 'job' && typeof val === 'object') {
      const job = db.jobs.get(String(row.id)) ?? null
      const sub = (val as Row).select as Row | undefined
      out.job = job ? (sub ? pick(job, sub) : { ...job }) : null
      continue
    }
    out[key] = row[key] ?? null
  }
  return out
}

const fakePrisma: Row = {
  booking: {
    async findUnique(args: { where: { id: string }; select?: Row }): Promise<Row | null> {
      const row = db.bookings.get(args.where.id)
      return row ? projectBooking(row, args.select) : null
    },
    async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
      stmt('booking.updateMany')
      let count = 0
      for (const row of Array.from(db.bookings.values())) {
        if (!matches(row, args.where)) continue
        Object.assign(row, args.data)
        count++
      }
      return { count }
    },
  },
  job: {
    async upsert(args: { where: { bookingId: string }; update: Row; create: Row }): Promise<Row> {
      stmt('job.upsert')
      const existing = db.jobs.get(args.where.bookingId)
      if (existing) {
        Object.assign(existing, args.update)
        return { ...existing }
      }
      const created: Row = { id: `job_${db.jobs.size + 1}`, ...args.create }
      db.jobs.set(args.where.bookingId, created)
      return { ...created }
    },
    async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
      stmt('job.updateMany')
      let count = 0
      for (const [bookingId, row] of Array.from(db.jobs.entries())) {
        if (!matches({ ...row, bookingId }, args.where)) continue
        Object.assign(row, args.data)
        count++
      }
      return { count }
    },
  },
  jobCrew: {
    async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
      stmt('jobCrew.updateMany')
      let count = 0
      for (const row of Array.from(db.jobCrew.values())) {
        if (!matches(row, args.where)) continue
        Object.assign(row, args.data)
        count++
      }
      return { count }
    },
  },
  auditLog: {
    async create(args: { data: Row }): Promise<Row> {
      stmt('auditLog.create')
      const id = String(args.data.id ?? `audit_${db.audits.size + 1}`)
      if (db.audits.has(id)) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
      }
      const row = { ...args.data, id, createdAt: new Date() }
      db.audits.set(id, row)
      return row
    },
    async count(args: { where: Row }): Promise<number> {
      db.writes.push('auditLog.count')
      let n = 0
      for (const row of Array.from(db.audits.values())) if (matches(row, args.where)) n++
      return n
    },
  },
  // The `move_completed` automation trigger reads this. Empty = no automation
  // is enrolled, which keeps the trigger out of the way of what is under test.
  emailAutomation: {
    async findMany(): Promise<Row[]> {
      return []
    },
  },
  async $transaction(arg: unknown): Promise<unknown> {
    if (Array.isArray(arg)) {
      const before = snapshot()
      try {
        return await Promise.all(arg)
      } catch (e) {
        restore(before)
        throw e
      }
    }
    const before = snapshot()
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(fakePrisma)
    } catch (e) {
      restore(before)
      throw e
    }
  },
}

/** Install the fake BEFORE src/lib/db.ts is first imported. Call at module
 *  scope in the test file; every module under test is imported dynamically
 *  inside the tests, so this always wins the race. */
export function installFakePrisma(): void {
  ;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma
}

export async function assertUsingFake(): Promise<void> {
  const dbModule = await import('../db')
  assert.equal(dbModule.prisma as unknown, fakePrisma, 'the shipped modules must be using the fake client')
}

// ── The booking row the SHIPPED WRITER persists ──────────────────────────────
//
// Built by `admin-booking.buildBookingCreateData` (the admin Book Move path),
// not by a fixture that invents columns production never writes.
export async function seedBooking(
  over: Row = {},
  opts: { job?: Row | null; crew?: Row[]; customer?: Row } = {},
): Promise<Row> {
  const [adminBooking, estimate, scheduling] = await Promise.all([
    import('../admin-booking'),
    import('../estimate'),
    import('../scheduling'),
  ])
  const parsed = adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: '2027-07-15',
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
  const schedule = adminBooking.resolveMoveSchedule(input.move, {
    estimatedHours: 4,
    helpers: { toInstant: scheduling.etDateTimeToInstant, endTime: scheduling.calculateEndTime },
  })
  const data = adminBooking.buildBookingCreateData(
    input,
    {
      estimate: estimate.computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1042',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate!,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  const row: Row = {
    id: 'bk_life',
    customerId: 'cust_1',
    ...(data as Row),
    // …the $49 hold is captured and the move is scheduled for the DATE.
    status: 'IN_PROGRESS',
    depositPaid: true,
    completedAt: null,
    confirmedDate: schedule.requestedDate,
    scheduledStart: null,
    scheduledEnd: null,
    customerToken: 'tok_life',
    ...over,
  }
  resetDb()
  db.bookings.set(String(row.id), row)
  db.customers.set('cust_1', {
    id: 'cust_1',
    name: 'Maria Lopez',
    email: 'maria@example.com',
    locale: 'en',
    // TRI-STATE consent. `true` here; the no-consent tests override it.
    emailMarketingConsent: true,
    marketingOptOut: false,
    ...(opts.customer ?? {}),
  })
  if (opts.job !== null) {
    db.jobs.set(String(row.id), {
      id: 'job_1',
      bookingId: row.id,
      status: 'IN_PROGRESS',
      startedAt: new Date('2027-07-15T18:00:00.000Z'),
      completedAt: null,
      durationMins: null,
      ...(opts.job ?? {}),
    })
  }
  for (const c of opts.crew ?? []) {
    db.jobCrew.set(String(c.id), {
      jobId: 'job_1',
      assignmentStatus: 'ASSIGNED',
      cancelledAt: null,
      cancelReason: null,
      ...c,
    })
  }
  return row
}

export const quietLogger = { info() {}, warn() {}, error() {} }
