// ════════════════════════════════════════════════════════════════════════════
//  webhook-durability.test.ts — ITEMS B3 + B4
//
//  THE TWO DEFECTS, ONE ROOT CAUSE: a failure was swallowed and success was
//  reported anyway.
//
//   B3  processStripeWebhook returned 200 when the event had been neither
//       durably QUEUED nor PROCESSED. Stripe never retries a 200, the
//       webhook_logs 'failed' row has no reader, and the event was gone —
//       worst for charge.dispute.created, which has no second trigger and a
//       hard evidence deadline. During a code-before-SQL window (this branch
//       has three unapplied migrations RIGHT NOW) every inline fallback throws
//       MIGRATION_NOT_APPLIED, so that window was silent by construction.
//
//   B4  fulfillPaidCheckout logged "all jobs queued" and returned
//       processed:true even when all five notification handoffs failed. The
//       customer got no email, Diego got no approval card, and because
//       `processed` consumed the atomic claim it also killed the success
//       redirect, the Stripe retry and the webhook log's honesty at once.
//
//  WHAT IS DELIBERATELY NOT RE-TESTED (verified correct; a fixer must not
//  rewrite it): fulfillPaidCheckout's atomic claim, the success-redirect backup
//  trigger, WebhookLog.eventId @unique, the 400/500 signature branches.
//
//  HOW IT TESTS THEM (round-3 rules):
//   • the booking row is what the SHIPPED WRITER persists — AdminBookingSchema
//     → resolveMoveSchedule → buildBookingCreateData on the DEFAULT owner path.
//     Nothing is hand-shaped.
//   • the SHIPPED functions run against a fake `prisma` installed on
//     `globalThis` before src/lib/db.ts is first imported. Only the queue edge,
//     Stripe signing and Discord posting are faked — through the same kind of
//     injected deps src/lib/booking-approval.ts already uses.
//   • the webhook signature is REAL (Stripe's own HMAC test helper), so the
//     verify → handoff → inline → status path is the shipped one end to end.
//
//  Offline: no database, no Redis, no network.
//    npx tsx --test src/lib/__tests__/webhook-durability.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Stripe from 'stripe'

// ── Environment, BEFORE any app import ──────────────────────────────────────
// A real DISCORD_BOT_TOKEN would make the owner-notice fallback post to the
// owner's live server from a test run. Deleted, and asserted below.
process.env.STRIPE_SECRET_KEY = 'sk_test_webhook_durability'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_webhook_durability'
process.env.APP_URL = 'https://example.test'
delete process.env.DISCORD_BOT_TOKEN
delete process.env.OUTBOX_ENABLED

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

// ── The fake database ───────────────────────────────────────────────────────
type Row = Record<string, any>

type Ctl = {
  booking: Row | null
  /** Thrown by every booking read — how the migration window looks. */
  bookingReadError?: Error
  bookingWrites: Row[]
  audits: Row[]
  webhookLogs: Map<string, Row>
  payments: Row[]
  paymentUpdates: number
  /** Runs inside the shipped handler, between the claim and the success stamp. */
  duringHandler?: () => void
  ops: string[]
}

function newCtl(booking: Row | null = null): Ctl {
  return {
    booking,
    bookingWrites: [],
    audits: [],
    webhookLogs: new Map(),
    payments: [],
    paymentUpdates: 0,
    ops: [],
  }
}

let ctl: Ctl = newCtl()

/** Postgres-ish WHERE: equality, `{ in: [] }`, `{ lt: Date }`, and OR.
 *  Dates compare BY VALUE, like Postgres does — the lease token guard
 *  (`processedAt: leaseAt`) would otherwise pass only because the fake happens
 *  to hold the same object, which would make it untested here. */
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

function p2022(column: string): Error {
  return Object.assign(new Error(`The column \`bookings.${column}\` does not exist in the current database.`), {
    code: 'P2022',
  })
}

const fakePrisma = {
  booking: {
    async findUnique(args: { where?: Row }): Promise<Row | null> {
      ctl.ops.push('booking.read')
      if (ctl.bookingReadError) throw ctl.bookingReadError
      if (!ctl.booking || !matches(ctl.booking, args.where)) return null
      return { ...ctl.booking }
    },
    async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      ctl.ops.push('booking.updateMany')
      if (!ctl.booking || !matches(ctl.booking, args.where)) return { count: 0 }
      ctl.bookingWrites.push({ ...args.data })
      Object.assign(ctl.booking, args.data)
      return { count: 1 }
    },
  },
  auditLog: {
    async create(args: { data: Row }): Promise<Row> {
      ctl.audits.push(args.data)
      return args.data
    },
    /** ITEM M3 — "did a fan-out for this booking ever reach its end?". The
     *  PAYMENT_RECEIVED row is the last durable step of one, so it is what
     *  separates a booking fulfilled BEFORE the ledger existed (leave it alone)
     *  from one whose fan-out was claimed and abandoned (run it). */
    async findMany(args: { where?: Row; select?: Row; take?: number }): Promise<Row[]> {
      return ctl.audits.filter((a) => matches(a, args.where)).slice(0, args.take ?? 100).map((a) => ({ ...a }))
    },
  },
  payment: {
    async findUnique(args: { where: Row }): Promise<Row | null> {
      return ctl.payments.find((p) => matches(p, args.where)) ?? null
    },
    async update(args: { where: Row; data: Row }): Promise<Row> {
      ctl.paymentUpdates += 1
      const row = ctl.payments.find((p) => matches(p, args.where))
      if (!row) throw new Error('payment not found')
      ctl.duringHandler?.()
      Object.assign(row, args.data)
      return row
    },
    async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
      let count = 0
      for (const p of ctl.payments) if (matches(p, args.where)) { Object.assign(p, args.data); count += 1 }
      return { count }
    },
  },
  webhookLog: {
    async upsert(args: { where: { eventId: string }; update: Row; create: Row }): Promise<Row> {
      ctl.ops.push('webhookLog.upsert')
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
      ctl.ops.push('webhookLog.updateMany')
      let count = 0
      for (const row of Array.from(ctl.webhookLogs.values())) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data)
          count += 1
        }
      }
      return { count }
    },
    async update(args: { where: Row; data: Row }): Promise<Row> {
      ctl.ops.push('webhookLog.update')
      const row = Array.from(ctl.webhookLogs.values()).find((r) => matches(r, args.where))
      if (!row) throw new Error('webhookLog row not found')
      Object.assign(row, args.data)
      return row
    },
    async findUnique(args: { where: { eventId: string } }): Promise<Row | null> {
      ctl.ops.push('webhookLog.findUnique')
      return ctl.webhookLogs.get(args.where.eventId) ?? null
    },
    /** ITEM M3 — `eventId` is @unique, which is what makes adopting an orphaned
     *  fan-out atomic: exactly one trigger can create the row. */
    async create(args: { data: Row }): Promise<Row> {
      ctl.ops.push('webhookLog.create')
      const eventId = String(args.data.eventId)
      if (ctl.webhookLogs.has(eventId)) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`eventId`)'), { code: 'P2002' })
      }
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
const MOVE_DAY = '2027-07-15'

async function paidBookingRow(): Promise<Row> {
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
    id: 'bk_wd',
    customerToken: 'tok_wd',
    displayId: 'WMIC-1042',
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...(data as Row),
  }
}

// ── Fake fulfillment deps (the queue edge) ──────────────────────────────────
type DepCalls = {
  email: number
  sms: number
  discord: string[]
  marketing: number
  ownerNotice: number
  tracker: number
  bookingPaid: number
  /** Every custom job id the shipped code passed, in order. */
  jobIds: string[]
}

type FakeDepOpts = {
  queuesUp?: boolean
  discordCardUp?: boolean
  noticeDelivered?: boolean
  /** OUTBOX_ENABLED=true is a live production configuration: the customer email
   *  is written to a Postgres outbox instead of the queue, and
   *  emitPaymentCompleted returns FALSE when that write was swallowed. */
  outbox?: 'off' | 'written' | 'swallowed'
  /** MODEL BULLMQ'S OWN DEDUPE: a second add under a job id the queue already
   *  holds creates nothing and counts as no send. OFF by default ON PURPOSE —
   *  with it on, the application-level ledger could be deleted and the
   *  duplicate-send tests would still pass, which is exactly the kind of
   *  overlapping guard that hides a regression. Each layer is tested alone. */
  dedupeByJobId?: boolean
}

/** A mutable controller so a test can change the queue edge BETWEEN runs while
 *  keeping the same call counters — which is the only way to observe "the retry
 *  did not re-send what the first run already sent". */
type DepCtl = { deps: import('../fulfillment').FulfillDeps; calls: DepCalls; set: (next: FakeDepOpts) => void }

function fakeDeps(initial: FakeDepOpts): DepCtl {
  let opts: FakeDepOpts = initial
  const calls: DepCalls = { email: 0, sms: 0, discord: [], marketing: 0, ownerNotice: 0, tracker: 0, bookingPaid: 0, jobIds: [] }
  const held = new Set<string>()
  const dead = (): Promise<never> => Promise.reject(new Error('Redis unreachable (test)'))
  const up = (): boolean => opts.queuesUp ?? true
  const cardUp = (): boolean => opts.discordCardUp ?? up()
  const outbox = (): 'off' | 'written' | 'swallowed' => opts.outbox ?? 'off'

  /** Returns true when the job id is NEW (i.e. a real send happened). */
  const accept = (jobId?: string): boolean => {
    if (jobId) calls.jobIds.push(jobId)
    if (!opts.dedupeByJobId || !jobId) return true
    if (held.has(jobId)) return false
    held.add(jobId)
    return true
  }

  return {
    calls,
    set: (next) => {
      opts = next
    },
    deps: {
      emailQueue: {
        add: async (_n, _d, o) => {
          if (!up()) return dead()
          if (accept(o?.jobId)) calls.email += 1
          return 'job'
        },
      },
      smsQueue: {
        add: async (_n, _d, o) => {
          if (!up()) return dead()
          if (accept(o?.jobId)) calls.sms += 1
          return 'job'
        },
      },
      discordQueue: {
        add: async (name: string, _d, o) => {
          if (!cardUp()) return dead()
          if (accept(o?.jobId)) calls.discord.push(name)
          return 'job'
        },
      },
      marketingQueue: {
        add: async (_n, _d, o) => {
          if (!up()) return dead()
          if (accept(o?.jobId)) calls.marketing += 1
          return 'job'
        },
      },
      outboxEnabled: () => outbox() !== 'off',
      emitPaymentCompleted: async () => {
        calls.email += 1
        return outbox() === 'written'
      },
      ingestBookingToTracker: async () => {
        calls.tracker += 1
      },
      onBookingPaid: async () => {
        calls.bookingPaid += 1
      },
      postOwnerNotice: async () => {
        calls.ownerNotice += 1
        return opts.noticeDelivered ? { delivered: true } : { delivered: false, reason: 'no configured channel (test)' }
      },
    },
  }
}

/** The sentence the shipped code logs for this run. summarizeHandoffs is the
 *  SINGLE place fulfillPaidCheckout builds that line, so asserting on it is
 *  asserting on what the owner reads — without capturing pino's fd-1 stream
 *  (pino writes straight to the file descriptor, so patching process.stdout
 *  captures nothing and would make these assertions vacuous). */
async function loggedClaim(handoffs: import('../fulfillment').HandoffOutcome[] | undefined): Promise<string> {
  const m = await load()
  return m.fulfillment.summarizeHandoffs(handoffs ?? []).message
}

// ── Stripe events + real signatures ─────────────────────────────────────────
const signer = new Stripe('sk_test_webhook_durability', { apiVersion: '2024-06-20' })

function signed(event: Record<string, unknown>): { body: string; signature: string } {
  const body = JSON.stringify(event)
  return { body, signature: signer.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET }) }
}

function checkoutEvent(id = 'evt_checkout_1'): Record<string, unknown> {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_intent: 'pi_wd', amount_total: 4900, metadata: { bookingId: 'bk_wd' } } },
  }
}

function refundEvent(id = 'evt_refund_1'): Stripe.Event {
  return {
    id,
    type: 'charge.refunded',
    data: {
      object: { id: 'ch_wd', payment_intent: 'pi_wd', amount: 4900, amount_refunded: 4900, refunds: { data: [{ id: 're_wd' }] } },
    },
  } as unknown as Stripe.Event
}

function paymentRow(): Row {
  return { id: 'pay_wd', bookingId: 'bk_wd', stripePaymentIntentId: 'pi_wd', stripeChargeId: 'ch_wd', amount: 4900, refundedAmountCents: 0, status: 'COMPLETED' }
}

// ════════════════════════════════════════════════════════════════════════════
//  1. B3 — THE HTTP CONTRACT. 200 means queued OR processed. Nothing else.
// ════════════════════════════════════════════════════════════════════════════

test('B3: queue handoff fails AND inline processing throws ⇒ 500, so Stripe retries', async () => {
  const m = await load()
  ctl = newCtl()
  const { body, signature } = signed(checkoutEvent())
  let inlineRuns = 0

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: async () => {
      inlineRuns += 1
      throw new Error('inline processing failed (test)')
    },
  })

  assert.equal(inlineRuns, 1, 'the inline fallback must still be attempted')
  assert.equal(
    res.status,
    500,
    'THE B3 DEFECT: this returned 200. The event was neither queued nor processed, so a 2xx told Stripe ' +
      'to never retry — permanent loss, and for charge.dispute.created there is no other trigger at all',
  )
  assert.deepEqual(res.body, { error: 'Webhook processing failed — retry this event' })
})

test('B3: queue handoff fails but inline processing SUCCEEDS ⇒ 200 (that work is genuinely done)', async () => {
  const m = await load()
  ctl = newCtl()
  const { body, signature } = signed(checkoutEvent())

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: async () => undefined,
  })

  assert.equal(res.status, 200, 'a completed inline run must NOT be reported as a failure — that would re-deliver it')
  assert.deepEqual(res.body, { ok: true })
})

test('B3: a queued event returns 200 without running inline', async () => {
  const m = await load()
  ctl = newCtl()
  const { body, signature } = signed(checkoutEvent())
  let inlineRuns = 0

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: async () => 'job',
    processInline: async () => {
      inlineRuns += 1
    },
  })

  assert.equal(res.status, 200)
  assert.equal(inlineRuns, 0, 'the queue owns it; running inline too would be the double-processing the reviewer feared')
})

test('B3: an invalid signature is still 400 and never touches the handoff', async () => {
  const m = await load()
  ctl = newCtl()
  let touched = 0

  const res = await m.events.processStripeWebhook(JSON.stringify(checkoutEvent()), 't=1,v1=deadbeef', {
    enqueue: async () => {
      touched += 1
      return 'job'
    },
    processInline: async () => {
      touched += 1
    },
  })

  assert.equal(res.status, 400)
  assert.equal(touched, 0)
})

test('B3: the code-before-SQL window is LOUD — migration-deferred fulfillment ⇒ 500 + webhook log "failed"', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  // Both read rungs fail the same migration-shaped way: this is the live state
  // of this branch (three unapplied migrations). fulfillPaidCheckout then
  // returns MIGRATION_NOT_APPLIED without claiming anything, and
  // handleStripeEvent throws by design — which the old 200 swallowed.
  ctl.bookingReadError = p2022('some_pending_column')
  const { body, signature } = signed(checkoutEvent('evt_migration_window'))

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: m.events.processStripeEventJob,
  })

  assert.equal(res.status, 500, 'the whole point of the MIGRATION_NOT_APPLIED throw is a retry; a 200 cancelled it')
  const logRow = ctl.webhookLogs.get('evt_migration_window')
  assert.equal(logRow?.status, 'failed', 'the event must NOT be recorded processed — nothing was done')
  assert.equal(ctl.booking?.status, 'PENDING_PAYMENT', 'and the claim must not have been consumed')
  assert.equal(ctl.bookingWrites.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  2. B3 — THE EVENT CLAIM. Exactly one runner; a stale lease is recoverable;
//     a 'processed' stamp can only come from the run that holds the claim.
// ════════════════════════════════════════════════════════════════════════════

test('B3: two concurrent runners ⇒ the business handler runs exactly once, and the LOSER fails loudly', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  const event = refundEvent('evt_concurrent')

  const settled = await Promise.allSettled([
    m.events.processStripeEventJob(event),
    m.events.processStripeEventJob(event),
  ])

  assert.equal(
    ctl.paymentUpdates,
    1,
    'read-then-act (findUnique + upsert) let both runners in; ONE conditional UPDATE decides the owner',
  )
  assert.equal(ctl.audits.length, 1, 'and exactly one PAYMENT_REFUNDED audit row')
  assert.equal(ctl.webhookLogs.get('evt_concurrent')?.status, 'processed')

  // ITEM R3 — and here is what exclusivity COSTS the loser, which the previous
  // version of this test never asked. Exactly one caller succeeds; the other is
  // told its delivery did nothing, so the delivery comes back.
  const fulfilled = settled.filter((s) => s.status === 'fulfilled')
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'exactly one runner may report success')
  assert.equal(rejected.length, 1, 'the loser must NOT resolve — resolving is what retires the retry')
  assert.equal(m.events.isWebhookLeaseHeld(rejected[0].reason), true)
})

test('R3: a LIVE lease is a SKIP, and the skip costs the caller its 2xx', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  ctl.webhookLogs.set('evt_inflight', {
    id: 'wl_inflight',
    eventId: 'evt_inflight',
    status: 'processing',
    processedAt: new Date(), // a FRESH lease — someone is on it right now
  })

  // 1. THE JOB. Exclusivity still holds …
  await assert.rejects(
    () => m.events.processStripeEventJob(refundEvent('evt_inflight')),
    (err: unknown) => m.events.isWebhookLeaseHeld(err),
    'THE R3 REGRESSION: this RETURNED NORMALLY. The worker then marked the job COMPLETED, the retry chain ended, ' +
      'and nothing ever revisited the row — a retryable event converted into a permanently lost one.',
  )
  assert.equal(ctl.paymentUpdates, 0, 'a fresh lease is exclusive')
  assert.equal(ctl.webhookLogs.get('evt_inflight')?.status, 'processing', 'and is left for its holder to finish')

  // 2. THE HTTP CONTRACT. Same state, driven through the shipped entry point
  //    with the queue dead: the answer must NOT be 2xx.
  const { body, signature } = signed(refundEvent('evt_inflight') as unknown as Record<string, unknown>)
  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: m.events.processStripeEventJob,
  })
  assert.equal(res.status, 409, 'a held event is not finished, so Stripe must re-deliver it')
  assert.notEqual(res.status, 200)
  assert.equal(ctl.paymentUpdates, 0, 'and still nothing was processed by this delivery')
})

test('R3: a run KILLED mid-flight is not lost — its own retry reclaims the expired lease', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  // Runner A stamped 'processing' and was killed (serverless timeout / deploy).
  const killedAt = new Date(Date.now() - 10_000)
  ctl.webhookLogs.set('evt_killed', { id: 'wl_killed', eventId: 'evt_killed', status: 'processing', processedAt: killedAt })

  // The 10s BullMQ retry lands while the lease is still live: it must FAIL, not
  // succeed. (With a 10-minute lease EVERY retry in the queue's ~2.5-minute
  // budget landed here, and every one of them returned normally.)
  await assert.rejects(() => m.events.processStripeEventJob(refundEvent('evt_killed')), (e: unknown) => m.events.isWebhookLeaseHeld(e))
  assert.equal(ctl.paymentUpdates, 0)

  // A later delivery, past the lease, RECLAIMS it and does the work.
  const row = ctl.webhookLogs.get('evt_killed')!
  row.processedAt = new Date(Date.now() - m.events.WEBHOOK_LEASE_MS - 1_000)
  await m.events.processStripeEventJob(refundEvent('evt_killed'))
  assert.equal(ctl.paymentUpdates, 1, 'exclusivity must never become the permanent-loss bug it exists to prevent')
  assert.equal(ctl.webhookLogs.get('evt_killed')?.status, 'processed')
})

test('R3: a run whose lease EXPIRED cannot stamp "processed" over the runner that reclaimed it', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  // While this run is inside the handler its lease expires and another runner
  // reclaims the row — same status ('processing'), DIFFERENT lease stamp. A
  // guard on the status alone would let this run stamp 'processed' over work
  // that is still in flight, and a rollback afterwards would then be invisible:
  // every future retry skips a 'processed' row forever.
  const reclaimedAt = new Date(Date.now() + 5_000)
  ctl.duringHandler = () => {
    const row = ctl.webhookLogs.get('evt_stolen')
    if (row) row.processedAt = reclaimedAt
  }

  await m.events.processStripeEventJob(refundEvent('evt_stolen'))

  const row = ctl.webhookLogs.get('evt_stolen')
  assert.equal(row?.status, 'processing', 'the lease TOKEN, not merely the status, decides who may close the row')
  assert.equal((row?.processedAt as Date).getTime(), reclaimedAt.getTime(), 'the reclaiming runner still owns it')
})

test('R3: a run whose lease EXPIRED cannot downgrade the runner that reclaimed it either', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  const reclaimedAt = new Date(Date.now() + 5_000)
  ctl.duringHandler = () => {
    const row = ctl.webhookLogs.get('evt_stolen_fail')
    if (row) row.processedAt = reclaimedAt
    throw new Error('handler blew up (test)')
  }

  await assert.rejects(() => m.events.processStripeEventJob(refundEvent('evt_stolen_fail')), /handler blew up/)

  assert.equal(
    ctl.webhookLogs.get('evt_stolen_fail')?.status,
    'processing',
    'a run that no longer holds the lease must not knock a LIVE runner back to "failed"',
  )
})

test('R3: the lease is SIZED to the retry cadence it has to survive', async () => {
  const m = await load()
  // Read the REAL queue policy rather than restating it: a lease is only
  // "right-sized" relative to the schedule of the deliveries that can rescue it.
  const src = readFileSync(resolve(process.cwd(), 'src/lib/queues/index.ts'), 'utf8')
  const block = src.slice(src.indexOf("new Queue('webhook-retry'"))
  const attempts = Number(/attempts:\s*(\d+)/.exec(block)?.[1])
  const delay = Number(/delay:\s*(\d+)/.exec(block)?.[1])
  assert.ok(Number.isFinite(attempts) && attempts > 1, 'could not read the webhook-retry attempts policy')
  assert.ok(Number.isFinite(delay) && delay > 0, 'could not read the webhook-retry backoff delay')

  // BullMQ exponential backoff: attempt n is delayed delay * 2^(n-1).
  const arrivals: number[] = []
  let cumulative = 0
  for (let n = 1; n < attempts; n += 1) {
    cumulative += delay * 2 ** (n - 1)
    arrivals.push(cumulative)
  }
  const reclaimers = arrivals.filter((t) => t > m.events.WEBHOOK_LEASE_MS)
  assert.ok(
    reclaimers.length >= 2,
    `a killed run must be reclaimable by its OWN retries with attempts to spare — lease ${m.events.WEBHOOK_LEASE_MS}ms vs ` +
      `retry arrivals [${arrivals.join(', ')}]ms. At the shipped 10-minute lease this list was EMPTY, which is the regression.`,
  )
  assert.ok(
    m.events.WEBHOOK_LEASE_MS > 30_000,
    'and it must still be longer than any healthy run (~10s measured with Redis dead) so a live run is never stolen',
  )
})

test('B3: a run killed mid-flight (stale lease) is RECLAIMED, not lost forever', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  ctl.webhookLogs.set('evt_stale', {
    id: 'wl_stale',
    eventId: 'evt_stale',
    status: 'processing',
    processedAt: new Date(Date.now() - m.events.WEBHOOK_LEASE_MS - 1000), // the process died here
  })

  await m.events.processStripeEventJob(refundEvent('evt_stale'))

  assert.equal(ctl.paymentUpdates, 1, 'exclusivity must never become the permanent-loss bug it exists to prevent')
  assert.equal(ctl.webhookLogs.get('evt_stale')?.status, 'processed')
})

test('B3: a FAILED event re-runs on the next delivery (this is what the 500 buys)', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  ctl.webhookLogs.set('evt_retry', {
    id: 'wl_retry',
    eventId: 'evt_retry',
    status: 'failed',
    processedAt: null,
  })

  await m.events.processStripeEventJob(refundEvent('evt_retry'))

  assert.equal(ctl.paymentUpdates, 1)
  assert.equal(ctl.webhookLogs.get('evt_retry')?.status, 'processed')
})

test('B3: a run that lost its claim mid-flight cannot stamp "processed" over it', async () => {
  const m = await load()
  ctl = newCtl()
  ctl.payments.push(paymentRow())
  // Simulates the race the reviewer's scenario G ends in: while this run is
  // inside the handler, the row is moved off 'processing' (another runner
  // reclaimed it after a lease expiry, or a rollback downgraded it). A stamp
  // that ignored the status would freeze the event at 'processed' forever and
  // every future retry would skip it.
  ctl.duringHandler = () => {
    const row = ctl.webhookLogs.get('evt_lost_claim')
    if (row) row.status = 'failed'
  }

  await m.events.processStripeEventJob(refundEvent('evt_lost_claim'))

  assert.equal(
    ctl.webhookLogs.get('evt_lost_claim')?.status,
    'failed',
    'the success write is conditional on still holding the claim — otherwise a stale "processed" is permanent',
  )
  // And the proof that it matters: the event is still replayable.
  ctl.duringHandler = undefined
  await m.events.processStripeEventJob(refundEvent('evt_lost_claim'))
  assert.equal(ctl.paymentUpdates, 2, 'the retry still executes')
  assert.equal(ctl.webhookLogs.get('evt_lost_claim')?.status, 'processed')
})

// ════════════════════════════════════════════════════════════════════════════
//  3. B4 — FULFILMENT TELLS THE TRUTH ABOUT WHAT IT ACTUALLY HANDED OFF.
// ════════════════════════════════════════════════════════════════════════════

async function fulfill(deps: import('../fulfillment').FulfillDeps) {
  const m = await load()
  return m.fulfillment.fulfillPaidCheckout(
    { bookingId: 'bk_wd', paymentIntentId: 'pi_wd', amountTotalCents: 4900, source: 'webhook' },
    deps,
  )
}

test('B4: a healthy fan-out reports every handoff, and only then claims "all jobs queued"', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps({ queuesUp: true })

  const result = await fulfill(deps)

  assert.equal(result.processed, true)
  assert.equal(result.ownerNotified, true)
  assert.equal(result.customerNotified, true)
  assert.equal(calls.ownerNotice, 0, 'the direct notice is a FALLBACK — it must not fire when the card was queued')
  assert.deepEqual(
    (result.handoffs ?? []).filter((h) => !h.ok),
    [],
    'nothing failed, so nothing may be recorded as failed',
  )
  assert.equal(result.handoffs?.length, 5, 'email + sms + approval card + marketing + job channels')
  assert.equal(await loggedClaim(result.handoffs), 'Checkout fulfilled — booking → PENDING_APPROVAL, all 5 jobs queued')
  assert.equal(ctl.booking?.status, 'PENDING_APPROVAL', 'the claim is kept — the work was done')
})

test('B4: every queue dead ⇒ the owner still gets a notice, and the log never says "all jobs queued"', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps({ queuesUp: false, noticeDelivered: true })

  const result = await fulfill(deps)
  const claim = await loggedClaim(result.handoffs)

  assert.equal(calls.ownerNotice, 1, 'the $0-lead fallback pattern (quote-capture.ts) now covers a $49 booking too')
  assert.equal(result.ownerNotified, true, 'the plain-text notice reached Discord without Redis')
  assert.equal(result.customerNotified, false, 'and the email genuinely did not go out')
  assert.equal(result.processed, true, 'the owner was told, so the claim is real work — do not release it')
  assert.equal(
    claim.includes('jobs queued'),
    false,
    'THE B4 DEFECT: "Checkout fulfilled — all jobs queued" was printed unconditionally, with zero jobs queued',
  )
  assert.ok(claim.includes('5 of 6 handoffs FAILED'), `the line must count the real failures — got: ${claim}`)
  assert.equal(ctl.booking?.status, 'PENDING_APPROVAL')
  const failed = (result.handoffs ?? []).filter((h) => !h.ok).map((h) => h.label)
  assert.deepEqual(failed.sort(), [
    'discord:booking-created',
    'discord:create-job-channels',
    'email:pre-approval',
    'marketing:enroll',
    'sms:final-confirmation',
  ])
})

test('B4: nothing reached ANYONE ⇒ not processed, and no "fulfilled" claim in the log', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps({ queuesUp: false, noticeDelivered: false })

  const result = await fulfill(deps)

  assert.equal(
    result.processed,
    false,
    'THE B4 DEFECT: this returned processed:true — which no-oped the success-redirect backup and let the webhook ' +
      'record the event processed while a paying customer sat in silence',
  )
  assert.equal(result.reason, m.fulfillment.NO_DURABLE_HANDOFF)
  assert.equal(result.ownerNotified, false)
  assert.equal(result.customerNotified, false)
  assert.equal(calls.ownerNotice, 1, 'the direct notice was attempted before giving up')
  assert.equal(calls.bookingPaid, 0, 'no downstream cleanup on a run that delivered nothing')
  // ITEM R4 — the claim is KEPT, and the durable ledger (not the booking
  // status) is what makes the retry safe. Releasing it here is what let the
  // forced Stripe retry re-run handoffs that had already succeeded.
  assert.equal(
    ctl.booking?.status,
    'PENDING_APPROVAL',
    'the claim MUST be kept: releasing it sends the next trigger through the WHOLE fan-out again',
  )
  const ledger = ctl.webhookLogs.get('fulfillment__bk_wd')
  assert.ok(ledger, 'and the run must have recorded what it intended to do, before attempting any of it')
  assert.equal(ledger?.status, 'outstanding')
  assert.deepEqual((ledger?.payload as Row)?.done, [], 'nothing got through, so nothing is recorded delivered')
  // Nothing was fulfilled, so nothing may say it was: this branch returns
  // BEFORE the "Checkout fulfilled" line is ever built, and the result carries
  // the reason instead of a success.
  assert.deepEqual(
    (result.handoffs ?? []).filter((h) => h.ok),
    [],
    'not one handoff may be recorded as delivered',
  )
})

test('B4: the next trigger after a TOTAL failure still fulfills completely', async () => {
  ctl = newCtl(await paidBookingRow())
  const q = fakeDeps({ queuesUp: false, noticeDelivered: false })
  const first = await fulfill(q.deps)
  assert.equal(first.processed, false)

  // Redis is back (or the browser success redirect arrives).
  q.set({ queuesUp: true })
  const second = await fulfill(q.deps)

  assert.equal(second.processed, true, 'the retry must not short-circuit on "already fulfilled"')
  assert.equal(second.resumed, true, 'and it is a RESUME of the recorded plan, not a fresh fan-out')
  assert.equal(q.calls.email, 1, 'exactly one customer email')
  assert.deepEqual(q.calls.discord, ['booking-created', 'create-job-channels'])
  assert.equal(ctl.booking?.status, 'PENDING_APPROVAL')
  assert.equal(
    ctl.audits.filter((a) => a.action === 'PAYMENT_RECEIVED').length,
    1,
    'ONE PAYMENT_RECEIVED row for one payment: src/lib/booking-approval.ts counts these as a one-per-booking ' +
      'marker for "the money is already recorded", so a per-attempt audit would corrupt that guard',
  )
  assert.equal(ctl.webhookLogs.get('fulfillment__bk_wd')?.status, 'complete')
})

// ════════════════════════════════════════════════════════════════════════════
//  3b. R4 — THE PARTIAL FAN-OUT. The retry may never re-run what succeeded.
// ════════════════════════════════════════════════════════════════════════════

test('R4: a PARTIAL fan-out is resumed, not repeated — the retry never re-sends what got through', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())

  // The reproduction, exactly: SMS + marketing were accepted, email + card were
  // refused, and the direct owner notice could not be delivered either. This is
  // the ORDINARY shape of an Upstash blip, not a corner case.
  const q = fakeDeps({ queuesUp: true, discordCardUp: false, noticeDelivered: false })
  const realEmail = q.deps.emailQueue.add
  q.deps.emailQueue.add = async () => Promise.reject(new Error('Redis unreachable (test)'))

  const first = await fulfill(q.deps)

  assert.equal(first.processed, false)
  assert.equal(first.reason, m.fulfillment.NO_DURABLE_HANDOFF, 'nobody was reached, so this run fulfilled nothing')
  assert.equal(q.calls.sms, 1, 'precondition: the SMS DID go out')
  assert.equal(q.calls.marketing, 1, 'precondition: the marketing enrolment DID go out')
  assert.equal(
    ctl.booking?.status,
    'PENDING_APPROVAL',
    'THE R4 REGRESSION: the claim was RELEASED here, which is what let the forced retry redo the whole fan-out',
  )
  assert.deepEqual(
    ((ctl.webhookLogs.get('fulfillment__bk_wd')?.payload as Row)?.done as string[]).slice().sort(),
    ['marketing:enroll', 'sms:final-confirmation'],
    'the two handoffs that succeeded are recorded DURABLY — that record is the whole fix',
  )

  // The forced Stripe retry (src/lib/stripe-events.ts throws on this reason),
  // with Redis healthy again.
  q.deps.emailQueue.add = realEmail
  q.set({ queuesUp: true })
  const second = await fulfill(q.deps)

  assert.equal(second.processed, true)
  assert.equal(second.resumed, true)
  assert.equal(
    q.calls.sms,
    1,
    'THE R4 REPRODUCTION: the retry re-ran the whole fan-out and the customer got TWO texts about one booking',
  )
  assert.equal(q.calls.marketing, 1, 'and TWO marketing enrolments for one customer')
  assert.equal(q.calls.email, 1, 'while the handoff that actually failed is the one that gets re-driven')
  assert.deepEqual(q.calls.discord, ['booking-created', 'create-job-channels'])
  assert.deepEqual(
    (second.handoffs ?? []).map((h) => h.label).sort(),
    ['discord:booking-created', 'discord:create-job-channels', 'email:pre-approval'],
    'ONLY the outstanding handoffs are attempted — the delivered ones are not even tried',
  )
  assert.deepEqual(
    (second.alreadyDelivered ?? []).slice().sort(),
    ['marketing:enroll', 'sms:final-confirmation'],
  )
  assert.equal(ctl.audits.filter((a) => a.action === 'PAYMENT_RECEIVED').length, 1)
  assert.equal(ctl.webhookLogs.get('fulfillment__bk_wd')?.status, 'complete')
})

test('R4: a handoff whose ABANDONED add lands later collapses instead of double-sending', async () => {
  // The documented Upstash mode: queue.add() HANGS, the 5s race abandons it
  // WITHOUT CANCELLING, and the job lands afterwards — so a handoff recorded
  // ok:false may in fact have been delivered. Only a deterministic job id can
  // make the re-drive collapse onto it. (dedupeByJobId models BullMQ's own
  // refusal to create a second job under an id it already holds.)
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const q = fakeDeps({ queuesUp: true, dedupeByJobId: true })
  const landedLate: string[] = []
  const realSms = q.deps.smsQueue.add
  q.deps.smsQueue.add = async (name, data, opts) => {
    // Recorded as a failure by fulfilment … and delivered anyway, moments later.
    void realSms(name, data, opts).then((r) => {
      landedLate.push(opts?.jobId ?? '(none)')
      return r
    })
    throw new Error('queue add timed out after 5s (Redis unreachable?)')
  }

  const first = await fulfill(q.deps)
  assert.equal(first.processed, true, 'the owner card went out, so this run keeps its claim')
  assert.equal((first.handoffs ?? []).find((h) => h.label === 'sms:final-confirmation')?.ok, false)
  assert.equal(q.calls.sms, 1, 'precondition: the abandoned add DID land')
  assert.equal(landedLate.length, 1)

  // The success redirect arrives and resumes the one outstanding handoff.
  q.deps.smsQueue.add = realSms
  const second = await fulfill(q.deps)

  assert.equal(second.resumed, true)
  assert.deepEqual((second.handoffs ?? []).map((h) => h.label), ['sms:final-confirmation'], 'it IS re-driven …')
  assert.equal(q.calls.sms, 1, '… and collapses onto the job the abandoned add already created — one text, not two')
  assert.equal(
    ctl.audits.filter((a) => a.action === 'PAYMENT_RECEIVED').length,
    1,
    'and the once-per-booking money record survives the resume: a second PAYMENT_RECEIVED row would corrupt the ' +
      'one-per-booking marker src/lib/booking-approval.ts reads',
  )
})

test('R4: an owner already reached by the plain-text notice is not pinged again by every resume', async () => {
  ctl = newCtl(await paidBookingRow())
  // Discord is down, so the card cannot be queued and the fallback notice is
  // what actually reaches Diego. That run KEEPS its claim (the owner was told),
  // but the two Discord handoffs stay outstanding.
  const q = fakeDeps({ queuesUp: true, discordCardUp: false, noticeDelivered: true })

  const first = await fulfill(q.deps)
  assert.equal(first.processed, true)
  assert.equal(first.ownerNotified, true)
  assert.equal(q.calls.ownerNotice, 1)

  // Discord is STILL down when the next trigger resumes.
  const second = await fulfill(q.deps)

  assert.equal(second.resumed, true)
  assert.deepEqual(
    (second.handoffs ?? []).map((h) => h.label).sort(),
    ['discord:booking-created', 'discord:create-job-channels'],
    'only the two outstanding Discord handoffs are retried',
  )
  assert.equal(
    q.calls.ownerNotice,
    1,
    'the owner was already told about this booking — "already delivered" covers the fallback notice too, or every ' +
      'retry becomes another 2am ping about a booking he has already seen',
  )
  assert.equal(
    ctl.audits.filter((a) => a.action === 'PAYMENT_RECEIVED').length,
    1,
    'ONE PAYMENT_RECEIVED row across BOTH runs — this is the case where the audit block is reached twice',
  )
  assert.equal(q.calls.bookingPaid, 1, 'and the abandoned-recovery cleanup runs once, not once per attempt')
})

test('R4: flipping OUTBOX_ENABLED between runs does not re-send the customer email', async () => {
  // The pre-approval email is ONE handoff with TWO transports (legacy queue vs
  // the Postgres outbox), under two different labels. If the flag changes
  // between the first run and the resume — a deploy, an env edit — the label in
  // the new plan is not the label in the ledger, and a naive "not in done"
  // check emails a customer who already has it.
  ctl = newCtl(await paidBookingRow())
  const q = fakeDeps({ queuesUp: true, discordCardUp: false, noticeDelivered: false, outbox: 'written' })

  const first = await fulfill(q.deps)
  assert.equal(first.customerNotified, true, 'precondition: the outbox row WAS written')
  assert.equal(q.calls.email, 1)

  q.set({ queuesUp: true, discordCardUp: true, outbox: 'off' })
  const second = await fulfill(q.deps)

  assert.equal(second.resumed, true)
  assert.equal(q.calls.email, 1, 'the customer already has the pre-approval email — the transport changing is not a reason to re-send')
  assert.deepEqual(
    (second.handoffs ?? []).map((h) => h.label).sort(),
    ['discord:booking-created', 'discord:create-job-channels'],
    'only the handoffs that genuinely failed are re-driven',
  )
  assert.equal(ctl.webhookLogs.get('fulfillment__bk_wd')?.status, 'complete')
})

test('R4: every queue handoff carries a deterministic, BullMQ-legal job id', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const a = fakeDeps({ queuesUp: true })
  await fulfill(a.deps)

  assert.deepEqual(a.calls.jobIds, [
    m.fulfillment.fulfillmentJobId('bk_wd', 'email:pre-approval'),
    m.fulfillment.fulfillmentJobId('bk_wd', 'sms:final-confirmation'),
    m.fulfillment.fulfillmentJobId('bk_wd', 'discord:booking-created'),
    m.fulfillment.fulfillmentJobId('bk_wd', 'marketing:enroll'),
    m.fulfillment.fulfillmentJobId('bk_wd', 'discord:create-job-channels'),
  ], 'every enqueue must pass an id — an add without one can never collapse')

  for (const id of a.calls.jobIds) {
    assert.equal(id.includes(':'), false, `BullMQ REJECTS a custom id containing ":" — got ${id}`)
    assert.ok(id.includes('bk_wd'), 'the id must be scoped to the booking')
  }
  // Deterministic across processes: the same booking + label is the same id.
  assert.equal(
    m.fulfillment.fulfillmentJobId('bk_wd', 'sms:final-confirmation'),
    m.fulfillment.fulfillmentJobId('bk_wd', 'sms:final-confirmation'),
  )
  assert.notEqual(
    m.fulfillment.fulfillmentJobId('bk_wd', 'sms:final-confirmation'),
    m.fulfillment.fulfillmentJobId('bk_other', 'sms:final-confirmation'),
  )
})

test('R4: two triggers resuming at once ⇒ only one re-drives, the other reports it did nothing', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const q = fakeDeps({ queuesUp: false, noticeDelivered: false })
  await fulfill(q.deps) // leaves an 'outstanding' ledger, claim kept

  q.set({ queuesUp: true })
  const [a, b] = await Promise.all([fulfill(q.deps), fulfill(q.deps)])

  const winners = [a, b].filter((r) => r.processed)
  const losers = [a, b].filter((r) => !r.processed)
  assert.equal(winners.length, 1, 'the resume lease is ONE conditional UPDATE — two callers cannot both pass it')
  assert.equal(losers[0].reason, m.fulfillment.RESUME_IN_PROGRESS, 'and the loser says it did nothing, not that it is done')
  assert.equal(q.calls.email, 1, 'exactly one customer email')
  assert.equal(q.calls.sms, 1)
  assert.deepEqual(q.calls.discord, ['booking-created', 'create-job-channels'])
  assert.equal(ctl.audits.filter((a2) => a2.action === 'PAYMENT_RECEIVED').length, 1)
})

test('R4: with no ledger, a booking whose fan-out DID finish is still a quiet no-op (never a blind re-fan-out)', async () => {
  // Bookings fulfilled before the ledger existed have no row, and re-sending to
  // customers already contacted is exactly what this guarantee prevents.
  //
  // ITEM M3 — the fixture now carries the PROOF that the fan-out finished: the
  // PAYMENT_RECEIVED row this module writes as its last durable step. An
  // already-fulfilled booking always has one, so this is the real shape of the
  // state, and it is what the skip is now decided on. Without any proof at all
  // the same row is an ORPHANED fan-out (claimed, then killed before the ledger
  // was written) — see the test below, where a paid customer had been sent
  // nothing and this branch reported the checkout finished.
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  ctl.audits.push({
    id: 'legacy_cuid_from_before_the_ledger',
    action: 'PAYMENT_RECEIVED',
    bookingId: 'bk_wd',
    details: { authorized: true, amount: 4900, paymentIntentId: 'pi_wd', source: 'webhook' },
  })
  const q = fakeDeps({ queuesUp: true })

  const result = await fulfill(q.deps)

  assert.equal(result.processed, false)
  assert.equal(result.reason, 'already-fulfilled-or-not-pending')
  assert.equal(q.calls.email, 0)
  assert.equal(q.calls.sms, 0)
  assert.equal(q.calls.discord.length, 0)
  assert.equal(q.calls.ownerNotice, 0)
})

test('M3: with no ledger AND no record of a finished fan-out, the abandoned fan-out is run', async () => {
  // The other half of the state above, and the reason it may not be assumed:
  // the booking claim is one statement and the ledger is written a few
  // statements later. A runner killed in between leaves a paid booking sitting
  // in PENDING_APPROVAL with nothing sent — and reporting that finished retires
  // the Stripe event that was the only remaining trigger.
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  const q = fakeDeps({ queuesUp: true })

  const result = await fulfill(q.deps)

  assert.equal(result.processed, true, 'the fan-out this booking never had is run now')
  assert.equal(result.reason, undefined)
  assert.equal(q.calls.email, 1, 'the customer who paid finally hears from us')
  assert.equal(q.calls.discord.length, 2, 'and the owner finally gets his cards')
  assert.equal(ctl.webhookLogs.get('fulfillment__bk_wd')?.status, 'complete')
})

test('R4: the fan-out never starts when its intent cannot be recorded', async () => {
  // If the ledger cannot be written, a retry has no way to know what went out —
  // so nothing goes out, and the claim is given back (nothing was sent yet).
  ctl = newCtl(await paidBookingRow())
  const q = fakeDeps({ queuesUp: true })
  const realUpsert = fakePrisma.webhookLog.upsert
  fakePrisma.webhookLog.upsert = async () => {
    throw new Error('webhook_logs unavailable (test)')
  }
  try {
    await assert.rejects(() => fulfill(q.deps), /ledger could not be written/)
  } finally {
    fakePrisma.webhookLog.upsert = realUpsert
  }

  assert.equal(q.calls.email, 0, 'not one message may be sent without a durable record of the plan')
  assert.equal(q.calls.sms, 0)
  assert.equal(q.calls.discord.length, 0)
  assert.equal(ctl.booking?.status, 'PENDING_PAYMENT', 'and the claim goes back, because nothing was sent')
})

test('B4: the customer email got through but the owner card did not ⇒ claim KEPT (a retry would double-send)', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps({ queuesUp: true, discordCardUp: false, noticeDelivered: false })

  const result = await fulfill(deps)

  assert.equal(result.processed, true)
  assert.equal(result.customerNotified, true)
  assert.equal(result.ownerNotified, false, 'and it says so — the owner-side failure is on the record, not hidden')
  assert.equal(calls.email, 1)
  assert.equal(calls.ownerNotice, 1)
  assert.equal(
    ctl.booking?.status,
    'PENDING_APPROVAL',
    'releasing here would re-send the pre-approval email the customer already has',
  )
})

test('B4: OUTBOX_ENABLED — a swallowed outbox emit counts as NOT notified', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps, calls } = fakeDeps({ queuesUp: true, outbox: 'swallowed' })

  const result = await fulfill(deps)

  assert.equal(calls.email, 1, 'the outbox emit was attempted')
  assert.equal(
    result.customerNotified,
    false,
    'src/outbox/integration.ts swallows the failure and returns false — throwing that answer away made a ' +
      'swallowed outbox write indistinguishable from a durable one',
  )
  const outboxHandoff = (result.handoffs ?? []).find((h) => h.label === 'outbox:payment-completed')
  assert.equal(outboxHandoff?.ok, false)
  assert.equal(result.processed, true, 'the owner card still went out, so the claim is real work')
})

test('B4: OUTBOX_ENABLED — a written outbox row IS the customer notification', async () => {
  ctl = newCtl(await paidBookingRow())
  const { deps } = fakeDeps({ queuesUp: true, outbox: 'written' })

  const result = await fulfill(deps)

  assert.equal(result.customerNotified, true)
  assert.deepEqual((result.handoffs ?? []).filter((h) => !h.ok), [])
})

test('B4: OUTBOX_ENABLED — a swallowed emit with every other handoff dead ⇒ nothing durable', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const { deps } = fakeDeps({ queuesUp: false, outbox: 'swallowed', noticeDelivered: false })

  const result = await fulfill(deps)

  assert.equal(result.processed, false)
  assert.equal(result.reason, m.fulfillment.NO_DURABLE_HANDOFF)
  // ITEM R4 — claim kept; the ledger, not a rolled-back status, is what the
  // retry reads to know the outbox email is still outstanding.
  assert.equal(ctl.booking?.status, 'PENDING_APPROVAL')
  assert.deepEqual(
    (ctl.webhookLogs.get('fulfillment__bk_wd')?.payload as Row)?.planned,
    ['outbox:payment-completed', 'sms:final-confirmation', 'discord:booking-created', 'marketing:enroll', 'discord:create-job-channels'],
    'and the OUTBOX transport is what the plan records, so the resume re-drives that one — not the legacy queue email',
  )
})

test('B4: an already-fulfilled booking is still a quiet no-op (the backup trigger must not double-fan-out)', async () => {
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  // ITEM M3 — an ALREADY-FULFILLED booking carries the PAYMENT_RECEIVED row its
  // fan-out wrote as the last step. That row is what proves "already fulfilled"
  // here rather than the absence of a ledger, which is equally the shape of a
  // fan-out that was claimed and abandoned.
  ctl.audits.push({
    id: 'pyauth__bk_wd__pi_wd',
    action: 'PAYMENT_RECEIVED',
    bookingId: 'bk_wd',
    details: { authorized: true, amount: 4900, paymentIntentId: 'pi_wd', source: 'webhook' },
  })
  const { deps, calls } = fakeDeps({ queuesUp: true })

  const result = await fulfill(deps)

  assert.equal(result.processed, false)
  assert.equal(result.reason, 'already-fulfilled-or-not-pending')
  assert.equal(calls.email, 0)
  assert.equal(calls.discord.length, 0)
  assert.equal(calls.ownerNotice, 0)
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE JOIN — a fulfilment that delivered nothing must not be recorded
//     'processed', and must reach Stripe as a retryable failure.
// ════════════════════════════════════════════════════════════════════════════

test('B3+B4: "delivered nothing" propagates — webhook log stays failed and the HTTP answer is 500', async () => {
  const m = await load()
  ctl = newCtl(await paidBookingRow())
  const { body, signature } = signed(checkoutEvent('evt_no_durable'))

  // The real handleStripeEvent → fulfillPaidCheckout, with the queue edge dead
  // and no Discord channel configured: exactly the Upstash-blip-during-checkout
  // scenario, end to end through the shipped code.
  const { deps } = fakeDeps({ queuesUp: false, noticeDelivered: false })
  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    // The SHIPPED processStripeEventJob → handleStripeEvent → fulfillPaidCheckout
    // chain; only the queue edge is injected.
    processInline: (event) =>
      m.events.processStripeEventJob(event, {
        fulfill: (params) => m.fulfillment.fulfillPaidCheckout(params, deps),
      }),
  })

  assert.equal(res.status, 500, 'Stripe must retry an event whose fulfilment reached nobody')
  assert.equal(ctl.webhookLogs.get('evt_no_durable')?.status, 'failed')
  // ITEM R4 — the booking keeps its claim (PENDING_APPROVAL is the honest state:
  // the $49 IS authorized, and it is what puts the booking on the admin
  // dashboard's "waiting for approval" counter). What the retry needs is not a
  // rolled-back status but a record of what is still outstanding.
  assert.equal(ctl.booking?.status, 'PENDING_APPROVAL')
  assert.equal(ctl.webhookLogs.get('fulfillment__bk_wd')?.status, 'outstanding')
})

test('R4: a delivery that lost the resume lease is NOT recorded processed', async () => {
  const m = await load()
  ctl = newCtl({ ...(await paidBookingRow()), status: 'PENDING_APPROVAL' })
  // Another runner (the browser success redirect) is re-driving the fan-out
  // right now, holding a fresh lease.
  ctl.webhookLogs.set('fulfillment__bk_wd', {
    id: 'wl_ledger',
    eventId: 'fulfillment__bk_wd',
    status: 'in-progress',
    processedAt: new Date(),
    payload: { version: 1, planned: ['email:pre-approval', 'discord:booking-created'], done: [], attempts: 1 },
  })
  const { body, signature } = signed(checkoutEvent('evt_resume_race'))
  const { deps, calls } = fakeDeps({ queuesUp: true })

  const res = await m.events.processStripeWebhook(body, signature, {
    enqueue: () => Promise.reject(new Error('Redis unreachable (test)')),
    processInline: (event) =>
      m.events.processStripeEventJob(event, { fulfill: (params) => m.fulfillment.fulfillPaidCheckout(params, deps) }),
  })

  assert.equal(calls.email, 0, 'the loser must not fan anything out')
  assert.equal(calls.discord.length, 0)
  assert.equal(
    res.status,
    500,
    'this delivery did NO work, so it may not retire the retry — the other runner may be the success redirect, ' +
      'whose failure nothing retries',
  )
  assert.equal(ctl.webhookLogs.get('evt_resume_race')?.status, 'failed')
})
