import { test } from 'node:test'
import assert from 'node:assert/strict'

// ════════════════════════════════════════════════════════════════════════════
//  Deposit links — FAILURE INJECTION and CONCURRENCY, against a fake database.
//  ------------------------------------------------------------------------
//  The other deposit suites prove the pure money rules and pin the wiring by
//  reading source. This one actually RUNS the money path and breaks things
//  underneath it: duplicate webhooks, two taps at once, Discord down, Postgres
//  down, a worker killed mid-send.
//
//  HOW IT WORKS. src/lib/db.ts resolves `globalThis.prisma ?? new PrismaClient()`,
//  so installing a fake on globalThis BEFORE the first import of anything that
//  imports db.ts gives the real service code a database it cannot tell from the
//  real one. No Postgres, no network, no Stripe — this file is offline.
//
//  THE FAKE IS NOT A STUB. `updateMany` genuinely evaluates its WHERE clause
//  against stored rows, because every exactly-once guarantee in this feature is
//  a CONDITIONAL UPDATE. A fake that ignored the WHERE would make every test
//  here pass while the production guard did nothing.
// ════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>

/** Does a row satisfy a Prisma-style where clause? Supports the operators the
 *  deposit service actually uses: equality, { not }, { in }, { lt }, and OR. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = cond as Record<string, unknown>[]
      if (!branches.some((b) => matches(row, b))) return false
      continue
    }
    const value = row[key]
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('not' in c && value === c.not) return false
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false
      if ('lt' in c) {
        if (value == null) return false
        if (!((value as Date).getTime() < (c.lt as Date).getTime())) return false
      }
      continue
    }
    if (cond === null) {
      if (value != null) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

/** Apply Prisma-style data, including { increment: n }. */
function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as Record<string, unknown>)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment as number)
      continue
    }
    if (v === undefined) continue // Prisma treats undefined as "leave alone"
    row[k] = v
  }
}

type FakeDb = {
  deposits: Row[]
  payments: Row[]
  audits: Row[]
  /** Set to make the next write throw, simulating Postgres going away. */
  failNextWrite: string | null
  paymentCreateCalls: number
}

// ONE fake client, installed once. The ES module cache means src/lib/db.ts
// resolves `globalThis.prisma` exactly once, on first import, and every service
// module then holds THAT reference forever. Installing a second fake later would
// silently do nothing — the tests would all share the first one and quietly stop
// testing what they claim to. So the client identity is stable and only its DATA
// is reset between tests.
const db: FakeDb = { deposits: [], payments: [], audits: [], failNextWrite: null, paymentCreateCalls: 0 }

function boom(): void {
  if (db.failNextWrite) {
    const msg = db.failNextWrite
    db.failNextWrite = null
    throw new Error(msg)
  }
}

const fakeClient = {
  depositRequest: {
    // Returns a SNAPSHOT, not the stored row. Real Prisma hands back a plain
    // object decoded from the wire, so a caller cannot observe a later write
    // through it. Returning the live object made every concurrency test pass
    // for the wrong reason: ten racing callers each re-read the winner's
    // mutation and all believed they had won.
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const hit = db.deposits.find((d) => matches(d, where))
      return hit ? { ...hit } : null
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      boom()
      const hits = db.deposits.filter((d) => matches(d, where))
      for (const h of hits) applyData(h, data)
      return { count: hits.length }
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      boom()
      const hit = db.deposits.find((d) => matches(d, where))
      if (!hit) throw new Error('record not found')
      applyData(hit, data)
      return hit
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      boom()
      const row = { id: `dep_${db.deposits.length + 1}`, ...data }
      db.deposits.push(row)
      return row
    },
  },
  payment: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      boom()
      db.paymentCreateCalls++
      const row = { id: `pay_${db.payments.length + 1}`, ...data }
      db.payments.push(row)
      return row
    },
  },
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      boom()
      db.audits.push(data)
      return data
    },
  },
  booking: { findUnique: async () => null },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeClient),
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakeClient

/** Reset the fake database to a known state. Returns the shared handle. */
function seedDb(rows: Row[]): FakeDb {
  db.deposits = rows
  db.payments = []
  db.audits = []
  db.failNextWrite = null
  db.paymentCreateCalls = 0
  return db
}

const depositRow = (over: Row = {}): Row => ({
  id: 'dep_1',
  publicToken: 'ABCDEFGH1234',
  bookingId: 'bk_1',
  status: 'ACTIVE',
  amountCents: 4900,
  quoteTotalCents: 49500,
  balanceBeforeCents: 49500,
  customerName: 'Natalia Reyes',
  paidAt: null,
  amountPaidCents: null,
  expiresAt: null,
  stripeCheckoutSessionId: null,
  stripeCheckoutUrl: null,
  checkoutSessionExpiresAt: null,
  checkoutAttempts: 0,
  discordStatus: 'NOT_APPLICABLE',
  discordClaimedAt: null,
  discordRetryCount: 0,
  ...over,
})

const paid = (db: FakeDb) => db.deposits[0]

// ── DUPLICATE WEBHOOK ───────────────────────────────────────────────────────

test('a duplicate Stripe webhook credits the booking exactly ONCE', async () => {
  const db = seedDb([depositRow()])
  const { markDepositPaid } = await import('../deposit-service')

  const event = {
    depositRequestId: 'dep_1',
    checkoutSessionId: 'cs_1',
    paymentIntentId: 'pi_1',
    stripeEventId: 'evt_1',
    amountPaidCents: 4900,
    livemode: true,
  }

  const first = await markDepositPaid(event)
  const second = await markDepositPaid(event) // Stripe redelivers the SAME event
  const third = await markDepositPaid({ ...event, stripeEventId: 'evt_2' }) // and a different one

  assert.equal(first.applied, true)
  assert.equal(second.applied, false)
  assert.equal(second.reason, 'already-paid')
  assert.equal(third.applied, false, 'a second event for the same deposit must not re-credit')

  assert.equal(db.payments.length, 1, 'EXACTLY ONE Payment row')
  assert.equal(db.paymentCreateCalls, 1)
  assert.equal(db.payments[0].amount, 4900)
  assert.equal(db.payments[0].status, 'COMPLETED')
  assert.equal(db.audits.filter((a) => a.action === 'DEPOSIT_LINK_PAID').length, 1, 'one audit entry')
})

test('CONCURRENT duplicate webhooks still credit exactly once', async () => {
  const db = seedDb([depositRow()])
  const { markDepositPaid } = await import('../deposit-service')

  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      markDepositPaid({
        depositRequestId: 'dep_1',
        checkoutSessionId: 'cs_1',
        paymentIntentId: 'pi_1',
        stripeEventId: `evt_${n}`,
        amountPaidCents: 4900,
        livemode: true,
      })
    )
  )

  assert.equal(results.filter((r) => r.applied).length, 1, 'exactly one caller wins the claim')
  assert.equal(db.payments.length, 1, 'exactly one Payment row despite five racing callers')
})

test('the recorded amount is what STRIPE captured, not what was requested', async () => {
  const db = seedDb([depositRow({ amountCents: 4900 })])
  const { markDepositPaid } = await import('../deposit-service')
  // Stripe is the authority. If the two ever disagree, the capture wins.
  await markDepositPaid({
    depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
    stripeEventId: 'evt_1', amountPaidCents: 4900, livemode: true,
  })
  assert.equal(db.payments[0].amount, 4900)
  assert.equal(paid(db).amountPaidCents, 4900)
})

test('a STANDALONE deposit records no Payment row (there is no booking to credit)', async () => {
  const db = seedDb([depositRow({ bookingId: null })])
  const { markDepositPaid } = await import('../deposit-service')
  const r = await markDepositPaid({
    depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
    stripeEventId: 'evt_1', amountPaidCents: 25000, livemode: true,
  })
  assert.equal(r.applied, true)
  assert.equal(db.payments.length, 0, 'no booking, no ledger row')
  assert.equal(paid(db).status, 'PAID')
  assert.equal(paid(db).amountPaidCents, 25000)
})

// ── MONEY THAT ARRIVED ON A DEAD LINK ───────────────────────────────────────

test('money captured against an EXPIRED or CANCELED link is still recorded', async () => {
  for (const status of ['EXPIRED', 'CANCELED']) {
    const db = seedDb([depositRow({ status, expiresAt: new Date('2020-01-01') })])
    const { markDepositPaid } = await import('../deposit-service')
    const r = await markDepositPaid({
      depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
      stripeEventId: 'evt_1', amountPaidCents: 4900, livemode: true,
    })
    // Refusing to record a real capture would LOSE money already in the account.
    assert.equal(r.applied, true, `${status}: a real capture must be recorded`)
    assert.equal(db.payments.length, 1)
    const audit = db.audits.find((a) => a.action === 'DEPOSIT_LINK_PAID')
    assert.equal((audit?.details as Row).statusBefore, status, 'the anomaly is audited, not normalised away')
  }
})

// ── DATABASE FAILURE ────────────────────────────────────────────────────────

test('a database failure during the claim does NOT half-credit the booking', async () => {
  const db = seedDb([depositRow()])
  const { markDepositPaid } = await import('../deposit-service')
  db.failNextWrite = 'could not connect to server: Connection refused'

  await assert.rejects(
    () => markDepositPaid({
      depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
      stripeEventId: 'evt_1', amountPaidCents: 4900, livemode: true,
    }),
    /Connection refused/,
    'the error must propagate so the webhook retries — never swallowed'
  )

  assert.equal(db.payments.length, 0, 'no Payment row was written')
  assert.equal(paid(db).paidAt, null, 'the deposit is still unpaid')
  assert.equal(paid(db).status, 'ACTIVE')
})

test('after a database failure, the RETRY completes normally', async () => {
  const db = seedDb([depositRow()])
  const { markDepositPaid } = await import('../deposit-service')
  const event = {
    depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
    stripeEventId: 'evt_1', amountPaidCents: 4900, livemode: true,
  }

  db.failNextWrite = 'server closed the connection unexpectedly'
  await assert.rejects(() => markDepositPaid(event))

  const retry = await markDepositPaid(event) // Stripe/BullMQ retries
  assert.equal(retry.applied, true, 'the retry succeeds')
  assert.equal(db.payments.length, 1, 'and still credits exactly once')
})

// ── RAPID DOUBLE-CLICK ──────────────────────────────────────────────────────

test('two simultaneous taps produce ONE payable checkout session', async () => {
  seedDb([depositRow()])
  const { claimCheckoutSession } = await import('../deposit-service')

  const [a, b] = await Promise.all([claimCheckoutSession('dep_1'), claimCheckoutSession('dep_1')])
  const kinds = [a.kind, b.kind].sort()
  assert.deepEqual(kinds, ['busy', 'create'], 'exactly one caller may mint; the other is told to back off')
})

test('ten simultaneous taps still produce ONE minting claim', async () => {
  seedDb([depositRow()])
  const { claimCheckoutSession } = await import('../deposit-service')
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimCheckoutSession('dep_1')))
  assert.equal(claims.filter((c) => c.kind === 'create').length, 1)
})

test('a still-valid session is REUSED, with no new Stripe call', async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000)
  seedDb([depositRow({ stripeCheckoutUrl: 'https://checkout.stripe.com/c/pay/cs_live_1', checkoutSessionExpiresAt: future })])
  const { claimCheckoutSession } = await import('../deposit-service')
  const c = await claimCheckoutSession('dep_1')
  assert.equal(c.kind, 'reuse')
  if (c.kind === 'reuse') assert.match(c.url, /checkout\.stripe\.com/)
})

test('a session about to expire is NOT reused — that would be a failed payment', async () => {
  const almost = new Date(Date.now() + 30 * 1000) // inside the 60s safety margin
  seedDb([depositRow({ stripeCheckoutUrl: 'https://checkout.stripe.com/c/pay/cs_1', checkoutSessionExpiresAt: almost })])
  const { claimCheckoutSession } = await import('../deposit-service')
  const c = await claimCheckoutSession('dep_1')
  assert.equal(c.kind, 'create', 'a fresh session is minted instead')
})

test('a PAID link can never mint another session', async () => {
  seedDb([depositRow({ status: 'PAID', paidAt: new Date() })])
  const { claimCheckoutSession, payableOrReason } = await import('../deposit-service')
  assert.equal((await claimCheckoutSession('dep_1')).kind, 'busy', 'the claim guard refuses a paid row')
  const reason = payableOrReason({ status: 'PAID', expiresAt: null, paidAt: new Date() })
  assert.match(reason?.message ?? '', /already been paid/i)
  // The CODE is what the customer-facing page translates; the English sentence
  // is only the fallback for a client that does not know the code.
  assert.equal(reason?.code, 'already_paid')
})

test('expired and canceled links are refused before any Stripe call', async () => {
  const { payableOrReason } = await import('../deposit-service')
  const expired = payableOrReason({ status: 'ACTIVE', expiresAt: new Date('2020-01-01'), paidAt: null })
  assert.match(expired?.message ?? '', /expired/i)
  assert.equal(expired?.code, 'expired')
  const canceled = payableOrReason({ status: 'CANCELED', expiresAt: null, paidAt: null })
  assert.match(canceled?.message ?? '', /no longer active/i)
  assert.equal(canceled?.code, 'inactive')
  assert.equal(payableOrReason({ status: 'ACTIVE', expiresAt: null, paidAt: null }), null, 'an active link is payable')
})

// ── DISCORD ─────────────────────────────────────────────────────────────────

test('the notification is owed the moment the money is recorded', async () => {
  const db = seedDb([depositRow()])
  const { markDepositPaid } = await import('../deposit-service')
  await markDepositPaid({
    depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
    stripeEventId: 'evt_1', amountPaidCents: 4900, livemode: true,
  })
  // Written in the SAME transaction as the payment — a crash between the two is
  // impossible, which is what makes this a durable outbox rather than a hope.
  assert.equal(paid(db).discordStatus, 'PENDING')
})

test('exactly ONE caller may deliver the notification', async () => {
  seedDb([depositRow({ paidAt: new Date(), status: 'PAID', discordStatus: 'PENDING' })])
  const { claimDiscordNotification } = await import('../deposit-service')
  const claims = await Promise.all(Array.from({ length: 5 }, () => claimDiscordNotification('dep_1')))
  assert.equal(claims.filter(Boolean).length, 1, 'five racing workers, one message')
})

test('a Discord failure records FAILED and leaves the PAYMENT untouched', async () => {
  const db = seedDb([depositRow({ paidAt: new Date(), status: 'PAID', discordStatus: 'PENDING', amountPaidCents: 4900 })])
  db.payments.push({ id: 'pay_1', amount: 4900, status: 'COMPLETED' })
  const { recordDiscordFailure } = await import('../deposit-service')

  await recordDiscordFailure('dep_1', 'discord 503')

  assert.equal(paid(db).discordStatus, 'FAILED')
  assert.equal(paid(db).discordRetryCount, 1)
  // The money is completely unaffected — this is the whole point.
  assert.equal(paid(db).status, 'PAID')
  assert.equal(paid(db).amountPaidCents, 4900)
  assert.equal(db.payments.length, 1)
})

test('a FAILED notification can be retried; a SENT one cannot be re-sent', async () => {
  seedDb([depositRow({ paidAt: new Date(), status: 'PAID', discordStatus: 'FAILED' })])
  const { claimDiscordNotification } = await import('../deposit-service')
  assert.equal(await claimDiscordNotification('dep_1'), true, 'FAILED is retryable')

  seedDb([depositRow({ paidAt: new Date(), status: 'PAID', discordStatus: 'SENT' })])
  const { claimDiscordNotification: claim2 } = await import('../deposit-service')
  assert.equal(await claim2('dep_1'), false, 'SENT is never re-sent')
})

test('an UNPAID deposit can never produce a notification', async () => {
  seedDb([depositRow({ paidAt: null, discordStatus: 'PENDING' })])
  const { claimDiscordNotification } = await import('../deposit-service')
  assert.equal(await claimDiscordNotification('dep_1'), false)
})

// ── PROCESS RESTART ─────────────────────────────────────────────────────────

test('a worker killed mid-send does not wedge the notification forever', async () => {
  const { DISCORD_CLAIM_STALE_MS } = await import('../deposit-service')

  // A crashed worker leaves the row SENDING with an old claim stamp.
  const stale = new Date(Date.now() - DISCORD_CLAIM_STALE_MS - 1000)
  seedDb([depositRow({ paidAt: new Date(), status: 'PAID', discordStatus: 'SENDING', discordClaimedAt: stale })])
  const { claimDiscordNotification } = await import('../deposit-service')
  assert.equal(await claimDiscordNotification('dep_1'), true, 'after the stale window it is reclaimable')

  // But a send genuinely in flight is left alone.
  const fresh = new Date()
  seedDb([depositRow({ paidAt: new Date(), status: 'PAID', discordStatus: 'SENDING', discordClaimedAt: fresh })])
  const { claimDiscordNotification: claim2 } = await import('../deposit-service')
  assert.equal(await claim2('dep_1'), false, 'an in-flight send is not duplicated')
})

// ── DELAYED PAYMENT METHODS ─────────────────────────────────────────────────

test('a delayed payment is not credited until Stripe confirms it', async () => {
  const db = seedDb([depositRow()])
  const { isConfirmedDepositSession } = await import('../deposit-links')
  const { markDepositPaid } = await import('../deposit-service')

  // checkout.session.completed for ACH: session complete, money NOT there.
  const pending = isConfirmedDepositSession({ payment_status: 'unpaid', amount_total: 4900 })
  assert.equal(pending.confirmed, false)
  assert.equal(db.payments.length, 0, 'nothing was credited')
  assert.equal(paid(db).status, 'ACTIVE', 'the link stays payable')

  // Later: async_payment_succeeded.
  const settled = isConfirmedDepositSession({ payment_status: 'paid', amount_total: 4900 })
  assert.equal(settled.confirmed, true)
  if (settled.confirmed) {
    await markDepositPaid({
      depositRequestId: 'dep_1', checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1',
      stripeEventId: 'evt_async', amountPaidCents: settled.amountCents, livemode: true,
    })
  }
  assert.equal(db.payments.length, 1, 'credited only once it settled')
  assert.equal(paid(db).status, 'PAID')
})

// ── CANCEL ──────────────────────────────────────────────────────────────────

test('cancelling a PAID deposit is refused — that would be a refund', async () => {
  const db = seedDb([depositRow({ status: 'PAID', paidAt: new Date() })])
  const { cancelDepositRequest } = await import('../deposit-service')
  const r = await cancelDepositRequest('dep_1', { userId: 'u1', name: 'Diego' })
  assert.equal(r.ok, false)
  assert.equal(r.status, 409)
  assert.match(r.error ?? '', /already paid/i)
  assert.equal(paid(db).status, 'PAID', 'the row is untouched')
})

test('cancelling an active deposit works, and is audited', async () => {
  const db = seedDb([depositRow()])
  const { cancelDepositRequest } = await import('../deposit-service')
  const r = await cancelDepositRequest('dep_1', { userId: 'u1', name: 'Diego' })
  assert.equal(r.ok, true)
  assert.equal(paid(db).status, 'CANCELED')
  assert.equal(db.audits.filter((a) => a.action === 'DEPOSIT_LINK_CANCELED').length, 1)
})

test('cancelling twice is refused the second time', async () => {
  seedDb([depositRow()])
  const { cancelDepositRequest } = await import('../deposit-service')
  assert.equal((await cancelDepositRequest('dep_1', {})).ok, true)
  assert.equal((await cancelDepositRequest('dep_1', {})).ok, false)
})

test('creating a link against a PRE-MIGRATION schema still mints a link', async () => {
  // This repo does not run migrations at build time, so new code can briefly run
  // against a database that lacks move_time_minutes / move_details / etc. The
  // first create throws Postgres 42703 ("column does not exist"); the service
  // must drop those columns and retry so the owner still gets a working link,
  // not a 500 on his most-used button.
  const db = seedDb([])
  db.failNextWrite = 'column "move_time_minutes" of relation "deposit_requests" does not exist'
  const { createDepositRequest } = await import('../deposit-service')
  const r = await createDepositRequest({
    amountCents: 4900,
    customerName: 'Rosey Alvarez',
    moveDetails: ['Apartment next door'],
    customerNote: 'Bring the hardware',
    internalNote: 'gate code 4417',
    moveTimeMinutes: 420,
  })
  assert.equal(r.ok, true, 'the link is created despite the missing columns')
  assert.equal(db.deposits.length, 1, 'exactly one row, on the retry')
  const row = db.deposits[0]
  // The new columns were dropped from the retried write...
  assert.ok(!('moveTimeMinutes' in row), 'move time was not written to the old schema')
  assert.ok(!('moveDetails' in row), 'move details were not written to the old schema')
  assert.ok(!('internalNote' in row), 'the note was not written to the old schema')
  // ...but the money-critical fields are intact.
  assert.equal(row.amountCents, 4900)
  assert.equal(row.status, 'ACTIVE')
  assert.ok((r as { warning?: string }).warning?.includes('migrate deploy'), 'the owner is told the migration is pending')
})

test('cancelling a link WITH an open Stripe session still succeeds when Stripe is unreachable', async () => {
  // The cancel path now tries to expire the open Stripe Checkout Session so a
  // customer who already opened Checkout cannot pay a killed link. That call is
  // best-effort: here there is no Stripe key, so it fails internally — and the
  // cancel must STILL succeed, because the database is the source of truth and
  // the money guard is "never expire our way into losing a payment", not "never
  // cancel if Stripe is down".
  const db = seedDb([
    depositRow({
      stripeCheckoutSessionId: 'cs_live_1',
      stripeCheckoutUrl: 'https://checkout.stripe.com/c/pay/cs_live_1',
      checkoutSessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  ])
  const { cancelDepositRequest } = await import('../deposit-service')
  const r = await cancelDepositRequest('dep_1', { userId: 'u1', name: 'Diego' })
  assert.equal(r.ok, true, 'the cancel is not blocked by a Stripe outage')
  assert.equal(paid(db).status, 'CANCELED')
  assert.equal(db.audits.filter((a) => a.action === 'DEPOSIT_LINK_CANCELED').length, 1)
})
