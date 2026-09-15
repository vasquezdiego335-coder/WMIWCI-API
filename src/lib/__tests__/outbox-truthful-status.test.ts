import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dbSkip, assertTestRecipient, assertNoProductionCredentials } from './_disposable-test-env'

// ════════════════════════════════════════════════════════════════════════
//  OUTBOX TRUTHFUL STATUS (2026-09-15)
//  ---------------------------------------------------------------------
//  email_jobs.status = 'sent' must mean the provider accepted an email.
//  Before the fix every guard refusal came back as `{ id: 'blocked:<reason>' }`
//  and the worker marked the row 'sent' — kill-switch holds, DB-read failures,
//  ambiguous provider outcomes and OUTBOX_EMAIL_DRYRUN alike.
//
//  Covered here:
//    1. outboxDeliveryFor — the pure SendOutcome → OutboxDelivery mapping;
//    2. resolveOutboxJob  — each delivery/throw reaches exactly one mark*;
//    3. nextAttemptAfterFailure — backoff + notBefore;
//    4. OUTBOX_EMAIL_DRYRUN holds, never reaches guardedSend / the provider;
//    5. (DB-gated) the SQL claim / terminal / reaper / deferral contracts.
//
//  PRISMA. src/lib/db.ts resolves `globalThis.prisma` once on first import, so
//  a Proxy is installed BEFORE any outbox module is imported. It overrides only
//  `booking.findUnique` (→ null, the renderer's payload fallback) and records
//  every other property touched. With a disposable DATABASE_URL it forwards to
//  a real PrismaClient for the DB-gated tests; without one it has no client at
//  all, so an unexpected query fails loudly instead of reaching anything.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

const touched: string[] = []
let realClient: Record<string | symbol, unknown> | null = null
const DB_MODE = dbSkip() === false

async function ensureRealClient(): Promise<void> {
  if (!DB_MODE || realClient) return
  const { PrismaClient } = await import('@prisma/client')
  realClient = new PrismaClient() as unknown as Record<string | symbol, unknown>
}

const fakeBooking = { findUnique: async () => null }

const prismaProxy = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (typeof prop === 'string') touched.push(prop)
      if (prop === 'booking') return fakeBooking
      if (!realClient) {
        throw new Error(`fake prisma: unexpected access to prisma.${String(prop)} with no disposable database`)
      }
      const v = realClient[prop]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(realClient) : v
    },
  }
)
;(globalThis as unknown as { prisma: unknown }).prisma = prismaProxy

const load = async () => {
  await ensureRealClient()
  const svc = await import('../../outbox/services/emailService')
  const worker = await import('../../outbox/workers/emailWorker')
  const repo = await import('../../outbox/db/emailJobsRepo')
  const events = await import('../../outbox/domain/events')
  return { svc, worker, repo, events }
}

type Outcome = import('../email-guard').SendOutcome
type EmailJob = import('../../outbox/domain/events').EmailJob

function refusal(reason: string, extra: Record<string, unknown> = {}): Outcome {
  return { sent: false, reason, ...extra } as Outcome
}

function catchThrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  assert.fail('expected the mapping to throw OutboxRetryLater')
}

// ── 1. outboxDeliveryFor ─────────────────────────────────────────────────

test('outboxDeliveryFor: sent → status sent with the provider id', async () => {
  const { svc } = await load()
  assert.deepEqual(svc.outboxDeliveryFor({ sent: true, providerId: 'prov_1', emailSendId: 'es_1' }), {
    status: 'sent',
    providerId: 'prov_1',
  })
})

test("outboxDeliveryFor: 'duplicate' → sent with a note and a null provider id", async () => {
  const { svc } = await load()
  const d = svc.outboxDeliveryFor(refusal('duplicate', { outcomeClass: 'terminal' }))
  assert.equal(d.status, 'sent')
  assert.ok(d.status === 'sent')
  assert.equal(d.providerId, null)
  assert.ok(d.note && d.note.length > 0, 'a duplicate must carry an explanatory note')
})

test('outboxDeliveryFor: every ambiguous shape → ambiguous (never sent, never retried)', async () => {
  const { svc } = await load()
  for (const o of [
    refusal('ambiguous'),
    refusal('provider_timeout', { outcomeClass: 'ambiguous' }),
    refusal('terminal:ambiguous'),
  ]) {
    const d = svc.outboxDeliveryFor(o)
    assert.equal(d.status, 'ambiguous', `reason ${(o as { reason: string }).reason}`)
  }
})

test("outboxDeliveryFor: 'attempts_exhausted' / 'terminal:failed_terminal' → failed", async () => {
  const { svc } = await load()
  assert.deepEqual(svc.outboxDeliveryFor(refusal('attempts_exhausted', { outcomeClass: 'terminal' })), {
    status: 'failed',
    reason: 'attempts_exhausted',
  })
  assert.deepEqual(svc.outboxDeliveryFor(refusal('terminal:failed_terminal')), {
    status: 'failed',
    reason: 'terminal:failed_terminal',
  })
})

test("outboxDeliveryFor: terminal policy refusal ('unsubscribed') → skipped", async () => {
  const { svc } = await load()
  assert.deepEqual(svc.outboxDeliveryFor(refusal('unsubscribed', { outcomeClass: 'terminal' })), {
    status: 'skipped',
    reason: 'unsubscribed',
  })
})

test("outboxDeliveryFor: kill switch 'email_sending_disabled' THROWS a hold (consumeAttempt false, retryAt + 1s)", async () => {
  const { svc } = await load()
  const retryAt = new Date(Date.now() + 15 * 60_000)
  const err = catchThrown(() =>
    svc.outboxDeliveryFor(refusal('email_sending_disabled', { retryAt, outcomeClass: 'deferred' }))
  )
  assert.ok(err instanceof svc.OutboxRetryLater)
  assert.equal(err.reason, 'email_sending_disabled')
  assert.equal(err.consumeAttempt, false)
  assert.equal(err.retryAt?.getTime(), retryAt.getTime() + 1000)
})

test("outboxDeliveryFor: 'not_due' + notDueUntil THROWS a retry that consumes an attempt at notDueUntil + 1s", async () => {
  const { svc } = await load()
  const notDueUntil = new Date(Date.now() + 60_000)
  const err = catchThrown(() => svc.outboxDeliveryFor(refusal('not_due', { notDueUntil, outcomeClass: 'terminal' })))
  assert.ok(err instanceof svc.OutboxRetryLater)
  assert.equal(err.consumeAttempt, true)
  assert.equal(err.retryAt?.getTime(), notDueUntil.getTime() + 1000)
})

test("outboxDeliveryFor: retryable 'suppression_read_failed' THROWS (consumeAttempt true, retryAt null)", async () => {
  const { svc } = await load()
  const err = catchThrown(() =>
    svc.outboxDeliveryFor(refusal('suppression_read_failed', { outcomeClass: 'retryable' }))
  )
  assert.ok(err instanceof svc.OutboxRetryLater)
  assert.equal(err.reason, 'suppression_read_failed')
  assert.equal(err.consumeAttempt, true)
  assert.equal(err.retryAt, null)
})

test("outboxDeliveryFor: 'in_flight' THROWS a retry timed past the guard's stale window (never skipped, never sent)", async () => {
  const { svc } = await load()
  const { SENDING_STALE_MS } = await import('../email-guard')
  const before = Date.now()
  const err = catchThrown(() => svc.outboxDeliveryFor(refusal('in_flight', { outcomeClass: 'retryable' })))
  assert.ok(err instanceof svc.OutboxRetryLater)
  assert.equal(err.reason, 'in_flight')
  assert.equal(err.consumeAttempt, false, 'a live claim is a hold: it must not use up the row on its final attempt')
  // A few-second backoff burned every attempt while the live claim resolved.
  assert.ok((err.retryAt?.getTime() ?? 0) >= before + SENDING_STALE_MS, 'must wait until the live claim has resolved')
})

// ── 2. resolveOutboxJob ──────────────────────────────────────────────────

function makeJob(overrides: Partial<EmailJob> = {}): EmailJob {
  return {
    id: 'job_1',
    bookingId: 'bk_1',
    eventType: 'APPROVED' as EmailJob['eventType'],
    idempotencyKey: 'bk_1::APPROVED',
    payload: {} as EmailJob['payload'],
    status: 'processing',
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  }
}

type Call = { fn: string; args: unknown[] }

function recordingDeps(route: () => Promise<unknown>, failMarks = false) {
  const calls: Call[] = []
  const mk = (fn: string) => async (...args: unknown[]) => {
    calls.push({ fn, args })
    if (failMarks) throw new Error(`db down in ${fn}`)
  }
  const deps = {
    routeAndSend: route as never,
    markJobSent: mk('markJobSent') as never,
    markJobSkipped: mk('markJobSkipped') as never,
    markJobDeferred: mk('markJobDeferred') as never,
    markJobFailed: mk('markJobFailed') as never,
    markJobTerminalFailure: mk('markJobTerminalFailure') as never,
  }
  return { calls, deps }
}

function quiet() {
  const restore = [mock.method(console, 'log', () => {}), mock.method(console, 'warn', () => {}), mock.method(console, 'error', () => {})]
  return () => restore.forEach((m) => m.mock.restore())
}

test('resolveOutboxJob: sent → markJobSent only', async () => {
  const { worker } = await load()
  const { calls, deps } = recordingDeps(async () => ({ status: 'sent', providerId: 'prov_1' }))
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'sent')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobSent'])
  assert.equal((calls[0].args[0] as EmailJob).id, 'job_1', 'the update is tied to the claim (id + attempts)')
})

test('resolveOutboxJob: skipped → markJobSkipped only, NEVER markJobSent (the old defect)', async () => {
  const { worker } = await load()
  const { calls, deps } = recordingDeps(async () => ({ status: 'skipped', reason: 'unsubscribed' }))
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'skipped')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobSkipped'])
  assert.equal((calls[0].args[0] as EmailJob).id, 'job_1')
  assert.equal(calls[0].args[1], 'unsubscribed')
})

test("resolveOutboxJob: ambiguous → markJobTerminalFailure with an 'ambiguous:' reason", async () => {
  const { worker } = await load()
  const { calls, deps } = recordingDeps(async () => ({ status: 'ambiguous', reason: 'provider_timeout' }))
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'ambiguous')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobTerminalFailure'])
  assert.ok(String(calls[0].args[1]).startsWith('ambiguous:'), String(calls[0].args[1]))
})

test('resolveOutboxJob: failed → markJobTerminalFailure', async () => {
  const { worker } = await load()
  const { calls, deps } = recordingDeps(async () => ({ status: 'failed', reason: 'attempts_exhausted' }))
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'failed')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobTerminalFailure'])
  assert.match(String(calls[0].args[1]), /attempts_exhausted/)
})

test('resolveOutboxJob: OutboxRetryLater consumeAttempt:false → markJobDeferred (hold, no attempt used)', async () => {
  const { worker, svc } = await load()
  const retryAt = new Date(Date.now() + 60_000)
  const job = makeJob()
  const { calls, deps } = recordingDeps(async () => {
    throw new svc.OutboxRetryLater('email_sending_disabled', retryAt, false)
  })
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(job, deps), 'held')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobDeferred'])
  assert.equal(calls[0].args[0], job)
  assert.equal(calls[0].args[1], 'email_sending_disabled')
  assert.equal((calls[0].args[2] as Date).getTime(), retryAt.getTime())
})

test('resolveOutboxJob: OutboxRetryLater consumeAttempt:true → markJobFailed with notBefore = retryAt', async () => {
  const { worker, svc } = await load()
  const retryAt = new Date(Date.now() + 90_000)
  const { calls, deps } = recordingDeps(async () => {
    throw new svc.OutboxRetryLater('not_due', retryAt, true)
  })
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'retry')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobFailed'])
  assert.equal((calls[0].args[2] as Date).getTime(), retryAt.getTime())
})

test('resolveOutboxJob: a plain Error (render failure / malformed payload) → markJobFailed', async () => {
  const { worker } = await load()
  const { calls, deps } = recordingDeps(async () => {
    throw new Error('Cannot read properties of undefined (reading customer)')
  })
  const unquiet = quiet()
  try {
    assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'retry')
  } finally {
    unquiet()
  }
  assert.deepEqual(calls.map((c) => c.fn), ['markJobFailed'])
  assert.match(String(calls[0].args[1]), /reading customer/)
  assert.equal(calls[0].args[2], null)
})

test('resolveOutboxJob: a throwing mark function never escapes (returns retry)', async () => {
  const { worker, svc } = await load()
  const cases: Array<() => Promise<unknown>> = [
    async () => ({ status: 'sent', providerId: 'prov_1' }),
    async () => ({ status: 'skipped', reason: 'unsubscribed' }),
    async () => {
      throw new svc.OutboxRetryLater('email_sending_disabled', null, false)
    },
    async () => {
      throw new Error('boom')
    },
  ]
  const unquiet = quiet()
  try {
    for (const route of cases) {
      const { deps } = recordingDeps(route, true)
      assert.equal(await worker.resolveOutboxJob(makeJob(), deps), 'retry')
    }
  } finally {
    unquiet()
  }
})

// ── 3. nextAttemptAfterFailure ───────────────────────────────────────────

test('nextAttemptAfterFailure: 2^attempts seconds, capped at one hour', async () => {
  const { repo } = await load()
  const now = 1_700_000_000_000
  assert.equal(repo.nextAttemptAfterFailure(0, null, now).getTime(), now + 1_000)
  assert.equal(repo.nextAttemptAfterFailure(3, undefined, now).getTime(), now + 8_000)
  assert.equal(repo.nextAttemptAfterFailure(12, null, now).getTime(), now + 3_600_000)
  assert.equal(repo.nextAttemptAfterFailure(40, null, now).getTime(), now + 3_600_000)
})

test('nextAttemptAfterFailure: a later notBefore wins, an earlier or invalid one is ignored', async () => {
  const { repo } = await load()
  const now = 1_700_000_000_000
  const later = new Date(now + 10 * 60_000)
  assert.equal(repo.nextAttemptAfterFailure(2, later, now).getTime(), later.getTime())
  assert.equal(repo.nextAttemptAfterFailure(2, new Date(now + 500), now).getTime(), now + 4_000)
  assert.equal(repo.nextAttemptAfterFailure(2, new Date('not a date'), now).getTime(), now + 4_000)
})

// ── 4. OUTBOX_EMAIL_DRYRUN ───────────────────────────────────────────────

test('OUTBOX_EMAIL_DRYRUN=true holds pre-approval and final-confirmation: never guardedSend, never the provider, never sent', async () => {
  const { svc } = await load()
  const { resend } = await import('../resend')
  const recipient = 'dryrun-customer@example.com'
  assertTestRecipient(recipient)

  const prev = process.env.OUTBOX_EMAIL_DRYRUN
  process.env.OUTBOX_EMAIL_DRYRUN = 'true'
  const send = mock.method(resend.emails, 'send', async () => ({ data: { id: 'prov_1' }, error: null }))
  const unquiet = quiet()
  touched.length = 0
  try {
    const base = {
      bookingId: `dryrun_${randomUUID()}`,
      customerEmail: recipient,
      customerName: 'Dry Run',
      requestedDate: '2026-10-01T15:00:00.000Z',
    }
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['pre-approval', () => svc.sendPreApprovalEmail({ ...base, amountPaid: '49.00' } as never)],
      ['final-confirmation', () => svc.sendFinalConfirmationEmail({ ...base, approvedBy: 'owner' } as never)],
    ]
    for (const [name, call] of calls) {
      let result: unknown
      let thrown: unknown
      try {
        result = await call()
      } catch (err) {
        thrown = err
      }
      assert.equal(result, undefined, `${name}: dry run must not RETURN a delivery (it returned ${JSON.stringify(result)})`)
      assert.ok(thrown instanceof svc.OutboxRetryLater, `${name}: expected OutboxRetryLater, got ${String(thrown)}`)
      assert.equal(thrown.reason, 'held_outbox_dryrun')
      assert.equal(thrown.consumeAttempt, false)
      assert.ok(thrown.retryAt && thrown.retryAt.getTime() > Date.now(), `${name}: hold must be in the future`)
    }
    assert.equal(send.mock.callCount(), 0, 'the provider must never be called in dry run')
    // Only the renderer's booking read may touch the database: guardedSend's
    // ledger writes/claims (emailSend, $queryRaw, $transaction…) must not happen.
    const unexpected = touched.filter((p) => p !== 'booking')
    assert.deepEqual(unexpected, [], `dry run reached the database beyond the booking read: ${unexpected.join(', ')}`)
  } finally {
    unquiet()
    send.mock.restore()
    if (prev === undefined) delete process.env.OUTBOX_EMAIL_DRYRUN
    else process.env.OUTBOX_EMAIL_DRYRUN = prev
  }
})

test('DRYRUN structural: deliverRendered holds before guardedSend, and no fake "dryrun" provider id remains', () => {
  const src = readFileSync(resolve(__dirname, '../../outbox/services/emailService.ts'), 'utf8')
  const fnIdx = src.indexOf('async function deliverRendered(')
  assert.ok(fnIdx > -1)
  const body = src.slice(fnIdx)
  const holdIdx = body.indexOf("throw new OutboxRetryLater('held_outbox_dryrun'")
  const sendIdx = body.indexOf('await guardedSend(')
  assert.ok(holdIdx > -1 && sendIdx > -1 && holdIdx < sendIdx, 'the dry-run hold must precede guardedSend')
  assert.match(body.slice(holdIdx, holdIdx + 120), /,\s*false\s*\)/, 'the dry-run hold must not consume an attempt')
  // Strip comments first: the header deliberately documents the old `{ id: 'blocked:<reason>' }` shape.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /id:\s*['"`]dryrun/i, 'no dryrun provider-id literal may remain')
  assert.doesNotMatch(code, /id:\s*['"`]blocked:/, "no `{ id: 'blocked:…' }` result may remain")
})

// ── 5. DB-gated SQL contracts ────────────────────────────────────────────

type RawDb = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>
  $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T>
}
const rawDb = () => prismaProxy as unknown as RawDb

type Seed = { status?: string; attempts?: number; maxAttempts?: number; nextAttemptAt?: string; updatedAt?: string; createdAt?: string }

async function insertJob(tag: string, s: Seed = {}): Promise<string> {
  const id = `ots_${tag}_${randomUUID()}`
  const bookingId = `ots_bk_${randomUUID()}`
  await rawDb().$executeRawUnsafe(
    `INSERT INTO email_jobs (id, booking_id, event_type, idempotency_key, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, 'APPROVED', $3, $4::jsonb, $5, $6, $7, ${s.nextAttemptAt ?? "now() - interval '1 minute'"}, ${s.createdAt ?? "'1971-01-01'::timestamp"}, ${s.updatedAt ?? 'now()'})`,
    id,
    bookingId,
    `${bookingId}::APPROVED`,
    JSON.stringify({ bookingId, customerEmail: 'outbox-db@example.com' }),
    s.status ?? 'pending',
    s.attempts ?? 0,
    s.maxAttempts ?? 5
  )
  return id
}

async function readJob(id: string) {
  const rows = await rawDb().$queryRawUnsafe<Array<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date }>>(
    `SELECT status, attempts, last_error, next_attempt_at FROM email_jobs WHERE id = $1`,
    id
  )
  return rows[0]
}

async function cleanup(ids: string[]) {
  if (ids.length) await rawDb().$executeRawUnsafe(`DELETE FROM email_jobs WHERE id = ANY($1::text[])`, ids)
}

/** A shared disposable DB may hold other suites' rows: give back anything we claimed that is not ours. */
async function releaseForeign(claimed: EmailJob[], ours: string[]) {
  for (const j of claimed) {
    if (!ours.includes(j.id)) {
      await rawDb().$executeRawUnsafe(
        `UPDATE email_jobs SET status = 'pending', attempts = GREATEST(attempts - 1, 0) WHERE id = $1 AND status = 'processing'`,
        j.id
      )
    }
  }
}

test('DB: fetchPendingJobs claims only pending, due rows with attempts left', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  try {
    const due = await insertJob('due', { createdAt: "'1970-01-01 00:00:01'" })
    const exhausted = await insertJob('exhausted', { attempts: 5, maxAttempts: 5, createdAt: "'1970-01-01 00:00:02'" })
    const future = await insertJob('future', { nextAttemptAt: "now() + interval '1 hour'", createdAt: "'1970-01-01 00:00:03'" })
    const processing = await insertJob('processing', { status: 'processing', createdAt: "'1970-01-01 00:00:04'" })
    const sent = await insertJob('sent', { status: 'sent', createdAt: "'1970-01-01 00:00:05'" })
    ids.push(due, exhausted, future, processing, sent)

    const claimed = await repo.fetchPendingJobs(50)
    await releaseForeign(claimed, ids)
    const mine = claimed.filter((j) => ids.includes(j.id)).map((j) => j.id)
    assert.deepEqual(mine, [due])

    assert.deepEqual({ ...(await readJob(due)), next_attempt_at: undefined, last_error: undefined }, {
      status: 'processing', attempts: 1, next_attempt_at: undefined, last_error: undefined,
    })
    assert.equal((await readJob(exhausted)).status, 'pending', 'attempts = max must NOT be claimed')
    assert.equal((await readJob(exhausted)).attempts, 5)
    assert.equal((await readJob(future)).status, 'pending')
    assert.equal((await readJob(processing)).attempts, 0)
    assert.equal((await readJob(sent)).status, 'sent')
  } finally {
    await cleanup(ids)
  }
})

test('DB: two concurrent fetchPendingJobs(1) claim different rows', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  let claimed: EmailJob[] = []
  try {
    ids.push(await insertJob('c1', { createdAt: "'1970-01-01 00:00:01'" }))
    ids.push(await insertJob('c2', { createdAt: "'1970-01-01 00:00:02'" }))
    const [a, b] = await Promise.all([repo.fetchPendingJobs(1), repo.fetchPendingJobs(1)])
    claimed = [...a, ...b]
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.notEqual(a[0].id, b[0].id, 'SKIP LOCKED must hand concurrent claimers different rows')
  } finally {
    await releaseForeign(claimed, ids)
    await cleanup(ids)
  }
})

test('DB: markJobSent / markJobSkipped only change a row that is processing', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  try {
    const procA = await insertJob('procA', { status: 'processing', attempts: 1 })
    const procB = await insertJob('procB', { status: 'processing', attempts: 1 })
    const pending = await insertJob('pending')
    const failed = await insertJob('failed', { status: 'failed', attempts: 5 })
    ids.push(procA, procB, pending, failed)

    await repo.markJobSkipped({ id: procA, attempts: 1 }, 'unsubscribed')
    await repo.markJobSent({ id: procB, attempts: 1 }, 'already delivered under this idempotency key')
    await repo.markJobSent({ id: pending, attempts: 0 })
    await repo.markJobSkipped({ id: failed, attempts: 5 }, 'unsubscribed')

    const a = await readJob(procA)
    assert.equal(a.status, 'skipped')
    assert.equal(a.last_error, 'skipped:unsubscribed')
    assert.equal((await readJob(procB)).status, 'sent')
    assert.equal((await readJob(pending)).status, 'pending', 'a pending row must not be marked sent')
    assert.equal((await readJob(failed)).status, 'failed', 'a resolved row must not be rewritten')
  } finally {
    await cleanup(ids)
  }
})

test('DB: reapStaleProcessingJobs re-pends a stale row with attempts left and closes one at max as failed', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  try {
    const retryable = await insertJob('stale_retry', { status: 'processing', attempts: 2, maxAttempts: 5, updatedAt: "now() - interval '1 hour'" })
    const final = await insertJob('stale_final', { status: 'processing', attempts: 5, maxAttempts: 5, updatedAt: "now() - interval '1 hour'" })
    const fresh = await insertJob('fresh', { status: 'processing', attempts: 1 })
    ids.push(retryable, final, fresh)

    const reaped = await repo.reapStaleProcessingJobs(5 * 60 * 1000)
    assert.ok(reaped >= 2)
    assert.equal((await readJob(retryable)).status, 'pending')
    assert.equal((await readJob(retryable)).attempts, 2)
    const f = await readJob(final)
    assert.equal(f.status, 'failed')
    assert.match(String(f.last_error), /stale processing on final attempt/)
    assert.equal((await readJob(fresh)).status, 'processing', 'a live claim must not be reaped')
  } finally {
    await cleanup(ids)
  }
})

test('DB: an update from a SUPERSEDED claim (attempts moved on) never lands — a slow worker cannot strand a re-claim', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  try {
    // Worker A claimed at attempts=4; the reaper re-pended it and worker B re-claimed (attempts=5).
    const id = await insertJob('reclaimed', { status: 'processing', attempts: 5, maxAttempts: 5 })
    ids.push(id)
    await repo.markJobFailed(makeJob({ id, attempts: 4, maxAttempts: 5 }), 'worker A timed out')
    await repo.markJobSkipped({ id, attempts: 4 }, 'unsubscribed')
    let row = await readJob(id)
    assert.equal(row.status, 'processing', "A's stale updates must not touch B's claim")
    assert.equal(row.last_error, null)
    // B's own update lands; the final decision is read from the row.
    await repo.markJobFailed(makeJob({ id, attempts: 5, maxAttempts: 5 }), 'worker B failed')
    row = await readJob(id)
    assert.equal(row.status, 'failed')
  } finally {
    await cleanup(ids)
  }
})

test('DB: the reaper closes a PENDING row with no attempts left (legacy re-pend) as failed', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  try {
    const stranded = await insertJob('stranded', { status: 'pending', attempts: 5, maxAttempts: 5 })
    const live = await insertJob('live_pending', { status: 'pending', attempts: 2, maxAttempts: 5 })
    ids.push(stranded, live)
    await repo.reapStaleProcessingJobs(5 * 60 * 1000)
    const s = await readJob(stranded)
    assert.equal(s.status, 'failed')
    assert.match(String(s.last_error), /attempts exhausted while pending/)
    assert.equal((await readJob(live)).status, 'pending')
  } finally {
    await cleanup(ids)
  }
})

test('DB: markJobDeferred gives back the attempt and sets next_attempt_at', { skip: dbSkip() }, async () => {
  const { repo } = await load()
  const ids: string[] = []
  try {
    const id = await insertJob('deferred', { status: 'processing', attempts: 3 })
    ids.push(id)
    const retryAt = new Date(Date.now() + 15 * 60_000)
    retryAt.setMilliseconds(0)
    await repo.markJobDeferred(makeJob({ id, attempts: 3 }), 'email_sending_disabled', retryAt)
    const row = await readJob(id)
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 2)
    assert.equal(row.last_error, 'held:email_sending_disabled')
    assert.ok(Math.abs(new Date(row.next_attempt_at).getTime() - retryAt.getTime()) < 1000, `next_attempt_at ${row.next_attempt_at}`)
  } finally {
    await cleanup(ids)
  }
})

test('DB: teardown disconnects the disposable client', { skip: dbSkip() }, async () => {
  if (realClient) await (realClient.$disconnect as () => Promise<void>).call(realClient)
})
