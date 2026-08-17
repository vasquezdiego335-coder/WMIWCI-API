// ════════════════════════════════════════════════════════════════════════════
//  shipped-amount-truth.test.ts — REPAIR ITEM D2
//
//  THE DEFECT. Item M1 removed `?? booking.depositAmount` from the approval
//  service. The invented amount survived on THE TWO PATHS THAT ACTUALLY SHIP:
//
//   1. THE OUTBOX EMAIL PATH — what EMAIL-REGISTRY.md calls "the live setting"
//      (OUTBOX_ENABLED=true). `ApprovedPayload` carried NO amount at all, so
//      `premiumEmails.renderFinalConfirmation` fell through to
//      `dollarsFromCents(b?.depositAmount)`. With `depositAmount = 12345` the
//      customer's confirmation read:
//          "Your $123.45 deposit is applied to your move"
//      over a booking with no completed payment of any kind.
//
//   2. THE PAYMENT-RECEIPT RESEND ROUTE — `amountPaid` from `depositAmount` and
//      `captured` from `depositPaid`. Both are intention columns:
//      `claimConfirm` sets `depositPaid: true` BEFORE the Stripe capture runs
//      (src/lib/booking-approval.ts), so the receipt printed
//      "$123.45 · Charged to your card" over money nobody had taken.
//
//  THE FIX UNDER TEST. One rule, in one place
//  (`src/outbox/domain/captured-amount.ts`): a dollar figure may be printed
//  only when a COMPLETED Payment row carries it — the ledger the approval path
//  writes ONLY from a Stripe-reported amount and REFUSES to write when Stripe
//  reports none. Absent proof ⇒ the confirmation names no amount (and still
//  ships), and the receipt is NOT SENT AT ALL, with an owner-honest 409.
//
//  WHY THIS IS NOT THEATRE
//   • the booking row is what the SHIPPED WRITER persists (`AdminBookingSchema`
//     → `resolveMoveSchedule` → `buildBookingCreateData`, default owner path),
//     with only `depositAmount`/`depositPaid` forced to the reproduction values;
//   • the RECEIPT ROUTE HANDLER IS EXECUTED — the real `POST` from
//     app/api/admin/receipts/[id]/resend/route.ts, with only the session, the
//     BullMQ queue and Prisma faked at the module boundary;
//   • the CONFIRMATION goes through the real `handleApprove` → the real
//     email_jobs INSERT → the real `sendFinalConfirmationEmail` →
//     `renderFinalConfirmation`, and the HTML asserted on is what `guardedSend`
//     was handed;
//   • every money assertion is MUTATION-TESTED: `harness check` drives the
//     SHIPPED templates with the argument the PRE-FIX lines produced and proves
//     the same checkers report the defect.
//
//  Offline: no database, no Stripe, no Redis, no network. Run:
//    npx tsx --test src/lib/__tests__/shipped-amount-truth.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>

const BOOKING_ID = 'bk_d2'
const PI = 'pi_d2'
/** The odd value the money doc names. Nothing Stripe reports is ever 12345, so
 *  any 12345 in a message came from the booking column. */
const ODD_DEPOSIT_AMOUNT = 12345
const ODD_DOLLARS = '123.45'
/** What a real $49 capture looks like in the ledger. */
const REAL_CAPTURE_CENTS = 4900

// ── The fake database ───────────────────────────────────────────────────────

type FakeDb = {
  booking: Row | null
  payments: Row[]
  audits: Row[]
  outboxState: string | null
  emailJobs: Array<{ bookingId: string; eventType: string; payload: string }>
}

let db: FakeDb = { booking: null, payments: [], audits: [], outboxState: null, emailJobs: [] }

function project(row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row }
  const out: Row = {}
  for (const [key, val] of Object.entries(select)) {
    if (!val) continue
    out[key] = row[key] === undefined ? null : row[key]
  }
  return out
}

const fakePrisma: any = {
  booking: {
    async findUnique(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      if (!db.booking) return null
      if (args.where?.id && args.where.id !== db.booking.id) return null
      return args.select ? project(db.booking, args.select) : { ...db.booking }
    },
    async findFirst(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row | null> {
      return fakePrisma.booking.findUnique(args)
    },
  },
  payment: {
    async findMany(args: { where?: Row; select?: Record<string, unknown> }): Promise<Row[]> {
      return db.payments
        .filter((p) => !args.where?.bookingId || p.bookingId === args.where.bookingId)
        .map((p) => project(p, args.select))
    },
  },
  auditLog: {
    async create(args: { data: Row }): Promise<Row> {
      db.audits.push({ ...args.data })
      return args.data
    },
  },
  async $transaction(arg: unknown): Promise<unknown> {
    if (Array.isArray(arg)) return Promise.all(arg)
    return (arg as (tx: unknown) => Promise<unknown>)(fakePrisma)
  },
  // The outbox repo speaks raw SQL. Tagged templates arrive as (strings, ...values).
  async $queryRaw(strings: TemplateStringsArray): Promise<unknown[]> {
    const sql = strings.join('?')
    if (/SELECT\s+outbox_state/i.test(sql)) return db.booking ? [{ outbox_state: db.outboxState }] : []
    return []
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join('?')
    if (/UPDATE\s+bookings/i.test(sql)) {
      db.outboxState = values[0] as string
      return 1
    }
    if (/INSERT\s+INTO\s+email_jobs/i.test(sql)) {
      db.emailJobs.push({
        bookingId: values[1] as string,
        eventType: values[2] as string,
        payload: values[4] as string,
      })
      return 1
    }
    return 0
  },
}
;(globalThis as any).prisma = fakePrisma

// ── Module-boundary fakes: the session, BullMQ, and the email provider ───────
//  Everything else — the route handler, the outbox controller, the repo SQL,
//  the renderers and the React templates — is the shipped code.

type QueuedEmail = { name: string; data: any }
const queuedEmails: QueuedEmail[] = []
type SentEmail = { to: string; template: string; html: string; text: string; payload: Record<string, unknown> }
const sentEmails: SentEmail[] = []
let session: Row | null = { userId: 'u_owner', role: 'OWNER', name: 'Diego' }

const NodeModule = require('module') as any
const realLoad = NodeModule._load
NodeModule._load = function (request: string, ...rest: any[]) {
  if (request === '@/lib/auth') return { getSession: async () => session }
  if (request === '@/lib/queues') {
    return {
      emailQueue: {
        async add(name: string, data: any) {
          queuedEmails.push({ name, data })
          return { id: `job_${queuedEmails.length}` }
        },
      },
    }
  }
  // The outbox send path: keep the REAL module (classifyTemplate and friends)
  // and replace only the provider call, so `deliverRendered` runs for real.
  if (request === '../../lib/email-guard' && String(rest[0]?.filename ?? '').includes('emailService')) {
    const real = realLoad.call(this, request, ...rest)
    return {
      ...real,
      guardedSend: async (opts: any) => {
        sentEmails.push({
          to: opts.to,
          template: opts.template,
          html: opts.html,
          text: opts.text,
          payload: opts.payload,
        })
        return { sent: true, providerId: `prov_${sentEmails.length}` }
      },
    }
  }
  return realLoad.call(this, request, ...rest)
}

// ── Modules under test (loaded only AFTER the fakes are installed) ───────────

type Mods = {
  adminBooking: typeof import('../admin-booking')
  estimate: typeof import('../estimate')
  scheduling: typeof import('../scheduling')
  premium: typeof import('../../outbox/services/premiumEmails')
  emailService: typeof import('../../outbox/services/emailService')
  approveController: typeof import('../../outbox/controllers/discordController')
  proof: typeof import('../../outbox/domain/captured-amount')
  events: typeof import('../../outbox/domain/events')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    adminBooking: await import('../admin-booking'),
    estimate: await import('../estimate'),
    scheduling: await import('../scheduling'),
    premium: await import('../../outbox/services/premiumEmails'),
    emailService: await import('../../outbox/services/emailService'),
    approveController: await import('../../outbox/controllers/discordController'),
    proof: await import('../../outbox/domain/captured-amount'),
    events: await import('../../outbox/domain/events'),
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

  return {
    id: BOOKING_ID,
    customerToken: 'tok_d2',
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: null,
    truck: null,
    inventoryItems: [],
    updatedAt: new Date('2027-02-02T15:00:00.000Z'),
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...(data as Row),
    // The state AFTER approval: the intention columns both say "paid".
    status: 'CONFIRMED',
    depositPaid: true,
    stripePaymentIntentId: PI,
    // THE ODD VALUE. Whatever this booking was supposed to be charged, it is not
    // evidence of what Stripe captured.
    depositAmount: ODD_DEPOSIT_AMOUNT,
  }
}

function reset(booking: Row, payments: Row[] = []): void {
  db = { booking: { ...booking }, payments, audits: [], outboxState: null, emailJobs: [] }
  queuedEmails.length = 0
  sentEmails.length = 0
  session = { userId: 'u_owner', role: 'OWNER', name: 'Diego' }
}

/** A COMPLETED Payment row — the ledger the approval path writes only from a
 *  Stripe-reported amount. This is the ONLY thing that proves a capture. */
function completedPayment(over: Row = {}): Row {
  return {
    id: 'pay_real',
    bookingId: BOOKING_ID,
    amount: REAL_CAPTURE_CENTS,
    status: 'COMPLETED',
    isInternalTest: false,
    stripePaymentIntentId: PI,
    createdAt: new Date('2027-01-05T12:00:00.000Z'),
    ...over,
  }
}

// ── The checkers (used on BOTH the shipped output and the pre-fix output, so
//    they are shown to be able to fail) ──────────────────────────────────────

/** Every way the booking column could surface in rendered text. */
function inventedAmountIn(text: string): string | null {
  const flat = text.replace(/&#x27;|&#39;/g, "'").replace(/<[^>]+>/g, ' ')
  if (flat.includes(ODD_DOLLARS)) return `rendered $${ODD_DOLLARS} — the booking column`
  if (flat.includes(String(ODD_DEPOSIT_AMOUNT))) return `rendered ${ODD_DEPOSIT_AMOUNT} — the booking column in cents`
  return null
}

/** A payload is honest only if it states no amount, or states a proven one. */
function receiptPayloadProblem(payload: Row, provenCents: number | null): string | null {
  if (payload.amountPaid == null) return null
  const cents = Math.round(Number(payload.amountPaid) * 100)
  if (provenCents == null) return `stated $${payload.amountPaid} with nothing proven`
  if (cents !== provenCents) return `stated $${payload.amountPaid}, proven ${provenCents} cents`
  return null
}

// ════════════════════════════════════════════════════════════════════════════
//  0. HARNESS CHECK — the checkers SEE the original defect.
// ════════════════════════════════════════════════════════════════════════════

test('D2 harness check: the PRE-FIX confirmation really did print the booking column', async () => {
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: FinalConfirmation } = await import('../../emails/final-confirmation')
  const m = await load()

  // Exactly what the removed line produced: dollarsFromCents(booking.depositAmount).
  const preFix = m.premium.dollarsFromCents(ODD_DEPOSIT_AMOUNT)
  assert.equal(preFix, ODD_DOLLARS)

  const html = await render(
    React.createElement(FinalConfirmation, {
      customerName: 'Maria',
      displayId: 'WMIC-1042',
      date: '2027-09-14T13:00:00.000Z',
      timeLabel: '8-10 AM',
      portalUrl: 'https://moveitclearit.com/my-booking/tok_d2',
      amountPaid: preFix,
      locale: 'en',
    }),
  )
  assert.ok(inventedAmountIn(html), 'the checker cannot see the defect it exists to catch')
  assert.match(
    html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    /\$123\.45 deposit is applied to your move/,
    'the money doc quotes this exact sentence — it must be reproducible here',
  )
})

test('D2 harness check: the PRE-FIX receipt really did print "$123.45 - charged to your card"', async () => {
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: PaymentReceipt } = await import('../../emails/payment-receipt')
  const booking = await createdRow()

  // The payload the route built, line for line, before this item.
  const preFixPayload = {
    customerName: booking.customer.name,
    displayId: booking.displayId,
    amountPaid: (booking.depositAmount / 100).toFixed(2),
    captured: booking.depositPaid,
    date: booking.updatedAt.toISOString(),
    portalUrl: 'https://moveitclearit.com/my-booking/tok_d2',
    locale: 'en',
  }
  assert.ok(
    receiptPayloadProblem(preFixPayload, null),
    'the payload checker cannot see a receipt built from an intention column',
  )

  const html = await render(React.createElement(PaymentReceipt, preFixPayload as never))
  assert.ok(inventedAmountIn(html), 'the rendered checker cannot see the defect either')
  assert.match(html, /Charged to your card/, 'and it claimed the money was taken')
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE OUTBOX CONFIRMATION — the live email path, end to end.
// ════════════════════════════════════════════════════════════════════════════

/** Drive the WHOLE outbox hop: the shipped controller writes the event row, the
 *  row's JSON is read back exactly as the worker reads it, and the shipped
 *  sender renders + delivers it. Returns what `guardedSend` was handed. */
async function approveAndSend(capturedAmountCents?: number | null): Promise<SentEmail> {
  const m = await load()
  const booking = db.booking as Row
  const result = await m.approveController.handleApprove({
    bookingId: booking.id,
    approvedBy: 'Diego',
    customerName: booking.customer.name,
    customerEmail: booking.customer.email,
    requestedDate: booking.requestedDate?.toISOString() ?? null,
    items: booking.itemsDescription ?? undefined,
    ...(capturedAmountCents === undefined ? {} : { capturedAmountCents }),
  })
  assert.equal(result.emailJobCreated, true, 'the outbox row must have been written')
  assert.equal(db.emailJobs.length, 1)

  const job = db.emailJobs[0]
  assert.equal(job.eventType, 'APPROVED')
  // Read it back the way the worker does: JSON out of the email_jobs row.
  const payload = JSON.parse(job.payload) as import('../../outbox/domain/events').ApprovedPayload
  await m.emailService.sendFinalConfirmationEmail(payload)
  assert.equal(sentEmails.length, 1, 'exactly one confirmation is delivered')
  return sentEmails[0]
}

test('D2: the confirmation states NO amount when nothing proves one (depositAmount 12345, no payment)', async () => {
  reset(await createdRow(), []) // the reproduction: odd column, empty ledger
  const sent = await approveAndSend() // …and an APPROVED event with no amount

  assert.equal(sent.template, 'final-confirmation')
  assert.equal(
    inventedAmountIn(sent.html),
    null,
    `the customer's confirmation printed the booking column:\n${sent.html.replace(/<[^>]+>/g, ' ').slice(0, 400)}`,
  )
  assert.equal(inventedAmountIn(sent.text), null, 'and the plain-text part must agree')
  assert.equal(sent.payload.amountPaid, undefined, 'no amount may reach the payload the guard validates')
  // The message that matters still goes out.
  assert.match(sent.html, /approved/i, 'the customer is still told their booking is approved')
  assert.match(sent.html, /WMIC-1042/, 'and can still identify the booking')
  assert.ok(
    !/the amount shown above/i.test(sent.html),
    'the deposit sentence must be rewritten, not left pointing at an amount that is not there',
  )
})

test('D2: a COMPLETED Payment row IS proof — the confirmation then states that figure', async () => {
  reset(await createdRow(), [completedPayment()])
  const sent = await approveAndSend() // still no amount on the event

  assert.equal(inventedAmountIn(sent.html), null, 'the booking column is still never printed')
  assert.equal(sent.payload.amountPaid, '49.00', 'the ledger figure is what ships')
  assert.match(sent.html.replace(/<[^>]+>/g, ' '), /\$49/, 'and the customer sees it')
})

test('D2: the amount Stripe reported travels ON the event and wins (it is the freshest proof)', async () => {
  reset(await createdRow(), []) // empty ledger — only the event knows
  const sent = await approveAndSend(REAL_CAPTURE_CENTS)

  assert.equal(sent.payload.amountPaid, '49.00')
  assert.equal(inventedAmountIn(sent.html), null)
  // …and the event carried it in CENTS, so nothing rounds a $49.50 capture to $50.
  const payload = JSON.parse(db.emailJobs[0].payload) as Row
  assert.equal(payload.capturedAmountCents, REAL_CAPTURE_CENTS)
})

test('D2: an odd capture keeps its cents through the whole hop', async () => {
  reset(await createdRow(), [])
  const sent = await approveAndSend(4950)
  assert.equal(sent.payload.amountPaid, '49.50', '$49.50 must not become "$50"')
})

test('D2: "captured, amount not reported" is carried as NULL, not as the booking column', async () => {
  reset(await createdRow(), [])
  const sent = await approveAndSend(null) // exactly what capturedAmountFromIntent returns

  const payload = JSON.parse(db.emailJobs[0].payload) as Row
  assert.equal(payload.capturedAmountCents, null, 'null is a real answer and must be stored as one')
  assert.equal(sent.payload.amountPaid, undefined)
  assert.equal(inventedAmountIn(sent.html), null)
  assert.match(sent.html, /approved/i, 'and the confirmation still ships')
})

test('D2: an OLD event row (written before this item) degrades to honest, not to invented', async () => {
  reset(await createdRow(), [])
  const m = await load()
  // A row exactly as the previous code wrote it: no amount key at all.
  const legacy = {
    bookingId: BOOKING_ID,
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: null,
    approvedBy: 'Diego',
  } as import('../../outbox/domain/events').ApprovedPayload
  await m.emailService.sendFinalConfirmationEmail(legacy)
  assert.equal(inventedAmountIn(sentEmails[0].html), null)
  assert.equal(sentEmails[0].payload.amountPaid, undefined)
})

test('D2: an unreadable ledger means NO amount — never a fallback to the column', async () => {
  reset(await createdRow(), [])
  const m = await load()
  const realFindMany = fakePrisma.payment.findMany
  // The code-before-SQL window, a dropped connection: the read that would have
  // proved the amount fails. The confirmation must still ship, and must still
  // name no figure.
  fakePrisma.payment.findMany = async () => {
    throw Object.assign(new Error('column "is_internal_test" does not exist'), { code: 'P2022' })
  }
  try {
    await m.emailService.sendFinalConfirmationEmail({
      bookingId: BOOKING_ID,
      customerName: 'Maria Lopez',
      customerEmail: 'maria@example.com',
      requestedDate: null,
      approvedBy: 'Diego',
    })
  } finally {
    fakePrisma.payment.findMany = realFindMany
  }
  assert.equal(sentEmails.length, 1, 'a failed ledger read must not cost the customer their confirmation')
  assert.equal(sentEmails[0].payload.amountPaid, undefined)
  assert.equal(inventedAmountIn(sentEmails[0].html), null)
})

test('D2: the renderer may not derive any amount from a booking column (source guard)', () => {
  // Comments stripped: a rule about CODE must not be satisfied by prose.
  const src = readFileSync(join(process.cwd(), 'src/outbox/services/premiumEmails.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.ok(
    !/dollarsFromCents\(\s*b\?\.\s*depositAmount\s*\)/.test(src),
    'the amount must never come from booking.depositAmount — that IS item D2',
  )
  assert.ok(!/depositAmount/.test(src), 'and the column has no business in an email renderer at all')
  assert.ok(!/depositPaid/.test(src), 'nor the flag that is set before the money moves')
})

test('D2: the outbox worker still routes APPROVED to the sender this test drove', () => {
  const worker = readFileSync(join(process.cwd(), 'src/outbox/workers/emailWorker.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.match(
    worker,
    /case\s+EventType\.APPROVED:\s*[\s\S]{0,80}sendFinalConfirmationEmail\(/,
    'if the worker stops calling sendFinalConfirmationEmail, this file proves nothing about production',
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE PAYMENT-RECEIPT RESEND ROUTE — the shipped handler, executed.
// ════════════════════════════════════════════════════════════════════════════

async function postResend(id = BOOKING_ID): Promise<{ status: number; body: any }> {
  const { POST } = await import('../../../app/api/admin/receipts/[id]/resend/route')
  const res = await POST({} as never, { params: { id } })
  return { status: res.status, body: await res.json() }
}

test('D2: NO receipt is sent for a booking with no proven payment — and nothing is recorded', async () => {
  reset(await createdRow(), []) // depositAmount 12345, depositPaid TRUE, empty ledger
  const { status, body } = await postResend()

  assert.equal(status, 409, 'a receipt for unproven money must be refused')
  assert.equal(body.reason, 'no_payment_row')
  assert.equal(queuedEmails.length, 0, 'no receipt email may be queued')
  assert.equal(db.audits.length, 0, 'and no RECEIPT_SENT audit may claim one was')
  assert.equal(
    inventedAmountIn(JSON.stringify(body)),
    null,
    'not even the refusal may quote a figure it cannot prove',
  )
  // The owner is told which fact is missing, and what to do.
  assert.match(body.message, /No payment is recorded/)
  assert.match(body.message, /Stripe/)
})

test('D2: with a COMPLETED payment the receipt states THAT amount — never the booking column', async () => {
  reset(await createdRow(), [completedPayment()])
  const { status, body } = await postResend()

  assert.equal(status, 200)
  assert.equal(queuedEmails.length, 1)
  const job = queuedEmails[0].data
  assert.equal(job.template, 'payment-receipt')
  assert.equal(job.payload.amountPaid, '49.00')
  assert.equal(job.payload.captured, true)
  assert.equal(receiptPayloadProblem(job.payload, REAL_CAPTURE_CENTS), null)
  // The DATE is the payment's own timestamp, not "whenever the booking last changed".
  assert.equal(job.payload.date, '2027-01-05T12:00:00.000Z')
  assert.notEqual(job.payload.date, (db.booking as Row).updatedAt.toISOString())
  // The balance rows are derived from the SAME proof as the headline figure.
  assert.equal(job.payload.remainingBalance, '651.00', '$700 estimate less the $49 actually collected')
  assert.equal(inventedAmountIn(JSON.stringify(job.payload)), null)
  // And the audit says WHICH payment was receipted.
  assert.equal(db.audits.length, 1)
  assert.equal(db.audits[0].action, 'RECEIPT_SENT')
  assert.equal(db.audits[0].details.amountCents, REAL_CAPTURE_CENTS)
  assert.equal(db.audits[0].details.paymentId, 'pay_real')
  assert.match(body.message, /\$49\.00/)
})

test('D2: the queued receipt RENDERS with the proven amount and no trace of the column', async () => {
  reset(await createdRow(), [completedPayment()])
  await postResend()
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: PaymentReceipt } = await import('../../emails/payment-receipt')

  const html = await render(React.createElement(PaymentReceipt, queuedEmails[0].data.payload as never))
  assert.equal(inventedAmountIn(html), null, 'the rendered receipt printed the booking column')
  assert.match(html.replace(/<[^>]+>/g, ' '), /\$49\.00/, 'the proven figure is what the customer reads')
  assert.match(html, /Charged to your card/, 'and a COMPLETED row does prove the charge')
})

test('D2: an authorization that was never captured gets no receipt', async () => {
  reset(await createdRow(), [completedPayment({ status: 'PENDING' })])
  const { status, body } = await postResend()
  assert.equal(status, 409)
  assert.equal(body.reason, 'not_completed')
  assert.equal(queuedEmails.length, 0)
  assert.equal(db.audits.length, 0)
})

test('D2: a REFUNDED payment gets no receipt (the template has no refund line to tell the truth with)', async () => {
  reset(await createdRow(), [completedPayment({ status: 'REFUNDED' })])
  const { status, body } = await postResend()
  assert.equal(status, 409)
  assert.equal(body.reason, 'not_completed')
  assert.equal(queuedEmails.length, 0)
})

test('D2: an owner checkout TEST is not money — no receipt', async () => {
  reset(await createdRow(), [completedPayment({ isInternalTest: true })])
  const { status, body } = await postResend()
  assert.equal(status, 409)
  assert.equal(body.reason, 'internal_test_only')
  assert.equal(queuedEmails.length, 0)
  assert.equal(db.audits.length, 0)
})

test('D2: a zero-amount ledger row is not a figure — no "$0.00" receipt', async () => {
  reset(await createdRow(), [completedPayment({ amount: 0 })])
  const { status, body } = await postResend()
  assert.equal(status, 409)
  assert.equal(body.reason, 'no_amount')
  assert.equal(queuedEmails.length, 0)
})

test('D2: the deposit intent wins when several payments exist (a move-day payment is not the deposit)', async () => {
  reset(await createdRow(), [
    completedPayment({ id: 'pay_moveday', amount: 55000, stripePaymentIntentId: 'pi_other', createdAt: new Date('2027-03-01T10:00:00.000Z') }),
    completedPayment(),
  ])
  await postResend()
  assert.equal(queuedEmails[0].data.payload.amountPaid, '49.00', 'the booking\'s own PaymentIntent is the deposit')
  assert.equal(db.audits[0].details.paymentId, 'pay_real')
})

test('D2: the route is still owner/manager only, and still 404s an unknown booking', async () => {
  reset(await createdRow(), [completedPayment()])
  session = { userId: 'u_crew', role: 'CREW', name: 'Sam' }
  assert.equal((await postResend()).status, 403)
  session = null
  assert.equal((await postResend()).status, 403)
  reset(await createdRow(), [completedPayment()])
  assert.equal((await postResend('bk_nope')).status, 404)
  assert.equal(queuedEmails.length, 0, 'a refused caller queues nothing')
})

test('D2: the receipt route may not read an intention column (source guard)', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/admin/receipts/[id]/resend/route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.ok(!/booking\.depositAmount/.test(src), 'amountPaid came from this column — that IS item D2')
  assert.ok(!/booking\.depositPaid/.test(src), '`captured` came from this flag, which is set before the money moves')
  assert.match(src, /provenCapturedDeposit\(/, 'the amount must come from the shared proof rule')
  // The audit may only be written on a path that actually queued a receipt.
  const auditIdx = src.indexOf("action: 'RECEIPT_SENT'")
  const refuseIdx = src.indexOf('status: 409')
  assert.ok(refuseIdx > -1 && auditIdx > refuseIdx, 'the refusal must return before the RECEIPT_SENT audit')
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE RULE ITSELF — pure, and the same one both paths use.
// ════════════════════════════════════════════════════════════════════════════

// ITEM C1 (2026-08-16) — the two rule tests below were UPDATED, not relaxed.
// They used to bless a COMPLETED row with NO Stripe id as proof of a captured
// card deposit, which is the defect C1 names: `app/api/admin/payments/route.ts`
// writes exactly that row for hand-entered CASH money. Every original assertion
// is still here; the rows that are meant to BE captures now carry the Stripe id
// a capture always has, and the two new refusals are asserted alongside.
test('D2/C1: provenCapturedDeposit answers only from a COMPLETED, non-test, STRIPE-REPORTED, positive row', async () => {
  const m = await load()
  const p = m.proof.provenCapturedDeposit
  const PI_ONLY = { stripePaymentIntentId: 'pi_rule' }

  assert.deepEqual(p([]), { proven: false, reason: 'no_payment_row' })
  assert.deepEqual(p(null), { proven: false, reason: 'no_payment_row' })
  assert.deepEqual(p([{ amount: 4900, status: 'PENDING', ...PI_ONLY }]), { proven: false, reason: 'not_completed' })
  assert.deepEqual(p([{ amount: 4900, status: 'FAILED', ...PI_ONLY }]), { proven: false, reason: 'not_completed' })
  assert.deepEqual(p([{ amount: 4900, status: 'PARTIALLY_REFUNDED', ...PI_ONLY }]), { proven: false, reason: 'not_completed' })
  assert.deepEqual(p([{ amount: 4900, status: 'COMPLETED', isInternalTest: true, ...PI_ONLY }]), {
    proven: false,
    reason: 'internal_test_only',
  })
  assert.deepEqual(p([{ amount: -100, status: 'COMPLETED', ...PI_ONLY }]), { proven: false, reason: 'no_amount' })
  assert.deepEqual(p([{ amount: Number.NaN, status: 'COMPLETED', ...PI_ONLY }]), { proven: false, reason: 'no_amount' })

  // ITEM C1 — a hand-entered CASH row is real revenue and is NOT a card capture.
  assert.deepEqual(p([{ id: 'cash', amount: 65000, status: 'COMPLETED' }]), {
    proven: false,
    reason: 'not_stripe_reported',
  })
  // ITEM C1 — a completed charge that is NOT this booking's deposit intent.
  assert.deepEqual(
    p([{ id: 'moveday', amount: 65000, status: 'COMPLETED', stripePaymentIntentId: 'pi_other' }], {
      stripePaymentIntentId: 'pi_deposit',
    }),
    { proven: false, reason: 'intent_mismatch' },
  )
  // A charge id alone is Stripe's evidence too (the refund/charge webhook path).
  assert.equal(m.proof.provenCapturedCents([{ amount: 4900, status: 'COMPLETED', stripeChargeId: 'ch_1' }]), 4900)

  const ok = p([{ id: 'x', amount: 4900, status: 'COMPLETED', ...PI_ONLY, createdAt: new Date('2027-01-01T00:00:00.000Z') }])
  assert.deepEqual(ok, { proven: true, cents: 4900, paymentId: 'x', capturedAt: new Date('2027-01-01T00:00:00.000Z') })
  assert.equal(m.proof.provenCapturedCents([{ amount: 4900, status: 'COMPLETED', ...PI_ONLY }]), 4900)
  assert.equal(m.proof.provenCapturedCents([{ amount: 4900, status: 'PENDING', ...PI_ONLY }]), null)
})

test('D2: with no intent to match, the OLDEST completed payment is the deposit', async () => {
  const m = await load()
  const proof = m.proof.provenCapturedDeposit([
    { id: 'late', amount: 55000, status: 'COMPLETED', stripePaymentIntentId: 'pi_late', createdAt: new Date('2027-03-01T00:00:00.000Z') },
    { id: 'first', amount: 4900, status: 'COMPLETED', stripePaymentIntentId: 'pi_first', createdAt: new Date('2027-01-01T00:00:00.000Z') },
  ])
  assert.equal(proof.proven && proof.paymentId, 'first')
  assert.equal(proof.proven && proof.cents, 4900)
})

test('D2: every refusal reason has an owner instruction, and none of them guesses an amount', async () => {
  const m = await load()
  const reasons: Array<import('../../outbox/domain/captured-amount').UnprovenReason> = [
    'no_payment_row',
    'not_completed',
    'internal_test_only',
    'not_stripe_reported',
    'intent_mismatch',
    'no_amount',
  ]
  for (const reason of reasons) {
    const text = m.proof.unprovenExplanation(reason)
    assert.ok(text.length > 40, `${reason}: the owner needs a sentence, not a code`)
    assert.ok(!/\$\d/.test(text), `${reason}: a refusal must not name a dollar figure`)
  }
})
