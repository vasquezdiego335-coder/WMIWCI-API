// ════════════════════════════════════════════════════════════════════════════
//  fulfilment-progress.test.ts — REPAIR ITEMS T2 + T3
//
//  T2 — THE DEFECT (reproduced against the shipped code): the fulfilment
//    progress list `done` grew ONLY IN MEMORY and was flushed ONCE, after the
//    fan-out, the audit write and the journey cleanup. Kill the runner in that
//    window — a serverless timeout, a deploy, the process being reaped — and the
//    durable row still said `done: []`, so the resume re-drove EVERY handoff: a
//    second SMS, a second email, a second marketing enrolment, two Discord
//    cards, and TWO PAYMENT_RECEIVED rows for one $49.
//
//  T2 — THE FIX UNDER TEST, in three layers, each tested ALONE:
//     1. every completion is its own durable write, issued the moment it is
//        proven (`markDone` → one conditional UPDATE that keeps the lease);
//     2. the deterministic BullMQ job id (already shipped, pinned by
//        webhook-durability.test.ts) collapses a re-driven enqueue;
//     3. `fulfillmentAuditId` — a DETERMINISTIC PRIMARY KEY on the
//        PAYMENT_RECEIVED row, so "one authorization ⇒ one audit row" is a
//        database property. Layer 1 cannot cover the audit's own kill window
//        (the write that records it is the statement after it), so layer 3 is
//        what makes that step exactly-once. The journey cleanup
//        (`onBookingPaid`) is the one step with neither: it is idempotent by
//        construction — it cancels queued recovery stages — and its window is
//        now one statement wide instead of the whole fan-out.
//
//  T3 — THE DEFECT: on the resume path the lease was taken by conditional
//    update, then the payload read failed and was swallowed by `.catch(() =>
//    null)`. The function returned `already-fulfilled-or-not-pending`, which is
//    NOT one of the reasons the caller throws on — so the webhook was marked
//    `processed`, the Stripe event was retired, the outstanding customer email
//    and Discord card never happened, and the lease was left held with nothing
//    to release it. A read failure is not a state.
//
//  HOW THIS FILE PROVES ITS HARNESS CAN SEE THE DEFECTS (the round-2 rule)
//   • T2: `dropProgressWrites` makes the fake database ignore the incremental
//     writes — which is EXACTLY the pre-fix durable state, because the pre-fix
//     code issued no such write at all; its only durable write was the final
//     flush the kill prevents. With it on, and the primary key off, the original
//     reproduction returns in full (2 emails, 2 texts, 2 enrolments, 2 cards,
//     2 PAYMENT_RECEIVED rows). Each toggle is also exercised ALONE, so neither
//     layer can be deleted while the other hides it.
//   • T3: the caller contract is A/B-tested directly — the reason the pre-fix
//     code returned is fed to the SHIPPED `processStripeEventJob` and shown to
//     retire the event (200 / webhook_logs 'processed'), while the reason the
//     fixed code returns throws (500 / 'failed'). That is the defect's exact
//     mechanism, still live, measured by this harness.
//
//  WHAT A "KILL" IS MODELLED AS: from the moment of death, NOTHING this process
//  does reaches the database or the queues (every fake throws), and the killed
//  run's return value is DISCARDED — a dead process tells nobody anything. The
//  resume can only ever see what the database holds, which is precisely what
//  this measures.
//
//  The booking row is what the SHIPPED WRITER persists (AdminBookingSchema →
//  resolveMoveSchedule → buildBookingCreateData, default owner path). The
//  shipped functions run against a fake `prisma` installed on globalThis before
//  src/lib/db.ts is first imported; only the queue edge and Discord posting are
//  faked, through the module's own injected deps.
//
//  Offline: no database, no Redis, no network.
//    npx tsx --test src/lib/__tests__/fulfilment-progress.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Stripe from 'stripe'

// ── Environment, BEFORE any app import ──────────────────────────────────────
process.env.STRIPE_SECRET_KEY = 'sk_test_fulfilment_progress'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fulfilment_progress'
process.env.APP_URL = 'https://example.test'
delete process.env.DISCORD_BOT_TOKEN
delete process.env.OUTBOX_ENABLED

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

type Row = Record<string, any>

const KILLED = 'process killed (test)'

type Ctl = {
  booking: Row | null
  audits: Row[]
  webhookLogs: Map<string, Row>
  payments: Row[]
  /** Every ledger write that actually LANDED, in order. */
  ledgerWrites: Array<{ status: string; done: string[] }>
  /** MUTANT SWITCH (T2 layer 1). True = a database that never received the
   *  incremental progress writes — i.e. the code before this repair, whose only
   *  durable write was the final flush. */
  dropProgressWrites: boolean
  /** THE CONSTRAINT UNDER TEST (T2 layer 3). False = a database without the
   *  deterministic PAYMENT_RECEIVED primary key. */
  enforceAuditPk: boolean
  /** The runner has been killed: nothing it does from here on reaches anything. */
  dead: boolean
  /** Die immediately after the PAYMENT_RECEIVED row commits — the T2 window. */
  killAfterAudit: boolean
  /** T3 — the ledger PAYLOAD read fails (only for the fulfilment ledger key). */
  failLedgerRead: Error | null
  /** T3 — the ledger LEASE claim fails. */
  failLedgerClaim: Error | null
  /** M3 — the PAYMENT_RECEIVED lookup (did a fan-out ever finish for this
   *  booking?) fails. Unknown must not be reported as done. */
  failAuditRead: Error | null
}

function newCtl(booking: Row | null = null): Ctl {
  return {
    booking,
    audits: [],
    webhookLogs: new Map(),
    payments: [],
    ledgerWrites: [],
    dropProgressWrites: false,
    enforceAuditPk: true,
    dead: false,
    killAfterAudit: false,
    failLedgerRead: null,
    failLedgerClaim: null,
    failAuditRead: null,
  }
}

let ctl: Ctl = newCtl()

const LEDGER_PREFIX = 'fulfillment__'

function reap(): void {
  if (ctl.dead) throw new Error(KILLED)
}

/** Postgres-ish WHERE: equality, `{ in: [] }`, `{ lt: Date }`, OR. Dates compare
 *  BY VALUE (the lease token guard must be tested, not accidentally satisfied by
 *  object identity). */
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
      if ('in' in val) {
        if (!(val.in as unknown[]).includes(row[key])) return false
        continue
      }
      if ('lt' in val) {
        const cur = row[key]
        if (!(cur instanceof Date) || !(cur.getTime() < (val.lt as Date).getTime())) return false
        continue
      }
    }
    if (row[key] !== val) return false
  }
  return true
}

function p2002(target: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${target}\`)`), {
    code: 'P2002',
    meta: { target: [target] },
  })
}

const fakePrisma = {
  booking: {
    async findUnique(args: { where?: Row }): Promise<Row | null> {
      reap()
      if (!ctl.booking || !matches(ctl.booking, args.where)) return null
      return { ...ctl.booking }
    },
    async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      reap()
      if (!ctl.booking || !matches(ctl.booking, args.where)) return { count: 0 }
      Object.assign(ctl.booking, args.data)
      return { count: 1 }
    },
  },
  auditLog: {
    async create(args: { data: Row }): Promise<Row> {
      reap()
      const id = args.data.id
      if (ctl.enforceAuditPk && id && ctl.audits.some((a) => a.id === id)) throw p2002('id')
      ctl.audits.push({ ...args.data })
      // THE KILL. The row is committed; the process dies before anything else it
      // was going to do — including recording that the row exists.
      if (ctl.killAfterAudit) ctl.dead = true
      return args.data
    },
    /** ITEM M3 — "has a fan-out for this booking ever reached its end?", which
     *  is what separates a booking fulfilled BEFORE this ledger existed from one
     *  whose fan-out was claimed and abandoned. */
    async findMany(args: { where?: Row; select?: Row; take?: number }): Promise<Row[]> {
      reap()
      if (ctl.failAuditRead) throw ctl.failAuditRead
      return ctl.audits
        .filter((a) => matches(a, args.where))
        .slice(0, args.take ?? 100)
        .map((a) => ({ ...a }))
    },
  },
  payment: {
    async findUnique(args: { where: Row }): Promise<Row | null> {
      reap()
      return ctl.payments.find((p) => matches(p, args.where)) ?? null
    },
  },
  webhookLog: {
    async upsert(args: { where: { eventId: string }; update: Row; create: Row }): Promise<Row> {
      reap()
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
      reap()
      const isLedger = typeof args.where.eventId === 'string' && args.where.eventId.startsWith(LEDGER_PREFIX)
      const isLeaseClaim = args.where.OR !== undefined
      if (isLedger && isLeaseClaim && ctl.failLedgerClaim) throw ctl.failLedgerClaim
      // THE MUTANT: a database that never received the incremental writes. The
      // lease claim (which also writes 'in-progress') is not a progress write.
      if (isLedger && !isLeaseClaim && ctl.dropProgressWrites && args.data.status === 'in-progress') {
        return { count: 1 }
      }
      let count = 0
      for (const row of Array.from(ctl.webhookLogs.values())) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data)
          count += 1
          if (isLedger) {
            ctl.ledgerWrites.push({
              status: String(args.data.status ?? row.status),
              done: [...(((args.data.payload as Row)?.done as string[]) ?? ((row.payload as Row)?.done as string[]) ?? [])],
            })
          }
        }
      }
      return { count }
    },
    async findUnique(args: { where: { eventId: string }; select?: Row }): Promise<Row | null> {
      reap()
      if (ctl.failLedgerRead && args.where.eventId.startsWith(LEDGER_PREFIX)) throw ctl.failLedgerRead
      return ctl.webhookLogs.get(args.where.eventId) ?? null
    },
    /** ITEM M3 — `eventId` is @unique, and THAT is what makes adopting an
     *  orphaned fan-out atomic: of N triggers arriving together, exactly one
     *  create succeeds and the rest get a unique violation. */
    async create(args: { data: Row }): Promise<Row> {
      reap()
      const eventId = String(args.data.eventId)
      if (ctl.webhookLogs.has(eventId)) throw p2002('eventId')
      const created = { id: `wl_${ctl.webhookLogs.size + 1}`, processedAt: null, ...args.data }
      ctl.webhookLogs.set(eventId, created)
      return created
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
  events: typeof import('../stripe-events')
  fulfillment: typeof import('../fulfillment')
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  scheduling: typeof import('../scheduling')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    events: await import('../stripe-events'),
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
  assert.equal(process.env.DISCORD_BOT_TOKEN, undefined, 'a test must never be able to post to the live Discord')
  return mods
}

// ── The row the SHIPPED WRITER persists ─────────────────────────────────────
async function paidBookingRow(): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: '2027-07-15',
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    deposit: { mode: 'stripe_link' },
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
      reference: 'WMIC-1042',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours,
    },
    [],
  )
  assert.equal(data.status, 'PENDING_PAYMENT', 'precondition: the default path creates an unpaid hold')
  return {
    id: 'bk_fp',
    customerToken: 'tok_fp',
    displayId: 'WMIC-1042',
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...(data as Row),
  }
}

// ── Fake fulfilment deps (the queue edge) ───────────────────────────────────
type DepCalls = { email: number; sms: number; discord: string[]; marketing: number; ownerNotice: number; bookingPaid: number }

function fakeDeps(opts: { queuesUp?: boolean; noticeDelivered?: boolean } = {}): {
  deps: import('../fulfillment').FulfillDeps
  calls: DepCalls
} {
  const calls: DepCalls = { email: 0, sms: 0, discord: [], marketing: 0, ownerNotice: 0, bookingPaid: 0 }
  const up = (): boolean => opts.queuesUp ?? true
  const guard = async (): Promise<void> => {
    reap() // a killed process does not enqueue anything either
    if (!up()) throw new Error('Redis unreachable (test)')
  }
  return {
    calls,
    deps: {
      emailQueue: { add: async () => { await guard(); calls.email += 1; return 'job' } },
      smsQueue: { add: async () => { await guard(); calls.sms += 1; return 'job' } },
      discordQueue: {
        add: async (name: string) => { await guard(); calls.discord.push(name); return 'job' },
      },
      marketingQueue: { add: async () => { await guard(); calls.marketing += 1; return 'job' } },
      outboxEnabled: () => false,
      emitPaymentCompleted: async () => { await guard(); calls.email += 1; return true },
      ingestBookingToTracker: async () => { reap() },
      onBookingPaid: async () => { reap(); calls.bookingPaid += 1 },
      postOwnerNotice: async () => {
        reap()
        calls.ownerNotice += 1
        return opts.noticeDelivered ? { delivered: true } : { delivered: false, reason: 'no configured channel (test)' }
      },
    },
  }
}

async function fulfill(deps: import('../fulfillment').FulfillDeps, intent: string | null = 'pi_fp') {
  const m = await load()
  return m.fulfillment.fulfillPaidCheckout(
    { bookingId: 'bk_fp', paymentIntentId: intent, amountTotalCents: 4900, source: 'webhook' },
    deps,
  )
}

const ledgerRow = (): Row | undefined => ctl.webhookLogs.get('fulfillment__bk_fp')
const durableDone = (): string[] => [...(((ledgerRow()?.payload as Row)?.done as string[]) ?? [])]
const paymentAudits = (): Row[] => ctl.audits.filter((a) => a.action === 'PAYMENT_RECEIVED')

/** The retry arrives after the dead runner's lease has expired — the real
 *  timeline, since nothing releases a lease held by a process that is gone. */
async function ageLeasePastExpiry(): Promise<void> {
  const m = await load()
  const row = ledgerRow()
  assert.ok(row, 'precondition: the killed run must have left a ledger row behind')
  row.processedAt = new Date(Date.now() - m.fulfillment.FULFILMENT_LEASE_MS - 1_000)
}

/** Run 1: fan out, commit the PAYMENT_RECEIVED row, then die — before the single
 *  ledger flush the pre-fix code depended on. The killed run's answer is thrown
 *  away on purpose: a dead process reports to nobody. */
async function killedFirstRun(deps: import('../fulfillment').FulfillDeps): Promise<void> {
  ctl.killAfterAudit = true
  await fulfill(deps).catch(() => undefined)
  assert.equal(ctl.dead, true, 'precondition: the kill must actually have fired (after the audit row committed)')
  ctl.killAfterAudit = false
  ctl.dead = false // a NEW process handles the retry
}

// ════════════════════════════════════════════════════════════════════════════
//  0. PRECONDITIONS — without these, nothing below means anything
// ════════════════════════════════════════════════════════════════════════════

test('0.1 the kill fires after the audit row commits and stops every later write', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps()
  await killedFirstRun(deps)

  assert.equal(paymentAudits().length, 1, 'the audit row IS committed — the kill is AFTER it')
  assert.equal(calls.discord.length, 2, 'and the fan-out DID run before the kill')
  assert.equal(
    ledgerRow()?.status,
    'in-progress',
    'the final flush never landed, so the row is still the dead run\'s — that is the whole T2 window',
  )
})

test('0.2 the mutant switch models the pre-fix database exactly: no progress write lands', async () => {
  ctl = newCtl(await paidBookingRow())
  ctl.dropProgressWrites = true
  const { deps } = fakeDeps()
  await killedFirstRun(deps)

  assert.deepEqual(
    durableDone(),
    [],
    'with the incremental writes dropped the durable ledger is empty — which is what the pre-fix code left behind, ' +
      'because its only durable write was the flush the kill prevents',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  1. T2 — THE PROGRESS LIST IS DURABLE AS IT HAPPENS
// ════════════════════════════════════════════════════════════════════════════

test('T2: a runner killed before the ledger flush loses NOTHING — the resume re-drives no handoff', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps()

  await killedFirstRun(deps)

  // What the database holds at the moment of death — the only thing the resume
  // can see. THE T2 DEFECT: this was `[]`.
  assert.deepEqual(
    durableDone().slice().sort(),
    ['discord:booking-created', 'discord:create-job-channels', 'email:pre-approval', 'marketing:enroll', 'sms:final-confirmation'],
    'every handoff that got through was written down AS IT HAPPENED, not at the end of a run that never finished',
  )
  assert.equal(calls.email, 1)
  assert.equal(calls.sms, 1)

  // The retry (Stripe re-delivery / the browser success redirect), in a new
  // process, once the dead runner's lease has expired.
  await ageLeasePastExpiry()
  const second = await fulfill(deps)

  assert.equal(second.processed, true)
  assert.equal(second.resumed, true, 'it is a RESUME of the recorded plan')
  assert.deepEqual(second.handoffs ?? [], [], 'and there was nothing left outstanding to re-drive')
  assert.equal(calls.email, 1, 'THE T2 REPRODUCTION: the customer got a SECOND pre-approval email')
  assert.equal(calls.sms, 1, 'and a SECOND text')
  assert.equal(calls.marketing, 1, 'and a SECOND marketing enrolment')
  assert.deepEqual(calls.discord, ['booking-created', 'create-job-channels'], 'and TWO Discord cards')
  assert.equal(
    paymentAudits().length,
    1,
    'and TWO PAYMENT_RECEIVED rows for one $49 — which also corrupts the one-per-booking marker ' +
      'src/lib/booking-approval.ts reads',
  )
  assert.equal(paymentAudits()[0].id, m.fulfillment.fulfillmentAuditId('bk_fp', 'pi_fp'))
  assert.equal(ledgerRow()?.status, 'complete')
})

test('T2 (mutation): with the progress writes dropped AND the primary key off, the reproduction returns in full', async () => {
  ctl = newCtl(await paidBookingRow())
  ctl.dropProgressWrites = true // the pre-fix ledger behaviour
  ctl.enforceAuditPk = false // a database without the deterministic audit key
  const { deps, calls } = fakeDeps()

  await killedFirstRun(deps)
  assert.deepEqual(durableDone(), [], 'precondition: the kill left an empty durable ledger')

  await ageLeasePastExpiry()
  const second = await fulfill(deps)

  assert.equal(second.resumed, true)
  assert.equal(calls.email, 2, 'the harness CAN see the defect: a second pre-approval email')
  assert.equal(calls.sms, 2, 'a second text')
  assert.equal(calls.marketing, 2, 'a second marketing enrolment')
  assert.deepEqual(calls.discord, ['booking-created', 'create-job-channels', 'booking-created', 'create-job-channels'])
  assert.equal(paymentAudits().length, 2, 'and TWO PAYMENT_RECEIVED rows for one $49')
})

test('T2: the deterministic audit key alone keeps the money record exactly-once (layer 3, on its own)', async () => {
  // Progress writes dropped, primary key ON: the messages double (that is layer
  // 1 missing, and it is why layer 1 exists) but the LEDGER cannot double —
  // Postgres refuses the second row. Neither layer is allowed to hide the other.
  ctl = newCtl(await paidBookingRow())
  ctl.dropProgressWrites = true
  const { deps, calls } = fakeDeps()

  await killedFirstRun(deps)
  await ageLeasePastExpiry()
  await fulfill(deps)

  assert.equal(calls.email, 2, 'without incremental persistence the handoffs DO get re-driven')
  assert.equal(paymentAudits().length, 1, 'but one authorization can only ever have one PAYMENT_RECEIVED row')
})

test('T2: incremental persistence alone stops the re-sends (layer 1, on its own)', async () => {
  ctl = newCtl(await paidBookingRow())
  ctl.enforceAuditPk = false // no database constraint to lean on
  const { deps, calls } = fakeDeps()

  await killedFirstRun(deps)
  await ageLeasePastExpiry()
  await fulfill(deps)

  assert.equal(calls.email, 1, 'the durable record of what went out is enough on its own for the handoffs')
  assert.equal(calls.sms, 1)
  assert.deepEqual(calls.discord, ['booking-created', 'create-job-channels'])
  assert.equal(
    paymentAudits().length,
    2,
    'and the audit is the one step the ledger cannot cover on its own — the write that records it is the statement ' +
      'AFTER it, which is exactly the window the kill lands in. That is what the primary key is for.',
  )
})

test('T2: progress is durable BEFORE the once-per-booking steps run, not after them', async () => {
  // The ordering property the fix rests on, observed rather than asserted about
  // the source: by the time the PAYMENT_RECEIVED row is written, every handoff
  // that succeeded is already on disk.
  ctl = newCtl(await paidBookingRow())
  const { deps } = fakeDeps()
  let doneAtAuditTime: string[] = []
  const realCreate = fakePrisma.auditLog.create
  fakePrisma.auditLog.create = async (args: { data: Row }) => {
    doneAtAuditTime = durableDone()
    return realCreate(args)
  }
  try {
    await fulfill(deps)
  } finally {
    fakePrisma.auditLog.create = realCreate
  }

  assert.deepEqual(
    doneAtAuditTime.slice().sort(),
    ['discord:booking-created', 'discord:create-job-channels', 'email:pre-approval', 'marketing:enroll', 'sms:final-confirmation'],
    'the fan-out was already recorded durably — a kill here can cost at most the audit row, which the primary key covers',
  )
})

test('T2: a progress write NEVER settles the row — the running fan-out keeps its own lease', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps } = fakeDeps()
  await fulfill(deps)

  const statuses = ctl.ledgerWrites.map((w) => w.status)
  assert.ok(statuses.length > 1, 'progress must be written more than once — that IS the fix')
  assert.deepEqual(
    statuses.slice(0, -1).filter((s) => s !== 'in-progress'),
    [],
    'every write but the last keeps the row in-progress: settling it mid-fan-out would hand this run\'s own lease away',
  )
  assert.equal(statuses[statuses.length - 1], 'complete', 'and only the final write settles it')
  // `done` only ever grows: a later write can never lose an earlier one.
  const sizes = ctl.ledgerWrites.map((w) => w.done.length)
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), `the durable done-list must be monotonic — got ${sizes.join(',')}`)
})

test('T2: the audit key is the MONEY, not just the booking — a second authorization gets its own row', async () => {
  const m = await load()
  assert.equal(
    m.fulfillment.fulfillmentAuditId('bk_1', 'pi_a'),
    m.fulfillment.fulfillmentAuditId('bk_1', 'pi_a'),
    'the id IS the claim — it must be stable',
  )
  assert.notEqual(m.fulfillment.fulfillmentAuditId('bk_1', 'pi_a'), m.fulfillment.fulfillmentAuditId('bk_1', 'pi_b'))
  assert.notEqual(m.fulfillment.fulfillmentAuditId('bk_1', 'pi_a'), m.fulfillment.fulfillmentAuditId('bk_2', 'pi_a'))
  assert.notEqual(
    m.fulfillment.fulfillmentAuditId('bk_1', 'pi_a'),
    'pyrcv_bk_1',
    'and it must not collide with the approval-side claim in src/lib/booking-approval.ts (the CAPTURE)',
  )

  // End to end: the same booking authorizes a SECOND intent (a re-checkout).
  ctl = newCtl(await paidBookingRow())
  const { deps } = fakeDeps()
  await fulfill(deps, 'pi_first')
  assert.equal(paymentAudits().length, 1)

  ctl.booking!.status = 'PENDING_PAYMENT' // the customer starts over
  await fulfill(deps, 'pi_second')
  assert.deepEqual(
    paymentAudits().map((a) => a.id),
    [
      (await load()).fulfillment.fulfillmentAuditId('bk_fp', 'pi_first'),
      (await load()).fulfillment.fulfillmentAuditId('bk_fp', 'pi_second'),
    ],
    'the money is keyed to the INTENT: a genuinely new authorization must be able to have its own record',
  )
})

test('T2: a re-driven audit that hits the primary key is treated as recorded, not as a failure', async () => {
  // The convergence property: the second run must finish (ledger 'complete'),
  // not spin forever on a row that is already there.
  ctl = newCtl(await paidBookingRow())
  ctl.dropProgressWrites = true
  const { deps } = fakeDeps()
  await killedFirstRun(deps)
  await ageLeasePastExpiry()

  const second = await fulfill(deps)

  assert.equal(second.processed, true)
  assert.equal(paymentAudits().length, 1)
  assert.equal(ledgerRow()?.status, 'complete', 'the unique violation must settle the ledger, not stall it')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. T3 — A SWALLOWED LEDGER READ IS NOT A FINISHED CHECKOUT
// ════════════════════════════════════════════════════════════════════════════

/** A booking mid-recovery: claimed, with two handoffs still outstanding. */
async function outstandingLedger(): Promise<void> {
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  ctl.webhookLogs.set('fulfillment__bk_fp', {
    id: 'wl_ledger',
    eventId: 'fulfillment__bk_fp',
    source: 'fulfillment',
    eventType: 'checkout-fanout',
    status: 'outstanding',
    processedAt: new Date(Date.now() - 30_000),
    payload: {
      version: 1,
      planned: ['email:pre-approval', 'sms:final-confirmation', 'discord:booking-created', 'marketing:enroll', 'discord:create-job-channels'],
      done: ['sms:final-confirmation', 'marketing:enroll'],
      attempts: 1,
    },
  })
}

test('T3: the lease is taken and the payload read fails ⇒ NOT reported as finished, and the lease is given back', async () => {
  const m = await load()
  await outstandingLedger()
  const { deps, calls } = fakeDeps()
  ctl.failLedgerRead = Object.assign(new Error("Can't reach database server at `ep-neon.aws.neon.tech`:`5432`"), { code: 'P1001' })

  const result = await fulfill(deps)

  assert.equal(
    result.reason,
    m.fulfillment.LEDGER_UNREADABLE,
    'THE T3 DEFECT: this returned `already-fulfilled-or-not-pending` — a reason the caller does NOT throw on — so the ' +
      'webhook was marked processed and the Stripe event retired while the customer email and the Discord card were ' +
      'still outstanding',
  )
  assert.notEqual(result.reason, 'already-fulfilled-or-not-pending')
  assert.equal(result.processed, false)
  assert.equal(calls.email, 0, 'a run that does not know what was sent must send nothing')
  assert.equal(calls.discord.length, 0)
  assert.equal(
    ledgerRow()?.status,
    'outstanding',
    'THE OTHER HALF: the lease was left HELD with nothing to release it — for 60s nothing could resume this booking',
  )

  // And the proof that releasing it matters: the very next delivery resumes
  // immediately, without waiting out a lease nobody holds.
  ctl.failLedgerRead = null
  const second = await fulfill(deps)

  assert.equal(second.processed, true)
  assert.equal(second.resumed, true)
  assert.deepEqual(
    (second.handoffs ?? []).map((h) => h.label).sort(),
    ['discord:booking-created', 'discord:create-job-channels', 'email:pre-approval'],
    'and exactly the outstanding handoffs finally go out — the ones already delivered are not re-sent',
  )
  assert.equal(calls.sms, 0, 'the SMS was already delivered before the failure; it must not be re-sent')
})

test('T3: a failed lease CLAIM is not "nothing to do" either', async () => {
  const m = await load()
  await outstandingLedger()
  const { deps, calls } = fakeDeps()
  ctl.failLedgerClaim = Object.assign(new Error('canceling statement due to statement timeout'), { code: 'P2024' })

  const result = await fulfill(deps)

  assert.equal(
    result.reason,
    m.fulfillment.LEDGER_UNREADABLE,
    'the claim update failing used to be swallowed into `claimedLedger = 0`, which fell into the "no ledger row ⇒ ' +
      'already fulfilled" branch — a database outage reported as a finished checkout',
  )
  assert.equal(calls.email, 0)
  assert.equal(ledgerRow()?.status, 'outstanding', 'no lease was taken, so none may be left behind')
})

test('T3: an unreadable ledger PAYLOAD is unknown, not finished — refuse to guess AND refuse to lie', async () => {
  const m = await load()
  await outstandingLedger()
  ledgerRow()!.payload = { corrupted: 'not a ledger' }
  const { deps, calls } = fakeDeps()

  const result = await fulfill(deps)

  assert.equal(result.reason, m.fulfillment.LEDGER_UNREADABLE)
  assert.equal(calls.email, 0, 'refusing to guess what was already sent is still right')
  assert.equal(calls.sms, 0)
  assert.equal(
    ledgerRow()?.status,
    'outstanding',
    'but the lease must not be held by a run that gave up, and the checkout must not be reported as fulfilled',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  2b. ITEM M3 — "NO LEDGER ROW" IS NOT AUTOMATICALLY A FINISHED CHECKOUT
//
//  THE DEFECT this file used to ASSERT AS CORRECT: a booking sitting in
//  PENDING_APPROVAL with no ledger row was reported
//  `already-fulfilled-or-not-pending` — a reason the caller does NOT throw on,
//  so the webhook is stamped 'processed' and the Stripe event is retired.
//
//  But that is EXACTLY the shape a killed runner leaves behind. The atomic
//  booking claim is taken FIRST; the ledger row is written a few statements
//  later. Die in between — a serverless timeout, a deploy, the process reaped —
//  and the booking reads PENDING_APPROVAL with no ledger and NOT ONE handoff
//  attempted: the customer has authorized $49 and has been sent nothing, the
//  owner has no card, and the only retry that could ever fix it was told the
//  work was done. A permanent loss, asserted as 'finished', with the test name
//  stating the conclusion — so neither file could see the hole.
//
//  THE FIX: the booking's own status and the audit ledger are asked instead of
//  assumed, and an orphaned fan-out is ADOPTED and run. Adopting cannot
//  double-send: the ledger row is written BEFORE the first handoff, so a run
//  that left no ledger row sent nothing.
// ════════════════════════════════════════════════════════════════════════════

test('M3: no ledger + the booking in the CLAIMED state is an ORPHANED fan-out — adopted and delivered', async () => {
  // The exact post-kill state: the claim was consumed and nothing was recorded.
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  const { deps, calls } = fakeDeps()

  const result = await fulfill(deps)

  assert.equal(
    result.reason,
    undefined,
    'THE M3 DEFECT: this returned `already-fulfilled-or-not-pending`, which retires the Stripe event — over a ' +
      'customer who paid $49 and was never contacted',
  )
  assert.equal(result.processed, true, 'the fan-out really ran')
  assert.equal(result.resumed, false, 'and it is NOT a resume: nothing had been delivered to resume from')
  assert.deepEqual(result.alreadyDelivered, [], 'nothing was already delivered')
  assert.equal(calls.email, 1, 'the customer finally gets their pre-approval email')
  assert.equal(calls.sms, 1)
  assert.deepEqual(calls.discord, ['booking-created', 'create-job-channels'], 'and the owner finally gets his card')
  assert.equal(calls.marketing, 1)
  assert.equal(paymentAudits().length, 1, 'the authorization is recorded exactly once')
  assert.equal(ledgerRow()?.status, 'complete', 'and the adopted fan-out settles its own ledger')
  assert.deepEqual(
    durableDone().slice().sort(),
    [
      'audit:payment-received',
      'discord:booking-created',
      'discord:create-job-channels',
      'email:pre-approval',
      'journey:booking-paid',
      'marketing:enroll',
      'sms:final-confirmation',
    ],
    'every step is written down, so a kill during THIS run is resumable like any other',
  )
})

test('M3 (mutation): the reason the pre-fix code returned retires the event with nothing sent', async () => {
  // The defect's mechanism, still live and still measurable: feed the SHIPPED
  // caller the answer the old branch gave for this state and watch the only
  // retry Stripe would ever perform disappear.
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  const { deps, calls } = fakeDeps()

  const retired = await callerVerdict('evt_m3_prefix', { processed: false, reason: 'already-fulfilled-or-not-pending' })

  assert.equal(retired.status, 200, 'the caller accepts it …')
  assert.equal(retired.logStatus, 'processed', '… and Stripe never re-delivers the event')
  assert.equal(calls.email, 0, 'while the customer who paid has still been sent nothing')
  assert.equal(calls.discord.length, 0, 'and the owner still has no card')
  assert.equal(ctl.webhookLogs.get('fulfillment__bk_fp'), undefined, 'nothing was ever recorded for this booking')
  void deps
})

test('M3: a booking NOT in the claimed state with no ledger IS finished — nothing to fulfil', async () => {
  // The one non-throwing skip that survives: the database answered, and its
  // answer was "this booking was never claimed by a fan-out / has moved on".
  for (const status of ['CONFIRMED', 'CANCELLED', 'COMPLETED']) {
    ctl = newCtl({ ...(await paidBookingRow()), status })
    const { deps, calls } = fakeDeps()

    const result = await fulfill(deps)

    assert.equal(result.processed, false, status)
    assert.equal(result.reason, 'already-fulfilled-or-not-pending', status)
    assert.equal(calls.email, 0, status)
    assert.equal(calls.ownerNotice, 0, status)
    assert.equal(ledgerRow(), undefined, `${status}: and no ledger is invented for it`)
  }
})

test('M3: no ledger but the AUTHORIZATION is recorded — a pre-ledger fan-out is finished', async () => {
  // A booking fulfilled before the ledger existed: its PAYMENT_RECEIVED row is
  // the last durable step of a fan-out that ran to its end, so re-running it
  // would be the double-send this branch must not cause.
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  ctl.audits.push({
    id: 'legacy_cuid_from_before_the_deterministic_key',
    action: 'PAYMENT_RECEIVED',
    bookingId: 'bk_fp',
    details: { authorized: true, amount: 4900, paymentIntentId: 'pi_fp', source: 'webhook' },
  })
  const { deps, calls } = fakeDeps()

  const result = await fulfill(deps)

  assert.equal(result.reason, 'already-fulfilled-or-not-pending')
  assert.equal(calls.email, 0, 'the customer must not get a second pre-approval email')
  assert.equal(calls.sms, 0)
  assert.deepEqual(calls.discord, [])
  assert.equal(ledgerRow(), undefined)
})

test('M3: if the "did a fan-out ever finish?" read FAILS, that is unknown — never finished', async () => {
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  ctl.failAuditRead = Object.assign(new Error("Can't reach database server at `ep-neon.aws.neon.tech`:`5432`"), { code: 'P1001' })
  const { deps, calls } = fakeDeps()
  const m = await load()

  const result = await fulfill(deps)

  assert.equal(result.reason, m.fulfillment.LEDGER_UNREADABLE, 'a failed read is not a state (ITEM T3, same rule)')
  assert.equal(result.processed, false)
  assert.equal(calls.email, 0, 'and a run that does not know what happened sends nothing')
  assert.equal(ledgerRow(), undefined, 'and adopts nothing')
})

test('M3: two triggers cannot both adopt the same orphan', async () => {
  // The webhook and the browser success-redirect arrive together, which is the
  // ordinary case. `eventId` is unique, so the ledger row IS the claim.
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  const { deps, calls } = fakeDeps()

  const results = await Promise.all([fulfill(deps), fulfill(deps)])

  const processed = results.filter((r) => r.processed)
  assert.equal(processed.length, 1, 'exactly one trigger may adopt the fan-out')
  const loser = results.find((r) => !r.processed)
  assert.equal(loser?.reason, (await load()).fulfillment.RESUME_IN_PROGRESS, 'and the other must NOT report it finished')
  assert.equal(calls.email, 1, 'one adoption, one email')
  assert.equal(calls.sms, 1)
  assert.deepEqual(calls.discord, ['booking-created', 'create-job-channels'], 'and one of each card')
  assert.equal(paymentAudits().length, 1)
})

test('T3: a COMPLETE ledger is finished too', async () => {
  await outstandingLedger()
  const row = ledgerRow()!
  row.status = 'complete'
  ;(row.payload as Row).done = [...((row.payload as Row).planned as string[]), 'audit:payment-received', 'journey:booking-paid']
  const { deps, calls } = fakeDeps()

  const result = await fulfill(deps)

  assert.equal(result.reason, 'already-fulfilled-or-not-pending')
  assert.equal(calls.email, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  3. T3 — WHAT THE CALLER DOES WITH EACH REASON. Returning normally retires
//     the Stripe event, so every non-throwing reason must mean FINISHED.
// ════════════════════════════════════════════════════════════════════════════

const signer = new Stripe('sk_test_fulfilment_progress', { apiVersion: '2024-06-20' })

function signed(event: Record<string, unknown>): { body: string; signature: string } {
  const body = JSON.stringify(event)
  return { body, signature: signer.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET }) }
}

function checkoutEvent(id: string): Record<string, unknown> {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_fp', payment_intent: 'pi_fp', amount_total: 4900, metadata: { bookingId: 'bk_fp' } } },
  }
}

/** Drive the SHIPPED webhook entry point with a fulfilment that returns exactly
 *  `result`, and report what the event ended up as. */
async function callerVerdict(
  eventId: string,
  result: { processed: boolean; reason?: string },
): Promise<{ status: number; logStatus: string | undefined }> {
  const m = await load()
  const { body, signature } = signed(checkoutEvent(eventId))
  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: (event) =>
      m.events.processStripeEventJob(event, {
        fulfill: async () => ({ bookingId: 'bk_fp', ...result }) as never,
      }),
  })
  return { status: res.status, logStatus: ctl.webhookLogs.get(eventId)?.status as string | undefined }
}

test('T3 (mutation): the reason the pre-fix code returned RETIRES the event — that is what the swallow cost', async () => {
  ctl = newCtl(await paidBookingRow())

  const retired = await callerVerdict('evt_prefix_reason', { processed: false, reason: 'already-fulfilled-or-not-pending' })
  assert.equal(retired.status, 200, 'the caller does not throw on this reason …')
  assert.equal(
    retired.logStatus,
    'processed',
    '… so the event is recorded processed and Stripe never sends it again. Returning it after a FAILED READ is what ' +
      'made a swallowed error a permanently lost fan-out — the mechanism is still live, which is how this harness ' +
      'can see the defect.',
  )

  const retried = await callerVerdict('evt_fixed_reason', {
    processed: false,
    reason: (await load()).fulfillment.LEDGER_UNREADABLE,
  })
  assert.equal(retried.status, 500, 'the fixed reason is retryable, so Stripe re-delivers')
  assert.equal(retried.logStatus, 'failed', 'and the log stays honest')
})

test('T3: every reason the shipped fulfilment can return is CLASSIFIED, and each non-throwing one means finished', async () => {
  const m = await load()

  // finished = the caller may report success (2xx, event retired)
  const CLASSIFIED: Record<string, 'finished' | 'retry'> = {
    'already-fulfilled-or-not-pending': 'finished',
    [m.fulfillment.MIGRATION_NOT_APPLIED]: 'retry',
    [m.fulfillment.NO_DURABLE_HANDOFF]: 'retry',
    [m.fulfillment.RESUME_IN_PROGRESS]: 'retry',
    [m.fulfillment.LEDGER_UNREADABLE]: 'retry',
    'booking-not-found': 'retry',
  }

  // DRIFT GUARD: read the reasons out of the shipped source, so a new one that
  // nobody classified fails here instead of quietly retiring Stripe events.
  const src = readFileSync(resolve(process.cwd(), 'src/lib/fulfillment.ts'), 'utf8')
  const found = new Set<string>()
  for (const match of Array.from(src.matchAll(/processed:\s*false,\s*bookingId,\s*reason:\s*(?:'([^']+)'|([A-Z_]+))/g))) {
    const literal = match[1]
    const constant = match[2]
    if (literal) found.add(literal)
    else {
      const value = (m.fulfillment as unknown as Record<string, unknown>)[constant]
      assert.equal(typeof value, 'string', `the shipped code returns reason ${constant}, which is not an exported constant`)
      found.add(value as string)
    }
  }
  assert.ok(found.size >= 6, `the scan must actually find the returns — found ${found.size}`)
  for (const reason of Array.from(found)) {
    assert.ok(CLASSIFIED[reason], `unclassified fulfilment reason "${reason}" — say whether it means FINISHED or RETRY`)
  }

  // And then EXECUTE the classification through the shipped caller.
  let n = 0
  for (const [reason, verdict] of Object.entries(CLASSIFIED)) {
    ctl = newCtl(await paidBookingRow())
    n += 1
    const out = await callerVerdict(`evt_reason_${n}`, { processed: false, reason })
    if (verdict === 'finished') {
      assert.equal(out.status, 200, `${reason} is classified finished, so the caller must accept it`)
      assert.equal(out.logStatus, 'processed')
    } else {
      assert.equal(out.status, 500, `${reason} does NOT mean finished — the caller must NOT retire the Stripe event`)
      assert.equal(out.logStatus, 'failed', `${reason} must leave the webhook log honest`)
    }
  }

  // processed:true is the fan-out having run.
  ctl = newCtl(await paidBookingRow())
  const done = await callerVerdict('evt_reason_ok', { processed: true })
  assert.equal(done.status, 200)
  assert.equal(done.logStatus, 'processed')
})

test('T3: a booking the fulfilment cannot find is money without a record — retry, never "processed"', async () => {
  const m = await load()
  ctl = newCtl(null) // the row Stripe named does not exist
  const { deps, calls } = fakeDeps()

  const result = await fulfill(deps)
  assert.equal(result.reason, 'booking-not-found')
  assert.equal(calls.email, 0)

  const { body, signature } = signed(checkoutEvent('evt_no_booking'))
  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: (event) =>
      m.events.processStripeEventJob(event, { fulfill: (params) => m.fulfillment.fulfillPaidCheckout(params, deps) }),
  })
  assert.equal(res.status, 500, 'the $49 is authorized and nothing was done — a 200 would retire the only retry')
  assert.equal(ctl.webhookLogs.get('evt_no_booking')?.status, 'failed')
})

test('T3: the event-claim path does not launder a failed READ into "held by another runner" either', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  // The row exists and is held, and the status read fails. Both outcomes throw
  // (both are retryable), but the worker treats a lease-held error as ordinary
  // contention — a database that cannot answer must not be logged as that.
  ctl.webhookLogs.set('evt_unreadable_state', {
    id: 'wl_x',
    eventId: 'evt_unreadable_state',
    status: 'processing',
    processedAt: new Date(),
  })
  const realFind = fakePrisma.webhookLog.findUnique
  fakePrisma.webhookLog.findUnique = async () => {
    throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' })
  }
  try {
    await assert.rejects(
      () => m.events.processStripeEventJob({ id: 'evt_unreadable_state', type: 'charge.refunded', data: { object: {} } } as never),
      (err: unknown) => {
        assert.equal(m.events.isWebhookLeaseHeld(err), false, 'an unreadable row is not evidence that a runner holds it')
        assert.match(String((err as Error).message), /could not be read/)
        return true
      },
    )
  } finally {
    fakePrisma.webhookLog.findUnique = realFind
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE ROUTE — the status code IS the retry contract
// ════════════════════════════════════════════════════════════════════════════

test('T3: the webhook route passes the core status through unchanged', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/api/stripe/webhook/route.ts'), 'utf8')
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(code, /NextResponse\.json\(result\.body,\s*\{\s*status:\s*result\.status\s*\}\)/)
  assert.equal(/status:\s*200/.test(code), false, 'a hard-coded 200 here would re-open B3/R3/T3 in one line')
})
