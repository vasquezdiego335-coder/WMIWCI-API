// ════════════════════════════════════════════════════════════════════════════
//  capture-amount-truth.test.ts — REPAIR ITEM M1
//
//  THE DEFECT (src/lib/booking-approval.ts, byte-identical to HEAD through three
//  repair rounds; flagged by three separate verifiers):
//
//      const capturedCents = intent.amount_received ?? intent.amount ?? booking.depositAmount
//
//  That last term is a BOOKING COLUMN — what the booking was SUPPOSED to be
//  charged — and `CapturedIntent` declares BOTH amount fields optional, so a
//  capture response that carries neither is legal per this module's own type.
//  `intentCaptureState` even returns 'captured' for a `succeeded` intent with no
//  amount at all, so the case is reachable. When it happened, every consumer —
//  the Payment row, the audit row, the customer's confirmation email, the
//  owner's ops alert, the Discord card and the admin retry message — stated a
//  dollar figure that came from a database column rather than from Stripe.
//
//  THE REPRODUCTION, exactly as the money doc specifies it: drive the SHIPPED
//  `approveBooking` with a capture response carrying NEITHER amount field, over
//  a booking whose `depositAmount` is the odd value 12345, and watch where 12345
//  goes. Before this item it was written to the Payment row, stamped into the
//  audit, handed to the notifier and printed in the ops alert. It must now reach
//  none of them.
//
//  THE FIX UNDER TEST: `capturedAmountFromIntent` (Stripe or nothing), the
//  `number | null` that is carried end to end, and the store's refusal to write
//  a Payment row for an amount nobody reported (`payments.amount` is NOT NULL,
//  so any row at all would be a figure). The deposit then stays visibly
//  UNRECORDED, which is true, alerted, and already repairable: that is the state
//  `reconciliation.ts` reports as `captured_no_payment_row` and the state the
//  admin's "Retry payment record" re-drives.
//
//  WHY THIS IS NOT THEATRE
//   • the booking row is what the SHIPPED WRITER persists (`AdminBookingSchema`
//     → `resolveMoveSchedule` → `buildBookingCreateData`, default owner path);
//   • `defaultApprovalDeps()` — the REAL `prismaApprovalStore` — runs against a
//     fake `prisma` installed on globalThis before src/lib/db.ts is imported, so
//     the Payment/Job/audit transaction under test is the production one;
//   • the harness is shown to SEE the defect: `M1 harness check` drives the
//     shipped store with the argument the pre-fix line produced and watches
//     12345 land in the ledger, the audit and the notifier.
//
//  SCOPE: this file is about the TRUTH OF THE AMOUNT. Concurrency and the
//  exactly-once claim belong to approval-exactly-once.test.ts, so the fake
//  `$transaction` here is a plain sequence, not a rollback.
//
//  Offline: no database, no Stripe, no Redis, no network. Run:
//    npx tsx --test src/lib/__tests__/capture-amount-truth.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>

const BOOKING_ID = 'bk_m1'
const PI = 'pi_m1'
/** The odd value the money doc names. Nothing Stripe reports is ever 12345, so
 *  any 12345 in a record, a message or an alert came from the booking column. */
const ODD_DEPOSIT_AMOUNT = 12345

// ── The fake database ───────────────────────────────────────────────────────

type FakeDb = {
  booking: Row
  payments: Row[]
  audits: Row[]
  jobs: Map<string, string>
  requirements: Map<string, Row>
}

let db: FakeDb = { booking: {}, payments: [], audits: [], jobs: new Map(), requirements: new Map() }

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
    if (key === 'AND') {
      if (!(val as Row[]).every((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (val && typeof val === 'object' && 'in' in (val as Row)) {
      if (!((val as { in: unknown[] }).in ?? []).includes(row[key])) return false
      continue
    }
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
    async upsert(args: { where: { stripePaymentIntentId: string }; update: Row; create: Row }): Promise<Row> {
      const existing = db.payments.find((p) => p.stripePaymentIntentId === args.where.stripePaymentIntentId)
      if (existing) {
        Object.assign(existing, args.update)
        return existing
      }
      const created = { id: `pay_${db.payments.length + 1}`, ...args.create }
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
      const id = args.data.id
      if (typeof id === 'string' && db.audits.some((a) => a.id === id)) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
      }
      db.audits.push({ ...args.data })
      return args.data
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
  validation: typeof import('../../emails/validation')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    approval: await import('../booking-approval'),
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    scheduling: await import('../scheduling'),
    validation: await import('../../emails/validation'),
  }
  const dbModule = await import('../db')
  assert.equal(
    dbModule.prisma as unknown,
    fakePrisma,
    'the fake prisma must be the client the shipped modules use — otherwise this file tests nothing',
  )
  return mods
}

// ── The row the SHIPPED WRITER persists, with the odd deposit column ─────────

async function createdRow(): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: '2027-09-14',
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
    customerToken: 'tok_m1',
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
    // THE ODD VALUE. Whatever this booking was supposed to be charged, it is not
    // evidence of what Stripe captured.
    depositAmount: ODD_DEPOSIT_AMOUNT,
  }
}

function resetDb(booking: Row): void {
  db = { booking: { ...booking }, payments: [], audits: [], jobs: new Map(), requirements: new Map() }
}

// ── The shipped deps, with only Stripe / notifications / logging / alerts faked ─

type Recorder = {
  captures: Array<{ pi: string; key: string }>
  notified: Array<{ cents: number | null; by: string; intent: string | null }>
  alerts: Array<{ title: string; lines: Array<{ message: string; action?: string }> }>
  errors: unknown[]
  infos: unknown[]
  /** What the capture response carries. Default: NEITHER amount field — legal
   *  per `CapturedIntent`, and the whole reproduction. */
  captureIntent: Record<string, unknown>
}

async function shippedDeps(over: Partial<Recorder> = {}): Promise<Recorder> {
  const m = await load()
  const rec: Recorder = {
    captures: [],
    notified: [],
    alerts: [],
    errors: [],
    infos: [],
    captureIntent: { status: 'succeeded', latest_charge: 'ch_m1', metadata: {} },
    ...over,
  }
  const deps = m.approval.defaultApprovalDeps() // the REAL prismaApprovalStore
  deps.stripe = {
    async capture(pi, key) {
      rec.captures.push({ pi, key })
      return { id: pi, ...rec.captureIntent } as never
    },
    async retrieveCharge() {
      return { id: 'ch_m1', receipt_url: 'https://receipt.example/ch_m1', payment_method_details: { type: 'card' } }
    },
    async releaseHold() {},
    async retrieveIntent(pi) {
      return { id: pi, ...rec.captureIntent } as never
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
  deps.logger = { info: (o) => rec.infos.push(o), warn() {}, error: (o) => rec.errors.push(o) }
  return rec
}

async function approve(): Promise<Awaited<ReturnType<typeof import('../booking-approval').approveBooking>>> {
  const m = await load()
  return m.approval.approveBooking({
    bookingId: BOOKING_ID,
    actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' },
    source: 'admin',
  })
}

const approvalAudits = (): Row[] =>
  db.audits.filter((a) => a.action === 'PAYMENT_RECEIVED' && (a.details as Row)?.event === 'approve_booking')

/** Everything this approval said or wrote, as one searchable string. If 12345
 *  is anywhere in here, a booking column reached a money statement. */
function everythingSaid(rec: Recorder): string {
  return JSON.stringify({
    payments: db.payments,
    audits: db.audits,
    notified: rec.notified,
    alerts: rec.alerts,
    errors: rec.errors,
    infos: rec.infos,
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  0. THE HARNESS CAN SEE THE DEFECT — without this, everything below is
//     theatre. The pre-fix line produced `booking.depositAmount` as the
//     captured amount; hand the SHIPPED store exactly that and watch it land.
// ════════════════════════════════════════════════════════════════════════════

test('M1 harness check: the booking column, passed as the captured amount, is recorded and stated', async () => {
  const m = await load()
  resetDb(await createdRow())
  const store = m.approval.defaultApprovalDeps().store

  await store.commitApproval({
    bookingId: BOOKING_ID,
    paymentIntentId: PI,
    capturedCents: ODD_DEPOSIT_AMOUNT, // what `?? booking.depositAmount` produced
    stripeChargeId: 'ch_m1',
    receiptUrl: null,
    paymentMeta: {},
    isInternalTest: false,
    auditUserId: 'u_diego',
    auditDetails: { event: 'approve_booking', captured: ODD_DEPOSIT_AMOUNT, paymentIntentId: PI },
  })

  assert.equal(db.payments.length, 1, 'the ledger accepts it …')
  assert.equal(db.payments[0].amount, ODD_DEPOSIT_AMOUNT, '… as a captured amount of $123.45')
  assert.equal(db.payments[0].status, 'COMPLETED')
  assert.equal((db.audits[0].details as Row).captured, ODD_DEPOSIT_AMOUNT, 'and the audit row records it as captured')
  // So if the shipped approval ever hands this figure down, this file sees it.
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE REPRODUCTION — a capture response with NEITHER amount field
// ════════════════════════════════════════════════════════════════════════════

test('M1: a capture Stripe reports without an amount records NO figure anywhere', async () => {
  resetDb(await createdRow())
  const rec = await shippedDeps() // capture: { status: 'succeeded' } — no amounts

  const res = await approve()

  assert.ok(res.ok, `the booking IS approved — the money moved: ${!res.ok ? res.message : ''}`)
  assert.equal(res.ok && res.capturedCents, null, 'and the result says the amount is UNKNOWN, not $123.45')
  assert.equal(db.booking.status, 'CONFIRMED')

  // THE REPRODUCTION: 12345 must not appear in ANY record or message.
  const said = everythingSaid(rec)
  assert.ok(
    !said.includes(String(ODD_DEPOSIT_AMOUNT)),
    `the booking's depositAmount reached a money statement: ${said.slice(0, 400)}`,
  )
  assert.ok(!/\$123\.45/.test(said), 'and no rendering of it may be printed either')

  // Every consumer named in the money doc, one at a time.
  assert.equal(db.payments.length, 0, 'LEDGER: no Payment row invents an amount (`payments.amount` is NOT NULL)')
  assert.equal(approvalAudits().length, 1, 'AUDIT: the capture is still recorded …')
  assert.equal((approvalAudits()[0].details as Row).captured, null, '… with the amount stated as unknown')
  assert.equal((approvalAudits()[0].details as Row).capturedAmountUnknown, true)
  assert.equal((approvalAudits()[0].details as Row).stripeResult, 'captured_amount_not_reported')
  assert.equal(rec.notified.length, 1, 'CUSTOMER: the confirmation still goes out …')
  assert.equal(rec.notified[0].cents, null, '… carrying no amount for the template to print')
  assert.equal(rec.alerts.length, 1, 'OWNER: and a human is put on the money gap')
  assert.match(rec.alerts[0].title, /did not report the amount/i)
  assert.match(rec.alerts[0].lines[0].action ?? '', /Stripe/, 'the action tells him where to read the real amount')
  assert.ok(db.jobs.size === 1, 'the job is still created — the booking really is confirmed')
})

test('M1: the DISCORD card and the ADMIN retry message both render the unknown case', async () => {
  const m = await load()
  resetDb(await createdRow())
  await shippedDeps()

  const res = await approve()
  assert.ok(res.ok)

  // The admin surface's own words for this result.
  const message = m.approval.retryApprovalMessage(res)
  assert.ok(!message.includes('$'), `no amount may be printed: ${message}`)
  assert.ok(!message.includes(String(ODD_DEPOSIT_AMOUNT)), message)
  assert.match(message, /Stripe did not report/i, 'and the reason is stated plainly')

  // The Discord card is fed `result.capturedCents` and prints an amount only
  // when it is a number (item R7, pinned by discord-card-truth.test.ts). What
  // this item guarantees is what it is FED.
  assert.equal(res.ok && res.capturedCents, null, 'the card is handed UNKNOWN, not the deposit column')
})

test('M1: a proven amount is still recorded — and it is STRIPE\'s number, not the booking\'s', async () => {
  resetDb(await createdRow())
  // Stripe captured $7.00 on a booking whose depositAmount column says $123.45.
  const rec = await shippedDeps({ captureIntent: { status: 'succeeded', amount_received: 700, latest_charge: 'ch_m1', metadata: {} } })

  const res = await approve()

  assert.ok(res.ok)
  assert.equal(res.ok && res.capturedCents, 700)
  assert.equal(db.payments.length, 1, 'a proven amount IS recorded')
  assert.equal(db.payments[0].amount, 700, 'and it is the one Stripe reported')
  assert.equal((approvalAudits()[0].details as Row).captured, 700)
  assert.equal(rec.notified[0].cents, 700)
  assert.equal(rec.alerts.length, 0, 'a capture with a known amount is not an incident')
  assert.ok(!everythingSaid(rec).includes(String(ODD_DEPOSIT_AMOUNT)))
})

test('M1: the unknown case stays REPAIRABLE — a later capture with an amount records it', async () => {
  // Refusing to invent must not mean refusing forever. The deposit is left
  // unrecorded, which is the state `convergeConfirmed` already knows how to
  // repair, so the admin's "Retry payment record" finishes the job the moment
  // Stripe reports a number.
  resetDb(await createdRow())
  await shippedDeps()
  const first = await approve()
  assert.ok(first.ok)
  assert.equal(db.payments.length, 0)

  const rec = await shippedDeps({ captureIntent: { status: 'succeeded', amount_received: 4900, latest_charge: 'ch_m1', metadata: {} } })
  const repaired = await approve() // the booking is CONFIRMED → convergeConfirmed

  assert.ok(repaired.ok, `the repair must converge: ${!repaired.ok ? repaired.message : ''}`)
  assert.equal(repaired.ok && repaired.capturedCents, 4900)
  assert.equal(db.payments.length, 1, 'the Payment row is finally written')
  assert.equal(db.payments[0].amount, 4900, 'with the amount Stripe reported')
  assert.equal(approvalAudits().length, 1, 'and one capture still has exactly one ledger row')
  assert.equal(rec.captures.length, 0, 'nothing was captured twice')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE PURE RULE — Stripe or nothing
// ════════════════════════════════════════════════════════════════════════════

test('M1: capturedAmountFromIntent reads Stripe, and only Stripe', async () => {
  const { capturedAmountFromIntent } = (await load()).approval

  assert.equal(capturedAmountFromIntent({ id: PI, amount_received: 4900 }), 4900, 'the captured amount wins')
  assert.equal(
    capturedAmountFromIntent({ id: PI, amount_received: 4900, amount: 12345 }),
    4900,
    'and it wins over the intent amount',
  )
  assert.equal(
    capturedAmountFromIntent({ id: PI, amount: 4900 }),
    4900,
    'the intent amount is used only when Stripe reported no captured amount (this module always captures in full)',
  )
  assert.equal(
    capturedAmountFromIntent({ id: PI, amount_received: 0, amount: 4900 }),
    null,
    'a PRESENT zero is Stripe saying the money did not arrive — it must never be rounded up to the authorization',
  )
  assert.equal(capturedAmountFromIntent({ id: PI, status: 'succeeded' }), null, 'no amounts at all ⇒ unknown')
  assert.equal(capturedAmountFromIntent({ id: PI, amount_received: null, amount: null }), null)
  assert.equal(capturedAmountFromIntent(null), null)
  assert.equal(capturedAmountFromIntent({ id: PI, amount_received: Number.NaN }), null, 'and nothing unusable is a figure')
})

test('M1: the module cannot fall back to a booking column again (source guard)', () => {
  // Comments stripped: a rule about CODE must not be satisfied by prose.
  const src = readFileSync(join(process.cwd(), 'src/lib/booking-approval.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.ok(
    !/\?\?\s*booking\.depositAmount/.test(src),
    'the captured amount must never fall back to a booking column — that IS item M1',
  )
  assert.ok(
    !/capturedCents\s*=\s*intent\./.test(src),
    'the amount must come from capturedAmountFromIntent, so there is exactly one rule',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE CUSTOMER EMAIL — an unknown amount must not silence the confirmation
// ════════════════════════════════════════════════════════════════════════════

test('M1: the confirmation email is still allowed to send with no amount, and still needs its date + link', async () => {
  const m = await load()
  const base = {
    displayId: 'WMIC-1042',
    date: '2027-09-14T13:00:00.000Z',
    timeLabel: '8–10 AM',
    portalUrl: 'https://moveitclearit.com/my-booking/tok_m1',
  }

  // The M1 payload: no amountPaid, because Stripe reported none.
  m.validation.assertEmailPayload('final-confirmation', base)
  // …and everything this gate actually exists for still blocks.
  assert.throws(
    () => m.validation.assertEmailPayload('final-confirmation', { ...base, date: '' }),
    m.validation.EmailValidationError,
    'a confirmation without a real date must still be refused',
  )
  assert.throws(
    () => m.validation.assertEmailPayload('final-confirmation', { ...base, portalUrl: '' }),
    m.validation.EmailValidationError,
    'and one without a link to act on',
  )
})

test('M1: the confirmation template names no amount when none was proven', async () => {
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: FinalConfirmation } = await import('../../emails/final-confirmation')

  const common = {
    customerName: 'Maria',
    displayId: 'WMIC-1042',
    date: '2027-09-14T13:00:00.000Z',
    timeLabel: '8–10 AM',
    portalUrl: 'https://moveitclearit.com/my-booking/tok_m1',
  }

  for (const locale of ['en', 'es'] as const) {
    const html = await render(React.createElement(FinalConfirmation, { ...common, locale }))
    assert.ok(!html.includes(String(ODD_DEPOSIT_AMOUNT)), `${locale}: no booking column may be printed`)
    assert.ok(!html.includes('$123.45'), `${locale}: nor any rendering of it`)
    assert.ok(
      !/the amount shown above|el monto indicado arriba/.test(html),
      `${locale}: the deposit sentence must be rewritten, not left pointing at an amount that is not there`,
    )
    assert.match(html, /approved|aprobada/i, `${locale}: and the customer is still told their booking is approved`)

    // With a proven amount the copy is unchanged.
    const withAmount = await render(React.createElement(FinalConfirmation, { ...common, locale, amountPaid: '49' }))
    assert.ok(withAmount.includes('$49'), `${locale}: a proven amount is still printed`)
  }
})
