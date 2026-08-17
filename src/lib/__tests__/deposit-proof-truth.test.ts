// ════════════════════════════════════════════════════════════════════════════
//  deposit-proof-truth.test.ts — ITEM C1
//
//  THE RULE UNDER TEST: no customer- or owner-facing string may state an amount
//  the system cannot prove from the database. `Booking.depositAmount` is an
//  INTENTION column (what the booking was supposed to be charged) and
//  `Booking.depositPaid` is set by the approval CLAIM before Stripe is called,
//  so neither is evidence of anything.
//
//  THE FOUR DEFECTS THIS FILE PINS, each reproduced before it is shown fixed:
//
//   1. THE PROOF RULE ITSELF ACCEPTED MONEY STRIPE NEVER REPORTED. "A COMPLETED
//      Payment row is proof by construction" is true of the APPROVAL path and
//      false of the LEDGER: app/api/admin/payments/route.ts writes COMPLETED
//      rows for CASH/ZELLE move-day money from an amount an owner TYPES. A
//      booking whose $49 was never captured, with a $650 cash payment recorded,
//      proved a "$650.00 · Charged to your card" deposit receipt.
//
//   2. THE PROVEN AMOUNT NEVER TRAVELLED ON THE OUTBOX EVENT, so the live email
//      path fell back to `booking.depositAmount`.
//
//   3. THE PRE-APPROVAL HOLD FIGURE was `(session.amount_total ?? 4900)`.
//      Stripe types `amount_total` as nullable, so a session that reported none
//      put the house $49 into a customer's inbox as an authorization — while the
//      SAME run recorded `{ authorized: true, amount: null }` in the audit row
//      and told the owner "Stripe reported no amount".
//
//   4. THE RECEIPT ROUTE'S LEDGER READ WAS UNGUARDED — a P2022 in the
//      code-before-SQL window or a Neon blip became a bare 500, indistinguishable
//      from "we refuse to state this amount".
//
//  WHAT IS ACTUALLY EXERCISED — no paraphrases:
//   • the proof rule, the evidence reader and the Discord card builders are the
//     SHIPPED exported functions;
//   • the RECEIPT ROUTE HANDLER is the real `POST`, executed, with only the
//     session, the queue and Prisma faked at the module boundary;
//   • the ADMIN CANCELLATION EMAIL builder is LIFTED out of the status route
//     with the TypeScript parser and CALLED — a Next.js route may only export
//     handlers — and its payload is then rendered through the shipped React
//     template;
//   • the PRE-APPROVAL hold derivation is LIFTED out of src/lib/fulfillment.ts
//     and EVALUATED, and its answer is driven through the shipped outbox
//     controller → the real email_jobs row → the shipped sender → the shipped
//     template, so the HTML asserted on is what `guardedSend` was handed.
//
//  Offline: no database, no Stripe, no Redis, no network.
//    npx tsx --test src/lib/__tests__/deposit-proof-truth.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.APP_URL = 'https://example.test'
delete process.env.OUTBOX_EMAIL_DRYRUN

const ROOT = join(__dirname, '..', '..', '..')
const STATUS_ROUTE = join(ROOT, 'app', 'api', 'admin', 'bookings', '[id]', 'status', 'route.ts')
const JOB_PAGE = join(ROOT, 'app', '(admin)', 'admin', '(dashboard)', 'jobs', '[id]', 'page.tsx')
const FULFILLMENT = join(ROOT, 'src', 'lib', 'fulfillment.ts')

type Row = Record<string, any>

const BOOKING_ID = 'bk_c1'
const PI = 'pi_c1'
/** The odd column value the contract names: "depositAmount set to an odd value
 *  and no completed payment". Stripe never reports 12345. */
const ODD_DEPOSIT_AMOUNT = 12345
const ODD_DOLLARS = '123.45'
const REAL_CAPTURE_CENTS = 4900
/** The move-day cash row from the finding — real money, not a card deposit. */
const CASH_CENTS = 65000

// ════════════════════════════════════════════════════════════════════════════
//  The fake database + module fakes, installed BEFORE any app import.
// ════════════════════════════════════════════════════════════════════════════

type FakeDb = {
  booking: Row | null
  payments: Row[]
  audits: Row[]
  outboxState: string | null
  emailJobs: Array<{ bookingId: string; eventType: string; payload: string }>
  /** Make the PAYMENT ledger read throw — the code-before-SQL window / Neon blip. */
  paymentReadError?: string
  /** Make the AUDIT read throw — the other half of `readDepositEvidence`. */
  auditReadError?: string
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
      if (db.paymentReadError) throw new Error(db.paymentReadError)
      return db.payments
        .filter((p) => !args.where?.bookingId || p.bookingId === args.where.bookingId)
        .map((p) => project(p, args.select))
    },
  },
  auditLog: {
    async findMany(args: { where?: Row }): Promise<Row[]> {
      if (db.auditReadError) throw new Error(db.auditReadError)
      const actions = (args.where?.action?.in as string[]) ?? null
      return db.audits
        .filter((a) => (!args.where?.bookingId || a.bookingId === args.where.bookingId) && (!actions || actions.includes(a.action)))
        .slice()
        .reverse() // newest first, exactly as `orderBy: { createdAt: 'desc' }`
    },
    async create(args: { data: Row }): Promise<Row> {
      db.audits.push({ ...args.data })
      return args.data
    },
  },
  async $transaction(arg: unknown): Promise<unknown> {
    if (Array.isArray(arg)) return Promise.all(arg)
    return (arg as (tx: unknown) => Promise<unknown>)(fakePrisma)
  },
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
      db.emailJobs.push({ bookingId: values[1] as string, eventType: values[2] as string, payload: values[4] as string })
      return 1
    }
    return 0
  },
}
;(globalThis as any).prisma = fakePrisma

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
  if (request === '../../lib/email-guard' && String(rest[0]?.filename ?? '').includes('emailService')) {
    const real = realLoad.call(this, request, ...rest)
    return {
      ...real,
      guardedSend: async (opts: any) => {
        sentEmails.push({ to: opts.to, template: opts.template, html: opts.html, text: opts.text, payload: opts.payload })
        return { sent: true, providerId: `prov_${sentEmails.length}` }
      },
    }
  }
  return realLoad.call(this, request, ...rest)
}

// ── Modules under test (loaded only AFTER the fakes are installed) ───────────

type Mods = {
  proof: typeof import('../../outbox/domain/captured-amount')
  evidence: typeof import('../deposit-evidence')
  display: typeof import('../booking-display')
  stripeController: typeof import('../../outbox/controllers/stripeController')
  discordController: typeof import('../../outbox/controllers/discordController')
  emailService: typeof import('../../outbox/services/emailService')
  receiptRoute: typeof import('../../../app/api/admin/receipts/[id]/resend/route')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    proof: await import('../../outbox/domain/captured-amount'),
    evidence: await import('../deposit-evidence'),
    display: await import('../booking-display'),
    stripeController: await import('../../outbox/controllers/stripeController'),
    discordController: await import('../../outbox/controllers/discordController'),
    emailService: await import('../../outbox/services/emailService'),
    receiptRoute: await import('../../../app/api/admin/receipts/[id]/resend/route'),
  }
  const dbModule = await import('../db')
  assert.equal(dbModule.prisma as unknown, fakePrisma, 'the fake prisma must be the client the shipped modules use')
  return mods
}

// ── Lifting shipped declarations out of files that cannot be imported ────────

function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function declarationOf(path: string, name: string): string {
  const source = ts.createSourceFile(path, codeOf(path), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX)
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(source)
  }
  assert.fail(`could not find \`function ${name}\` in ${path} — this guard has drifted from the source`)
}

function lift<T>(path: string, name: string, bindings: Record<string, unknown>): T {
  const js = ts.transpileModule(declarationOf(path, name), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText
  const names = Object.keys(bindings)
  return new Function(...names, `${js}\nreturn ${name};`)(...names.map((n) => bindings[n])) as T
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function bookingRow(over: Row = {}): Row {
  return {
    id: BOOKING_ID,
    displayId: 'WMIC-1042',
    status: 'CONFIRMED',
    customerToken: 'tok_c1',
    stripePaymentIntentId: PI,
    // THE ODD COLUMN, with the claim flag set: exactly the B1 failure state.
    depositAmount: ODD_DEPOSIT_AMOUNT,
    depositPaid: true,
    totalEstimate: 599,
    truckAddonDueOnMoveDay: false,
    truckAddonAmount: null,
    travelFee: 0,
    travelFeeDueOnMoveDay: false,
    manualReviewRequired: false,
    itemsDescription: 'Service: 1 Bedroom move',
    requestedDate: new Date('2027-09-14T12:00:00.000Z'),
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: null,
    startTimeKnown: false,
    originAddress: '1 A St, Newark NJ',
    destAddress: '2 B St, Newark NJ',
    originAccessNotes: null,
    specialtyItems: null,
    customerNotes: null,
    hasElevator: false,
    originHasElevator: null,
    destHasElevator: null,
    originStairCount: null,
    destStairCount: null,
    truckProvider: null,
    truckSize: null,
    serviceAreaZone: 'primary',
    updatedAt: new Date('2027-02-02T15:00:00.000Z'),
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...over,
  }
}

type Proof = typeof import('../../outbox/domain/captured-amount')
function stripeDeposit(over: Row = {}): any {
  return {
    id: 'pay_stripe',
    bookingId: BOOKING_ID,
    amount: REAL_CAPTURE_CENTS,
    status: 'COMPLETED',
    isInternalTest: false,
    stripePaymentIntentId: PI,
    stripeChargeId: 'ch_1',
    refundedAmountCents: null,
    createdAt: new Date('2027-01-05T12:00:00.000Z'),
    ...over,
  }
}
/** What app/api/admin/payments/route.ts writes when Diego records move-day
 *  cash: COMPLETED, real money, an amount he TYPED, no Stripe id at all. */
function cashPayment(over: Row = {}): any {
  return {
    id: 'pay_cash',
    bookingId: BOOKING_ID,
    amount: CASH_CENTS,
    status: 'COMPLETED',
    isInternalTest: false,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    refundedAmountCents: null,
    createdAt: new Date('2027-09-14T20:00:00.000Z'),
    ...over,
  }
}

function reset(booking: Row | null = bookingRow(), payments: Row[] = [], audits: Row[] = []): void {
  db = { booking: booking ? { ...booking } : null, payments, audits, outboxState: null, emailJobs: [] }
  queuedEmails.length = 0
  sentEmails.length = 0
  session = { userId: 'u_owner', role: 'OWNER', name: 'Diego' }
}

const strip = (html: string): string => html.replace(/&#x27;|&#39;/g, "'").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

/** Every way the intention column could surface in rendered text. */
function inventedAmountIn(text: string): string | null {
  if (text.includes(ODD_DOLLARS)) return `stated $${ODD_DOLLARS} — the booking column`
  if (text.includes(String(ODD_DEPOSIT_AMOUNT))) return `stated ${ODD_DEPOSIT_AMOUNT} — the booking column in cents`
  return null
}
const houseFeeIn = (text: string): boolean => /\$\s?49\b/.test(text)

// ════════════════════════════════════════════════════════════════════════════
//  0. HARNESS CHECKS — the checkers SEE the original defects.
// ════════════════════════════════════════════════════════════════════════════

test('C1 harness check: the PRE-FIX rule accepted the move-day CASH row as a card deposit', async () => {
  const m = await load()
  const rows = [cashPayment()]

  // The rule as it stood before item C1: "a COMPLETED row that is not an
  // internal test", with no question about Stripe and no intent match.
  const preFix = rows.filter((p) => p.status === 'COMPLETED' && !p.isInternalTest)[0]
  assert.ok(preFix, 'the reproduction must reproduce')
  assert.equal(preFix.amount, CASH_CENTS, 'a $650 cash payment became the $49 deposit receipt')

  // The shipped rule refuses it, and says WHICH fact is missing.
  const proof = m.proof.provenCapturedDeposit(rows, { stripePaymentIntentId: PI })
  assert.equal(proof.proven, false)
  assert.equal((proof as any).reason, 'not_stripe_reported')
})

test('C1 harness check: the PRE-FIX pre-approval printed $49 for an unreported hold', async () => {
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: PreApproval } = await import('../../emails/pre-approval')

  // Exactly what `(amountTotalCents ?? 4900)` produced when Stripe reported none.
  const amountTotalCents: number | null = JSON.parse('null')
  const preFix = (amountTotalCents ?? 4900) / 100
  const html = await render(React.createElement(PreApproval, { locale: 'en', amountHold: preFix.toFixed(2) }))
  assert.ok(houseFeeIn(strip(html)), 'the house-fee checker cannot see the defect it exists to catch')
  assert.match(strip(html), /\$49\.00 hold/)
})

test('C1 harness check: the amount checker fires on the booking column and not on a proven figure', () => {
  assert.ok(inventedAmountIn(`$${ODD_DOLLARS} · Charged to your card`))
  assert.equal(inventedAmountIn('$49.00 · Charged to your card'), null)
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE RULE — "the ledger has it" was never the question; "Stripe reported
//     it" is.
// ════════════════════════════════════════════════════════════════════════════

test('C1: a Stripe-reported COMPLETED row on THIS booking’s intent is proof', async () => {
  const m = await load()
  const proof = m.proof.provenCapturedDeposit([stripeDeposit()], { stripePaymentIntentId: PI })
  assert.equal(proof.proven, true)
  assert.equal((proof as any).cents, REAL_CAPTURE_CENTS)
})

test('C1 REPRODUCTION: a hand-entered CASH row is real money but not a card deposit', async () => {
  const m = await load()
  for (const rows of [[cashPayment()], [cashPayment(), cashPayment({ id: 'pay_cash2' })]]) {
    const proof = m.proof.provenCapturedDeposit(rows, { stripePaymentIntentId: PI })
    assert.equal(proof.proven, false)
    assert.equal((proof as any).reason, 'not_stripe_reported')
    assert.match(m.proof.unprovenExplanation((proof as any).reason), /manually recorded/i)
  }
})

test('C1 REPRODUCTION: a rehearsal row carrying depositAmount is the booking column, one table over', async () => {
  const m = await load()
  // scripts/stage4-closeout-rehearsal.ts writes COMPLETED rows from the
  // booking's own expected deposit figure, with no Stripe id.
  const rehearsal = cashPayment({ id: 'pay_rehearsal', amount: ODD_DEPOSIT_AMOUNT })
  const proof = m.proof.provenCapturedDeposit([rehearsal], { stripePaymentIntentId: PI })
  assert.equal(proof.proven, false)
  assert.equal(m.proof.provenCapturedCents([rehearsal], { stripePaymentIntentId: PI }), null)
})

test('C1: a Stripe row on a DIFFERENT intent can never stand in for the deposit', async () => {
  const m = await load()
  const moveDayCard = stripeDeposit({ id: 'pay_moveday', amount: CASH_CENTS, stripePaymentIntentId: 'pi_moveday', stripeChargeId: 'ch_moveday' })
  const proof = m.proof.provenCapturedDeposit([moveDayCard], { stripePaymentIntentId: PI })
  assert.equal(proof.proven, false)
  assert.equal((proof as any).reason, 'intent_mismatch')
})

test('C1: an owner checkout test is never money', async () => {
  const m = await load()
  const proof = m.proof.provenCapturedDeposit([stripeDeposit({ isInternalTest: true })], { stripePaymentIntentId: PI })
  assert.equal((proof as any).reason, 'internal_test_only')
})

test('C1: a COMPLETED row with an unusable amount fails to UNKNOWN, never "$0.00"', async () => {
  const m = await load()
  for (const amount of [0, -1, Number.NaN]) {
    const proof = m.proof.provenCapturedDeposit([stripeDeposit({ amount })], { stripePaymentIntentId: PI })
    assert.equal(proof.proven, false, `amount ${amount} was accepted as a figure`)
  }
})

test('C1: `state: none` is not "the card was not charged" — the reasons stay apart', async () => {
  const m = await load()
  const reasons: string[] = ['no_payment_row', 'not_completed', 'internal_test_only', 'not_stripe_reported', 'intent_mismatch', 'no_amount']
  const explanations = reasons.map((r) => m.proof.unprovenExplanation(r as any))
  assert.equal(new Set(explanations).size, reasons.length, 'two reasons collapsed into one owner instruction')
  for (const s of explanations) {
    assert.ok(!/something went wrong/i.test(s), `a generic apology is not a missing fact: ${s}`)
    assert.ok(s.length > 60 && /\.\s|\.$/.test(s), `the owner is not told what to do next: ${s}`)
    assert.equal(inventedAmountIn(s), null)
  }
})

test('C1: the same Stripe evidence rule governs the CANCELLED-booking money state', async () => {
  const m = await load()
  assert.equal(m.proof.provenDepositMoney([cashPayment()], { stripePaymentIntentId: PI }).state, 'none')
  assert.equal(m.proof.provenDepositMoney([stripeDeposit()], { stripePaymentIntentId: PI }).state, 'captured')
  const partial = m.proof.provenDepositMoney(
    [stripeDeposit({ status: 'PARTIALLY_REFUNDED', refundedAmountCents: 1000 })],
    { stripePaymentIntentId: PI },
  )
  assert.equal(partial.state, 'partially_refunded')
  assert.equal((partial as any).refundedCents, 1000)
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE EVIDENCE READER — a failed read is not evidence.
// ════════════════════════════════════════════════════════════════════════════

test('C1: readDepositEvidence reads the ledger AND the audit trail', async () => {
  const m = await load()
  reset(bookingRow(), [stripeDeposit()], [
    { action: 'PAYMENT_RECEIVED', bookingId: BOOKING_ID, details: { authorized: true, amount: REAL_CAPTURE_CENTS, paymentIntentId: PI } },
  ])
  const ev = await m.evidence.readDepositEvidence(BOOKING_ID, { stripePaymentIntentId: PI })
  assert.equal(ev.degraded, false)
  assert.equal(ev.money.state, 'captured')
  assert.equal(ev.authorizedCents, REAL_CAPTURE_CENTS)
  assert.equal(m.evidence.canClaimDepositState(ev), true)
})

test('C1 REPRODUCTION: a ledger read that THROWS answers "unknown", not "not charged"', async () => {
  const m = await load()
  reset(bookingRow(), [stripeDeposit()])
  db.paymentReadError = 'Invalid `prisma.payment.findMany()` invocation: column does not exist (P2022)'
  const ev = await m.evidence.readDepositEvidence(BOOKING_ID, { stripePaymentIntentId: PI })
  assert.equal(ev.degraded, true, 'a failed read must be flagged, or "none" reads as "no charge"')
  assert.equal(m.evidence.canClaimDepositState(ev), false)
})

test('C1: an AUDIT read that throws degrades too — the hold is not "unreleased"', async () => {
  const m = await load()
  reset(bookingRow(), [])
  db.auditReadError = 'Neon connection reset'
  const ev = await m.evidence.readDepositEvidence(BOOKING_ID, { stripePaymentIntentId: PI })
  assert.equal(ev.degraded, true)
  assert.equal(ev.release, 'unknown')
})

test('C1: provenDollars never turns an absent figure into $0.00', async () => {
  const m = await load()
  assert.equal(m.evidence.provenDollars(null), null)
  assert.equal(m.evidence.provenDollars(undefined), null)
  assert.equal(m.evidence.provenDollars(Number.NaN), null)
  assert.equal(m.evidence.provenDollars(REAL_CAPTURE_CENTS), '49.00')
  assert.equal(m.evidence.provenDollars(ODD_DEPOSIT_AMOUNT), ODD_DOLLARS)
})

test('C1: every reader runs the SAME select — a hand-copied column list is what drifts', async () => {
  const m = await load()
  assert.equal(m.evidence.DEPOSIT_PROOF_PAYMENT_SELECT, m.proof.PROOF_PAYMENT_SELECT)
  for (const column of ['stripeChargeId', 'stripePaymentIntentId', 'refundedAmountCents', 'isInternalTest', 'status', 'amount']) {
    assert.equal((m.proof.PROOF_PAYMENT_SELECT as any)[column], true, `${column} missing — the rule would run on half its input`)
  }
  for (const file of [
    join(ROOT, 'app', 'api', 'admin', 'receipts', '[id]', 'resend', 'route.ts'),
    join(ROOT, 'src', 'outbox', 'services', 'premiumEmails.tsx'),
  ]) {
    assert.match(codeOf(file), /PROOF_PAYMENT_SELECT/, `${file} kept its own copy of the column list`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE OWNER'S DISCORD CARDS.
// ════════════════════════════════════════════════════════════════════════════

test('C1 REPRODUCTION: depositPaid + depositAmount alone never print "captured"', async () => {
  const m = await load()
  const data = m.display.approvalCardDataFromBooking({ ...(bookingRow() as any), payments: [] })
  const lines = m.display.depositCardLines(data).join(' | ')
  assert.match(lines, new RegExp(`Deposit quoted: \\$${ODD_DOLLARS}`), 'the column is still shown — labelled QUOTED')
  assert.match(lines, /Deposit captured: NOT RECORDED/)
  assert.match(lines, /Check Stripe before telling the customer/)
  assert.ok(!/captured: \$/.test(lines), `the card claimed a capture: ${lines}`)
  assert.match(m.display.depositStatusLabel(data), /flagged paid — NO recorded capture/)

  const card = m.display.buildBookingApprovalCard(data)
  const pricing = card.embeds[0].fields!.find((f) => f.name.includes('Pricing'))!.value
  assert.match(pricing, /Deposit captured: NOT RECORDED/)
})

test('C1: a PROVEN capture prints, and prints the LEDGER figure', async () => {
  const m = await load()
  const data = m.display.approvalCardDataFromBooking({ ...(bookingRow() as any), payments: [stripeDeposit()] })
  assert.match(m.display.depositCardLines(data).join(' | '), /Deposit captured: \$49\.00 ✅/)
  assert.match(m.display.depositStatusLabel(data), /✅ \$49\.00 captured/)
})

test('C1: an UNREADABLE ledger is UNKNOWN on the card — not "no record"', async () => {
  const m = await load()
  const data = m.display.approvalCardDataFromBooking({ ...(bookingRow() as any) }) // payments absent
  assert.match(m.display.depositCardLines(data).join(' | '), /Deposit captured: UNKNOWN/)
  assert.match(m.display.depositStatusLabel(data), /Deposit UNKNOWN/)
})

test('C1: the card never invents the house fee for a booking with no deposit column', async () => {
  const m = await load()
  const data = m.display.approvalCardDataFromBooking({ ...(bookingRow({ depositAmount: null, depositPaid: false }) as any), payments: [] })
  const flat = JSON.stringify(m.display.buildBookingApprovalCard(data))
  assert.ok(!houseFeeIn(flat), `the card invented $49: ${flat}`)
  assert.match(m.display.depositCardLines(data)[0], /Deposit quoted: —/)
})

test('C1: a cash-only booking shows the CASH nowhere near the word "deposit captured"', async () => {
  const m = await load()
  const data = m.display.approvalCardDataFromBooking({ ...(bookingRow() as any), payments: [cashPayment()] })
  const lines = m.display.depositCardLines(data).join(' | ')
  assert.match(lines, /NOT RECORDED/)
  assert.ok(!lines.includes('650'), `the $650 cash payment was printed as the deposit: ${lines}`)
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE ADMIN MONEY PAGE — the same rule, the owner's own card.
// ════════════════════════════════════════════════════════════════════════════

test('C1: the job money card asks provenDepositMoney, and labels the column "quoted"', async () => {
  const m = await load()
  // The decision input, exactly as the page computes it.
  const proof = m.proof.provenDepositMoney([], { stripePaymentIntentId: PI })
  assert.equal(proof.state, 'none', 'depositPaid:true with an empty ledger is not a capture')

  const page = codeOf(JOB_PAGE)
  assert.match(page, /const depositProof = provenDepositMoney\(booking\.payments, \{ stripePaymentIntentId: booking\.stripePaymentIntentId \}\)/)
  assert.match(page, /depositProof\.state !== 'none' \?/, 'the captured badge is no longer gated on proof')
  assert.match(page, /FLAGGED PAID BUT NOT RECORDED/, 'the unproven case must read as an incident, not as a capture')
  // The only `depositAmount` renders left on the page are labelled quoted.
  for (const match of page.match(/cents\(booking\.depositAmount\)[^\n]*/g) ?? []) {
    assert.ok(!/captured/.test(match), `an unproven figure is still labelled captured: ${match}`)
  }
  assert.ok(!/\?\?\s*'\$49\.00'/.test(page), 'the invented house fee is back on the money card')
})

// ════════════════════════════════════════════════════════════════════════════
//  5. THE ADMIN CANCELLATION EMAIL — lifted from the shipped route and CALLED.
// ════════════════════════════════════════════════════════════════════════════

async function sendCancellation(booking: Row): Promise<QueuedEmail> {
  const m = await load()
  const sendCancellationEmail = lift<(b: any, id: string) => Promise<void>>(STATUS_ROUTE, 'sendCancellationEmail', {
    readDepositEvidence: m.evidence.readDepositEvidence,
    provenDollars: m.evidence.provenDollars,
    emailQueue: { add: async (name: string, data: any) => { queuedEmails.push({ name, data }); return { id: 'job' } } },
    withDeadline: <T,>(p: Promise<T>) => p,
    apiLogger: { error() {}, warn() {}, info() {} },
  })
  queuedEmails.length = 0
  await sendCancellationEmail(booking, BOOKING_ID)
  assert.equal(queuedEmails.length, 1, 'exactly one cancellation message')
  return queuedEmails[0]
}

test('C1 REPRODUCTION: cancelling a booking FLAGGED paid with an empty ledger sends the DECLINED copy', async () => {
  reset(bookingRow(), [], [])
  const queued = await sendCancellation(db.booking as Row)
  // `depositPaid` used to choose the template: the CAPTURED copy went out about
  // money the system cannot show.
  assert.equal(queued.name, 'booking-declined')
  assert.equal(inventedAmountIn(JSON.stringify(queued.data.payload)), null)
  assert.equal(queued.data.payload.holdReleased, false, 'this path never calls Stripe, so it may not claim a release')
})

test('C1: a PROVEN capture sends the cancellation copy with the LEDGER figure', async () => {
  reset(bookingRow(), [stripeDeposit()], [])
  const queued = await sendCancellation(db.booking as Row)
  assert.equal(queued.name, 'booking-cancellation')
  assert.equal(queued.data.payload.amount, '49.00')
  assert.match(String(queued.data.payload.statusText), /follow up with you about your \$49\.00 deposit/)
  assert.equal(inventedAmountIn(JSON.stringify(queued.data.payload)), null)

  // ...and the SHIPPED template renders exactly that, claiming no refund.
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: BookingCancellation } = await import('../../emails/booking-cancellation')
  const text = strip(await render(React.createElement(BookingCancellation, queued.data.payload as never)))
  assert.match(text, /follow up with you about your \$49\.00 deposit/)
  assert.equal(inventedAmountIn(text), null)
  assert.ok(!/refunded/i.test(text), 'no refund is issued here, so none may be claimed')
})

test('C1: a RECORDED refund is described as a refund, from the ledger figure', async () => {
  reset(bookingRow(), [stripeDeposit({ status: 'REFUNDED', refundedAmountCents: REAL_CAPTURE_CENTS })], [])
  const queued = await sendCancellation(db.booking as Row)
  assert.equal(queued.name, 'booking-cancellation')
  assert.match(String(queued.data.payload.statusText), /A refund of your \$49\.00 deposit is recorded/)
})

test('C1 REPRODUCTION: an UNREADABLE ledger states no amount and claims no release', async () => {
  reset(bookingRow(), [stripeDeposit()], [])
  db.paymentReadError = 'P2022'
  db.auditReadError = 'P2022'
  const queued = await sendCancellation(db.booking as Row)
  const payload = JSON.stringify(queued.data.payload)
  assert.equal(inventedAmountIn(payload), null)
  assert.ok(!houseFeeIn(payload), `an unreadable ledger produced a figure: ${payload}`)
  assert.equal(queued.data.payload.holdReleased, false)

  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: BookingDeclined } = await import('../../emails/booking-declined')
  const text = strip(await render(React.createElement(BookingDeclined, queued.data.payload as never)))
  assert.ok(!/\$\d/.test(text), `the email printed an unproven amount: ${text}`)
  assert.ok(!/were not charged|released in full/i.test(text), 'and it claimed a release nobody proved')
})

test('C1: the hold figure on the declined copy is Stripe’s, from the AUTHORIZATION audit row', async () => {
  reset(bookingRow(), [], [
    { action: 'PAYMENT_RECEIVED', bookingId: BOOKING_ID, details: { authorized: true, amount: REAL_CAPTURE_CENTS, paymentIntentId: PI } },
    { action: 'BOOKING_STATE_CHANGED', bookingId: BOOKING_ID, details: { stripeResult: 'hold_released' } },
  ])
  const queued = await sendCancellation(db.booking as Row)
  assert.equal(queued.name, 'booking-declined')
  assert.equal(queued.data.payload.amountHold, '49.00', 'Stripe’s figure, never depositAmount')
  assert.equal(queued.data.payload.holdReleased, true, 'a decline DID record a release — say so')
})

// ════════════════════════════════════════════════════════════════════════════
//  6. THE RECEIPT ROUTE — the strongest claim this system makes about money.
// ════════════════════════════════════════════════════════════════════════════

async function resendReceipt(): Promise<{ status: number; body: any }> {
  const m = await load()
  const res = await m.receiptRoute.POST({} as any, { params: { id: BOOKING_ID } })
  return { status: res.status, body: await res.json() }
}

test('C1 REPRODUCTION: no proven payment ⇒ NO receipt, a 409, and no audit row', async () => {
  reset(bookingRow(), [])
  const { status, body } = await resendReceipt()
  assert.equal(status, 409)
  assert.equal(body.reason, 'no_payment_row')
  assert.equal(queuedEmails.length, 0, 'a receipt was sent for an amount nobody captured')
  assert.equal(db.audits.length, 0, 'and a RECEIPT_SENT row would be a second false record')
  assert.equal(inventedAmountIn(JSON.stringify(body)), null)
})

test('C1 REPRODUCTION: an UNREADABLE ledger is a retryable 503, not a bare 500 and not a receipt', async () => {
  reset(bookingRow(), [stripeDeposit()])
  db.paymentReadError = 'Invalid `prisma.payment.findMany()` invocation: column does not exist (P2022)'
  const { status, body } = await resendReceipt()
  assert.equal(status, 503, 'a read failure must be distinguishable from a refusal')
  assert.equal(body.reason, 'ledger_unreadable')
  assert.match(String(body.message), /could not be read/)
  assert.equal(queuedEmails.length, 0)
  assert.equal(db.audits.length, 0)
})

test('C1: a CASH-only booking is refused with the reason that names the missing fact', async () => {
  reset(bookingRow(), [cashPayment()])
  const { status, body } = await resendReceipt()
  assert.equal(status, 409)
  assert.equal(body.reason, 'not_stripe_reported')
  assert.ok(!JSON.stringify(body).includes('650'), 'the cash figure must not appear as a deposit')
})

test('C1: a PROVEN capture sends a receipt for the LEDGER amount and records which payment', async () => {
  reset(bookingRow(), [stripeDeposit()])
  const { status, body } = await resendReceipt()
  assert.equal(status, 200)
  assert.equal(body.amountCents, REAL_CAPTURE_CENTS)
  assert.equal(queuedEmails.length, 1)
  const payload = queuedEmails[0].data.payload
  assert.equal(payload.amountPaid, '49.00')
  assert.equal(payload.captured, true)
  assert.equal(payload.date, stripeDeposit().createdAt.toISOString(), 'the receipt date is the payment’s, not booking.updatedAt')
  assert.equal(inventedAmountIn(JSON.stringify(payload)), null)
  assert.equal(db.audits.length, 1)
  assert.equal(db.audits[0].action, 'RECEIPT_SENT')
  assert.equal(db.audits[0].details.amountCents, REAL_CAPTURE_CENTS)

  // The SHIPPED receipt template, driven with the payload the route built.
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: PaymentReceipt } = await import('../../emails/payment-receipt')
  const text = strip(await render(React.createElement(PaymentReceipt, payload as never)))
  assert.equal(inventedAmountIn(text), null, 'the receipt printed the booking column')
  assert.match(text, /\$49\.00/)
})

test('C1: a receipt for an odd PROVEN figure prints that figure — proof, not silence', async () => {
  reset(bookingRow(), [stripeDeposit({ amount: ODD_DEPOSIT_AMOUNT })])
  const { status, body } = await resendReceipt()
  assert.equal(status, 200)
  assert.equal(body.amountCents, ODD_DEPOSIT_AMOUNT)
  assert.equal(queuedEmails[0].data.payload.amountPaid, ODD_DOLLARS)
})

// ════════════════════════════════════════════════════════════════════════════
//  7. THE PRE-APPROVAL HOLD FIGURE — the sender, the event, and the template.
// ════════════════════════════════════════════════════════════════════════════

/** The SHIPPED derivation out of fulfillPaidCheckout, transpiled and evaluated.
 *  This is the line that used to read `(amountTotalCents ?? 4900)`. */
function shippedHoldDerivation(): (amountTotalCents: number | null) => string | null {
  const code = codeOf(FULFILLMENT)
  const start = code.indexOf('const provenHoldCents =')
  assert.ok(start > -1, 'the hold derivation has been renamed — this guard has drifted from the source')
  const amountLine = code.indexOf('const amountPaid =', start)
  assert.ok(amountLine > start, 'the derivation no longer produces `amountPaid`')
  const snippet = code.slice(start, code.indexOf('\n', amountLine))
  assert.ok(!/4900/.test(snippet), `the house-fee fallback is back in the hold derivation: ${snippet}`)
  const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  return new Function('amountTotalCents', `${js}\nreturn amountPaid;`) as any
}

test('C1 REPRODUCTION: Stripe reporting no amount_total yields NO figure, not $49', () => {
  const derive = shippedHoldDerivation()
  assert.equal(derive(null), null, 'a null session total became the house $49 in a customer’s inbox')
  assert.equal(derive(4900), '49.00')
  assert.equal(derive(ODD_DEPOSIT_AMOUNT), ODD_DOLLARS, 'and a real, odd authorization is still printed')
})

test('C1: the LEGACY pre-approval sender omits the hold line rather than inventing one', () => {
  // Source guard on the twin path (its enqueue needs Redis and is not run here):
  // the payload spread must be conditional, and no `?? 4900` may remain.
  const code = codeOf(FULFILLMENT)
  assert.match(code, /\.\.\.\(amountPaid != null \? \{ amountHold: String\(Math\.round\(Number\(amountPaid\)\)\) \} : \{\}\)/)
  assert.ok(!/amountTotalCents \?\? 4900\) \/ 100/.test(code), 'the customer-facing default is back')
})

test('C1 REPRODUCTION: the OUTBOX event carries no amount, end to end, and the email states none', async () => {
  const m = await load()
  reset(bookingRow({ status: 'PENDING_APPROVAL', depositPaid: false }), [])
  const amountPaid = shippedHoldDerivation()(null)

  // The SHIPPED controller writes the event row...
  const result = await m.stripeController.handlePaymentCompleted({
    bookingId: BOOKING_ID,
    ...(amountPaid != null ? { amountPaid } : {}),
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: '2027-09-14T12:00:00.000Z',
  })
  assert.equal(result.emailJobCreated, true)
  const stored = JSON.parse(db.emailJobs[0].payload)
  assert.equal(stored.amountPaid, undefined, 'a stored event that carries a figure resurrects it on every resend')

  // ...and the SHIPPED sender renders + delivers it.
  await m.emailService.sendPreApprovalEmail(stored)
  assert.equal(sentEmails.length, 1)
  const text = strip(sentEmails[0].html)
  assert.ok(!houseFeeIn(text), `the pre-approval email printed the house fee: ${text}`)
  assert.equal(inventedAmountIn(text), null)
  // The email still states the QUOTE ($599, a stored estimate it can prove);
  // what it may not do is attach a figure to the HOLD. Both sentences that used
  // to carry one are checked by shape, so a new number cannot slip into either.
  assert.ok(!/\$[\d.,]+\s*hold/i.test(text), `a figure was attached to the hold: ${text}`)
  assert.ok(!/(The|de)\s+\$[\d.,]+\s+(authorization|autorización)/i.test(text), `a figure was attached to the authorization: ${text}`)
  assert.match(text, /Booking fee hold/, 'the fee is named without a number')
  assert.match(text, /The booking fee authorization is a hold, not a charge/)
  assert.ok(!/the amount shown above/.test(text), 'the receipt-shaped filler points at the move ESTIMATE here')
})

test('C1: a REPORTED amount still travels and still prints', async () => {
  const m = await load()
  reset(bookingRow({ status: 'PENDING_APPROVAL', depositPaid: false }), [])
  const amountPaid = shippedHoldDerivation()(REAL_CAPTURE_CENTS)
  await m.stripeController.handlePaymentCompleted({
    bookingId: BOOKING_ID,
    ...(amountPaid != null ? { amountPaid } : {}),
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: '2027-09-14T12:00:00.000Z',
  })
  const stored = JSON.parse(db.emailJobs[0].payload)
  assert.equal(stored.amountPaid, '49.00')
  await m.emailService.sendPreApprovalEmail(stored)
  const text = strip(sentEmails[0].html)
  assert.match(text, /\$49\.00 hold/)
  assert.equal(inventedAmountIn(text), null, 'and never the booking column, which is 12345 on this row')
})

test('C1 REPRODUCTION: the pre-approval email never reaches for depositAmount', async () => {
  const m = await load()
  reset(bookingRow({ status: 'PENDING_APPROVAL', depositPaid: false }), [])
  // No amount on the event at all — the pre-fix renderer's fallback target.
  await m.stripeController.handlePaymentCompleted({
    bookingId: BOOKING_ID,
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: '2027-09-14T12:00:00.000Z',
  })
  await m.emailService.sendPreApprovalEmail(JSON.parse(db.emailJobs[0].payload))
  const text = strip(sentEmails[0].html)
  assert.equal(inventedAmountIn(text), null, `the booking column reached the customer: ${text}`)
})

// ════════════════════════════════════════════════════════════════════════════
//  8. THE OUTBOX CONFIRMATION — the proven amount TRAVELS on the event.
// ════════════════════════════════════════════════════════════════════════════

test('C1 REPRODUCTION: the approval hands the outbox the amount STRIPE reported', async () => {
  // The chain existed and had nothing feeding it: the shipped emit omitted the
  // field entirely, so `capturedAmountCents` was always null on the live path.
  const approval = codeOf(join(ROOT, 'src', 'lib', 'booking-approval.ts'))
  assert.match(approval, /capturedAmountCents: capturedCents,/, 'the proven amount no longer travels on the event')
  assert.match(approval, /const capturedCents = capturedAmountFromIntent\(intent\)/)
})

test('C1: the confirmation prints the EVENT amount, and falls back only to the ledger', async () => {
  const m = await load()
  reset(bookingRow(), [stripeDeposit({ amount: 100, id: 'pay_test_capture' })])

  // Event says $1 (a controlled test capture); the booking column says $123.45.
  const withEvent = await m.discordController.handleApprove({
    bookingId: BOOKING_ID,
    approvedBy: 'Diego',
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: null,
    capturedAmountCents: 100,
  })
  assert.equal(withEvent.emailJobCreated, true)
  const payload = JSON.parse(db.emailJobs[0].payload)
  assert.equal(payload.capturedAmountCents, 100)
  await m.emailService.sendFinalConfirmationEmail(payload)
  const text = strip(sentEmails[0].html)
  assert.match(text, /\$1\.00/)
  assert.equal(inventedAmountIn(text), null, 'the booking column must never win over Stripe’s figure')
})

test('C1: a null on the event falls back to the LEDGER, never to the booking column', async () => {
  const m = await load()
  reset(bookingRow(), [stripeDeposit()])
  await m.discordController.handleApprove({
    bookingId: BOOKING_ID,
    approvedBy: 'Diego',
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: null,
    capturedAmountCents: null,
  })
  await m.emailService.sendFinalConfirmationEmail(JSON.parse(db.emailJobs[0].payload))
  const text = strip(sentEmails[0].html)
  assert.match(text, /\$49\.00/)
  assert.equal(inventedAmountIn(text), null)
})

test('C1 REPRODUCTION: null on the event AND a cash-only ledger ⇒ the confirmation names no amount', async () => {
  const m = await load()
  reset(bookingRow(), [cashPayment()])
  await m.discordController.handleApprove({
    bookingId: BOOKING_ID,
    approvedBy: 'Diego',
    customerName: 'Maria Lopez',
    customerEmail: 'maria@example.com',
    requestedDate: null,
    capturedAmountCents: null,
  })
  await m.emailService.sendFinalConfirmationEmail(JSON.parse(db.emailJobs[0].payload))
  const text = strip(sentEmails[0].html)
  assert.equal(inventedAmountIn(text), null)
  assert.ok(!text.includes('650'), `a move-day cash payment became the deposit: ${text}`)
  assert.ok(!houseFeeIn(text), 'and the house fee was not invented either')
})
