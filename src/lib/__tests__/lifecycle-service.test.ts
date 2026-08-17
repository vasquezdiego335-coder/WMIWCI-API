// ════════════════════════════════════════════════════════════════════════════
//  lifecycle-service.test.ts — BLOCKER B7 + B8.
//
//  WHAT IS UNDER TEST, and how (round-3 rules):
//
//   • THE SHIPPED CODE RUNS. `src/lib/lifecycle-service.ts` is imported for
//     real, against a fake Prisma client installed on globalThis BEFORE
//     src/lib/db.ts is first loaded — the same technique
//     staffing-repair-triggers.test.ts uses. Nothing here re-implements the
//     service; every assertion is about what the shipped function did.
//
//   • THE FAKE MODELS THE EDGES HONESTLY. `$transaction` is ATOMIC: it snapshots
//     every table, and a throw inside restores the snapshot. `auditLog.create`
//     enforces the PRIMARY KEY, so the deterministic id really is a claim.
//     `updateMany` evaluates its `where` against the current rows, so a
//     conditional claim really can match zero. A fake that could not express
//     those cannot prove anything about them.
//
//   • THE BOOKING ROW COMES FROM THE SHIPPED WRITER. `buildBookingCreateData`
//     (the admin Book Move path) produces the columns, not a fixture that
//     invents fields production never writes.
//
//   • EVERY GUARANTEE IS MUTATION-TESTED AGAINST THE ORIGINAL DEFECT. The
//     pre-fix shapes are reproduced in this file — `preFixAdminComplete()` (five
//     separate awaits, `completedAt` stamped last and swallowed) and
//     `preFixDiscordComplete()` (one transaction, no messages at all) — and run
//     against the SAME fake. Each defect test asserts the old wreckage still
//     appears, so a reader can see that this harness is capable of detecting the
//     bug it claims is fixed. If those tests ever go green-by-accident (the
//     harness stops seeing the defect), the guarantees below mean nothing.
//
//  OFFLINE: no database, no Redis, no Stripe, no network.
//    npx tsx --test src/lib/__tests__/lifecycle-service.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A canary allowlist would block the eligibility assertions for reasons that
// have nothing to do with completion.
delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST

type Row = Record<string, unknown>

// ════════════════════════════════════════════════════════════════════════════
//  THE FAKE DATABASE
// ════════════════════════════════════════════════════════════════════════════

type Tables = {
  bookings: Map<string, Row>
  customers: Map<string, Row>
  /** keyed by bookingId (Job.bookingId is @unique) */
  jobs: Map<string, Row>
  /** keyed by JobCrew.id */
  jobCrew: Map<string, Row>
  /** keyed by AuditLog.id — the PRIMARY KEY, enforced */
  audits: Map<string, Row>
}

type Db = Tables & {
  /** Ordered log of every write statement, for ordering assertions. */
  writes: string[]
  /** Throw the next time this statement runs (`op` matches a `writes` entry). */
  failOn?: { op: string; error: Error }
  /** Depth of the current $transaction, so nested behaviour is visible. */
  txDepth: number
}

function emptyDb(): Db {
  return {
    bookings: new Map(),
    customers: new Map(),
    jobs: new Map(),
    jobCrew: new Map(),
    audits: new Map(),
    writes: [],
    txDepth: 0,
  }
}

let db: Db = emptyDb()

const clone = (m: Map<string, Row>): Map<string, Row> =>
  new Map(Array.from(m.entries()).map(([k, v]) => [k, { ...v }]))

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

/** Record a statement and honour an injected failure. */
function stmt(op: string): void {
  db.writes.push(op)
  if (db.failOn && db.failOn.op === op) {
    const err = db.failOn.error
    db.failOn = undefined
    throw err
  }
}

/** Does a row satisfy a Prisma-style `where`? Supports the operators this
 *  service actually uses: equality, `in`, `notIn`, and an explicit null. */
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

/** Project a booking row through a (possibly nested) Prisma `select`. */
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

function pick(row: Row, select: Row): Row {
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) if (val) out[key] = row[key] ?? null
  return out
}

const fakePrisma: Row = {
  booking: {
    async findUnique(args: { where: { id: string }; select?: Row }): Promise<Row | null> {
      const row = db.bookings.get(args.where.id)
      return row ? projectBooking(row, args.select) : null
    },
    async update(args: { where: { id: string }; data: Row; select?: Row }): Promise<Row> {
      stmt('booking.update')
      const row = db.bookings.get(args.where.id)
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' })
      Object.assign(row, args.data)
      return projectBooking(row, args.select)
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
        const candidate = { ...row, bookingId }
        if (!matches(candidate, args.where)) continue
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
      // THE PRIMARY KEY IS REAL. A deterministic id is only a claim if a second
      // insert of the same id fails, so this fake enforces it.
      if (db.audits.has(id)) {
        throw Object.assign(new Error(`Unique constraint failed on the fields: (\`id\`)`), { code: 'P2002' })
      }
      const row = { ...args.data, id, createdAt: new Date() }
      db.audits.set(id, row)
      return row
    },
    async count(args: { where: Row }): Promise<number> {
      let n = 0
      for (const row of Array.from(db.audits.values())) if (matches(row, args.where)) n++
      return n
    },
  },
  async $transaction(arg: unknown): Promise<unknown> {
    // ATOMIC. This is the property the whole blocker turns on: the pre-fix route
    // wrote three rows as three separate awaits, so a failure left the booking
    // COMPLETED with no stamp, no Job and no audit — and it could never be
    // retried.
    if (Array.isArray(arg)) {
      const before = snapshot()
      db.txDepth++
      try {
        const out = await Promise.all(arg)
        return out
      } catch (e) {
        restore(before)
        throw e
      } finally {
        db.txDepth--
      }
    }
    const before = snapshot()
    db.txDepth++
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(fakePrisma)
    } catch (e) {
      restore(before)
      throw e
    } finally {
      db.txDepth--
    }
  },
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

// ── Modules under test (dynamic — the fake must exist before db.ts loads) ────

type Mods = {
  lifecycle: typeof import('../lifecycle-service')
  eligibility: typeof import('../email-eligibility')
  conflicts: typeof import('../conflict-engine')
  assignments: typeof import('../assignment-lifecycle')
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  scheduling: typeof import('../scheduling')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    lifecycle: await import('../lifecycle-service'),
    eligibility: await import('../email-eligibility'),
    conflicts: await import('../conflict-engine'),
    assignments: await import('../assignment-lifecycle'),
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    scheduling: await import('../scheduling'),
  }
  const dbModule = await import('../db')
  assert.equal(dbModule.prisma as unknown, fakePrisma, 'the shipped modules must be using the fake client')
  return mods
}

// ── The row the SHIPPED WRITER persists ─────────────────────────────────────

async function bookingRow(over: Row = {}): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
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
  const schedule = m.adminBooking.resolveMoveSchedule(input.move, {
    estimatedHours: 4,
    helpers: { toInstant: m.scheduling.etDateTimeToInstant, endTime: m.scheduling.calculateEndTime },
  })
  const data = m.adminBooking.buildBookingCreateData(
    input,
    {
      estimate: m.estimate.computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1042',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate!,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  // …then the $49 hold is captured and the move is scheduled for the DATE.
  return {
    id: 'bk_life',
    customerId: 'cust_1',
    ...(data as Row),
    status: 'SCHEDULED',
    depositPaid: true,
    completedAt: null,
    confirmedDate: schedule.requestedDate,
    scheduledStart: null,
    scheduledEnd: null,
    customerToken: 'tok_life',
    ...over,
  }
}

/** Seed the fake with one booking, one customer, and optionally a Job + crew. */
async function seed(
  over: Row = {},
  opts: { job?: Row | null; crew?: Row[] } = {},
): Promise<Row> {
  db = emptyDb()
  const row = await bookingRow(over)
  db.bookings.set(String(row.id), row)
  db.customers.set('cust_1', {
    id: 'cust_1',
    name: 'Maria Lopez',
    email: 'maria@example.com',
    locale: 'en',
    emailMarketingConsent: true,
    marketingOptOut: false,
  })
  if (opts.job !== null) {
    db.jobs.set(String(row.id), {
      id: 'job_1',
      bookingId: row.id,
      status: 'SCHEDULED',
      startedAt: null,
      completedAt: null,
      durationMins: null,
      ...(opts.job ?? {}),
    })
  }
  for (const c of opts.crew ?? []) {
    db.jobCrew.set(String(c.id), { jobId: 'job_1', assignmentStatus: 'ASSIGNED', cancelledAt: null, cancelReason: null, ...c })
  }
  return row
}

const booking = (): Row => db.bookings.get('bk_life') as Row
const job = (): Row | undefined => db.jobs.get('bk_life')
const auditRows = (): Row[] => Array.from(db.audits.values())

// ── Observable side effects ─────────────────────────────────────────────────

type Recorder = {
  effects: import('../lifecycle-service').LifecycleEffects
  emails: Array<{ bookingId: string; completedAt: Date }>
  followups: string[]
  balance: string[]
  stops: string[]
  /** Make one handoff blow up. */
  fail: Set<'email' | 'followups' | 'balance' | 'stops'>
  /** Make one handoff hang forever (Redis stall). */
  hang: Set<'email' | 'followups' | 'balance' | 'stops'>
  /** What the follow-up handoff REPORTS. Default: the whole sequence really
   *  reached the queue. D3: the handoffs report what they did, so a test can
   *  say "the flag was off" or "no consent" without inventing a report shape. */
  followupOutcome: import('../followups').FollowupScheduleOutcome
  balanceOutcome: import('../journeys').BalanceReminderOutcome
}

function recorder(): Recorder {
  const r: Partial<Recorder> = {
    emails: [],
    followups: [],
    balance: [],
    stops: [],
    fail: new Set(),
    hang: new Set(),
    followupOutcome: { scheduled: 4, failed: 0, total: 4, reason: null },
    balanceOutcome: { scheduled: true, reason: null },
  }
  const gate = async (which: 'email' | 'followups' | 'balance' | 'stops'): Promise<void> => {
    if (r.fail!.has(which)) throw new Error(`${which} handoff failed (Redis?)`)
    if (r.hang!.has(which)) await new Promise(() => {})
  }
  r.effects = {
    async sendCompletionEmail(b, completedAt) {
      await gate('email')
      if (!b.customer?.email) return false
      r.emails!.push({ bookingId: b.id, completedAt })
      return true
    },
    async scheduleFollowups(id) {
      await gate('followups')
      r.followups!.push(id)
      return r.followupOutcome!
    },
    async scheduleBalanceReminder(id) {
      await gate('balance')
      r.balance!.push(id)
      return r.balanceOutcome!
    },
    async stopJourneys(id) {
      await gate('stops')
      r.stops!.push(id)
    },
  }
  return r as Recorder
}

const quietLogger = { info() {}, warn() {}, error() {} }

// ── The PRE-FIX shapes, reproduced so the harness can be shown to see them ───

/** The admin route as it shipped: FIVE separate awaits, `completedAt` stamped
 *  last (inside followups.onBookingCompleted) with its failure swallowed. */
async function preFixAdminComplete(bookingId: string, now: Date): Promise<void> {
  const p = fakePrisma as never as {
    job: { updateMany(a: unknown): Promise<unknown> }
    booking: { update(a: unknown): Promise<unknown>; updateMany(a: unknown): Promise<unknown> }
    auditLog: { create(a: unknown): Promise<unknown> }
  }
  await p.job.updateMany({ where: { bookingId }, data: { status: 'COMPLETED', completedAt: now } })
  await p.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } })
  await p.auditLog.create({
    data: { action: 'BOOKING_STATE_CHANGED', bookingId, details: { from: 'IN_PROGRESS', to: 'COMPLETED' } },
  })
  // followups.onBookingCompleted — first-wins stamp, `.catch(log.warn)`.
  await p.booking
    .updateMany({ where: { id: bookingId, completedAt: null }, data: { completedAt: now } })
    .catch(() => undefined)
}

/** The Discord handler as it shipped: one atomic transaction, and then nothing.
 *  No email, no balance reminder, no follow-ups, no automation trigger. */
async function preFixDiscordComplete(bookingId: string, now: Date): Promise<void> {
  const p = fakePrisma as never as { $transaction(a: unknown): Promise<unknown> }
  const t = fakePrisma as never as {
    booking: { update(a: unknown): Promise<unknown> }
    job: { upsert(a: unknown): Promise<unknown> }
    auditLog: { create(a: unknown): Promise<unknown> }
  }
  await p.$transaction([
    t.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED', completedAt: now } }),
    t.job.upsert({
      where: { bookingId },
      update: { status: 'COMPLETED', completedAt: now },
      create: { bookingId, status: 'COMPLETED', startedAt: now, completedAt: now },
    }),
    t.auditLog.create({ data: { action: 'JOB_COMPLETED', bookingId, details: { by: 'crew' } } }),
  ])
}

const AT = new Date('2027-07-15T21:00:00.000Z')

// ════════════════════════════════════════════════════════════════════════════
//  0. THE HARNESS CAN STILL SEE THE ORIGINAL DEFECTS
//     (if these go green, nothing below means anything)
// ════════════════════════════════════════════════════════════════════════════

test('DEFECT B8: the pre-fix Discord completion leaves the customer with NOTHING', async () => {
  await load()
  await seed({ status: 'IN_PROGRESS' }, { job: { status: 'IN_PROGRESS', startedAt: new Date(AT.getTime() - 3 * 3600_000) } })
  const rec = recorder()

  await preFixDiscordComplete('bk_life', AT)

  assert.equal(booking().status, 'COMPLETED', 'the row IS completed…')
  assert.ok(booking().completedAt, '…and Discord did stamp completedAt')
  // …and that is the entire blocker: every customer-facing consequence is absent.
  assert.deepEqual(rec.emails, [], 'no move-complete email')
  assert.deepEqual(rec.followups, [], 'no review request, no referral ask, no repeat reminder')
  assert.deepEqual(rec.balance, [], 'no +24h reminder for the balance still owed')
})

test('DEFECT B7: the pre-fix admin completion can strand a booking with NO completedAt', async () => {
  await load()
  await seed({ status: 'IN_PROGRESS' })

  // The request dies after the status flip and before the stamp — a deploy
  // restart, a Neon blip, a closed laptop. The stamp's failure is swallowed.
  db.failOn = { op: 'booking.updateMany', error: new Error('Neon: connection terminated') }
  await preFixAdminComplete('bk_life', AT)

  assert.equal(booking().status, 'COMPLETED')
  assert.equal(booking().completedAt ?? null, null, 'THE DEFECT: completed with no stamp')

  // …and that stamp is what every post-move template checks, so all six are
  // permanently refused for a job that really happened.
  const m = await load()
  const snap = {
    status: 'COMPLETED',
    isInternalTest: false,
    depositPaid: true,
    completedAt: null,
    requestedDate: booking().requestedDate as Date,
    confirmedDate: booking().confirmedDate as Date,
    scheduledStart: null,
    customerMarketingConsent: true,
    customerMarketingOptOut: false,
  }
  for (const template of ['job-completion', 'review-request', 'review-reminder', 'referral', 'referral-ask', 'repeat-reminder']) {
    assert.equal(m.eligibility.bookingBlockReason(template, snap), 'not_completed', `${template} is refused`)
  }
})

test('DEFECT B7: the pre-fix admin completion is NOT atomic — a mid-way failure half-writes', async () => {
  await load()
  await seed({ status: 'IN_PROGRESS' })

  // Kill it at the audit, i.e. AFTER the Job and the Booking were written.
  db.failOn = { op: 'auditLog.create', error: new Error('Neon: connection terminated') }
  await assert.rejects(() => preFixAdminComplete('bk_life', AT))

  assert.equal(booking().status, 'COMPLETED', 'THE DEFECT: the status change survived…')
  assert.equal(booking().completedAt ?? null, null, '…with no stamp…')
  assert.equal(auditRows().length, 0, '…and no audit record of any of it')
})

test('DEFECT B7: nothing in the shipped repo ever wrote JobStatus.CANCELLED', () => {
  const ROOT = resolve(__dirname, '../../..')
  // The finding: `JobStatus.CANCELLED` existed and was written by NOTHING, which
  // made conflict-engine's ASSIGNMENT_ON_CANCELLED_JOB hard block unreachable.
  // This pins the ONE place that may write it now, so a future refactor that
  // deletes the write re-opens the hole loudly.
  const service = readFileSync(join(ROOT, 'src/lib/lifecycle-service.ts'), 'utf8')
  assert.match(service, /status: 'CANCELLED'/, 'the lifecycle service must be the writer')
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE FIX — one transaction, and the messages that follow it
// ════════════════════════════════════════════════════════════════════════════

test('B8: completing from Discord now emits the whole post-move sequence', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' }, { job: { status: 'IN_PROGRESS', startedAt: new Date(AT.getTime() - 3 * 3600_000) } })
  const rec = recorder()

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'sebastian', discordUserId: '99' }, source: 'discord', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.ok(res.ok, 'the completion must succeed')
  assert.equal(res.ok && res.outcome, 'completed')
  assert.equal(res.ok && res.durationMins, 180, 'three hours of labor, from the Job start')

  // The customer finally hears from the business.
  assert.equal(rec.emails.length, 1, 'the move-complete email is queued')
  assert.deepEqual(rec.followups, ['bk_life'], 'review / review-reminder / referral / repeat are scheduled')
  assert.deepEqual(rec.balance, ['bk_life'], 'the +24h balance reminder is scheduled')
  assert.deepEqual(res.ok ? res.effects : null, {
    email: { state: 'queued', count: 1 },
    followups: { state: 'scheduled', count: 4 },
    balance: { state: 'scheduled', count: 1 },
  })
})

test('B7: status and completedAt commit TOGETHER, so every post-move template passes', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()

  await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego', userId: 'u_diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.equal(booking().status, 'COMPLETED')
  assert.equal((booking().completedAt as Date).getTime(), AT.getTime(), 'the stamp is not a later, separate write')

  // The SHIPPED send-time gate, run against the row this service committed.
  for (const template of ['job-completion', 'review-request', 'review-reminder', 'referral', 'referral-ask', 'repeat-reminder']) {
    assert.equal(await m.eligibility.bookingEligibility(template, 'bk_life'), null, `${template} may now be sent`)
  }
})

test('B7: the message is enqueued only AFTER the stamp is committed (the ordering race is gone)', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const order: string[] = []
  const rec = recorder()
  const effects: import('../lifecycle-service').LifecycleEffects = {
    async sendCompletionEmail(b, at) {
      // What the email worker's recheck would see at this instant.
      order.push(`email:completedAt=${booking().completedAt ? 'set' : 'NULL'}`)
      return rec.effects.sendCompletionEmail(b, at)
    },
    scheduleFollowups: rec.effects.scheduleFollowups,
    scheduleBalanceReminder: rec.effects.scheduleBalanceReminder,
    stopJourneys: rec.effects.stopJourneys,
  }

  await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects, logger: quietLogger },
  )

  assert.deepEqual(order, ['email:completedAt=set'])
})

test('B7: a failure inside the transaction writes NOTHING and leaves the completion retryable', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()

  db.failOn = { op: 'auditLog.create', error: new Error('Neon: connection terminated') }
  const failed = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.equal(failed.ok, false, 'the caller is told the truth')
  assert.equal(!failed.ok && failed.code, 'write_failed')
  assert.match(!failed.ok ? failed.message : '', /nothing was changed/i, 'and told that nothing changed')
  assert.equal(booking().status, 'IN_PROGRESS', 'the status did NOT move')
  assert.equal(booking().completedAt ?? null, null)
  assert.equal(job()!.status, 'SCHEDULED', 'the Job write rolled back with it')
  assert.equal(auditRows().length, 0)
  // No message may be sent about a completion that did not happen.
  assert.deepEqual(rec.emails, [])
  assert.deepEqual(rec.followups, [])
  assert.deepEqual(rec.balance, [])

  // AND THE RETRY WORKS — the whole point of an all-or-nothing write.
  const retried = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )
  assert.ok(retried.ok)
  assert.equal(retried.ok && retried.outcome, 'completed')
  assert.equal(booking().status, 'COMPLETED')
  assert.equal(rec.emails.length, 1)
})

test('B7: the Job is UPSERTED — a booking with no Job row still gets a completed one', async () => {
  const m = await load()
  await seed({ status: 'CONFIRMED' }, { job: null })
  assert.equal(db.jobs.size, 0, 'precondition: approval never wrote a Job')

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'sebastian' }, source: 'discord', at: AT },
    { effects: recorder().effects, logger: quietLogger },
  )

  assert.ok(res.ok)
  assert.equal(db.jobs.size, 1, 'updateMany would have matched zero rows and created nothing')
  assert.equal(job()!.status, 'COMPLETED')
  assert.equal((job()!.completedAt as Date).getTime(), AT.getTime())
})

// ════════════════════════════════════════════════════════════════════════════
//  2. IDEMPOTENCY — a second press changes nothing and re-sends nothing
// ════════════════════════════════════════════════════════════════════════════

test('B8: a second "Complete Job" press is a no-op and re-fires no message', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()
  const press = () =>
    m.lifecycle.completeBooking(
      { bookingId: 'bk_life', actor: { name: 'sebastian' }, source: 'discord', at: AT },
      { effects: rec.effects, logger: quietLogger },
    )

  const first = await press()
  const second = await press()

  assert.equal(first.ok && first.outcome, 'completed')
  assert.equal(second.ok && second.outcome, 'already_completed')
  assert.equal(second.ok && second.claimed, false)
  assert.equal(rec.emails.length, 1, 'exactly one move-complete email')
  assert.equal(rec.followups.length, 1)
  assert.equal(rec.balance.length, 1)
  assert.equal(auditRows().filter((a) => a.action === 'JOB_COMPLETED').length, 1, 'one JOB_COMPLETED, forever')
})

test('B8: two callers racing into the transaction produce exactly one completion', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()

  // Both read the pending row, then both drive the transaction.
  const [a, b] = await Promise.all([
    m.lifecycle.completeBooking(
      { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
      { effects: rec.effects, logger: quietLogger },
    ),
    m.lifecycle.completeBooking(
      { bookingId: 'bk_life', actor: { name: 'sebastian' }, source: 'discord', at: AT },
      { effects: rec.effects, logger: quietLogger },
    ),
  ])

  const outcomes = [a.ok && a.outcome, b.ok && b.outcome].sort()
  assert.deepEqual(outcomes, ['already_completed', 'completed'], 'one winner, one no-op')
  assert.equal(auditRows().filter((x) => x.action === 'JOB_COMPLETED').length, 1)
  assert.equal(rec.emails.length, 1, 'the customer is not told twice')
})

test('B8: the completion audit id is deterministic — a second insert is refused by the primary key', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: recorder().effects, logger: quietLogger },
  )

  assert.ok(db.audits.has(m.lifecycle.completionAuditId('bk_life')), 'the row is keyed to the booking')
  await assert.rejects(
    () => (fakePrisma as never as { auditLog: { create(a: unknown): Promise<unknown> } }).auditLog.create({
      data: { id: m.lifecycle.completionAuditId('bk_life'), action: 'JOB_COMPLETED', bookingId: 'bk_life' },
    }),
    /Unique constraint/,
    'the database itself refuses a second completion ledger row',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  3. CONVERGENCE — both surfaces write the same rows
// ════════════════════════════════════════════════════════════════════════════

test('B7/B8: admin and Discord completions produce IDENTICAL database writes', async () => {
  const m = await load()
  const startedAt = new Date(AT.getTime() - 2 * 3600_000)

  const run = async (source: 'admin' | 'discord'): Promise<{ booking: Row; job: Row; audit: Row; writes: string[] }> => {
    await seed({ status: 'IN_PROGRESS' }, { job: { status: 'IN_PROGRESS', startedAt } })
    db.writes = []
    await m.lifecycle.completeBooking(
      { bookingId: 'bk_life', actor: { name: 'x' }, source, at: AT },
      { effects: recorder().effects, logger: quietLogger },
    )
    const audit = auditRows()[0]
    return { booking: { ...booking() }, job: { ...job()! }, audit: { ...audit }, writes: [...db.writes] }
  }

  const admin = await run('admin')
  const discord = await run('discord')

  assert.deepEqual(admin.writes, discord.writes, 'the same statements, in the same order')
  assert.deepEqual(admin.booking, discord.booking)
  assert.deepEqual(admin.job, discord.job)
  // Only the provenance differs — which is the one thing that SHOULD differ.
  const strip = (a: Row): Row => {
    const d = { ...(a.details as Row) }
    delete d.source
    return { ...a, details: d, createdAt: null }
  }
  assert.deepEqual(strip(admin.audit), strip(discord.audit))
  assert.equal((admin.audit.details as Row).source, 'admin')
  assert.equal((discord.audit.details as Row).source, 'discord')
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE RECOVERY — the piece that turns a permanent loss into an action
// ════════════════════════════════════════════════════════════════════════════

test('B8 RECOVERY: replay re-drives the messages for a job completed before this fix', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  // Exactly the state a pre-fix Discord completion leaves behind.
  await preFixDiscordComplete('bk_life', AT)
  const rec = recorder()
  db.writes = []

  const res = await m.lifecycle.replayCompletion('bk_life', {}, { effects: rec.effects, logger: quietLogger })

  assert.ok(res.ok)
  assert.equal(rec.emails.length, 1, 'the customer finally gets their move-complete email')
  assert.deepEqual(rec.followups, ['bk_life'])
  assert.deepEqual(rec.balance, ['bk_life'])
  assert.deepEqual(db.writes, [], 'a replay changes NO database row — it only re-drives the messages')
})

test('B7 RECOVERY: replay repairs a stranded COMPLETED-with-no-stamp booking, then sends', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  db.failOn = { op: 'booking.updateMany', error: new Error('Neon: connection terminated') }
  await preFixAdminComplete('bk_life', AT)
  assert.equal(booking().completedAt ?? null, null, 'precondition: the stranded state')
  const rec = recorder()

  const res = await m.lifecycle.replayCompletion('bk_life', {}, { effects: rec.effects, logger: quietLogger })

  assert.ok(res.ok)
  assert.ok(booking().completedAt, 'the stamp is repaired — nothing else could reach this row')
  assert.equal(booking().status, 'COMPLETED')
  assert.equal(rec.emails.length, 1)
  assert.equal(rec.followups.length, 1)
  assert.equal(rec.balance.length, 1)
  // And the six templates that were permanently refused now pass.
  assert.equal(await m.eligibility.bookingEligibility('review-request', 'bk_life'), null)
})

test('B7 RECOVERY: an ARCHIVED booking with no stamp is repaired WITHOUT being un-archived', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  db.failOn = { op: 'booking.updateMany', error: new Error('Neon: connection terminated') }
  await preFixAdminComplete('bk_life', AT)
  // …and then the owner did the only thing the admin UI offered: Archive.
  booking().status = 'ARCHIVED'
  assert.equal(booking().completedAt ?? null, null, 'precondition: archived, never stamped')
  const rec = recorder()

  const res = await m.lifecycle.replayCompletion('bk_life', {}, { effects: rec.effects, logger: quietLogger })

  assert.ok(res.ok)
  assert.ok(booking().completedAt, 'the missing fact is written')
  assert.equal(booking().status, 'ARCHIVED', 'and the booking is NOT dragged back out of the archive')
  assert.equal(rec.emails.length, 1)
  assert.equal(await m.eligibility.bookingEligibility('review-request', 'bk_life'), null)
})

test('B7 RECOVERY: repairing a missing stamp uses the time the JOB recorded, not "now"', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  db.failOn = { op: 'booking.updateMany', error: new Error('Neon: connection terminated') }
  await preFixAdminComplete('bk_life', AT) // the Job row DOES carry the real time
  assert.equal((job()!.completedAt as Date).getTime(), AT.getTime(), 'precondition: the job knows when it finished')
  assert.equal(booking().completedAt ?? null, null)

  const much_later = new Date(AT.getTime() + 9 * 24 * 3600_000)
  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: much_later },
    { effects: recorder().effects, logger: quietLogger },
  )

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'repaired')
  assert.equal(
    (booking().completedAt as Date).getTime(),
    AT.getTime(),
    'the repair records when the move actually finished — pressing the button nine days later does not move the move',
  )
  assert.equal((job()!.completedAt as Date).getTime(), AT.getTime(), 'and the job row is not rewritten either')
})

test('a lost claim never reports a completedAt the row does not carry', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  // Between the read and the write, another caller archives the booking, so the
  // claim matches zero rows and no stamp exists anywhere.
  const original = (fakePrisma as never as { booking: { updateMany(a: unknown): Promise<{ count: number }> } }).booking
  const realUpdateMany = original.updateMany.bind(original)
  original.updateMany = async (args: unknown) => {
    booking().status = 'CANCELLED'
    return realUpdateMany(args)
  }
  try {
    const res = await m.lifecycle.completeBooking(
      { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
      { effects: recorder().effects, logger: quietLogger },
    )
    assert.ok(res.ok)
    assert.equal(res.ok && res.claimed, false)
    assert.equal(res.ok && res.completedAt, null, 'no invented completion time')
  } finally {
    original.updateMany = realUpdateMany
  }
})

test('RECOVERY: replay refuses a booking whose job never happened', async () => {
  const m = await load()
  await seed({ status: 'SCHEDULED' })

  const res = await m.lifecycle.replayCompletion('bk_life', {}, { effects: recorder().effects, logger: quietLogger })

  assert.equal(res.ok, false, 'no message may claim a completed job the database cannot show')
  assert.equal(!res.ok && res.code, 'invalid_status')
  assert.equal(await m.lifecycle.loadLifecycleBooking('bk_life').then((b) => b?.status), 'SCHEDULED')
})

test('RECOVERY: replaying twice does not double-send (the handoffs are the dedupe)', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()
  await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )
  const emailJob = m.lifecycle.buildCompletionEmailJob(
    (await m.lifecycle.loadLifecycleBooking('bk_life'))!,
    booking().completedAt as Date,
  )
  await m.lifecycle.replayCompletion('bk_life', {}, { effects: rec.effects, logger: quietLogger })

  // The service hands the queue the SAME job id every time, and the send guard
  // keys on the booking — so the second run collapses onto the first.
  const again = m.lifecycle.buildCompletionEmailJob(
    (await m.lifecycle.loadLifecycleBooking('bk_life'))!,
    booking().completedAt as Date,
  )
  assert.equal(emailJob!.opts.jobId, again!.opts.jobId, 'a deterministic queue-job id')
  assert.ok(!emailJob!.opts.jobId.includes(':'), 'BullMQ REJECTS a custom job id containing a colon')
  assert.equal(emailJob!.data.bookingId, 'bk_life', 'the send guard keys on the booking')
})

// ════════════════════════════════════════════════════════════════════════════
//  5. CANCELLATION — the crew guard can finally fire
// ════════════════════════════════════════════════════════════════════════════

test('B7: cancelling marks the Job CANCELLED, and the dead hard block finally fires', async () => {
  const m = await load()
  await seed({ status: 'CONFIRMED' })
  const rec = recorder()

  // BEFORE: the pre-fix state is a SCHEDULED job on a cancelled booking, and
  // the conflict engine cannot see anything wrong with it.
  const ctx = (jobStatus: string) => ({
    worker: { active: true, workerStatus: 'ACTIVE', isDriverEligible: true },
    assignment: { startAt: null, endAt: null, isDriver: false },
    jobStatus,
    otherShifts: [],
  })
  const before = m.conflicts.detectAssignmentConflicts(ctx('SCHEDULED') as never)
  assert.ok(
    !before.some((c) => c.code === 'ASSIGNMENT_ON_CANCELLED_JOB'),
    'DEFECT: with the Job left SCHEDULED, more crew can be added to a cancelled move',
  )

  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego', userId: 'u_diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.ok(res.ok)
  assert.equal(booking().status, 'CANCELLED')
  assert.equal(job()!.status, 'CANCELLED')
  const after = m.conflicts.detectAssignmentConflicts(ctx(String(job()!.status)) as never)
  const hard = after.find((c) => c.code === 'ASSIGNMENT_ON_CANCELLED_JOB')
  assert.ok(hard, 'the guard written for exactly this case is now reachable')
  assert.equal(hard!.severity, 'HARD_BLOCK')
  assert.deepEqual(rec.stops, ['bk_life'], 'and every journey for the booking is stopped')
})

test('B7: cancelling kills the LIVE crew assignments, so the move leaves the worker\'s upcoming list', async () => {
  const m = await load()
  await seed(
    { status: 'SCHEDULED' },
    {
      crew: [
        { id: 'jc_1', assignmentStatus: 'ASSIGNED' },
        { id: 'jc_2', assignmentStatus: 'ACCEPTED' },
        { id: 'jc_3', assignmentStatus: 'COMPLETED' }, // real work, already done
        { id: 'jc_4', assignmentStatus: 'DECLINED' },
      ],
    },
  )

  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT, reason: 'Customer cancelled' },
    { effects: recorder().effects, logger: quietLogger },
  )

  assert.ok(res.ok)
  assert.equal(res.ok && res.crewCancelled, 2, 'the two live assignments, and only those')
  assert.equal(db.jobCrew.get('jc_1')!.assignmentStatus, 'CANCELLED')
  assert.equal(db.jobCrew.get('jc_2')!.assignmentStatus, 'CANCELLED')
  assert.equal(db.jobCrew.get('jc_3')!.assignmentStatus, 'COMPLETED', 'work that really happened is not unmade')
  assert.equal(db.jobCrew.get('jc_4')!.assignmentStatus, 'DECLINED')
  assert.equal(db.jobCrew.get('jc_1')!.cancelReason, 'Customer cancelled')
  assert.equal((db.jobCrew.get('jc_1')!.cancelledAt as Date).getTime(), AT.getTime())

  // The crew portal's "upcoming" filter is assignment liveness — this is the
  // query that kept showing a cancelled move on a worker's phone.
  for (const id of ['jc_1', 'jc_2']) {
    assert.equal(m.assignments.isLiveStatus(String(db.jobCrew.get(id)!.assignmentStatus)), false)
  }
})

test('B7: a cancellation failure writes NOTHING — booking, job and crew all roll back', async () => {
  const m = await load()
  await seed({ status: 'SCHEDULED' }, { crew: [{ id: 'jc_1', assignmentStatus: 'ASSIGNED' }] })
  const rec = recorder()

  db.failOn = { op: 'auditLog.create', error: new Error('Neon: connection terminated') }
  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.equal(res.ok, false)
  assert.equal(booking().status, 'SCHEDULED')
  assert.equal(job()!.status, 'SCHEDULED')
  assert.equal(db.jobCrew.get('jc_1')!.assignmentStatus, 'ASSIGNED')
  assert.deepEqual(rec.stops, [], 'and no journey is stopped for a cancellation that did not happen')
})

test('B7: re-cancelling an already-cancelled booking still finishes the crew half (the pre-fix backlog)', async () => {
  const m = await load()
  // Every cancellation before this service left exactly this: booking CANCELLED,
  // Job SCHEDULED, assignments live.
  await seed({ status: 'CANCELLED' }, { crew: [{ id: 'jc_1', assignmentStatus: 'ASSIGNED' }] })

  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: recorder().effects, logger: quietLogger },
  )

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'already_cancelled')
  assert.equal(job()!.status, 'CANCELLED', 'the stale live Job is finally closed')
  assert.equal(db.jobCrew.get('jc_1')!.assignmentStatus, 'CANCELLED')
})

test('B7: cancelJobForBooking REFUSES to touch the crew of a booking that is not cancelled', async () => {
  const m = await load()
  await seed({ status: 'SCHEDULED' }, { crew: [{ id: 'jc_1', assignmentStatus: 'ASSIGNED' }] })

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin' },
    { logger: quietLogger },
  )

  assert.equal(out.jobCancelled, false)
  assert.equal(out.crewCancelled, 0)
  assert.equal(out.skipped, 'status:SCHEDULED')
  assert.equal(db.jobCrew.get('jc_1')!.assignmentStatus, 'ASSIGNED', 'a live move keeps its crew')
  assert.equal(job()!.status, 'SCHEDULED')
})

test('B7: cancelJobForBooking is idempotent and writes no audit when nothing was live', async () => {
  const m = await load()
  await seed({ status: 'CANCELLED' }, { job: { status: 'CANCELLED' }, crew: [{ id: 'jc_1', assignmentStatus: 'CANCELLED' }] })

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin' },
    { logger: quietLogger },
  )

  assert.equal(out.jobCancelled, false)
  assert.equal(out.crewCancelled, 0)
  assert.equal(auditRows().length, 0, 'no audit row for a no-op')
})

// ════════════════════════════════════════════════════════════════════════════
//  6. HONEST REPORTING — no handoff is ever claimed to have happened
// ════════════════════════════════════════════════════════════════════════════

test('the effect report names what FAILED instead of claiming everything queued', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()
  rec.fail.add('email')

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.ok(res.ok, 'the completion itself still stands — it is committed')
  const eff = res.ok ? res.effects! : null
  assert.equal(eff!.email.state, 'failed', 'the email failure is REPORTED, not swallowed into a success line')
  assert.match(eff!.email.reason ?? '', /handoff failed/)
  assert.equal(eff!.followups.state, 'scheduled', 'and one failure does not cancel the rest')
  assert.equal(eff!.balance.state, 'scheduled')
  assert.match(m.lifecycle.replayCompletionMessage(eff!), /could NOT be queued/)
})

test('a customer with no email address is a SKIP, not a failure, and says so', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  db.customers.get('cust_1')!.email = null
  const rec = recorder()

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.deepEqual(res.ok ? res.effects!.email : null, { state: 'skipped', reason: 'no-email-address', count: 0 })
  const skipReport = res.ok ? res.effects! : null
  assert.match(m.lifecycle.replayCompletionMessage(skipReport!), /No move-complete email — no address on file/)
  assert.equal(rec.emails.length, 0)
})

test('a Redis stall inside Discord\'s 3s window times out the MESSAGES, never the completion', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const rec = recorder()
  rec.hang.add('followups') // queue.add() hangs forever — the documented Upstash failure

  const res = await m.lifecycle.completeBooking(
    { bookingId: 'bk_life', actor: { name: 'sebastian' }, source: 'discord', at: AT, effectsTimeoutMs: 25 },
    { effects: rec.effects, logger: quietLogger },
  )

  assert.ok(res.ok, 'the crew still get their card')
  assert.equal(booking().status, 'COMPLETED', 'and the completion is durable')
  assert.ok(booking().completedAt)
  assert.equal(res.ok && res.effects!.timedOut, true, 'the timeout is REPORTED')
  assert.equal(res.ok && res.effects!.email.state, 'queued', 'what did finish is reported as finished')
  assert.equal(res.ok && res.effects!.followups.state, 'not-run', 'what did NOT finish is never reported as done')
  assert.equal(res.ok && res.effects!.balance.state, 'not-run', 'nor the handoff that never even started')
})

// ════════════════════════════════════════════════════════════════════════════
//  7. PURE GUARDS
// ════════════════════════════════════════════════════════════════════════════

test('planCompletion admits exactly the states a completion can answer for', async () => {
  const { planCompletion } = (await load()).lifecycle
  const stamped = new Date()

  for (const s of ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']) {
    assert.equal(planCompletion(s, null).kind, 'complete', `${s} is a live move`)
  }
  assert.equal(planCompletion('COMPLETED', stamped).kind, 'already')
  assert.equal(planCompletion('ARCHIVED', stamped).kind, 'already')
  assert.equal(planCompletion('COMPLETED', null).kind, 'repair', 'the stranded state is REPAIRABLE, not "already done"')
  for (const s of ['CANCELLED', 'PENDING_APPROVAL', 'PENDING_PAYMENT', 'DRAFT']) {
    const p = planCompletion(s, null)
    assert.equal(p.kind, 'refuse', `${s} has no job to complete`)
    assert.ok(p.kind === 'refuse' && p.message.length > 0)
  }
})

test('planCancellation refuses to re-open a terminal booking', async () => {
  const { planCancellation } = (await load()).lifecycle
  for (const s of ['DRAFT', 'PENDING_PAYMENT', 'PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']) {
    assert.equal(planCancellation(s).kind, 'cancel', s)
  }
  assert.equal(planCancellation('CANCELLED').kind, 'already')
  for (const s of ['COMPLETED', 'ARCHIVED']) {
    assert.equal(planCancellation(s).kind, 'refuse', `${s} is a record of work, not a live move`)
  }
})

test('durationMinutesBetween never invents, and never goes negative', async () => {
  const { durationMinutesBetween } = (await load()).lifecycle
  const end = new Date('2027-07-15T21:00:00.000Z')
  assert.equal(durationMinutesBetween(null, end), null, 'no Start press ⇒ no duration claim')
  assert.equal(durationMinutesBetween(new Date('2027-07-15T18:00:00.000Z'), end), 180)
  assert.equal(durationMinutesBetween(new Date('2027-07-15T22:00:00.000Z'), end), 0, 'clock skew is not -60 minutes')
})

test('the cancellable assignment states are DERIVED from the shipped transition table', async () => {
  const m = await load()
  for (const s of m.lifecycle.CANCELLABLE_ASSIGNMENT_STATUSES) {
    assert.ok(m.assignments.canTransition(s, 'CANCELLED'), `${s} → CANCELLED must be a legal transition`)
  }
  assert.ok(!m.lifecycle.CANCELLABLE_ASSIGNMENT_STATUSES.includes('COMPLETED'), 'completed work is terminal')
  assert.ok(m.lifecycle.CANCELLABLE_ASSIGNMENT_STATUSES.includes('ASSIGNED'))
  assert.ok(m.lifecycle.CANCELLABLE_ASSIGNMENT_STATUSES.includes('IN_PROGRESS'))
})

test('the completion email payload is the one the customer already received', async () => {
  const m = await load()
  await seed({ status: 'IN_PROGRESS' })
  const b = (await m.lifecycle.loadLifecycleBooking('bk_life'))!

  const job = m.lifecycle.buildCompletionEmailJob(b, AT, 'https://moveitclearit.com/')

  assert.equal(job!.name, 'job-completion')
  assert.equal(job!.data.template, 'job-completion')
  assert.equal(job!.data.to, 'maria@example.com')
  const payload = job!.data.payload as Row
  assert.equal(payload.customerName, 'Maria Lopez')
  assert.equal(payload.displayId, 'WMIC-1042')
  assert.equal(payload.completedAt, AT.toISOString())
  assert.equal(payload.portalUrl, 'https://moveitclearit.com/my-booking/tok_life', 'no double slash from APP_URL')
  assert.equal(payload.locale, 'en')
})

// ════════════════════════════════════════════════════════════════════════════
//  8. WIRING — a correct service nothing calls is the defect itself
//     (source guards; comments stripped, so prose can never satisfy them)
// ════════════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../../..')

function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('WIRING: the comment stripper actually works (the round-3 lesson)', () => {
  const src = code('app/api/discord/interactions/route.ts')
  assert.ok(!/THIS IS THE DEFAULT COMPLETION PATH/.test(src), 'a known comment survived the stripper')
  assert.ok(/handleJobComplete/.test(src), 'and real code must survive it')
})

test('WIRING: the Discord card completes through the SHARED service, not its own transaction', () => {
  const src = code('app/api/discord/interactions/route.ts')
  const start = src.indexOf('async function handleJobComplete(')
  assert.ok(start > -1, 'the handler must still exist')
  const body = src.slice(start, src.indexOf('async function handleJobArchive('))

  assert.match(body, /completeBooking\(/, 'it must call the shared lifecycle service')
  assert.ok(
    !/\$transaction/.test(body),
    'a second completion transaction here is the B8 defect: two implementations that drift apart',
  )
  assert.ok(!/status: "COMPLETED"/.test(body), 'the handler must not write the status itself')
  assert.match(src, /from "@\/lib\/lifecycle-service"/, 'imported from the one module')
})

test('WIRING: the Discord deny finishes the crew half', () => {
  const src = code('app/api/discord/interactions/route.ts')
  const start = src.indexOf('async function handleDeny(')
  const body = src.slice(start, src.indexOf('async function handleOffer('))
  assert.match(body, /cancelJobForBooking\(/, 'a denied booking must not keep a live Job + crew')
  const decline = body.indexOf('declineBooking(')
  const cancelJob = body.indexOf('cancelJobForBooking(')
  assert.ok(decline > -1 && cancelJob > decline, 'the hold release runs first; the crew half follows it')
})

test('WIRING: the admin route completes and cancels through the SAME service', () => {
  const src = code('app/api/admin/bookings/[id]/status/route.ts')

  assert.match(src, /completeBooking\(/, 'COMPLETED goes through the service')
  assert.match(src, /cancelBooking\(/, 'CANCELLED goes through the service')
  assert.match(src, /cancelJobForBooking\(/, 'and a decline finishes the crew half')

  // The old duplicated fan-out must be GONE — a second copy is how the two
  // surfaces drifted in the first place.
  assert.ok(!/onBookingCompleted\(/.test(src), 'the follow-up call is the service\'s job now')
  assert.ok(!/onBookingCompletedBalance\(/.test(src), 'so is the balance reminder')
  assert.ok(!/onBookingCancelled\(/.test(src), 'so is the journey stop')
  assert.ok(
    !/data: \{ status: 'COMPLETED', completedAt: new Date\(\) \}/.test(src),
    'the Job updateMany that silently created no Job is gone',
  )

  // The transition table is NOT weakened.
  const completedRow = /\bCOMPLETED:\s*\[([^\]]*)\]/.exec(src)
  assert.ok(completedRow, 'VALID_TRANSITIONS must still describe a completed booking')
  assert.deepEqual(completedRow![1].trim(), "'ARCHIVED'", 'no COMPLETED → COMPLETED edge — the recovery is a named action')
})

test('WIRING: the recovery action is reachable BEFORE the transition table 422', () => {
  const src = code('app/api/admin/bookings/[id]/status/route.ts')
  assert.match(src, /z\.literal\('replay_completion'\)/, 'a literal, so a typo is a 422 rather than a status change')
  const branch = src.indexOf("'action' in parsed.data")
  const table = src.indexOf('allowed.includes(newStatus)')
  assert.ok(branch > -1 && table > branch, 'the named action must be handled before the 422 that would swallow it')
  const body = src.slice(branch, table)
  assert.match(body, /replayCompletion\(/, 'and it must call the replay')
})

test('WIRING: the admin button carries the label the service exports', async () => {
  const m = await load()
  const actions = code('app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx')
  assert.ok(
    actions.includes(m.lifecycle.REPLAY_COMPLETION_ACTION_LABEL),
    `BookingActions.tsx must render a control labelled "${m.lifecycle.REPLAY_COMPLETION_ACTION_LABEL}"`,
  )
  assert.match(actions, /action: 'replay_completion'/, 'and post the named action, not a status change')
  const completedBlock = /COMPLETED:\s*\[([\s\S]*?)\n\s{2}\],/.exec(actions)
  assert.ok(completedBlock, 'BookingActions must still describe a completed booking')
  assert.match(completedBlock![1], /replay_completion/, 'the recovery must be offered on a COMPLETED booking')
  assert.match(completedBlock![1], /ARCHIVED/, 'without removing Archive')
})

test('WIRING: the service reads booking columns EXPLICITLY (the deploy-window rule)', () => {
  const src = code('src/lib/lifecycle-service.ts')
  const pattern = /prisma\.booking\.(?:findFirst|findUnique|findMany|update|upsert)\(/g
  let found = 0
  let call: RegExpExecArray | null
  while ((call = pattern.exec(src)) !== null) {
    found++
    assert.match(
      src.slice(call.index, call.index + 300),
      /\bselect\b/,
      'an unqualified booking read asks for every generated column and raises P2022 during the code-before-SQL window',
    )
  }
  assert.ok(found > 0, 'the read under test must still exist')
})
